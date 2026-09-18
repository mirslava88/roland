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
  private captureBusy = false
  private inputBackpressured = false
  private internalProgram = false
  private stopping = false

  private readonly resourceDirectory = app.isPackaged
    ? join(process.resourcesPath, 'virtual-camera')
    : join(app.getAppPath(), 'native', 'virtual-camera', 'bin', 'x64', 'Release')
  private readonly hostPath = join(this.resourceDirectory, 'PDMVirtualCameraHost.exe')
  private readonly sourcePath = join(this.resourceDirectory, 'PDMVirtualCameraSource.dll')

  constructor(
    private control: () => BrowserWindow | null,
    private programDisplay: () => number | null,
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
      if (!this.internalProgram && this.statusValue.phase === 'running' && display.id === this.programDisplay()) {
        this.fail('Эфирный экран отключён. Виртуальная камера остановлена.')
      }
    })
  }

  isInternalProgramOutputActive(): boolean {
    return this.internalProgram && (this.statusValue.phase === 'starting' || this.statusValue.phase === 'running')
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
    const result = await this.runHost(['--elevate-install', this.sourcePath])
    const installed = result.code === 0 && await this.isInstalled()
    this.statusValue = {
      ...freshStatus(),
      installed,
      available: installed,
      phase: installed ? 'idle' : 'error',
      error: installed ? null : 'Установка отменена или Windows не разрешила зарегистрировать виртуальную камеру.'
    }
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
    child.stdin.on('drain', () => { this.inputBackpressured = false })
    const capture = async (): Promise<void> => {
      if (this.captureBusy || this.inputBackpressured || this.process !== child || this.statusValue.phase !== 'running') return
      const window = this.programWindow()
      if (!window || window.isDestroyed()) { this.fail('Внутренний программный выход закрылся.'); return }
      this.captureBusy = true
      try {
        const image = await window.webContents.capturePage()
        const frame = fitNativeImageToVirtualCameraFrame(image)
        this.inputBackpressured = !child.stdin.write(frame)
      } catch (error) {
        this.fail(`Не удалось получить кадр программного выхода: ${cleanIpcError(error)}`)
      } finally {
        this.captureBusy = false
      }
    }
    void capture()
    this.frameTimer = setInterval(() => { void capture() }, Math.round(1000 / FPS))
  }

  private async start(displayId: number | null): Promise<VirtualCameraStatus> {
    if (this.statusValue.phase === 'running' || this.statusValue.phase === 'starting') return { ...this.statusValue }
    const installed = await this.isInstalled()
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
    this.stopping = false
    const args = display
      ? (() => {
          const physical = screen.dipToScreenRect(null, display.bounds)
          return ['--display', '--x', String(physical.x), '--y', String(physical.y), '--width', String(physical.width), '--height', String(physical.height)]
        })()
      : ['--internal']
    const child = spawn(this.hostPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.process = child
    let errors = ''
    child.stderr.on('data', (chunk: Buffer) => { errors = `${errors}${chunk.toString('utf8')}`.slice(-2000) })
    child.once('exit', (code) => {
      if (this.process !== child) return
      this.process = null
      clearInterval(this.frameTimer)
      this.frameTimer = undefined
      this.internalProgram = false
      if (!this.stopping && this.statusValue.phase !== 'idle') {
        this.statusValue = { ...freshStatus(), installed: true, available: true, phase: 'error', error: errors.trim() || `Компонент виртуальной камеры остановился с кодом ${code ?? 'unknown'}.` }
      }
    })
    try {
      await this.waitUntilRunning(child)
      if (this.process !== child) throw new Error('Запуск виртуальной камеры был отменён.')
      this.statusValue = { ...this.statusValue, phase: 'running', startedAt: Date.now(), error: null }
      if (!display) this.startInternalCapture(child)
      diagnosticLog('virtual-camera', `start source=${display ? `display:${display.id}` : 'internal'} output=${WIDTH}x${HEIGHT}@${FPS}`)
      return { ...this.statusValue }
    } catch (error) {
      this.fail(cleanIpcError(error))
      throw error
    }
  }

  stop(): VirtualCameraStatus {
    this.stopping = true
    clearInterval(this.frameTimer)
    this.frameTimer = undefined
    const child = this.process
    this.process = null
    if (child && !child.killed) {
      child.stdin.end()
      const timeout = setTimeout(() => { if (!child.killed) child.kill() }, 3000)
      child.once('exit', () => clearTimeout(timeout))
    }
    this.internalProgram = false
    this.captureBusy = false
    this.inputBackpressured = false
    const installed = this.statusValue.installed
    this.statusValue = {
      ...freshStatus(),
      installed,
      available: supported() && installed && this.binariesAvailable()
    }
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
    diagnosticLog('virtual-camera', `error=${message}`)
  }
}
