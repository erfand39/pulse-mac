import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { app } from 'electron'
import type { Settings, YoutubeFormatOption, YoutubeProbe, YoutubeMeta } from '@shared/types'
import type { EngineHost, TaskHandle } from './http'
import { ensureDir, sanitizeFileName } from '../util'
import { atomicWrite } from '../durable-file'
import { installMacYtDlp, macYtDlpRelease } from './ytdlp-release'
import { httpUrl } from '../validate'

const shutdown = new AbortController()
const utilityRuns = new Set<Promise<unknown>>()
const toolEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':'),
  PYTHONIOENCODING: 'utf-8',
  PULSE_NODE_EXECUTABLE: process.execPath
}
delete toolEnvironment.ELECTRON_RUN_AS_NODE
delete toolEnvironment.NODE_OPTIONS
delete toolEnvironment.NODE_EXTRA_CA_CERTS

export interface BinInfo {
  cmd: string
  prefix: string[]
  path: string
  version?: string
}

interface RawFormat {
  format_id?: string
  ext?: string
  height?: number | null
  width?: number | null
  vcodec?: string
  acodec?: string
  filesize?: number | null
  filesize_approx?: number | null
  tbr?: number | null
  abr?: number | null
  fps?: number | null
  format_note?: string
  protocol?: string
}

function friendlyYoutubeError(raw: string): string {
  const text = (raw || '').replace(/\s+/g, ' ').trim()
  if (/sign in to confirm|not a bot|confirm you.{0,3}re not a bot/i.test(text)) {
    return 'YouTube requested a sign-in check. Open Settings → Tools and add cookies (pick your browser or a cookies.txt file), then retry.'
  }
  if (/private video|members[- ]only|join this channel/i.test(text)) {
    return 'This video is private or members-only. Add cookies from an account with access in Settings → Tools.'
  }
  if (/age[- ]restricted|confirm your age/i.test(text)) {
    return 'This video is age-restricted. Add cookies from a signed-in account in Settings → Tools.'
  }
  return ''
}

function runCapture(
  cmd: string,
  args: string[],
  timeout = 15_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const active = AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeout)])
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    if (active.aborted) return resolve({ code: -1, stdout: '', stderr: '' })
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args, { detached: true, env: toolEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
    const abort = (): void => killTree(child, 'SIGKILL')
    active.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
      if (stdout.length > 8_000_000) abort()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-30_000)
    })
    child.on('error', () => { /* close follows error */ })
    child.on('close', (code) => {
      active.removeEventListener('abort', abort)
      resolve({ code, stdout, stderr })
    })
  })
  utilityRuns.add(result)
  void result.finally(() => utilityRuns.delete(result))
  return result
}

function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

export function bundledBin(name: string): string {
  const exe = name
  const candidates = [
    join(process.resourcesPath || '', 'bin', exe),
    join(app.getAppPath(), 'resources', 'bin', exe),
    join(app.getAppPath(), '..', 'resources', 'bin', exe),
    join(app.getPath('userData'), 'bin', exe)
  ]
  return candidates.find((p) => existsSync(p)) || ''
}

export class YoutubeEngine {
  private host: EngineHost
  private binCache: BinInfo | null = null
  private childs = new Map<string, ChildProcess>()
  private ffmpegCache: string | null | undefined = undefined
  private installation?: Promise<{ ok: boolean; message: string }>
  private jsRuntimeCache: string | null | undefined = undefined
  versionCache = ''

  constructor(host: EngineHost) {
    this.host = host
  }

  async resolveBin(force = false): Promise<BinInfo | null> {
    if (this.binCache && !force) return this.binCache
    const settings = this.host.settings()
    const candidates: Array<{ cmd: string; prefix: string[] }> = []

    if (settings.ytDlpPath && existsSync(settings.ytDlpPath)) {
      candidates.push({ cmd: settings.ytDlpPath, prefix: [] })
    }
    const bundled = bundledBin('yt-dlp')
    if (bundled) candidates.push({ cmd: bundled, prefix: [] })
    candidates.push({ cmd: 'yt-dlp', prefix: [] })

    for (const candidate of candidates) {
      if (candidate.cmd.includes('\\') || candidate.cmd.includes('/')) {
        if (!existsSync(candidate.cmd)) continue
      }
      const res = await runCapture(candidate.cmd, [...candidate.prefix, '--version'], 12_000)
      if (res.code === 0 && /^\d{4}\.\d{2}\.\d{2}/m.test(res.stdout)) {
        const version = (res.stdout.match(/\d{4}\.\d{2}\.\d{2}[^\s]*/) || [res.stdout.trim()])[0]
        this.binCache = { ...candidate, path: candidate.cmd, version }
        this.versionCache = version
        return this.binCache
      }
    }
    this.binCache = null
    return null
  }

  async resolveFfmpeg(): Promise<string | null> {
    if (this.ffmpegCache !== undefined) return this.ffmpegCache
    const settings = this.host.settings()
    const candidates = [
      settings.ffmpegPath,
      bundledBin('ffmpeg'),
      'ffmpeg'
    ].filter(Boolean)

    const locate = async (cmd: string): Promise<string | null> => {
      if (isAbsolute(cmd) || cmd.includes('\\') || cmd.includes('/')) {
        return existsSync(cmd) ? resolvePath(cmd) : null
      }
      // `where`/`which` gives yt-dlp the absolute path it needs for
      // --ffmpeg-location (a bare "ffmpeg.exe" would be resolved against CWD).
      const found = await runCapture('/usr/bin/which', [cmd], 6_000)
      if (found.code !== 0) return null
      return (
        found.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) || null
      )
    }

    for (const candidate of candidates) {
      const path = await locate(candidate)
      if (!path) continue
      const res = await runCapture(path, ['-version'], 10_000)
      const probe = await runCapture(join(dirname(path), 'ffprobe'), ['-version'], 10_000)
      if (res.code === 0 && probe.code === 0 && /ffmpeg version/i.test(res.stdout + res.stderr)) {
        this.ffmpegCache = path
        return path
      }
    }
    this.ffmpegCache = null
    return null
  }

  /**
   * yt-dlp 2026+ can use an external JavaScript runtime to solve YouTube's
   * challenge scripts. Node is usually present when the app is installed on a
   * developer machine, so detect it once and pass it through when available.
   */
  private async resolveJsRuntime(): Promise<string | null> {
    if (this.jsRuntimeCache !== undefined) return this.jsRuntimeCache
    for (const runtime of ['deno', 'node']) {
      const chosen = await runCapture('/usr/bin/which', [runtime], 6_000)
      const path = chosen.stdout.trim()
      if (!isAbsolute(path)) continue
      const res = await runCapture(path, ['--version'], 6_000)
      if (res.code === 0) {
        this.jsRuntimeCache = `${runtime}:${path}`
        return this.jsRuntimeCache
      }
    }
    if (process.platform === 'darwin' && process.versions.electron) {
      const dir = join(app.getPath('userData'), 'bin')
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const shim = join(dir, 'pulse-node')
      await atomicWrite(shim, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$PULSE_NODE_EXECUTABLE" "$@"\n')
      await fs.chmod(shim, 0o700)
      const version = await runCapture(shim, ['--version'], 6_000)
      if (version.code === 0 && /^v\d+/.test(version.stdout)) {
        this.jsRuntimeCache = `node:${shim}`
        return this.jsRuntimeCache
      }
    }
    this.jsRuntimeCache = null
    return null
  }

  /** `--js-runtimes` only exists in yt-dlp 2025.11 and newer. */
  private supportsJsRuntime(): boolean {
    const parts = this.versionCache.split('.').map((n) => Number(n))
    const [year, month] = parts
    if (!Number.isFinite(year) || !Number.isFinite(month)) return false
    return year > 2025 || (year === 2025 && month >= 11)
  }

  private async jsRuntimeArgs(): Promise<string[]> {
    if (!this.supportsJsRuntime()) return []
    const runtime = await this.resolveJsRuntime()
    return runtime ? ['--js-runtimes', runtime] : []
  }

  private cookieArgs(): string[] {
    const settings = this.host.settings()
    if (settings.cookiesFile && existsSync(settings.cookiesFile)) {
      return ['--cookies', settings.cookiesFile]
    }
    if (settings.cookiesBrowser) {
      return ['--cookies-from-browser', settings.cookiesBrowser]
    }
    return []
  }

  async status(): Promise<{
    ytdlp: { available: boolean; version?: string; path?: string }
    ffmpeg: { available: boolean; path?: string }
  }> {
    const bin = await this.resolveBin()
    const ffmpeg = await this.resolveFfmpeg()
    return {
      ytdlp: bin
        ? { available: true, version: bin.version, path: bin.path }
        : { available: false },
      ffmpeg: ffmpeg ? { available: true, path: ffmpeg } : { available: false }
    }
  }

  /** Clears the binary caches and probes everything again. */
  async rescan(): Promise<{
    ytdlp: { available: boolean; version?: string; path?: string }
    ffmpeg: { available: boolean; path?: string }
  }> {
    this.binCache = null
    this.ffmpegCache = undefined
    this.jsRuntimeCache = undefined
    const status = await this.status()
    this.versionCache = status.ytdlp.version || ''
    return status
  }

  async probe(url: string): Promise<YoutubeProbe> {
    httpUrl.parse(url)
    const bin = await this.resolveBin()
    if (!bin) {
      throw new Error(
        'yt-dlp was not found. Install it from Settings → Tools, or place the binary in the app "bin" folder.'
      )
    }
    const args = [
      ...bin.prefix,
      '--ignore-config', '-J',
      '--no-warnings',
      '--no-colors',
      '--flat-playlist',
      '--playlist-end',
      '150',
      '--socket-timeout',
      '20',
      '--retries',
      '3',
      ...this.cookieArgs(),
      ...(await this.jsRuntimeArgs()),
      '--', url
    ]
    const res = await runCapture(bin.cmd, args, 90_000)
    if (res.code !== 0 || !res.stdout.trim()) {
      const tail = res.stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ')
      throw new Error(friendlyYoutubeError(tail) || 'yt-dlp could not read this URL')
    }
    let info: Record<string, unknown>
    try {
      info = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')))
    } catch {
      throw new Error('Could not parse yt-dlp metadata')
    }

    if (info._type === 'playlist' || Array.isArray(info.entries)) {
      const rawEntries = (info.entries as Array<Record<string, unknown>>) || []
      const entries = rawEntries
        .filter((e) => e && (e.url || e.webpage_url || e.id))
        .map((e, i) => {
          const thumbs = (e.thumbnails as Array<{ url: string }> | undefined) || []
          const rawUrl = String(e.webpage_url || e.url || '')
          const id = typeof e.id === 'string' ? e.id : ''
          const entryUrl = /^https?:/i.test(rawUrl)
            ? rawUrl
            : id
              ? `https://www.youtube.com/watch?v=${id}`
              : rawUrl
          return {
            url: entryUrl,
            title: String(e.title || `Item ${i + 1}`),
            duration: typeof e.duration === 'number' ? e.duration : undefined,
            thumbnail: thumbs.length ? thumbs[thumbs.length - 1]?.url : typeof e.thumbnail === 'string' ? e.thumbnail : undefined,
            index: i + 1
          }
        })
      return {
        url,
        title: String(info.title || 'Playlist'),
        uploader: typeof info.uploader === 'string' ? info.uploader : undefined,
        isPlaylist: true,
        playlistCount: entries.length,
        entries,
        formats: []
      }
    }

    const formats = (info.formats as RawFormat[]) || []
    const thumbnails = (info.thumbnails as Array<{ url: string }> | undefined) || []
    return {
      url,
      title: String(info.title || 'Untitled'),
      uploader: (info.uploader || info.channel || info.creator) as string | undefined,
      duration: typeof info.duration === 'number' ? info.duration : undefined,
      thumbnail:
        (typeof info.thumbnail === 'string' && info.thumbnail) ||
        thumbnails[thumbnails.length - 1]?.url,
      extractor: (info.extractor_key || info.extractor) as string | undefined,
      viewCount: typeof info.view_count === 'number' ? info.view_count : undefined,
      uploadDate: typeof info.upload_date === 'string' ? info.upload_date : undefined,
      isPlaylist: false,
      formats: this.buildFormats(formats, await this.resolveFfmpeg())
    }
  }

  private buildFormats(raw: RawFormat[], ffmpeg: string | null): YoutubeFormatOption[] {
    const usable = raw.filter((f) => {
      const proto = (f.protocol || '').toLowerCase()
      return f.format_id && !proto.startsWith('mhtml')
    })
    const videos = usable.filter(
      (f) => f.vcodec && f.vcodec !== 'none' && (f.height || 0) > 0
    )
    const audios = usable.filter((f) => f.acodec && f.acodec !== 'none' && f.vcodec === 'none')
    const progressive = usable.filter(
      (f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && (f.height || 0) > 0
    )
    const bestAudio = audios
      .slice()
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0]
    const options: YoutubeFormatOption[] = []

    const heights = Array.from(new Set(videos.map((v) => v.height as number))).sort(
      (a, b) => b - a
    )
    const sizeOf = (f?: RawFormat): number | undefined =>
      f ? f.filesize || f.filesize_approx || undefined : undefined

    options.push({
      id: 'best',
      height: 0,
      ext: 'mp4',
      selector: 'bestvideo*+bestaudio/best',
      audioOnly: false,
      label: 'Best quality',
      note: ffmpeg ? 'auto merge' : 'single file'
    })

    for (const height of heights) {
      const candidates = videos.filter((v) => v.height === height)
      const best = candidates.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0]
      if (!best?.format_id) continue
      const prog = progressive
        .filter((p) => p.height === height)
        .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0]
      const useProgressive = !ffmpeg && !!prog
      const chosen = useProgressive ? prog : best
      const selector =
        useProgressive || !ffmpeg
          ? `${chosen.format_id}/${best.format_id}`
          : bestAudio?.format_id
            ? `${best.format_id}+${bestAudio.format_id}`
            : `${best.format_id}+bestaudio/best`
      const size = sizeOf(chosen) ?? (bestAudio ? (sizeOf(chosen) || 0) + (sizeOf(bestAudio) || 0) : undefined)
      const fps = chosen.fps && chosen.fps > 30 ? `${Math.round(chosen.fps)}fps` : ''
      options.push({
        id: String(chosen.format_id),
        height,
        ext: useProgressive ? chosen.ext || 'mp4' : 'mp4',
        fps: chosen.fps || undefined,
        vcodec: chosen.vcodec,
        acodec: useProgressive ? chosen.acodec : bestAudio?.acodec,
        filesize: size || undefined,
        tbr: chosen.tbr || undefined,
        selector,
        label: `${height}p${fps ? ' ' + fps : ''}`,
        note: chosen.format_note
      })
    }

    if (bestAudio) {
      options.push({
        id: 'audio-m4a',
        height: 0,
        ext: 'm4a',
        audioOnly: true,
        selector: `${bestAudio.format_id}/bestaudio`,
        filesize: sizeOf(bestAudio),
        label: 'Audio · M4A',
        note: ffmpeg ? 'original stream' : 'original'
      })
      if (ffmpeg) {
        options.push({
          id: 'audio-mp3',
          height: 0,
          ext: 'mp3',
          audioOnly: true,
          selector: 'bestaudio/best',
          label: 'Audio · MP3 320k',
          note: 'converted'
        })
      }
    }
    options.push({
      id: 'audio',
      height: 0,
      ext: 'm4a',
      audioOnly: true,
      selector: 'bestaudio/best',
      label: 'Audio only',
      note: 'best'
    })
    return options
  }

  getRunning(id: string): boolean {
    return this.childs.has(id)
  }

  stop(id: string): void {
    const child = this.childs.get(id)
    if (child) killTree(child)
  }

  async start(handle: TaskHandle, opts: { audioOnly?: boolean; extractAudio?: boolean; subtitles?: boolean; thumbnail?: boolean }): Promise<void> {
    const task = handle.task
    const settings = this.host.settings()
    const bin = await this.resolveBin()
    if (!bin) {
      handle.patch({
        status: 'error',
        error: 'yt-dlp is not installed. Open Settings → Tools to download it automatically.'
      })
      return
    }
    const ffmpeg = await this.resolveFfmpeg()
    await ensureDir(task.dir)
    if (handle.signal.aborted) return

    let selector = task.youtube?.formatId || task.youtube?.quality || 'bestvideo*+bestaudio/best'
    if (opts.audioOnly) selector = 'bestaudio/best'
    if (!ffmpeg && selector.includes('+')) {
      // Without ffmpeg yt-dlp cannot merge separate video/audio streams.
      selector = 'best[ext=mp4]/best'
      handle.toast('info', 'ffmpeg is missing. Downloading the best single-file format instead.')
    }
    const dir = join(task.dir, `${sanitizeFileName(task.name).slice(0, 45)} [${task.id}]`)
    await ensureDir(dir)
    if (await fs.realpath(dir) !== dir || !(await fs.lstat(dir)).isDirectory()) {
      throw new Error('The video folder moved or is not a regular directory.')
    }
    const entries = await fs.readdir(dir, { withFileTypes: true })
    if (entries.some((entry) => !entry.isFile())) throw new Error('The video folder contains unsupported files.')
    const outputTemplate = join(dir, '%(title).120B [%(id)s].%(ext)s')
    const args = [
      ...bin.prefix,
      '--no-warnings',
      '--no-colors',
      '--newline',
      '--ignore-config',
      '--no-playlist',
      '--no-overwrites',
      '--print', 'after_move:PULSE_FILE|%(filepath)j',
      '--progress',
      '--continue',
      '--no-mtime',
      '--retries',
      '10',
      '--fragment-retries',
      '10',
      '--concurrent-fragments',
      '4',
      '--socket-timeout',
      '20',
      '--progress-template',
      'PULSE|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '-f',
      selector,
      '-o',
      outputTemplate,
      ...this.cookieArgs()
    ]
    args.push(...(await this.jsRuntimeArgs()))
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg)
    if (settings.globalSpeedLimit > 0) {
      args.push('--limit-rate', `${Math.round(settings.globalSpeedLimit / 1024)}K`)
    }
    if (opts.audioOnly && ffmpeg) {
      args.push('--extract-audio', '--audio-format', opts.extractAudio ? 'mp3' : 'm4a')
      if (opts.extractAudio) args.push('--audio-quality', '0')
    }
    if (opts.subtitles && ffmpeg) {
      args.push('--write-subs', '--embed-subs', '--sub-langs', 'en.*,fa.*,fa')
    }
    if (opts.thumbnail && ffmpeg) {
      args.push('--write-thumbnail', '--convert-thumbnails', 'jpg', '--embed-thumbnail')
    }
    args.push('--', httpUrl.parse(task.url))
    if (handle.signal.aborted) return

    const meta: YoutubeMeta = { ...(task.youtube || { title: task.name }), title: task.name }
    handle.patch({ status: 'downloading', error: undefined, connections: 1, youtube: meta })

    await new Promise<void>((resolve) => {
      const child = spawn(bin.cmd, args, {
        detached: true,
        env: toolEnvironment
      })
      this.childs.set(task.id, child)
      let stdout = ''
      let stderr = ''
      let lastEmit = 0
      let lastSize = 0
      let finalPath = ''
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => {
        killTree(child)
        killTimer ??= setTimeout(() => killTree(child, 'SIGKILL'), 2500)
      }
      handle.signal.addEventListener('abort', abort, { once: true })

      let finished = false
      const finish = (fn: () => void): void => {
        if (finished) return
        finished = true
        this.childs.delete(task.id)
        clearTimeout(killTimer)
        handle.signal.removeEventListener('abort', abort)
        fn()
        resolve()
      }

      const handleLine = (line: string): void => {
        if (line.startsWith('PULSE|')) {
          const parts = line.split('|')
          const num = (v?: string): number => {
            const n = Number(v)
            return Number.isFinite(n) && n > 0 ? n : 0
          }
          const total = num(parts[3]) || num(parts[4])
          const downloaded = num(parts[2])
          if (total) lastSize = total
          const now = Date.now()
          if (now - lastEmit > 150) {
            lastEmit = now
            handle.patch({
              downloaded,
              size: total || lastSize,
              ...(total ? {} : {})
            })
          }
          return
        }
        if (line.startsWith('PULSE_FILE|')) {
          try {
            const result: unknown = JSON.parse(line.slice(11))
            if (typeof result === 'string') finalPath = result
          } catch { /* the final file will be validated on exit */ }
        }
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        const lines = stdout.split(/\r?\n/)
        stdout = (lines.pop() || '').slice(-8192)
        for (const line of lines) handleLine(line.trim())
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > 200_000) stderr = stderr.slice(-60_000)
      })
      child.on('error', () => {
        finish(() => {
          handle.patch({
            status: 'error',
            error: 'Could not start yt-dlp.',
            speed: 0,
            eta: 0,
            connections: 0
          })
        })
      })
      child.on('close', async (code) => {
        if (handle.signal.aborted) {
          finish(() => {
            handle.patch({ status: 'paused', speed: 0, eta: 0, connections: 0 })
          })
          return
        }
        if (code === 0) {
          const file = finalPath && dirname(finalPath) === dir
            ? await fs.lstat(finalPath).catch(() => null)
            : null
          const valid = file && file.isFile() && file.size > 0
          finish(() => {
            if (handle.signal.aborted) {
              handle.patch({ status: 'paused', speed: 0, eta: 0, connections: 0 })
            } else if (valid && file) {
              handle.patch({
                status: 'completed', downloaded: file.size, size: file.size,
                completedAt: Date.now(), speed: 0, eta: 0, connections: 0,
                filePath: finalPath, fileName: basename(finalPath)
              })
            } else {
              handle.patch({ status: 'error', error: 'yt-dlp did not report a valid final file.', speed: 0, eta: 0, connections: 0 })
            }
          })
          return
        }
        const tail = stderr
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('WARNING'))
          .slice(-4)
          .join(' ')
        finish(() => {
          handle.patch({
            status: 'error',
            error: friendlyYoutubeError(tail) || `yt-dlp exited with code ${code}`,
            speed: 0,
            eta: 0,
            connections: 0
          })
        })
      })
    })
  }

  install(): Promise<{ ok: boolean; message: string }> {
    if (this.installation) return this.installation
    const task = this.installPinnedBinary().finally(() => { this.installation = undefined })
    this.installation = task
    return task
  }

  private async installPinnedBinary(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      return { ok: false, message: 'yt-dlp installation requires an Apple Silicon Mac.' }
    }
    try {
      await installMacYtDlp(join(app.getPath('userData'), 'bin'), shutdown.signal, async (path) => {
        const result = await runCapture(path, ['--version'])
        return result.code === 0 && result.stdout.trim() === macYtDlpRelease.version
      })
      this.binCache = null
      return { ok: true, message: `yt-dlp ${macYtDlpRelease.version} installed.` }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  async shutdown(): Promise<void> {
    shutdown.abort()
    await Promise.allSettled([...utilityRuns, this.installation])
  }

  sanitize(name: string): string {
    return sanitizeFileName(name)
  }
}
