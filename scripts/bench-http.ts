import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { HttpEngine } from '../src/main/engines/http'
import { GlobalThrottle } from '../src/main/util'
import type { DownloadTask, Settings } from '../src/shared/types'

const MIB = 1024 * 1024
const payload = Buffer.alloc(32 * MIB)
for (let i = 0; i < payload.length; i++) payload[i] = (i + (i >>> 10)) % 251
const checksum = createHash('sha256').update(payload).digest('hex')

async function stream(response: ServerResponse, start: number, end: number, delay: number): Promise<void> {
  const chunkSize = 128 * 1024
  for (let offset = start; offset <= end && !response.destroyed; offset += chunkSize) {
    if (!response.write(payload.subarray(offset, Math.min(end + 1, offset + chunkSize)))) {
      const signal = new AbortController()
      const abort = (): void => signal.abort()
      response.once('close', abort)
      try {
        await once(response, 'drain', { signal: signal.signal })
      } catch {
        return
      } finally {
        response.off('close', abort)
      }
    }
    if (offset + chunkSize <= end) await wait(delay)
  }
  response.end()
}

async function benchmark(): Promise<void> {
  const previous = process.argv[2] ? await import(pathToFileURL(resolve(process.argv[2])).href) as { HttpEngine: typeof HttpEngine } : undefined
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pulse-http-bench-')))
  const server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    if (!range) { response.writeHead(400).end(); return }
    const start = Number(range[1])
    const end = Number(range[2])
    response.writeHead(206, {
      ETag: '"benchmark"',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${payload.length}`
    })
    const delay = request.url === '/skew.bin' ? (start < payload.length / 8 ? 65 : 4) : 15
    void stream(response, start, end, delay)
  })
  const patches = (task: DownloadTask, patch: Partial<DownloadTask>): void => { Object.assign(task, patch) }
  const host = {
    settings: () => ({ connections: 8, userAgent: 'PulseMacBenchmark' }) as Settings,
    patch: patches,
    toast: (): void => {},
    throttle: new GlobalThrottle()
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const run = async (Engine: typeof HttpEngine, scenario: string, connections: number): Promise<number> => {
    const engine = new Engine(host)
    const task: DownloadTask = {
      id: randomUUID(), kind: 'http', status: 'queued', dir, name: 'sample.bin', fileName: 'sample.bin',
      url: `http://127.0.0.1:${address.port}/${scenario}.bin`,
      maxConnections: connections, checksum, size: 0, downloaded: 0, speed: 0, eta: 0,
      connections: 0, createdAt: Date.now(), updatedAt: Date.now(), order: 1
    }
    try {
      const start = performance.now()
      await engine.start({
        task, signal: AbortSignal.timeout(30_000),
        patch: (patch) => patches(task, patch), toast: host.toast
      }, false)
      const seconds = (performance.now() - start) / 1000
      assert.equal(task.status, 'completed', task.error)
      assert.equal(createHash('sha256').update(await fs.readFile(task.filePath!)).digest('hex'), checksum)
      await engine.deleteOwnedFiles(task)
      return seconds
    } finally {
      await engine.shutdown()
    }
  }

  try {
    const rows = [
      { scenario: 'uniform', name: 'Current / 1 connection', Engine: HttpEngine, connections: 1 },
      { scenario: 'uniform', name: 'Current / 8 connections', Engine: HttpEngine, connections: 8 },
      ...(previous ? [{ scenario: 'skew', name: 'Previous / 8 connections', Engine: previous.HttpEngine, connections: 8 }] : []),
      { scenario: 'skew', name: 'Current / 8 connections', Engine: HttpEngine, connections: 8 }
    ]
    for (const row of rows) {
      const samples: number[] = []
      for (let i = 0; i < 3; i++) samples.push(await run(row.Engine, row.scenario, row.connections))
      const median = [...samples].sort((a, b) => a - b)[1]
      console.log(`${row.scenario}   ${row.name}   median ${median.toFixed(3)} s   ${(32 / median).toFixed(2)} MiB/s   [${samples.map((value) => value.toFixed(3)).join(', ')}]`)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

void benchmark().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
