import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, shell, desktopCapturer, protocol, session } from 'electron'
import type { DesktopCapturerSource, Display } from 'electron'
import { createControlWindow, createPresentationWindow, createOverlayWindow, createMusicPlayerWindow } from './windows'
import { ChildProcess, spawn } from 'child_process'
import { writeFileSync, unlinkSync, existsSync, createReadStream } from 'fs'
import { readFile, stat } from 'fs/promises'
import { Readable } from 'stream'
import { tmpdir } from 'os'
import { registerIpcHandlers, closeAllExternalFiles } from './ipc-handlers'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { scriptPath } from './paths'
import { pptDaemon } from './powerpoint-daemon'
import { diagnosticLog, formatDiagnosticError, getDiagnosticLogPath, initDiagnosticLog } from './diagnostic-log'
import {
  hwndFromCaptureSourceId,
  isSameNativeWindow,
  nativeWindowDaemon
} from './native-window-daemon'
import type { NativeTopLevelWindow } from './native-window-daemon'

interface DesktopCaptureSourceInfo {
  id: string
  captureId?: string
  name: string
  kind: 'window' | 'screen'
  thumbnail: string
  appIcon?: string
  displayId?: string
  processName?: string
  isMinimized?: boolean
  nativeHwnd?: string
  nativePid?: number
  availability?: 'ready' | 'minimized' | 'unavailable'
}

interface NativeDesktopSourceRegistryEntry {
  hwnd: string
  pid: number
  title: string
  processName: string
  seenAt: number
}

let controlWindow: BrowserWindow | null = null
let presentationWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let wpfTimerProcess: ChildProcess | null = null // WPF timer overlay for PPTX
const wpfTimerDataFile = join(tmpdir(), 'roland-timer-data.json')
let musicPlayerWindow: BrowserWindow | null = null
let activeContentType: string | null = null // tracks what's on the external display
let timerActive = false // whether timer overlay is currently shown
let presentationWindowReady = false
let presentationWindowRequestedVisible = false
const presentationReadyWaiters = new Set<() => void>()
let overlayZOrderGuard: NodeJS.Timeout | null = null
let overlayPlacement: 'cover' | 'underlay' = 'cover'
let quitCleanupStarted = false
let quitCleanupComplete = false
const nativeDesktopSourceRegistry = new Map<string, NativeDesktopSourceRegistryEntry>()
const nativeAppIconCache = new Map<string, Promise<string | undefined>>()
let lastDesktopWindowInventorySignature = ''

// Live capture sources must start rendering even though the prewarmed output
// window never receives a mouse click of its own. This affects only media
// playback policy; camera/microphone access is still guarded explicitly below.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function stopOverlayZOrderGuard(): void {
  if (!overlayZOrderGuard) return
  clearInterval(overlayZOrderGuard)
  overlayZOrderGuard = null
  diagnosticLog('window', 'overlay z-order guard stopped')
}

function startOverlayZOrderGuard(): void {
  stopOverlayZOrderGuard()
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  try {
    // One native raise is enough now that the PowerPoint daemon catches every
    // newly-created slideshow HWND, hides it before first paint, and explicitly
    // removes WS_EX_TOPMOST before revealing it. Repeating moveTop every 4ms
    // continuously invalidated DWM z-order and produced intermittent flashes.
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    overlayWindow.moveTop()
    diagnosticLog('window', 'overlay z-order raised once (native PowerPoint guard active)')
  } catch { /* window can be closing */ }
}

ipcMain.on('presentation-ready', (event) => {
  if (
    !presentationWindow ||
    presentationWindow.isDestroyed() ||
    event.sender.id !== presentationWindow.webContents.id
  ) return

  presentationWindowReady = true
  console.log(`[MAIN ${Date.now()}] presentation-window: renderer ready`)
  for (const resolve of presentationReadyWaiters) resolve()
  presentationReadyWaiters.clear()
})

function waitForPresentationWindowReady(timeoutMs = 5000): Promise<void> {
  if (presentationWindowReady) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      presentationReadyWaiters.delete(finish)
      resolve()
    }
    const timeout = setTimeout(() => {
      console.log(`[MAIN ${Date.now()}] presentation-window: ready timeout (${timeoutMs}ms)`)
      finish()
    }, timeoutMs)
    presentationReadyWaiters.add(finish)
  })
}

function createManagedPresentationWindow(display: Display): BrowserWindow {
  presentationWindowReady = false
  const win = createPresentationWindow(display)
  // Keep the 4K native surface alive. On the affected PC a hidden window
  // takes 5–6 seconds to reactivate even when its renderer is already loaded.
  // A fully transparent Windows HWND still receives mouse input unless told
  // otherwise. Without this guard a warm surface on the primary display can
  // make the control UI look frozen even though its renderer is healthy.
  win.setIgnoreMouseEvents(true)
  win.setOpacity(0)
  win.on('closed', () => {
    if (presentationWindow !== win) return
    console.log(`[MAIN ${Date.now()}] presentation-window: closed`)
    presentationWindow = null
    presentationWindowReady = false
    for (const resolve of presentationReadyWaiters) resolve()
    presentationReadyWaiters.clear()
    controlWindow?.webContents.send('presentation-window-closed')
  })
  return win
}

function prewarmPresentationWindow(): void {
  const displays = screen.getAllDisplays()
  const primaryDisplay = screen.getPrimaryDisplay()
  const externalDisplay = displays.find((display) => display.id !== primaryDisplay.id)
  const targetDisplay = externalDisplay || primaryDisplay

  if (presentationWindow && !presentationWindow.isDestroyed()) {
    // A renderer created headlessly on the primary display keeps camera/device
    // enumeration alive when the laptop starts without an external monitor.
    // Once an output is attached, move that same warm surface onto it instead
    // of creating a second CaptureHub and duplicate media streams.
    if (externalDisplay) {
      presentationWindow.setBounds(externalDisplay.bounds)
      presentationWindow.setIgnoreMouseEvents(true)
      presentationWindow.setOpacity(0)
      if (!presentationWindow.isVisible()) presentationWindow.showInactive()
      diagnosticLog('window', `presentation headless surface promoted to display=${externalDisplay.id}`)
    }
    return
  }

  const headless = !externalDisplay
  console.log(`[MAIN ${Date.now()}] presentation-window: prewarm BEGIN display=${targetDisplay.id} headless=${headless}`)
  const warmWindow = createManagedPresentationWindow(targetDisplay)
  presentationWindow = warmWindow
  void waitForPresentationWindowReady().then(() => {
    if (
      presentationWindow === warmWindow &&
      !warmWindow.isDestroyed() &&
      !presentationWindowRequestedVisible
    ) {
      warmWindow.setIgnoreMouseEvents(true)
      warmWindow.setOpacity(0)
      // With one monitor the renderer must exist for camera enumeration, but
      // its native HWND must stay hidden so it cannot cover the control UI.
      if (externalDisplay) warmWindow.showInactive()
    }
    console.log(`[MAIN ${Date.now()}] presentation-window: prewarm END ready=${presentationWindowReady}`)
    diagnosticLog(
      'window',
      `presentation prewarm ready=${presentationWindowReady} headless=${headless} visible=${warmWindow.isDestroyed() ? false : warmWindow.isVisible()}`
    )
  })
}

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

function nativeSourceKey(window: Pick<NativeTopLevelWindow, 'hwnd' | 'pid'>): string {
  return `native-window:${window.hwnd}:${window.pid}`
}

function getOwnWindowHwnds(): Set<string> {
  const handles = new Set<string>()
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    try {
      const handle = window.getNativeWindowHandle()
      if (handle.length >= 8) handles.add(handle.readBigUInt64LE(0).toString(10))
      else if (handle.length >= 4) handles.add(String(handle.readUInt32LE(0)))
    } catch { /* window may be closing */ }
    try {
      const sourceHwnd = hwndFromCaptureSourceId(window.getMediaSourceId())
      if (sourceHwnd) handles.add(sourceHwnd)
    } catch { /* media id can be unavailable while a window is closing */ }
  }
  return handles
}

function electronDesktopSourceInfo(
  source: DesktopCapturerSource,
  kind: 'window' | 'screen',
  id = source.id
): DesktopCaptureSourceInfo {
  return {
    id,
    captureId: source.id,
    name: source.name,
    kind,
    thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : undefined,
    displayId: source.display_id || undefined,
    availability: 'ready'
  }
}

function normalizedProcessName(processName: string): string {
  return processName.trim().replace(/\.exe$/i, '').toLowerCase()
}

function processIconFallbackPath(processName: string): string | undefined {
  const name = normalizedProcessName(processName)
  if (!name) return undefined

  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const explicitPaths: Record<string, string> = {
    explorer: join(systemRoot, 'explorer.exe'),
    powershell: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    pwsh: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }
  const candidates = [
    explicitPaths[name],
    join(systemRoot, 'System32', `${name}.exe`)
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => existsSync(candidate))
}

function cachedFileIcon(filePath: string): Promise<string | undefined> {
  const cacheKey = `path:${filePath.toLowerCase()}`
  const cached = nativeAppIconCache.get(cacheKey)
  if (cached) return cached

  const pending = app.getFileIcon(filePath, { size: 'normal' })
    .then((icon) => icon.isEmpty() ? undefined : icon.toDataURL())
    .catch(() => undefined)
  nativeAppIconCache.set(cacheKey, pending)
  return pending
}

async function nativeWindowAppIcon(window: NativeTopLevelWindow): Promise<string | undefined> {
  const processPath = window.processPath?.trim()
  if (processPath) {
    const exactIcon = await cachedFileIcon(processPath)
    if (exactIcon) return exactIcon
  }

  // Access to an executable path can be denied for protected/system windows.
  // Cache the well-known process-name fallback too, so automatic picker polls
  // never repeat filesystem/icon work.
  const processName = normalizedProcessName(window.processName)
  if (!processName) return undefined
  const cacheKey = `process:${processName}`
  const cached = nativeAppIconCache.get(cacheKey)
  if (cached) return cached

  const fallbackPath = processIconFallbackPath(processName)
  const pending = fallbackPath
    ? cachedFileIcon(fallbackPath)
    : Promise.resolve(undefined)
  nativeAppIconCache.set(cacheKey, pending)
  return pending
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
  const dbgLogFile = getDiagnosticLogPath()
  console.log(`[MAIN ${Date.now()}] dbg-log file: ${dbgLogFile}`)
  ipcMain.on('dbg-log', (_event, msg: string) => {
    const line = `[R ${Date.now()}] ${msg}`
    console.log(line)
    diagnosticLog('renderer', msg)
  })

  ipcMain.handle('open-presentation-window', async (
    _event,
    displayId?: number,
    behindPowerPoint = false
  ) => {
    presentationWindowRequestedVisible = true
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay

    const raiseOverlay = (reason: string): void => {
      if (
        overlayPlacement === 'cover' &&
        overlayWindow &&
        !overlayWindow.isDestroyed() &&
        overlayWindow.isVisible()
      ) {
        overlayWindow.setAlwaysOnTop(true, 'screen-saver')
        overlayWindow.moveTop()
        console.log(`[MAIN ${Date.now()}] open-presentation-window: overlay re-asserted topmost (${reason})`)
      }
    }

    if (!presentationWindow || presentationWindow.isDestroyed()) {
      console.log(`[MAIN ${Date.now()}] open-presentation-window: create BEGIN display=${targetDisplay!.id}`)
      presentationWindow = createManagedPresentationWindow(targetDisplay!)
    } else {
      console.log(`[MAIN ${Date.now()}] open-presentation-window: reusing warm window`)
      const currentBounds = presentationWindow.getBounds()
      const nextBounds = targetDisplay!.bounds
      if (
        currentBounds.x !== nextBounds.x || currentBounds.y !== nextBounds.y ||
        currentBounds.width !== nextBounds.width || currentBounds.height !== nextBounds.height
      ) {
        presentationWindow.setBounds(nextBounds)
      }
    }

    // Usually already resolved by startup prewarm. This remains as a safe
    // fallback when the first TAKE is pressed immediately after app launch.
    await waitForPresentationWindowReady()

    // Critical sequence: raise overlay FIRST, THEN show presentation window.
    // SW_SHOW на скрытом fullscreen window может моментально promote его
    // выше overlay в DWM, поэтому overlay должен уже лежать поверх в этот
    // момент. После show() ещё раз re-assert на всякий случай.
    if (!behindPowerPoint) raiseOverlay('before-show')
    if (!presentationWindow.isVisible()) presentationWindow.showInactive()
    presentationWindow.setAlwaysOnTop(false)
    presentationWindow.setOpacity(1)
    presentationWindow.setIgnoreMouseEvents(false)
    if (behindPowerPoint) {
      diagnosticLog('window', 'presentation output revealed behind live PowerPoint')
    } else if (overlayPlacement === 'underlay') {
      // The old frame is a non-topmost safety layer. Promote the already
      // painted target once; removing the underlay later cannot expose it.
      presentationWindow.moveTop()
      diagnosticLog('window', 'presentation output promoted above transition underlay')
    }
    console.log(`[MAIN ${Date.now()}] open-presentation-window: warm surface opacity=1`)
    diagnosticLog('window', 'presentation output opacity=1 (warm reveal)')
    if (!behindPowerPoint) raiseOverlay('after-show')

  })

  ipcMain.handle('close-presentation-window', () => {
    presentationWindowRequestedVisible = false
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      // Keep the renderer, PDF cache and GPU surface warm. Destroying this
      // window made every PPTX→PDF switch pay a 5–8 second renderer startup
      // and introduced a new fullscreen HWND into DWM on every TAKE.
      presentationWindow.setIgnoreMouseEvents(true)
      presentationWindow.setOpacity(0)
      console.log(`[MAIN ${Date.now()}] presentation-window: opacity=0 (kept warm)`)
      diagnosticLog('window', 'presentation output opacity=0 (kept warm)')
    }
  })

  ipcMain.handle('show-overlay', async (
    _event,
    displayId?: number,
    freezeImageDataUrl?: string,
    imagePath?: string,
    placement: 'cover' | 'underlay' = 'cover'
  ) => {
    overlayPlacement = placement
    console.log(`[MAIN ${Date.now()}] show-overlay: ENTER placement=${placement} hasDataUrl=${!!freezeImageDataUrl} hasPath=${!!imagePath}`)
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
      // An owned BrowserWindow is forced above its owner by Windows and cannot
      // act as a true underlay, so the transition window stays independent.
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
    const retainExistingFrame = keepOpaque && !overlayImage && !imagePath
    const imgJs = retainExistingFrame
      ? `(async () => {
           var o=document.getElementById('o');
           if (o) o.classList.remove('hide');
           await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
           return true;
         })()`
      : overlayImage
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
    if (placement === 'underlay') {
      stopOverlayZOrderGuard()
      overlayWindow.setAlwaysOnTop(false)
      // It may temporarily cover the old live HWND, but it contains that exact
      // old frame. The prepared target is then promoted above this window once
      // and the old bitmap can no longer flash back over the new content.
      overlayWindow.moveTop()
      diagnosticLog('window', 'transition underlay armed below next target')
    } else {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver')
      overlayWindow.moveTop()
    }
    if (!keepOpaque) {
      overlayWindow.setOpacity(1)
      console.log(`[MAIN ${Date.now()}] overlay opacity=1 (image=${overlayImage ? 'yes' : 'no'} path=${imagePath ?? '-'})`)
    } else {
      console.log(`[MAIN ${Date.now()}] overlay stayed opaque, frame=${retainExistingFrame ? 'retained' : 'swapped'} (image=${overlayImage ? 'yes' : 'no'} path=${imagePath ?? '-'})`)
    }
    if (placement === 'cover') startOverlayZOrderGuard()
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

  // Enumerate program windows and displays only for the trusted operator
  // window. The selected source id is later opened by the already-sandboxed
  // presentation renderer, which owns all long-lived live capture streams.
  ipcMain.handle('get-desktop-capture-sources', async (
    event,
    requestedTypes?: Array<'window' | 'screen'>,
    excludedDisplayId?: number
  ) => {
    if (
      !controlWindow ||
      controlWindow.isDestroyed() ||
      event.sender.id !== controlWindow.webContents.id
    ) {
      diagnosticLog('capture', `desktop sources denied wc=${event.sender.id}`)
      return []
    }

    const allowedTypes = new Set<'window' | 'screen'>(['window', 'screen'])
    const types: Array<'window' | 'screen'> = Array.isArray(requestedTypes)
      ? [...new Set(requestedTypes.filter((type): type is 'window' | 'screen' => allowedTypes.has(type)))]
      : ['window', 'screen']
    if (types.length === 0) return []

    try {
      const displays = screen.getAllDisplays()
      const primaryDisplay = screen.getPrimaryDisplay()
      const defaultOutputDisplay = displays.find((display) => display.id !== primaryDisplay.id) || primaryDisplay
      const requestedOutputDisplay = Number.isFinite(excludedDisplayId)
        ? displays.find((display) => display.id === excludedDisplayId)
        : undefined
      const currentPresentationDisplay = presentationWindow && !presentationWindow.isDestroyed()
        ? screen.getDisplayMatching(presentationWindow.getBounds())
        : undefined
      const protectedDisplayId = String(
        requestedOutputDisplay?.id ?? currentPresentationDisplay?.id ?? defaultOutputDisplay.id
      )
      const nativeWindowsPromise = types.includes('window')
        ? nativeWindowDaemon.listWindows({ excludedPids: [process.pid] }).catch((error) => {
            diagnosticLog('capture', `native window list failed ${formatDiagnosticError(error)}`)
            return [] as NativeTopLevelWindow[]
          })
        : Promise.resolve([] as NativeTopLevelWindow[])
      const [sources, nativeWindows] = await Promise.all([
        desktopCapturer.getSources({
          types,
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: types.includes('window')
        }),
        nativeWindowsPromise
      ])

      const ownWindowHwnds = getOwnWindowHwnds()
      const electronWindowsByHwnd = new Map<string, DesktopCapturerSource>()
      for (const source of sources) {
        if (!source.id.startsWith('window:')) continue
        const hwnd = hwndFromCaptureSourceId(source.id)
        if (!hwnd || ownWindowHwnds.has(hwnd)) continue
        if (!electronWindowsByHwnd.has(hwnd)) electronWindowsByHwnd.set(hwnd, source)
      }

      const nativeAppIconsByHwnd = new Map<string, string>()
      await Promise.all(nativeWindows.map(async (nativeWindow) => {
        if (ownWindowHwnds.has(nativeWindow.hwnd)) return
        const icon = await nativeWindowAppIcon(nativeWindow)
        if (icon) nativeAppIconsByHwnd.set(nativeWindow.hwnd, icon)
      }))

      const now = Date.now()
      const windowResults: DesktopCaptureSourceInfo[] = []
      const mergedHwnds = new Set<string>()
      for (const nativeWindow of nativeWindows) {
        if (ownWindowHwnds.has(nativeWindow.hwnd)) continue
        const key = nativeSourceKey(nativeWindow)
        const electronSource = electronWindowsByHwnd.get(nativeWindow.hwnd)
        nativeDesktopSourceRegistry.set(key, {
          hwnd: nativeWindow.hwnd,
          pid: nativeWindow.pid,
          title: nativeWindow.title,
          processName: nativeWindow.processName,
          seenAt: now
        })
        mergedHwnds.add(nativeWindow.hwnd)
        const electronInfo = electronSource
          ? electronDesktopSourceInfo(electronSource, 'window', key)
          : undefined
        windowResults.push({
          ...(electronInfo || {
            id: key,
            name: nativeWindow.title,
            kind: 'window' as const,
            thumbnail: ''
          }),
          name: nativeWindow.title,
          appIcon: electronInfo?.appIcon || nativeAppIconsByHwnd.get(nativeWindow.hwnd),
          processName: nativeWindow.processName || undefined,
          isMinimized: nativeWindow.minimized,
          nativeHwnd: nativeWindow.hwnd,
          nativePid: nativeWindow.pid,
          availability: electronSource
            ? 'ready'
            : nativeWindow.minimized
              ? 'minimized'
              : 'unavailable'
        })
      }

      // Keep rare Chromium-only sources too (for example a capturable surface
      // that Windows does not classify as a regular Alt-Tab application).
      for (const [hwnd, source] of electronWindowsByHwnd) {
        if (mergedHwnds.has(hwnd)) continue
        windowResults.push(electronDesktopSourceInfo(source, 'window'))
      }

      windowResults.sort((left, right) => {
        const appOrder = (left.processName || left.name).localeCompare(
          right.processName || right.name,
          'ru',
          { sensitivity: 'base', numeric: true }
        )
        return appOrder || left.name.localeCompare(right.name, 'ru', { sensitivity: 'base', numeric: true })
      })
      const inventorySignature = windowResults
        .map((source) => `${source.id}|${source.name}|${source.isMinimized ? 'min' : 'open'}`)
        .join('\n')
      if (inventorySignature !== lastDesktopWindowInventorySignature) {
        lastDesktopWindowInventorySignature = inventorySignature
        diagnosticLog(
          'capture',
          `window inventory changed: ${windowResults.map((source) => `${source.processName || '?'}:${source.name}${source.isMinimized ? '[min]' : ''}`).join(' | ')}`
        )
      }

      for (const [key, entry] of nativeDesktopSourceRegistry) {
        if (now - entry.seenAt > 15000) nativeDesktopSourceRegistry.delete(key)
      }

      const screenResults = sources
        .filter((source) => (
          source.id.startsWith('screen:') && source.display_id !== protectedDisplayId
        ))
        .map((source) => electronDesktopSourceInfo(source, 'screen'))
      const result = [
        ...(types.includes('window') ? windowResults : []),
        ...(types.includes('screen') ? screenResults : [])
      ]
      const rawWindows = sources.filter((source) => source.id.startsWith('window:')).length
      const rawScreens = sources.length - rawWindows
      const listedWindows = result.filter((source) => source.kind === 'window').length
      const listedScreens = result.length - listedWindows
      const minimizedWindows = windowResults.filter((source) => source.isMinimized).length
      diagnosticLog(
        'capture',
        `desktop sources listed types=${types.join(',')} windows=${listedWindows} electron=${rawWindows} native=${nativeWindows.length} minimized=${minimizedWindows} screens=${listedScreens}/${rawScreens} ownHwnd=${ownWindowHwnds.size} protectedDisplay=${protectedDisplayId}`
      )
      return result
    } catch (error) {
      diagnosticLog('capture', `desktop sources failed ${formatDiagnosticError(error)}`)
      return []
    }
  })

  ipcMain.handle('prepare-desktop-capture-source', async (
    event,
    sourceKey: string
  ): Promise<{ success: boolean; source?: DesktopCaptureSourceInfo; error?: string }> => {
    if (
      !controlWindow ||
      controlWindow.isDestroyed() ||
      event.sender.id !== controlWindow.webContents.id ||
      typeof sourceKey !== 'string' ||
      sourceKey.length > 200
    ) {
      diagnosticLog('capture', `desktop source prepare denied wc=${event.sender.id}`)
      return { success: false, error: 'Источник окна недоступен.' }
    }

    try {
      const ownWindowHwnds = getOwnWindowHwnds()
      const registryEntry = nativeDesktopSourceRegistry.get(sourceKey)
      const nativeKey = /^native-window:(\d+):(\d+)$/.exec(sourceKey)
      const directHwnd = hwndFromCaptureSourceId(sourceKey)
      const nativeWindows = await nativeWindowDaemon.listWindows({ excludedPids: [process.pid] })
      let targetWindow = nativeWindows.find((window) => (
        nativeKey
          ? window.hwnd === nativeKey[1] && window.pid === Number(nativeKey[2])
          : registryEntry
            ? window.hwnd === registryEntry.hwnd && window.pid === registryEntry.pid
            : directHwnd
              ? window.hwnd === directHwnd
              : false
      ))

      // A channel can be taken long after the picker was closed. The picker
      // registry is only a short-lived UI cache, so validate the stable
      // HWND+PID key against a fresh EnumWindows snapshot on every TAKE.
      if (nativeKey && !targetWindow) {
        nativeDesktopSourceRegistry.delete(sourceKey)
        return { success: false, error: 'Окно уже закрыто или больше недоступно.' }
      }
      if (targetWindow && ownWindowHwnds.has(targetWindow.hwnd)) {
        targetWindow = undefined
      }

      const targetHwnd = targetWindow?.hwnd || hwndFromCaptureSourceId(sourceKey)
      if (!targetHwnd || ownWindowHwnds.has(targetHwnd)) {
        return { success: false, error: 'Это окно нельзя использовать как источник.' }
      }

      const findElectronSource = async (): Promise<DesktopCapturerSource | undefined> => {
        const candidates = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true
        })
        return candidates.find((source) => isSameNativeWindow(source.id, targetHwnd))
      }

      let electronSource = await findElectronSource()
      let targetWasActivated = false
      // Restoring belongs exclusively to the explicit "В эфир" action. A
      // stale Chromium source can still exist for an iconic window, so force
      // a fresh lookup after requesting the native restore.
      if (targetWindow?.minimized) {
        // TAKE is the explicit hand-off point requested by the operator: make
        // the selected application visible in front instead of restoring it
        // behind PDM with SW_SHOWNOACTIVATE.
        const restored = await nativeWindowDaemon.restoreWindow(targetWindow.hwnd, true)
        targetWasActivated = true
        diagnosticLog(
          'capture',
          `restore window hwnd=${targetWindow.hwnd} requested=${restored.requested} ` +
          `minimized=${restored.minimized} activated=${restored.activated} foreground=${restored.foreground}`
        )
        electronSource = undefined
      }
      if (!electronSource && targetWindow) {
        if (!targetWindow.minimized) {
          await nativeWindowDaemon.restoreWindow(targetWindow.hwnd, true)
          targetWasActivated = true
        }

        for (let attempt = 0; attempt < 24 && !electronSource; attempt++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100))
          electronSource = await findElectronSource()
          if (!electronSource && attempt === 8 && !targetWasActivated) {
            await nativeWindowDaemon.restoreWindow(targetWindow.hwnd, true)
            targetWasActivated = true
          }
        }
      }

      if (targetWasActivated) {
        // Do not immediately focus PDM again: that would put Word/Excel back
        // behind the control window and make a successful restore look like it
        // never happened. The operator can return to PDM normally afterwards.
        diagnosticLog('capture', `foreground handed to captured window hwnd=${targetHwnd}`)
      }
      if (!electronSource) {
        return {
          success: false,
          error: 'Windows показала окно в списке, но не разрешила его захватить. Разверните окно и попробуйте ещё раз.'
        }
      }

      const name = targetWindow?.title || electronSource.name
      const electronInfo = electronDesktopSourceInfo(electronSource, 'window', sourceKey)
      const prepared = {
        ...electronInfo,
        name,
        appIcon: electronInfo.appIcon || (targetWindow
          ? await nativeWindowAppIcon(targetWindow)
          : undefined),
        processName: targetWindow?.processName || undefined,
        isMinimized: false,
        nativeHwnd: targetWindow?.hwnd || targetHwnd,
        nativePid: targetWindow?.pid,
        availability: 'ready' as const
      }
      diagnosticLog(
        'capture',
        `desktop source prepared key=${sourceKey} captureId=${electronSource.id} label=${name}`
      )
      return { success: true, source: prepared }
    } catch (error) {
      diagnosticLog('capture', `desktop source prepare failed ${formatDiagnosticError(error)}`)
      return { success: false, error: `Не удалось подготовить окно: ${formatDiagnosticError(error)}` }
    }
  })

  // Capture the Electron output window itself, not a desktop thumbnail. This
  // gives PDF→PDF transitions an exact freeze of the currently visible PDF
  // using the same Chromium surface that capture-and-swap-overlay captures at
  // the end of the switch. Keeping both boundary frames in the same pixel
  // pipeline avoids the pdf.js-vs-Windows.Data.Pdf visual jump.
  ipcMain.handle('capture-presentation-frame', async (): Promise<string | null> => {
    if (!presentationWindow || presentationWindow.isDestroyed()) return null
    const t0 = Date.now()
    try {
      const nativeImage = await presentationWindow.webContents.capturePage()
      if (nativeImage.isEmpty()) return null
      const buffer = nativeImage.toPNG()
      console.log(
        `[MAIN ${Date.now()}] capture-presentation-frame: done (${Date.now() - t0}ms, ${buffer.length} bytes)`
      )
      return `data:image/png;base64,${buffer.toString('base64')}`
    } catch (error) {
      console.log(`[MAIN ${Date.now()}] capture-presentation-frame: ERROR ${String(error)}`)
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

  // A pinned target frame is the actual visible output between a cross-window
  // TAKE and the first navigation click. Stop the aggressive 4ms z-order
  // guard once the target bitmap is installed; the window remains TOPMOST,
  // while other intentional overlays (notably the timer) can still surface.
  ipcMain.handle('pin-overlay', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    overlayPlacement = 'cover'
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    overlayWindow.moveTop()
    stopOverlayZOrderGuard()
    diagnosticLog('window', `overlay pinned opacity=${overlayWindow.getOpacity()}`)
  })

  // Перед hide-overlay: захватываем именно то что СЕЙЧАС нарисовано в
  // presentation window (webContents.capturePage force-flush paint в DirectX
  // surface перед снятием), swap overlay image в этот кадр. После этого
  // overlay image = presentation window pixels pixel-perfect — последующий
  // hide-overlay превращается в «убрать идентичный слой поверх идентичного»,
  // любая DWM compositor гонка невидима. Паттерн зеркалит PPTX→PPTX где
  // snapshotSlideshow + swap даёт pixel-match и работает бесшовно.
  ipcMain.handle('capture-and-swap-overlay', async (): Promise<boolean> => {
    if (!presentationWindow || presentationWindow.isDestroyed()) {
      console.log(`[MAIN ${Date.now()}] capture-and-swap-overlay: no presentation window, skip`)
      return false
    }
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      console.log(`[MAIN ${Date.now()}] capture-and-swap-overlay: no overlay window, skip`)
      return false
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
      return true
    } catch (e) {
      console.log(`[MAIN ${Date.now()}] capture-and-swap-overlay: ERROR ${String(e)}`)
      return false
    }
  })

  ipcMain.handle('hide-overlay', async () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // Give the prepared target one DWM frame, then remove the freeze frame
      // over a very short native-opacity ramp. An instant 1 -> 0 jump exposed
      // a compositor boundary as a visible flash on the slower machine.
      await new Promise<void>((resolve) => setTimeout(resolve, 33))
      const startOpacity = overlayWindow.getOpacity()
      if (startOpacity > 0.01) {
        console.log(`[MAIN ${Date.now()}] hide-overlay: native crossfade begin opacity=${startOpacity}`)
        for (const opacity of [0.82, 0.58, 0.32, 0.12, 0]) {
          if (!overlayWindow || overlayWindow.isDestroyed()) break
          overlayWindow.setOpacity(opacity)
          if (opacity > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 14))
          }
        }
        console.log(`[MAIN ${Date.now()}] hide-overlay: native crossfade complete opacity=0`)
      } else {
        overlayWindow.setOpacity(0)
      }
      stopOverlayZOrderGuard()
    }
  })

  ipcMain.on('timer-overlay-update', (_event, data: {
    remaining: number
    running: boolean
    duration: number
    posX: number
    posY: number
    scale: number
    textColor: string
    warningTextColor: string
    overtimeTextColor: string
    textOpacity: number
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
      bounds: d.bounds,
      scaleFactor: d.scaleFactor
    }))
  })

  // window.devicePixelRatio can briefly report the primary monitor's scale
  // when a hidden BrowserWindow is created directly on a secondary display.
  // Canvas renderers need the scale of the display that actually contains the
  // presentation window, otherwise a 4K/150% output gets a 2560px buffer and
  // Windows stretches it to 3840px. Resolve it in the main process where
  // Electron exposes authoritative per-monitor metrics.
  ipcMain.handle('get-window-display-scale-factor', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return 1
    const display = screen.getDisplayMatching(win.getBounds())
    diagnosticLog(
      'display',
      `window scale window=${win.getTitle() || '-'} display=${display.id} scale=${display.scaleFactor} bounds=${JSON.stringify(display.bounds)}`
    )
    return display.scaleFactor || 1
  })

  const sendDisplays = (): void => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      const displays = screen.getAllDisplays()
      const primary = screen.getPrimaryDisplay()
      controlWindow.webContents.send('displays-changed', displays.map((d) => ({
        id: d.id,
        label: `${d.size.width}x${d.size.height}`,
        isPrimary: d.id === primary.id,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor
      })))
    }
  }

  screen.on('display-added', () => {
    // Auto-extend display (instead of duplicate) when external monitor is connected
    ensureExtendDisplayMode()
    sendDisplays()
    // DisplaySwitch/Windows may need a moment to publish stable extended
    // bounds. Prewarm only after a genuine second display is visible.
    setTimeout(() => {
      sendDisplays()
      prewarmPresentationWindow()
    }, 1500)
  })
  screen.on('display-removed', () => {
    sendDisplays()
    if (
      screen.getAllDisplays().length < 2 &&
      presentationWindow &&
      !presentationWindow.isDestroyed()
    ) {
      presentationWindowRequestedVisible = false
      presentationWindow.setIgnoreMouseEvents(true)
      diagnosticLog('window', 'presentation window closed: external display removed')
      presentationWindow.close()
      // Recreate only the hidden renderer on the primary display. CaptureHub
      // remains available for USB-camera enumeration without blocking input.
      setTimeout(() => prewarmPresentationWindow(), 250)
    }
  })

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

  const navigationShortcuts: Array<{
    accelerator: string
    direction: 'next' | 'prev'
  }> = [
    { accelerator: 'PageDown', direction: 'next' },
    { accelerator: 'PageUp', direction: 'prev' },
    { accelerator: 'Right', direction: 'next' },
    { accelerator: 'Left', direction: 'prev' },
    // Some presenter remotes identify as ArrowDown/ArrowUp rather than
    // PageDown/PageUp. Local keydown only sees those while the control window
    // owns focus; global registration keeps the first click after an output
    // window/PowerPoint focus transition from disappearing.
    { accelerator: 'Down', direction: 'next' },
    { accelerator: 'Up', direction: 'prev' }
  ]

  const registerNavigationShortcuts = (): void => {
    for (const { accelerator, direction } of navigationShortcuts) {
      const registered = globalShortcut.register(accelerator, () => {
        diagnosticLog(
          'input',
          `global shortcut=${accelerator} direction=${direction} activeContent=${activeContentType ?? 'none'}`
        )
        controlWindow?.webContents.send('global-key', direction)
      })
      diagnosticLog('input', `register shortcut=${accelerator} success=${registered}`)
    }
  }

  const unregisterNavigationShortcuts = (): void => {
    for (const { accelerator } of navigationShortcuts) {
      globalShortcut.unregister(accelerator)
    }
  }

  // Register global shortcuts by default
  registerNavigationShortcuts()

  ipcMain.handle('toggle-global-hook', (_event, enable: boolean) => {
    if (enable && !globalHookEnabled) {
      registerNavigationShortcuts()
      globalHookEnabled = true
    } else if (!enable && globalHookEnabled) {
      unregisterNavigationShortcuts()
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

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv'])
const MEDIA_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.tiff': 'image/tiff', '.tif': 'image/tiff', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.wma': 'audio/x-ms-wma'
}

function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null
  let start: number
  let end: number
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return null
  }
  return { start, end: Math.min(end, size - 1) }
}

// Navigation hardening: deny any top-level navigation away from the app's own
// origin (file:// in prod, the dev-server URL, or our self-built data: pages),
// and deny window.open from non-control windows. The app never navigates
// top-level or opens child windows, so this only blocks a hijacked renderer
// from pivoting to a remote origin while still holding the privileged preload.
function isAllowedNavigation(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl && url.startsWith(devUrl)) return true
  // data: is intentionally NOT a permitted navigation target: the overlay/music
  // windows load their data: page as the INITIAL load (not via will-navigate), so
  // denying data: here closes an XSS-via-navigation vector without breaking them.
  return url.startsWith('file://')
}

app.whenReady().then(() => {
  initDiagnosticLog()
  diagnosticLog('display', JSON.stringify(screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    size: d.size,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
    internal: d.internal
  }))))

  const isPresentationRendererUrl = (url: string): boolean => {
    try {
      const current = new URL(url)
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      if (devUrl) {
        const expected = new URL(`${devUrl.replace(/\/$/, '')}/presentation.html`)
        return current.origin === expected.origin && current.pathname === expected.pathname
      }
      return current.href === pathToFileURL(join(__dirname, '../renderer/presentation.html')).href
    } catch {
      return false
    }
  }

  const isTrustedMediaRequester = (contents: Electron.WebContents | null): boolean => {
    if (!contents || contents.isDestroyed()) return false
    return (
      contents.id === presentationWindow?.webContents.id &&
      isPresentationRendererUrl(contents.getURL())
    )
  }

  // Default-deny remains in place for every permission except media requested
  // by the exact local presentation renderer. It is the sole long-lived owner
  // of UVC/USB capture devices; the control renderer never opens camera/mic.
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    const allowed = permission === 'media' && isTrustedMediaRequester(contents)
    diagnosticLog('capture', `permission check=${permission} allowed=${allowed} wc=${contents?.id ?? '-'}`)
    return allowed
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = permission === 'media' && isTrustedMediaRequester(contents)
    const mediaTypes = permission === 'media' && 'mediaTypes' in details
      ? details.mediaTypes?.join(',') || '-'
      : '-'
    diagnosticLog(
      'capture',
      `permission request=${permission} mediaTypes=${mediaTypes} allowed=${allowed} wc=${contents?.id ?? '-'}`
    )
    callback(allowed)
  })
  // Serve local media for webSecurity:true renderers. The renderer references
  // files as pdm-media://file/<encodeURIComponent(absPath)>; we decode, gate by
  // media extension, and serve it with explicit byte-range support. Forwarding
  // to a fresh file:// net.fetch dropped the original Request.Range header:
  // small MP4s happened to buffer fully, but interrupted large MP4s failed on
  // A→B→A reopen with MEDIA_ERR_SRC_NOT_SUPPORTED.
  protocol.handle('pdm-media', async (request) => {
    try {
      const filePath = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      if (!MEDIA_EXTENSIONS.has(ext)) {
        diagnosticLog('media', `blocked request url=${request.url} ext=${ext}`)
        return new Response('forbidden', { status: 403 })
      }
      // Paths (including UNC network shares) are served as-is — the app must open
      // media from network drives. Residual SSRF/arbitrary-read risk is ACCEPTED:
      // the renderer loads only local bundled code under a strict CSP (no
      // remote-content / XSS vector to forge a pdm-media request), and the
      // read-file IPC is already a broader arbitrary-read primitive. Tighten via
      // library-root confinement if that threat model changes.
      const fileStats = await stat(filePath)
      if (!fileStats.isFile()) return new Response('not found', { status: 404 })
      const size = fileStats.size
      const rangeHeader = request.headers.get('range')
      const range = rangeHeader ? parseByteRange(rangeHeader, size) : null
      if (rangeHeader && !range) {
        diagnosticLog('media', `invalid range=${rangeHeader} size=${size} file=${filePath}`)
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }
        })
      }

      const start = range?.start ?? 0
      const end = range?.end ?? Math.max(0, size - 1)
      const contentLength = size === 0 ? 0 : end - start + 1
      const headers: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(contentLength),
        'Content-Type': MEDIA_MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

      if (VIDEO_EXTENSIONS.has(ext)) {
        diagnosticLog('media', `serve method=${request.method} status=${range ? 206 : 200} range=${rangeHeader || '-'} bytes=${start}-${end}/${size} file=${filePath}`)
      }
      if (request.method === 'HEAD' || size === 0) {
        return new Response(null, { status: range ? 206 : 200, headers })
      }

      const fileStream = createReadStream(filePath, { start, end })
      const abortStream = (): void => fileStream.destroy()
      request.signal.addEventListener('abort', abortStream, { once: true })
      fileStream.once('close', () => request.signal.removeEventListener('abort', abortStream))
      const body = Readable.toWeb(fileStream) as unknown as BodyInit
      return new Response(body, { status: range ? 206 : 200, headers })
    } catch (error) {
      diagnosticLog('media', `request failed url=${request.url} ${formatDiagnosticError(error)}`)
      return new Response('not found', { status: 404 })
    }
  })

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => { if (!isAllowedNavigation(url)) e.preventDefault() })
    contents.on('will-redirect', (e, url) => { if (!isAllowedNavigation(url)) e.preventDefault() })
    // Deny window.open by default. The control window installs its own handler
    // (with an http/https/mailto allow-list) that overrides this for itself.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Permission policy is installed once on defaultSession above. It allows
    // only media for the two trusted app renderers and denies everything else.
  })

  // Ensure extended display mode on startup if external monitor is connected
  if (process.platform === 'win32') {
    const displays = screen.getAllDisplays()
    if (displays.length > 1) {
      ensureExtendDisplayMode()
    }
  }

  createWindows()
  prewarmPresentationWindow()
  pptDaemon.warmup()
  nativeWindowDaemon.warmup()

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

app.on('before-quit', (event) => {
  if (quitCleanupComplete) return
  event.preventDefault()
  if (quitCleanupStarted) return

  quitCleanupStarted = true
  diagnosticLog('shutdown', 'waiting for PowerPoint and window-enumerator cleanup')
  void Promise.allSettled([
    pptDaemon.shutdown(),
    nativeWindowDaemon.shutdown()
  ])
    .then((results) => {
      if (results[0].status === 'rejected') {
        diagnosticLog('shutdown', `PowerPoint cleanup failed: ${formatDiagnosticError(results[0].reason)}`)
      }
      if (results[1].status === 'rejected') {
        diagnosticLog('shutdown', `Window enumerator cleanup failed: ${formatDiagnosticError(results[1].reason)}`)
      }
    })
    .finally(() => {
      quitCleanupComplete = true
      diagnosticLog('shutdown', 'helper cleanup complete')
      app.quit()
    })
})
