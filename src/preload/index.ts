import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AddDownloadInput,
  AddTorrentInput,
  AppSnapshot,
  GithubRepoDetails,
  GithubSearchResult,
  MainEvent,
  ProbeResult,
  PulseAPI,
  ResumeWithUrlResult,
  Settings,
  YoutubeProbe
} from '../shared/types'
import { IP } from '../shared/ipc'

const api: PulseAPI = {
  snapshot: () => ipcRenderer.invoke(IP.snapshot) as Promise<AppSnapshot>,
  probe: (url: string, headers?: Record<string, string>) =>
    ipcRenderer.invoke(IP.probe, url, headers) as Promise<ProbeResult>,
  probeYoutube: (url: string) => ipcRenderer.invoke(IP.probeYoutube, url) as Promise<YoutubeProbe>,
  addDownload: (input: AddDownloadInput) => ipcRenderer.invoke(IP.addDownload, input),
  addTorrent: (input: AddTorrentInput) => ipcRenderer.invoke(IP.addTorrent, input),
  pauseTask: (id: string) => ipcRenderer.invoke(IP.pause, id) as Promise<void>,
  resumeTask: (id: string) => ipcRenderer.invoke(IP.resume, id) as Promise<void>,
  cancelTask: (id: string) => ipcRenderer.invoke(IP.cancel, id) as Promise<void>,
  removeTask: (id: string, deleteFile: boolean) =>
    ipcRenderer.invoke(IP.remove, id, deleteFile) as Promise<void>,
  prioritizeTask: (id: string) => ipcRenderer.invoke(IP.prioritize, id),
  selectTorrentFiles: (id: string, indices: number[]) => ipcRenderer.invoke(IP.selectTorrentFiles, id, indices),
  retryTask: (id: string) => ipcRenderer.invoke(IP.retry, id) as Promise<void>,
  revealTask: (id: string) => ipcRenderer.invoke(IP.reveal, id) as Promise<void>,
  openTask: (id: string) => ipcRenderer.invoke(IP.open, id) as Promise<void>,
  clearCompleted: () => ipcRenderer.invoke(IP.clearCompleted) as Promise<void>,
  updateSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke(IP.updateSettings, patch) as Promise<Settings>,
  setGithubToken: (token: string) => ipcRenderer.invoke(IP.setGithubToken, token),
  chooseTool: (tool: 'ytDlpPath' | 'ffmpegPath') => ipcRenderer.invoke(IP.chooseTool, tool),
  chooseDir: (current?: string, title?: string, buttonLabel?: string) =>
    ipcRenderer.invoke(IP.chooseDir, current, title, buttonLabel) as Promise<string | null>,
  chooseTorrentFile: () => ipcRenderer.invoke(IP.chooseTorrent) as Promise<string | null>,
  chooseCookiesFile: () => ipcRenderer.invoke(IP.chooseCookies) as Promise<string | null>,
  setSpeedLimit: (bytes: number) => ipcRenderer.invoke(IP.setSpeedLimit, bytes) as Promise<void>,
  installYtDlp: () => ipcRenderer.invoke(IP.installYtDlp) as Promise<{ ok: boolean; message: string }>,
  rescanTools: () => ipcRenderer.invoke(IP.rescanTools) as Promise<void>,
  githubSearch: (query: string, page?: number) =>
    ipcRenderer.invoke(IP.githubSearch, query, page) as Promise<GithubSearchResult>,
  githubRepo: (fullName: string) =>
    ipcRenderer.invoke(IP.githubRepo, fullName) as Promise<GithubRepoDetails>,
  openExternal: (url: string) => ipcRenderer.invoke(IP.openExternal, url) as Promise<void>,
  revealDir: (dir: string) => ipcRenderer.invoke(IP.revealDir, dir) as Promise<void>,
  readClipboard: () => ipcRenderer.invoke(IP.readClipboard) as Promise<string>,
  writeClipboard: (text: string) => ipcRenderer.invoke(IP.writeClipboard, text) as Promise<void>,
  resumeWithUrl: (id: string, url: string) =>
    ipcRenderer.invoke(IP.resumeWithUrl, id, url) as Promise<ResumeWithUrlResult>,
  subscribe: (cb: (event: MainEvent) => void) => {
    const listener = (_event: unknown, payload: MainEvent): void => cb(payload)
    ipcRenderer.on(IP.event, listener)
    return () => ipcRenderer.removeListener(IP.event, listener)
  }
}

// Exposed for drag & drop of local .torrent files. Electron resolves the real
// path from a File object inside the isolated world.
const pathForFile = (file: File): string => {
  try {
    return webUtils.getPathForFile(file)
  } catch {
    return ''
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const report = (): void => { void ipcRenderer.invoke(IP.networkChanged, navigator.onLine).catch(() => undefined) }
  window.addEventListener('online', report)
  window.addEventListener('offline', report)
  report()
})

contextBridge.exposeInMainWorld('pulse', api)
contextBridge.exposeInMainWorld('pulsePath', { pathForFile })
