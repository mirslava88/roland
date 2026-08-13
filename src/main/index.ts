import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, shell, desktopCapturer, protocol, session, powerMonitor, crashReporter } from 'electron'
import type { DesktopCapturerSource, Display } from 'electron'
import {
  createAuxiliaryWindow,
  createControlWindow,
  createPresentationWindow,
  createOverlayWindow,
  createMusicPlayerWindow
} from './windows'
import type { AuxiliaryWindowRole } from './windows'
import { ChildProcess, spawn } from 'child_process'
import { writeFileSync, unlinkSync, existsSync, createReadStream, readFileSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { Readable } from 'stream'
import { tmpdir } from 'os'
import { registerIpcHandlers, closeAllExternalFiles } from './ipc-handlers'
import { showAllTaskbars } from './taskbar-manager'
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
const auxiliaryWindows = new Map<number, {
  role: AuxiliaryWindowRole
  window: BrowserWindow
}>()
const auxiliaryLastMessages = new Map<AuxiliaryWindowRole, Map<string, unknown[]>>()
const programMirrorHolds = new Map<number, {
  transitionId: string
  displayId: number
  window: BrowserWindow
}>()
const programMirrorHoldIntents = new Map<number, {
  transitionId: string
  revision: number
}>()
let programMirrorHoldRevision = 0
let overlayWindow: BrowserWindow | null = null
let wpfTimerProcess: ChildProcess | null = null // WPF timer overlay for PPTX
let wpfTimerDisplayKey: string | null = null
let wpfTimerDisplayId: number | null = null
let lastWpfTimerData: Record<string, unknown> = {}
let wpfTimerPositionRevision = 0
let wpfTimerMirrorSyncTimer: NodeJS.Timeout | null = null
let lastWpfTimerMirrorSignature = ''
const wpfTimerDataFile = join(tmpdir(), 'roland-timer-data.json')
let musicPlayerWindow: BrowserWindow | null = null
let activeContentType: string | null = null // tracks what's on the external display
let timerActive = false // whether timer overlay is currently shown
let presentationWindowReady = false
let presentationWindowRequestedVisible = false
let presentationDisplayId: number | null = null
let overlayDisplayId: number | null = null
const presentationReadyWaiters = new Set<() => void>()
let overlayZOrderGuard: NodeJS.Timeout | null = null
let overlayPlacement: 'cover' | 'underlay' = 'cover'
let displayMetricsSyncTimer: NodeJS.Timeout | null = null
let quitCleanupStarted = false
let quitCleanupComplete = false
let shutdownTrigger = 'unknown'
let controlRendererRecoveryAttempts = 0
let controlRendererLastRecoveryAt = 0
const nativeDesktopSourceRegistry = new Map<string, NativeDesktopSourceRegistryEntry>()
const nativeAppIconCache = new Map<string, Promise<string | undefined>>()
interface BrowserFullscreenConsumer {
  sourceKey: string
  /** Distinguishes a stale prepare rollback from this renderer's latest use. */
  token: symbol
}

const fullscreenBrowserWindows = new Map<string, {
  sourceKey: string
  processName: string
  pid: number
  threadId: number
  consumers: Map<number, BrowserFullscreenConsumer>
}>()
let browserFullscreenOperationTail: Promise<void> = Promise.resolve()
let lastDesktopWindowInventorySignature = ''

async function withBrowserFullscreenLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = browserFullscreenOperationTail
  let unlock!: () => void
  browserFullscreenOperationTail = new Promise<void>((resolve) => { unlock = resolve })
  await previous
  try {
    return await operation()
  } finally {
    unlock()
  }
}

function sendToAuxiliaryRole(
  role: AuxiliaryWindowRole,
  channel: string,
  ...args: unknown[]
): void {
  let roleMessages = auxiliaryLastMessages.get(role)
  if (!roleMessages) {
    roleMessages = new Map()
    auxiliaryLastMessages.set(role, roleMessages)
  }
  roleMessages.set(channel, args)
  for (const entry of auxiliaryWindows.values()) {
    if (entry.role === role && !entry.window.isDestroyed()) {
      entry.window.webContents.send(channel, ...args)
    }
  }
}

async function armProgramMirrorHold(
  displayId: number,
  win: BrowserWindow,
  transitionId: string,
  revision: number,
  deadline: number
): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false
  const senderId = win.webContents.id
  const startedAt = Date.now()
  try {
    // The renderer-side generation closes A -> B races even if capturePage for
    // A resolves after B has already started.
    await win.webContents.executeJavaScript(`(() => {
      const next = { id: ${JSON.stringify(transitionId)}, revision: ${revision} };
      const current = window.__pdmProgramMirrorHoldIntent;
      if (!current || Number(current.revision || 0) <= next.revision) {
        window.__pdmProgramMirrorHoldIntent = next;
      }
    })()`)
    const frame = await win.webContents.capturePage()
    const currentIntent = programMirrorHoldIntents.get(senderId)
    if (
      Date.now() > deadline ||
      currentIntent?.transitionId !== transitionId ||
      currentIntent.revision !== revision ||
      frame.isEmpty() ||
      win.isDestroyed() ||
      win.webContents.isDestroyed()
    ) return false
    const dataUrl = `data:image/png;base64,${frame.toPNG().toString('base64')}`
    if (Date.now() > deadline) return false
    const armed = await win.webContents.executeJavaScript(`(async () => {
      const transitionId = ${JSON.stringify(transitionId)};
      const revision = ${revision};
      const deadline = ${deadline};
      const elementId = 'pdm-program-mirror-hold';
      const currentIntent = () => window.__pdmProgramMirrorHoldIntent;
      const isCurrent = () => {
        const intent = currentIntent();
        return Date.now() <= deadline && intent &&
          intent.id === transitionId && Number(intent.revision) === revision;
      };
      if (!isCurrent()) return false;
      const image = new Image();
      image.id = elementId + '-pending-' + revision;
      image.alt = '';
      image.draggable = false;
      image.src = ${JSON.stringify(dataUrl)};
      try { await image.decode(); } catch { return false; }
      if (!isCurrent()) return false;
      image.dataset.transitionId = transitionId;
      image.style.cssText = [
        'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
        'max-width:none', 'max-height:none', 'object-fit:fill',
        'background:#000', 'z-index:2147483647', 'pointer-events:none',
        'user-select:none'
      ].join(';');
      document.body.appendChild(image);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!isCurrent() || !image.isConnected) {
        image.remove();
        return false;
      }
      const previous = document.getElementById(elementId);
      if (previous && previous !== image) previous.remove();
      image.id = elementId;
      return true;
    })()`)
    const latestIntent = programMirrorHoldIntents.get(senderId)
    if (
      armed !== true ||
      win.isDestroyed() ||
      latestIntent?.transitionId !== transitionId ||
      latestIntent.revision !== revision
    ) {
      if (armed === true && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        void win.webContents.executeJavaScript(`(() => {
          const image = document.getElementById('pdm-program-mirror-hold');
          if (image?.dataset.transitionId === ${JSON.stringify(transitionId)}) image.remove();
        })()`)
      }
      return false
    }
    programMirrorHolds.set(senderId, { transitionId, displayId, window: win })
    diagnosticLog(
      'display',
      `program mirror hold armed transition=${transitionId} display=${displayId} ` +
      `wc=${win.webContents.id} dur=${Date.now() - startedAt}ms`
    )
    return true
  } catch (error) {
    diagnosticLog(
      'display',
      `program mirror hold failed transition=${transitionId} display=${displayId} ` +
      `error=${formatDiagnosticError(error)}`
    )
    return false
  }
}

async function removeProgramMirrorHold(
  senderId: number,
  transitionId: string
): Promise<boolean> {
  const hold = programMirrorHolds.get(senderId)
  if (!hold || hold.transitionId !== transitionId) return false
  const win = hold.window
  try {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      await win.webContents.executeJavaScript(`(() => {
        const image = document.getElementById('pdm-program-mirror-hold');
        if (!image || image.dataset.transitionId !== ${JSON.stringify(transitionId)}) return false;
        image.remove();
        return true;
      })()`)
    }
  } catch (error) {
    diagnosticLog(
      'display',
      `program mirror hold remove failed transition=${transitionId} display=${hold.displayId} ` +
      `error=${formatDiagnosticError(error)}`
    )
    return false
  }
  if (programMirrorHolds.get(senderId)?.transitionId === transitionId) {
    programMirrorHolds.delete(senderId)
  }
  if (programMirrorHoldIntents.get(senderId)?.transitionId === transitionId) {
    programMirrorHoldIntents.delete(senderId)
  }
  diagnosticLog(
    'display',
    `program mirror hold released transition=${transitionId} display=${hold.displayId} wc=${senderId}`
  )
  return true
}

function getWpfTimerStateFile(): string {
  return join(app.getPath('userData'), 'timer-overlay-state.json')
}

let lastGoodWpfTimerLayout = { x: 0.976, y: 0.96, scale: 1 }

function readWpfTimerLayout(): { x: number; y: number; scale: number } {
  try {
    const raw = JSON.parse(readFileSync(getWpfTimerStateFile(), 'utf8')) as {
      x?: unknown
      y?: unknown
      scale?: unknown
    }
    lastGoodWpfTimerLayout = {
      x: typeof raw.x === 'number' ? Math.max(0, Math.min(1, raw.x)) : 0.976,
      y: typeof raw.y === 'number' ? Math.max(0, Math.min(1, raw.y)) : 0.96,
      scale: typeof raw.scale === 'number' ? Math.max(0.5, Math.min(8, raw.scale)) : 1
    }
    return lastGoodWpfTimerLayout
  } catch {
    // WPF replaces this file while the mirror sync polls it. Keep the last
    // valid layout instead of flashing the timer at its defaults for one tick.
    return lastGoodWpfTimerLayout
  }
}

function broadcastWpfTimerToMirrors(force = false): void {
  const payload = {
    visible: timerActive && Number(lastWpfTimerData.duration || 0) > 0,
    remaining: Number(lastWpfTimerData.remaining || 0),
    running: lastWpfTimerData.running === true,
    duration: Number(lastWpfTimerData.duration || 0),
    textColor: String(lastWpfTimerData.textColor || '#ffffff'),
    warningTextColor: String(lastWpfTimerData.warningTextColor || '#facc15'),
    overtimeTextColor: String(lastWpfTimerData.overtimeTextColor || '#ef4444'),
    textOpacity: Math.max(0.1, Math.min(1, Number(lastWpfTimerData.textOpacity || 1))),
    ...readWpfTimerLayout()
  }
  const signature = JSON.stringify(payload)
  if (!force && signature === lastWpfTimerMirrorSignature) return
  lastWpfTimerMirrorSignature = signature
  sendToAuxiliaryRole('mirror', 'program-timer-overlay', payload)
}

function startWpfTimerMirrorSync(): void {
  if (wpfTimerMirrorSyncTimer) clearInterval(wpfTimerMirrorSyncTimer)
  broadcastWpfTimerToMirrors(true)
  wpfTimerMirrorSyncTimer = setInterval(() => broadcastWpfTimerToMirrors(), 250)
}

function stopWpfTimerMirrorSync(): void {
  if (wpfTimerMirrorSyncTimer) clearInterval(wpfTimerMirrorSyncTimer)
  wpfTimerMirrorSyncTimer = null
  lastWpfTimerMirrorSignature = ''
  broadcastWpfTimerToMirrors(true)
}

function closeAuxiliaryWindow(
  role: AuxiliaryWindowRole,
  displayId?: number,
  notify = false
): void {
  const entries = [...auxiliaryWindows.entries()].filter(([id, entry]) => (
    entry.role === role && (displayId === undefined || id === displayId)
  ))
  for (const [id, entry] of entries) {
    const consumerId = entry.window.webContents.id
    programMirrorHolds.delete(consumerId)
    programMirrorHoldIntents.delete(consumerId)
    // React cleanup is best-effort during window teardown. Release the native
    // browser lease from main as well, while this renderer identity is known.
    void releaseBrowserFullscreenWindows(undefined, false, consumerId)
    auxiliaryWindows.delete(id)
    if (!entry.window.isDestroyed()) entry.window.close()
    if (notify && controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('auxiliary-window-closed', { role, displayId: id })
    }
  }
}

const BROWSER_PROCESS_NAMES = new Set([
  'chrome',
  'chromium',
  'msedge',
  'firefox',
  'librewolf',
  'waterfox',
  'brave',
  'vivaldi',
  'opera',
  'opera_gx',
  'browser', // Yandex Browser
  'arc'
])

function isBrowserProcess(processName: string): boolean {
  return BROWSER_PROCESS_NAMES.has(processName.trim().replace(/\.exe$/i, '').toLowerCase())
}

type BrowserFullscreenEntry = (typeof fullscreenBrowserWindows extends Map<string, infer Entry>
  ? Entry
  : never)

async function addBrowserFullscreenConsumer(
  hwnd: string,
  pid: number,
  threadId: number,
  processName: string,
  sourceKey: string,
  consumerId: number,
  consumerToken: symbol
): Promise<{
  fullscreen: import('./native-window-daemon').NativeWindowFullscreenResult
  consumerAdded: boolean
}> {
  return withBrowserFullscreenLock(async () => {
    let fullscreen: import('./native-window-daemon').NativeWindowFullscreenResult
    try {
      fullscreen = await nativeWindowDaemon.ensureBrowserFullscreen(hwnd, pid, threadId)
    } catch (error) {
      // A timeout can happen after the helper captured WINDOWPLACEMENT. Ensure
      // is idempotent for an owned HWND, so retry while still holding the same
      // lock before any release is allowed to run.
      diagnosticLog('capture', `browser fullscreen ensure retry hwnd=${hwnd} ${formatDiagnosticError(error)}`)
      fullscreen = await nativeWindowDaemon.ensureBrowserFullscreen(hwnd, pid, threadId)
    }
      if (!fullscreen.ownershipHeld) return { fullscreen, consumerAdded: false }

    const existingOwnership = fullscreenBrowserWindows.get(hwnd)
    const sameNativeWindow = existingOwnership?.pid === pid &&
      existingOwnership.threadId === threadId
    const consumers = sameNativeWindow
      ? existingOwnership.consumers
      : new Map<number, BrowserFullscreenConsumer>()
    const existingConsumer = consumers.get(consumerId)
    // Repeated prepare of a stream already used by this renderer is
    // idempotent. Preserve its acquisition token so a failed retry cannot
    // release the still-live stream.
    if (existingConsumer?.sourceKey === sourceKey) {
      return { fullscreen, consumerAdded: false }
    }
    if (existingConsumer) {
      // One renderer owns one live desktop stream. Moving that renderer to a
      // different HWND is finalized by its normal release-after-transition;
      // never silently overwrite an unrelated acquisition on the same HWND.
      diagnosticLog(
        'capture',
        `browser consumer source updated wc=${consumerId} from=${existingConsumer.sourceKey} to=${sourceKey}`
      )
    }
    consumers.set(consumerId, { sourceKey, token: consumerToken })
    fullscreenBrowserWindows.set(hwnd, {
      sourceKey,
      processName,
      pid,
      threadId,
      consumers
    })
    return { fullscreen, consumerAdded: true }
  })
}

async function exitTrackedBrowserFullscreenLocked(
  hwnd: string,
  entry: BrowserFullscreenEntry,
  returnFocusHwnd?: string
): Promise<boolean> {
  try {
    const result = await nativeWindowDaemon.exitBrowserFullscreen(
      hwnd,
      entry.pid,
      entry.threadId,
      returnFocusHwnd
    )
    diagnosticLog(
      'capture',
      `browser fullscreen exit hwnd=${hwnd} process=${entry.processName} ` +
      `wasFullscreen=${result.wasFullscreen} requested=${result.requested} ` +
      `fullscreen=${result.fullscreen} foreground=${result.foreground} ` +
      `identityMatched=${result.identityMatched} ownershipHeld=${result.ownershipHeld} ` +
      `ownershipMissing=${result.ownershipMissing} placementRestored=${result.placementRestored}`
    )
    if (!result.valid || !result.identityMatched || result.ownershipMissing || result.placementRestored) {
      if (fullscreenBrowserWindows.get(hwnd) === entry) fullscreenBrowserWindows.delete(hwnd)
      return true
    }
  } catch (error) {
    diagnosticLog('capture', `browser fullscreen exit failed hwnd=${hwnd} ${formatDiagnosticError(error)}`)
  }
  return false
}

async function releaseBrowserFullscreenWindows(
  keepSourceKey?: string,
  restoreControlFocus = true,
  consumerId?: number,
  releaseSourceKey?: string,
  consumerToken?: symbol
): Promise<{ released: number; remaining: number }> {
  return withBrowserFullscreenLock(async () => {
    let released = 0
    const returnFocusHwnd = restoreControlFocus && controlWindow && !controlWindow.isDestroyed()
      ? browserWindowNativeHwnd(controlWindow)
      : undefined
    for (const [hwnd, entry] of [...fullscreenBrowserWindows]) {
      if (consumerId !== undefined) {
        const consumer = entry.consumers.get(consumerId)
        if (!consumer) continue
        if (consumerToken && consumer.token !== consumerToken) continue
        if (keepSourceKey && consumer.sourceKey === keepSourceKey) continue
        if (releaseSourceKey && consumer.sourceKey !== releaseSourceKey) continue
        if (entry.consumers.size > 1) {
          entry.consumers.delete(consumerId)
          continue
        }
        // Keep the last consumer as a retry tombstone until native restore
        // succeeds. A transient Windows focus refusal must not make cleanup
        // impossible on the next renderer/destroyed notification.
      } else {
        // Shutdown is the only caller without a consumer. No renderer can keep
        // the ownership alive once PDM itself is closing.
        entry.consumers.clear()
      }
      if (await exitTrackedBrowserFullscreenLocked(hwnd, entry, returnFocusHwnd)) released++
    }

    if (released > 0 && restoreControlFocus && controlWindow && !controlWindow.isDestroyed()) {
      try {
        if (controlWindow.isMinimized()) controlWindow.restore()
        controlWindow.show()
        controlWindow.focus()
      } catch { /* window may be closing */ }
    }
    return { released, remaining: fullscreenBrowserWindows.size }
  })
}

async function rollbackBrowserFullscreenPrepare(
  hwnd: string | null,
  pid: number | null,
  threadId: number | null,
  consumerId: number,
  consumerToken: symbol,
  ensureAttempted: boolean,
  restoreControlFocus = true
): Promise<void> {
  if (!hwnd || !pid || !threadId || !ensureAttempted) return
  await withBrowserFullscreenLock(async () => {
    const entry = fullscreenBrowserWindows.get(hwnd)
    if (entry) {
      const consumer = entry.consumers.get(consumerId)
      // A newer prepare by the same renderer replaced this acquisition. Its
      // stream is still entitled to keep the shared browser fullscreen.
      if (!consumer || consumer.token !== consumerToken) return
      if (entry.consumers.size > 1) {
        entry.consumers.delete(consumerId)
        return
      }
      const returnFocusHwnd = restoreControlFocus && controlWindow && !controlWindow.isDestroyed()
        ? browserWindowNativeHwnd(controlWindow)
        : undefined
      await exitTrackedBrowserFullscreenLocked(hwnd, entry, returnFocusHwnd)
      return
    }

    // The helper may have captured placement before its response was lost or
    // the renderer disappeared. Exit is safe: without a matching native
    // ownership snapshot it is a no-op and never sends F11 blindly.
    try {
      const result = await nativeWindowDaemon.exitBrowserFullscreen(
        hwnd,
        pid,
        threadId,
        restoreControlFocus && controlWindow && !controlWindow.isDestroyed()
          ? browserWindowNativeHwnd(controlWindow)
          : undefined
      )
      diagnosticLog(
        'capture',
        `browser prepare rollback untracked hwnd=${hwnd} identityMatched=${result.identityMatched} ` +
        `ownershipMissing=${result.ownershipMissing} placementRestored=${result.placementRestored}`
      )
    } catch (error) {
      diagnosticLog('capture', `browser prepare rollback failed hwnd=${hwnd} ${formatDiagnosticError(error)}`)
    }
  })
}

// Live capture sources must start rendering even though the prewarmed output
// window never receives a mouse click of its own. This affects only media
// playback policy; camera/microphone access is still guarded explicitly below.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Keep native minidumps locally. Nothing is uploaded: the dump is available
// alongside Electron's crash data if a future main/GPU/renderer process dies
// before the text logger can record an exception.
crashReporter.start({
  productName: 'Presentation Display Manager',
  uploadToServer: false,
  rateLimit: false,
  compress: false,
  globalExtra: { appVersion: app.getVersion() }
})

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
  presentationDisplayId = display.id
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
      presentationDisplayId = externalDisplay.id
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
  const displayKey = `${displayBounds.x},${displayBounds.y},${displayBounds.width},${displayBounds.height}`
  const timerProcessAlive = !!wpfTimerProcess &&
    !wpfTimerProcess.killed &&
    wpfTimerProcess.exitCode === null &&
    wpfTimerProcess.signalCode === null
  if (timerProcessAlive) {
    const changed = wpfTimerDisplayKey !== displayKey
    wpfTimerDisplayKey = displayKey
    wpfTimerPositionRevision++
    sendToWpfTimer({
      cmd: 'show',
      displayX: displayBounds.x,
      displayY: displayBounds.y,
      displayWidth: displayBounds.width,
      displayHeight: displayBounds.height,
      windowPositionRevision: wpfTimerPositionRevision
    })
    diagnosticLog('window', `timer overlay ${changed ? 'relocated' : 'reanchored'} physicalBounds=${displayKey}`)
    return
  }
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
  const timerStateFile = getWpfTimerStateFile()
  wpfTimerDisplayKey = displayKey
  wpfTimerPositionRevision++
  sendToWpfTimer({
    cmd: 'show',
    displayX: displayBounds.x,
    displayY: displayBounds.y,
    displayWidth: displayBounds.width,
    displayHeight: displayBounds.height,
    windowPositionRevision: wpfTimerPositionRevision
  })
  diagnosticLog('window', `timer overlay spawn physicalBounds=${displayKey}`)
  const timerProcess = spawn('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-STA',
    '-File', timerScript,
    '-DisplayX', String(displayBounds.x),
    '-DisplayY', String(displayBounds.y),
    '-DisplayWidth', String(displayBounds.width),
    '-DisplayHeight', String(displayBounds.height),
    '-DataFile', wpfTimerDataFile,
    '-StateFile', timerStateFile
  ], { stdio: 'ignore' })
  wpfTimerProcess = timerProcess
  timerProcess.on('exit', () => {
    if (wpfTimerProcess === timerProcess) {
      wpfTimerProcess = null
      wpfTimerDisplayKey = null
    }
  })
}

function hideWpfTimer(destroy = false): void {
  if (wpfTimerMirrorSyncTimer) clearInterval(wpfTimerMirrorSyncTimer)
  wpfTimerMirrorSyncTimer = null
  if (!destroy) {
    const timerProcessAlive = !!wpfTimerProcess &&
      !wpfTimerProcess.killed &&
      wpfTimerProcess.exitCode === null &&
      wpfTimerProcess.signalCode === null
    if (timerProcessAlive) {
      // Keep the exact same HWND, measured size and per-monitor DPI context.
      // Recreating a SizeToContent WPF window on every Stop made its initial
      // placeholder width overwrite the operator's saved pixel position.
      sendToWpfTimer({ cmd: 'hide' })
      diagnosticLog(
        'window',
        `timer overlay parked display=${wpfTimerDisplayId ?? 'unknown'} key=${wpfTimerDisplayKey ?? 'unknown'}`
      )
    }
    return
  }
  const closingProcess = wpfTimerProcess
  wpfTimerProcess = null
  wpfTimerDisplayKey = null
  wpfTimerDisplayId = null
  try { writeFileSync(wpfTimerDataFile, JSON.stringify({ cmd: 'exit' })) } catch {}
  setTimeout(() => {
    if (closingProcess && !closingProcess.killed) {
      closingProcess.kill()
    }
    if (!wpfTimerProcess) {
      try { unlinkSync(wpfTimerDataFile) } catch {}
    }
  }, 500)
}

function sendToWpfTimer(data: unknown): void {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    lastWpfTimerData = { ...lastWpfTimerData, ...(data as Record<string, unknown>) }
  }
  try { writeFileSync(wpfTimerDataFile, JSON.stringify(lastWpfTimerData)) } catch {}
}


function nativeSourceKey(window: Pick<NativeTopLevelWindow, 'hwnd' | 'pid'>): string {
  return `native-window:${window.hwnd}:${window.pid}`
}

function browserWindowNativeHwnd(window: BrowserWindow): string | undefined {
  if (window.isDestroyed()) return undefined
  try {
    const handle = window.getNativeWindowHandle()
    if (handle.length >= 8) return handle.readBigUInt64LE(0).toString(10)
    if (handle.length >= 4) return String(handle.readUInt32LE(0))
  } catch { /* window may be closing */ }
  try {
    return hwndFromCaptureSourceId(window.getMediaSourceId())
  } catch {
    return undefined
  }
}

function getOwnWindowHwnds(): Set<string> {
  const handles = new Set<string>()
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const nativeHwnd = browserWindowNativeHwnd(window)
    if (nativeHwnd) handles.add(nativeHwnd)
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
  const thisControlWindow = controlWindow
  let allowControlWindowClose = false
  let closeConfirmationOpen = false
  registerIpcHandlers(controlWindow, () => presentationWindow)

  const discardPreparedWorkspaceRecovery = async (): Promise<void> => {
    if (thisControlWindow.isDestroyed()) return
    try {
      const removed = await thisControlWindow.webContents.executeJavaScript(`(() => {
        const key = 'roland-app-preferences'
        const raw = localStorage.getItem(key)
        if (!raw) return 0
        const snapshot = JSON.parse(raw)
        const state = snapshot && typeof snapshot.state === 'object' ? snapshot.state : null
        if (!state) return 0
        const workspaceKeys = [
          'channels', 'channelIds', 'channelGridSize', 'currentChannelPage',
          'selectedChannel', 'captureSources', 'slidePositions'
        ]
        let removedCount = 0
        for (const field of workspaceKeys) {
          if (Object.prototype.hasOwnProperty.call(state, field)) {
            delete state[field]
            removedCount++
          }
        }
        localStorage.setItem(key, JSON.stringify(snapshot))
        return removedCount
      })()`)
      diagnosticLog('workspace-recovery', `operator close discarded prepared workspace fields=${removed}`)
    } catch (error) {
      // Never block an explicitly confirmed exit. The failure remains in the
      // diagnostic log so it can be investigated if recovery data reappears.
      diagnosticLog(
        'workspace-recovery',
        `operator close discard failed ${formatDiagnosticError(error)}`
      )
    }
  }

  ipcMain.handle('open-auxiliary-window', async (
    _event,
    role: AuxiliaryWindowRole,
    displayId: number
  ) => {
    if (!(['mirror', 'speaker', 'info', 'timer', 'event-timer', 'backdrop'] as AuxiliaryWindowRole[]).includes(role)) {
      return { success: false, error: 'Unknown auxiliary display role' }
    }
    const primary = screen.getPrimaryDisplay()
    const displays = screen.getAllDisplays()
    const target = displays.find((display) => display.id === displayId)
    if (!target || target.id === primary.id) {
      return {
        success: false,
        error: 'Назначенный внешний монитор не подключён'
      }
    }

    const existing = auxiliaryWindows.get(target.id)
    if (existing && (existing.role !== role || existing.window.isDestroyed())) {
      closeAuxiliaryWindow(existing.role, target.id)
    }

    let win = auxiliaryWindows.get(target.id)?.window ?? null
    if (!win || win.isDestroyed()) {
      win = createAuxiliaryWindow(target, role)
      auxiliaryWindows.set(target.id, { role, window: win })
      const auxiliaryConsumerId = win.webContents.id
      win.webContents.once('destroyed', () => {
        programMirrorHolds.delete(auxiliaryConsumerId)
        programMirrorHoldIntents.delete(auxiliaryConsumerId)
        void releaseBrowserFullscreenWindows(undefined, false, auxiliaryConsumerId)
      })
      win.on('closed', () => {
        if (auxiliaryWindows.get(target.id)?.window === win) {
          auxiliaryWindows.delete(target.id)
        }
      })
    }

    if (win.webContents.isLoading()) {
      await new Promise<void>((resolve) => {
        win!.webContents.once('did-finish-load', () => resolve())
      })
    }
    if (win.isDestroyed()) {
      return { success: false, error: 'Окно дисплея было закрыто во время запуска' }
    }
    for (const [channel, args] of auxiliaryLastMessages.get(role) ?? []) {
      win.webContents.send(channel, ...args)
    }
    // A fullscreen BrowserWindow cannot be reliably moved with setBounds on
    // Windows. Place it while windowed, then enter fullscreen on that monitor.
    // This is especially important when a Full HD display and an ultrawide
    // display are both connected: otherwise the renderer can inherit the
    // geometry of the wrong screen and size the live copy incorrectly.
    const actualBeforePlacement = win.getBounds()
    const alreadyPlaced = actualBeforePlacement.x === target.bounds.x &&
      actualBeforePlacement.y === target.bounds.y &&
      actualBeforePlacement.width === target.bounds.width &&
      actualBeforePlacement.height === target.bounds.height
    if (!alreadyPlaced || !win.isFullScreen()) {
      if (win.isFullScreen()) win.setFullScreen(false)
      win.setBounds(target.bounds)
      if (!win.isVisible()) win.showInactive()
      win.setFullScreen(true)
    } else if (!win.isVisible()) {
      win.showInactive()
    }
    win.setAlwaysOnTop(false)
    diagnosticLog(
      'display',
      `auxiliary open role=${role} display=${target.id} requested=${JSON.stringify(target.bounds)} ` +
      `actual=${JSON.stringify(win.getBounds())} fullscreen=${win.isFullScreen()}`
    )
    return { success: true }
  })

  ipcMain.handle('close-auxiliary-window', (
    _event,
    role: AuxiliaryWindowRole,
    displayId?: number
  ) => {
    if (!(['mirror', 'speaker', 'info', 'timer', 'event-timer', 'backdrop'] as AuxiliaryWindowRole[]).includes(role)) return
    closeAuxiliaryWindow(role, displayId)
  })

  ipcMain.on('send-to-auxiliary', (
    _event,
    role: AuxiliaryWindowRole,
    channel: string,
    ...args: unknown[]
  ) => {
    sendToAuxiliaryRole(role, channel, ...args)
  })

  ipcMain.handle('freeze-program-mirrors', async (
    event,
    transitionId: string
  ): Promise<{ armed: number }> => {
    if (
      !controlWindow ||
      controlWindow.isDestroyed() ||
      event.sender.id !== controlWindow.webContents.id ||
      typeof transitionId !== 'string' ||
      transitionId.length < 1 ||
      transitionId.length > 100
    ) {
      return { armed: 0 }
    }
    const mirrors = [...auxiliaryWindows.entries()].filter(([, entry]) => (
      entry.role === 'mirror' &&
      !entry.window.isDestroyed() &&
      !entry.window.webContents.isDestroyed()
    ))
    const revision = ++programMirrorHoldRevision
    const deadline = Date.now() + 1000
    for (const [, entry] of mirrors) {
      programMirrorHoldIntents.set(entry.window.webContents.id, { transitionId, revision })
    }
    const results = await Promise.all(mirrors.map(async ([displayId, entry]) => {
      const arm = armProgramMirrorHold(displayId, entry.window, transitionId, revision, deadline)
      const remaining = Math.max(0, deadline - Date.now())
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining))
      return Promise.race([arm, timeout])
    }))
    const armed = results.filter(Boolean).length
    for (const [, entry] of mirrors) {
      const senderId = entry.window.webContents.id
      const intent = programMirrorHoldIntents.get(senderId)
      if (
        intent?.transitionId === transitionId &&
        intent.revision === revision &&
        programMirrorHolds.get(senderId)?.transitionId !== transitionId
      ) {
        programMirrorHoldIntents.delete(senderId)
      }
    }
    diagnosticLog(
      'display',
      `program mirror freeze complete transition=${transitionId} armed=${armed}/${mirrors.length}`
    )
    return { armed }
  })

  ipcMain.handle('complete-program-mirror-transition', async (
    event,
    transitionId: string
  ): Promise<{ released: number; remaining: number }> => {
    if (
      !controlWindow ||
      controlWindow.isDestroyed() ||
      event.sender.id !== controlWindow.webContents.id ||
      typeof transitionId !== 'string' ||
      transitionId.length < 1 ||
      transitionId.length > 100
    ) {
      return { released: 0, remaining: 0 }
    }
    const matching = [...programMirrorHolds.entries()].filter(([, hold]) => (
      hold.transitionId === transitionId &&
      !hold.window.isDestroyed() &&
      !hold.window.webContents.isDestroyed()
    ))
    for (const [senderId, hold] of matching) {
      hold.window.webContents.send('program-mirror-transition-complete', { transitionId })
      // Completion must never block the TAKE/navigation pipeline. Normally the
      // mirror drops the frozen frame as soon as the new target has painted.
      // This guard only prevents a dead/static capture stream or a lost IPC
      // event from leaving the previous slide pinned forever.
      setTimeout(() => {
        const current = programMirrorHolds.get(senderId)
        if (!current || current.transitionId !== transitionId) return
        diagnosticLog(
          'display',
          `program mirror hold watchdog transition=${transitionId} ` +
          `display=${current.displayId} wc=${senderId}`
        )
        void removeProgramMirrorHold(senderId, transitionId).then((released) => {
          if (released) return
          setTimeout(() => {
            if (programMirrorHolds.get(senderId)?.transitionId === transitionId) {
              void removeProgramMirrorHold(senderId, transitionId)
            }
          }, 200)
        })
      }, 2500)
    }
    diagnosticLog(
      'display',
      `program mirror transition notified id=${transitionId} mirrors=${matching.length}`
    )
    return { released: 0, remaining: matching.length }
  })

  ipcMain.handle('release-program-mirror-hold', async (
    event,
    transitionId: string
  ): Promise<boolean> => {
    if (typeof transitionId !== 'string' || transitionId.length < 1 || transitionId.length > 100) {
      return false
    }
    const trustedMirror = [...auxiliaryWindows.values()].some((entry) => (
      entry.role === 'mirror' &&
      !entry.window.isDestroyed() &&
      !entry.window.webContents.isDestroyed() &&
      entry.window.webContents.id === event.sender.id
    ))
    if (!trustedMirror) return false
    return removeProgramMirrorHold(event.sender.id, transitionId)
  })

  ipcMain.handle('get-screen-capture-source', async (
    event,
    displayId: number
  ): Promise<string | null> => {
    const trustedMirror = [...auxiliaryWindows.values()].some((entry) => (
      entry.role === 'mirror' &&
      !entry.window.isDestroyed() &&
      entry.window.webContents.id === event.sender.id
    ))
    if (!trustedMirror) {
      diagnosticLog('display', `mirror source denied wc=${event.sender.id}`)
      return null
    }
    const displays = screen.getAllDisplays()
    const target = displays.find((display) => display.id === displayId)
    if (!target) return null
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }
    })
    const source = sources.find((item) => item.display_id === String(target.id)) ||
      sources[displays.indexOf(target)] ||
      null
    return source?.id ?? null
  })

  controlWindow.on('query-session-end', () => {
    shutdownTrigger = 'windows-session-end'
    allowControlWindowClose = true
    diagnosticLog('lifecycle', 'Windows session end requested')
  })

  controlWindow.on('close', (event) => {
    if (allowControlWindowClose || quitCleanupStarted || quitCleanupComplete) {
      diagnosticLog(
        'lifecycle',
        `control window close accepted trigger=${shutdownTrigger} ` +
        `liveType=${activeContentType ?? 'none'} cleanupStarted=${quitCleanupStarted}`
      )
      return
    }

    event.preventDefault()
    diagnosticLog(
      'lifecycle',
      `control window close confirmation requested liveType=${activeContentType ?? 'none'}`
    )
    if (closeConfirmationOpen) return
    closeConfirmationOpen = true
    void dialog.showMessageBox(thisControlWindow, {
      type: 'warning',
      title: 'Закрыть PDM?',
      message: 'Закрыть Presentation Display Manager?',
      detail: 'Текущий эфир будет остановлен. Подготовленные каналы будут очищены. Они восстанавливаются только после аварийного завершения PDM.',
      buttons: ['Отмена', 'Закрыть PDM'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }).then(async ({ response }) => {
      closeConfirmationOpen = false
      if (response !== 1) {
        diagnosticLog('lifecycle', 'control window close canceled by operator')
        return
      }
      shutdownTrigger = 'operator-confirmed-close'
      await discardPreparedWorkspaceRecovery()
      allowControlWindowClose = true
      diagnosticLog('lifecycle', 'control window close confirmed by operator')
      if (!thisControlWindow.isDestroyed()) thisControlWindow.close()
    }).catch((error) => {
      closeConfirmationOpen = false
      diagnosticLog('lifecycle', `close confirmation failed ${formatDiagnosticError(error)}`)
    })
  })

  controlWindow.on('closed', () => {
    diagnosticLog('lifecycle', `control window closed trigger=${shutdownTrigger}`)
    controlWindow = null
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
    }
    presentationWindow = null
    for (const role of ['mirror', 'speaker', 'info', 'timer', 'event-timer', 'backdrop'] as AuxiliaryWindowRole[]) {
      closeAuxiliaryWindow(role)
    }
    hideWpfTimer(true)
    closeAllExternalFiles()
    if (musicPlayerWindow && !musicPlayerWindow.isDestroyed()) {
      musicPlayerWindow.close()
    }
    musicPlayerWindow = null
    globalShortcut.unregisterAll()
    app.quit()
  })

  thisControlWindow.webContents.on('unresponsive', () => {
    diagnosticLog('renderer-failure', `control renderer unresponsive wc=${thisControlWindow.webContents.id}`)
  })
  thisControlWindow.webContents.on('responsive', () => {
    diagnosticLog('renderer-failure', `control renderer responsive wc=${thisControlWindow.webContents.id}`)
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
    presentationDisplayId = targetDisplay.id

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

  // Reposition the persistent Chromium output without changing visibility or
  // z-order. The renderer stays warm underneath PowerPoint for seamless
  // switching, but the operator can change the primary program display while
  // it is parked. PDF/video must be moved to that same display before their
  // next frame is prepared, otherwise PowerPoint and Chromium diverge onto two
  // different monitors.
  ipcMain.handle('place-presentation-window', (_event, displayId?: number): boolean => {
    if (!presentationWindow || presentationWindow.isDestroyed()) return false

    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((display) => display.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((display) => display.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay
    presentationDisplayId = targetDisplay.id
    const currentBounds = presentationWindow.getBounds()
    const nextBounds = targetDisplay.bounds
    const changed =
      currentBounds.x !== nextBounds.x || currentBounds.y !== nextBounds.y ||
      currentBounds.width !== nextBounds.width || currentBounds.height !== nextBounds.height

    if (changed) {
      presentationWindow.setBounds(nextBounds)
      diagnosticLog(
        'window',
        `presentation output relocated display=${targetDisplay.id} ` +
        `from=${JSON.stringify(currentBounds)} to=${JSON.stringify(nextBounds)}`
      )
    }
    return true
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
    overlayDisplayId = targetDisplay.id

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
    const isInformationDisplay = [...auxiliaryWindows.values()].some((entry) => (
      entry.role === 'info' &&
      !entry.window.isDestroyed() &&
      entry.window.webContents.id === event.sender.id
    ))
    if (
      ((!controlWindow || controlWindow.isDestroyed() || event.sender.id !== controlWindow.webContents.id) &&
        !isInformationDisplay) ||
      typeof sourceKey !== 'string' ||
      sourceKey.length > 200
    ) {
      diagnosticLog('capture', `desktop source prepare denied wc=${event.sender.id}`)
      return { success: false, error: 'Источник окна недоступен.' }
    }

    let browserFullscreenHwnd: string | null = null
    let browserFullscreenOwned = false
    let browserPid: number | null = null
    let browserThreadId: number | null = null
    let browserEnsureAttempted = false
    let browserConsumerAdded = false
    const browserConsumerToken = Symbol(`desktop-prepare-${event.sender.id}`)
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
      const browserTarget = !!targetWindow && isBrowserProcess(targetWindow.processName)
      if (targetWindow && browserTarget) {
        // The native helper captures WINDOWPLACEMENT before it restores or
        // fullscreens the browser. That snapshot is applied when the source
        // leaves air, so Chromium cannot move its normal/maximized position to
        // the output monitor. Do not restore it separately before the snapshot.
        targetWasActivated = true
        browserFullscreenHwnd = targetWindow.hwnd
        browserPid = targetWindow.pid
        browserThreadId = targetWindow.threadId
        browserEnsureAttempted = true
        const browserAcquisition = await addBrowserFullscreenConsumer(
          targetWindow.hwnd,
          targetWindow.pid,
          targetWindow.threadId,
          targetWindow.processName,
          sourceKey,
          event.sender.id,
          browserConsumerToken
        )
        const fullscreen = browserAcquisition.fullscreen
        browserConsumerAdded = browserAcquisition.consumerAdded
        browserFullscreenOwned = fullscreen.ownershipHeld
        if (event.sender.isDestroyed()) {
          if (browserConsumerAdded) {
            await rollbackBrowserFullscreenPrepare(
              browserFullscreenHwnd,
              browserPid,
              browserThreadId,
              event.sender.id,
              browserConsumerToken,
              browserEnsureAttempted,
              false
            )
          }
          return { success: false, error: 'РћРєРЅРѕ РґРёСЃРїР»РµСЏ Р±С‹Р»Рѕ Р·Р°РєСЂС‹С‚Рѕ РІРѕ РІСЂРµРјСЏ РїРѕРґРіРѕС‚РѕРІРєРё.' }
        }
        diagnosticLog(
          'capture',
          `browser fullscreen hwnd=${targetWindow.hwnd} process=${targetWindow.processName} ` +
          `wasFullscreen=${fullscreen.wasFullscreen} ` +
          `requested=${fullscreen.requested} fullscreen=${fullscreen.fullscreen} foreground=${fullscreen.foreground} ` +
          `identityMatched=${fullscreen.identityMatched} ownershipHeld=${fullscreen.ownershipHeld}`
        )
        if (!fullscreen.fullscreen) {
          if (fullscreen.ownershipHeld && browserConsumerAdded) {
            await rollbackBrowserFullscreenPrepare(
              browserFullscreenHwnd,
              browserPid,
              browserThreadId,
              event.sender.id,
              browserConsumerToken,
              browserEnsureAttempted
            )
            browserFullscreenOwned = false
          }
          return {
            success: false,
            error: 'Браузер не успел перейти в полноэкранный режим. Повторите «В эфир».'
          }
        }
        // F11 changes the browser's native surface. Resolve Chromium's source
        // again only after the fullscreen transition has completed.
        electronSource = undefined
      }
      if (targetWindow && !browserTarget) {
        // TAKE is an explicit hand-off every time, not only while a window is
        // minimized. After the first TAKE the source remains valid in
        // desktopCapturer but usually sits behind PDM; skipping activation in
        // that state made the second TAKE appear to do nothing.
        const restored = await nativeWindowDaemon.restoreWindow(targetWindow.hwnd, true)
        targetWasActivated = true
        diagnosticLog(
          'capture',
          `activate window hwnd=${targetWindow.hwnd} requested=${restored.requested} ` +
          `minimized=${restored.minimized} activated=${restored.activated} foreground=${restored.foreground}`
        )
        // A restored HWND can acquire a new Chromium capture surface. A
        // merely covered window keeps the existing source and needs no wait.
        if (targetWindow.minimized) electronSource = undefined
      }
      if (!electronSource && targetWindow) {
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
        if (
          browserFullscreenHwnd && browserFullscreenOwned && browserConsumerAdded &&
          browserPid && browserThreadId
        ) {
          await rollbackBrowserFullscreenPrepare(
            browserFullscreenHwnd,
            browserPid,
            browserThreadId,
            event.sender.id,
            browserConsumerToken,
            browserEnsureAttempted
          )
          if (controlWindow && !controlWindow.isDestroyed()) controlWindow.focus()
        }
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
      if (browserFullscreenHwnd && browserConsumerAdded && browserPid && browserThreadId) {
        try {
          await rollbackBrowserFullscreenPrepare(
            browserFullscreenHwnd,
            browserPid,
            browserThreadId,
            event.sender.id,
            browserConsumerToken,
            browserEnsureAttempted
          )
          if (controlWindow && !controlWindow.isDestroyed()) controlWindow.focus()
        } catch { /* original prepare error is more useful */ }
      }
      diagnosticLog('capture', `desktop source prepare failed ${formatDiagnosticError(error)}`)
      return { success: false, error: `Не удалось подготовить окно: ${formatDiagnosticError(error)}` }
    }
  })

  ipcMain.handle('release-browser-fullscreen', async (
    event,
    keepSourceKey?: string
  ): Promise<{ released: number; remaining: number }> => {
    const isInformationDisplay = [...auxiliaryWindows.values()].some((entry) => (
      entry.role === 'info' &&
      !entry.window.isDestroyed() &&
      entry.window.webContents.id === event.sender.id
    ))
    if (
      (!controlWindow || controlWindow.isDestroyed() ||
        event.sender.id !== controlWindow.webContents.id) &&
      !isInformationDisplay
    ) {
      return { released: 0, remaining: fullscreenBrowserWindows.size }
    }
    const requestedSourceKey = typeof keepSourceKey === 'string' && keepSourceKey.length <= 200
      ? keepSourceKey
      : undefined
    return releaseBrowserFullscreenWindows(
      isInformationDisplay ? undefined : requestedSourceKey,
      !isInformationDisplay,
      event.sender.id,
      isInformationDisplay ? requestedSourceKey : undefined
    )
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
    broadcastWpfTimerToMirrors()
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
      wpfTimerDisplayId = targetDisplay.id
      // WPF/SetWindowPos consume physical pixels. Electron display bounds are
      // DIP coordinates, so passing them directly moves the timer to the
      // wrong monitor in mixed 100%/150% layouts.
      const physicalBounds = screen.dipToScreenRect(null, targetDisplay.bounds)
      showWpfTimer(physicalBounds)
      startWpfTimerMirrorSync()
    }
  })

  ipcMain.handle('hide-timer-overlay', () => {
    timerActive = false
    stopWpfTimerMirrorSync()
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
      label: d.label?.trim() || `${d.size.width}x${d.size.height}`,
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
        label: d.label?.trim() || `${d.size.width}x${d.size.height}`,
        isPrimary: d.id === primary.id,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor
      })))
    }
  }

  const syncWindowsAfterDisplayMetricsChange = async (reason: string): Promise<void> => {
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    const byId = new Map(displays.map((display) => [display.id, display]))
    diagnosticLog(
      'display',
      `metrics sync reason=${reason} displays=${JSON.stringify(displays.map((display) => ({
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        rotation: display.rotation
      })))}`
    )
    // Notify the renderer immediately so taskbar hiding and display-dependent
    // layout do not wait for a potentially slow native PowerPoint relocation.
    sendDisplays()

    const placeWindow = (
      win: BrowserWindow | null,
      target: Display | undefined,
      label: string
    ): void => {
      if (!win || win.isDestroyed() || !target) return
      const previous = win.getBounds()
      const next = target.bounds
      const changed = previous.x !== next.x || previous.y !== next.y ||
        previous.width !== next.width || previous.height !== next.height
      if (!changed) return
      try {
        // Only auxiliary windows use the explicit windowed -> place ->
        // fullscreen sequence. The main program/transition pair has its own
        // flicker-sensitive z-order choreography and must not be toggled here.
        const restoreFullscreen = label.startsWith('auxiliary ') && win.isFullScreen()
        if (restoreFullscreen) win.setFullScreen(false)
        win.setBounds(next)
        if (restoreFullscreen) win.setFullScreen(true)
        diagnosticLog(
          'display',
          `${label} resized display=${target.id} from=${JSON.stringify(previous)} to=${JSON.stringify(next)}`
        )
      } catch (error) {
        diagnosticLog('display', `${label} resize failed ${formatDiagnosticError(error)}`)
      }
    }

    const fallbackOutput = displays.find((display) => display.id !== primary.id) || primary
    const presentationTarget = byId.get(presentationDisplayId ?? -1) || fallbackOutput
    presentationDisplayId = presentationTarget.id
    placeWindow(presentationWindow, presentationTarget, 'presentation output')

    const overlayTarget = byId.get(overlayDisplayId ?? -1) || presentationTarget
    overlayDisplayId = overlayTarget.id
    placeWindow(overlayWindow, overlayTarget, 'transition overlay')

    for (const [displayId, entry] of auxiliaryWindows) {
      placeWindow(entry.window, byId.get(displayId), `auxiliary role=${entry.role}`)
    }

    if (timerActive) {
      const timerTarget = byId.get(wpfTimerDisplayId ?? -1) || presentationTarget
      wpfTimerDisplayId = timerTarget.id
      const physicalBounds = screen.dipToScreenRect(null, timerTarget.bounds)
      showWpfTimer(physicalBounds)
    }

    if (activeContentType === 'presentation') {
      const physicalBounds = screen.dipToScreenRect(null, presentationTarget.bounds)
      try {
        const result = await pptDaemon.send('relocate', { bounds: physicalBounds }, 5000)
        diagnosticLog(
          'display',
          `PowerPoint metrics relocate display=${presentationTarget.id} ` +
          `physical=${JSON.stringify(physicalBounds)} ok=${result.ok}`
        )
      } catch (error) {
        diagnosticLog('display', `PowerPoint metrics relocate failed ${formatDiagnosticError(error)}`)
      }
    }
  }

  const scheduleDisplayMetricsSync = (reason: string): void => {
    if (displayMetricsSyncTimer) clearTimeout(displayMetricsSyncTimer)
    displayMetricsSyncTimer = setTimeout(() => {
      displayMetricsSyncTimer = null
      void syncWindowsAfterDisplayMetricsChange(reason)
    }, 300)
  }

  screen.on('display-metrics-changed', (_event, display, changedMetrics) => {
    diagnosticLog(
      'display',
      `metrics changed display=${display.id} metrics=${changedMetrics.join(',')} ` +
      `bounds=${JSON.stringify(display.bounds)} workArea=${JSON.stringify(display.workArea)} scale=${display.scaleFactor}`
    )
    scheduleDisplayMetricsSync(`display=${display.id} metrics=${changedMetrics.join(',')}`)
  })

  screen.on('display-added', () => {
    // Observe the topology selected in Windows without changing it. Running
    // DisplaySwitch automatically can make Windows migrate third-party windows
    // (notably Chromium browsers) to another monitor.
    sendDisplays()
    scheduleDisplayMetricsSync('display-added')
    // Windows may need a moment to publish stable bounds for a new display.
    setTimeout(() => {
      sendDisplays()
      prewarmPresentationWindow()
    }, 1500)
  })
  screen.on('display-removed', () => {
    sendDisplays()
    scheduleDisplayMetricsSync('display-removed')
    const connectedIds = new Set(screen.getAllDisplays().map((display) => display.id))
    for (const [displayId, entry] of [...auxiliaryWindows.entries()]) {
      if (!connectedIds.has(displayId)) {
        diagnosticLog('display', `auxiliary display removed role=${entry.role} id=${displayId}`)
        closeAuxiliaryWindow(entry.role, displayId, true)
      }
    }
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
    if (channel === 'prewarm-pdf') {
      // Channel assignment can happen while the hidden output renderer is
      // still starting. Queue this one background-only command until its
      // listener exists instead of silently losing the cache request.
      if (!presentationWindow || presentationWindow.isDestroyed()) {
        prewarmPresentationWindow()
      }
      const target = presentationWindow
      void waitForPresentationWindowReady().then(() => {
        if (!target || target.isDestroyed() || presentationWindow !== target) return
        target.webContents.send(channel, ...args)
      })
      return
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
  diagnosticLog('session', `crashDumps=${app.getPath('crashDumps')} localOnly=true`)
  powerMonitor.on('shutdown', () => {
    if (shutdownTrigger === 'unknown') shutdownTrigger = 'windows-shutdown'
    diagnosticLog('lifecycle', 'Windows shutdown requested')
  })
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

  const isAuxiliaryRendererUrl = (url: string): boolean => {
    try {
      const current = new URL(url)
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      const expected = devUrl
        ? new URL(`${devUrl.replace(/\/$/, '')}/auxiliary.html`)
        : new URL(pathToFileURL(join(__dirname, '../renderer/auxiliary.html')).href)
      return current.protocol === expected.protocol && current.pathname === expected.pathname
    } catch {
      return false
    }
  }

  const isTrustedMediaRequester = (contents: Electron.WebContents | null): boolean => {
    if (!contents || contents.isDestroyed()) return false
    const isPresentation = (
      contents.id === presentationWindow?.webContents.id &&
      isPresentationRendererUrl(contents.getURL())
    )
    const isTrustedAuxiliaryCapture = [...auxiliaryWindows.values()].some((entry) => (
      (entry.role === 'mirror' || entry.role === 'info') &&
      !entry.window.isDestroyed() &&
      entry.window.webContents.id === contents.id
    )) && isAuxiliaryRendererUrl(contents.getURL())
    return isPresentation || isTrustedAuxiliaryCapture
  }

  // Default-deny remains in place for every permission except media requested
  // by the exact local presentation renderer and the auxiliary renderers that
  // need video capture (program mirrors and information displays). The control
  // renderer itself never opens a camera or microphone.
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
    contents.on('render-process-gone', (_event, details) => {
      const isControl = controlWindow?.webContents.id === contents.id
      diagnosticLog(
        'renderer-failure',
        `gone wc=${contents.id} type=${contents.getType()} control=${isControl} ` +
        `reason=${details.reason} exitCode=${details.exitCode}`
      )
      if (!isControl || quitCleanupStarted || details.reason === 'clean-exit') return

      const now = Date.now()
      if (now - controlRendererLastRecoveryAt > 60_000) controlRendererRecoveryAttempts = 0
      controlRendererLastRecoveryAt = now
      controlRendererRecoveryAttempts++
      if (controlRendererRecoveryAttempts > 2) {
        diagnosticLog('renderer-failure', 'control renderer automatic recovery stopped after 2 attempts')
        return
      }
      setTimeout(() => {
        if (!controlWindow || controlWindow.isDestroyed() || controlWindow.webContents.id !== contents.id) return
        diagnosticLog('renderer-failure', `reloading control renderer attempt=${controlRendererRecoveryAttempts}`)
        controlWindow.webContents.reload()
      }, 500)
    })
    // Permission policy is installed once on defaultSession above. It allows
    // only media for the two trusted app renderers and denies everything else.
  })

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
  if (shutdownTrigger === 'unknown') shutdownTrigger = 'window-all-closed'
  diagnosticLog('lifecycle', `window-all-closed trigger=${shutdownTrigger}`)
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
  if (shutdownTrigger === 'unknown') shutdownTrigger = 'app-quit-or-system'
  diagnosticLog(
    'lifecycle',
    `before-quit trigger=${shutdownTrigger} cleanupStarted=${quitCleanupStarted} cleanupComplete=${quitCleanupComplete}`
  )
  if (quitCleanupComplete) return
  event.preventDefault()
  if (quitCleanupStarted) return

  quitCleanupStarted = true
  diagnosticLog('shutdown', 'waiting for PowerPoint, browser fullscreen and window-enumerator cleanup')
  void Promise.allSettled([
    pptDaemon.shutdown(),
    (async () => {
      await releaseBrowserFullscreenWindows(undefined, false)
      await nativeWindowDaemon.shutdown()
    })(),
    // This final restore shares the same main-process queue as every runtime
    // hide/show request. It is therefore guaranteed to run after an in-flight
    // hide, and all later hides become no-ops during shutdown.
    showAllTaskbars(true)
  ])
    .then((results) => {
      if (results[0].status === 'rejected') {
        diagnosticLog('shutdown', `PowerPoint cleanup failed: ${formatDiagnosticError(results[0].reason)}`)
      }
      if (results[1].status === 'rejected') {
        diagnosticLog('shutdown', `Window enumerator cleanup failed: ${formatDiagnosticError(results[1].reason)}`)
      }
      if (results[2].status === 'rejected') {
        diagnosticLog('shutdown', `Taskbar restore failed: ${formatDiagnosticError(results[2].reason)}`)
      }
    })
    .finally(() => {
      quitCleanupComplete = true
      diagnosticLog('shutdown', 'helper cleanup complete')
      app.quit()
    })
})

app.on('will-quit', () => {
  diagnosticLog('lifecycle', `will-quit trigger=${shutdownTrigger}`)
})

app.on('quit', (_event, exitCode) => {
  diagnosticLog('lifecycle', `quit trigger=${shutdownTrigger} exitCode=${exitCode}`)
})

app.on('child-process-gone', (_event, details) => {
  diagnosticLog(
    'process-failure',
    `child gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} ` +
    `service=${details.serviceName || '-'} name=${details.name || '-'}`
  )
})

process.on('uncaughtExceptionMonitor', (error, origin) => {
  diagnosticLog('fatal', `uncaught exception origin=${origin} ${formatDiagnosticError(error)}`)
})

process.on('unhandledRejection', (reason) => {
  diagnosticLog('fatal', `unhandled rejection ${formatDiagnosticError(reason)}`)
})

process.on('exit', (code) => {
  diagnosticLog('lifecycle', `node process exit code=${code} trigger=${shutdownTrigger}`)
})
