import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { DownloadTask, Settings } from '@shared/types'
import { GithubCredential } from './credentials'
import { StateFile } from './state-file'
import { loginItemEnabled } from './autostart'
import { settingsPatch } from './validate'

interface Persisted {
  tasks: DownloadTask[]
  settings: Settings
  legacyToken?: string
  protectedUrls?: Map<string, string>
}

const taskShape = z.object({
  id: z.uuid(),
  url: z.string(),
  protectedUrl: z.string().max(32_768).optional(),
  name: z.string(),
  fileName: z.string(),
  dir: z.string(),
  kind: z.enum(['http', 'youtube', 'torrent']),
  status: z.enum(['queued', 'connecting', 'downloading', 'paused', 'verifying', 'completed', 'error', 'canceled']),
  order: z.number(),
  downloaded: z.number().nonnegative(),
  size: z.number().nonnegative()
}).passthrough()

export function defaultSettings(): Settings {
  return {
    downloadDir: app.getPath('downloads'),
    maxConcurrent: 3,
    connections: 8,
    globalSpeedLimit: 0,
    language: 'fa',
    theme: 'system',
    clipboardWatch: false,
    keepRunningOnClose: true,
    notifyOnComplete: true,
    ytDlpPath: '',
    ffmpegPath: '',
    torrentPort: 0,
    seedAfterComplete: false,
    proxy: '',
    userAgent: 'PulseMac/1.0',
    autoResume: true,
    launchAtStartup: false,
    cookiesBrowser: '',
    cookiesFile: '',
    githubTokenConfigured: false
  }
}

function decode(raw: string): Persisted {
  const parsed = z.object({
    version: z.union([z.literal(1), z.literal(2)]),
    tasks: z.array(taskShape),
    settings: z.record(z.string(), z.unknown())
  }).parse(JSON.parse(raw))
  const { githubToken, proxy, ...remaining } = parsed.settings
  const checked: Partial<Settings> = {}
  for (const [key, value] of Object.entries(remaining)) {
    if (!Object.hasOwn(settingsPatch.shape, key)) continue
    const field = key as keyof typeof settingsPatch.shape
    const legacy = parsed.version === 1 && field === 'connections' && typeof value === 'number'
      ? Math.min(value, 16)
      : value
    const checkedField = settingsPatch.shape[field].safeParse(legacy)
    if (checkedField.success && checkedField.data !== undefined) Object.assign(checked, { [field]: checkedField.data })
  }
  const safeProxy = settingsPatch.shape.proxy.safeParse(proxy)
  const protectedUrls = new Map<string, string>()
  return {
    tasks: [...new Map(parsed.tasks.map((task) => {
      const { headers: _headers, error: _error, protectedUrl, ...rest } = task
      if (protectedUrl) protectedUrls.set(task.id, protectedUrl)
      return [task.id, rest as unknown as DownloadTask]
    })).values()],
    protectedUrls,
    settings: {
      ...defaultSettings(),
      ...checked,
      ...(safeProxy.success && safeProxy.data ? { proxy: safeProxy.data } : {})
    },
    legacyToken: parsed.version === 1 && typeof githubToken === 'string' ? githubToken : undefined
  }
}

export class Store {
  private state = new StateFile(join(app.getPath('userData'), 'pulse-state-v2.json'), decode)
  readonly credential = new GithubCredential()
  private data: Persisted = { tasks: [], settings: defaultSettings() }
  private secrets = new Map<string, { ciphertext: string; plain?: string }>()
  private timer: NodeJS.Timeout | null = null
  warning = ''
  onSaveError?: () => void

  async load(): Promise<void> {
    await fs.mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 })
    const loaded = await this.state.load(join(app.getPath('appData'), 'pulse-download-manager', 'pulse-state.json'))
    if (loaded.data) this.data = loaded.data
    for (const task of this.data.tasks) {
      const ciphertext = this.data.protectedUrls?.get(task.id)
      if (!ciphertext) continue
      let plain: string | undefined
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain is locked')
        plain = safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
        task.url = plain
      } catch {
        if (task.status !== 'completed') task.status = 'paused'
        this.warning = 'Some download links are locked. Unlock the macOS Keychain and reopen Pulse Mac.'
      }
      this.secrets.set(task.id, { ciphertext, plain })
    }
    delete this.data.protectedUrls
    const legacyToken = this.data.legacyToken
    delete this.data.legacyToken
    if (legacyToken && !(await this.credential.configured())) {
      try {
        await this.credential.set(legacyToken)
      } catch {
        this.warning = 'The previous state was copied. Set the GitHub credential again after unlocking the macOS Keychain.'
      }
    }
    this.data.settings.githubTokenConfigured = await this.credential.configured()
    this.data.settings.launchAtStartup = loginItemEnabled()
    if (loaded.recovered) this.warning = 'Pulse Mac recovered its saved state from backup. The damaged state was preserved.'
    if (loaded.migrated) {
      this.data.settings.clipboardWatch = false
      this.data.settings.cookiesBrowser = ''
      this.data.settings.cookiesFile = ''
    }
    if (loaded.migrated || loaded.recovered) await this.flush()
  }

  get tasks(): DownloadTask[] { return this.data.tasks }
  set tasks(list: DownloadTask[]) {
    this.data.tasks = list
    this.scheduleSave()
  }
  get settings(): Settings { return this.data.settings }

  patchSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch }
    this.scheduleSave()
    return this.data.settings
  }

  private scheduleSave(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(() => this.onSaveError?.())
    }, 700)
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const nextSecrets = new Map<string, { ciphertext: string; plain?: string }>()
    const tasks = this.data.tasks.map(({ headers: _headers, error: _error, ...task }) => {
      const previous = this.secrets.get(task.id)
      if (previous && (!task.url || previous.plain === task.url)) {
        nextSecrets.set(task.id, previous)
        return { ...task, url: '', protectedUrl: previous.ciphertext }
      }
      // Queries, signed paths and magnet parameters may contain credentials.
      if (process.platform !== 'darwin' || !/^(https?:|magnet:)/i.test(task.url)) return task
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock the macOS Keychain to save download links.')
      const ciphertext = safeStorage.encryptString(task.url).toString('base64')
      nextSecrets.set(task.id, { ciphertext, plain: task.url })
      return { ...task, url: '', protectedUrl: ciphertext }
    })
    this.secrets = nextSecrets
    const { githubTokenConfigured: _configured, ...settings } = this.data.settings
    return this.state.save(JSON.stringify({ version: 2, tasks, settings }))
  }
}
