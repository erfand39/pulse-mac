import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { syncDirectory } from '../durable-file'

export const macYtDlpRelease = {
  version: '2026.10.26',
  size: 37_466_304,
  sha256: '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa'
}
const hosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

export async function installMacYtDlp(
  dir: string, signal: AbortSignal, check: (path: string) => Promise<boolean>
): Promise<void> {
  const release = macYtDlpRelease
  const temp = join(dir, `yt-dlp-${randomUUID()}.tmp`)
  const target = join(dir, 'yt-dlp')
  let url = new URL(`https://github.com/yt-dlp/yt-dlp/releases/download/${release.version}/yt-dlp_macos`)
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    for (let count = 0; count <= 4; count++) {
      if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || url.port) {
        throw new Error('Untrusted yt-dlp download host.')
      }
      const res = await fetch(url, { signal: timeout, redirect: 'manual' })
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel()
        const location = res.headers.get('location')
        if (!location) throw new Error('Invalid yt-dlp redirect.')
        url = new URL(location, url)
        continue
      }
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel()
        throw new Error(`Failed to get yt-dlp (HTTP ${res.status}).`)
      }
      const hash = createHash('sha256')
      let bytes = 0
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length
            if (bytes > release.size) return done(new Error('yt-dlp exceeds its published size.'))
            hash.update(chunk)
            done(null, chunk)
          }
        }),
        createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
        { signal: timeout }
      )
      if (bytes !== release.size || hash.digest('hex') !== release.sha256) {
        throw new Error('yt-dlp does not match its published SHA-256 checksum.')
      }
      await fs.chmod(temp, 0o700)
      if (!(await check(temp))) throw new Error('The verified yt-dlp binary could not run on this Mac.')
      const file = await fs.open(temp, 'r')
      try { await file.sync() } finally { await file.close() }
      timeout.throwIfAborted()
      await fs.rename(temp, target)
      await syncDirectory(dir)
      return
    }
    throw new Error('Too many yt-dlp redirects.')
  } finally {
    await fs.unlink(temp).catch(() => undefined)
  }
}
