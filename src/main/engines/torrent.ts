import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { app } from 'electron'
import type { DownloadTask, TorrentFileEntry } from '@shared/types'
import type { EngineHost, TaskHandle } from './http'
import { sanitizeFileName } from '../util'
import { atomicWrite, readLocalFile } from '../durable-file'
import { httpUrl, MAX_TORRENT_BYTES } from '../validate'
import { HttpNetwork } from './http-network'
import { validateTorrentPaths } from './torrent-path'

type Client = any
type Torrent = any
type TorrentFile = TorrentFileEntry & { done: boolean; select(): void; deselect(): void }

interface Session {
  torrent: Torrent
  handle: TaskHandle
  dir: string
  metadata: boolean
  ready: boolean
  started: boolean
  finishing: boolean
  closing?: Promise<void>
  selected: Set<number> | undefined
  finish: () => void
}

const MAX_WAIT = 60_000

export class TorrentEngine {
  private client: Client
  private initializing?: Promise<Client>
  private sessions = new Map<string, Session>()
  private poll?: ReturnType<typeof setInterval>
  private destroyed = false
  private state: 'idle' | 'ready' | 'starting' | 'unavailable' = 'idle'
  private network: HttpNetwork

  constructor(private host: EngineHost) {
    this.network = new HttpNetwork(host.resolveProxy?.bind(host))
  }

  init(): Promise<Client> {
    if (this.destroyed) return Promise.reject(new Error('Torrent engine is shutting down.'))
    if (this.client) return Promise.resolve(this.client)
    if (this.initializing) return this.initializing
    this.state = 'starting'
    this.initializing = this.createClient().finally(() => { this.initializing = undefined })
    return this.initializing
  }

  private async createClient(): Promise<Client> {
    try {
      const { default: WebTorrent } = await import('webtorrent')
      const client: Client = new WebTorrent({
        maxConns: 40,
        torrentPort: this.host.settings().torrentPort,
        dht: true,
        tracker: false,
        lsd: false,
        utp: false,
        webSeeds: false,
        blocklist: [
          { start: '0.0.0.0', end: '0.255.255.255' }, { start: '10.0.0.0', end: '10.255.255.255' },
          { start: '127.0.0.0', end: '127.255.255.255' }, { start: '169.254.0.0', end: '169.254.255.255' },
          { start: '172.16.0.0', end: '172.31.255.255' }, { start: '192.168.0.0', end: '192.168.255.255' },
          { start: '::', end: '::1' }, { start: 'fc00::', end: 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' },
          { start: 'fe80::', end: 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff' }
        ]
      })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => fail(new Error('Torrent listener timed out.')), 10_000)
        const ready = (): void => { clearTimeout(timeout); client.off('error', fail); resolve() }
        const fail = (error: Error): void => {
          clearTimeout(timeout)
          client.off('listening', ready)
          client.destroy(() => undefined)
          reject(error)
        }
        client.once('error', fail)
        client.once('listening', ready)
      })
      client.on('error', () => this.host.toast('error', 'The torrent engine reported a network error.'))
      this.client = client
      this.setLimit(this.host.settings().globalSpeedLimit)
      this.state = 'ready'
      return client
    } catch {
      this.state = 'unavailable'
      throw new Error('Could not start the torrent listener. Check the configured port.')
    }
  }

  private async source(task: DownloadTask, signal: AbortSignal): Promise<Buffer | string> {
    if (task.torrent?.torrentFile) {
      const path = join(app.getPath('userData'), 'torrents', `${task.id}.torrent`)
      if (path !== task.torrent.torrentFile) {
        throw new Error('Choose the legacy torrent file again to create a Pulse Mac task.')
      }
      return readLocalFile(path, MAX_TORRENT_BYTES)
    }
    if (/^magnet:/i.test(task.url)) {
      const params = new URL(task.url).searchParams
      const xt = params.getAll('xt').find((value) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(value))
      if (!xt) throw new Error('The magnet link has no valid BitTorrent v1 info hash.')
      return `magnet:?xt=${xt}`
    }
    if (/^https?:/i.test(task.url)) {
      const active = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      const response = await this.network.request(httpUrl.parse(task.url), new Headers(), active)
      const reader = response.body?.getReader()
      let size = 0
      const parts: Uint8Array[] = []
      try {
        if (!response.ok || !reader) throw new Error('Could not read the remote torrent file.')
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > MAX_TORRENT_BYTES) throw new Error('The torrent file is too large.')
          parts.push(value)
        }
        return Buffer.concat(parts)
      } finally {
        await reader?.cancel().catch(() => undefined)
      }
    }
    throw new Error('Choose a torrent file or a valid magnet link.')
  }

  private async workDir(task: DownloadTask): Promise<string> {
    if (await fs.realpath(task.dir) !== task.dir) throw new Error('The torrent destination moved.')
    const dir = join(task.dir, `Torrent [${task.id}]`)
    await fs.mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    if (!(await fs.lstat(dir)).isDirectory() || await fs.realpath(dir) !== dir) {
      throw new Error('Choose a regular torrent destination.')
    }
    return dir
  }

  async startOrResume(handle: TaskHandle): Promise<void> {
    const { task, signal } = handle
    const [source, dir, client, { default: Storage }] = await Promise.all([
      this.source(task, signal), this.workDir(task), this.init(), import('fs-chunk-store')
    ])
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      let session: Session
      let failure: Error | undefined
      const fail = (message: string): void => {
        if (signal.aborted) return
        failure ??= new Error(message)
        void this.remove(task.id).catch(reject)
      }
      class SafeStorage {
        constructor(length: number, opts: { length: number; files: TorrentFile[]; path: string }) {
          try {
            validateTorrentPaths(dir, opts.files)
            return new Storage(length, opts)
          } catch {
            queueMicrotask(() => fail('Unsafe or conflicting file paths in torrent metadata.'))
            const closed = (done: () => void): void => queueMicrotask(done)
            return {
              put: (_index: number, _data: Buffer, cb: (error: Error) => void) =>
                queueMicrotask(() => cb(new Error('Torrent store rejected.'))),
              get: (_index: number, _opts: unknown, cb: (error: Error) => void) =>
                queueMicrotask(() => cb(new Error('Torrent store rejected.'))),
              close: closed, destroy: closed
            } as unknown as SafeStorage
          }
        }
      }
      const torrent: Torrent = client.add(source, {
        path: dir, store: SafeStorage, storeCacheSlots: 8,
        strategy: task.torrent?.sequential ? 'sequential' : 'rarest',
        deselect: true, destroyStoreOnDestroy: false
      })
      const timeout = setTimeout(() => fail('Timed out waiting for torrent metadata and verification.'), MAX_WAIT)
      const stop = (): void => { void this.remove(task.id) }
      const finish = (): void => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', stop)
        if (failure) reject(failure)
        else resolve()
      }
      session = {
        torrent, handle, dir, metadata: false, ready: false, started: false, finishing: false,
        selected: task.torrent?.fileIndices ? new Set(task.torrent.fileIndices) : undefined,
        finish
      }
      this.sessions.set(task.id, session)
      this.poll ??= setInterval(() => this.tick(), 1000)
      signal.addEventListener('abort', stop, { once: true })
      torrent.once('error', () => fail('Invalid, duplicate or inaccessible torrent.'))
      torrent.once('metadata', () => {
        if (torrent.destroyed || signal.aborted) return
        void this.saveMetadata(session).then(() => {
          if (torrent.destroyed || signal.aborted) return
          session.metadata = true
          this.begin(session)
        }, () => fail('Could not save the torrent metadata.'))
      })
      torrent.once('ready', () => {
        session.ready = true
        clearTimeout(timeout)
        if (!torrent.destroyed && !signal.aborted) this.begin(session)
      })
    })
  }

  private async saveMetadata(session: Session): Promise<void> {
    const { task } = session.handle
    const data = Buffer.from(session.torrent.torrentFile)
    if (!data.length || data.length > MAX_TORRENT_BYTES) throw new Error('Torrent metadata is too large.')
    const folder = join(app.getPath('userData'), 'torrents')
    await fs.mkdir(folder, { recursive: true, mode: 0o700 })
    const path = join(folder, `${task.id}.torrent`)
    if (task.torrent?.torrentFile !== path) await atomicWrite(path, data)
    if (!session.handle.signal.aborted && task.torrent) {
      session.handle.patch({ torrent: { ...task.torrent, torrentFile: path } })
    }
  }

  private begin(session: Session): void {
    if (!session.ready || !session.metadata || session.handle.task.status !== 'connecting') return
    const { torrent, handle } = session
    session.started = true
    this.updateSelection(session)
    handle.patch({ status: 'downloading', name: sanitizeFileName(torrent.name), fileName: sanitizeFileName(torrent.name) })
    this.update(session)
  }

  private updateSelection(session: Session): void {
    const { torrent, selected } = session
    torrent.files.forEach((file: TorrentFile, i: number) => {
      if (!selected || selected.has(i)) file.select()
    })
  }

  selectFiles(id: string, indices: number[]): void {
    const session = this.sessions.get(id)
    if (!session?.started || session.finishing) return
    const previous = session.selected
    const next = new Set(indices)
    session.torrent.files.forEach((file: TorrentFile, index: number) => {
      const wasSelected = !previous || previous.has(index)
      if (wasSelected && !next.has(index)) file.deselect()
      else if (!wasSelected && next.has(index)) file.select()
    })
    session.selected = next
    this.update(session)
  }

  private tick(): void {
    for (const session of this.sessions.values()) {
      if (!session.started || session.finishing || session.handle.signal.aborted) continue
      this.update(session)
    }
  }

  private update(session: Session): void {
    const { torrent, handle, selected, dir } = session
    if (torrent.destroyed || !handle.task.torrent) return
    const files: TorrentFileEntry[] = torrent.files.map((file: TorrentFile, i: number) => ({
      name: sanitizeFileName(file.name), path: file.path, length: file.length,
      downloaded: file.done ? file.length : Math.max(0, Math.min(file.length, file.downloaded || 0)),
      selected: !selected || selected.has(i)
    }))
    const wanted = files.filter((file) => file.selected)
    const size = wanted.reduce((total, file) => total + file.length, 0)
    const downloaded = wanted.reduce((total, file) => total + file.downloaded, 0)
    const done = wanted.length > 0 && torrent.files.every((file: TorrentFile, i: number) => selected && !selected.has(i) || file.done)
    const seeding = Boolean(done && torrent.done && this.host.settings().seedAfterComplete)
    handle.patch({
      size, downloaded, connections: done ? 0 : torrent.numPeers || 0,
      torrent: {
        ...handle.task.torrent, infoHash: torrent.infoHash || '', peers: torrent.numPeers || 0,
        uploadSpeed: torrent.uploadSpeed || 0, uploaded: torrent.uploaded || 0,
        ratio: Number.isFinite(torrent.ratio) ? torrent.ratio : 0,
        files, seeding
      }
    })
    if (!done || handle.task.status === 'completed') return
    handle.patch({
      status: 'completed', completedAt: Date.now(), speed: 0, eta: 0,
      filePath: wanted.length === 1 && wanted[0].length > 0 ? join(dir, wanted[0].path) : dir
    })
    if (seeding) session.finish()
    else void this.remove(handle.task.id)
  }

  pause(id: string): void { void this.remove(id) }

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.closing) return session.closing
    session.finishing = true
    const closing = new Promise<void>((resolve) => {
      if (session.torrent.destroyed) resolve()
      else session.torrent.destroy({ destroyStore: false }, () => resolve())
    }).then(() => {
      this.sessions.delete(id)
      if (!this.sessions.size) {
        clearInterval(this.poll)
        this.poll = undefined
      }
      session.finish()
    })
    session.closing = closing
    return closing
  }

  setLimit(limit: number): void {
    this.client?.throttleDownload(limit || -1)
    this.client?.throttleUpload(this.host.settings().seedAfterComplete ? -1 : 0)
  }

  status(): 'idle' | 'ready' | 'starting' | 'unavailable' { return this.state }

  async destroy(): Promise<void> {
    this.destroyed = true
    await this.initializing?.catch(() => undefined)
    await Promise.all([...this.sessions.keys()].map((id) => this.remove(id)))
    if (this.client) await new Promise<void>((resolve) => this.client.destroy(() => resolve()))
    this.client = undefined
    await this.network.close()
  }
}
