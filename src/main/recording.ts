import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { existsSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_RECORDING_SETTINGS, validateRecordingSettings } from '../shared/recording'
import type { RecordingSettings, RecordingStatus } from '../shared/recording'
import { desktopInputArguments } from './streaming-engine'
import { RecordingEngine } from './recording-engine'
import { RecordingEditorManager } from './recording-editor'
import { diagnosticLog } from './diagnostic-log'
import { getTrustedRendererDevUrl } from './renderer-security'

const freshStatus = (): RecordingStatus => ({ phase: 'idle', startedAt: null, frames: 0, fps: 0, droppedFrames: 0, sizeBytes: 0 })

export class RecordingManager {
  private status: RecordingStatus = freshStatus()
  private engine: RecordingEngine | null = null
  private worker: BrowserWindow | null = null
  private workerReady: Promise<void> | null = null
  private requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private sequence = 0
  private epoch = 0
  private displayId: number | null = null
  private audioDisplayId: number | null = null
  private settings: RecordingSettings | null = null
  private frameTimer?: NodeJS.Timeout
  private routingTimer?: NodeJS.Timeout
  private frameBusy = false
  private busy = false
  private finalizing: Promise<void> | null = null
  private readonly editor: RecordingEditorManager
  private readonly ffmpegPath = app.isPackaged
    ? join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : join(app.getAppPath(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

  constructor(private control: () => BrowserWindow | null, private programDisplay: () => number | null,
    private programWindow: () => BrowserWindow | null) {
    this.editor = new RecordingEditorManager(this.ffmpegPath, control,
      () => this.status.phase === 'idle' ? this.status.path : undefined,
      () => ['starting', 'running', 'stopping'].includes(this.status.phase))
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (event.sender !== this.control()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Недоступно.')
        return fn(...args)
      })
    }
    handle('record-load', () => this.load())
    handle('record-save', (settings: RecordingSettings) => this.save(settings))
    handle('record-devices', () => this.command<Array<{ id: string; label: string }>>('devices').finally(() => {
      if (!this.engine) this.closeWorker()
    }))
    handle('record-start', (settings: RecordingSettings, displayId: number | null) => this.start(settings, displayId))
    handle('record-stop', () => this.stop())
    handle('record-status', () => this.snapshot())
    ipcMain.handle('record-chunk', (event, bytes: ArrayBuffer, capturedAt: number) => {
      if (event.sender !== this.worker?.webContents || event.senderFrame !== event.sender.mainFrame) return false
      return this.engine?.writeAudio(bytes, capturedAt) ?? false
    })
    ipcMain.on('record-reply', (event, id: number, value: unknown, error?: string) => {
      if (event.sender !== this.worker?.webContents || event.senderFrame !== event.sender.mainFrame) return
      const request = this.requests.get(id)
      if (!request) return
      clearTimeout(request.timer); this.requests.delete(id)
      error ? request.reject(new Error(String(error).slice(0, 300))) : request.resolve(value)
    })
    ipcMain.on('record-failed', (event, message: string) => {
      if (event.sender === this.worker?.webContents && event.senderFrame === event.sender.mainFrame) {
        void this.fail(String(message).slice(0, 300).replace(/стрим/gi, 'запись'))
      }
    })
    screen.on('display-removed', (_event, display) => {
      if (this.displayId !== null && this.displayId === display.id) void this.fail('Эфирный экран отключён. Запись остановлена.')
    })
    screen.on('display-metrics-changed', (_event, display, metrics) => {
      if (this.displayId !== null && this.displayId === display.id && metrics.some(m => ['bounds', 'rotation', 'scaleFactor'].includes(m))) {
        void this.fail('Параметры эфирного экрана изменились. Запись остановлена.')
      }
    })
  }

  isInternalProgramOutputActive(): boolean {
    return this.status.source === 'internal' && ['starting', 'running', 'stopping'].includes(this.status.phase)
  }

  private snapshot(): RecordingStatus {
    let sizeBytes = this.status.sizeBytes
    try { if (this.status.path && existsSync(this.status.path)) sizeBytes = statSync(this.status.path).size } catch { /* file may have moved */ }
    return { ...this.status, ...this.engine?.snapshot(), sizeBytes }
  }

  private async load(): Promise<RecordingSettings> {
    try {
      const value = JSON.parse(await readFile(join(app.getPath('userData'), 'record-settings.json'), 'utf8'))
      return validateRecordingSettings(value)
    } catch { return { ...DEFAULT_RECORDING_SETTINGS } }
  }

  private async save(settings: RecordingSettings): Promise<void> {
    const valid = validateRecordingSettings(settings)
    await writeFile(join(app.getPath('userData'), 'record-settings.json'), JSON.stringify(valid), { mode: 0o600 })
  }

  private async ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady
    const captureSession = session.fromPartition('pdm-record-capture')
    const isWorker = (contents: Electron.WebContents | null): boolean => !!contents && contents === this.worker?.webContents
    captureSession.setPermissionCheckHandler((contents, permission) => isWorker(contents) && (permission === 'media' || permission === 'display-capture'))
    captureSession.setPermissionRequestHandler((contents, permission, callback) => callback(isWorker(contents) && (permission === 'media' || permission === 'display-capture')))
    captureSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (!this.worker || request.frame !== this.worker.webContents.mainFrame || this.audioDisplayId === null) { callback({}); return }
        const pinned = this.audioDisplayId
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        const source = sources.find(s => s.display_id === String(pinned))
        if (!source || this.audioDisplayId !== pinned) { callback({}); return }
        const systemAudio = this.settings?.audio === 'system' || this.settings?.audio === 'both'
        callback({ video: source, ...(systemAudio ? { audio: 'loopback' as const } : {}) })
      } catch { callback({}) }
    })
    const worker = new BrowserWindow({ show: false, width: 320, height: 180, skipTaskbar: true,
      webPreferences: { preload: join(__dirname, '../preload/recording.js'), session: captureSession,
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
    this.worker = worker
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    worker.webContents.on('will-navigate', event => event.preventDefault())
    worker.webContents.on('render-process-gone', () => { if (this.worker === worker) void this.fail('Процесс захвата звука остановился. Запись завершена.') })
    const url = getTrustedRendererDevUrl()
    this.workerReady = url ? worker.loadURL(`${url.replace(/\/$/, '')}/streaming.html`) : worker.loadFile(join(__dirname, '../renderer/streaming.html'))
    return this.workerReady
  }

  private async command<T>(command: string, value?: unknown): Promise<T> {
    await this.ensureWorker()
    if (!this.worker || this.worker.isDestroyed()) throw new Error('Захват звука остановлен.')
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Нет ответа от захвата звука.')) }, 15000)
      this.requests.set(id, { resolve: result => resolve(result as T), reject, timer })
      this.worker!.webContents.send('record-command', id, command, value)
    })
  }

  private async start(value: RecordingSettings, displayId: number | null): Promise<boolean> {
    if (this.busy || this.engine) throw new Error('Запись уже запущена или запускается.')
    if (this.editor.isBusy()) throw new Error('Дождитесь окончания монтажа записи или отмените его.')
    const settings = validateRecordingSettings(value)
    if (process.platform !== 'win32' || !existsSync(this.ffmpegPath)) throw new Error('Запись доступна в Windows-сборке Stream с FFmpeg.')
    const internal = displayId === null
    const display = internal ? null : screen.getAllDisplays().find(d => d.id === displayId)
    if (!internal && !display) throw new Error('Назначенный эфирный экран отключён.')
    if (display && this.control() && screen.getDisplayMatching(this.control()!.getBounds()).id === displayId) {
      throw new Error('Для записи нужен отдельный эфирный экран, без панели управления PDM.')
    }
    if (internal && settings.fps > 30) throw new Error('Без дополнительного монитора выберите 25 или 30 кадров/с.')
    const win = internal ? this.programWindow() : null
    if (internal && (!win || win.isDestroyed())) throw new Error('Внутренний программный выход ещё не готов.')
    const extension = settings.format === 'lossless-mkv' ? 'mkv' : 'mp4'
    const now = new Date()
    const twoDigits = (value: number): string => String(value).padStart(2, '0')
    const defaultName = `PDM-${twoDigits(now.getDate())}-${twoDigits(now.getMonth() + 1)}-${now.getFullYear()}_${twoDigits(now.getHours())}-${twoDigits(now.getMinutes())}.${extension}`
    const options: Electron.SaveDialogOptions = {
      title: 'Сохранить запись эфира', defaultPath: join(app.getPath('videos'), defaultName),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }], properties: ['showOverwriteConfirmation']
    }
    const parent = this.control()
    const selection = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (selection.canceled || !selection.filePath) return false
    const path = selection.filePath.toLowerCase().endsWith(`.${extension}`) ? selection.filePath : `${selection.filePath}.${extension}`
    if (existsSync(path)) throw new Error('Файл уже существует. Выберите новое имя для записи.')
    this.busy = true
    const token = ++this.epoch
    this.status = { ...freshStatus(), phase: 'starting', path, source: internal ? 'internal' : 'display' }
    this.displayId = displayId
    this.audioDisplayId = internal ? screen.getPrimaryDisplay().id : displayId
    this.settings = settings
    try {
      if (win) { win.setIgnoreMouseEvents(true); win.setOpacity(0); if (!win.isVisible()) win.showInactive() }
      await this.command('start', { resolution: 1080, fps: settings.fps, bitrateKbps: 0,
        audio: settings.audio, microphoneId: settings.microphoneId })
      if (token !== this.epoch) throw new Error('Запуск отменён.')
      const engine = new RecordingEngine(this.ffmpegPath, message => { if (token === this.epoch) void this.fail(message) })
      this.engine = engine
      if (win) {
        const first = await win.webContents.capturePage()
        const size = first.getSize()
        if (size.width < 16 || size.height < 16) throw new Error('Внутренний программный выход не отрисовал кадр.')
        engine.start(settings, ['-thread_queue_size', '2', '-f', 'rawvideo', '-pixel_format', 'bgra',
          '-video_size', `${size.width}x${size.height}`, '-framerate', String(settings.fps),
          '-use_wallclock_as_timestamps', '1', '-i', 'pipe:4'], path, true)
        void engine.writeVideo(first.toBitmap())
        const captureFrame = async (): Promise<void> => {
          if (token !== this.epoch || this.frameBusy || this.engine !== engine) return
          const current = this.programWindow()
          if (!current || current.isDestroyed()) { void this.fail('Внутренний программный выход закрылся.'); return }
          this.frameBusy = true
          try {
            const frame = await current.webContents.capturePage()
            const frameSize = frame.getSize()
            if (frameSize.width !== size.width || frameSize.height !== size.height) {
              void this.fail('Изменился размер внутреннего выхода. Запись остановлена.'); return
            }
            if (token === this.epoch) await engine.writeVideo(frame.toBitmap())
          } catch { if (token === this.epoch) void this.fail('Не удалось получить кадр внутреннего выхода.') }
          finally { this.frameBusy = false }
        }
        this.frameTimer = setInterval(() => { void captureFrame() }, Math.round(1000 / settings.fps))
      } else if (display) {
        engine.start(settings, desktopInputArguments(screen.dipToScreenRect(null, display.bounds), settings.fps), path, false)
      }
      await this.command('resume')
      if (token !== this.epoch) throw new Error('Запуск отменён.')
      this.status = { ...this.status, phase: 'running', startedAt: Date.now() }
      this.routingTimer = setInterval(() => {
        if (token !== this.epoch) return
        if (displayId !== null && this.programDisplay() !== displayId) {
          void this.fail('Эфир перенесён на другой экран. Запись остановлена, файл сохранён.')
        }
        else if (!this.control() || this.control()!.isDestroyed()) void this.fail('Окно управления закрылось. Запись завершена.')
        else if (displayId !== null && screen.getDisplayMatching(this.control()!.getBounds()).id === displayId) {
          void this.fail('Панель управления перемещена на эфирный экран. Запись остановлена.')
        }
      }, 500)
      diagnosticLog('record', `start format=${settings.format} fps=${settings.fps} source=${internal ? 'internal' : 'display'} audio=${settings.audio}`)
      return true
    } catch (error) {
      if (token === this.epoch) await this.fail(error instanceof Error ? error.message : 'Не удалось начать запись.')
      throw error
    } finally { if (token === this.epoch) this.busy = false }
  }

  private closeWorker(): void {
    const worker = this.worker
    this.worker = null; this.workerReady = null
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Захват остановлен.')) }
    this.requests.clear()
    if (worker && !worker.isDestroyed()) worker.destroy()
  }

  async stop(): Promise<void> {
    if (this.finalizing) return this.finalizing
    this.finalizing = this.finalize()
    try { await this.finalizing } finally { this.finalizing = null }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([this.stop(), this.editor.shutdown()])
  }

  private async finalize(): Promise<void> {
    if (this.status.phase === 'stopping' || this.status.phase === 'idle') return
    this.epoch++
    const previous = this.snapshot()
    this.status = { ...previous, phase: 'stopping' }
    clearInterval(this.frameTimer)
    clearInterval(this.routingTimer)
    this.frameTimer = undefined
    this.routingTimer = undefined
    this.closeWorker()
    const engine = this.engine
    this.engine = null
    this.displayId = null; this.audioDisplayId = null; this.settings = null
    const clean = await engine?.stop() ?? true
    this.status = { ...previous, phase: clean ? 'idle' : 'error',
      error: clean ? undefined : 'Не удалось корректно завершить файл. Проверьте запись перед использованием.',
      sizeBytes: this.snapshot().sizeBytes }
    diagnosticLog('record', `stop clean=${clean} frames=${previous.frames} dropped=${previous.droppedFrames}`)
    this.busy = false
  }

  private async fail(message: string): Promise<void> {
    if (this.status.phase === 'stopping' || this.status.phase === 'idle' || this.status.phase === 'error') return
    diagnosticLog('record', `error=${message}`)
    await this.stop()
    this.status = { ...this.status, phase: 'error', error: message }
  }
}
