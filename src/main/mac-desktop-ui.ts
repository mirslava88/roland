import { app, type BrowserWindow } from 'electron'
import { join } from 'path'

let native: { restoreMacDockVisibility(): boolean } | undefined

// Electron's simple fullscreen hides Dock/menu application-wide, including
// when only the Program window needs to fill its display. Keep desktop chrome
// available to the operator; the elevated Program window covers it locally.
export function restoreMacDesktopUI(): void {
  if (process.platform !== 'darwin') return
  native ??= require(app.isPackaged
    ? join(process.resourcesPath, 'mac-office-accessibility.node')
    : join(__dirname, '../../build/mac-office-accessibility.node'))
  native!.restoreMacDockVisibility()
}

export function setMacSimpleFullscreen(win: BrowserWindow, fullscreen: boolean): void {
  win.setSimpleFullScreen(fullscreen)
  restoreMacDesktopUI()
}
