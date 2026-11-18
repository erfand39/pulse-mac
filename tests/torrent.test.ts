import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('locked WebTorrent transfers a generated file over localhost', { timeout: 15_000 }, async (t) => {
  const { default: WebTorrent } = await import('webtorrent')
  const dir = await fs.mkdtemp(join(tmpdir(), 'pulse-torrent-'))
  const options = { dht: false, tracker: false, lsd: false, utp: false, webSeeds: false, torrentPort: 0 }
  const seed = new WebTorrent(options)
  const receive = new WebTorrent(options)
  t.after(async () => {
    await Promise.all([seed, receive].map((client) => new Promise<void>((resolve) => client.destroy(resolve))))
    await fs.rm(dir, { recursive: true, force: true })
  })
  await Promise.all([once(seed, 'listening'), once(receive, 'listening')])
  const original = Buffer.from('Pulse Mac torrent integration fixture\n'.repeat(3500))
  const name = 'pulse-fixture.txt'
  const source = seed.seed(original, { name })
  await once(source, 'seed')
  const torrent = receive.add(source.torrentFile, { path: dir })
  const done = once(torrent, 'done')
  await once(torrent, 'infoHash')
  assert.equal(torrent.addPeer(`127.0.0.1:${seed.torrentPort}`), true)
  await done
  const data = await fs.readFile(join(dir, torrent.files[0].path))
  assert.equal(data.compare(original), 0)
})
