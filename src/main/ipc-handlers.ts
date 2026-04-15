import { BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { readdir, stat, readFile, rename } from 'fs/promises'
import { join, extname, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

let originalAudioDeviceId: string | null = null
// Map of file path -> { hwnd, pid } for tracking multiple external windows
const externalFiles = new Map<string, { hwnd: number; pid: number }>()

async function manageExternalWindow(action: 'minimize' | 'restore' | 'close', filePath?: string, bounds?: { x: number; y: number; width: number; height: number }): Promise<void> {
  const scriptPath = join(__dirname, '../../scripts/manage-window.ps1')

  if (filePath) {
    const entry = externalFiles.get(filePath)
    if (!entry) return
    try {
      const args = [
        '-ExecutionPolicy', 'Bypass',
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

  ipcMain.handle('load-folder', async (_event, folderPath: string) => {
    const entries = await readdir(folderPath)
    const files: FileEntry[] = []
    const subfolders: { name: string; path: string }[] = []

    for (const entry of entries) {
      const fullPath = join(folderPath, entry)
      const stats = await stat(fullPath)

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
    async (_event, filePath: string, _monitorIndex?: number) => {
      if (process.platform === 'win32') {
        const scriptPath = join(__dirname, '../../scripts/powerpoint-control.ps1')
        try {
          const { stdout } = await execFileAsync('powershell.exe', [
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
            '-Action', 'open',
            '-FilePath', filePath
          ])
          return { success: true, output: stdout }
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

  ipcMain.handle('powerpoint-command', async (_event, command: string, arg?: number) => {
    if (process.platform === 'win32') {
      const scriptPath = join(__dirname, '../../scripts/powerpoint-control.ps1')
      const args = [
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Action', command
      ]
      if (arg !== undefined) {
        args.push('-SlideNumber', String(arg))
      }
      try {
        const { stdout } = await execFileAsync('powershell.exe', args)
        return { success: true, output: stdout }
      } catch (error: unknown) {
        return { success: false, error: String(error) }
      }
    }

    return { success: false, error: 'Unsupported platform' }
  })

  ipcMain.handle('generate-pptx-thumbnails', async (_event, filePath: string) => {
    if (process.platform === 'win32') {
      const scriptPath = join(__dirname, '../../scripts/powerpoint-control.ps1')
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & "${scriptPath}" -Action thumbnails -FilePath "${filePath}"`
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
      const scriptPath = join(__dirname, '../../scripts/audio-control.ps1')
      const { stdout } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Action', 'list'
      ])
      return JSON.parse(stdout.trim())
    } catch {
      return []
    }
  })

  ipcMain.handle('switch-audio-to-external', async () => {
    if (process.platform !== 'win32') return { success: false }
    try {
      const scriptPath = join(__dirname, '../../scripts/audio-control.ps1')
      // Get current default before switching
      const { stdout: defaultOut } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Action', 'get-default'
      ])
      const current = JSON.parse(defaultOut.trim())
      originalAudioDeviceId = current.id

      // Get all devices and find a non-default one (external)
      const { stdout: listOut } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Action', 'list'
      ])
      const devices = JSON.parse(listOut.trim())
      const external = devices.find((d: { isDefault: boolean }) => !d.isDefault)
      if (!external) return { success: false, error: 'No external audio device found' }

      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
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
      const scriptPath = join(__dirname, '../../scripts/audio-control.ps1')
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Action', 'set',
        '-DeviceId', originalAudioDeviceId
      ])
    } catch { /* ignore */ }
  })

  ipcMain.handle('open-file-external', async (_event, filePath: string, displayBounds?: { x: number; y: number; width: number; height: number }) => {
    try {
      if (displayBounds && process.platform === 'win32') {
        const scriptPath = join(__dirname, '../../scripts/manage-window.ps1')
        const { stdout } = await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
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
      if (displayBounds && process.platform === 'win32') {
        const scriptPath = join(__dirname, '../../scripts/manage-window.ps1')
        try {
          const { stdout } = await execFileAsync('powershell.exe', [
            '-ExecutionPolicy', 'Bypass',
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

  ipcMain.handle('generate-doc-preview', async (_event, filePath: string) => {
    if (process.platform !== 'win32') return { success: false, error: 'Unsupported platform' }
    const scriptPath = join(__dirname, '../../scripts/document-preview.ps1')
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${scriptPath.replace(/'/g, "''")}' -FilePath '${filePath.replace(/'/g, "''")}'`
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
