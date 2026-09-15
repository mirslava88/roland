import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron'
import { readdir, stat, readFile, writeFile, rename, copyFile, rm, cp, mkdir } from 'fs/promises'
import { join, extname, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { scriptPath as resolveScript } from './paths'
import { pptDaemon } from './powerpoint-daemon'
import { createPptxCache, readPptxCacheImages, type PptxCacheProgress } from './pptx-cache'
import { resizePptxThumbnail } from './pptx-thumbnail'
import { exportPptxIncrementally } from './pptx-incremental-export'
import { createPptxDiskCache } from './pptx-cache-disk'
import {
  diagnosticLog,
  formatDiagnosticError,
  getDiagnosticLogDirectory
} from './diagnostic-log'
import { hideTaskbarForDisplay, showAllTaskbars } from './taskbar-manager'
import type { ProgramSceneLayoutConfig } from '../shared/program-scene'
import { normalizeContentZoom, type ContentZoomState } from '../shared/content-zoom'
import {
  getActivePowerPointSceneLayout,
  getPowerPointNativePlacement,
  setActivePowerPointZoom,
  setActivePowerPointSceneLayout
} from './program-scene-state'

const execFileAsync = promisify(execFile)

// PowerPoint is effectively a single COM automation target. Several renderer
// surfaces can request the same preview at once (grid tile, channel card and
// slide navigator); concurrent exporters race over PowerPoint and temp files.
const pptxExportInflight = new Map<string, Promise<unknown>>()
let pptxExportQueue: Promise<void> = Promise.resolve()

// Native PDF rendering starts PowerShell + WinRT and reopens the document. On
// slower machines that can take more than a second, so adjacent-page prefetch
// and an interactive navigation request must share the same render job.
const pdfPageRenderInflight = new Map<string, Promise<string | null>>()
let nativePdfRendererDisabledReason: string | null = null

function isNativePdfRendererPolicyFailure(error: unknown): boolean {
  const details = error instanceof Error
    ? [
        error.message,
        String((error as Error & { stderr?: unknown }).stderr ?? ''),
        String((error as Error & { stdout?: unknown }).stdout ?? '')
      ].join('\n')
    : String(error)

  return /DotSourceNotSupported/i.test(details)
}

function enqueuePptxExport<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = pptxExportInflight.get(key) as Promise<T> | undefined
  if (existing) {
    diagnosticLog('pptx-preview', `join existing job key=${key}`)
    return existing
  }

  diagnosticLog('pptx-preview', `queue job key=${key}`)
  const job = pptxExportQueue.then(work, work)
  pptxExportQueue = job.then(() => undefined, () => undefined)
  pptxExportInflight.set(key, job)
  const cleanup = (): void => {
    if (pptxExportInflight.get(key) === job) pptxExportInflight.delete(key)
  }
  job.then(cleanup, cleanup)
  return job
}

async function syncPreparedPowerPointsInternal(
  paths: string[],
  reason: string
): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'win32') return { success: true }
  try {
    let result = await pptDaemon.send('sync-prepared', { paths }, 60_000)
    for (let attempt = 2; attempt <= 3 && !result.ok; attempt++) {
      diagnosticLog(
        'pptx-preload',
        `sync prepared retry reason=${reason} attempt=${attempt} error=${result.error ?? '-'}`
      )
      await new Promise((resolve) => setTimeout(resolve, attempt * 200))
      result = await pptDaemon.send('sync-prepared', { paths }, 60_000)
    }
    diagnosticLog(
      'pptx-preload',
      `sync prepared reason=${reason} count=${paths.length} ok=${result.ok} error=${result.error ?? '-'}`
    )
    return { success: result.ok, error: result.error }
  } catch (error) {
    diagnosticLog(
      'pptx-preload',
      `sync prepared failed reason=${reason} ${formatDiagnosticError(error)}`
    )
    return { success: false, error: String(error) }
  }
}

function pptxExportDirectory(
  kind: 'thumbs' | 'slides',
  filePath: string,
  size: number,
  mtimeMs: number,
  width: number,
  height: number
): string {
  const hash = createHash('sha256')
    .update(`daemon-export-v1|${filePath.toLowerCase()}|${size}|${mtimeMs}|${width}|${height}`)
    .digest('hex')
    .slice(0, 24)
  return join(tmpdir(), `pdm-${kind}-${hash}`)
}

const readPptxExportCache = readPptxCacheImages
const pptxDiskCache = createPptxDiskCache()

const preparePptxCache = createPptxCache({
  directory: (path, size, mtime, width, height) => pptxDiskCache.claim(pptxExportDirectory('slides', path, size, mtime, width, height)),
  readCache: readPptxExportCache,
  export: (path, outputDir, width, height, onEvent, signal) => exportPptxIncrementally(
    pptDaemon.send.bind(pptDaemon), { path, outputDir, width, height }, onEvent, signal
  ),
  prepare: (path) => pptDaemon.send('prepare', { path }, 120_000),
  resize: resizePptxThumbnail,
  enqueue: enqueuePptxExport,
  release: (path) => syncPreparedPowerPointsInternal([], `single-pass-cache:${path}`),
  log: (message) => diagnosticLog('pptx-cache', message)
})

export async function stopPptxCacheJobs(): Promise<void> {
  await preparePptxCache.stop()
}

export async function clearPptxDiskCaches(): Promise<void> {
  const result = await pptxDiskCache.clear()
  diagnosticLog('pptx-cache', `shutdown purge removed=${result.removed} shared=${result.shared}`)
}

let originalAudioDeviceId: string | null = null
let preferredAudioDeviceId: string | null = null
let audioPreferenceLoaded = false
let audioPreferenceLoadPromise: Promise<void> | null = null
let audioMutationQueue: Promise<void> = Promise.resolve()
let audioOperationId = 0

function audioSettingsPath(): string {
  return join(app.getPath('userData'), 'audio-settings.json')
}

async function ensureAudioPreferenceLoaded(): Promise<void> {
  if (audioPreferenceLoaded) return
  if (audioPreferenceLoadPromise) return audioPreferenceLoadPromise
  audioPreferenceLoadPromise = (async () => {
    try {
      const raw = await readFile(audioSettingsPath(), 'utf8')
      const parsed = JSON.parse(raw) as { preferredDeviceId?: unknown }
      preferredAudioDeviceId = typeof parsed.preferredDeviceId === 'string' && parsed.preferredDeviceId
        ? parsed.preferredDeviceId
        : null
      diagnosticLog('audio', `preference loaded configured=${Boolean(preferredAudioDeviceId)}`)
    } catch {
      preferredAudioDeviceId = null
      diagnosticLog('audio', 'preference not found; current Windows default will be adopted')
    } finally {
      audioPreferenceLoaded = true
      audioPreferenceLoadPromise = null
    }
  })()
  return audioPreferenceLoadPromise
}

async function saveAudioPreference(): Promise<void> {
  const path = audioSettingsPath()
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(path, JSON.stringify({ preferredDeviceId: preferredAudioDeviceId }, null, 2), 'utf8')
}

function enqueueAudioMutation<T>(label: string, work: () => Promise<T>): Promise<T> {
  const operationId = ++audioOperationId
  const job = audioMutationQueue.then(async () => {
    diagnosticLog('audio', `operation=${operationId} ${label} begin`)
    try {
      const result = await work()
      diagnosticLog('audio', `operation=${operationId} ${label} complete`)
      return result
    } catch (error) {
      diagnosticLog('audio', `operation=${operationId} ${label} failed ${formatDiagnosticError(error)}`)
      throw error
    }
  })
  audioMutationQueue = job.then(() => undefined, () => undefined)
  return job
}

async function setDefaultAudioDevice(deviceId: string): Promise<void> {
  const scriptPath = resolveScript('audio-control.ps1')
  await execFileAsync('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-File', scriptPath,
    '-Action', 'set',
    '-DeviceId', deviceId
  ])
}

async function runAudioControlJson<T>(action: 'list' | 'get-default'): Promise<T> {
  const audioScriptPath = resolveScript('audio-control.ps1')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-File', audioScriptPath,
    '-Action', `${action}-base64`
  ], { timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const encoded = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!encoded) throw new Error(`Audio control returned no data for ${action}`)
  const json = Buffer.from(encoded, 'base64').toString('utf8')
  return JSON.parse(json) as T
}

// Exact title/class fingerprint prevents same-process HWND reuse in Word/Excel
// from making PDM minimize or close a different user document.
const externalFiles = new Map<string, {
  hwnd: number
  pid: number
  windowTitle: string
  windowClass: string
  owned: boolean
}>()

// Office may need up to a minute to create its HWND. Serialize every external
// window mutation so shutdown cannot run its final cleanup before an in-flight
// open/restore has registered the exact window it created or borrowed.
let externalOperationTail: Promise<void> = Promise.resolve()
let externalShutdownStarted = false

function enqueueExternalOperation<T>(operation: () => Promise<T>): Promise<T> {
  const job = externalOperationTail.then(operation, operation)
  externalOperationTail = job.then(() => undefined, () => undefined)
  return job
}

export interface ExternalWindowActionResult {
  success: boolean
  error?: string
  windowGone?: boolean
}

type ExternalDisplayBounds = { x: number; y: number; width: number; height: number }

interface ExternalWindowPlacement {
  bounds: ExternalDisplayBounds
  windowed: boolean
  cornerRadius: number
}

function getNativeExternalDisplayBounds(bounds?: ExternalDisplayBounds): ExternalDisplayBounds | undefined {
  if (!bounds || process.platform !== 'win32') return bounds
  // Renderer display bounds are DIP coordinates. manage-window.ps1 uses
  // Win32 MoveWindow/GetWindowRect and therefore requires physical pixels.
  // Passing DIP happened to keep Excel on some mixed-DPI layouts, while Word
  // jumped back to the primary display after a minimize/restore cycle.
  return screen.dipToScreenRect(null, bounds)
}

function getExternalWindowPlacement(
  displayBounds?: ExternalDisplayBounds,
  sceneLayout?: ProgramSceneLayoutConfig
): ExternalWindowPlacement | undefined {
  const nativeDisplayBounds = getNativeExternalDisplayBounds(displayBounds)
  if (!nativeDisplayBounds) return undefined
  if (!sceneLayout?.enabled || !displayBounds) {
    return { bounds: nativeDisplayBounds, windowed: false, cornerRadius: 0 }
  }
  const display = screen.getAllDisplays().find((candidate) => (
    candidate.bounds.x === displayBounds.x &&
    candidate.bounds.y === displayBounds.y &&
    candidate.bounds.width === displayBounds.width &&
    candidate.bounds.height === displayBounds.height
  ))
  if (!display) {
    diagnosticLog('window', `Office program scene refused: target display bounds not found ${JSON.stringify(displayBounds)}`)
    return undefined
  }
  // Word/Excel perform magnification internally through Office COM. Keep the
  // native HWND at the unscaled content-pane bounds; applying PowerPoint's
  // outer-window zoom here would enlarge the title/ribbon instead of the
  // document and could overlap the independent participant pane.
  const placement = getPowerPointNativePlacement(display, sceneLayout, {
    enabled: false,
    scale: 1,
    originX: 0.5,
    originY: 0.5
  })
  return {
    bounds: placement.bounds,
    windowed: sceneLayout.viewMode !== 'content',
    cornerRadius: placement.cornerRadius
  }
}

function appendExternalPlacementArgs(args: string[], placement: ExternalWindowPlacement): void {
  args.push(
    '-X', String(placement.bounds.x),
    '-Y', String(placement.bounds.y),
    '-Width', String(placement.bounds.width),
    '-Height', String(placement.bounds.height),
    '-Windowed', placement.windowed ? '1' : '0',
    '-CornerRadius', String(placement.cornerRadius)
  )
}

interface PowerPointEmergencyRollbackResult {
  visualStopped: boolean
  cleanupVerified: boolean
  safeToUncover: boolean
  previousRestored?: boolean
  windowGone?: boolean
  error?: string
}

async function rollbackPowerPointAfterCommitFailure(
  hwnd: number | undefined,
  pid: number | undefined,
  filePath: string,
  managed: boolean | undefined,
  reusedPrevious: boolean | undefined,
  previousHwnd: number | undefined,
  previousPid: number | undefined,
  previousPath: string | undefined,
  previousSlide: number | undefined,
  sharesPreviousPresentation: boolean | undefined,
  presentationRelationshipKnown: boolean | undefined
): Promise<PowerPointEmergencyRollbackResult> {
  if (!hwnd || !pid || process.platform !== 'win32') {
    return {
      visualStopped: false,
      cleanupVerified: false,
      safeToUncover: false,
      error: 'PowerPoint target HWND is unavailable for emergency rollback'
    }
  }

  const script = resolveScript('manage-window.ps1')
  const baseArgs = [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-File', script
  ]

  type HelperResult = PowerPointEmergencyRollbackResult & {
    success?: boolean
    visible?: boolean
  }
  const runHelper = async (args: string[], timeout: number): Promise<HelperResult> => {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [...baseArgs, ...args],
      { timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }
    )
    const json = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'
    return JSON.parse(json) as HelperResult
  }

  // Same-file OPEN can be an in-place GotoSlide on the exact last committed
  // slideshow. It is not a disposable target: restore its prior slide and
  // visibility, then independently verify the exact HWND fingerprint.
  if (reusedPrevious === true) {
    if (
      previousHwnd !== hwnd || previousPid !== pid ||
      !previousPath || !previousSlide || previousSlide <= 0
    ) {
      return {
        visualStopped: false,
        cleanupVerified: false,
        safeToUncover: false,
        error: 'Same-file PowerPoint rollback metadata is incomplete or inconsistent'
      }
    }
    let restore: HelperResult
    try {
      restore = await runHelper([
        '-Action', 'restore-powerpoint-slideshow',
        '-Hwnd', String(hwnd),
        '-ProcessId', String(pid),
        '-FilePath', previousPath!,
        '-RestoreSlide', String(previousSlide)
      ], 18_000)
    } catch (error) {
      restore = {
        visualStopped: false,
        cleanupVerified: false,
        safeToUncover: false,
        error: `Same-file PowerPoint restore failed: ${String(error)}`
      }
    }

    let visibleCheck: HelperResult
    try {
      visibleCheck = await runHelper([
        '-Action', 'verify-window',
        '-Hwnd', String(hwnd),
        '-ProcessId', String(pid),
        '-ExpectedWindowClass', 'screenClass'
      ], 5_000)
    } catch (error) {
      visibleCheck = {
        visualStopped: false,
        cleanupVerified: false,
        safeToUncover: false,
        error: `Previous PowerPoint visibility recheck failed: ${String(error)}`
      }
    }
    const previousRestored = restore.success === true &&
      restore.previousRestored === true && visibleCheck.success === true
    return {
      visualStopped: false,
      cleanupVerified: previousRestored,
      previousRestored,
      safeToUncover: previousRestored,
      windowGone: visibleCheck.windowGone,
      error: previousRestored
        ? undefined
        : [restore.error, visibleCheck.error].filter(Boolean).join('; ') ||
          'Previous PowerPoint slideshow restore was not verified'
    }
  }

  // Hide the exact HWND in a separate bounded helper before attempting COM.
  // Even if Office is hung and the COM helper times out, the uncommitted
  // target can never become visible when the renderer drops its overlay.
  let hideResult: HelperResult
  try {
    hideResult = await runHelper([
      '-Action', 'hide-window',
      '-Hwnd', String(hwnd),
      '-ProcessId', String(pid),
      '-ExpectedWindowClass', 'screenClass'
    ], 5_000)
  } catch (error) {
    return {
      visualStopped: false,
      cleanupVerified: false,
      safeToUncover: false,
      error: `PowerPoint target hide failed: ${String(error)}`
    }
  }

  if (hideResult.success !== true || hideResult.visualStopped === false) {
    return {
      visualStopped: false,
      cleanupVerified: false,
      safeToUncover: false,
      windowGone: hideResult.windowGone,
      error: hideResult.error || 'PowerPoint target hide was not verified'
    }
  }

  const samePathAsPrevious = Boolean(
    previousPath && previousPath.toLowerCase() === filePath.toLowerCase()
  )
  let cleanupResult: HelperResult
  let previousRestoreResult: HelperResult | undefined
  try {
    if (previousHwnd === hwnd) {
      cleanupResult = {
        visualStopped: true,
        cleanupVerified: false,
        safeToUncover: false,
        error: 'Target equals previous HWND but was not marked as a verified reuse'
      }
    } else if (samePathAsPrevious && presentationRelationshipKnown !== true) {
      cleanupResult = {
        visualStopped: true,
        cleanupVerified: false,
        safeToUncover: false,
        error: 'Same-path PowerPoint presentation identity relationship is unknown'
      }
    } else {
      cleanupResult = await runHelper([
        '-Action', 'rollback-powerpoint-target',
        '-Hwnd', String(hwnd),
        '-ProcessId', String(pid),
        '-FilePath', filePath,
        '-OwnershipKnown', typeof managed === 'boolean' ? '1' : '0',
        // Two slideshow HWNDs can share one Presentation. Exit only the staged
        // target view; Presentation.Close would also kill previous output.
        '-PdmManaged', sharesPreviousPresentation === true ? '0' : managed === true ? '1' : '0'
      ], 18_000)

    }
  } catch (error) {
    cleanupResult = {
      visualStopped: true,
      cleanupVerified: false,
      safeToUncover: false,
      error: `PowerPoint target is hidden, but COM rollback failed: ${String(error)}`
    }
  }

  // If a previous PowerPoint output existed, abort semantics require that
  // exact HWND to be back on its prior slide and visible. An empty previous
  // marker is the cold-start/Electron-underlay case and needs no PPT restore.
  const noPreviousPowerPoint = !previousHwnd && !previousPath
  if (!noPreviousPowerPoint && (!previousHwnd || !previousPid || !previousPath || !previousSlide)) {
    previousRestoreResult = {
      visualStopped: false,
      cleanupVerified: false,
      safeToUncover: false,
      error: 'Previous PowerPoint output metadata is unavailable'
    }
  } else if (!noPreviousPowerPoint) {
    try {
      previousRestoreResult = await runHelper([
        '-Action', 'restore-powerpoint-slideshow',
        '-Hwnd', String(previousHwnd),
        '-ProcessId', String(previousPid),
        '-FilePath', previousPath!,
        '-RestoreSlide', String(previousSlide)
      ], 18_000)
    } catch (error) {
      previousRestoreResult = {
        visualStopped: false,
        cleanupVerified: false,
        safeToUncover: false,
        error: `Previous PowerPoint restore failed: ${String(error)}`
      }
    }
  }

  // COM can recreate/re-show a slideshow HWND after the first SW_HIDE, and a
  // timed-out helper result is stale by definition. Always make a separate
  // exact PID/HWND/class visibility check after the COM process terminates.
  let hiddenCheck: HelperResult
  try {
    hiddenCheck = await runHelper([
      '-Action', 'verify-hidden-window',
      '-Hwnd', String(hwnd),
      '-ProcessId', String(pid),
      '-ExpectedWindowClass', 'screenClass'
    ], 5_000)
  } catch (error) {
    hiddenCheck = {
      visualStopped: false,
      cleanupVerified: false,
      safeToUncover: false,
      error: `PowerPoint target visibility recheck failed: ${String(error)}`
    }
  }

  let previousVisible = noPreviousPowerPoint
  let previousVisibilityError = ''
  if (previousRestoreResult?.success === true) {
    try {
      const previousCheck = await runHelper([
        '-Action', 'verify-window',
        '-Hwnd', String(previousHwnd),
        '-ProcessId', String(previousPid),
        '-ExpectedWindowClass', 'screenClass'
      ], 5_000)
      previousVisible = previousCheck.success === true
      previousVisibilityError = previousCheck.error || ''
    } catch (error) {
      previousVisible = false
      previousVisibilityError = `Previous PowerPoint visibility recheck failed: ${String(error)}`
    }
  }

  const visualStopped = hiddenCheck.success === true && hiddenCheck.visualStopped !== false
  const previousRestored = noPreviousPowerPoint || (
    previousRestoreResult?.success === true &&
    previousRestoreResult.previousRestored === true && previousVisible
  )
  const cleanupVerified = cleanupResult.cleanupVerified === true &&
    previousRestored
  const safeToUncover = visualStopped && cleanupVerified
  return {
    visualStopped,
    cleanupVerified,
    previousRestored,
    safeToUncover,
    windowGone: hiddenCheck.windowGone,
    error: safeToUncover
      ? undefined
      : [cleanupResult.error, previousRestoreResult?.error, hiddenCheck.error, previousVisibilityError]
          .filter(Boolean)
          .join('; ') || 'PowerPoint emergency rollback was not fully verified'
  }
}

async function manageExternalWindowUnlocked(action: 'minimize' | 'restore' | 'close', filePath?: string, placement?: ExternalWindowPlacement): Promise<ExternalWindowActionResult> {
  const scriptPath = resolveScript('manage-window.ps1')

  if (filePath) {
    const entry = externalFiles.get(filePath)
    if (!entry) {
      return action === 'close'
        ? { success: true }
        : { success: false, error: 'Окно программы больше не найдено.' }
    }
    try {
      // Start-Process may activate a document that the user already had open.
      // A logical close removes that borrowed HWND from program output without
      // sending WM_CLOSE to a user-owned document.
      const effectiveAction = action === 'close' && !entry.owned ? 'minimize' : action
      const args = [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', effectiveAction,
        '-Hwnd', String(entry.hwnd),
        '-ProcessId', String(entry.pid),
        '-FilePath', filePath,
        '-ExpectedWindowTitle', entry.windowTitle,
        '-ExpectedWindowClass', entry.windowClass
      ]
      if (placement && action === 'restore') {
        appendExternalPlacementArgs(args, placement)
      }
      const timeout = effectiveAction === 'close' ? 8_000 : 5_000
      const { stdout } = await execFileAsync('powershell.exe', args, { timeout })
      const data = JSON.parse(stdout.trim()) as ExternalWindowActionResult
      if (!data.success) return { success: false, error: data.error || 'Windows не переместила окно программы.' }
      if ((action === 'close' && entry.owned) || data.windowGone) externalFiles.delete(filePath)
      return data
    } catch (error) {
      return { success: false, error: String(error) }
    }
  } else {
    // Apply to all tracked files
    let firstError: string | undefined
    for (const [path, entry] of externalFiles) {
      let actionSucceeded = false
      try {
        const effectiveAction = action === 'close' && !entry.owned ? 'minimize' : action
        const args = [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', scriptPath,
          '-Action', effectiveAction,
          '-Hwnd', String(entry.hwnd),
          '-ProcessId', String(entry.pid),
          '-FilePath', path,
          '-ExpectedWindowTitle', entry.windowTitle,
          '-ExpectedWindowClass', entry.windowClass
        ]
        const timeout = effectiveAction === 'close' ? 8_000 : 5_000
        const { stdout } = await execFileAsync('powershell.exe', args, { timeout })
        const data = JSON.parse(stdout.trim()) as ExternalWindowActionResult
        if (!data.success && !firstError) firstError = data.error || 'Windows не обработала окно программы.'
        actionSucceeded = data.success
        if (data.windowGone) externalFiles.delete(path)
      } catch (error) {
        if (!firstError) firstError = String(error)
      }
      if (action === 'close' && entry.owned && actionSucceeded) externalFiles.delete(path)
    }
    return firstError ? { success: false, error: firstError } : { success: true }
  }
}

async function manageExternalWindow(action: 'minimize' | 'restore' | 'close', filePath?: string, placement?: ExternalWindowPlacement): Promise<ExternalWindowActionResult> {
  if (externalShutdownStarted) {
    return { success: false, error: 'PDM is shutting down; external window operation was cancelled.' }
  }
  return enqueueExternalOperation(() => manageExternalWindowUnlocked(action, filePath, placement))
}

export async function closeExternalFile(filePath?: string): Promise<ExternalWindowActionResult> {
  return manageExternalWindow('close', filePath)
}

export async function closeAllExternalFiles(): Promise<ExternalWindowActionResult> {
  // Set the gate synchronously before queueing the final pass, so no renderer
  // request can be appended behind shutdown cleanup.
  externalShutdownStarted = true
  return enqueueExternalOperation(() => manageExternalWindowUnlocked('close'))
}

const SUPPORTED_EXTENSIONS = {
  presentation: ['.pptx', '.ppt'],
  pdf: ['.pdf'],
  video: ['.mp4', '.mov', '.avi', '.webm', '.mkv'],
  other: [
    '.doc', '.docx', '.xls', '.xlsx', '.txt', '.rtf', '.odt', '.ods',
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma'
  ]
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg']
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma']

function getFileType(ext: string): 'presentation' | 'pdf' | 'video' | 'other' | 'unknown' {
  const lower = ext.toLowerCase()
  if (SUPPORTED_EXTENSIONS.presentation.includes(lower)) return 'presentation'
  if (SUPPORTED_EXTENSIONS.pdf.includes(lower)) return 'pdf'
  if (SUPPORTED_EXTENSIONS.video.includes(lower)) return 'video'
  if (SUPPORTED_EXTENSIONS.other.includes(lower)) return 'other'
  return 'unknown'
}

function isImageFile(ext: string): boolean {
  return IMAGE_EXTENSIONS.includes(ext.toLowerCase())
}

function isAudioFile(ext: string): boolean {
  return AUDIO_EXTENSIONS.includes(ext.toLowerCase())
}

// Extensions that must NEVER be launched via external-open (LOLBin / RCE vector).
// Defense-in-depth on top of the getFileType allowlist in isOpenable().
const DANGEROUS_OPEN_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.scr', '.pif', '.lnk', '.hta', '.cpl',
  '.msi', '.msp', '.reg', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.gadget', '.jar'
])

// Main-side gate for the external-open / Start-Process surface (audit finding,
// "open-file-external launches arbitrary renderer-controlled path"). Deny-by-
// default: only file types the app legitimately surfaces (getFileType !==
// 'unknown') may be opened externally; all executables fall into 'unknown' and
// are also explicitly hard-denied. Legit external opens are always docs/media,
// so this does not reject any real flow — the renderer's load-folder already
// filters out 'unknown' files, so openable items are always supported types.
function isOpenable(filePath: string): boolean {
  // UNC / network-share paths are allowed — the app opens documents from network
  // drives. Executables are still hard-denied below (DANGEROUS_OPEN_EXTENSIONS),
  // which is the actual protection here.
  const ext = extname(filePath).toLowerCase()
  if (DANGEROUS_OPEN_EXTENSIONS.has(ext)) return false
  return getFileType(ext) !== 'unknown'
}

export interface FileEntry {
  id: string
  name: string
  path: string
  type: 'presentation' | 'pdf' | 'video' | 'other' | 'unknown'
  extension: string
  size: number
  isImage?: boolean
  isAudio?: boolean
}

export function registerIpcHandlers(
  controlWindow: BrowserWindow,
  getPresentationWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('get-app-version', (event): string => {
    if (event.sender.id !== controlWindow.webContents.id) return ''
    return __PDM_DISPLAY_VERSION__
  })

  ipcMain.handle('save-app-config', async (event, content: string) => {
    if (event.sender.id !== controlWindow.webContents.id) {
      return { success: false, canceled: false, error: 'Сохранение конфигурации запрещено.' }
    }
    if (typeof content !== 'string' || content.length < 2 || content.length > 5 * 1024 * 1024) {
      return { success: false, canceled: false, error: 'Некорректный или слишком большой файл конфигурации.' }
    }
    try {
      JSON.parse(content)
    } catch {
      return { success: false, canceled: false, error: 'Конфигурация содержит некорректный JSON.' }
    }

    const date = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(controlWindow, {
      title: 'Сохранить конфигурацию PDM',
      defaultPath: join(app.getPath('documents'), `PDM-config-${date}.pdmconfig`),
      filters: [
        { name: 'Конфигурация PDM', extensions: ['pdmconfig'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }
    const filePath = /\.(?:pdmconfig|json)$/i.test(result.filePath)
      ? result.filePath
      : `${result.filePath}.pdmconfig`
    try {
      await writeFile(filePath, content, 'utf8')
      diagnosticLog('config', `saved path=${filePath} bytes=${Buffer.byteLength(content, 'utf8')}`)
      return { success: true, canceled: false, path: filePath }
    } catch (error) {
      diagnosticLog('config', `save failed path=${filePath} ${formatDiagnosticError(error)}`)
      return { success: false, canceled: false, error: String(error) }
    }
  })

  ipcMain.handle('load-app-config', async (event) => {
    if (event.sender.id !== controlWindow.webContents.id) {
      return { success: false, canceled: false, error: 'Загрузка конфигурации запрещена.' }
    }
    const result = await dialog.showOpenDialog(controlWindow, {
      title: 'Загрузить конфигурацию PDM',
      properties: ['openFile'],
      filters: [
        { name: 'Конфигурация PDM', extensions: ['pdmconfig', 'json'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }
    const filePath = result.filePaths[0]
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.size > 5 * 1024 * 1024) {
        return { success: false, canceled: false, error: 'Файл конфигурации слишком большой или недоступен.' }
      }
      const content = await readFile(filePath, 'utf8')
      JSON.parse(content)
      diagnosticLog('config', `loaded path=${filePath} bytes=${info.size}`)
      return { success: true, canceled: false, path: filePath, content }
    } catch (error) {
      diagnosticLog('config', `load failed path=${filePath} ${formatDiagnosticError(error)}`)
      return { success: false, canceled: false, error: 'Не удалось прочитать конфигурацию: ' + String(error) }
    }
  })

  ipcMain.handle('validate-config-paths', async (event, paths: unknown) => {
    if (event.sender.id !== controlWindow.webContents.id || !Array.isArray(paths)) return []
    const uniquePaths = [...new Set(paths
      .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32768)
      .slice(0, 2000))]
    return await Promise.all(uniquePaths.map(async (filePath) => {
      try {
        const info = await stat(filePath)
        return { path: filePath, exists: true, isDirectory: info.isDirectory() }
      } catch {
        return { path: filePath, exists: false, isDirectory: false }
      }
    }))
  })

  ipcMain.handle('open-diagnostic-log-folder', async () => {
    const path = getDiagnosticLogDirectory()
    diagnosticLog('diagnostics', `open log folder path=${path}`)
    const error = await shell.openPath(path)
    return { success: error.length === 0, path, error: error || undefined }
  })

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      properties: ['openDirectory'],
      title: 'Select Presentation Folder'
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  // Folder watcher: fs.watch на текущей папке, при любых изменениях шлём
  // 'folder-changed' в renderer (он re-load list). Debounce 200мс — Windows
  // часто шлёт несколько событий на одно действие (create + write + close).
  // Только один активный watcher; смена папки переинициализирует.
  let activeWatcher: ReturnType<typeof import('fs').watch> | null = null
  let activeWatchPath: string | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  ipcMain.handle('watch-folder', (_event, folderPath: string | null) => {
    if (activeWatcher && activeWatchPath === folderPath) return
    if (activeWatcher) {
      try { activeWatcher.close() } catch { /* ignore */ }
      activeWatcher = null
      activeWatchPath = null
    }
    if (!folderPath) return
    try {
      const fs = require('fs') as typeof import('fs')
      activeWatcher = fs.watch(folderPath, { persistent: false }, () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          if (!controlWindow.isDestroyed()) {
            controlWindow.webContents.send('folder-changed', folderPath)
          }
        }, 200)
      })
      activeWatchPath = folderPath
      activeWatcher.on('error', () => {
        if (activeWatcher) { try { activeWatcher.close() } catch {} }
        activeWatcher = null
        activeWatchPath = null
      })
    } catch (e) {
      console.error('[IPC] watch-folder failed:', e)
    }
  })

  ipcMain.handle('load-folder', async (_event, folderPath: string) => {
    let entries: string[]
    try {
      entries = await readdir(folderPath)
    } catch {
      return { files: [], subfolders: [] }
    }
    const files: FileEntry[] = []
    const subfolders: { name: string; path: string }[] = []

    for (const entry of entries) {
      const fullPath = join(folderPath, entry)
      let stats
      try {
        stats = await stat(fullPath)
      } catch {
        // Skip files/folders we can't access (permissions, system files)
        continue
      }

      if (stats.isDirectory()) {
        subfolders.push({ name: entry, path: fullPath })
        continue
      }

      if (!stats.isFile()) continue

      const ext = extname(entry)
      const type = getFileType(ext)

      if (type === 'unknown') continue

      files.push({
        id: `${entry}-${stats.mtimeMs}`,
        name: basename(entry, ext),
        path: fullPath,
        type,
        extension: ext.toLowerCase(),
        size: stats.size,
        isImage: isImageFile(ext),
        isAudio: isAudioFile(ext)
      })
    }

    return { files, subfolders }
  })

  ipcMain.handle('check-powerpoint', async () => {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-Command',
          'Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\powerpnt.exe" -ErrorAction Stop'
        ])
        return true
      } catch {
        try {
          await execFileAsync('where.exe', ['powerpnt'])
          return true
        } catch {
          return false
        }
      }
    }

    if (process.platform === 'darwin') {
      try {
        await execFileAsync('osascript', [
          '-e', 'tell application "System Events" to (name of processes) contains "Microsoft PowerPoint"'
        ])
        return true
      } catch {
        return false
      }
    }

    return false
  })

  ipcMain.handle('prepare-powerpoint', async (_event, filePath: string) => {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Unsupported platform' }
    }
    const started = Date.now()
    try {
      diagnosticLog('pptx-preload', `prepare request file=${filePath}`)
      const result = await pptDaemon.send('prepare', { path: filePath }, 120000)
      diagnosticLog(
        'pptx-preload',
        `prepare result file=${filePath} ok=${result.ok} slides=${result.slideCount ?? 0} ` +
        `size=${result.slideWidth ?? 0}x${result.slideHeight ?? 0} ` +
        `dur=${Date.now() - started}ms error=${result.error ?? '-'}`
      )
      const aspectRatio = typeof result.slideWidth === 'number' &&
        typeof result.slideHeight === 'number' && result.slideHeight > 0
        ? result.slideWidth / result.slideHeight
        : undefined
      return result.ok
        ? { success: true, slideCount: result.slideCount ?? 0, aspectRatio }
        : { success: false, error: result.error || 'PowerPoint preparation failed' }
    } catch (error) {
      diagnosticLog(
        'pptx-preload',
        `prepare failed file=${filePath} dur=${Date.now() - started}ms ${formatDiagnosticError(error)}`
      )
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('sync-prepared-powerpoints', async (_event, filePaths: unknown) => {
    const paths = Array.isArray(filePaths)
      ? filePaths.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
    return syncPreparedPowerPointsInternal(paths, 'renderer-request')
  })

  ipcMain.handle(
    'launch-powerpoint',
    async (
      event,
      filePath: string,
      displayId?: number,
      startSlide?: number,
      sceneLayout?: ProgramSceneLayoutConfig,
      deferPromotion?: boolean
    ) => {
      if (process.platform === 'win32') {
        try {
          const args: Record<string, unknown> = { path: filePath }
          const displays = screen.getAllDisplays()
          const explicitlyRequestedDisplay = typeof displayId === 'number'
            ? displays.find((d) => d.id === displayId)
            : undefined
          if (typeof displayId === 'number' && !explicitlyRequestedDisplay) {
            return {
              success: false,
              error: `Requested PowerPoint display ${displayId} is disconnected`
            }
          }
          if (!explicitlyRequestedDisplay) {
            return {
              success: false,
              error: 'Для PowerPoint не назначен подключённый эфирный дисплей.'
            }
          }
          const targetDisplay = explicitlyRequestedDisplay

          // Electron bounds are DIP while SetWindowPos expects physical pixels.
          const placement = getPowerPointNativePlacement(targetDisplay, sceneLayout, {
            enabled: false,
            scale: 1,
            originX: 0.5,
            originY: 0.5
          })
          args.bounds = placement.bounds
          args.clipBounds = placement.clipBounds
          args.cornerRadius = placement.cornerRadius
          args.deferPromotion = deferPromotion === true
          const presentationWindow = getPresentationWindow()
          if (presentationWindow && !presentationWindow.isDestroyed()) {
            const nativeHandle = presentationWindow.getNativeWindowHandle()
            args.underlayHwnd = nativeHandle.length >= 8
              ? Number(nativeHandle.readBigUInt64LE(0))
              : nativeHandle.readUInt32LE(0)
          }
          if (typeof startSlide === 'number' && startSlide > 1) {
            args.slide = startSlide
          }
          // Keep open + commit/abort indivisible. The PowerShell host processes
          // stdin serially, but without this main-side lock an export/notes job
          // could be queued between the two transaction commands. A late
          // commit would then leave the renderer rolled back while the new
          // slideshow was physically on air.
          return await pptDaemon.runExclusive(async (send) => {
            let res: Awaited<ReturnType<typeof pptDaemon.send>> = {
              id: 0,
              ok: false,
              error: 'not attempted'
            }
            let safeToUncoverOnFailure = true
            let emergencyRollbackAttempted = false
            try {
              for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`[IPC ${Date.now()}] launch-powerpoint: daemon.send('open') BEGIN attempt=${attempt} slide=${startSlide ?? 1} display=${targetDisplay.id} bounds=${JSON.stringify(args.bounds)}`)
                res = await send('open', args, 120000, (progress) => {
                  if (progress.event === 'slideshow-visible' && !event.sender.isDestroyed()) {
                    event.sender.send('powerpoint-slideshow-visible', filePath)
                  }
                })
                if (res.ok) {
                  // Nothing else can enter the daemon queue before this
                  // acknowledgement. Cleanup is bounded in the PS host; the
                  // wider timeout avoids reporting rollback while a valid
                  // commit response is merely delayed by Office COM.
                  let committed: Awaited<ReturnType<typeof pptDaemon.send>>
                  try {
                    // `commit-open` acknowledges immediately after rechecking
                    // the exact slideshow HWND. All potentially slow COM
                    // retirement runs after that ACK behind the daemon cleanup
                    // barrier, so detaching this request on a finite timeout is
                    // both unnecessary and unsafe.
                    committed = await send('commit-open', {}, 0)
                  } catch (commitError) {
                    // A visible screenClass HWND is not a durable commit: the
                    // daemon may have exited and lost every COM ownership
                    // marker. Hide the exact PID/HWND first, then independently
                    // match HWND + file path through PowerPoint COM and retire
                    // only the document the daemon identified as PDM-managed.
                    // User-owned presentations keep their document and only
                    // exit the exact slideshow.
                    const rollback = await rollbackPowerPointAfterCommitFailure(
                      res.hwnd,
                      res.pid,
                      filePath,
                      res.managed,
                      res.reusedPrevious,
                      res.previousHwnd,
                      res.previousPid,
                      res.previousPath,
                      res.previousSlide,
                      res.sharesPreviousPresentation,
                      res.presentationRelationshipKnown
                    )
                    emergencyRollbackAttempted = true
                    safeToUncoverOnFailure = rollback.safeToUncover
                    diagnosticLog(
                      'pptx-lifecycle',
                      `commit acknowledgement failed file=${filePath} hwnd=${res.hwnd ?? 0} ` +
                      `pid=${res.pid ?? 0} managed=${String(res.managed)} ` +
                      `reusedPrevious=${String(res.reusedPrevious)} ` +
                      `sharesPreviousPresentation=${String(res.sharesPreviousPresentation)} ` +
                      `visualStopped=${rollback.visualStopped} cleanupVerified=${rollback.cleanupVerified} ` +
                      `previousRestored=${String(rollback.previousRestored)} ` +
                      `safeToUncover=${rollback.safeToUncover} ` +
                      `rollbackError=${rollback.error ?? '-'} commitError=${String(commitError)}`
                    )
                    const rollbackState = rollback.previousRestored
                      ? 'Previous PowerPoint slideshow was restored.'
                      : rollback.visualStopped
                        ? rollback.cleanupVerified
                        ? 'Нецелевой показ PowerPoint остановлен и освобождён.'
                        : 'Нецелевой показ PowerPoint скрыт, но очистка COM не подтверждена. Перезапустите PDM.'
                      : 'Не удалось гарантированно скрыть незафиксированный показ PowerPoint. Перезапустите PDM.'
                    throw new Error(
                      `PowerPoint commit failed: ${String(commitError)}; ${rollbackState}` +
                      (rollback.error ? ` ${rollback.error}` : '')
                    )
                  }
                  if (!committed.ok) {
                    const aborted = await send('abort-open', {}, 150000)
                    if (!aborted.ok) safeToUncoverOnFailure = false
                    res = {
                      ...res,
                      ok: false,
                      error: [committed.error || 'PowerPoint commit failed', aborted.ok ? '' : aborted.error]
                        .filter(Boolean)
                        .join('; ')
                    }
                  }
                }
                console.log(`[IPC ${Date.now()}] launch-powerpoint: daemon.send('open') END attempt=${attempt} ok=${res.ok} error=${res.error ?? '-'}`)
                if (res.ok) break
                if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750))
              }
              if (!res.ok) {
                let cleanupError = ''
                try {
                  const cleanup = await send('abort-open', {}, 150000)
                  if (!cleanup.ok) {
                    cleanupError = cleanup.error || 'PowerPoint cleanup failed'
                    safeToUncoverOnFailure = false
                  }
                } catch (error) {
                  cleanupError = String(error)
                  safeToUncoverOnFailure = false
                }
                diagnosticLog(
                  'pptx-lifecycle',
                  `open failed after retries file=${filePath} cleanupError=${cleanupError || '-'} error=${res.error ?? '-'}`
                )
                return {
                  success: false,
                  error: [res.error || 'open failed', cleanupError].filter(Boolean).join('; '),
                  safeToUncover: safeToUncoverOnFailure
                }
              }
              const output = JSON.stringify({
                Status: 'ok',
                SlideCount: res.slideCount ?? 0,
                CurrentSlide: res.slide ?? 1
              })
              setActivePowerPointSceneLayout(sceneLayout?.enabled ? sceneLayout : null)
              return { success: true, output }
            } catch (error: unknown) {
              let cleanupError = ''
              try {
                // A timeout cannot cancel a COM command already being
                // processed. The raw abort remains under the same exclusive
                // lock and is therefore the very next daemon command.
                const cleanup = await send('abort-open', {}, 150000)
                if (!cleanup.ok) {
                  cleanupError = cleanup.error || 'PowerPoint rollback failed'
                  if (!emergencyRollbackAttempted) safeToUncoverOnFailure = false
                }
              } catch (cleanupFailure) {
                cleanupError = String(cleanupFailure)
                if (!emergencyRollbackAttempted) safeToUncoverOnFailure = false
              }
              return {
                success: false,
                error: [String(error), cleanupError].filter(Boolean).join('; '),
                safeToUncover: safeToUncoverOnFailure
              }
            }
          })
        } catch (error: unknown) {
          return {
            success: false,
            error: String(error),
            safeToUncover: false
          }
        }
      }

      if (process.platform === 'darwin') {
        try {
          const { stdout } = await execFileAsync('osascript', [
            '-e', `tell application "Microsoft PowerPoint" to open "${filePath}"`
          ])
          return { success: true, output: stdout }
        } catch (error: unknown) {
          return { success: false, error: String(error) }
        }
      }

      return { success: false, error: 'Unsupported platform' }
    }
  )

  // Снимок живого slideshow-окна PP через PrintWindow(PW_RENDERFULLCONTENT).
  // Вызывается ПОСЛЕ launchPowerPoint в hybrid-флоу для PPTX→PPTX: кадр,
  // который PP только что отрисовал, захватывается в PNG и подкладывается
  // в оверлей перед hideOverlay. Оверлей и PP показывают пиксель-в-пиксель
  // одно изображение — композиторная гонка DWM перестаёт быть видимой.
  ipcMain.handle('snapshot-slideshow', async (): Promise<string | null> => {
    if (process.platform !== 'win32') return null
    try {
      const res = await pptDaemon.send('snapshot', {}, 5000)
      if (res.ok && res.path) return res.path
    } catch { /* ignore */ }
    return null
  })

  // Render a single PDF page to PNG via Windows.Data.Pdf (native WinRT engine).
  // pdf.js has a bug truncating renders for PDFs with TilingPattern at scale>1,
  // which corrupts presentation slides exported from PowerPoint. Native engine
  // renders pixel-perfect at any size. Results are cached on disk by content
  // hash to keep navigation snappy.
  ipcMain.handle('render-pdf-page', async (_event, filePath: string, pageIndex: number, width: number): Promise<string | null> => {
    if (process.platform !== 'win32') return null
    if (nativePdfRendererDisabledReason) {
      diagnosticLog(
        'pdf-render',
        `native skipped page=${pageIndex + 1} reason=${nativePdfRendererDisabledReason}`
      )
      return null
    }
    const started = Date.now()
    try {
      const renderWidth = Math.max(64, Math.min(16384, Math.round(width)))
      const st = await stat(filePath)
      // v3 invalidates both visually uniform frames and PNGs whose physical
      // dimensions were incorrectly enlarged by Windows display scaling.
      const key = createHash('md5').update(`native-pdf-v3|${filePath}|${st.mtimeMs}|${st.size}|${pageIndex}|${renderWidth}`).digest('hex')
      const outPath = join(tmpdir(), `pdm-pdfpage-${key}.png`)
      const rejectedPath = `${outPath}.rejected`

      const existing = pdfPageRenderInflight.get(key)
      if (existing) {
        diagnosticLog('pdf-render', `join inflight page=${pageIndex + 1} width=${renderWidth} file=${filePath}`)
        return await existing
      }

      if (existsSync(outPath)) {
        diagnosticLog('pdf-render', `cache hit page=${pageIndex + 1} width=${renderWidth} file=${filePath}`)
        return outPath
      }

      // A marker is written only when Windows.Data.Pdf returned a valid but
      // visually uniform frame. The cache key includes file metadata, page and
      // width, so it is safe to skip the slow native attempt for this exact
      // render and immediately use the reliable pdf.js fallback.
      if (existsSync(rejectedPath)) {
        diagnosticLog('pdf-render', `negative cache hit page=${pageIndex + 1} width=${renderWidth} file=${filePath}`)
        return null
      }

      const job = (async (): Promise<string | null> => {
        const script = resolveScript('render-pdf-page.ps1')
        diagnosticLog('pdf-render', `native start page=${pageIndex + 1} width=${renderWidth} file=${filePath}`)
        const { stdout, stderr } = await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', script,
          '-PdfPath', filePath,
          '-PageIndex', String(pageIndex),
          '-OutPath', outPath,
          '-Width', String(renderWidth)
        ], { timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
        if (!existsSync(outPath)) {
          const rejected = existsSync(rejectedPath)
          diagnosticLog(
            'pdf-render',
            `${rejected ? 'native rejected' : 'native missing output'} page=${pageIndex + 1} width=${renderWidth} dur=${Date.now() - started}ms stdout=${String(stdout).trim()} stderr=${String(stderr).trim()}`
          )
          return null
        }
        diagnosticLog(
          'pdf-render',
          `native success page=${pageIndex + 1} width=${renderWidth} dur=${Date.now() - started}ms output=${String(stdout).trim()}`
        )
        return outPath
      })()

      pdfPageRenderInflight.set(key, job)
      try {
        return await job
      } finally {
        if (pdfPageRenderInflight.get(key) === job) pdfPageRenderInflight.delete(key)
      }
    } catch (e) {
      if (isNativePdfRendererPolicyFailure(e)) {
        nativePdfRendererDisabledReason = 'PowerShell policy: DotSourceNotSupported'
        diagnosticLog(
          'pdf-render',
          `native disabled for session after policy failure page=${pageIndex + 1}`
        )
      }
      diagnosticLog('pdf-render', `native failed page=${pageIndex + 1} width=${width} dur=${Date.now() - started}ms ${formatDiagnosticError(e)}`)
      return null
    }
  })

  ipcMain.handle('powerpoint-command', async (
    _event,
    command: string,
    arg?: number | { stopAtBoundary?: boolean }
  ) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    console.log(`[IPC ${Date.now()}] powerpoint-command: BEGIN command=${command} arg=${arg}`)
    try {
      const t0 = Date.now()
      let res = command === 'goto' && typeof arg === 'number'
        ? await pptDaemon.send('goto', { slide: arg })
        : await pptDaemon.send(
          command,
          typeof arg === 'object' && arg !== null
            ? { stopAtBoundary: arg.stopAtBoundary === true }
            : {},
          // CLOSE performs only an exact-HWND Win32 hide before its ACK; all
          // potentially slow COM retirement happens afterward under the
          // daemon cleanup barrier. Never detach this tiny mutating prefix:
          // a finite timeout could report failure and then hide the slideshow
          // later, diverging physical output from renderer state.
          command === 'close' ? 0 : 20_000
        )
      if (command === 'close' && !res.ok) {
        for (let attempt = 2; attempt <= 3 && !res.ok; attempt++) {
          diagnosticLog(
            'pptx-lifecycle',
            `close retry attempt=${attempt} previousError=${res.error ?? '-'}`
          )
          await new Promise((resolve) => setTimeout(resolve, attempt * 150))
          res = await pptDaemon.send('close', {}, 0)
        }
      }
      if (command === 'close' && res.ok) {
        setActivePowerPointSceneLayout(null)
        setActivePowerPointZoom(null)
      }
      if (command === 'close' && !controlWindow.isDestroyed()) {
        // PowerPoint owns the foreground while its slideshow is running. When
        // that HWND is destroyed Windows can promote Explorer/Start unless a
        // real operator window explicitly takes focus.
        if (controlWindow.isMinimized()) controlWindow.restore()
        controlWindow.focus()
        diagnosticLog('window', 'control focused after PowerPoint close')
      }
      console.log(`[IPC ${Date.now()}] powerpoint-command: END command=${command} ok=${res.ok} slide=${res.slide} dur=${Date.now() - t0}ms`)
      const output = JSON.stringify({
        Status: res.ok ? 'ok' : 'error',
        CurrentSlide: res.slide,
        Boundary: res.boundary === true,
        Message: res.error
      })
      return {
        success: res.ok,
        output,
        error: res.ok ? undefined : (res.error || `PowerPoint command failed: ${command}`)
      }
    } catch (error: unknown) {
      console.log(`[IPC ${Date.now()}] powerpoint-command: ERROR ${String(error)}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('prepare-pptx-cache', async (event, filePath: string) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    try {
      const result = await preparePptxCache(filePath, 1920, 1080, (progress: PptxCacheProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send('pptx-cache-progress', progress)
      })
      return { success: true, ...result }
    } catch (error) {
      diagnosticLog('pptx-cache', `failed ${formatDiagnosticError(error)}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('generate-pptx-thumbnails', async (_event, filePath: string) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    try {
      const result = await preparePptxCache(filePath)
      return { success: true, thumbnails: result.thumbnails, slideCount: result.slideCount }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('relocate-powerpoint', async (
    _event,
    displayId: number,
    sceneLayout?: ProgramSceneLayoutConfig
  ) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    try {
      const displays = screen.getAllDisplays()
      const explicitlyRequestedDisplay = displays.find((display) => display.id === displayId)
      if (!explicitlyRequestedDisplay) {
        diagnosticLog('window', `PowerPoint output relocate refused: display=${displayId} is disconnected`)
        return { success: false, error: 'Target display is not connected' }
      }
      const targetDisplay = explicitlyRequestedDisplay
      if (!targetDisplay) return { success: false, error: 'Target display is not connected' }
      const effectiveSceneLayout = sceneLayout === undefined
        ? getActivePowerPointSceneLayout() ?? undefined
        : sceneLayout
      const placement = getPowerPointNativePlacement(targetDisplay, effectiveSceneLayout)
      const presentationWindow = getPresentationWindow()
      let underlayHwnd = 0
      if (
        effectiveSceneLayout?.enabled &&
        presentationWindow &&
        !presentationWindow.isDestroyed()
      ) {
        const nativeHandle = presentationWindow.getNativeWindowHandle()
        underlayHwnd = nativeHandle.length >= 8
          ? Number(nativeHandle.readBigUInt64LE(0))
          : nativeHandle.readUInt32LE(0)
      }
      const result = await pptDaemon.send('relocate', {
        ...placement,
        underlayHwnd,
        transitionDurationMs: Math.max(
          0,
          Math.min(5000, Math.round(effectiveSceneLayout?.transitionDurationMs ?? 0))
        )
      }, Math.max(5000, Math.round(effectiveSceneLayout?.transitionDurationMs ?? 0) + 3000))
      if (result.ok && sceneLayout !== undefined) {
        setActivePowerPointSceneLayout(sceneLayout.enabled ? sceneLayout : null)
      }
      diagnosticLog(
        'window',
        `PowerPoint output relocate display=${targetDisplay.id} bounds=${JSON.stringify(placement.bounds)} ok=${result.ok}`
      )
      return { success: result.ok, error: result.error }
    } catch (error) {
      diagnosticLog('window', `PowerPoint output relocate failed: ${formatDiagnosticError(error)}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('get-pptx-slide-notes', async (_event, filePath: string, slide: number) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    try {
      const result = await pptDaemon.send('notes', { path: filePath, slide }, 20000)
      return result.ok
        ? { success: true, notes: result.notes || '' }
        : { success: false, error: result.error || 'PowerPoint notes are unavailable' }
    } catch (error) {
      diagnosticLog('pptx-notes', `failed file=${filePath} slide=${slide} ${formatDiagnosticError(error)}`)
      return { success: false, error: String(error) }
    } finally {
      const released = await syncPreparedPowerPointsInternal([], `slide-notes:${filePath}:${slide}`)
      if (!released.success) {
        return {
          success: false,
          error: released.error || 'PowerPoint notes resources were not released'
        }
      }
    }
  })

  ipcMain.handle('generate-pptx-slides', async (_event, filePath: string, width?: number, height?: number) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    const w = width && width > 0 ? width : 1920
    const h = height && height > 0 ? height : 1080
    try {
      const result = await preparePptxCache(filePath, w, h)
      return { success: true, slides: result.slides, slideCount: result.slideCount }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('read-file', async (_event, filePath: string) => {
    const buffer = await readFile(filePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

  ipcMain.handle('select-scene-layer-files', async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Добавить слой',
      filters: [{ name: 'Картинки и видео', extensions: [
        'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'svg',
        'mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v'
      ] }]
    })
    return result.canceled ? null : result.filePaths
  })

  ipcMain.handle('select-backdrop-image', async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      properties: ['openFile'],
      title: 'Select Backdrop Image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('select-information-media', async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      properties: ['openFile'],
      title: 'Выберите файл для информационного дисплея',
      filters: [
        {
          name: 'Презентации и мультимедиа',
          extensions: [
            'ppt', 'pptx', 'pptm', 'pps', 'ppsx',
            'pdf',
            'mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v',
            'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'svg'
          ]
        },
        { name: 'PowerPoint', extensions: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Видео', extensions: ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v'] },
        { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'svg'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('get-audio-devices', async () => {
    if (process.platform !== 'win32') return []
    try {
      const devices = await runAudioControlJson<Array<{ id: string; name: string; isDefault: boolean }>>('list')
      diagnosticLog('audio', `device list success count=${devices.length} names=${JSON.stringify(devices.map((d) => d.name))}`)
      return devices
    } catch (error) {
      diagnosticLog('audio', `device list failed ${formatDiagnosticError(error)}`)
      return []
    }
  })

  ipcMain.handle('set-audio-device', async (_event, deviceId: string) => {
    if (process.platform !== 'win32') return { success: false }
    try {
      await enqueueAudioMutation('set-preferred', async () => {
        await ensureAudioPreferenceLoaded()
        await setDefaultAudioDevice(deviceId)
        preferredAudioDeviceId = deviceId
        await saveAudioPreference()
        diagnosticLog('audio', `preferred device saved id=${JSON.stringify(deviceId)}`)
      })
      return { success: true }
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('switch-audio-to-external', async () => {
    if (process.platform !== 'win32') return { success: false }
    try {
      return await enqueueAudioMutation('ensure-preferred', async () => {
        await ensureAudioPreferenceLoaded()
        const current = await runAudioControlJson<{ id: string; name: string }>('get-default')

        // First-run migration: never guess an "external" device by taking the
        // first non-default endpoint. That made two endpoints alternate on
        // every channel switch. Adopt and persist the user's current Windows
        // default until they explicitly choose another output in Settings.
        if (!preferredAudioDeviceId) {
          preferredAudioDeviceId = current.id
          await saveAudioPreference()
          diagnosticLog(
            'audio',
            `adopted current Windows default as preferred name=${JSON.stringify(current.name)}`
          )
          return { success: true, device: current.name }
        }

        if (current.id === preferredAudioDeviceId) {
          diagnosticLog('audio', `preferred device already active name=${JSON.stringify(current.name)}`)
          return { success: true, device: current.name }
        }

        const devices = await runAudioControlJson<Array<{ id: string; name: string; isDefault: boolean }>>('list')
        const preferred = devices.find((device) => device.id === preferredAudioDeviceId)
        if (!preferred) {
          diagnosticLog('audio', 'saved preferred device is disconnected; leaving Windows default unchanged')
          return { success: false, error: 'Preferred audio device is unavailable' }
        }

        if (!originalAudioDeviceId) originalAudioDeviceId = current.id
        await setDefaultAudioDevice(preferredAudioDeviceId)
        diagnosticLog('audio', `switched to preferred name=${JSON.stringify(preferred.name)}`)
        return { success: true, device: preferred.name }
      })
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('restore-audio-device', async () => {
    if (process.platform !== 'win32' || !originalAudioDeviceId) return
    try {
      await enqueueAudioMutation('restore-original', async () => {
        if (!originalAudioDeviceId) return
        const restoreId = originalAudioDeviceId
        await setDefaultAudioDevice(restoreId)
        originalAudioDeviceId = null
      })
    } catch { /* ignore */ }
  })

  ipcMain.handle('open-file-external', async (_event, filePath: string, displayBounds?: { x: number; y: number; width: number; height: number }) => {
    if (externalShutdownStarted) {
      return { success: false, error: 'PDM is shutting down; external file open was cancelled.' }
    }
    return enqueueExternalOperation(async () => {
      if (!isOpenable(filePath)) return { success: false, error: 'Недопустимый тип файла для внешнего открытия' }
      try {
        if (displayBounds && process.platform === 'win32') {
          const nativeBounds = getNativeExternalDisplayBounds(displayBounds)!
          const scriptPath = resolveScript('manage-window.ps1')
          const { stdout } = await execFileAsync('powershell.exe', [
            '-ExecutionPolicy', 'Bypass',
            '-NoProfile',
            '-File', scriptPath,
            '-Action', 'open',
            '-FilePath', filePath,
            '-X', String(nativeBounds.x),
            '-Y', String(nativeBounds.y),
            '-Width', String(nativeBounds.width),
            '-Height', String(nativeBounds.height)
          ], { timeout: 70_000 })
          const data = JSON.parse(stdout.trim()) as {
            success?: boolean
            hwnd?: number
            pid?: number
            windowTitle?: string
            windowClass?: string
            owned?: boolean
            error?: string
          }
          if (data.hwnd) {
            // Keep a failed-but-created HWND tracked as well. The PowerShell
            // helper parks it on verification failure, and a later TAKE can
            // retry or close that exact window instead of leaving an orphan.
            externalFiles.set(filePath, {
              hwnd: data.hwnd,
              pid: data.pid || 0,
              windowTitle: data.windowTitle || '',
              windowClass: data.windowClass || '',
              owned: data.owned === true
            })
          }
          if (!data.success || !data.hwnd) {
            return {
              success: false,
              error: data.error || 'The application window was not placed on the target display.'
            }
          }
          return { success: true }
        }
        await shell.openPath(filePath)
        return { success: true }
      } catch (error: unknown) {
        return { success: false, error: String(error) }
      }
    })
  })

  ipcMain.handle('select-qr-logo', async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      properties: ['openFile'],
      title: 'Выберите логотип для QR-кода',
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'svg'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('select-qr-image', async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      properties: ['openFile'],
      title: 'Выберите изображение QR-кода',
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'svg'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('set-powerpoint-zoom', async (
    _event,
    displayId: number,
    zoom: Partial<ContentZoomState>
  ) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    try {
      const targetDisplay = screen.getAllDisplays().find((display) => display.id === displayId)
      if (!targetDisplay) return { success: false, error: 'Target display is not connected' }
      const normalized = setActivePowerPointZoom(zoom)
      const placement = getPowerPointNativePlacement(targetDisplay, undefined, normalized)
      const result = await pptDaemon.send('relocate', placement, 5000)
      diagnosticLog(
        'window',
        `PowerPoint magnifier scale=${normalized.scale.toFixed(2)} ` +
        `origin=${normalized.originX.toFixed(3)},${normalized.originY.toFixed(3)} ok=${result.ok}`
      )
      return { success: result.ok, error: result.error }
    } catch (error) {
      diagnosticLog('window', `PowerPoint magnifier failed: ${formatDiagnosticError(error)}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('set-external-file-zoom', async (
    _event,
    filePath: string,
    zoom: Partial<ContentZoomState>
  ): Promise<ExternalWindowActionResult & { zoomPercent?: number }> => {
    if (externalShutdownStarted) {
      return { success: false, error: 'PDM is shutting down; Office zoom was cancelled.' }
    }
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    return enqueueExternalOperation(async () => {
      const entry = externalFiles.get(filePath)
      if (!entry) return { success: false, error: 'Окно Word/Excel больше не найдено.' }
      const extension = extname(filePath).toLowerCase()
      if (!['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.ods'].includes(extension)) {
        return { success: false, error: 'Лупа поддерживается только для Word и Excel.' }
      }
      const normalized = normalizeContentZoom(zoom)
      const scriptPath = resolveScript('manage-window.ps1')
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', scriptPath,
          '-Action', 'zoom-office',
          '-Hwnd', String(entry.hwnd),
          '-ProcessId', String(entry.pid),
          '-FilePath', filePath,
          '-ExpectedWindowTitle', entry.windowTitle,
          '-ExpectedWindowClass', entry.windowClass,
          '-ZoomEnabled', normalized.enabled ? '1' : '0',
          '-ZoomPercent', String(Math.round(normalized.scale * 100)),
          '-OriginX', String(Math.round(normalized.originX * 10_000)),
          '-OriginY', String(Math.round(normalized.originY * 10_000))
        ], { timeout: 7_000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
        const data = JSON.parse(stdout.trim()) as ExternalWindowActionResult & { zoomPercent?: number }
        diagnosticLog(
          'window',
          `Office magnifier file=${basename(filePath)} scale=${normalized.scale.toFixed(2)} ` +
          `origin=${normalized.originX.toFixed(3)},${normalized.originY.toFixed(3)} ok=${data.success}`
        )
        return data.success
          ? data
          : { success: false, error: data.error || 'Word/Excel не применил масштаб.' }
      } catch (error) {
        diagnosticLog('window', `Office magnifier failed: ${formatDiagnosticError(error)}`)
        return { success: false, error: String(error) }
      }
    })
  })

  ipcMain.handle('close-external-file', (_event, filePath?: string) => closeExternalFile(filePath))

  ipcMain.handle('minimize-external-file', (_event, filePath?: string) => manageExternalWindow('minimize', filePath))

  ipcMain.handle('restore-external-file', async (
    _event,
    filePath?: string,
    displayBounds?: ExternalDisplayBounds,
    sceneLayout?: ProgramSceneLayoutConfig
  ): Promise<ExternalWindowActionResult> => {
    if (externalShutdownStarted) {
      return { success: false, error: 'PDM is shutting down; external file restore was cancelled.' }
    }
    return enqueueExternalOperation(async () => {
      const placement = getExternalWindowPlacement(displayBounds, sceneLayout)
      if (displayBounds && !placement) {
        return { success: false, error: 'Целевой дисплей для окна Word/Excel больше не найден.' }
      }
      // If not tracked yet, open instead of restore
      if (filePath && !externalFiles.has(filePath)) {
        if (!isOpenable(filePath)) return { success: false, error: 'Недопустимый тип файла.' }
        if (placement && process.platform === 'win32') {
          const scriptPath = resolveScript('manage-window.ps1')
          try {
            const args = [
              '-ExecutionPolicy', 'Bypass',
              '-NoProfile',
              '-File', scriptPath,
              '-Action', 'open',
              '-FilePath', filePath
            ]
            appendExternalPlacementArgs(args, placement)
            const { stdout } = await execFileAsync('powershell.exe', args, { timeout: 70_000 })
            const data = JSON.parse(stdout.trim()) as {
              success?: boolean
              hwnd?: number
              pid?: number
              windowTitle?: string
              windowClass?: string
              owned?: boolean
              error?: string
            }
            if (data.hwnd) {
              externalFiles.set(filePath, {
                hwnd: data.hwnd,
                pid: data.pid || 0,
                windowTitle: data.windowTitle || '',
                windowClass: data.windowClass || '',
                owned: data.owned === true
              })
            }
            if (!data.success || !data.hwnd) {
              return { success: false, error: data.error || 'Окно программы не найдено после открытия.' }
            }
          } catch (error) {
            return { success: false, error: String(error) }
          }
        } else {
          const error = await shell.openPath(filePath)
          if (error) return { success: false, error }
        }
        return { success: true }
      }
      return manageExternalWindowUnlocked('restore', filePath, placement)
    })
  })

  ipcMain.handle('select-sound-file', async () => {
    const result = await dialog.showOpenDialog(controlWindow, {
      properties: ['openFile'],
      title: 'Выберите звуковой файл',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('move-file', async (_event, srcPath: string, destFolder: string) => {
    try {
      const fileName = basename(srcPath)
      const destPath = join(destFolder, fileName)
      await rename(srcPath, destPath)
      return { success: true, newPath: destPath }
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('hide-taskbar', async (_event, displayBounds: { x: number; y: number; width: number; height: number }) => {
    await hideTaskbarForDisplay(
      displayBounds,
      controlWindow.isDestroyed() ? undefined : controlWindow.getBounds()
    )
  })

  ipcMain.handle('show-taskbar', async () => {
    await showAllTaskbars()
  })

  ipcMain.handle('get-drives', async () => {
    if (process.platform !== 'win32') return []
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root } | ForEach-Object {
          $used = $_.Used; $free = $_.Free; $total = if ($used -ne $null -and $free -ne $null) { $used + $free } else { 0 }
          [PSCustomObject]@{ Name=$_.Name; Root=$_.Root; Description=$_.Description; Used=$used; Free=$free; Total=$total; IsRemovable=($_.Root -ne $null) }
        } | ConvertTo-Json -Compress`
      ], { timeout: 5000 })
      const parsed = JSON.parse(stdout.trim())
      // Ensure array
      const drives = Array.isArray(parsed) ? parsed : [parsed]
      // Detect removable drives
      const { stdout: wmiOut } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-WmiObject Win32_LogicalDisk | Select-Object DeviceID, DriveType | ConvertTo-Json -Compress`
      ], { timeout: 5000 })
      const wmiParsed = JSON.parse(wmiOut.trim())
      const wmiDrives = Array.isArray(wmiParsed) ? wmiParsed : [wmiParsed]
      const removableSet = new Set(wmiDrives.filter((d: { DriveType: number }) => d.DriveType === 2).map((d: { DeviceID: string }) => d.DeviceID))

      return drives.map((d: { Name: string; Root: string; Description: string; Total: number; Free: number }) => ({
        name: d.Name,
        root: d.Root,
        label: d.Description || d.Name,
        totalSize: d.Total || 0,
        freeSize: d.Free || 0,
        isRemovable: removableSet.has(d.Name + ':')
      }))
    } catch {
      return []
    }
  })

  ipcMain.handle('rename-file', async (_event, filePath: string, newName: string) => {
    try {
      // Guard (CWE-23): newName must be a bare file name. basename() strips any
      // directory part, so a value containing \ or / or '..' is rejected before
      // it can escape the file's folder. Legit renames never contain separators.
      if (!newName || newName !== basename(newName) || newName === '.' || newName === '..' || /[:<>"|?*\\/]/.test(newName)) {
        return { success: false, error: 'Недопустимое имя файла' }
      }
      const dir = join(filePath, '..')
      const ext = extname(filePath)
      const newPath = join(dir, newName + ext)
      if (existsSync(newPath)) {
        return { success: false, error: 'Файл с таким именем уже существует' }
      }
      await rename(filePath, newPath)
      return { success: true, newPath }
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('copy-files-to-folder', async (_event, filePaths: string[], destFolder: string) => {
    const results: { success: boolean; name: string; error?: string }[] = []
    for (const srcPath of filePaths) {
      try {
        const name = basename(srcPath)
        const destPath = join(destFolder, name)
        await copyFile(srcPath, destPath)
        results.push({ success: true, name })
      } catch (error: unknown) {
        results.push({ success: false, name: basename(srcPath), error: String(error) })
      }
    }
    return results
  })

  // Delete to recycle bin (shell) or permanently (shift+del)
  ipcMain.handle('delete-items', async (_event, paths: string[], permanent: boolean) => {
    const results: { success: boolean; path: string; error?: string }[] = []
    for (const itemPath of paths) {
      try {
        if (permanent) {
          const s = await stat(itemPath)
          if (s.isDirectory()) {
            // NO force: respect the read-only attribute + NTFS ACLs exactly as
            // Windows Explorer does. A read-only or permission-denied file throws
            // here instead of being silently bypassed — the app never deletes
            // anything the user couldn't delete through standard Windows.
            await rm(itemPath, { recursive: true })
          } else {
            await rm(itemPath)
          }
        } else {
          // Move to recycle bin via shell
          await shell.trashItem(itemPath)
        }
        results.push({ success: true, path: itemPath })
      } catch (error: unknown) {
        results.push({ success: false, path: itemPath, error: String(error) })
      }
    }
    return results
  })

  // Copy folders recursively
  ipcMain.handle('copy-items-to-folder', async (_event, srcPaths: string[], destFolder: string) => {
    const results: { success: boolean; name: string; error?: string }[] = []
    for (const srcPath of srcPaths) {
      try {
        const name = basename(srcPath)
        const destPath = join(destFolder, name)
        const s = await stat(srcPath)
        if (s.isDirectory()) {
          await cp(srcPath, destPath, { recursive: true })
        } else {
          await copyFile(srcPath, destPath)
        }
        results.push({ success: true, name })
      } catch (error: unknown) {
        results.push({ success: false, name: basename(srcPath), error: String(error) })
      }
    }
    return results
  })

  // Move folder (rename across same drive)
  ipcMain.handle('move-item', async (_event, srcPath: string, destFolder: string) => {
    try {
      const name = basename(srcPath)
      const destPath = join(destFolder, name)
      await rename(srcPath, destPath)
      return { success: true, newPath: destPath }
    } catch (error: unknown) {
      // rename fails across drives — fall back to copy+delete
      try {
        const name = basename(srcPath)
        const destPath = join(destFolder, name)
        const s = await stat(srcPath)
        if (s.isDirectory()) {
          await cp(srcPath, destPath, { recursive: true })
          // NO force — respect read-only / NTFS permissions (see delete-items).
          await rm(srcPath, { recursive: true })
        } else {
          await copyFile(srcPath, destPath)
          await rm(srcPath)
        }
        return { success: true, newPath: destPath }
      } catch (err: unknown) {
        return { success: false, error: String(err) }
      }
    }
  })

  ipcMain.handle('generate-doc-preview', async (_event, filePath: string) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    const scriptPath = resolveScript('document-preview.ps1')
    try {
      // -File + argv (см. F-004, audit 2026-04-20).
      const { stdout } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-FilePath', filePath
      ], { timeout: 60000, encoding: 'utf8' })
      const data = JSON.parse(stdout.trim())
      if (data.Status === 'ok') {
        return { success: true, pdfPath: data.Path }
      }
      return { success: false, error: data.Error || 'Unknown error' }
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
  })
}
