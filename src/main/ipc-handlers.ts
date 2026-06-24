import { BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { readdir, stat, readFile, rename, copyFile, rm, cp, mkdir } from 'fs/promises'
import { join, extname, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { scriptPath as resolveScript } from './paths'
import { pptDaemon } from './powerpoint-daemon'

const execFileAsync = promisify(execFile)

let originalAudioDeviceId: string | null = null
let preferredAudioDeviceId: string | null = null // set by user in Settings
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

  ipcMain.handle(
    'launch-powerpoint',
    async (_event, filePath: string, _monitorIndex?: number, startSlide?: number) => {
      if (process.platform === 'win32') {
        try {
          const args: Record<string, unknown> = { path: filePath }
          if (typeof startSlide === 'number' && startSlide > 1) {
            args.slide = startSlide
          }
          console.log(`[IPC ${Date.now()}] launch-powerpoint: daemon.send('open') BEGIN slide=${startSlide ?? 1}`)
          const res = await pptDaemon.send('open', args, 60000)
          console.log(`[IPC ${Date.now()}] launch-powerpoint: daemon.send('open') END ok=${res.ok}`)
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
    try {
      const st = await stat(filePath)
      const key = createHash('md5').update(`${filePath}|${st.mtimeMs}|${st.size}|${pageIndex}|${width}`).digest('hex')
      const outPath = join(tmpdir(), `pdm-pdfpage-${key}.png`)
      if (existsSync(outPath)) return outPath
      const script = resolveScript('render-pdf-page.ps1')
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', script,
        '-PdfPath', filePath,
        '-PageIndex', String(pageIndex),
        '-OutPath', outPath,
        '-Width', String(width)
      ], { timeout: 15000 })
      return existsSync(outPath) ? outPath : null
    } catch (e) {
      console.error('[IPC] render-pdf-page error:', e)
      return null
    }
  })

  ipcMain.handle('powerpoint-command', async (_event, command: string, arg?: number) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    console.log(`[IPC ${Date.now()}] powerpoint-command: BEGIN command=${command} arg=${arg}`)
    try {
      const t0 = Date.now()
      const res = command === 'goto' && typeof arg === 'number'
        ? await pptDaemon.send('goto', { slide: arg })
        : await pptDaemon.send(command)
      console.log(`[IPC ${Date.now()}] powerpoint-command: END command=${command} ok=${res.ok} slide=${res.slide} dur=${Date.now() - t0}ms`)
      const output = JSON.stringify({
        Status: res.ok ? 'ok' : 'error',
        CurrentSlide: res.slide,
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
      const scriptPath = resolveScript('powerpoint-control.ps1')
      try {
        // -File + argv: filePath уходит как literal argument, не через shell-
        // строку. Иначе имя файла вроде `a"; rm -rf; echo "` → command
        // injection (F-002, audit 2026-04-20).
        const { stdout } = await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', scriptPath,
          '-Action', 'thumbnails',
          '-FilePath', filePath
        ], { timeout: 30000, encoding: 'utf8' })
        const data = JSON.parse(stdout)
        if (data.Status === 'ok') {
          const thumbDir = data.ThumbnailDir
          const thumbFiles: string[] = []
          for (let i = 1; i <= data.SlideCount; i++) {
            thumbFiles.push(join(thumbDir, `slide_${i}.png`))
          }
          return { success: true, thumbnails: thumbFiles, slideCount: data.SlideCount }
        }
        return { success: false, error: stdout }
      } catch (error: unknown) {
        return { success: false, error: String(error) }
      }
    }
    return { success: false, error: 'Unsupported platform' }
  })

  ipcMain.handle('generate-pptx-slides', async (_event, filePath: string, width?: number, height?: number) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    const scriptPath = resolveScript('powerpoint-control.ps1')
    const w = width && width > 0 ? width : 1920
    const h = height && height > 0 ? height : 1080
    try {
      // -File + argv (см. F-003, audit 2026-04-20).
      const { stdout } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'renderslides',
        '-FilePath', filePath,
        '-Width', String(w),
        '-Height', String(h)
      ], { timeout: 120000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
      const data = JSON.parse(stdout)
      if (data.Status === 'ok') {
        const slidesDir = data.SlidesDir
        const slides: string[] = []
        for (let i = 1; i <= data.SlideCount; i++) {
          slides.push(join(slidesDir, `slide_${i}.png`))
        }
        return { success: true, slides, slideCount: data.SlideCount }
      }
      return { success: false, error: stdout }
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
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

  ipcMain.handle('get-audio-devices', async () => {
    if (process.platform !== 'win32') return []
    try {
      const scriptPath = resolveScript('audio-control.ps1')
      const { stdout } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${scriptPath.replace(/'/g, "''")}' -Action list`
      ], { encoding: 'utf8' })
      return JSON.parse(stdout.trim())
    } catch {
      return []
    }
  })

  ipcMain.handle('set-audio-device', async (_event, deviceId: string) => {
    if (process.platform !== 'win32') return { success: false }
    try {
      const scriptPath = resolveScript('audio-control.ps1')
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'set',
        '-DeviceId', deviceId
      ])
      preferredAudioDeviceId = deviceId
      return { success: true }
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('switch-audio-to-external', async () => {
    if (process.platform !== 'win32') return { success: false }
    try {
      const scriptPath = resolveScript('audio-control.ps1')

      // If user chose a preferred device in Settings, use it
      if (preferredAudioDeviceId) {
        // Save current default so we can restore later
        const { stdout: defaultOut } = await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', scriptPath,
          '-Action', 'get-default'
        ])
        const current = JSON.parse(defaultOut.trim())
        if (!originalAudioDeviceId) originalAudioDeviceId = current.id

        // Already set to preferred? Skip
        if (current.id === preferredAudioDeviceId) {
          return { success: true, device: current.name }
        }

        await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', scriptPath,
          '-Action', 'set',
          '-DeviceId', preferredAudioDeviceId
        ])
        return { success: true, device: preferredAudioDeviceId }
      }

      // Auto-detect: get current default before switching
      const { stdout: defaultOut } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'get-default'
      ])
      const current = JSON.parse(defaultOut.trim())
      originalAudioDeviceId = current.id

      // Get all devices and find a non-default one (external)
      const { stdout: listOut } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'list'
      ])
      const devices = JSON.parse(listOut.trim())
      const external = devices.find((d: { isDefault: boolean }) => !d.isDefault)
      if (!external) return { success: false, error: 'No external audio device found' }

      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'set',
        '-DeviceId', external.id
      ])
      return { success: true, device: external.name }
    } catch (error: unknown) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('restore-audio-device', async () => {
    if (process.platform !== 'win32' || !originalAudioDeviceId) return
    try {
      const scriptPath = resolveScript('audio-control.ps1')
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'set',
        '-DeviceId', originalAudioDeviceId
      ])
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
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath,
        '-Action', 'hide-taskbar',
        '-X', String(displayBounds.x),
        '-Y', String(displayBounds.y),
        '-Width', String(displayBounds.width),
        '-Height', String(displayBounds.height)
      ], { timeout: 5000 })
    } catch { /* ignore */ }
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
      if (!newName || newName !== basename(newName) || newName === '.' || newName === '..') {
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
            await rm(itemPath, { recursive: true, force: true })
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
          await rm(srcPath, { recursive: true, force: true })
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
