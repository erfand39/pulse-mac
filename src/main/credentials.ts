import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { atomicWrite, readLocalFile, syncDirectory } from './durable-file'

export class GithubCredential {
  private get path(): string { return join(app.getPath('userData'), 'github-token.encrypted') }

  async get(): Promise<string> {
    let encrypted: Buffer
    try {
      encrypted = await readLocalFile(this.path, 16_384)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw new Error('GitHub credential could not be read.')
    }
    this.requireKeychain()
    try {
      return safeStorage.decryptString(encrypted)
    } catch {
      throw new Error('Unlock the macOS Keychain to use your GitHub credential.')
    }
  }

  async set(token: string): Promise<void> {
    if (!token) {
      await fs.unlink(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      await syncDirectory(app.getPath('userData'))
      return
    }
    this.requireKeychain()
    await atomicWrite(this.path, safeStorage.encryptString(token))
  }

  async configured(): Promise<boolean> {
    return fs.access(this.path).then(() => true, () => false)
  }

  private requireKeychain(): void {
    if (process.platform !== 'darwin' || !safeStorage.isEncryptionAvailable()) {
      throw new Error('The macOS Keychain is unavailable. GitHub credential was not changed.')
    }
  }
}
