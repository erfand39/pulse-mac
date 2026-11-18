import { promises as fs } from 'node:fs'
import { atomicWrite, readLocalFile } from './durable-file'

const MAX_STATE_BYTES = 64 * 1024 * 1024
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

export class StateFile<T> {
  private previous?: string
  private blocked = false
  private repair = false
  private writing: Promise<void> = Promise.resolve()

  constructor(private file: string, private decode: (raw: string) => T) {}

  async load(legacy?: string): Promise<{ data?: T; recovered?: boolean; migrated?: boolean }> {
    let damaged = false
    for (const [index, path] of [this.file, `${this.file}.bak`, legacy].entries()) {
      if (!path || (index === 2 && damaged)) continue
      try {
        const raw = (await readLocalFile(path, MAX_STATE_BYTES)).toString('utf8')
        const data = this.decode(raw)
        if (index < 2) this.previous = raw
        if (damaged) {
          // Hard-link any corrupt primary for recovery, then commit a valid snapshot.
          // Failure to preserve it blocks writes through this StateFile.
          const stamp = Date.now()
          await fs.link(this.file, `${this.file}.corrupt-${stamp}`).catch((error) => {
            if (!missing(error)) throw error
          })
        }
        this.repair = damaged || index === 1
        return { data, recovered: this.repair, migrated: index === 2 }
      } catch (error) {
        if (missing(error)) continue
        damaged = true
      }
    }
    if (damaged) {
      this.blocked = true
      throw new Error('The saved Pulse state and its backup could not be loaded.')
    }
    return {}
  }

  save(payload: string): Promise<void> {
    if (this.blocked) return Promise.reject(new Error('State is locked for recovery'))
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) return Promise.reject(new Error('State is too large'))
    const write = this.writing.then(async () => {
      if (!this.repair && this.previous === payload) return
      if (this.previous !== undefined) await atomicWrite(`${this.file}.bak`, this.previous)
      await atomicWrite(this.file, payload)
      this.previous = payload
      this.repair = false
    })
    this.writing = write.catch(() => undefined)
    return write
  }
}
