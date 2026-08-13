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
import {
  diagnosticLog,
  formatDiagnosticError,
  getDiagnosticLogDirectory
} from './diagnostic-log'

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

async function readPptxExportCache(directory: string): Promise<string[] | null> {
  try {
    const count = Number((await readFile(join(directory, 'complete.txt'), 'utf8')).trim())
    if (!Number.isInteger(count) || count < 1) return null
    const images: string[] = []
    for (let i = 1; i <= count; i++) {
      const imagePath = join(directory, `slide_${i}.png`)
      if (!existsSync(imagePath)) return null
      images.push(imagePath)
    }
    return images
  } catch {
    return null
  }
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

// Map of file path -> { hwnd, pid } for tracking multiple external windows
const externalFiles = new Map<string, { hwnd: number; pid: number }>()


async function manageExternalWindow(action: 'minimize' | 'restore' | 'close', filePath?: string, bounds?: { x: number; y: number; width: number; height: number }): Promise<void> {
  const scriptPath = resolveScript('manage-window.ps1')

  if (filePath) {
    const entry = externalFiles.get(filePath)
    if (!entry) return
    try {
      const args = [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', action,
        '-Hwnd', String(entry.hwnd),
        '-ProcessId', String(entry.pid),
        '-FilePath', filePath
      ]
      if (bounds && action === 'restore') {
        args.push('-X', String(bounds.x), '-Y', String(bounds.y), '-Width', String(bounds.width), '-Height', String(bounds.height))
      }
      await execFileAsync('powershell.exe', args, { timeout: 5000 })
    } catch { /* ignore */ }
    if (action === 'close') externalFiles.delete(filePath)
  } else {
    // Apply to all tracked files
    for (const [path, entry] of externalFiles) {
      try {
        const args = [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', scriptPath,
          '-Action', action,
          '-Hwnd', String(entry.hwnd),
          '-ProcessId', String(entry.pid)
        ]
        await execFileAsync('powershell.exe', args, { timeout: 5000 })
      } catch { /* ignore */ }
      if (action === 'close') externalFiles.delete(path)
    }
  }
}

export async function closeExternalFile(filePath?: string): Promise<void> {
  await manageExternalWindow('close', filePath)
}

export async function closeAllExternalFiles(): Promise<void> {
  await manageExternalWindow('close')
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
    if (process.platform !== 'win32') return { success: true }
    const paths = Array.isArray(filePaths)
      ? filePaths.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
    try {
      const result = await pptDaemon.send('sync-prepared', { paths }, 60000)
      diagnosticLog(
        'pptx-preload',
        `sync prepared count=${paths.length} ok=${result.ok} error=${result.error ?? '-'}`
      )
      return { success: result.ok, error: result.error }
    } catch (error) {
      diagnosticLog('pptx-preload', `sync prepared failed ${formatDiagnosticError(error)}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(
    'launch-powerpoint',
    async (event, filePath: string, displayId?: number, startSlide?: number) => {
      if (process.platform === 'win32') {
        try {
          const args: Record<string, unknown> = { path: filePath }
          const displays = screen.getAllDisplays()
          const primaryDisplay = screen.getPrimaryDisplay()
          const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
          const targetDisplay = typeof displayId === 'number'
            ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
            : externalDisplay || primaryDisplay

          // Electron bounds are DIP while SetWindowPos expects physical pixels.
          args.bounds = screen.dipToScreenRect(null, targetDisplay.bounds)
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
          let res: Awaited<ReturnType<typeof pptDaemon.send>> = { id: 0, ok: false, error: 'not attempted' }
          for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`[IPC ${Date.now()}] launch-powerpoint: daemon.send('open') BEGIN attempt=${attempt} slide=${startSlide ?? 1} display=${targetDisplay.id} bounds=${JSON.stringify(args.bounds)}`)
            res = await pptDaemon.send('open', args, 60000, (progress) => {
              if (progress.event === 'slideshow-visible' && !event.sender.isDestroyed()) {
                event.sender.send('powerpoint-slideshow-visible', filePath)
              }
            })
            console.log(`[IPC ${Date.now()}] launch-powerpoint: daemon.send('open') END attempt=${attempt} ok=${res.ok} error=${res.error ?? '-'}`)
            if (res.ok) break
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750))
          }
          if (!res.ok) return { success: false, error: res.error || 'open failed' }
          const output = JSON.stringify({
            Status: 'ok',
            SlideCount: res.slideCount ?? 0,
            CurrentSlide: res.slide ?? 1
          })
          return { success: true, output }
        } catch (error: unknown) {
          return { success: false, error: String(error) }
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
      // v2 invalidates pre-fix cache entries: Windows.Data.Pdf used to cache
      // visually uniform white frames as successful renders.
      const key = createHash('md5').update(`native-pdf-v2|${filePath}|${st.mtimeMs}|${st.size}|${pageIndex}|${renderWidth}`).digest('hex')
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
      const res = command === 'goto' && typeof arg === 'number'
        ? await pptDaemon.send('goto', { slide: arg })
        : await pptDaemon.send(
          command,
          typeof arg === 'object' && arg !== null
            ? { stopAtBoundary: arg.stopAtBoundary === true }
            : {}
        )
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
      return { success: res.ok, output }
    } catch (error: unknown) {
      console.log(`[IPC ${Date.now()}] powerpoint-command: ERROR ${String(error)}`)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('generate-pptx-thumbnails', async (_event, filePath: string) => {
    if (process.platform === 'win32') {
      diagnosticLog('pptx-preview', `thumbnail request file=${filePath}`)
      return enqueuePptxExport(`thumbnails:${filePath.toLowerCase()}`, async () => {
        const started = Date.now()
        try {
          const fileStats = await stat(filePath)
          const thumbDir = pptxExportDirectory('thumbs', filePath, fileStats.size, fileStats.mtimeMs, 320, 240)
          diagnosticLog('pptx-preview', `thumbnail start exporter=daemon size=${fileStats.size} mtime=${fileStats.mtime.toISOString()} dir=${thumbDir}`)
          const cached = await readPptxExportCache(thumbDir)
          if (cached) {
            diagnosticLog('pptx-preview', `thumbnail cache hit count=${cached.length} dir=${thumbDir}`)
            return { success: true, thumbnails: cached, slideCount: cached.length }
          }
          const result = await pptDaemon.send('export', {
            path: filePath,
            outputDir: thumbDir,
            width: 320,
            height: 240
          }, 180000)
          if (!result.ok) throw new Error(result.error || 'PowerPoint daemon export failed')
          const thumbFiles = await readPptxExportCache(thumbDir)
          if (!thumbFiles) throw new Error(`PowerPoint daemon returned an incomplete thumbnail export: ${thumbDir}`)
          diagnosticLog('pptx-preview', `thumbnail success exporter=daemon count=${thumbFiles.length} dir=${thumbDir} dur=${Date.now() - started}ms`)
          return { success: true, thumbnails: thumbFiles, slideCount: thumbFiles.length }
        } catch (error: unknown) {
          console.error('[IPC] generate-pptx-thumbnails failed:', error)
          diagnosticLog('pptx-preview', `thumbnail failed file=${filePath} dur=${Date.now() - started}ms ${formatDiagnosticError(error)}`)
          return { success: false, error: String(error) }
        }
      })
    }
    return { success: false, error: 'Unsupported platform' }
  })

  ipcMain.handle('relocate-powerpoint', async (_event, displayId: number) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    try {
      const displays = screen.getAllDisplays()
      const primaryDisplay = screen.getPrimaryDisplay()
      const externalDisplay = displays.find((display) => display.id !== primaryDisplay.id)
      const targetDisplay = displays.find((display) => display.id === displayId) || externalDisplay
      if (!targetDisplay) return { success: false, error: 'Target display is not connected' }
      const bounds = screen.dipToScreenRect(null, targetDisplay.bounds)
      const result = await pptDaemon.send('relocate', { bounds }, 5000)
      diagnosticLog(
        'window',
        `PowerPoint output relocate display=${targetDisplay.id} bounds=${JSON.stringify(bounds)} ok=${result.ok}`
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
    }
  })

  ipcMain.handle('generate-pptx-slides', async (_event, filePath: string, width?: number, height?: number) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    const w = width && width > 0 ? width : 1920
    const h = height && height > 0 ? height : 1080
    diagnosticLog('pptx-preview', `full-slide request file=${filePath} size=${w}x${h}`)
    return enqueuePptxExport(`slides:${filePath.toLowerCase()}:${w}x${h}`, async () => {
      const started = Date.now()
      try {
        const fileStats = await stat(filePath)
        const slidesDir = pptxExportDirectory('slides', filePath, fileStats.size, fileStats.mtimeMs, w, h)
        diagnosticLog('pptx-preview', `full-slide start exporter=daemon fileSize=${fileStats.size} mtime=${fileStats.mtime.toISOString()} output=${w}x${h} dir=${slidesDir}`)
        const cached = await readPptxExportCache(slidesDir)
        if (cached) {
          diagnosticLog('pptx-preview', `full-slide cache hit count=${cached.length} dir=${slidesDir}`)
          return { success: true, slides: cached, slideCount: cached.length }
        }
        const result = await pptDaemon.send('export', {
          path: filePath,
          outputDir: slidesDir,
          width: w,
          height: h
        }, 240000)
        if (!result.ok) throw new Error(result.error || 'PowerPoint daemon export failed')
        const slides = await readPptxExportCache(slidesDir)
        if (!slides) throw new Error(`PowerPoint daemon returned an incomplete full-slide export: ${slidesDir}`)
        diagnosticLog('pptx-preview', `full-slide success exporter=daemon count=${slides.length} dir=${slidesDir} dur=${Date.now() - started}ms`)
        return { success: true, slides, slideCount: slides.length }
      } catch (error: unknown) {
        console.error('[IPC] generate-pptx-slides failed:', error)
        diagnosticLog('pptx-preview', `full-slide failed file=${filePath} dur=${Date.now() - started}ms ${formatDiagnosticError(error)}`)
        return { success: false, error: String(error) }
      }
    })
  })

  ipcMain.handle('read-file', async (_event, filePath: string) => {
    const buffer = await readFile(filePath)
    return buffer.buffer
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
    if (!isOpenable(filePath)) return { success: false, error: 'Недопустимый тип файла для внешнего открытия' }
    try {
      if (displayBounds && process.platform === 'win32') {
        const scriptPath = resolveScript('manage-window.ps1')
        const { stdout } = await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', scriptPath,
          '-Action', 'open',
          '-FilePath', filePath,
          '-X', String(displayBounds.x),
          '-Y', String(displayBounds.y),
          '-Width', String(displayBounds.width),
          '-Height', String(displayBounds.height)
        ], { timeout: 25000 })
        try {
          const data = JSON.parse(stdout.trim())
          if (data.hwnd) {
            externalFiles.set(filePath, { hwnd: data.hwnd, pid: data.pid || 0 })
          }
        } catch { /* ignore */ }
        return { success: true }
      }
      await shell.openPath(filePath)
      return { success: true }
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('close-external-file', (_event, filePath?: string) => closeExternalFile(filePath))

  ipcMain.handle('minimize-external-file', (_event, filePath?: string) => manageExternalWindow('minimize', filePath))

  ipcMain.handle('restore-external-file', async (_event, filePath?: string, displayBounds?: { x: number; y: number; width: number; height: number }) => {
    // If not tracked yet, open instead of restore
    if (filePath && !externalFiles.has(filePath)) {
      if (!isOpenable(filePath)) return
      if (displayBounds && process.platform === 'win32') {
        const scriptPath = resolveScript('manage-window.ps1')
        try {
          const { stdout } = await execFileAsync('powershell.exe', [
            '-ExecutionPolicy', 'Bypass',
            '-NoProfile',
            '-File', scriptPath,
            '-Action', 'open',
            '-FilePath', filePath,
            '-X', String(displayBounds.x),
            '-Y', String(displayBounds.y),
            '-Width', String(displayBounds.width),
            '-Height', String(displayBounds.height)
          ], { timeout: 25000 })
          try {
            const data = JSON.parse(stdout.trim())
            if (data.hwnd) {
              externalFiles.set(filePath, { hwnd: data.hwnd, pid: data.pid || 0 })
            }
          } catch { /* ignore */ }
        } catch { /* ignore */ }
      } else {
        await shell.openPath(filePath!)
      }
      return
    }
    await manageExternalWindow('restore', filePath, displayBounds || undefined)
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
    if (process.platform !== 'win32') return
    const scriptPath = resolveScript('manage-window.ps1')
    try {
      // Renderer display bounds are DIP coordinates, while GetWindowRect in
      // manage-window.ps1 returns physical pixels. Match the authoritative
      // display and convert its complete bounds before comparing taskbars.
      const targetDisplay = screen.getDisplayMatching(displayBounds)
      const physicalBounds = screen.dipToScreenRect(null, targetDisplay.bounds)
      diagnosticLog(
        'display',
        `hide taskbar display=${targetDisplay.id} dip=${JSON.stringify(targetDisplay.bounds)} ` +
        `physical=${JSON.stringify(physicalBounds)}`
      )
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'hide-taskbar',
        '-X', String(physicalBounds.x),
        '-Y', String(physicalBounds.y),
        '-Width', String(physicalBounds.width),
        '-Height', String(physicalBounds.height)
      ], { timeout: 5000 })
    } catch (error) {
      diagnosticLog('display', `hide taskbar failed ${formatDiagnosticError(error)}`)
    }
  })

  ipcMain.handle('show-taskbar', async () => {
    if (process.platform !== 'win32') return
    const scriptPath = resolveScript('manage-window.ps1')
    try {
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'show-taskbar'
      ], { timeout: 5000 })
    } catch { /* ignore */ }
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
