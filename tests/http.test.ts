import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { HttpEngine } from '../src/main/engines/http'
import { GlobalThrottle, sanitizeFileName } from '../src/main/util'
import type { DownloadTask, Settings } from '../src/shared/types'

const payload = Buffer.alloc(3 * 1024 * 1024 + 19)
for (let i = 0; i < payload.length; i++) payload[i] = (i * 23 + Math.floor(i / 131)) % 251
const second = Buffer.from(payload.map((byte) => 255 - byte))
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
type FixtureOptions = {
  ranged?: 'valid' | 'wrong' | 'ignored' | '416' | 'bad-probe' | 'absent'
  failure?: number
  unknown?: boolean
  slow?: boolean
  cut?: boolean
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pulse-http-')))
  const requests: Array<{ range?: string; ifRange?: string }> = []
  let current = payload
  let etag = '"first"'
  let didCut = false
  const server = http.createServer(async (req, res) => {
    const data = current
    const tag = etag
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file.bin' }).end()
      return
    }
    if (options.failure) {
      res.writeHead(options.failure).end()
      return
    }
    const range = req.headers.range
    requests.push({ range, ifRange: req.headers['if-range'] as string | undefined })
    if (range && options.ranged === '416') {
      res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end()
      return
    }
    const matched = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
    if (matched && options.ranged !== 'absent' && (!options.ranged || options.ranged !== 'ignored' || range === 'bytes=0-0')) {
      const start = Number(matched[1])
      const end = Number(matched[2])
      const wrong = options.ranged === 'wrong' && end !== 0 || options.ranged === 'bad-probe' && end === 0
      const body = data.subarray(start, end + 1)
      res.writeHead(206, {
        ETag: tag,
        'Content-Range': `bytes ${start + Number(wrong)}-${end}/${data.length}`,
        'Content-Length': body.length
      })
      if (options.cut && !didCut && end !== 0) {
        didCut = true
        res.write(body.subarray(0, 150_000))
        setTimeout(() => res.destroy(), 20)
        return
      }
      if (!options.slow || end === 0) {
        res.end(body)
        return
      }
      for (let i = 0; i < body.length && !res.destroyed; i += 32768) {
        res.write(body.subarray(i, i + 32768))
        await new Promise((resolve) => setTimeout(resolve, 14))
      }
      res.end()
      return
    }
    res.writeHead(200, options.unknown ? { ETag: tag } : { ETag: tag, 'Content-Length': data.length })
    res.write(data.subarray(0, 200))
    res.end(data.subarray(200))
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/file.bin`
  const holder = {
    settings: () => ({ connections: 4, userAgent: 'PulseTest' }) as Settings,
    patch: (task: DownloadTask, patch: Partial<DownloadTask>) => Object.assign(task, patch),
    toast: () => undefined,
    throttle: new GlobalThrottle()
  }
  const engine = new HttpEngine(holder)
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await engine.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  })
  function task(fileName = 'file.bin'): DownloadTask {
    return {
      id: randomUUID(), status: 'queued', kind: 'http', url, dir, fileName, name: fileName,
      size: 0, downloaded: 0, speed: 0, eta: 0, connections: 0, order: 1,
      createdAt: Date.now(), updatedAt: Date.now()
    }
  }
  const run = (item: DownloadTask, controller = new AbortController(), onPatch?: () => void) =>
    engine.start({
      task: item, signal: controller.signal, toast: holder.toast,
      patch: (patch) => { holder.patch(item, patch); onPatch?.() }
    }, true)
  const change = (): void => { current = second; etag = '"second"' }
  return { dir, engine, requests, run, task, change }
}

test('multi-connection download validates ranges and SHA-256 after a redirect', async (t) => {
  const f = await fixture(t)
  const task = f.task('نمونه.bin')
  task.url = task.url.replace('/file.bin', '/redirect')
  task.checksum = sha(payload)
  await f.run(task)
  assert.equal(task.status, 'completed', task.error)
  assert.equal(task.fileName, 'نمونه.bin')
  assert.equal(sha(await fs.readFile(task.filePath!)), sha(payload))
  assert.ok(f.requests.filter((r) => r.ifRange === '"first"').length > 1)
})

for (const ranged of ['wrong', 'ignored', '416', 'bad-probe', 'absent'] as const) {
  test(`HTTP range mode ${ranged} falls back to a clean full stream`, async (t) => {
    const f = await fixture(t, { ranged, unknown: ranged === 'absent' })
    const task = f.task()
    await f.run(task)
    assert.equal(task.status, 'completed', task.error)
    assert.equal(sha(await fs.readFile(task.filePath!)), sha(payload))
    assert.ok(f.requests.some((r) => r.range === undefined))
  })
}

for (const failure of [401, 403]) {
  test(`HTTP ${failure} is reported as a recoverable expired-link error`, async (t) => {
    const f = await fixture(t, { failure })
    const task = f.task()
    await f.run(task)
    assert.equal(task.status, 'error')
    assert.equal(task.linkExpired, true)
    assert.equal(task.filePath, undefined)
  })
}

test('resumes an interrupted part using durable byte offsets and ETag', async (t) => {
  const f = await fixture(t, { slow: true })
  const controller = new AbortController()
  const task = f.task()
  await f.run(task, controller, () => { if (task.downloaded > 100_000) controller.abort() })
  assert.equal(task.status, 'paused', task.error)
  assert.ok(task.downloaded < payload.length)
  const initial = new Set(f.requests.map((r) => r.range))
  f.requests.length = 0
  await f.run({ ...task }).then(async () => {
    assert.equal(sha(await fs.readFile(join(f.dir, 'file.bin'))), sha(payload))
  })
  assert.ok(f.requests.some((r) => r.ifRange && !initial.has(r.range)))
})

test('SIGKILL during HTTP transfer recovers the checkpoint in a fresh process', async (t) => {
  const f = await fixture(t, { slow: true })
  const task = f.task('crash.bin')
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/download-worker.ts', JSON.stringify(task)], {
    env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.node.json' },
    stdio: 'ignore'
  })
  const exited = once(child, 'exit')
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const checkpoint = join(f.dir, `.pulse-mac-${task.id}`, 'checkpoint.json')
  let saved = false
  for (let tries = 0; tries < 150; tries++) {
    const value = await fs.readFile(checkpoint, 'utf8').catch(() => '')
    if (value && JSON.parse(value).segments.some((segment: { start: number; position: number }) => segment.position > segment.start)) {
      saved = true
      break
    }
    if (child.exitCode !== null || child.signalCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(saved, 'the killed process must have committed progress')
  child.kill('SIGKILL')
  assert.equal((await exited)[1], 'SIGKILL')
  const first = new Set(f.requests.map((request) => request.range))
  f.requests.length = 0
  await f.run(task)
  assert.equal(task.status, 'completed', task.error)
  assert.equal(sha(await fs.readFile(task.filePath!)), sha(payload))
  assert.ok(f.requests.some((request) => request.ifRange && !first.has(request.range)))
})

test('same-length response with a different ETag does not reuse old bytes', async (t) => {
  const f = await fixture(t, { slow: true })
  const controller = new AbortController()
  const task = f.task()
  await f.run(task, controller, () => { if (task.downloaded > 100_000) controller.abort() })
  assert.equal(task.status, 'paused')
  f.change()
  await f.run(task)
  assert.equal(task.status, 'completed', task.error)
  assert.equal(sha(await fs.readFile(task.filePath!)), sha(second))
})

test('socket cut recovers a range without corrupting data', async (t) => {
  const f = await fixture(t, { cut: true })
  const task = f.task()
  await f.run(task)
  assert.equal(task.status, 'completed', task.error)
  assert.equal(sha(await fs.readFile(task.filePath!)), sha(payload))
  assert.ok(f.requests.length > 5)
})

test('concurrent same-name publication preserves an existing file and symlink', async (t) => {
  const f = await fixture(t)
  const external = join(f.dir, 'external')
  await fs.writeFile(external, 'keep me')
  await fs.symlink(external, join(f.dir, 'file.bin'))
  const a = f.task()
  const b = f.task()
  await Promise.all([f.run(a), f.run(b)])
  assert.equal(a.status, 'completed', a.error)
  assert.equal(b.status, 'completed', b.error)
  assert.notEqual(a.filePath, b.filePath)
  assert.equal(await fs.readFile(external, 'utf8'), 'keep me')
  await fs.unlink(a.filePath!)
  await fs.symlink(external, a.filePath!)
  await f.engine.deleteOwnedFiles(a)
  assert.equal((await fs.lstat(a.filePath!)).isSymbolicLink(), true)
  assert.equal(await fs.readFile(external, 'utf8'), 'keep me')
  await f.engine.deleteOwnedFiles(b)
  await assert.rejects(fs.lstat(b.filePath!), { code: 'ENOENT' })
})

test('checkpoint recovers a previously validated publication without a request', async (t) => {
  const f = await fixture(t)
  const task = f.task()
  await f.run(task)
  assert.equal(task.status, 'completed', task.error)
  f.requests.length = 0
  task.status = 'queued'
  await f.run(task)
  assert.equal(task.status, 'completed', task.error)
  assert.equal(f.requests.length, 0)
})

test('checksum mismatch preserves the partial file and prevents publication', async (t) => {
  const f = await fixture(t)
  const task = f.task()
  task.checksum = '0'.repeat(64)
  await f.run(task)
  assert.equal(task.status, 'error')
  assert.match(task.error ?? '', /SHA-256/)
  await assert.rejects(fs.stat(join(f.dir, 'file.bin')), { code: 'ENOENT' })
})

test('global HTTP throttle serializes concurrent byte budgets and handles abort', async () => {
  const throttle = new GlobalThrottle()
  throttle.setLimit(1000)
  const start = performance.now()
  await Promise.all([throttle.consume(70), throttle.consume(70)])
  assert.ok(performance.now() - start >= 120)
  const controller = new AbortController()
  const pending = throttle.consume(10_000, controller.signal)
  controller.abort()
  await assert.rejects(pending)
  throttle.setLimit(0)
  await throttle.consume(10_000)
})

test('filename normalization preserves Persian while limiting UTF-8 length', () => {
  assert.equal(sanitizeFileName('../نمونه.pdf'), '_نمونه.pdf')
  assert.ok(Buffer.byteLength(sanitizeFileName('آ'.repeat(300) + '.zip')) <= 220)
})

test('sparse response uses byte positions beyond 4 GiB without allocating the whole file', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t)
  const task = f.task('sparse.bin')
  task.maxConnections = 16
  const size = 4_600_000_000
  const disk = await fs.statfs(f.dir)
  if (disk.bavail * disk.bsize < size) return t.skip('fixture volume has less than 4.6 GB available')
  const controller = new AbortController()
  let high = 0
  const server = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    if (!range) { res.writeHead(500).end(); return }
    const start = Number(range[1])
    const end = Number(range[2])
    res.writeHead(206, { ETag: '"sparse"', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    if (end === 0) return res.end(Buffer.alloc(1))
    res.write(Buffer.alloc(64))
    if (start > 2 ** 32) {
      high = start
      setTimeout(() => controller.abort(), 150)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  task.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/sparse.bin`
  await f.run(task, controller)
  assert.equal(task.status, 'paused', task.error)
  assert.ok(high > 2 ** 32)
  const folder = join(f.dir, `.pulse-mac-${task.id}`)
  const files = await fs.readdir(folder)
  const stat = await fs.stat(join(folder, files.find((name) => name.endsWith('.part'))!))
  assert.ok(stat.size > 2 ** 32)
  assert.ok(stat.blocks * 512 < 2_000_000)
})
