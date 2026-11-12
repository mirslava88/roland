import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, powerSaveBlocker, screen, session, systemPreferences } from 'electron'
import { existsSync, statSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_RECORDING_SETTINGS, validateRecordingSettings } from '../shared/recording'
import type { RecordingSettings, RecordingStatus } from '../shared/recording'
import { RecordingEngine } from './recording-engine'
import { RecordingEditorManager } from './recording-editor'
import { diagnosticLog } from './diagnostic-log'
import { getTrustedRendererDevUrl, isTrustedWindowMainFrame, isTrustedWebContentsPage } from './renderer-security'
import { macReleaseWebPreferences } from './mac-release-security'
import { isMacRenderDisplay } from './mac-render-display'

const fresh = (): RecordingStatus => ({ phase: 'idle', startedAt: null, frames: 0, fps: 0, droppedFrames: 0, sizeBytes: 0 })
const active = (status: RecordingStatus): boolean => ['starting', 'running', 'stopping'].includes(status.phase)
export function macRecordingSize(width: number, height: number): { width: number; height: number } {
  if (![width, height].every(Number.isInteger) || width < 16 || height < 16 || width > 16384 || height > 16384 ||
      width * height > 67108864) throw new Error('Разрешение эфирного выхода не поддерживается для записи.')
  return { width, height }
}
export function macRecordingInput(width: number, height: number, fps: number): string[] {
  macRecordingSize(width, height)
  return ['-thread_queue_size', '2', '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${width}x${height}`,
    '-framerate', String(fps), '-use_wallclock_as_timestamps', '1', '-i', 'pipe:4']
}

/** Mac capture owns its own audio partition, epoch and encoder; streaming may run independently. */
export class MacRecordingManager {
  private status = fresh()
  private engine: RecordingEngine | null = null
  private worker: BrowserWindow | null = null
  private workerReady: Promise<void> | null = null
  private requests = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private sequence = 0
  private epoch = 0
  private busy = false
  private finalizing: Promise<void> | null = null
  private internal = false
  private displayId: number | null = null
  private audioDisplayId: number | null = null
  private settings: RecordingSettings | null = null
  private frameTimer?: NodeJS.Timeout
  private routingTimer?: NodeJS.Timeout
  private frameBusy = false
  private powerId: number | null = null
  private failure: string | undefined
  private lastPath: string | undefined
  private readonly editor: RecordingEditorManager
  private readonly ffmpeg = app.isPackaged ? join(process.resourcesPath, 'ffmpeg/ffmpeg') : join(app.getAppPath(), 'build/mac-ffmpeg')

  constructor(private control: () => BrowserWindow | null, private programDisplay: () => number | null,
    private programWindow: () => BrowserWindow | null) {
    this.editor = new RecordingEditorManager(this.ffmpeg, control, () => this.lastPath, () => this.busy || active(this.status))
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        if (!isTrustedWindowMainFrame(event, this.control(), 'index.html')) throw new Error('Недоступно.')
        return fn(...args)
      })
    }
    handle('record-load', () => this.load())
    handle('record-save', (settings: RecordingSettings) => this.save(settings))
    handle('record-status', () => this.snapshot())
    handle('record-devices', () => this.devices())
    handle('record-start', (settings: RecordingSettings, id: number | null) => this.start(settings, id))
    handle('record-stop', () => this.stop())
    ipcMain.handle('record-chunk', (event, bytes: ArrayBuffer, capturedAt: number) => {
      if (!isTrustedWindowMainFrame(event, this.worker, 'streaming.html')) return false
      return this.engine?.writeAudio(bytes, capturedAt) ?? false
    })
    ipcMain.on('record-reply', (event, id: number, value: unknown, error?: string) => {
      if (!isTrustedWindowMainFrame(event, this.worker, 'streaming.html')) return
      const request = this.requests.get(id)
      if (!request) return
      clearTimeout(request.timer); this.requests.delete(id)
      error ? request.reject(new Error(String(error).slice(0, 300))) : request.resolve(value)
    })
    ipcMain.on('record-failed', (event, message: string) => {
      if (isTrustedWindowMainFrame(event, this.worker, 'streaming.html')) void this.fail(String(message).slice(0, 300).replace(/стрим/gi, 'запись'))
    })
    screen.on('display-removed', (_event, display) => {
      if (this.displayId === display.id) void this.fail('Эфирный экран отключён. Запись остановлена.')
    })
    screen.on('display-metrics-changed', (_event, display, metrics) => {
      if (this.displayId === display.id && metrics.some(value => ['bounds', 'scaleFactor', 'rotation'].includes(value))) {
        void this.fail('Параметры эфирного экрана изменились. Запись остановлена.')
      }
    })
  }

  isInternalProgramOutputActive(): boolean { return this.internal && active(this.status) }
  private snapshot(): RecordingStatus {
    let sizeBytes = this.status.sizeBytes
    try { if (this.status.path) sizeBytes = statSync(this.status.path).size } catch { /* not created yet */ }
    return { ...this.status, ...this.engine?.snapshot(), sizeBytes }
  }
  private async load(): Promise<RecordingSettings> {
    try { return validateRecordingSettings(JSON.parse(await readFile(join(app.getPath('userData'), 'record-settings.json'), 'utf8'))) }
    catch { return { ...DEFAULT_RECORDING_SETTINGS } }
  }
  private async save(value: RecordingSettings): Promise<void> {
    await writeFile(join(app.getPath('userData'), 'record-settings.json'), JSON.stringify(validateRecordingSettings(value)), { mode: 0o600 })
  }
  private async devices(): Promise<Array<{ id: string; label: string }>> {
    if (this.busy || this.finalizing) throw new Error('Дождитесь завершения текущей операции.')
    if (this.engine) throw new Error('Аудиовход нельзя менять во время записи.')
    this.busy = true
    try { return await this.command('devices') }
    finally { this.closeWorker(); this.busy = false }
  }
  private async ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady
    const captureSession = session.fromPartition('pdm-mac-record-capture')
    const trusted = (contents: Electron.WebContents | null): boolean =>
      contents === this.worker?.webContents && isTrustedWebContentsPage(contents, 'streaming.html')
    captureSession.setPermissionCheckHandler((contents, permission) => trusted(contents) && ['media', 'display-capture'].includes(permission))
    captureSession.setPermissionRequestHandler((contents, permission, callback) => callback(trusted(contents) && ['media', 'display-capture'].includes(permission)))
    captureSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const worker = this.worker, pinned = this.audioDisplayId
        if (!worker || request.frame !== worker.webContents.mainFrame || !trusted(worker.webContents) || pinned === null) { callback({}); return }
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        const source = sources.find(s => s.display_id === String(pinned))
        if (!source || worker !== this.worker || pinned !== this.audioDisplayId) { callback({}); return }
        callback({ video: source, ...(this.settings?.audio === 'system' || this.settings?.audio === 'both' ? { audio: 'loopback' as const } : {}) })
      } catch { callback({}) }
    })
    const worker = new BrowserWindow({ show: false, width: 320, height: 180, skipTaskbar: true,
      webPreferences: { ...macReleaseWebPreferences(), preload: join(__dirname, '../preload/recording.js'), session: captureSession,
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
    this.worker = worker
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    worker.webContents.on('will-navigate', event => event.preventDefault())
    worker.webContents.on('render-process-gone', () => {
      if (this.worker === worker) void this.fail('Процесс захвата звука остановился. Запись завершена.')
    })
    const url = getTrustedRendererDevUrl()
    this.workerReady = url ? worker.loadURL(`${url}/streaming.html`) : worker.loadFile(join(__dirname, '../renderer/streaming.html'))
    return this.workerReady
  }
  private async command<T>(command: string, value?: unknown): Promise<T> {
    const ready = this.ensureWorker()
    const worker = this.worker
    await ready
    if (!worker || worker !== this.worker || worker.isDestroyed()) throw new Error('Захват звука остановлен.')
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Нет ответа от захвата звука.')) }, 15000)
      this.requests.set(id, { resolve: result => resolve(result as T), reject, timer })
      worker.webContents.send('record-command', id, command, value)
    })
  }
  private closeWorker(): void {
    const worker = this.worker
    this.worker = null; this.workerReady = null
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Захват остановлен.')) }
    this.requests.clear()
    if (worker && !worker.isDestroyed()) worker.destroy()
  }

  private async start(value: RecordingSettings, displayId: number | null): Promise<boolean> {
    if (this.busy || this.finalizing || active(this.status)) throw new Error('Запись уже запускается или завершается.')
    if (this.editor.isBusy()) throw new Error('Дождитесь окончания монтажа записи или отмените его.')
    const settings = validateRecordingSettings(value)
    if (!existsSync(this.ffmpeg)) throw new Error('Компонент записи FFmpeg не найден в PDM Stream.')
    if (displayId !== null && (!Number.isInteger(displayId) || displayId <= 0)) throw new Error('Некорректный эфирный экран.')
    const internal = displayId === null
    const display = internal ? null : screen.getAllDisplays().find(d => d.id === displayId && !isMacRenderDisplay(d))
    if (!internal && !display) throw new Error('Эфирный экран отключён.')
    if (display && systemPreferences.getMediaAccessStatus('screen') !== 'granted') throw new Error('Разрешите PDM Stream запись экрана в настройках конфиденциальности macOS.')
    if (internal && settings.fps > 30) throw new Error('Без дополнительного монитора выберите 25 или 30 кадров/с.')
    if (settings.audio === 'system' || settings.audio === 'both') {
      const [major, minor] = process.getSystemVersion().split('.').map(Number)
      if (major < 14 || major === 14 && minor < 2) throw new Error('Для системного звука нужна macOS 14.2 или новее. Можно записать микрофон или выбрать «Без звука».')
    }
    const win = internal ? this.programWindow() : null
    if (internal && (!win || win.isDestroyed())) throw new Error('Внутренний программный выход ещё не готов.')
    const validateRoute = (): void => {
      const control = this.control()
      if (!control || control.isDestroyed()) throw new Error('Окно управления закрыто.')
      if (display && (!screen.getAllDisplays().some(d => d.id === display.id && JSON.stringify(d.bounds) === JSON.stringify(display.bounds) && d.scaleFactor === display.scaleFactor) ||
          this.programDisplay() !== displayId || screen.getDisplayMatching(control.getBounds()).id === displayId)) {
        throw new Error('Эфирный экран отключён, переназначен или занят панелью управления. Запись остановлена.')
      }
    }
    validateRoute()
    this.busy = true; this.internal = internal; this.displayId = displayId; this.failure = undefined
    const token = ++this.epoch
    const current = (): boolean => token === this.epoch
    this.status = { ...fresh(), phase: 'starting', source: internal ? 'internal' : 'display' }
    try {
      const extension = settings.format === 'lossless-mkv' ? 'mkv' : 'mp4'
      const name = `PDM-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
      const options: Electron.SaveDialogOptions = { title: 'Сохранить запись эфира', defaultPath: join(app.getPath('videos'), name),
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }], properties: ['showOverwriteConfirmation'] }
      const parent = this.control()
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      if (!current()) throw new Error('Запуск записи отменён.')
      if (result.canceled || !result.filePath) { this.status = { ...fresh(), path: this.lastPath }; this.internal = false; this.displayId = null; return false }
      const path = result.filePath.toLowerCase().endsWith(`.${extension}`) ? result.filePath : `${result.filePath}.${extension}`
      if (existsSync(path)) throw new Error('Файл уже существует. Выберите новое имя для записи.')
      validateRoute()
      this.status.path = path
      this.settings = settings
      this.audioDisplayId = displayId ?? screen.getAllDisplays().find(d => !isMacRenderDisplay(d))?.id ?? screen.getPrimaryDisplay().id
      this.powerId = powerSaveBlocker.start('prevent-display-sleep')
      await this.command('start', { resolution: 1080, fps: settings.fps, bitrateKbps: 0, audio: settings.audio, microphoneId: settings.microphoneId })
      if (!current()) throw new Error('Запуск записи отменён.')
      validateRoute()
      const engine = new RecordingEngine(this.ffmpeg, message => { if (current()) void this.fail(message) })
      if (win) {
        if (win.isDestroyed() || this.programWindow() !== win) throw new Error('Внутренний программный выход закрылся.')
        const first = await win.webContents.capturePage()
        if (!current()) throw new Error('Запуск записи отменён.')
        const size = macRecordingSize(first.getSize().width, first.getSize().height)
        this.engine = engine
        engine.start(settings, macRecordingInput(size.width, size.height, settings.fps), path, true)
        void engine.writeVideo(first.toBitmap()).catch(() => { if (current()) void this.fail('Не удалось передать кадр записи.') })
        const capture = async (): Promise<void> => {
          if (!current() || this.frameBusy || this.engine !== engine) return
          this.frameBusy = true
          try {
            if (win.isDestroyed() || this.programWindow() !== win) throw new Error('Внутренний программный выход закрылся.')
            const frame = await win.webContents.capturePage()
            if (!current()) return
            if (frame.getSize().width !== size.width || frame.getSize().height !== size.height) throw new Error('Размер внутреннего выхода изменился. Запись остановлена.')
            await engine.writeVideo(frame.toBitmap())
          } catch (error) { if (current()) void this.fail(error instanceof Error ? error.message : 'Не удалось получить кадр записи.') }
          finally { if (current()) this.frameBusy = false }
        }
        this.frameTimer = setInterval(() => { void capture() }, Math.round(1000 / settings.fps))
      } else if (display) {
        const size = macRecordingSize(Math.round(display.bounds.width * display.scaleFactor), Math.round(display.bounds.height * display.scaleFactor))
        this.engine = engine
        engine.start(settings, macRecordingInput(size.width, size.height, settings.fps), path, true, {
          path: app.isPackaged ? join(process.resourcesPath, 'mac-stream-capture') : join(app.getAppPath(), 'build/mac-stream-capture'),
          args: [String(display.id), String(size.width), String(size.height), String(settings.fps), '--record'] })
      }
      await this.command('resume')
      if (!current()) throw new Error('Запуск записи отменён.')
      this.status = { ...this.status, phase: 'running', startedAt: Date.now() }
      this.routingTimer = setInterval(() => { try { validateRoute() } catch (error) { void this.fail(String((error as Error).message)) } }, 500)
      diagnosticLog('record', `Mac start format=${settings.format} fps=${settings.fps} source=${internal ? 'internal' : 'display'} audio=${settings.audio}`)
      return true
    } catch (error) {
      if (current()) await this.fail(error instanceof Error ? error.message : 'Не удалось начать запись.')
      throw error
    } finally { if (current()) this.busy = false }
  }

  async stop(): Promise<void> {
    if (this.finalizing) return this.finalizing
    this.finalizing = this.finalize()
    try { await this.finalizing } finally { this.finalizing = null }
  }
  private async finalize(): Promise<void> {
    if (!active(this.status)) return
    ++this.epoch
    const previous = this.snapshot()
    this.status = { ...previous, phase: 'stopping' }
    clearInterval(this.frameTimer); clearInterval(this.routingTimer)
    this.frameTimer = undefined; this.routingTimer = undefined
    this.closeWorker()
    const engine = this.engine
    this.engine = null
    let clean = false
    try { clean = await engine?.stop() ?? true }
    finally {
      if (this.powerId !== null) powerSaveBlocker.stop(this.powerId)
      this.powerId = null; this.frameBusy = false; this.busy = false
      this.audioDisplayId = null; this.displayId = null; this.settings = null; this.internal = false
      if (clean && previous.path && !this.failure) this.lastPath = previous.path
      const error = this.failure || (!clean ? 'Не удалось корректно завершить файл. Проверьте запись.' : undefined)
      this.status = { ...previous, phase: error ? 'error' : 'idle', error, path: previous.path || this.lastPath,
        sizeBytes: this.snapshot().sizeBytes }
      diagnosticLog('record', `Mac stop clean=${clean} error=${error || '-'} frames=${previous.frames}`)
    }
  }
  private async fail(message: string): Promise<void> {
    if (!active(this.status) || this.status.phase === 'stopping') return
    this.failure = message
    await this.stop()
  }
  async beforeProgramHide(): Promise<void> {
    // Finish physical-screen capture before the desktop can become visible.
    // Internal recording remains attached to its private composition window.
    if (!this.internal && active(this.status)) await this.stop()
  }
  async shutdown(): Promise<void> { await Promise.allSettled([this.stop(), this.editor.shutdown()]) }
}
