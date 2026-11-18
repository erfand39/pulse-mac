import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { StateFile } from '../src/main/state-file'
import { settingsPatch, shapes } from '../src/main/validate'
import { validateTorrentPaths } from '../src/main/engines/torrent-path'

async function setup(t: TestContext) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pulse-state-')))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'current.json')
  const state = () => new StateFile<{ revision: number }>(path, JSON.parse)
  return { dir, path, state }
}

test('simultaneous saves serialize and backup contains the previous committed state', async (t) => {
  const f = await setup(t)
  const state = f.state()
  await Promise.all([1, 2, 3].map((revision) => state.save(JSON.stringify({ revision }))))
  assert.deepEqual((await f.state().load()).data, { revision: 3 })
  assert.equal(await fs.readFile(f.path + '.bak', 'utf8'), '{"revision":2}')
})

test('legacy journal migration is repeatable and leaves the original untouched', async (t) => {
  const f = await setup(t)
  const legacy = join(f.dir, 'pulse-state.json')
  await fs.writeFile(legacy, '{"revision":1}')
  const current = f.state()
  assert.deepEqual(await current.load(legacy), { data: { revision: 1 }, migrated: true, recovered: false })
  await current.save('{"revision":2}')
  assert.deepEqual((await f.state().load(legacy)).data, { revision: 2 })
  assert.equal(await fs.readFile(legacy, 'utf8'), '{"revision":1}')
})

test('corrupt current state is preserved and replaced with a valid backup', async (t) => {
  const f = await setup(t)
  const current = f.state()
  await current.save('{"revision":1}')
  await current.save('{"revision":2}')
  await fs.writeFile(f.path, '{broken')
  const recovery = f.state()
  const loaded = await recovery.load()
  assert.equal(loaded.recovered, true)
  assert.deepEqual(loaded.data, { revision: 1 })
  await recovery.save(JSON.stringify(loaded.data))
  const filename = (await fs.readdir(f.dir)).find((name) => name.includes('.corrupt-'))
  assert.equal(await fs.readFile(join(f.dir, filename!), 'utf8'), '{broken')
  assert.equal(await fs.readFile(f.path, 'utf8'), '{"revision":1}')
  assert.equal((await f.state().load()).recovered, false)
})

test('unrecoverable state refuses to overwrite the damaged data', async (t) => {
  const f = await setup(t)
  const current = f.state()
  await fs.writeFile(f.path, '{bad')
  await assert.rejects(current.load())
  await assert.rejects(current.save('{"revision":1}'))
  assert.equal(await fs.readFile(f.path, 'utf8'), '{bad')
})

test('IPC accepts bounded preferences and rejects credentials, URLs and nonsensical options', () => {
  assert.equal(settingsPatch.safeParse({ theme: 'system', maxConcurrent: 3, proxy: 'socks5://127.0.0.1:5000' }).success, true)
  assert.equal(settingsPatch.safeParse({ githubToken: 'secret' }).success, false)
  assert.equal(settingsPatch.safeParse({ maxConcurrent: 0 }).success, false)
  assert.equal(settingsPatch.safeParse({ proxy: 'http://name:secret@example.com' }).success, false)
  assert.equal(shapes.add.safeParse({ url: 'https://example.org', headers: { Authorization: 'secret' } }).success, false)
  for (const url of ['ftp://example.org/a', 'file:///tmp/data', 'javascript:alert(1)', 'http://user:pass@example.org']) {
    assert.equal(shapes.add.safeParse({ url }).success, false)
  }
})

test('torrent store rejects conflicting and symlink paths inside a temporary fixture', async (t) => {
  const f = await setup(t)
  await fs.symlink(f.dir, join(f.dir, 'foreign'))
  assert.throws(() => validateTorrentPaths(f.dir, [{ path: 'foreign/file', length: 2 }]))
  assert.throws(() => validateTorrentPaths(f.dir, [{ path: '../outside', length: 2 }]))
  assert.throws(() => validateTorrentPaths(f.dir, [{ path: 'A.zip', length: 2 }, { path: 'a.zip', length: 2 }]))
  assert.doesNotThrow(() => validateTorrentPaths(f.dir, [{ path: 'پوشه/نمونه.zip', length: 900 }]))
})
