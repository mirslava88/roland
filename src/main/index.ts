import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, shell, desktopCapturer, protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { createControlWindow, createPresentationWindow, createOverlayWindow, createMusicPlayerWindow } from './windows'
import { ChildProcess, spawn } from 'child_process'
import { writeFileSync, unlinkSync, existsSync, appendFileSync } from 'fs'
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
  // Create the data file before spawning so the script can find it.
  // НЕ затираем существующий файл — handleSetTime в Timer.tsx делает
  // syncTimer (пишет {remaining,duration,...} в файл) ДО того как
  // useEffect запускает showTimerOverlay → showWpfTimer. Если затереть
  // на '{}', WPF на первом poll прочитает duration=0/remaining=0 и
  // покажет 00:00 вместо настроенного времени.
  try {
    if (!existsSync(wpfTimerDataFile)) {
      writeFileSync(wpfTimerDataFile, '{}')
    }
  } catch {}
  const timerScript = scriptPath('timer-overlay.ps1')
  const posX = displayBounds.x + displayBounds.width - 320
  const posY = displayBounds.y + displayBounds.height - 120
  wpfTimerProcess = spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
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
      '-NoProfile',
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

  // dbg-log: renderer processes (control + presentation) forward debug strings
  // here so everything lands in the main-process stdout stream alongside
  // [MAIN ...] and [DAEMON ...] lines. Single interleaved timeline for
  // diagnosing PDF↔PPTX flicker timing. Also persisted to a tmpdir file so
  // diagnostics survive process exit and can be read after the session.
  const dbgLogFile = join(tmpdir(), 'roland-dbg.log')
  try { writeFileSync(dbgLogFile, `=== session start ${new Date().toISOString()} ===\n`) } catch {}
  console.log(`[MAIN ${Date.now()}] dbg-log file: ${dbgLogFile}`)
  ipcMain.on('dbg-log', (_event, msg: string) => {
    const line = `[R ${Date.now()}] ${msg}`
    console.log(line)
    try { appendFileSync(dbgLogFile, line + '\n') } catch {}
  })

  ipcMain.handle('open-presentation-window', async (_event, displayId?: number) => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      console.log(`[MAIN ${Date.now()}] open-presentation-window: already open, focusing`)
      presentationWindow.focus()
      return
    }

    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay

    console.log(`[MAIN ${Date.now()}] open-presentation-window: createPresentationWindow BEGIN display=${targetDisplay!.id} bounds=${targetDisplay!.bounds.width}x${targetDisplay!.bounds.height}`)
    presentationWindow = createPresentationWindow(targetDisplay!)
    console.log(`[MAIN ${Date.now()}] open-presentation-window: createPresentationWindow END (show=false, hidden), waiting for presentation-ready`)

    // Window создано скрытым (show:false в createPresentationWindow). Renderer
    // process активен, React монтируется, signalReady() прилетит. Главное —
    // paint surface окна ЕЩЁ не в DWM, оно не может всплыть поверх overlay.
    const raiseOverlay = (reason: string): void => {
      if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
        overlayWindow.setAlwaysOnTop(true, 'screen-saver')
        overlayWindow.moveTop()
        console.log(`[MAIN ${Date.now()}] open-presentation-window: overlay re-asserted topmost (${reason})`)
      }
    }

    // Wait for the renderer to fully load and React to mount
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[MAIN ${Date.now()}] open-presentation-window: TIMEOUT (5000ms) waiting for presentation-ready`)
        resolve()
      }, 5000)
      ipcMain.once('presentation-ready', () => {
        clearTimeout(timeout)
        console.log(`[MAIN ${Date.now()}] open-presentation-window: presentation-ready received`)
        resolve()
      })
    })

    // Critical sequence: raise overlay FIRST, THEN show presentation window.
    // SW_SHOW на скрытом fullscreen window может моментально promote его
    // выше overlay в DWM, поэтому overlay должен уже лежать поверх в этот
    // момент. После show() ещё раз re-assert на всякий случай.
    raiseOverlay('before-show')
    presentationWindow.showInactive()
    console.log(`[MAIN ${Date.now()}] open-presentation-window: presentationWindow.showInactive() called`)
    raiseOverlay('after-show')

    presentationWindow.on('closed', () => {
      console.log(`[MAIN ${Date.now()}] presentation-window: closed`)
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
    console.log(`[MAIN ${Date.now()}] show-overlay: ENTER hasDataUrl=${!!freezeImageDataUrl} hasPath=${!!imagePath}`)
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
    const freshlyCreated = !overlayWindow || overlayWindow.isDestroyed()
    if (freshlyCreated) {
      console.log(`[MAIN ${Date.now()}] show-overlay: creating overlay window (first time)`)
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
    const prevOpacity = overlayWindow.getOpacity()
    const wasVisible = overlayWindow.isVisible()
    const keepOpaque = prevOpacity >= 1
    console.log(`[MAIN ${Date.now()}] show-overlay: before setBounds prevOpacity=${prevOpacity} wasVisible=${wasVisible} freshlyCreated=${freshlyCreated} keepOpaque=${keepOpaque}`)
    overlayWindow.setBounds(targetDisplay!.bounds)
    if (!keepOpaque) {
      overlayWindow.setOpacity(0)
      if (!overlayWindow.isVisible()) overlayWindow.showInactive()
      console.log(`[MAIN ${Date.now()}] show-overlay: opacity forced to 0, window visible`)
    } else {
      console.log(`[MAIN ${Date.now()}] show-overlay: overlay already opaque, keeping opacity=1 — atomically swap image`)
    }

    // Single <img id="f"> with atomic src swap. Browser keeps OLD image
    // visible until NEW decoded, then one paint swap. Single boundary
    // (atomic jump) vs ghost-prone crossfade — атомарный swap выбран
    // как лучший из плохих вариантов для different-content transitions.
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
    const jsT0 = Date.now()
    console.log(`[MAIN ${jsT0}] show-overlay: executeJavaScript BEGIN (decode+2rAF)`)
    try {
      await overlayWindow.webContents.executeJavaScript(imgJs)
    } catch { /* ignore */ }
    console.log(`[MAIN ${Date.now()}] show-overlay: executeJavaScript END dur=${Date.now() - jsT0}ms`)
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    overlayWindow.moveTop()
    if (!keepOpaque) {
      overlayWindow.setOpacity(1)
      console.log(`[MAIN ${Date.now()}] overlay opacity=1 (image=${overlayImage ? 'yes' : 'no'} path=${imagePath ?? '-'})`)
    } else {
      console.log(`[MAIN ${Date.now()}] overlay stayed opaque, image swapped atomically (image=${overlayImage ? 'yes' : 'no'} path=${imagePath ?? '-'})`)
    }
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

  // Перед hide-overlay: захватываем именно то что СЕЙЧАС нарисовано в
  // presentation window (webContents.capturePage force-flush paint в DirectX
  // surface перед снятием), swap overlay image в этот кадр. После этого
  // overlay image = presentation window pixels pixel-perfect — последующий
  // hide-overlay превращается в «убрать идентичный слой поверх идентичного»,
  // любая DWM compositor гонка невидима. Паттерн зеркалит PPTX→PPTX где
  // snapshotSlideshow + swap даёт pixel-match и работает бесшовно.
  ipcMain.handle('capture-and-swap-overlay', async () => {
    if (!presentationWindow || presentationWindow.isDestroyed()) {
      console.log(`[MAIN ${Date.now()}] capture-and-swap-overlay: no presentation window, skip`)
      return
    }
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      console.log(`[MAIN ${Date.now()}] capture-and-swap-overlay: no overlay window, skip`)
      return
    }
    const t0 = Date.now()
    try {
      const nativeImage = await presentationWindow.webContents.capturePage()
      const buffer = nativeImage.toPNG()
      const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
      console.log(`[MAIN ${Date.now()}] capture-and-swap-overlay: capturePage done (${Date.now() - t0}ms, ${buffer.length} bytes)`)
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
      console.log(`[MAIN ${Date.now()}] capture-and-swap-overlay: swap done (total ${Date.now() - t0}ms)`)
    } catch (e) {
      console.log(`[MAIN ${Date.now()}] capture-and-swap-overlay: ERROR ${String(e)}`)
    }
  })

  ipcMain.handle('hide-overlay', async () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // Native setOpacity(0) с 33мс DWM grace. Мгновенное скрытие
      // overlay — единственная transition boundary. Poliмат из
      // captureAndSwap перед hide = overlay image совпадает с
      // содержимым presentation window → hide невидим. Без
      // captureAndSwap (first-take с prev-hidden) видна jump от
      // overlay к window content.
      await new Promise<void>((resolve) => setTimeout(resolve, 33))
      console.log(`[MAIN ${Date.now()}] hide-overlay: opacity=0 (stay native-visible, after 33ms DWM grace)`)
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

  ipcMain.handle('music-set-playlist', async (_event, files: string[], startIndex?: number, autoplay?: boolean) => {
    const win = ensureMusicWindow()
    // Number()/Boolean() каст защищает от JS-injection если renderer прислал
    // строку вроде "0); alert(1); (" вместо числа (audit 2026-04-20 F-005).
    await win.webContents.executeJavaScript(
      `window._setPlaylist(${JSON.stringify(files)}, ${Number(startIndex) || 0}, ${Boolean(autoplay)})`
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
      // Boolean() каст: см. audit F-005. Renderer может прислать строку.
      await musicPlayerWindow.webContents.executeJavaScript(`window._setLoopTrack(${Boolean(value)})`)
    }
  })

  ipcMain.handle('music-set-loop-playlist', async (_event, value: boolean) => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript(`window._setLoopPlaylist(${Boolean(value)})`)
    }
  })

  ipcMain.handle('music-set-volume', async (_event, value: number) => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript(`window._setVolume(${Number(value) || 0})`)
    }
  })

  ipcMain.handle('music-seek', async (_event, time: number) => {
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      await musicPlayerWindow.webContents.executeJavaScript(`window._seek(${Number(time) || 0})`)
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
          '-NoProfile',
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
          '-NoProfile',
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

// Privileged scheme for serving validated local media to renderers running with
// webSecurity:true (a file:// document can't load cross-origin file:// itself).
// MUST be registered before app 'ready' — this runs at module load, which is
// before whenReady resolves.
protocol.registerSchemesAsPrivileged([
  { scheme: 'pdm-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg',
  '.mp4', '.mov', '.avi', '.webm', '.mkv',
  '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma'
])

// Navigation hardening: deny any top-level navigation away from the app's own
// origin (file:// in prod, the dev-server URL, or our self-built data: pages),
// and deny window.open from non-control windows. The app never navigates
// top-level or opens child windows, so this only blocks a hijacked renderer
// from pivoting to a remote origin while still holding the privileged preload.
function isAllowedNavigation(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl && url.startsWith(devUrl)) return true
  return url.startsWith('file://') || url.startsWith('data:text/html')
}

app.whenReady().then(() => {
  // Serve local media for webSecurity:true renderers. The renderer references
  // files as pdm-media://file/<encodeURIComponent(absPath)>; we decode, gate by
  // media extension, and stream the file via net.fetch(file://) (handles range
  // requests + content-type so <video> seeking works).
  protocol.handle('pdm-media', async (request) => {
    try {
      const filePath = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      if (!MEDIA_EXTENSIONS.has(ext)) return new Response('forbidden', { status: 403 })
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => { if (!isAllowedNavigation(url)) e.preventDefault() })
    contents.on('will-redirect', (e, url) => { if (!isAllowedNavigation(url)) e.preventDefault() })
    // Deny window.open by default. The control window installs its own handler
    // (with an http/https/mailto allow-list) that overrides this for itself.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Deny all renderer permission requests (camera/mic/geo/notifications/midi/
    // etc.). This is a local presentation tool that requests none — verified no
    // requestFullscreen/getUserMedia/Notification usage in the renderer.
    contents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  })

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
