import { app, BrowserWindow, ipcMain, screen } from 'electron'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { release } from 'os'
import type { IpcMainInvokeEvent } from 'electron'
import type { VirtualCameraStatus } from '../shared/virtual-camera'
import { diagnosticLog } from './diagnostic-log'
import { fitNativeImageToVirtualCameraFrame } from './virtual-camera-frame'

const NAME = 'PDM Virtual Camera'
const WIDTH = 1920 as const
const HEIGHT = 1080 as const
const FPS = 30 as const
const FRAME_BYTES = WIDTH * HEIGHT * 4
const PIPE_CONTROL_MAGIC = 'PDMVCR01'
const PIPE_COMMAND_USE_DISPLAY = 1

const windowsBuild = (): number => Number.parseInt(release().split('.')[2] || '0', 10)
const supported = (): boolean => process.platform === 'win32' && windowsBuild() >= 22000

const freshStatus = (): VirtualCameraStatus => ({
  phase: 'idle',
  supported: supported(),
  installed: false,
  available: false,
  source: null,
  error: null,
  name: NAME,
  width: WIDTH,
  height: HEIGHT,
  fps: FPS,
  startedAt: null
})

const cleanIpcError = (error: unknown): string => String(error instanceof Error ? error.message : error)
  .replace(/[\r\n\t]+/g, ' ')
  .slice(0, 400)

export class VirtualCameraManager {
  private process: ChildProcessWithoutNullStreams | null = null
  private statusValue: VirtualCameraStatus = freshStatus()
  private frameTimer?: NodeJS.Timeout
  private fallbackCaptureTimer?: NodeJS.Timeout
  private captureBusy = false
  private inputBackpressured = false
  private internalProgram = false
  private displaySourceId: number | null = null
  private preferredDisplayId: number | null = null
  private switchingToDisplayId: number | null = null
  private internalCaptureFailures = 0
  private internalFramesSubmitted = 0
  private fallbackAwaitingProgramFrame = false
  private internalCaptureGeneration = 0
  private stopping = false
  private lifecycleGeneration = 0
  private sourceRequestId = 0

  private readonly resourceDirectory = app.isPackaged
    ? join(process.resourcesPath, 'virtual-camera')
    : join(app.getAppPath(), 'native', 'virtual-camera', 'bin', 'x64', 'Release')
  private readonly hostPath = join(this.resourceDirectory, 'PDMVirtualCameraHost.exe')
  private readonly sourcePath = join(this.resourceDirectory, 'PDMVirtualCameraSource.dll')

  constructor(
    private control: () => BrowserWindow | null,
    private programWindow: () => BrowserWindow | null
  ) {
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const control = this.control()
        if (!control || event.sender !== control.webContents || event.senderFrame !== event.sender.mainFrame) {
          throw new Error('Недоступно.')
        }
        return fn(...args)
      })
    }
    handle('virtual-camera-status', () => this.refreshStatus())
    handle('virtual-camera-install', () => this.install())
    handle('virtual-camera-start', (displayId: number | null) => this.start(displayId))
    handle('virtual-camera-stop', () => this.stop())

    screen.on('display-removed', (_event, display) => {
      if (this.statusValue.phase === 'running' &&
          (display.id === this.displaySourceId || display.id === this.switchingToDisplayId)) {
        this.switchToInternalCapture(display.id)
      }
    })
    screen.on('display-added', (_event, display) => {
      if (!this.internalProgram || this.statusValue.phase !== 'running' || display.id !== this.preferredDisplayId) return
      const generation = this.lifecycleGeneration
      setTimeout(() => {
        if (generation === this.lifecycleGeneration && display.id === this.preferredDisplayId) {
          this.usePhysicalProgramDisplay(display.id)
        }
      }, 1200)
    })
  }

  isInternalProgramOutputActive(): boolean {
    return this.internalProgram && (this.statusValue.phase === 'starting' || this.statusValue.phase === 'running')
  }

  private publishStatus(): void {
    const control = this.control()
    if (!control || control.isDestroyed()) return
    control.webContents.send('virtual-camera-status-changed', { ...this.statusValue })
  }

  private binariesAvailable(): boolean {
    return existsSync(this.hostPath) && existsSync(this.sourcePath)
  }

  private runHost(args: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      execFile(this.hostPath, args, { windowsHide: true, timeout: 120_000 }, (error, stdout) => {
        if (error && typeof error.code !== 'number') { reject(error); return }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout: String(stdout).trim() })
      })
    })
  }

  private async isInstalled(): Promise<boolean> {
    if (!this.binariesAvailable()) return false
    try { return (await this.runHost(['--source-registered'])).code === 0 }
    catch { return false }
  }

  private async refreshStatus(): Promise<VirtualCameraStatus> {
    const installed = await this.isInstalled()
    this.statusValue = {
      ...this.statusValue,
      supported: supported(),
      installed,
      available: supported() && installed && this.binariesAvailable()
    }
    return { ...this.statusValue }
  }

  private async install(): Promise<VirtualCameraStatus> {
    if (!supported()) throw new Error('Виртуальная камера PDM доступна только в Windows 11 и более новых версиях Windows.')
    if (!this.binariesAvailable()) throw new Error('Компоненты виртуальной камеры не найдены. Пересоберите или переустановите PDM.')
    if (this.statusValue.phase === 'running' || this.statusValue.phase === 'starting') throw new Error('Сначала остановите виртуальную камеру.')
    this.statusValue = { ...this.statusValue, phase: 'installing', error: null }
    const owner = app.getName().endsWith('-stream')
      ? 'com.roland.presentation-display-manager.stream'
      : 'com.roland.presentation-display-manager'
    const result = await this.runHost(['--elevate-install', this.sourcePath, owner])
    const installed = result.code === 0 && await this.isInstalled()
    const installError = result.code === 1223
      ? 'Установка виртуальной камеры отменена в запросе Windows.'
      : result.code === 32
        ? 'Файл виртуальной камеры занят другим приложением. Закройте программы видеосвязи и повторите установку PDM.'
        : result.code !== 0
          ? `Не удалось зарегистрировать виртуальную камеру в Windows (код ${result.code}). Повторите установку PDM с правами администратора.`
          : 'Windows не подтвердила регистрацию виртуальной камеры. Повторите установку PDM.'
    this.statusValue = {
      ...freshStatus(),
      installed,
      available: installed,
      phase: installed ? 'idle' : 'error',
      error: installed ? null : installError
    }
    this.publishStatus()
    diagnosticLog('virtual-camera', `source install result=${result.code} installed=${installed}`)
    return { ...this.statusValue }
  }

  private waitUntilRunning(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer = ''
      const timeout = setTimeout(() => finish(new Error('Виртуальная камера не ответила вовремя.')), 15_000)
      const finish = (error?: Error): void => {
        clearTimeout(timeout)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        if (error) reject(error); else resolve()
      }
      const onExit = (code: number | null): void => finish(new Error(`Компонент виртуальной камеры завершился с кодом ${code ?? 'unknown'}.`))
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          try {
            const value = JSON.parse(line) as { phase?: string; message?: string }
            if (value.phase === 'running') { finish(); return }
            if (value.phase === 'error') { finish(new Error(value.message || 'Не удалось запустить виртуальную камеру.')); return }
          } catch { /* ignore native diagnostics that are not JSON */ }
        }
      }
      child.stdout.on('data', onData)
      child.once('exit', onExit)
    })
  }

  private startInternalCapture(child: ChildProcessWithoutNullStreams): void {
    if (this.frameTimer) return
    const generation = ++this.internalCaptureGeneration
    this.captureBusy = false
    this.inputBackpressured = false
    clearTimeout(this.fallbackCaptureTimer)
    this.fallbackCaptureTimer = undefined
    this.fallbackAwaitingProgramFrame = false
    child.stdin.removeAllListeners('drain')
    child.stdin.on('drain', () => {
      if (generation !== this.internalCaptureGeneration || this.process !== child) return
      this.inputBackpressured = false
      if (this.internalFramesSubmitted === 1) {
        diagnosticLog('virtual-camera', 'first internal Program frame flushed to native host')
      }
    })
    const capture = async (): Promise<void> => {
      if (this.captureBusy || this.inputBackpressured || this.process !== child || this.statusValue.phase !== 'running') return
      const window = this.programWindow()
      if (!window || window.isDestroyed()) {
        this.internalCaptureFailures += 1
        if (this.internalCaptureFailures === 1 || this.internalCaptureFailures % 90 === 0) {
          diagnosticLog('virtual-camera', 'internal frame pending: Program renderer is unavailable')
        }
        return
      }
      this.captureBusy = true
      try {
        const image = await window.webContents.capturePage()
        const frame = fitNativeImageToVirtualCameraFrame(image)
        // A physical Program route may have returned while capturePage() was
        // still resolving. Never append that stale internal frame after the
        // native use-display command: the host would otherwise switch back to
        // internal mode and stay there until another renderer update.
        if (
          generation !== this.internalCaptureGeneration ||
          this.process !== child ||
          !this.internalProgram
        ) return
        this.inputBackpressured = !child.stdin.write(frame)
        this.internalFramesSubmitted += 1
        if (this.internalFramesSubmitted === 1) {
          diagnosticLog(
            'virtual-camera',
            `first internal Program frame submitted bytes=${frame.length} backpressured=${this.inputBackpressured}`
          )
        }
        if (this.internalCaptureFailures > 0) {
          diagnosticLog('virtual-camera', `internal frame recovered after failures=${this.internalCaptureFailures}`)
          this.internalCaptureFailures = 0
        }
      } catch (error) {
        if (generation !== this.internalCaptureGeneration || this.process !== child) return
        // A window move during HDMI hot-plug can reject a single capture.
        // Keep the device registered and retry while the native source holds
        // the last complete frame instead of disconnecting conferencing apps.
        this.internalCaptureFailures += 1
        if (this.internalCaptureFailures === 1 || this.internalCaptureFailures % 90 === 0) {
          diagnosticLog(
            'virtual-camera',
            `internal frame retry failures=${this.internalCaptureFailures} error=${cleanIpcError(error)}`
          )
        }
      } finally {
        if (generation === this.internalCaptureGeneration && this.process === child) this.captureBusy = false
      }
    }
    void capture()
    this.frameTimer = setInterval(() => { void capture() }, Math.round(1000 / FPS))
  }

  /**
   * The physical Program surface may disappear before the renderer has
   * republished the current PPTX/PDF frame into the preserved Chromium
   * surface. Keep the last complete physical frame in shared memory until the
   * renderer confirms that its replacement frame is painted. This prevents a
   * transient transparent/empty capture from replacing the presentation in
   * an already-open conferencing application.
   */
  notifyProgramOutputReady(): void {
    if (!this.fallbackAwaitingProgramFrame) return
    const child = this.process
    if (!child || child.killed || !this.internalProgram || this.statusValue.phase !== 'running') return
    diagnosticLog('virtual-camera', 'internal Program renderer ready; beginning live frame handoff')
    this.startInternalCapture(child)
  }

  private switchToInternalCapture(disconnectedDisplayId: number): void {
    const child = this.process
    if (!child || child.killed || this.statusValue.phase !== 'running') return
    if (this.internalProgram && this.switchingToDisplayId === null) return
    this.sourceRequestId++
    this.internalProgram = true
    this.displaySourceId = null
    this.preferredDisplayId = disconnectedDisplayId
    this.switchingToDisplayId = null
    this.statusValue = { ...this.statusValue, source: 'internal', error: null }
    this.publishStatus()
    this.fallbackAwaitingProgramFrame = true
    // Capture/video sources normally acknowledge their first rendered frame,
    // but never let a missing acknowledgement freeze the fallback forever.
    // Until this timer fires the native source deliberately keeps its last
    // complete physical frame instead of replacing it with an empty surface.
    clearTimeout(this.fallbackCaptureTimer)
    this.fallbackCaptureTimer = setTimeout(() => {
      if (!this.fallbackAwaitingProgramFrame || this.process !== child) return
      diagnosticLog('virtual-camera', 'internal Program readiness timeout; beginning guarded frame handoff')
      this.startInternalCapture(child)
    }, 4_000)
    diagnosticLog(
      'virtual-camera',
      `physical source disconnected display=${disconnectedDisplayId}; awaiting internal Program frame`
    )
  }

  /**
   * Return the already-running Media Foundation camera to Desktop Duplication
   * when its physical Program display comes back. The native host switches
   * writers inside the same process, so conferencing applications keep the
   * same camera session and immediately regain native PowerPoint/Scene pixels.
   */
  usePhysicalProgramDisplay(displayId: number): void {
    this.preferredDisplayId = displayId
    if (
      !this.internalProgram ||
      this.statusValue.phase !== 'running' ||
      this.switchingToDisplayId === displayId
    ) return
    const display = screen.getAllDisplays().find((value) => value.id === displayId)
    const child = this.process
    if (!display || !child || child.killed) return

    clearInterval(this.frameTimer)
    this.frameTimer = undefined
    this.internalCaptureGeneration += 1
    clearTimeout(this.fallbackCaptureTimer)
    this.fallbackCaptureTimer = undefined
    this.fallbackAwaitingProgramFrame = false
    this.switchingToDisplayId = displayId

    const physical = screen.dipToScreenRect(null, display.bounds)
    const packet = Buffer.alloc(FRAME_BYTES)
    packet.write(PIPE_CONTROL_MAGIC, 0, 'ascii')
    packet.writeUInt32LE(PIPE_COMMAND_USE_DISPLAY, 8)
    packet.writeInt32LE(physical.x, 12)
    packet.writeInt32LE(physical.y, 16)
    packet.writeInt32LE(physical.width, 20)
    packet.writeInt32LE(physical.height, 24)
    packet.writeUInt32LE(++this.sourceRequestId, 28)
    this.inputBackpressured = !child.stdin.write(packet)
    const requestId = this.sourceRequestId
    this.fallbackCaptureTimer = setTimeout(() => {
      if (this.process !== child || this.sourceRequestId !== requestId || this.switchingToDisplayId !== displayId) return
      this.sourceRequestId++
      this.switchingToDisplayId = null
      this.internalProgram = true
      this.displaySourceId = null
      this.statusValue = { ...this.statusValue, source: 'internal', error: null }
      this.publishStatus()
      this.startInternalCapture(child)
      diagnosticLog('virtual-camera', 'physical source acknowledgement timed out; internal capture retained')
    }, 4000)
    diagnosticLog(
      'virtual-camera',
      `physical source restore requested display=${displayId} bounds=${physical.width}x${physical.height}`
    )
  }

  private observeRuntimeStatus(child: ChildProcessWithoutNullStreams): void {
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.process !== child) return
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as { phase?: string; message?: string; requestId?: number }
          if (value.phase === 'source' && value.message === 'display') {
            const displayId = this.switchingToDisplayId
            if (displayId === null || value.requestId !== this.sourceRequestId) continue
            if (!screen.getAllDisplays().some((display) => display.id === displayId)) {
              this.switchToInternalCapture(displayId)
              continue
            }
            this.internalProgram = false
            clearTimeout(this.fallbackCaptureTimer)
            this.fallbackCaptureTimer = undefined
            this.displaySourceId = displayId
            this.switchingToDisplayId = null
            this.statusValue = { ...this.statusValue, source: 'display', error: null }
            this.publishStatus()
            diagnosticLog('virtual-camera', `physical source restored display=${displayId} without camera restart`)
          } else if (value.phase === 'capture-retrying' || value.phase === 'capture-recovered') {
            // A delayed notification from an old desktop must not overwrite a newer
            // internal route (or another physical-source request).
            if (value.requestId !== this.sourceRequestId || this.internalProgram ||
                this.displaySourceId === null || this.statusValue.phase !== 'running') continue
            const recovering = value.phase === 'capture-retrying'
            if (recovering && this.statusValue.error === 'Восстанавливаем изображение виртуальной камеры…') continue
            this.statusValue = {
              ...this.statusValue,
              error: recovering ? 'Восстанавливаем изображение виртуальной камеры…' : null
            }
            this.publishStatus()
            diagnosticLog('virtual-camera', recovering
              ? `desktop capture interrupted; retrying without camera restart: ${value.message || 'unknown error'}`
              : 'desktop capture recovered without camera restart')
          } else if (value.phase === 'source-error') {
            if (this.switchingToDisplayId === null || value.requestId !== this.sourceRequestId) continue
            const failedDisplayId = this.switchingToDisplayId
            this.switchingToDisplayId = null
            this.internalProgram = true
            this.displaySourceId = null
            this.statusValue = { ...this.statusValue, source: 'internal', error: null }
            this.publishStatus()
            this.startInternalCapture(child)
            diagnosticLog(
              'virtual-camera',
              `physical source restore failed display=${failedDisplayId ?? '-'}; internal capture retained`
            )
          }
        } catch { /* ignore native diagnostics that are not JSON */ }
      }
    })
  }

  private async start(displayId: number | null): Promise<VirtualCameraStatus> {
    if (['running', 'starting', 'installing'].includes(this.statusValue.phase)) return { ...this.statusValue }
    const generation = ++this.lifecycleGeneration
    this.statusValue = { ...this.statusValue, phase: 'starting', error: null }
    this.publishStatus()
    try {
      const installed = await this.isInstalled()
      if (generation !== this.lifecycleGeneration) return { ...this.statusValue }
      if (!supported()) throw new Error('Виртуальная камера PDM доступна только в Windows 11 и более новых версиях Windows.')
      if (!this.binariesAvailable()) throw new Error('Компоненты виртуальной камеры не найдены. Пересоберите или переустановите PDM.')
      if (!installed) throw new Error('Сначала установите компонент виртуальной камеры.')

      const display = displayId === null ? null : screen.getAllDisplays().find((value) => value.id === displayId)
      if (displayId !== null && !display) throw new Error('Назначенный эфирный экран отключён.')
      const control = this.control()
      if (display && control && screen.getDisplayMatching(control.getBounds()).id === display.id) {
        throw new Error('Панель управления PDM нельзя выдавать как виртуальную камеру. Выберите отдельный эфирный экран.')
      }
      if (!display) {
        const internalWindow = this.programWindow()
        if (!internalWindow || internalWindow.isDestroyed()) throw new Error('Внутренний программный выход ещё не готов.')
        internalWindow.setIgnoreMouseEvents(true)
        internalWindow.setOpacity(0)
        if (!internalWindow.isVisible()) internalWindow.showInactive()
      }

      this.statusValue = {
        ...freshStatus(),
        supported: true,
        installed: true,
        available: true,
        phase: 'starting',
        source: display ? 'display' : 'internal'
      }
      this.internalProgram = !display
      this.displaySourceId = display?.id ?? null
      this.preferredDisplayId = display?.id ?? null
      this.switchingToDisplayId = null
      this.internalCaptureFailures = 0
      this.internalFramesSubmitted = 0
      this.fallbackAwaitingProgramFrame = false
      this.stopping = false
      const args = display
        ? (() => {
            const physical = screen.dipToScreenRect(null, display.bounds)
            return ['--display', '--x', String(physical.x), '--y', String(physical.y), '--width', String(physical.width), '--height', String(physical.height)]
          })()
        : ['--internal']
      args.push('--request-id', String(this.sourceRequestId))
      const child = spawn(this.hostPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.process = child
      let errors = ''
      child.stderr.on('data', (chunk: Buffer) => { errors = `${errors}${chunk.toString('utf8')}`.slice(-2000) })
      child.once('exit', (code) => {
        if (this.process !== child) return
        this.process = null
        clearInterval(this.frameTimer)
        this.frameTimer = undefined
        clearTimeout(this.fallbackCaptureTimer)
        this.fallbackCaptureTimer = undefined
        this.internalProgram = false
        this.displaySourceId = null
        this.preferredDisplayId = null
        this.switchingToDisplayId = null
        this.internalCaptureFailures = 0
        this.internalFramesSubmitted = 0
        this.fallbackAwaitingProgramFrame = false
        this.internalCaptureGeneration += 1
        if (!this.stopping && this.statusValue.phase !== 'idle') {
          this.statusValue = { ...freshStatus(), installed: true, available: true, phase: 'error', error: errors.trim() || `Компонент виртуальной камеры остановился с кодом ${code ?? 'unknown'}.` }
          this.publishStatus()
        }
      })
      await this.waitUntilRunning(child)
      if (generation !== this.lifecycleGeneration) return { ...this.statusValue }
      if (this.process !== child) throw new Error('Запуск виртуальной камеры был отменён.')
      this.observeRuntimeStatus(child)
      this.statusValue = { ...this.statusValue, phase: 'running', startedAt: Date.now(), error: null }
      this.publishStatus()
      if (!display) this.startInternalCapture(child)
      diagnosticLog('virtual-camera', `start source=${display ? `display:${display.id}` : 'internal'} output=${WIDTH}x${HEIGHT}@${FPS}`)
      return { ...this.statusValue }
    } catch (error) {
      if (generation !== this.lifecycleGeneration) return { ...this.statusValue }
      this.fail(cleanIpcError(error))
      throw error
    }
  }

  stop(): VirtualCameraStatus {
    this.lifecycleGeneration++
    this.sourceRequestId++
    this.stopping = true
    clearInterval(this.frameTimer)
    this.frameTimer = undefined
    clearTimeout(this.fallbackCaptureTimer)
    this.fallbackCaptureTimer = undefined
    const child = this.process
    this.process = null
    if (child && !child.killed) {
      child.stdin.end()
      const timeout = setTimeout(() => { if (!child.killed) child.kill() }, 3000)
      child.once('exit', () => clearTimeout(timeout))
    }
    this.internalProgram = false
    this.displaySourceId = null
    this.preferredDisplayId = null
    this.switchingToDisplayId = null
    this.internalCaptureFailures = 0
    this.internalFramesSubmitted = 0
    this.fallbackAwaitingProgramFrame = false
    this.internalCaptureGeneration += 1
    this.captureBusy = false
    this.inputBackpressured = false
    const installed = this.statusValue.installed
    this.statusValue = {
      ...freshStatus(),
      installed,
      available: supported() && installed && this.binariesAvailable()
    }
    this.publishStatus()
    diagnosticLog('virtual-camera', 'stop')
    return { ...this.statusValue }
  }

  private fail(message: string): void {
    const installed = this.statusValue.installed
    this.stop()
    this.statusValue = {
      ...freshStatus(),
      installed,
      available: supported() && installed && this.binariesAvailable(),
      phase: 'error',
      error: message
    }
    this.publishStatus()
    diagnosticLog('virtual-camera', `error=${message}`)
  }
}
