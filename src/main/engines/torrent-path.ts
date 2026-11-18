import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Validate file paths before WebTorrent's on-disk store opens any files. */
export function validateTorrentPaths(root: string, files: Array<{ path: string; length: number }>): void {
  if (realpathSync(root) !== root || files.length < 1 || files.length > 10_000) {
    throw new Error('Invalid torrent folder or file count.')
  }
  const paths = new Map<string, { key: string; directory: boolean }>()
  for (const file of files) {
    if (!Number.isSafeInteger(file.length) || file.length < 0) throw new Error('Invalid torrent file length.')
    const components = file.path.split('/')
    let actual = root
    for (const [i, component] of components.entries()) {
      if (!component || component === '.' || component === '..' ||
        /[<>:"\\|?*\x00-\x1f\x7f]/.test(component) || Buffer.byteLength(component) > 255) {
        throw new Error('Invalid torrent path.')
      }
      actual = join(actual, component)
      const key = actual.normalize('NFC').toLowerCase()
      const directory = i < components.length - 1
      const known = paths.get(key)
      if (known) {
        if (!known.directory || !directory || known.key !== actual) throw new Error('Conflicting torrent paths.')
      } else {
        paths.set(key, { key: actual, directory })
        const stat = lstatSync(actual, { throwIfNoEntry: false })
        if (stat && (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1))) {
          throw new Error('The torrent destination contains an unsupported file.')
        }
      }
    }
  }
}
