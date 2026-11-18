import { app } from 'electron'

export function isAutoStartSupported(): boolean {
  return process.platform === 'darwin' && app.isPackaged
}

export function loginItemEnabled(): boolean {
  return isAutoStartSupported() && app.getLoginItemSettings().openAtLogin
}

export function applyLaunchAtStartup(enabled: boolean): boolean {
  if (!isAutoStartSupported()) return false
  app.setLoginItemSettings({ openAtLogin: enabled })
  return loginItemEnabled()
}
