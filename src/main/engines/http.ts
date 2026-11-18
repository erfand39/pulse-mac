import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, promises as fs, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import type { DownloadTask, SegmentState, Settings } from '@shared/types'
import { atomicWrite, readLocalFile, sameFile, syncDirectory } from '../durable-file'
import { ensureDir, extFromMime, guessNameFromUrl, parseContentDisposition, sanitizeFileName, sleep, type GlobalThrottle } from '../util'
import { HttpNetwork } from './http-network'

export interface EngineHost {
  settings(): Settings
  patch(task: DownloadTask, patch: Partial<DownloadTask>): void
  toast(level: 'info' | 'success' | 'error', message: string): void
  throttle: GlobalThrottle
  resolveProxy?(url: string): Promise<string | undefined>
}

export interface TaskHandle {
  task: DownloadTask
  signal: AbortSignal
  patch: (patch: Partial<DownloadTask>) => void
  toast: (level: 'info' | 'success' | 'error', message: string) => void
}

export interface ProbeOutput {
  url: string
  finalUrl: string
  fileName: string
  size: number
  resumable: boolean
  contentType?: string
  etag?: string
  lastModified?: string
  headers: Record<string, string>
}

const position = z.number().int().nonnegative()
const leaf = z.string().min(1).refine((value) => value !== '.' && value !== '..' && !/[/\\\0]/.test(value))
const identityShape = z.object({ dev: position, ino: position })
const checkpointShape = z.object({
  source: z.string().regex(/^[a-f0-9]{64}$/),
  validator: z.string().optional(),
  destination: z.string().optional(),
  modified: z.string().optional(),
  size: position,
  part: z.uuid(),
  identity: identityShape,
  segments: z.array(z.object({ start: position, end: position, position })).max(16),
  publication: z.object({ name: leaf, size: position }).optional()
})
type Checkpoint = z.infer<typeof checkpointShape>

class HttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`) }
}

class RangeRejected extends Error {
  constructor() { super('Server returned an invalid range or changed the file.') }
}

const linkExpired = (error: unknown): boolean =>
  error instanceof HttpError && [401, 403, 404, 410].includes(error.status)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code
const exists = async (path: string): Promise<Stats | undefined> =>
  fs.lstat(path).catch((error) => { if (code(error) !== 'ENOENT') throw error; return undefined })

function identity(response: Response): boolean {
  const encoding = response.headers.get('content-encoding')
  return !encoding || encoding.toLowerCase() === 'identity'
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')
  if (raw === null) return
  const size = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(size)) throw new Error('Invalid Content-Length.')
  return size
}

function contentRange(response: Response): { start: number; end: number; size: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
  if (!match) return
  const [start, end, size] = match.slice(1).map(Number)
  if ([start, end, size].every(Number.isSafeInteger) && start <= end && end < size) {
    return { start, end, size }
  }
}

function strongEtag(value: string | null): string | undefined {
  return value && /^"[^"\r\n]*"$/.test(value) ? value : undefined
}

function buildSegments(size: number, connections: number): SegmentState[] {
  const count = Math.max(1, Math.min(16, connections, Math.ceil(size / 1_048_576)))
  const chunk = Math.floor(size / count)
  return Array.from({ length: count }, (_, i) => ({
    start: i * chunk, end: i === count - 1 ? size : (i + 1) * chunk, position: i * chunk
  }))
}

function validSegments(segments: SegmentState[], size: number): boolean {
  let offset = 0
  if (!segments.length) return false
  for (const segment of segments) {
    if (segment.start !== offset || segment.position < offset ||
        segment.end <= offset || segment.position > segment.end) return false
    offset = segment.end
  }
  return size === offset
}

async function writeAll(file: FileHandle, value: Uint8Array, offset: number): Promise<void> {
  let written = 0
  while (written < value.length) {
    const { bytesWritten } = await file.write(value, written, value.length - written, offset + written)
    if (!bytesWritten) throw new Error('The disk could not finish the write.')
    written += bytesWritten
  }
}

function fileFor(checkpoint: Checkpoint, dir: string): string {
  return join(dir, `${checkpoint.part}.part`)
}

function ownedFile(stat: Stats | undefined, checkpoint: Checkpoint): stat is Stats {
  return !!stat?.isFile() && stat.dev === checkpoint.identity.dev && stat.ino === checkpoint.identity.ino
}

export class HttpEngine {
  private network: HttpNetwork

  constructor(private host: EngineHost) {
    this.network = new HttpNetwork(host.resolveProxy?.bind(host))
  }

  private headers(url: string, custom?: Record<string, string>, userAgent?: string): Headers {
    const headers = new Headers({
      'User-Agent': userAgent || this.host.settings().userAgent || 'PulseMac',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Referer: `${new URL(url).origin}/`
    })
    for (const [name, value] of Object.entries(custom ?? {})) {
      if (/^(accept|accept-language|referer|user-agent)$/i.test(name)) headers.set(name, value)
    }
    return headers
  }

  async probe(url: string, headers?: Record<string, string>, userAgent?: string, signal?: AbortSignal): Promise<ProbeOutput> {
    const controller = new AbortController()
    const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const timeout = setTimeout(() => controller.abort(new Error('Server response timed out.')), 20_000)
    const request = this.headers(url, headers, userAgent)
    request.set('Range', 'bytes=0-0')
    try {
      let res = await this.network.request(url, request, abort)
      let range = contentRange(res)
      if (res.status === 416 || (res.status === 206 &&
        (!range || range.start !== 0 || range.end !== 0 || !identity(res) ||
          (contentLength(res) !== undefined && contentLength(res) !== 1)))) {
        await res.body?.cancel()
        request.delete('Range')
        res = await this.network.request(url, request, abort)
        range = undefined
      }
      try {
        if (res.status !== 200 && !(res.status === 206 && range)) throw new HttpError(res.status)
        const size = range?.size ?? (identity(res) ? contentLength(res) ?? 0 : 0)
        const contentType = res.headers.get('content-type') ?? undefined
        const fileName = parseContentDisposition(res.headers.get('content-disposition')) || guessNameFromUrl(res.url || url)
        return {
          url, finalUrl: res.url || url,
          fileName: sanitizeFileName(extname(fileName) ? fileName : fileName + (extFromMime(contentType) ?? '')),
          size,
          resumable: !!range,
          etag: strongEtag(res.headers.get('etag')),
          lastModified: res.headers.get('last-modified') ?? undefined,
          contentType,
          headers: Object.fromEntries([...res.headers].filter(([name]) =>
            ['content-length', 'content-type', 'content-disposition'].includes(name)))
        }
      } finally {
        await res.body?.cancel()
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  private async stage(task: DownloadTask, create: boolean): Promise<string> {
    z.uuid().parse(task.id)
    if (create) await ensureDir(task.dir)
    const root = await fs.realpath(task.dir)
    if (root !== task.dir) throw new Error('Download folder moved. Restore the original folder.')
    const stage = join(root, `.pulse-mac-${task.id}`)
    if (create) await fs.mkdir(stage, { mode: 0o700 }).catch((error) => {
      if (code(error) !== 'EEXIST') throw error
    })
    if (!(await fs.lstat(stage)).isDirectory() || await fs.realpath(stage) !== stage) {
      throw new Error('The work folder is not a regular directory.')
    }
    return stage
  }

  private async readCheckpoint(stage: string): Promise<Checkpoint | undefined> {
    const path = join(stage, 'checkpoint.json')
    try {
      return checkpointShape.parse(JSON.parse((await readLocalFile(path, 64 * 1024)).toString('utf8')))
    } catch (error) {
      if (code(error) === 'ENOENT') return
      throw new Error('The HTTP checkpoint is damaged. Its files were preserved.')
    }
  }

  async resumeWithUrl(task: DownloadTask, url: string, signal?: AbortSignal): Promise<{ size: number; restarted: boolean }> {
    const probe = await this.probe(url, task.headers, undefined, signal)
    const changed = digest(task.url) !== digest(url)
    return { size: probe.size, restarted: task.downloaded > 0 && (changed || !probe.resumable) }
  }

  async start(handle: TaskHandle, _resume: boolean): Promise<void> {
    try {
      await this.transfer(handle)
    } catch (error) {
      const disk = code(error)
      handle.patch({
        status: handle.signal.aborted ? 'paused' : 'error',
        ...(!handle.signal.aborted && {
          error: disk === 'ENOSPC' ? 'The disk is full. Free some space and resume.' :
            ['EACCES', 'EROFS', 'ENODEV', 'ENOENT', 'EIO', 'ESTALE'].includes(disk ?? '') ?
              'The download folder is unavailable. Reconnect the volume or check permissions.' :
              (error as Error).message,
          linkExpired: linkExpired(error)
        }),
        speed: 0, eta: 0, connections: 0
      })
    }
  }

  private async transfer(handle: TaskHandle): Promise<void> {
    const { task, signal } = handle
    const stage = await this.stage(task, true)
    const path = join(stage, 'checkpoint.json')
    const previous = await this.readCheckpoint(stage)
    // Recover a publication interrupted after the atomic link. Check both names
    // refer to the task inode and verify the size before marking it complete.
    if (previous?.publication && previous.source === digest(task.url)) {
      const final = join(task.dir, previous.publication.name)
      const published = await exists(final)
      if (ownedFile(published, previous) && published.size === previous.publication.size) {
        await this.verify(handle, final)
        await this.complete(handle, stage, previous, final, published.size)
        return
      }
    }

    const probe = await this.probe(task.url, task.headers, undefined, signal)
    signal.throwIfAborted()
    let ranged = probe.resumable && !!probe.etag && probe.size > 0
    const fileName = sanitizeFileName(task.fileName === guessNameFromUrl(task.url) || !task.fileName ? probe.fileName : task.fileName)
    let checkpoint = previous
    for (let attempt = 0; attempt < 2; attempt++) {
      const source = digest(task.url)
      const resumed = ranged && checkpoint && checkpoint.source === source &&
        checkpoint.validator === probe.etag && checkpoint.destination === digest(probe.finalUrl) && checkpoint.size === probe.size &&
        validSegments(checkpoint.segments, probe.size) && !checkpoint.publication &&
        ownedFile(await exists(fileFor(checkpoint, stage)), checkpoint)
      let file: FileHandle
      if (resumed && checkpoint) {
        file = await fs.open(fileFor(checkpoint, stage), constants.O_RDWR | constants.O_NOFOLLOW)
        const stat = await file.stat()
        if (!ownedFile(stat, checkpoint) || checkpoint.segments.some((seg) => seg.position > seg.start && seg.position > stat.size)) {
          await file.close()
          throw new Error('The partial download was changed outside Pulse Mac.')
        }
      } else {
        const part = randomUUID()
        file = await fs.open(join(stage, `${part}.part`), 'wx+', 0o600)
        const stat = await file.stat()
        checkpoint = {
          source, part, size: probe.size, identity: { dev: stat.dev, ino: stat.ino },
          validator: probe.etag, modified: probe.lastModified, destination: digest(probe.finalUrl),
          segments: ranged ? buildSegments(probe.size, task.maxConnections || this.host.settings().connections) : []
        }
      }
      const state = checkpoint!
      let downloaded = state.segments.reduce((sum, seg) => sum + seg.position - seg.start, 0)
      let lastSave = 0
      let lastEmit = 0
      let writes = Promise.resolve()
      let saveError: unknown
      const controller = new AbortController()
      const active = AbortSignal.any([signal, controller.signal])
      const save = (): Promise<void> => {
        const snapshot = JSON.stringify(state)
        const op = writes.then(async () => {
          await file.sync()
          await atomicWrite(path, snapshot)
        })
        writes = op.catch((error) => { saveError = error; controller.abort(error) })
        return op
      }
      const tick = (bytes: number): void => {
        downloaded += bytes
        const now = Date.now()
        if (now - lastEmit >= 180) {
          lastEmit = now
          handle.patch({ downloaded, segments: state.segments.map((seg) => ({ ...seg })) })
        }
        if (ranged && now - lastSave >= 2000) {
          lastSave = now
          void save().catch(() => undefined)
        }
      }

      let retryWithoutRange = false
      try {
        const disk = await fs.statfs(stage)
        if (probe.size - downloaded > disk.bavail * disk.bsize) {
          throw Object.assign(new Error('The disk is full.'), { code: 'ENOSPC' })
        }
        await save()
        handle.patch({
          status: 'downloading', size: probe.size, downloaded, fileName,
          connections: ranged ? state.segments.filter((s) => s.position < s.end).length : 1,
          resumable: ranged, filePath: undefined, linkExpired: false
        })
        if (ranged) {
          let firstError: unknown
          const workers = state.segments.map(async (segment) => {
            try {
              await this.downloadRange(handle, file, segment, state, active, tick)
            } catch (error) {
              if (!firstError) firstError = error
              controller.abort(error)
            }
          })
          await Promise.all(workers)
          if (saveError) throw saveError
          if (firstError) throw firstError
        } else {
          downloaded = await this.readResponse(handle, active, this.headers(task.url, task.headers),
            undefined, async (value, offset) => {
              await writeAll(file, value, offset)
              tick(value.length)
            })
        }
        active.throwIfAborted()
        const stat = await file.stat()
        if (stat.size !== downloaded || (ranged && downloaded !== state.size)) {
          throw new Error('The file length does not match the downloaded data.')
        }
        await save()
      } catch (error) {
        await writes
        if (ranged && !saveError) await save()
        if (!signal.aborted && ranged && error instanceof RangeRejected) retryWithoutRange = true
        else throw saveError || error
      } finally {
        await writes
        await file.close()
      }
      if (retryWithoutRange) {
        handle.toast('info', 'The server rejected range requests. Restarting with one connection.')
        ranged = false
        continue
      }

      handle.patch({ status: 'verifying', connections: 0 })
      const part = fileFor(state, stage)
      await this.verify(handle, part)
      signal.throwIfAborted()
      await this.publish(handle, stage, state, fileName, downloaded)
      return
    }
  }

  private async downloadRange(
    handle: TaskHandle, file: FileHandle, segment: SegmentState, state: Checkpoint,
    signal: AbortSignal, tick: (bytes: number) => void
  ): Promise<void> {
    for (let attempt = 0; segment.position < segment.end; attempt++) {
      signal.throwIfAborted()
      const start = segment.position
      const headers = this.headers(handle.task.url, handle.task.headers)
      headers.set('Range', `bytes=${start}-${segment.end - 1}`)
      headers.set('If-Range', state.validator!)
      try {
        await this.readResponse(handle, signal, headers, { start, end: segment.end - 1, state }, async (value, offset) => {
          await writeAll(file, value, start + offset)
          const next = start + offset + value.length
          // Keep the last chunk out of the checkpoint until EOF is validated.
          if (next < segment.end) {
            const committed = next - segment.position
            segment.position = next
            tick(committed)
          }
        })
        const committed = segment.end - segment.position
        segment.position = segment.end
        tick(committed)
      } catch (error) {
        if (signal.aborted || error instanceof RangeRejected || linkExpired(error) || code(error) ||
          (error instanceof HttpError && error.status < 500 && ![408, 429].includes(error.status)) || attempt >= 4) throw error
        await sleep(200 * 2 ** attempt + Math.random() * 150, signal)
      }
    }
  }

  private async readResponse(
    handle: TaskHandle, signal: AbortSignal, headers: Headers,
    expected: { start: number; end: number; state: Checkpoint } | undefined,
    write: (chunk: Uint8Array, offset: number) => Promise<void>
  ): Promise<number> {
    const controller = new AbortController()
    const active = AbortSignal.any([signal, controller.signal])
    let timeout: ReturnType<typeof setTimeout> | undefined
    const armTimeout = (): void => {
      clearTimeout(timeout)
      timeout = setTimeout(() => controller.abort(new Error('Download connection timed out.')), 20_000)
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      armTimeout()
      const res = await this.network.request(handle.task.url, headers, active)
      reader = res.body?.getReader()
      if (!res.ok && res.status !== 416) throw new HttpError(res.status)
      let length = identity(res) ? contentLength(res) : undefined
      if (expected) {
        const range = contentRange(res)
        const bytes = expected.end + 1 - expected.start
        if (res.status !== 206 || !identity(res) || !range || range.start !== expected.start ||
          range.end !== expected.end || range.size !== expected.state.size ||
          digest(res.url || handle.task.url) !== expected.state.destination ||
          strongEtag(res.headers.get('etag')) !== expected.state.validator ||
          (expected.state.modified && res.headers.get('last-modified') !== expected.state.modified) ||
          (length !== undefined && length !== bytes)) throw new RangeRejected()
        length = bytes
      } else if (res.status !== 200) throw new HttpError(res.status)
      if (!reader) {
        if (length === 0) return 0
        throw new Error('Empty response body.')
      }

      let offset = 0
      while (true) {
        armTimeout()
        const { done, value } = await reader.read()
        clearTimeout(timeout)
        if (done) break
        if (!value?.length) continue
        active.throwIfAborted()
        if (length !== undefined && offset + value.length > length) {
          if (expected) throw new RangeRejected()
          throw new Error('Server sent more bytes than expected.')
        }
        await this.host.throttle.consume(value.length, active)
        active.throwIfAborted()
        await write(value, offset)
        offset += value.length
      }
      if (length !== undefined && length !== offset) throw new Error('Server ended the response early.')
      return offset
    } finally {
      clearTimeout(timeout)
      controller.abort()
      await reader?.cancel().catch(() => undefined)
    }
  }

  private async verify(handle: TaskHandle, path: string): Promise<void> {
    if (!handle.task.checksum) return
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, {
      flags: 'r', signal: handle.signal
    })) hash.update(chunk)
    if (hash.digest('hex') !== handle.task.checksum.toLowerCase()) throw new Error('SHA-256 checksum does not match.')
  }

  private async publish(handle: TaskHandle, stage: string, state: Checkpoint, fileName: string, size: number): Promise<void> {
    const ext = extname(fileName)
    const stem = fileName.slice(0, fileName.length - ext.length)
    const part = fileFor(state, stage)
    for (let i = 0; i <= 10_000; i++) {
      handle.signal.throwIfAborted()
      const name = i ? `${stem} (${i})${ext}` : fileName
      const candidate = join(handle.task.dir, name)
      if (await exists(candidate)) continue
      state.publication = { name, size }
      await atomicWrite(join(stage, 'checkpoint.json'), JSON.stringify(state))
      handle.signal.throwIfAborted()
      try {
        await fs.link(part, candidate)
      } catch (error) {
        if (code(error) === 'EEXIST') continue
        throw error
      }
      await syncDirectory(handle.task.dir)
      await this.complete(handle, stage, state, candidate, size)
      return
    }
    throw new Error('Could not reserve a unique file name.')
  }

  private async complete(handle: TaskHandle, stage: string, state: Checkpoint, final: string, size: number): Promise<void> {
    const part = fileFor(state, stage)
    const original = await exists(part)
    const published = await exists(final)
    if (!ownedFile(published, state) || (original && !sameFile(original, published))) {
      throw new Error('The completed file changed before publication.')
    }
    if (original) await fs.unlink(part)
    handle.patch({
      status: 'completed', downloaded: size, size, filePath: final, fileName: basename(final),
      completedAt: Date.now(), connections: 0, speed: 0, eta: 0
    })
  }

  async deleteOwnedFiles(task: DownloadTask): Promise<void> {
    let stage: string
    try { stage = await this.stage(task, false) } catch (error) {
      if (code(error) === 'ENOENT') return
      throw error
    }
    const state = await this.readCheckpoint(stage)
    if (!state) return
    const part = fileFor(state, stage)
    if (state.publication && state.source === digest(task.url)) {
      const path = join(task.dir, state.publication.name)
      const stat = await exists(path)
      if (ownedFile(stat, state) && stat.size === state.publication.size) await fs.unlink(path)
    }
    if (ownedFile(await exists(part), state)) await fs.unlink(part)
    await fs.unlink(join(stage, 'checkpoint.json'))
    await fs.rmdir(stage).catch((error) => { if (code(error) !== 'ENOTEMPTY') throw error })
  }

  shutdown(): Promise<void> { return this.network.close() }
}
