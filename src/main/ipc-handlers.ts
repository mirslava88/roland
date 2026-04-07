import { BrowserWindow, ipcMain, dialog } from 'electron'
import { readdir, stat, readFile } from 'fs/promises'
import { join, extname, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

let originalAudioDeviceId: string | null = null

const SUPPORTED_EXTENSIONS = {
  presentation: ['.pptx', '.ppt'],
  pdf: ['.pdf'],
  video: ['.mp4', '.mov', '.avi', '.webm', '.mkv']
}

function getFileType(ext: string): 'presentation' | 'pdf' | 'video' | 'unknown' {
  const lower = ext.toLowerCase()
  if (SUPPORTED_EXTENSIONS.presentation.includes(lower)) return 'presentation'
  if (SUPPORTED_EXTENSIONS.pdf.includes(lower)) return 'pdf'
  if (SUPPORTED_EXTENSIONS.video.includes(lower)) return 'video'
  return 'unknown'
}

export interface FileEntry {
  id: string
  name: string
  path: string
  type: 'presentation' | 'pdf' | 'video' | 'unknown'
  extension: string
  size: number
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

    for (const entry of entries) {
      const fullPath = join(folderPath, entry)
      const stats = await stat(fullPath)

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
        size: stats.size
      })
    }

    return files
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
}
