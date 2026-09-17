import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, screen, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'fs'
import { readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'
import { getTrustedRendererDevUrl } from './renderer-security'
import { connect as tcpConnect } from 'net'
import { connect as tlsConnect } from 'tls'
import { DEFAULT_STREAM_SETTINGS, validateStreamSettings } from '../shared/streaming'
import type { StreamSettings, StreamStatus } from '../shared/streaming'
import { desktopInputArguments, probeEncoder, rawVideoInputArguments, StreamingEngine } from './streaming-engine'
import { diagnosticLog } from './diagnostic-log'

const freshStatus = (): StreamStatus => ({ phase: 'idle', startedAt: null, encoder: '', fps: 0, bitrateKbps: 0, droppedFrames: 0, encoderLagMs: 0, destinations: [] })

export class StreamingManager {
  private worker: BrowserWindow | null = null
  private workerReady: Promise<void> | null = null
  private requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private sequence = 0
  private epoch = 0
  private engine: StreamingEngine | null = null
  private status: StreamStatus = freshStatus()
  private displayId: number | null = null
  private audioCaptureDisplayId: number | null = null
  private internalProgram = false
  private frameTimer?: NodeJS.Timeout
  private frameCaptureBusy = false
  private internalFrameSize: { width: number; height: number } | null = null
  private settings: StreamSettings | null = null
  private routingTimer?: NodeJS.Timeout
  private encoderCache = new Map<string, boolean>()
  private busy = false
  private readonly ffmpegPath = app.isPackaged
    ? join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : join(app.getAppPath(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

  constructor(
    private control: () => BrowserWindow | null,
    private programDisplay: () => number | null,
    private programWindow: () => BrowserWindow | null
  ) {
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (event.sender !== this.control()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Недоступно.')
        return fn(...args)
      })
    }
    handle('stream-load', () => this.load())
    handle('stream-save', (value: StreamSettings) => this.save(value))
    handle('stream-status', () => ({ ...this.status, ...(this.engine?.snapshot() || {}) }))
    handle('stream-start', (value: StreamSettings, displayId: number | null) => this.start(value, displayId))
    handle('stream-stop', () => this.stop())
    handle('stream-devices', () => this.devices())
    handle('stream-check', (value: StreamSettings) => this.check(value))
    ipcMain.handle('stream-chunk', (event, bytes: ArrayBuffer, capturedAt: number) => {
      if (event.sender !== this.worker?.webContents || event.senderFrame !== event.sender.mainFrame) return false
      return this.engine?.write(bytes, capturedAt) ?? false
    })
    ipcMain.on('stream-reply', (event, id: number, value: unknown, error?: string) => {
      if (event.sender !== this.worker?.webContents || event.senderFrame !== event.sender.mainFrame) return
      const request = this.requests.get(id)
      if (!request) return
      clearTimeout(request.timer)
      this.requests.delete(id)
      if (error) request.reject(new Error(String(error).slice(0, 300)))
      else request.resolve(value)
    })
    ipcMain.on('stream-failed', (event, message: string) => {
      if (event.sender === this.worker?.webContents && event.senderFrame === event.sender.mainFrame) this.fail(String(message).slice(0, 300))
    })
    screen.on('display-removed', (_event, display) => {
      if (!this.internalProgram && display.id === this.displayId) this.fail('Эфирный экран отключён. После подключения запустите стрим повторно.')
    })
    screen.on('display-metrics-changed', (_event, display, metrics) => {
      if (!this.internalProgram && display.id === this.displayId && metrics.some((m) => ['bounds', 'rotation', 'scaleFactor'].includes(m))) {
        this.fail('Изменились параметры эфирного экрана. Запустите стрим повторно.')
      }
    })
  }

  isInternalProgramOutputActive(): boolean {
    return this.internalProgram
  }

  private async load(): Promise<{ settings: StreamSettings; canSave: boolean; available: boolean; warning?: string }> {
    let settings = structuredClone(DEFAULT_STREAM_SETTINGS)
    const path = join(app.getPath('userData'), 'stream-settings.enc')
    const canSave = safeStorage.isEncryptionAvailable()
    let warning: string | undefined
    if (existsSync(path)) {
      if (!canSave) warning = 'Сохранённые настройки недоступны: системное шифрование отключено. Можно ввести ключи без сохранения.'
      else {
        try { settings = validateStreamSettings(JSON.parse(safeStorage.decryptString(await readFile(path))), false) }
        catch { warning = 'Не удалось прочитать сохранённые настройки. Введите их заново; прежний файл изменится только после сохранения.' }
      }
    }
    return { settings, canSave, available: process.platform === 'win32' && existsSync(this.ffmpegPath), warning }
  }

  private async save(value: StreamSettings): Promise<void> {
    const settings = validateStreamSettings(value, false)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное шифрование недоступно. Ключи можно использовать без сохранения.')
    const path = join(app.getPath('userData'), 'stream-settings.enc')
    const temporary = `${path}.${this.sequence++}.tmp`
    await writeFile(temporary, safeStorage.encryptString(JSON.stringify(settings)))
    await rename(temporary, path)
  }

  private async check(value: StreamSettings): Promise<Array<{ name: string; reachable: boolean }>> {
    const settings = validateStreamSettings(value)
    return Promise.all(settings.destinations.filter((d) => d.enabled).map(async (destination) => {
      const url = new URL(destination.server)
      const secure = url.protocol === 'rtmps:'
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = secure
          ? tlsConnect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: true })
          : tcpConnect({ host: url.hostname, port: Number(url.port) || 1935 })
        const timer = setTimeout(() => finish(false), 5000)
        const finish = (ok: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(ok) }
        socket.once(secure ? 'secureConnect' : 'connect', () => finish(true))
        socket.once('error', () => finish(false))
      })
      return { name: destination.name, reachable }
    }))
  }

  private async ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady
    const captureSession = session.fromPartition('pdm-stream-capture')
    const isWorker = (contents: Electron.WebContents | null): boolean => !!contents && contents === this.worker?.webContents
    captureSession.setPermissionCheckHandler((contents, permission) => isWorker(contents) && permission === 'media')
    captureSession.setPermissionRequestHandler((contents, permission, callback) => callback(isWorker(contents) && permission === 'media'))
    captureSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (!this.worker || request.frame !== this.worker.webContents.mainFrame || this.audioCaptureDisplayId === null) { callback({}); return }
        const pinned = this.audioCaptureDisplayId
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        const source = sources.find((s) => s.display_id === String(pinned))
        if (!source || this.audioCaptureDisplayId !== pinned) { callback({}); return }
        const systemAudio = this.settings?.audio === 'system' || this.settings?.audio === 'both'
        callback({ video: source, ...(systemAudio ? { audio: 'loopback' as const } : {}) })
      } catch { callback({}) }
    })
    const worker = new BrowserWindow({ show: false, width: 320, height: 180, skipTaskbar: true,
      webPreferences: { preload: join(__dirname, '../preload/streaming.js'), session: captureSession,
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
    this.worker = worker
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    worker.webContents.on('will-navigate', (event) => event.preventDefault())
    worker.webContents.on('render-process-gone', () => { if (this.worker === worker) this.fail('Процесс захвата остановился. Основной эфир продолжает работать.') })
    const url = getTrustedRendererDevUrl()
    this.workerReady = url ? worker.loadURL(`${url.replace(/\/$/, '')}/streaming.html`) : worker.loadFile(join(__dirname, '../renderer/streaming.html'))
    return this.workerReady
  }

  private async command<T>(command: string, value?: unknown): Promise<T> {
    await this.ensureWorker()
    if (!this.worker || this.worker.isDestroyed()) throw new Error('Захват остановлен.')
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Нет ответа от захвата изображения/звука.')); }, 15000)
      this.requests.set(id, { resolve: (result) => resolve(result as T), reject, timer })
      this.worker!.webContents.send('stream-command', id, command, value)
    })
  }

  private async devices(): Promise<Array<{ id: string; label: string }>> {
    if (this.busy) throw new Error('Дождитесь завершения текущей операции.')
    this.busy = true
    try { return await this.command('devices') }
    finally { this.busy = false; if (!this.engine) this.closeWorker() }
  }

  private async start(value: StreamSettings, displayId: number | null): Promise<void> {
    if (this.busy || this.engine || this.status.phase === 'starting') throw new Error('Стрим уже запущен или запускается.')
    const settings = validateStreamSettings(value)
    if (process.platform !== 'win32' || !existsSync(this.ffmpegPath)) throw new Error('Модуль стриминга доступен в Windows-сборке с FFmpeg.')
    const internalProgram = displayId === null
    const display = displayId === null ? null : screen.getAllDisplays().find((d) => d.id === displayId)
    if (!internalProgram && !display) throw new Error('Назначенный эфирный экран отключён.')
    if (!internalProgram && this.control() && screen.getDisplayMatching(this.control()!.getBounds()).id === displayId) throw new Error('Для стрима нужен отдельный эфирный экран, без панели управления PDM.')
    if (internalProgram && settings.fps > 30) throw new Error('Без дополнительного монитора выберите 25 или 30 кадров/с.')
    const internalWindow = internalProgram ? this.programWindow() : null
    if (internalProgram && (!internalWindow || internalWindow.isDestroyed())) {
      throw new Error('Внутренний программный выход ещё не готов. Повторите запуск стрима.')
    }
    if (internalWindow) {
      internalWindow.setIgnoreMouseEvents(true)
      internalWindow.setOpacity(0)
      if (!internalWindow.isVisible()) internalWindow.showInactive()
    }
    this.busy = true
    const token = ++this.epoch
    this.status = { ...freshStatus(), phase: 'starting' }
    this.displayId = displayId
    this.audioCaptureDisplayId = internalProgram ? screen.getPrimaryDisplay().id : displayId
    this.internalProgram = internalProgram
    this.settings = settings
    try {
      let encoder = 'libx264'
      if (settings.encoder !== 'software') {
        const candidates = settings.encoder === 'auto' ? ['h264_nvenc', 'h264_qsv', 'h264_amf'] : [settings.encoder]
        const results = await Promise.all(candidates.map(async (name) => {
          let supported = this.encoderCache.get(name)
          if (supported === undefined) { supported = await probeEncoder(this.ffmpegPath, name); this.encoderCache.set(name, supported) }
          return { name, supported }
        }))
        encoder = results.find((r) => r.supported)?.name || 'libx264'
        if (settings.encoder !== 'auto' && encoder === 'libx264') throw new Error('Выбранный аппаратный кодер недоступен. Выберите «Авто» или «Процессор».')
      }
      if (token !== this.epoch) throw new Error('Запуск отменён.')
      await this.command('start', { resolution: settings.resolution, fps: settings.fps, bitrateKbps: settings.bitrateKbps,
        audio: settings.audio, microphoneId: settings.microphoneId })
      if (token !== this.epoch) throw new Error(this.status.error || 'Запуск отменён.')
      this.engine = new StreamingEngine(this.ffmpegPath, settings, (message) => this.fail(message))
      if (internalProgram && internalWindow) {
        const firstFrame = await internalWindow.webContents.capturePage()
        const size = firstFrame.getSize()
        if (size.width < 16 || size.height < 16) throw new Error('Внутренний программный выход не отрисовал кадр.')
        this.internalFrameSize = size
        this.engine.start(encoder, rawVideoInputArguments(size.width, size.height, settings.fps), true)
        // FFmpeg opens the raw-video and PCM inputs together. Do not await the
        // first video pipe before resuming PCM, otherwise both inputs can wait
        // on each other during startup.
        void this.engine.writeVideo(firstFrame.getBitmap())
        const captureFrame = async (): Promise<void> => {
          if (this.frameCaptureBusy || !this.engine || !this.internalProgram) return
          const win = this.programWindow()
          if (!win || win.isDestroyed()) {
            this.fail('Внутренний программный выход закрылся.')
            return
          }
          this.frameCaptureBusy = true
          try {
            const frame = await win.webContents.capturePage()
            const currentSize = frame.getSize()
            if (currentSize.width !== size.width || currentSize.height !== size.height) {
              this.fail('Изменился размер внутреннего программного выхода. Запустите стрим повторно.')
              return
            }
            await this.engine?.writeVideo(frame.getBitmap())
          } catch {
            this.fail('Не удалось получить кадр внутреннего программного выхода.')
          } finally {
            this.frameCaptureBusy = false
          }
        }
        this.frameTimer = setInterval(() => { void captureFrame() }, Math.max(1, Math.round(1000 / settings.fps)))
        diagnosticLog('stream', `start capture=internal encoder=${encoder} resolution=${settings.resolution} fps=${settings.fps} frame=${size.width}x${size.height} destinations=${settings.destinations.filter(d => d.enabled).length}`)
      } else if (display) {
        const physical = screen.dipToScreenRect(null, display.bounds)
        this.engine.start(encoder, desktopInputArguments(physical, settings.fps))
        diagnosticLog('stream', `start capture=native encoder=${encoder} resolution=${settings.resolution} fps=${settings.fps} display=${displayId} bounds=${JSON.stringify(physical)} destinations=${settings.destinations.filter(d => d.enabled).length}`)
      }
      await this.command('resume')
      if (token !== this.epoch) throw new Error(this.status.error || 'Запуск отменён.')
      this.status = { ...freshStatus(), phase: 'running', encoder, startedAt: Date.now(), source: internalProgram ? 'internal' : 'display' }
      let diagnosticTicks = 0
      this.routingTimer = setInterval(() => {
        if (++diagnosticTicks % 20 === 0 && this.engine) {
          const s = this.engine.snapshot()
          diagnosticLog('stream', `fps=${s.fps} encodedKbps=${s.bitrateKbps} encoderLagMs=${s.encoderLagMs} destinations=${JSON.stringify(s.destinations.map((d, i) => ({ index: i, phase: d.phase, retries: d.retries, bufferedMs: d.bufferedMs, kbps: d.bitrateKbps, droppedFrames: d.droppedFrames, error: d.error })))}`)
        }
        if (!this.internalProgram && this.programDisplay() !== this.displayId) this.fail('Эфир перенесён на другой экран. Запустите стрим повторно.')
        else if (!this.control() || this.control()!.isDestroyed()) this.fail('Окно управления закрыто. Стрим остановлен.')
        else if (!this.internalProgram && screen.getDisplayMatching(this.control()!.getBounds()).id === this.displayId) {
          this.fail('Панель управления перемещена на эфирный экран. Верните её на основной экран и запустите стрим повторно.')
        }
      }, 500)
    } catch (error) {
      if (token === this.epoch) this.fail(error instanceof Error ? error.message : 'Не удалось запустить стрим.')
      throw error
    } finally { this.busy = false }
  }

  private closeWorker(): void {
    const worker = this.worker
    this.worker = null
    this.workerReady = null
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Захват остановлен.')) }
    this.requests.clear()
    if (worker && !worker.isDestroyed()) worker.destroy()
  }

  stop(): void {
    if (this.engine) diagnosticLog('stream', 'stop')
    this.epoch++
    clearInterval(this.routingTimer)
    clearInterval(this.frameTimer)
    this.frameTimer = undefined
    this.engine?.stop()
    this.engine = null
    this.closeWorker() // destroying its renderer releases every media track, canvas and audio context
    this.displayId = null
    this.audioCaptureDisplayId = null
    this.internalProgram = false
    this.internalFrameSize = null
    this.settings = null
    this.status = freshStatus()
  }

  private fail(message: string): void {
    diagnosticLog('stream', `error=${message}`)
    this.stop()
    this.status = { ...freshStatus(), phase: 'error', error: message }
  }
}
