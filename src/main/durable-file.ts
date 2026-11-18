import { randomUUID } from 'node:crypto'
import { constants, promises as fs, type Stats } from 'node:fs'
import { dirname } from 'node:path'

export async function syncDirectory(path: string): Promise<void> {
  const dir = await fs.open(path, 'r')
  try {
    await dir.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally {
    await dir.close()
  }
}

export async function atomicWrite(path: string, payload: string | Buffer): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const file = await fs.open(temp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(payload)
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.rename(temp, path)
    await syncDirectory(dirname(path))
  } finally {
    await fs.unlink(temp).catch(() => undefined)
  }
}

export async function readLocalFile(path: string, limit: number): Promise<Buffer> {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) throw new Error('File is not a supported regular file')
    const data = Buffer.alloc(stat.size + 1)
    let bytesRead = 0
    while (bytesRead < data.length) {
      const result = await file.read(data, bytesRead, data.length - bytesRead, bytesRead)
      if (!result.bytesRead) break
      bytesRead += result.bytesRead
    }
    if (bytesRead !== stat.size || (await file.stat()).size !== stat.size) {
      throw new Error('File changed while being read')
    }
    return data.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

export function sameFile(a: Stats, b: Stats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
}
