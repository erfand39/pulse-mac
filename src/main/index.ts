import {
  app, BrowserWindow, Menu, clipboard, dialog, nativeTheme, Tray, nativeImage,
  powerMonitor, session
} from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Store } from './store'
import { DownloadManager } from './manager'
import { registerIpc } from './ipc'
import { IP } from '@shared/ipc'
import type { MainEvent } from '@shared/types'
import { isLocalUrl, scanClipboardUrls } from '@shared/urls'
import { formatBytes } from './util'

let mainWindow: BrowserWindow | null = null
let manager: DownloadManager
let store: Store
let clipboardTimer: NodeJS.Timeout | null = null
let lastClipboard = ''
let tray: Tray | null = null
let quitting = false
let quitReady = false
let trayLabel = ''
let initialized = false
const pendingTorrents: string[] = []

app.setName('Pulse Mac')
const smoke = app.isPackaged && process.env.PULSE_PACKAGE_SMOKE === '1'
const profileDir = join(app.getPath('appData'), smoke ? 'pulse-mac-smoke' : 'pulse-mac')
mkdirSync(profileDir, { recursive: true, mode: 0o700 })
app.setPath('userData', profileDir)
const gotLock = app.requestSingleInstanceLock()

const rendererPath = join(__dirname, '../renderer/index.html')
const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
const rendererUrl = devUrl ? new URL(devUrl).href : pathToFileURL(rendererPath).href

function send(event: MainEvent): void {
  if (event.type === 'settings') configureClipboard()
  if (event.type === 'stats' && tray) {
    const { activeCount, downSpeed } = event.stats
    const label = activeCount ? `${activeCount} · ${formatBytes(downSpeed)}/s` : ''
    if (label !== trayLabel) {
      trayLabel = label
      tray.setTitle(label)
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (event.type === 'task:add' || event.type === 'task:update') {
      const { headers: _headers, ...task } = event.task
      mainWindow.webContents.send(IP.event, { ...event, task })
    } else mainWindow.webContents.send(IP.event, event)
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Pulse Mac',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101216' : '#f4f6fb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })
  mainWindow = win
  win.once('ready-to-show', () => {
    if (process.platform !== 'darwin' || !app.getLoginItemSettings().wasOpenedAtLogin) win.show()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-redirect', (event) => event.preventDefault())
  win.on('close', (event) => {
    if (!quitting && store.settings.keepRunningOnClose) {
      event.preventDefault()
      win.hide()
    } else if (!quitting) {
      event.preventDefault()
      app.quit()
    }
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  if (devUrl) void win.loadURL(rendererUrl)
  else void win.loadFile(rendererPath)
  return win
}

function showWindow(event?: MainEvent): void {
  if (quitting) return
  const win = mainWindow ?? createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (event) {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => send(event))
    } else send(event)
  }
}

function configureClipboard(): void {
  if (clipboardTimer) clearInterval(clipboardTimer)
  clipboardTimer = null
  if (!store.settings.clipboardWatch) {
    lastClipboard = ''
    return
  }
  clipboardTimer = setInterval(async () => {
    if (!mainWindow?.isFocused()) return
    const text = (await clipboard.readText()).trim()
    if (!text || text === lastClipboard) return
    lastClipboard = text
    const scan = scanClipboardUrls(text)
    if (scan.direct.length >= 2) send({ type: 'clipboard:batch', urls: scan.urls })
    else if (scan.urls.length === 1 && !isLocalUrl(scan.urls[0])) {
      send({ type: 'clipboard:url', url: scan.urls[0] })
    }
  }, 1800)
}

function setupMenus(): void {
  const fa = store.settings.language === 'fa'
  const label = (en: string, persian: string): string => fa ? persian : en
  const controls: Electron.MenuItemConstructorOptions[] = [
    { label: label('Pause All', 'توقف همه'), click: () => void manager.pauseAll() },
    { label: label('Resume All', 'ادامهٔ همه'), click: () => void manager.resumeAll() }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: label('Settings…', 'تنظیمات…'), accelerator: 'Cmd+,',
          click: () => showWindow({ type: 'navigate', view: 'settings' }) },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { label: label('Downloads', 'دانلودها'), submenu: controls },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: label('Pulse Mac Information', 'دربارهٔ Pulse Mac'),
        click: () => showWindow({ type: 'navigate', view: 'about' }) }
    ] }
  ]))
  const dir = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  const image = nativeImage.createFromPath(join(dir, 'menubarTemplate.png'))
  image.setTemplateImage(true)
  tray ??= new Tray(image)
  tray.setToolTip('Pulse Mac')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: label('Show Pulse Mac', 'نمایش Pulse Mac'), click: () => showWindow() },
    ...controls,
    { type: 'separator' },
    { role: 'quit' }
  ]))
}

async function openTorrent(path: string): Promise<void> {
  showWindow()
  try {
    await manager.addTorrentFile(path)
  } catch {
    await dialog.showMessageBox({ type: 'error', message: 'Could not open this torrent file.' })
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  app.setAboutPanelOptions({
    applicationName: 'Pulse Mac',
    applicationVersion: app.getVersion(),
    version: `macOS ${process.getSystemVersion()} · ${process.arch}`,
    credits: 'Pulse Download Manager by TheGreatAzizi · GPL-3.0-or-later'
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  store = new Store()
  await store.load(!smoke)
  nativeTheme.themeSource = store.settings.theme
  manager = new DownloadManager({
    store,
    emit: (event) => {
      send(event)
      if (event.type === 'settings' && !smoke && process.platform === 'darwin') setupMenus()
    },
    openTaskView: (id) => showWindow({ type: 'select-task', id })
  })
  if (smoke) {
    const win = createWindow()
    registerIpc(manager, () => mainWindow, rendererUrl)
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', () => reject(new Error('App did not load')))
    })
    await Promise.race([
      Promise.all([
        manager.torrent.init(),
        win.webContents.executeJavaScript("new Promise((resolve, reject) => { const start = Date.now(); const check = () => window.pulse && document.querySelector('main') ? resolve(true) : Date.now() - start > 15000 ? reject(new Error('Renderer did not initialize')) : setTimeout(check, 50); check(); })")
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Package smoke test timed out')), 20_000))
    ])
    await manager.shutdown()
    app.exit(0)
    return
  }
  await manager.init()
  registerIpc(manager, () => mainWindow, rendererUrl)
  createWindow()
  if (process.platform === 'darwin') setupMenus()
  configureClipboard()

  powerMonitor.on('suspend', () => void manager.suspend())
  powerMonitor.on('resume', () => void manager.wake())
  app.on('activate', () => showWindow())
  app.on('second-instance', () => showWindow())
  initialized = true
  for (const path of pendingTorrents.splice(0)) void openTorrent(path)
  if (store.warning) {
    await dialog.showMessageBox({ type: 'warning', message: store.warning })
  }
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (initialized) void openTorrent(path)
  else if (pendingTorrents.length < 20) pendingTorrents.push(path)
})

app.on('window-all-closed', () => undefined)
app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  if (clipboardTimer) clearInterval(clipboardTimer)
  void (async () => {
    try {
      await manager?.shutdown()
      quitReady = true
      app.quit()
    } catch {
      await dialog.showMessageBox({ type: 'error', message: 'Pulse Mac could not save its state. Check the disk and quit again.' })
      quitting = false
    }
  })()
})

if (!gotLock) app.exit(0)
else void bootstrap().catch(async () => {
  if (!smoke) await dialog.showMessageBox({ type: 'error', message: 'Pulse Mac could not start. Your previous state was preserved.' })
  app.exit(1)
})
