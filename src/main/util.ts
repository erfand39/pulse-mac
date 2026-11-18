import { promises as fs } from 'node:fs'
import { dirname, basename, extname, join } from 'node:path'
import { isVideoPlatformUrl } from '@shared/urls'

/** Cross-platform filename sanitizer that also copes with reserved Windows names. */
export function sanitizeFileName(input: string, fallback = 'download'): string {
  let name = (input || '').normalize('NFC')
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim()
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!name) name = fallback
  if (process.platform === 'win32') {
    const base = name.split('.')[0]?.toUpperCase()
    if (
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base) ||
      ['CON', 'PRN', 'AUX', 'NUL'].includes(base)
    ) {
      name = `_${name}`
    }
  }
  if (Buffer.byteLength(name) > 220) {
    const ext = extname(name).slice(0, 12)
    const stem = name.slice(0, name.length - extname(name).length)
    let truncated = ''
    for (const char of stem) {
      if (Buffer.byteLength(truncated + char + ext) > 220) break
      truncated += char
    }
    name = (truncated || fallback) + ext
  }
  return name
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function parseContentDisposition(value?: string | null): string | undefined {
  if (!value) return undefined
  const star = /filename\*\s*=\s*([^;]+)/i.exec(value)?.[1]
  if (star) {
    // RFC 5987: UTF-8''encoded-name
    const match = /^([\w-]+)'([^']*)'(.+)$/.exec(star.trim().replace(/^"|"$/g, ''))
    if (match) {
      try {
        return decodeURIComponent(match[3])
      } catch {
        return match[3]
      }
    }
  }
  const plain = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(value)
  const raw = plain?.[2] ?? plain?.[3]
  if (!raw) return undefined
  let name = raw.trim()
  try {
    name = decodeURIComponent(name)
  } catch {
    /* keep raw */
  }
  // Some servers send latin1-encoded utf8 bytes
  if (/[ÃÂ][\x80-\xbf]/.test(name)) {
    try {
      const decoded = Buffer.from(name, 'latin1').toString('utf8')
      if (!decoded.includes('\uFFFD')) name = decoded
    } catch {
      /* ignore */
    }
  }
  return name
}

export function guessNameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    if (last && last.includes('.')) return last
    return last || `download-${Date.now()}`
  } catch {
    return `download-${Date.now()}`
  }
}

export function extFromMime(mime?: string): string | undefined {
  if (!mime) return undefined
  const map: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/x-matroska': '.mkv',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/x-7z-compressed': '.7z',
    'application/x-rar-compressed': '.rar',
    'application/x-msdownload': '.exe',
    'application/vnd.android.package-archive': '.apk',
    'application/octet-stream': ''
  }
  return map[mime.split(';')[0].trim().toLowerCase()]
}

export const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.m4v', '.ts', '.wmv', '.mpg', '.mpeg'
])
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav', '.wma'])
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif'])
export const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.xz', '.bz2', '.iso'])
export const DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.epub'])
export const APP_EXT = new Set(['.exe', '.msi', '.apk', '.dmg', '.deb', '.rpm', '.appimage'])

export function categoryFor(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (DOC_EXT.has(ext)) return 'document'
  if (APP_EXT.has(ext)) return 'app'
  return 'other'
}

export function isYoutubeUrl(raw: string): boolean {
  return isVideoPlatformUrl(raw)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class GlobalThrottle {
  private limit = 0
  private chain: Promise<void> = Promise.resolve()
  private changed = new AbortController()

  setLimit(bytesPerSecond: number): void {
    const limit = Math.max(0, bytesPerSecond)
    if (limit === this.limit) return
    this.limit = limit
    this.changed.abort()
    this.changed = new AbortController()
  }

  getLimit(): number { return this.limit }

  consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (!this.limit) return Promise.resolve()
    const run = this.chain.then(async () => {
      let remaining = bytes
      while (this.limit && remaining > 0) {
        signal?.throwIfAborted()
        const rate = this.limit
        const changed = this.changed.signal
        const active = signal ? AbortSignal.any([changed, signal]) : changed
        const start = performance.now()
        try {
          await sleep(Math.ceil(remaining * 1000 / rate), active)
          return
        } catch (error) {
          signal?.throwIfAborted()
          if (!changed.aborted) throw error
          remaining -= rate * (performance.now() - start) / 1000
        }
      }
    })
    this.chain = run.catch(() => undefined)
    if (!signal) return run
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      void run.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function fileSize(path: string): Promise<number> {
  try {
    const stat = await fs.stat(path)
    return stat.size
  } catch {
    return 0
  }
}

export function shortPath(p: string, max = 46): string {
  if (p.length <= max) return p
  return `${p.slice(0, 8)}…${p.slice(-(max - 9))}`
}

export function dirOf(p: string): string {
  return dirname(p) || p
}

export function baseName(p: string): string {
  return basename(p)
}
