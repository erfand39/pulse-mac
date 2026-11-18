import { Notification, app, nativeTheme, shell, clipboard, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { basename, join, isAbsolute } from 'node:path'
import type {
  AddDownloadInput,
  AddTorrentInput,
  DownloadTask,
  GlobalStats,
  MainEvent,
  ProbeResult,
  ResumeWithUrlResult,
  Settings,
  SpeedSample,
  TaskKind,
  TaskStatus
} from '@shared/types'
import { Store } from './store'
import {
  GlobalThrottle,
  categoryFor,
  ensureDir,
  guessNameFromUrl,
  isYoutubeUrl,
  sanitizeFileName
} from './util'
import { HttpEngine, type EngineHost, type TaskHandle } from './engines/http'
import { YoutubeEngine } from './engines/youtube'
import { TorrentEngine } from './engines/torrent'
import { applyLaunchAtStartup } from './autostart'
import { atomicWrite, readLocalFile } from './durable-file'
import { httpUrl, MAX_TORRENT_BYTES } from './validate'

interface ManagerDeps {
  store: Store
  emit: (event: MainEvent) => void
  openTaskView?: (id: string) => void
}

const ACTIVE: TaskStatus[] = ['connecting', 'downloading', 'verifying']
const RESUMABLE: TaskStatus[] = ['paused', 'error', 'canceled']

export class DownloadManager implements EngineHost {
  readonly store: Store
  readonly http: HttpEngine
  readonly youtube: YoutubeEngine
  readonly torrent: TorrentEngine
  readonly throttle = new GlobalThrottle()
  private emit: (event: MainEvent) => void
  private tasks = new Map<string, DownloadTask>()
  private controllers = new Map<string, AbortController>()
  private pendingAdds = new Set<string>()
  private runs = new Map<string, Promise<void>>()
  private operations = new Map<string, Promise<unknown>>()
  private operationAbort = new AbortController()
  private sleeping = false
  private offline = false
  private reconnectTasks = new Set<string>()
  private wakeTasks = new Set<string>()
  private queuePaused = false
  private autoNames = new Set<string>()
  private resumeFlags = new Set<string>()
  private lastDownloaded = new Map<string, number>()
  private history: SpeedSample[] = []
  private ticker: NodeJS.Timeout | null = null
  private toolStatus = {
    ytdlp: { available: false } as { available: boolean; version?: string; path?: string },
    ffmpeg: { available: false } as { available: boolean; path?: string }
  }
  private shuttingDown = false
  private shutdownResume = new Set<string>()
  private lastStatsEmit = 0
  private openTaskView?: (id: string) => void

  constructor(deps: ManagerDeps) {
    this.store = deps.store
    this.emit = deps.emit
    this.openTaskView = deps.openTaskView
    this.store.onSaveError = () => this.toast('error', 'Pulse Mac could not save its state. Check the disk.')
    this.http = new HttpEngine(this)
    this.youtube = new YoutubeEngine(this)
    this.torrent = new TorrentEngine(this)
  }

  settings(): Settings {
    return this.store.settings
  }

  async init(): Promise<void> {
    const saved = this.store.tasks
    const autoResume = this.store.settings.autoResume
    for (const raw of saved) {
      const task: DownloadTask = {
        ...raw,
        speed: 0,
        eta: 0,
        connections: 0,
        error: raw.status === 'error' ? raw.error : undefined
      }
      if (ACTIVE.includes(task.status) || task.status === 'queued') {
        if (task.status === 'queued' || autoResume) {
          task.status = 'queued'
        } else {
          task.status = 'paused'
        }
      }
      this.tasks.set(task.id, task)
      this.lastDownloaded.set(task.id, task.downloaded)
    }
    this.throttle.setLimit(this.store.settings.globalSpeedLimit)
    this.ticker = setInterval(() => this.tick(), 1000)
    void this.refreshTools()
    if (this.store.settings.globalSpeedLimit > 0) {
      this.torrent.setLimit(this.store.settings.globalSpeedLimit)
    }
    setTimeout(() => this.schedule(), 700)
  }

  private async refreshTools(): Promise<void> {
    try {
      const status = await this.youtube.status()
      this.toolStatus = status
    } catch {
      this.toolStatus = {
        ytdlp: { available: false },
        ffmpeg: { available: false }
      }
    }
    this.emitStats(true)
  }

  list(): DownloadTask[] {
    return [...this.tasks.values()].sort((a, b) => b.order - a.order)
  }

  get(id: string): DownloadTask | undefined {
    return this.tasks.get(id)
  }

  patch(task: DownloadTask, patch: Partial<DownloadTask>): void {
    const wasCompleted = task.status === 'completed'
    Object.assign(task, patch)
    task.updatedAt = Date.now()
    if (patch.fileName && this.autoNames.has(task.id)) task.name = patch.fileName
    if (patch.fileName) task.category = categoryFor(patch.fileName)
    this.persistSoon()
    if (!wasCompleted && task.status === 'completed') this.handleCompleted(task)
    this.emit({ type: 'task:update', task })
    if (wasCompleted !== (task.status === 'completed')) this.emitStats(true)
  }

  private handleCompleted(task: DownloadTask): void {
    task.speed = 0
    task.eta = 0
    task.connections = 0
    if (this.store.settings.notifyOnComplete && Notification.isSupported()) {
      try {
        const notification = new Notification({
          title: this.settings().language === 'fa' ? 'دانلود کامل شد' : 'Download complete',
          body: task.name
        })
        notification.on('click', () => this.openTaskView?.(task.id))
        notification.show()
      } catch {
        /* ignore */
      }
    }
    void this.store.flush().catch(() => this.store.onSaveError?.())
  }

  toast(level: 'info' | 'success' | 'error', message: string): void {
    this.emit({ type: 'toast', level, message })
  }

  async probe(url: string, headers?: Record<string, string>): Promise<ProbeResult> {
    const probe = await this.http.probe(url, headers || {})
    return {
      url,
      finalUrl: probe.finalUrl,
      fileName: probe.fileName,
      size: probe.size,
      resumable: probe.resumable,
      contentType: probe.contentType,
      headers: probe.headers
    }
  }

  async addDownload(input: AddDownloadInput): Promise<DownloadTask> {
    const rawUrl = (input.url || '').trim()
    if (!rawUrl) throw new Error('URL is empty')
    if (/^magnet:/i.test(rawUrl)) return this.addTorrent({ uri: rawUrl, dir: input.dir })
    let url: string
    try {
      url = new URL(rawUrl).toString()
    } catch {
      throw new Error('This does not look like a valid URL')
    }
    url = httpUrl.parse(url)

    const kind: TaskKind =
      input.kind === 'youtube' || (input.kind !== 'http' && isYoutubeUrl(url))
        ? 'youtube'
        : 'http'

    this.requireRunning()
    const dir = await this.downloadDir(input.dir)

    const fallbackName = guessNameFromUrl(url)
    const fileName = sanitizeFileName(
      input.fileName ||
        (kind === 'youtube'
          ? `${sanitizeFileName(input.title || 'video')}.${input.youtube?.audioOnly ? 'm4a' : 'mp4'}`
          : fallbackName)
    )

    const task: DownloadTask = {
      id: randomUUID(),
      kind,
      url,
      name: input.title || fileName,
      fileName,
      dir,
      status: 'queued',
      size: 0,
      downloaded: 0,
      speed: 0,
      eta: 0,
      connections: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      headers: input.headers,
      checksum: input.checksum,
      thumbnail: input.thumbnail,
      maxConnections: input.connections,
      category: categoryFor(fileName),
      order: this.nextOrder()
    }
    this.autoNames.add(task.id)
    if (kind === 'youtube') {
      this.autoNames.delete(task.id)
      task.name = input.title || fileName
      task.youtube = {
        title: input.title || fileName,
        uploader: input.youtube?.uploader,
        duration: input.youtube?.duration,
        thumbnail: input.thumbnail,
        quality: input.youtube?.quality,
        formatId: input.youtube?.selector || 'bestvideo*+bestaudio/best',
        audioOnly: !!input.youtube?.audioOnly,
        audioFormat: input.youtube?.audioFormat,
        subtitles: input.youtube?.subtitles,
        embedThumbnail: input.youtube?.thumbnail,
        videoId: input.youtube?.videoId,
        playlistIndex: input.youtube?.playlistIndex,
        playlistCount: input.youtube?.playlistCount
      }
    }
    return this.enqueue(task)
  }

  async addTorrent(input: AddTorrentInput): Promise<DownloadTask> {
    this.requireRunning()
    const dir = await this.downloadDir(input.dir)
    let name = input.name?.replace(/\.torrent$/i, '') || 'Torrent'
    let uri = input.uri?.trim() || ''
    if (/^magnet:/i.test(uri)) {
      const dn = /[?&]dn=([^&]+)/.exec(uri)?.[1]
      if (dn) name = decodeURIComponent(dn.replace(/\+/g, ' '))
    }
    if (!uri && !input.data) throw new Error('No torrent source provided')
    if (/^https?:/i.test(uri) && /\.torrent($|\?)/i.test(uri)) name = guessNameFromUrl(uri).replace(/\.torrent$/i, '')

    const task: DownloadTask = {
      id: randomUUID(),
      kind: 'torrent',
      url: uri || `file:${input.name || 'torrent'}`,
      name: sanitizeFileName(name),
      fileName: sanitizeFileName(name),
      dir,
      status: 'queued',
      size: 0,
      downloaded: 0,
      speed: 0,
      eta: 0,
      connections: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      category: 'other',
      order: this.nextOrder(),
      torrent: {
        infoHash: '',
        peers: 0,
        seeds: 0,
        uploadSpeed: 0,
        uploaded: 0,
        ratio: 0,
        files: [],
        sequential: input.sequential ?? true,
        seeding: false
      }
    }
    if (input.data) {
      const data = Buffer.from(input.data, 'base64')
      if (!data.length || data.length > MAX_TORRENT_BYTES) throw new Error('Invalid torrent file size.')
      const dir = join(app.getPath('userData'), 'torrents')
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${task.id}.torrent`)
      await atomicWrite(path, data)
      task.torrent!.torrentFile = path
    } else if (isAbsolute(uri)) {
      throw new Error('Select the torrent file through the file picker.')
    }
    task.torrent!.fileIndices = input.fileIndices
    return this.enqueue(task)
  }

  async addTorrentFile(path: string, input: AddTorrentInput = {}): Promise<DownloadTask> {
    if (!/\.torrent$/i.test(path)) throw new Error('Choose a .torrent file.')
    const data = await readLocalFile(path, MAX_TORRENT_BYTES)
    return this.addTorrent({
      ...input, uri: undefined, data: data.toString('base64'),
      name: input.name || path.split('/').pop()
    })
  }

  private requireRunning(): void {
    if (this.shuttingDown) throw new Error('Pulse Mac is quitting.')
  }

  private async downloadDir(path?: string): Promise<string> {
    const dir = path?.trim() || this.store.settings.downloadDir
    if (!isAbsolute(dir)) throw new Error('Choose an absolute download folder.')
    await ensureDir(dir)
    return fs.realpath(dir)
  }

  private async enqueue(task: DownloadTask): Promise<DownloadTask> {
    this.requireRunning()
    task.order = this.nextOrder()
    this.pendingAdds.add(task.id)
    this.tasks.set(task.id, task)
    this.lastDownloaded.set(task.id, 0)
    this.persistSoon()
    try {
      await this.store.flush()
    } catch (error) {
      this.tasks.delete(task.id)
      this.lastDownloaded.delete(task.id)
      this.persistSoon()
      throw error
    } finally {
      this.pendingAdds.delete(task.id)
    }
    this.emit({ type: 'task:add', task })
    this.emitStats(true)
    this.schedule()
    return task
  }

  async resolveProxy(url: string): Promise<string | undefined> {
    const proxy = this.settings().proxy
    if (!proxy || proxy === 'direct') return undefined
    if (proxy !== 'system') return proxy
    const result = await session.defaultSession.resolveProxy(url)
    const [kind, endpoint] = result.split(';')[0].trim().split(/\s+/)
    if (kind === 'DIRECT') return undefined
    const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5' }[kind]
    if (!scheme || !endpoint) throw new Error('The system proxy type is unsupported.')
    return `${scheme}://${endpoint}`
  }

  private nextOrder(): number {
    const orders = [...this.tasks.values()].map((t) => t.order)
    return (orders.length ? Math.max(...orders) : 0) + 1
  }

  private persistSoon(): void {
    this.store.tasks = this.list()
  }

  private schedule(): void {
    if (this.shuttingDown || this.sleeping || this.offline || this.queuePaused) return
    const active = this.runs.size
    const limit = Math.max(1, this.store.settings.maxConcurrent)
    let slots = limit - active
    if (slots <= 0) return
    const queued = [...this.tasks.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.order - b.order)
    for (const task of queued) {
      if (slots <= 0) break
      if (this.pendingAdds.has(task.id) || this.runs.has(task.id) || this.operations.has(task.id)) continue
      slots--
      const run = Promise.resolve().then(async () => {
        if (task.status === 'queued') await this.startTask(task)
      }).finally(() => {
        this.runs.delete(task.id)
        this.schedule()
        this.emitStats(true)
      })
      this.runs.set(task.id, run)
    }
  }

  private async startTask(task: DownloadTask): Promise<void> {
    if (this.controllers.has(task.id) || this.shuttingDown) return
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    const handle: TaskHandle = {
      task,
      signal: controller.signal,
      patch: (patch) => this.patch(task, patch),
      toast: (level, message) => this.toast(level, message)
    }
    this.patch(task, { status: 'connecting', error: undefined, speed: 0, eta: 0 })
    this.emitStats(true)
    try {
      if (task.kind === 'http') {
        const resume = this.resumeFlags.has(task.id) || task.downloaded > 0
        await this.http.start(handle, resume)
      } else if (task.kind === 'youtube') {
        const yt = task.youtube
        await this.youtube.start(handle, {
          audioOnly: !!yt?.audioOnly,
          extractAudio: yt?.audioFormat === 'mp3',
          subtitles: !!yt?.subtitles,
          thumbnail: !!yt?.embedThumbnail
        })
      } else {
        await this.torrent.startOrResume(handle)
      }
    } catch (err) {
      if (controller.signal.aborted && task.status !== 'completed') {
        this.patch(task, { status: 'paused', speed: 0, eta: 0, connections: 0 })
      } else if (!controller.signal.aborted) {
        this.patch(task, {
          status: 'error',
          error: (err as Error).message || 'Download failed',
          speed: 0,
          eta: 0,
          connections: 0
        })
      }
    } finally {
      this.controllers.delete(task.id)
      this.resumeFlags.delete(task.id)
      if (ACTIVE.includes(task.status)) this.patch(task, { status: 'paused', speed: 0, eta: 0, connections: 0 })
      this.lastDownloaded.set(task.id, task.downloaded)
    }
  }

  private operate<T>(id: string, action: (task: DownloadTask) => Promise<T>, missing: T): Promise<T> {
    this.requireRunning()
    const previous = this.operations.get(id) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(async () => {
      const task = this.tasks.get(id)
      return task ? action(task) : missing
    }).finally(() => {
      if (this.operations.get(id) === run) this.operations.delete(id)
      this.schedule()
    })
    this.operations.set(id, run)
    return run
  }

  private async stop(task: DownloadTask): Promise<void> {
    this.controllers.get(task.id)?.abort()
    if (task.kind === 'torrent') this.torrent.pause(task.id)
    if (task.kind === 'youtube') this.youtube.stop(task.id)
    await this.runs.get(task.id)
  }

  pause(id: string): Promise<void> {
    return this.operate(id, async (task) => {
      if (!ACTIVE.includes(task.status) && task.status !== 'queued') return
      await this.stop(task)
      if (task.status !== 'completed') this.patch(task, { status: 'paused', speed: 0, eta: 0, connections: 0 })
      await this.store.flush()
    }, undefined)
  }

  resume(id: string, unpauseQueue = true): Promise<void> {
    if (unpauseQueue) this.queuePaused = false
    return this.operate(id, async (task) => {
      if (!RESUMABLE.includes(task.status)) return
      if (!task.url) throw new Error('Unlock the macOS Keychain and reopen Pulse Mac, or supply a new link.')
      this.resumeFlags.add(id)
      this.patch(task, { status: 'queued', error: undefined, speed: 0, eta: 0, connections: 0 })
      await this.store.flush()
    }, undefined)
  }

  resumeWithUrl(id: string, rawUrl: string): Promise<ResumeWithUrlResult> {
    return this.operate<ResumeWithUrlResult>(id, async (task) => {
      if (task.kind !== 'http' || task.status === 'completed') {
        return { ok: false, error: 'Only unfinished HTTP downloads can use a new link.' }
      }
      const url = httpUrl.parse(rawUrl.trim())
      await this.stop(task)
      if (this.get(id)?.status === 'completed') return { ok: false, error: 'This download is already complete.' }
      try {
        const { size, restarted } = await this.http.resumeWithUrl(task, url, this.operationAbort.signal)
        this.patch(task, {
          url, status: 'queued', error: undefined, linkExpired: false, speed: 0, eta: 0, connections: 0,
          downloaded: restarted ? 0 : task.downloaded, segments: restarted ? undefined : task.segments, size
        })
        await this.store.flush()
        return { ok: true, restarted }
      } catch {
        return { ok: false, error: 'Could not use the replacement link. Your partial file was preserved.' }
      }
    }, { ok: false, error: 'Download not found.' })
  }

  cancel(id: string): Promise<void> {
    return this.operate(id, async (task) => {
      if (task.status === 'completed') return
      await this.stop(task)
      if (task.kind === 'torrent') await this.torrent.remove(id)
      if (this.get(id)?.status !== 'completed') this.patch(task, { status: 'canceled', speed: 0, eta: 0, connections: 0 })
      await this.store.flush()
    }, undefined)
  }

  remove(id: string, deleteFile: boolean): Promise<void> {
    return this.operate(id, async (task) => {
      await this.stop(task)
      if (task.kind === 'torrent') await this.torrent.remove(id)
      if (deleteFile) {
        if (task.kind === 'http') await this.http.deleteOwnedFiles(task)
        else throw new Error('Remove this download from the list, then delete its files in Finder.')
      }
      this.tasks.delete(id)
      this.lastDownloaded.delete(id)
      this.autoNames.delete(id)
      this.resumeFlags.delete(id)
      this.emit({ type: 'task:remove', id })
      this.persistSoon()
      await this.store.flush()
      this.emitStats(true)
    }, undefined)
  }

  prioritize(id: string): Promise<void> {
    return this.operate(id, async (task) => {
      if (task.status !== 'queued') return
      const order = this.list().reduce((min, item) => Math.min(min, item.order), 0) - 1
      this.patch(task, { order })
      await this.store.flush()
    }, undefined)
  }

  selectTorrentFiles(id: string, indices: number[]): Promise<void> {
    return this.operate(id, async (task) => {
      if (!task.torrent || task.status === 'completed') return
      if (indices.some((index) => index >= task.torrent!.files.length)) throw new Error('Invalid file selection.')
      this.patch(task, { torrent: { ...task.torrent, fileIndices: indices } })
      this.torrent.selectFiles(id, indices)
      await this.store.flush()
    }, undefined)
  }

  async networkChanged(online: boolean): Promise<void> {
    if (this.shuttingDown || this.offline === !online) return
    this.offline = !online
    if (!online) {
      this.reconnectTasks = new Set(this.list().filter((task) => ACTIVE.includes(task.status)).map((task) => task.id))
      await Promise.all([...this.reconnectTasks].map((id) => this.pause(id)))
      return
    }
    const interrupted = [...this.reconnectTasks]
    this.reconnectTasks.clear()
    if (this.settings().autoResume && !this.queuePaused) {
      await Promise.all(interrupted.map((id) => this.resume(id, false)))
    }
    this.schedule()
  }

  retry(id: string): Promise<void> { return this.resume(id) }

  async pauseAll(): Promise<void> {
    this.queuePaused = true
    try {
      await Promise.all(this.list().map((task) => this.pause(task.id)))
    } catch {
      this.store.onSaveError?.()
    }
  }

  async resumeAll(): Promise<void> {
    this.queuePaused = true
    try {
      await Promise.all(this.list().filter((task) => task.status === 'paused').map((task) => this.resume(task.id, false)))
    } catch {
      this.store.onSaveError?.()
    } finally {
      this.queuePaused = false
      this.schedule()
    }
  }

  async suspend(): Promise<void> {
    this.sleeping = true
    this.wakeTasks = new Set(this.list().filter((task) => ACTIVE.includes(task.status)).map((task) => task.id))
    try {
      await Promise.all([...this.wakeTasks].map((id) => this.pause(id)))
    } catch {
      this.store.onSaveError?.()
    }
  }

  async wake(): Promise<void> {
    try {
      if (this.settings().autoResume && !this.queuePaused) {
        await Promise.all([...this.wakeTasks].map((id) => this.resume(id, false)))
      }
    } catch {
      this.store.onSaveError?.()
    } finally {
      this.wakeTasks.clear()
      this.sleeping = false
      this.schedule()
    }
  }

  reveal(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    const target = task.filePath && existsSync(task.filePath) ? task.filePath : task.dir
    if (existsSync(target)) shell.showItemInFolder(target)
    else void shell.openPath(task.dir)
  }

  async open(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status !== 'completed') return
    const target = task.filePath
    if (target && existsSync(target)) {
      const err = await shell.openPath(target)
      if (err) this.toast('error', `Could not open the file: ${err}`)
    } else {
      this.toast('info', 'The file is not on disk yet.')
    }
  }

  clearCompleted(): void {
    for (const task of [...this.tasks.values()]) {
      if (task.status === 'completed') {
        this.tasks.delete(task.id)
        this.lastDownloaded.delete(task.id)
        this.emit({ type: 'task:remove', id: task.id })
      }
    }
    this.persistSoon()
    this.emitStats(true)
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.launchAtStartup !== undefined) {
      patch = { ...patch, launchAtStartup: applyLaunchAtStartup(patch.launchAtStartup) }
    }
    const settings = this.store.patchSettings(patch)
    if (patch.globalSpeedLimit !== undefined || patch.seedAfterComplete !== undefined) {
      this.throttle.setLimit(settings.globalSpeedLimit)
      this.torrent.setLimit(settings.globalSpeedLimit)
    }
    if (patch.maxConcurrent !== undefined) this.schedule()
    if (patch.ytDlpPath !== undefined || patch.ffmpegPath !== undefined) {
      void this.rescanTools()
    }
    if (patch.theme !== undefined) {
      nativeTheme.themeSource = settings.theme
    }
    this.emit({ type: 'settings', settings })
    this.emitStats(true)
    return settings
  }

  setSpeedLimit(bytes: number): void {
    this.updateSettings({ globalSpeedLimit: Math.max(0, bytes) })
  }

  private tick(): void {
    if (!this.runs.size && !this.list().some((task) => task.torrent?.seeding)) return
    const now = Date.now()
    for (const task of this.tasks.values()) {
      const last = this.lastDownloaded.get(task.id) ?? task.downloaded
      const isActive = task.status === 'downloading'
      if (isActive) {
        const delta = Math.max(0, task.downloaded - last)
        // Exponential smoothing keeps the readout from jumping around.
        task.speed = task.speed ? Math.round(task.speed * 0.55 + delta * 0.45) : delta
        if (task.size > 0) {
          task.eta = task.speed > 8 ? Math.round((task.size - task.downloaded) / task.speed) : 0
        } else {
          task.eta = 0
        }
        this.emit({ type: 'task:update', task })
      } else if (task.speed !== 0) {
        task.speed = 0
        task.eta = 0
      }
      this.lastDownloaded.set(task.id, task.downloaded)
    }
    this.emitStats(false, now)
  }

  stats(): GlobalStats {
    const tasks = [...this.tasks.values()]
    const down = tasks.reduce((acc, t) => acc + (t.status === 'downloading' ? t.speed : 0), 0)
    const up = tasks.reduce(
      (acc, t) => acc + (t.kind === 'torrent' ? t.torrent?.uploadSpeed || 0 : 0),
      0
    )
    return {
      downSpeed: down,
      upSpeed: up,
      activeCount: tasks.filter((t) => ACTIVE.includes(t.status)).length,
      queuedCount: tasks.filter((t) => t.status === 'queued').length,
      completedCount: tasks.filter((t) => t.status === 'completed').length,
      totalDownloaded: tasks.reduce((acc, t) => acc + t.downloaded, 0),
      history: this.history,
      torrentEngine: this.torrent.status(),
      ytdlp: this.toolStatus.ytdlp,
      ffmpeg: this.toolStatus.ffmpeg
    }
  }

  private emitStats(force = false, now = Date.now()): void {
    if (!force && now - this.lastStatsEmit < 900) return
    this.lastStatsEmit = now
    const stats = this.stats()
    this.history.push({ t: now, down: stats.downSpeed, up: stats.upSpeed })
    if (this.history.length > 90) this.history.shift()
    this.emit({ type: 'stats', stats })
  }

  async shutdown(): Promise<void> {
    if (!this.shuttingDown) this.shutdownResume = new Set(this.list().filter((task) => ACTIVE.includes(task.status)).map((task) => task.id))
    this.shuttingDown = true
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.operationAbort.abort()
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled([this.youtube.shutdown(), ...this.operations.values(), ...this.runs.values()])
    await this.torrent.destroy()
    await this.http.shutdown()
    for (const task of this.tasks.values()) {
      if ((ACTIVE.includes(task.status) || task.status === 'paused') && this.shutdownResume.has(task.id)) {
        task.status = this.settings().autoResume ? 'queued' : 'paused'
      }
      task.speed = 0
      task.eta = 0
      task.connections = 0
    }
    this.persistSoon()
    await this.store.flush()
  }

  async readClipboardUrl(): Promise<string> {
    const text = (await clipboard.readText()).trim()
    if (/^(https?:\/\/|magnet:)/i.test(text) && text.length < 4096) return text
    return ''
  }

  revealDir(dir: string): void {
    if (existsSync(dir)) void shell.openPath(dir)
  }

  async installYtdlp(): Promise<{ ok: boolean; message: string }> {
    const result = await this.youtube.install()
    if (result.ok) {
      this.toast('success', result.message)
      await this.refreshTools()
    } else {
      this.toast('error', result.message)
    }
    return result
  }

  async rescanTools(): Promise<void> {
    try {
      this.toolStatus = await this.youtube.rescan()
    } catch {
      this.toolStatus = {
        ytdlp: { available: false },
        ffmpeg: { available: false }
      }
    }
    this.emitStats(true)
  }

  taskTitle(task: DownloadTask): string {
    return task.youtube?.title || task.name || basename(task.fileName || 'download')
  }
}
