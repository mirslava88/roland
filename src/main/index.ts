import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut } from 'electron'
import { createControlWindow, createPresentationWindow, createOverlayWindow, createMusicPlayerWindow } from './windows'
import { ChildProcess, spawn } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { registerIpcHandlers, closeAllExternalFiles } from './ipc-handlers'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'

const execFileAsync = promisify(execFile)

let controlWindow: BrowserWindow | null = null
let presentationWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let wpfTimerProcess: ChildProcess | null = null // WPF timer overlay for PPTX
const wpfTimerDataFile = join(tmpdir(), 'roland-timer-data.json')
let musicPlayerWindow: BrowserWindow | null = null
let activeContentType: string | null = null // tracks what's on the external display
let timerActive = false // whether timer overlay is currently shown

function showWpfTimer(displayBounds: { x: number; y: number; width: number; height: number }): void {
  if (wpfTimerProcess && !wpfTimerProcess.killed) return
  // Create the data file before spawning so the script can find it
  try { writeFileSync(wpfTimerDataFile, '{}') } catch {}
  const scriptPath = join(__dirname, '../../scripts/timer-overlay.ps1')
  const posX = displayBounds.x + displayBounds.width - 320
  const posY = displayBounds.y + displayBounds.height - 120
  wpfTimerProcess = spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-STA',
    '-File', scriptPath,
    '-X', String(posX),
    '-Y', String(posY),
    '-DataFile', wpfTimerDataFile
  ], { stdio: 'ignore' })
  wpfTimerProcess.on('exit', () => { wpfTimerProcess = null })
}

function hideWpfTimer(): void {
  try { writeFileSync(wpfTimerDataFile, JSON.stringify({ cmd: 'exit' })) } catch {}
  setTimeout(() => {
    if (wpfTimerProcess && !wpfTimerProcess.killed) {
      wpfTimerProcess.kill()
      wpfTimerProcess = null
    }
    try { unlinkSync(wpfTimerDataFile) } catch {}
  }, 500)
}

function sendToWpfTimer(data: unknown): void {
  try { writeFileSync(wpfTimerDataFile, JSON.stringify(data)) } catch {}
}

async function autoSwitchAudioToExternal(): Promise<void> {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const hasExternal = displays.some((d) => d.id !== primary.id)
  if (hasExternal) {
    try {
      const scriptPath = join(__dirname, '../../scripts/audio-control.ps1')
      const { stdout: listOut } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Action', 'list'
      ])
      const devices = JSON.parse(listOut.trim())
      const external = devices.find((d: { isDefault: boolean }) => !d.isDefault)
      if (external) {
        await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-Action', 'set',
          '-DeviceId', external.id
        ])
      }
    } catch { /* ignore */ }
  }
}

function createWindows(): void {
  controlWindow = createControlWindow()
  registerIpcHandlers(controlWindow, () => presentationWindow)

  controlWindow.on('closed', () => {
    controlWindow = null
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
    }
    presentationWindow = null
    hideWpfTimer()
    closeAllExternalFiles()
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      musicPlayerWindow.close()
    }
    musicPlayerWindow = null
    globalShortcut.unregisterAll()
    app.quit()
  })

  ipcMain.handle('open-presentation-window', async (_event, displayId?: number) => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.focus()
      return
    }

    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay

    presentationWindow = createPresentationWindow(targetDisplay!)

    // Wait for the renderer to fully load and React to mount
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000) // fallback timeout
      ipcMain.once('presentation-ready', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    presentationWindow.on('closed', () => {
      presentationWindow = null
      controlWindow?.webContents.send('presentation-window-closed')
    })
  })

  ipcMain.handle('close-presentation-window', () => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
      presentationWindow = null
    }
  })

  ipcMain.handle('show-overlay', async (_event, displayId?: number) => {
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay

    if (!overlayWindow || overlayWindow.isDestroyed()) {
      overlayWindow = createOverlayWindow(targetDisplay!)
    }
    overlayWindow.setBounds(targetDisplay!.bounds)
    overlayWindow.show()
    overlayWindow.webContents.executeJavaScript(
      "document.getElementById('o').classList.remove('hide');document.getElementById('o').classList.add('show');"
    )
    // Wait for fade-in to complete
    await new Promise((r) => setTimeout(r, 250))
  })

  ipcMain.handle('hide-overlay', async () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.executeJavaScript(
        "document.getElementById('o').classList.remove('show');document.getElementById('o').classList.add('hide');"
      )
      // Wait for fade-out, then hide window
      await new Promise((r) => setTimeout(r, 250))
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide()
      }
    }
  })

  ipcMain.on('timer-overlay-update', (_event, data: {
    remaining: number
    running: boolean
    duration: number
    posX: number
    posY: number
    scale: number
  }) => {
    sendToWpfTimer(data)
  })

  ipcMain.handle('show-timer-overlay', async (_event, displayId?: number) => {
    timerActive = true
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay
    if (targetDisplay) {
      showWpfTimer(targetDisplay.bounds)
    }
  })

  ipcMain.handle('hide-timer-overlay', () => {
    timerActive = false
    hideWpfTimer()
  })

  ipcMain.on('timer-play-sound', (_event, _type: string, filePath: string) => {
    const url = 'file:///' + filePath.replace(/\\/g, '/')
    const js = `(() => { const a = new Audio(${JSON.stringify(url)}); a.play().catch(() => {}); })()`
    // Play on control window (always exists) — presentation window may be closed for PPTX
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.executeJavaScript(js).catch(() => {})
    }
  })

  // --- Music Player ---
  function ensureMusicWindow(): BrowserWindow {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) return musicPlayerWindow
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    musicPlayerWindow = createMusicPlayerWindow(externalDisplay || primaryDisplay)
    return musicPlayerWindow
  }

  ipcMain.handle('select-music-files', async () => {
    const result = await dialog.showOpenDialog(controlWindow!, {
      properties: ['openFile', 'multiSelections'],
      title: 'Выберите музыкальные файлы',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac', 'wma'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle('select-music-folder', async () => {
    const result = await dialog.showOpenDialog(controlWindow!, {
      properties: ['openDirectory'],
      title: 'Выберите папку с музыкой'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folderPath = result.filePaths[0]
    // Scan folder for audio files
    const { readdir } = require('fs/promises')
    const { join, extname } = require('path')
    const entries = await readdir(folderPath)
    const audioExts = ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma']
    const files: string[] = []
    for (const entry of entries) {
      if (audioExts.includes(extname(entry).toLowerCase())) {
        files.push(join(folderPath, entry))
      }
    }
    return files.length > 0 ? files : null
  })

  ipcMain.handle('music-set-playlist', async (_event, files: string[], startIndex?: number) => {
    const win = ensureMusicWindow()
    await win.webContents.executeJavaScript(
      `window._setPlaylist(${JSON.stringify(files)}, ${startIndex || 0})`
    )
  })

  ipcMain.handle('music-play', async () => {
    const win = ensureMusicWindow()
    await win.webContents.executeJavaScript('window._play()')
  })

  ipcMain.handle('music-pause', async () => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript('window._pause()')
    }
  })

  ipcMain.handle('music-stop', async () => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript('window._stop()')
    }
  })

  ipcMain.handle('music-next', async () => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript('window._next()')
    }
  })

  ipcMain.handle('music-prev', async () => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript('window._prev()')
    }
  })

  ipcMain.handle('music-set-loop-track', async (_event, value: boolean) => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript(`window._setLoopTrack(${value})`)
    }
  })

  ipcMain.handle('music-set-loop-playlist', async (_event, value: boolean) => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript(`window._setLoopPlaylist(${value})`)
    }
  })

  ipcMain.handle('music-set-volume', async (_event, value: number) => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript(`window._setVolume(${value})`)
    }
  })

  ipcMain.handle('music-seek', async (_event, time: number) => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript(`window._seek(${time})`)
    }
  })

  ipcMain.handle('music-get-state', async () => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      return await musicPlayerWindow.webContents.executeJavaScript('window._getState()')
    }
    return null
  })

  ipcMain.handle('get-displays', () => {
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    return displays.map((d) => ({
      id: d.id,
      label: `${d.size.width}x${d.size.height}`,
      isPrimary: d.id === primary.id,
      bounds: d.bounds
    }))
  })

  const sendDisplays = (): void => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      const displays = screen.getAllDisplays()
      const primary = screen.getPrimaryDisplay()
      controlWindow.webContents.send('displays-changed', displays.map((d) => ({
        id: d.id,
        label: `${d.size.width}x${d.size.height}`,
        isPrimary: d.id === primary.id,
        bounds: d.bounds
      })))
    }
  }

  screen.on('display-added', () => {
    sendDisplays()
    autoSwitchAudioToExternal()
  })
  screen.on('display-removed', sendDisplays)

  ipcMain.on('set-active-content-type', (_event, type: string) => {
    activeContentType = type
  })

  ipcMain.on('send-to-presentation', (_event, channel: string, ...args: unknown[]) => {
    if (channel === 'load-content' && args[0]) {
      activeContentType = (args[0] as { type: string }).type
    }
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.webContents.send(channel, ...args)
    }
  })

  ipcMain.on('send-to-control', (_event, channel: string, ...args: unknown[]) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send(channel, ...args)
    }
  })

  let globalHookEnabled = true

  // Register global shortcuts by default
  globalShortcut.register('PageDown', () => {
    controlWindow?.webContents.send('global-key', 'next')
  })
  globalShortcut.register('PageUp', () => {
    controlWindow?.webContents.send('global-key', 'prev')
  })
  globalShortcut.register('Right', () => {
    controlWindow?.webContents.send('global-key', 'next')
  })
  globalShortcut.register('Left', () => {
    controlWindow?.webContents.send('global-key', 'prev')
  })

  ipcMain.handle('toggle-global-hook', (_event, enable: boolean) => {
    if (enable && !globalHookEnabled) {
      globalShortcut.register('PageDown', () => {
        controlWindow?.webContents.send('global-key', 'next')
      })
      globalShortcut.register('PageUp', () => {
        controlWindow?.webContents.send('global-key', 'prev')
      })
      globalShortcut.register('Right', () => {
        controlWindow?.webContents.send('global-key', 'next')
      })
      globalShortcut.register('Left', () => {
        controlWindow?.webContents.send('global-key', 'prev')
      })
      globalHookEnabled = true
    } else if (!enable && globalHookEnabled) {
      globalShortcut.unregister('PageDown')
      globalShortcut.unregister('PageUp')
      globalShortcut.unregister('Right')
      globalShortcut.unregister('Left')
      globalHookEnabled = false
    }
    return globalHookEnabled
  })
}

app.whenReady().then(() => {
  createWindows()
  autoSwitchAudioToExternal()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindows()
    }
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
    musicPlayerWindow.close()
    musicPlayerWindow = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
