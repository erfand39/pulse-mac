import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import { realpath, statfs } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { AppSnapshot } from '@shared/types'
import { IP } from '@shared/ipc'
import type { DownloadManager } from './manager'
import { isAutoStartSupported } from './autostart'
import { getGithubRepo, searchGithubRepos } from './github'
import { settingsPatch, shapes } from './validate'

export function registerIpc(
  manager: DownloadManager,
  getWindow: () => BrowserWindow | null,
  rendererUrl: string
): void {
  const dirs = new Set<string>()
  const torrentFiles = new Set<string>()
  const cookieFiles = new Set<string>()
  const selectedTools = { ytDlpPath: new Set<string>(), ffmpegPath: new Set<string>() }
  const handle = <S extends z.ZodType>(
    channel: string,
    schema: S,
    fn: (args: z.output<S>, win: BrowserWindow) => unknown
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      const win = getWindow()
      const frame = event.senderFrame
      if (!win || win.webContents !== event.sender || !frame || frame.parent || frame.url !== rendererUrl) {
        throw new Error('Request rejected.')
      }
      const parsed = schema.safeParse(args.map((value) => value === null ? undefined : value))
      if (!parsed.success) throw new Error('Invalid request. Check the link, path or settings.')
      return fn(parsed.data, win)
    })
  }
  const none = z.tuple([])
  const id = z.tuple([shapes.id])
  const permittedDir = async (chosen?: string): Promise<string | undefined> => {
    if (!chosen || chosen === manager.settings().downloadDir) return undefined
    const target = await realpath(chosen)
    if (!dirs.has(target) || target !== chosen) throw new Error('Choose the destination in the folder picker.')
    return target
  }

  handle(IP.snapshot, none, async (_, win): Promise<AppSnapshot> => {
    const settings = manager.settings()
    const info = await statfs(settings.downloadDir).catch(() => null)
    return {
      tasks: manager.list().map(({ headers: _headers, ...task }) => task),
      settings, stats: manager.stats(),
      system: {
        platform: process.platform,
        arch: process.arch,
        version: process.getSystemVersion(),
        appVersion: app.getVersion(),
        freeDisk: info ? info.bavail * info.bsize : 0,
        downloadDir: settings.downloadDir,
        defaultDir: app.getPath('downloads'),
        runtime: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node
        },
        maximized: win.isMaximized(),
        autoStartSupported: isAutoStartSupported()
      }
    }
  })

  handle(IP.probe, z.tuple([shapes.httpUrl, shapes.headers]), ([url, headers]) => manager.probe(url, headers))
  handle(IP.probeYoutube, z.tuple([shapes.httpUrl]), ([url]) => manager.youtube.probe(url))
  handle(IP.addDownload, z.tuple([shapes.add]), async ([input]) =>
    manager.addDownload({ ...input, dir: await permittedDir(input.dir) }))
  handle(IP.addTorrent, z.tuple([shapes.torrent]), async ([input]) => {
    const dir = await permittedDir(input.dir)
    if (input.uri && isAbsolute(input.uri)) {
      if (!torrentFiles.has(input.uri)) throw new Error('Choose the file in the torrent picker.')
      return manager.addTorrentFile(input.uri, { ...input, dir })
    }
    return manager.addTorrent({ ...input, dir })
  })
  handle(IP.pause, id, ([value]) => manager.pause(value))
  handle(IP.resume, id, ([value]) => manager.resume(value))
  handle(IP.cancel, id, ([value]) => manager.cancel(value))
  handle(IP.retry, id, ([value]) => manager.retry(value))
  handle(IP.prioritize, id, ([value]) => manager.prioritize(value))
  handle(IP.selectTorrentFiles, z.tuple([shapes.id, z.array(z.number().int().min(0).max(10_000)).min(1).max(10_000)]),
    ([value, indices]) => manager.selectTorrentFiles(value, [...new Set(indices)]))
  handle(IP.networkChanged, z.tuple([z.boolean()]), ([online]) => manager.networkChanged(online))
  handle(IP.reveal, id, ([value]) => manager.reveal(value))
  handle(IP.open, id, ([value]) => manager.open(value))
  handle(IP.clearCompleted, none, () => manager.clearCompleted())
  handle(IP.resumeWithUrl, z.tuple([shapes.id, shapes.httpUrl]), ([value, url]) => manager.resumeWithUrl(value, url))

  handle(IP.remove, z.tuple([shapes.id, z.boolean()]), async ([value, deleteFile], win) => {
    if (deleteFile) {
      const task = manager.get(value)
      if (!task) return
      const persian = manager.settings().language === 'fa'
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: persian ? 'فایل‌های این دانلود حذف شوند؟' : 'Delete files owned by this download?',
        detail: task.name,
        buttons: persian ? ['لغو', 'حذف'] : ['Cancel', 'Delete'],
        defaultId: 0, cancelId: 0, noLink: true
      })
      if (response !== 1) return
    }
    await manager.remove(value, deleteFile)
  })

  handle(IP.updateSettings, z.tuple([settingsPatch]), async ([patch], win) => {
    if (patch.downloadDir) await permittedDir(patch.downloadDir)
    if (patch.cookiesFile && patch.cookiesFile !== manager.settings().cookiesFile && !cookieFiles.has(patch.cookiesFile)) {
      throw new Error('Choose the cookie file in the file picker.')
    }
    for (const tool of ['ytDlpPath', 'ffmpegPath'] as const) {
      if (patch[tool] && patch[tool] !== manager.settings()[tool] && !selectedTools[tool].has(patch[tool])) {
        throw new Error('Choose the executable in the file picker.')
      }
    }
    if (patch.cookiesBrowser && patch.cookiesBrowser !== manager.settings().cookiesBrowser) {
      const fa = manager.settings().language === 'fa'
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: fa ? `اجازهٔ خواندن کوکی‌های ${patch.cookiesBrowser}؟` : `Allow yt-dlp to read cookies from ${patch.cookiesBrowser}?`,
        buttons: fa ? ['لغو', 'اجازه'] : ['Cancel', 'Allow'],
        defaultId: 0, cancelId: 0, noLink: true
      })
      if (response !== 1) delete patch.cookiesBrowser
    }
    return manager.updateSettings(patch)
  })

  handle(IP.setGithubToken, z.tuple([shapes.credential]), async ([token]) => {
    await manager.store.credential.set(token)
    manager.updateSettings({ githubTokenConfigured: !!token })
  })
  handle(IP.setSpeedLimit, z.tuple([shapes.speed]), ([bytes]) => manager.setSpeedLimit(bytes))
  handle(IP.installYtDlp, none, () => manager.installYtdlp())
  handle(IP.rescanTools, none, () => manager.rescanTools())
  handle(IP.githubSearch, z.tuple([shapes.text(200), shapes.page]), async ([query, page]) =>
    searchGithubRepos(await manager.store.credential.get(), query, page))
  handle(IP.githubRepo, z.tuple([shapes.repo]), async ([name]) =>
    getGithubRepo(await manager.store.credential.get(), name))

  handle(IP.readClipboard, none, () => manager.readClipboardUrl())
  handle(IP.writeClipboard, z.tuple([z.string().max(8192)]), ([text]) => clipboard.writeText(text))
  handle(IP.chooseDir, z.tuple([shapes.dir, shapes.text(100).optional(), shapes.text(50).optional()]),
    async ([_current, title, buttonLabel], win) => {
      const result = await dialog.showOpenDialog(win, {
        title: title || 'Choose download folder', buttonLabel,
        defaultPath: manager.settings().downloadDir,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return null
      const path = await realpath(result.filePaths[0])
      dirs.add(path)
      return path
    })

  const chooseFile = async (win: BrowserWindow, options: Electron.OpenDialogOptions, allowed: Set<string>): Promise<string | null> => {
    const result = await dialog.showOpenDialog(win, { ...options, properties: ['openFile'] })
    if (result.canceled || !result.filePaths[0]) return null
    const path = await realpath(result.filePaths[0])
    allowed.add(path)
    return path
  }
  handle(IP.chooseTorrent, none, (_, win) => chooseFile(win, {
    title: 'Open torrent file', filters: [{ name: 'Torrent files', extensions: ['torrent'] }]
  }, torrentFiles))
  handle(IP.chooseCookies, none, (_, win) => chooseFile(win, {
    title: 'Select a cookies.txt file', filters: [{ name: 'Cookies file', extensions: ['txt'] }]
  }, cookieFiles))
  handle(IP.chooseTool, z.tuple([z.enum(['ytDlpPath', 'ffmpegPath'])]), ([tool], win) =>
    chooseFile(win, { title: tool === 'ffmpegPath' ? 'Choose FFmpeg' : 'Choose yt-dlp' }, selectedTools[tool]))
  handle(IP.revealDir, z.tuple([shapes.dir]), async ([dir]) => {
    await permittedDir(dir)
    if (dir) manager.revealDir(dir)
  })
  handle(IP.openExternal, z.tuple([shapes.external]), ([url]) => shell.openExternal(url))
}
