import { isAbsolute } from 'node:path'
import { z } from 'zod'

const text = (length: number) => z.string().max(length).refine((v) => !/[\0\r\n]/.test(v))
const optionalPath = text(4096).refine((v) => v === '' || isAbsolute(v))
const integer = (min: number, max: number) => z.number().int().min(min).max(max)
const strict = z.strictObject

export const httpUrl = text(8192).refine((value) => {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !!url.hostname
  } catch { return false }
}, { message: 'Enter a valid HTTP or HTTPS link.' })

const magnet = text(8192).refine((value) => /^magnet:\?[^#]*\bxt=urn:btih:/i.test(value))
const dir = optionalPath.optional()
const speed = integer(0, 1_000_000_000)

export const settingsPatch = strict({
  downloadDir: optionalPath.refine(Boolean),
  maxConcurrent: integer(1, 12),
  connections: integer(1, 16),
  globalSpeedLimit: speed,
  language: z.enum(['fa', 'en', 'ja', 'ru']),
  theme: z.enum(['dark', 'light', 'system']),
  clipboardWatch: z.boolean(),
  keepRunningOnClose: z.boolean(),
  notifyOnComplete: z.boolean(),
  ytDlpPath: optionalPath,
  ffmpegPath: optionalPath,
  torrentPort: integer(0, 65535),
  seedAfterComplete: z.boolean(),
  proxy: z.union([z.literal(''), z.literal('direct'), z.literal('system'), httpUrl, text(8192).refine((value) => /^socks5:\/\/[a-z0-9.[\]:-]+\/?$/i.test(value))]).refine((value) => {
    if (!value.includes('://')) return true
    try {
      const url = new URL(value)
      return (!url.pathname || url.pathname === '/') && !url.search && !url.hash
    } catch { return false }
  }),
  userAgent: text(512),
  autoResume: z.boolean(),
  launchAtStartup: z.boolean(),
  cookiesBrowser: z.enum(['', 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium', 'safari']),
  cookiesFile: optionalPath
}).partial()

const headers = z.record(
  z.string().regex(/^(accept|accept-language|referer|user-agent)$/i),
  text(2048)
)
const youtube = strict({
  selector: text(256), quality: text(128), audioOnly: z.boolean(),
  audioFormat: z.enum(['m4a', 'mp3']), subtitles: z.boolean(), thumbnail: z.boolean(),
  videoId: text(256), duration: z.number().min(0), playlistIndex: integer(0, 10_000),
  playlistCount: integer(0, 10_000), uploader: text(512)
}).partial()

export const MAX_TORRENT_BYTES = 1024 * 1024
export const shapes = {
  id: z.uuid(),
  text,
  dir,
  httpUrl,
  headers: headers.optional(),
  speed,
  add: strict({
    url: z.union([httpUrl, magnet]),
    kind: z.enum(['auto', 'http', 'youtube']).optional(),
    fileName: text(1024).optional(),
    dir,
    connections: integer(1, 16).optional(),
    headers: headers.optional(),
    title: text(512).optional(),
    thumbnail: httpUrl.optional(),
    youtube: youtube.optional(),
    checksum: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
  }),
  torrent: strict({
    uri: z.union([httpUrl, magnet, optionalPath.refine((value) => /\.torrent$/i.test(value))]).optional(),
    data: z.base64().max(4 * Math.ceil(MAX_TORRENT_BYTES / 3)).optional(),
    name: text(512).optional(), dir,
    sequential: z.boolean().optional(),
    fileIndices: z.array(integer(0, 10_000)).max(10_001).optional()
  }).refine((input) => !!input.uri !== !!input.data),
  repo: z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/),
  page: integer(1, 100).optional(),
  external: text(8192).refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['github.com', 'www.github.com', 'githubusercontent.com', 'www.youtube.com'].includes(url.hostname)
    } catch { return false }
  }),
  credential: z.string().max(512).regex(/^[\w-]*$/)
}
