import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, shell, desktopCapturer } from 'electron'
import { createControlWindow, createPresentationWindow, createOverlayWindow, createMusicPlayerWindow } from './windows'
import { ChildProcess, spawn } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { registerIpcHandlers, closeAllExternalFiles } from './ipc-handlers'
import { join } from 'path'
import { scriptPath } from './paths'
import { pptDaemon } from './powerpoint-daemon'

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
  const timerScript = scriptPath('timer-overlay.ps1')
  const posX = displayBounds.x + displayBounds.width - 320
  const posY = displayBounds.y + displayBounds.height - 120
  wpfTimerProcess = spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-STA',
    '-File', timerScript,
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


function ensureExtendDisplayMode(): void {
  if (process.platform !== 'win32') return
  // Run multiple times — Windows sometimes ignores the first call if the
  // display is still being registered
  const run = (): void => {
    try { spawn('DisplaySwitch.exe', ['/extend'], { stdio: 'ignore', detached: true }) } catch { /* ignore */ }
  }
  run()
  setTimeout(run, 800)
  setTimeout(run, 2000)
}

function restoreTaskbar(): void {
  try {
    const mwScript = scriptPath('manage-window.ps1')
    spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-File', mwScript,
      '-Action', 'show-taskbar'
    ], { stdio: 'ignore', detached: true })
  } catch { /* ignore */ }
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
    // Restore taskbar visibility on exit
    restoreTaskbar()
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

  ipcMain.handle('show-overlay', async (_event, displayId?: number, freezeImageDataUrl?: string, imagePath?: string) => {
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay

    // Hybrid mode: caller can pass a file path instead of a data URL. Read
    // the PNG from disk and inline it so the overlay renderer (sandboxed
    // data: URL page) can display it without file:// access.
    let overlayImage = freezeImageDataUrl
    if (!overlayImage && imagePath) {
      try {
        const buf = await readFile(imagePath)
        const ext = imagePath.toLowerCase()
        const mime = ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
        overlayImage = `data:${mime};base64,${buf.toString('base64')}`
      } catch { /* fall through to black overlay */ }
    }

    // Create overlay once and keep it persistently shown at screen-saver level
    // with win.setOpacity(0). All further visibility toggles are instant OS
    // opacity changes — no window show/hide animations, no black frame flash.
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      overlayWindow = createOverlayWindow(targetDisplay!)
      await new Promise<void>((resolve) => {
        const w = overlayWindow!
        let done = false
        const finish = (): void => { if (!done) { done = true; resolve() } }
        if (!w.webContents.isLoading()) { finish() }
        else {
          w.webContents.once('did-finish-load', finish)
          setTimeout(finish, 2000)
        }
      })
      overlayWindow.setAlwaysOnTop(true, 'screen-saver')
      overlayWindow.setIgnoreMouseEvents(true)
      overlayWindow.setOpacity(0)
      overlayWindow.showInactive()
    }
    overlayWindow.setBounds(targetDisplay!.bounds)
    // Native opacity must be 0 BEFORE showInactive(), otherwise the window
    // pops in opaque for one frame showing the black body bg (the #o div is
    // still at CSS opacity:0 from the previous .hide class) before the
    // imgJs below runs and decodes the new image. That one frame == flicker.
    overlayWindow.setOpacity(0)
    if (!overlayWindow.isVisible()) overlayWindow.showInactive()

    // Preload & decode the freeze image WHILE overlay is still invisible —
    // guarantees the first visible frame already contains the image.
    // CRITICAL: remove the `.hide` CSS class that hide-overlay added last
    // time. Without this, the overlay div stays at opacity:0 on every
    // subsequent show, so the freeze frame is INVISIBLE and PowerPoint's
    // raw transition shows through.
    // Also wait two rAF ticks so the decoded image is actually composited
    // into the renderer's back buffer before the native window flips opaque.
    const imgJs = overlayImage
      ? `(async () => {
           var o=document.getElementById('o');
           if (o) o.classList.remove('hide');
           var f=document.getElementById('f');
           f.style.display='block';
           f.src=${JSON.stringify(overlayImage)};
           try { await f.decode(); } catch {}
           f.getBoundingClientRect();
           await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
           return true;
         })()`
      : `(async () => {
           var o=document.getElementById('o');
           if (o) o.classList.remove('hide');
           var f=document.getElementById('f'); f.src=''; f.style.display='none';
           await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
           return true;
         })()`
    try {
      await overlayWindow.webContents.executeJavaScript(imgJs)
    } catch { /* ignore */ }
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    overlayWindow.moveTop()
    overlayWindow.setOpacity(1)
    console.log(`[MAIN ${Date.now()}] overlay opacity=1 (image=${overlayImage ? 'yes' : 'no'} path=${imagePath ?? '-'})`)
    // NB: No raise-timer. Poller data (2026-04-25 session) proved PP
    // slideshow has exStyle=0x0 — it's NOT topmost — so there is no
    // z-order race to fight. Electron's HWND_TOPMOST set once is enough.
  })

  // Grab a screenshot of the target display so the renderer can show it
  // as a "freeze-frame" inside the overlay during a channel switch.
  ipcMain.handle('capture-display', async (_event, displayId?: number): Promise<string | null> => {
    try {
      const displays = screen.getAllDisplays()
      const primaryDisplay = screen.getPrimaryDisplay()
      const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
      const targetDisplay = displayId
        ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
        : externalDisplay || primaryDisplay
      const { width, height } = targetDisplay.size
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      })
      const idx = displays.indexOf(targetDisplay)
      const source =
        sources.find((s) => s.display_id === String(targetDisplay.id)) ||
        sources[idx] ||
        sources[0]
      if (!source || source.thumbnail.isEmpty()) return null
      return source.thumbnail.toDataURL()
    } catch {
      return null
    }
  })

  // Hybrid PPTX→PPTX: overlay holds freeze-frame of OLD content while PP
  // tears down and starts NEW slideshow. Right before hideOverlay, we swap
  // the overlay image to a PRE-RENDERED PNG of the target slide — so the
  // overlay's last visible frame matches PP's first visible frame pixel-wise.
  // Even if DWM compositor races on hide/reveal, user sees no content change.
  // The img element stays visible while the new src decodes; browser paints
  // the old image until the new bitmap is ready, then swaps atomically on
  // the next frame. No opacity toggle = no DWM flicker window.
  ipcMain.handle('swap-overlay-image', async (_event, imagePath: string) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    try {
      const buf = await readFile(imagePath)
      const ext = imagePath.toLowerCase()
      const mime = ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      const js = `(async () => {
        var f=document.getElementById('f');
        if (!f) return false;
        var img = new Image();
        img.src = ${JSON.stringify(dataUrl)};
        try { await img.decode(); } catch {}
        f.src = img.src;
        f.style.display='block';
        var o=document.getElementById('o');
        if (o) o.classList.remove('hide');
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
      })()`
      await overlayWindow.webContents.executeJavaScript(js)
    } catch { /* ignore */ }
  })

  ipcMain.handle('hide-overlay', async () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // КРИТИЧНО: НЕ звать overlayWindow.hide(). Окно должно оставаться
      // native-visible (с нулевой opacity) весь жизненный цикл. hide() даёт
      // WM_SHOWWINDOW-транзишен + освобождение/переаллокацию DWM-surface,
      // и пока окно скрыто, Electron теряет screen-saver Z-order над PP —
      // PP slideshow (WS_EX_TOPMOST) успевает прорисоваться поверх до
      // следующего showInactive(). Это и есть вспышка при PPTX→PPTX.
      // setOpacity(0) — GPU-level композитная прозрачность, окно остаётся
      // в иерархии, Z-order непрерывно доминирует над PP всё время.
      console.log(`[MAIN ${Date.now()}] hide-overlay: opacity=0 (stay native-visible)`)
      overlayWindow.setOpacity(0)
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

  // --- Video playlist: file dialogs only. Playback happens in the presentation
  // window via existing load-content + VideoViewer flow (control-side state
  // in useAppStore). ---
  ipcMain.handle('select-video-files', async () => {
    const result = await dialog.showOpenDialog(controlWindow!, {
      properties: ['openFile', 'multiSelections'],
      title: 'Выберите видеофайлы',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle('select-video-folder', async () => {
    const result = await dialog.showOpenDialog(controlWindow!, {
      properties: ['openDirectory'],
      title: 'Выберите папку с видео'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folderPath = result.filePaths[0]
    const { readdir } = require('fs/promises')
    const { join, extname } = require('path')
    const entries = await readdir(folderPath)
    const videoExts = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v']
    const files: string[] = []
    for (const entry of entries) {
      if (videoExts.includes(extname(entry).toLowerCase())) {
        files.push(join(folderPath, entry))
      }
    }
    return files.length > 0 ? files : null
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
    // Auto-extend display (instead of duplicate) when external monitor is connected
    ensureExtendDisplayMode()
    sendDisplays()
  })
  screen.on('display-removed', sendDisplays)

  ipcMain.handle('open-display-settings', () => {
    if (process.platform === 'win32') {
      shell.openExternal('ms-settings:display')
    }
  })

  ipcMain.handle('set-display-mode', (_event, mode: 'internal' | 'clone' | 'extend' | 'external') => {
    if (process.platform !== 'win32') return { success: false, error: 'Windows only' }
    const flag = { internal: '/internal', clone: '/clone', extend: '/extend', external: '/external' }[mode]
    if (!flag) return { success: false, error: 'Invalid mode' }
    try {
      spawn('DisplaySwitch.exe', [flag], { stdio: 'ignore', detached: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('set-display-resolution', async (_event, deviceName: string, width: number, height: number, frequency?: number) => {
    if (process.platform !== 'win32') return { success: false, error: 'Windows only' }
    try {
      const srScript = scriptPath('set-resolution.ps1')
      return await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const args = [
          '-ExecutionPolicy', 'Bypass',
          '-File', srScript,
          '-DeviceName', deviceName,
          '-Width', String(width),
          '-Height', String(height)
        ]
        if (frequency && frequency > 0) {
          args.push('-Frequency', String(frequency))
        }
        const child = spawn('powershell.exe', args, { stdio: 'ignore' })
        child.on('close', (code) => {
          resolve(code === 0 ? { success: true } : { success: false, error: `ChangeDisplaySettings returned ${code}` })
        })
        child.on('error', (err) => resolve({ success: false, error: String(err) }))
      })
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('get-display-modes', async () => {
    if (process.platform !== 'win32') return []
    try {
      const gdmScript = scriptPath('get-display-modes.ps1')
      return await new Promise<Array<{ deviceName: string; friendlyName: string; current: { width: number; height: number; frequency: number }; modes: Array<{ width: number; height: number; frequency: number }> }>>((resolve) => {
        let data = ''
        const child = spawn('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-File', gdmScript
        ], { stdio: ['ignore', 'pipe', 'ignore'] })
        child.stdout.on('data', (chunk) => { data += chunk.toString() })
        child.on('close', () => {
          try { resolve(JSON.parse(data || '[]')) }
          catch { resolve([]) }
        })
        child.on('error', () => resolve([]))
      })
    } catch { return [] }
  })

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
  // Ensure extended display mode on startup if external monitor is connected
  if (process.platform === 'win32') {
    const displays = screen.getAllDisplays()
    if (displays.length > 1) {
      ensureExtendDisplayMode()
    }
  }

  createWindows()

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

app.on('before-quit', () => {
  void pptDaemon.shutdown()
})
