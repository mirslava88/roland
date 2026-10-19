import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { cp, mkdir, readFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import { release } from 'os'
import type { VirtualCameraStatus } from '../shared/virtual-camera'
import { fitNativeImageToVirtualCameraFrame } from './virtual-camera-frame'
import { diagnosticLog } from './diagnostic-log'

const execute = promisify(execFile)
const version = (): boolean => {
  const [major, minor] = release().split('.').map(Number)
  return major > 21 || (major === 21 && minor >= 4)
}
const fresh = (): VirtualCameraStatus => ({ phase: 'idle', supported: version(), installed: false,
  available: false, source: null, error: null, name: 'PDM Virtual Camera', width: 1920, height: 1080,
  fps: 30, startedAt: null })

export class MacVirtualCameraManager {
  private statusValue = fresh()
  private writer: ChildProcessWithoutNullStreams | null = null
  private installer: ChildProcessWithoutNullStreams | null = null
  private timer?: NodeJS.Timeout
  private busy = false
  private generation = 0
  private lastCheck = 0
  private checkPending: Promise<VirtualCameraStatus> | null = null
  private preferredDisplayId: number | null = null
  private readonly resources = app.isPackaged ? join(process.resourcesPath, 'mac-virtual-camera')
    : join(app.getAppPath(), 'build/mac-virtual-camera')
  private readonly writerPath = join(this.resources, 'mac-camera-writer')

  constructor(private control: () => BrowserWindow | null, private programWindow: () => BrowserWindow | null) {
    const handle = (name: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(name, (event, ...args: unknown[]) => {
        if (event.sender !== this.control()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Недоступно.')
        return fn(...args)
      })
    }
    handle('virtual-camera-status', () => this.refreshStatus())
    handle('virtual-camera-install', () => this.install())
    handle('virtual-camera-start', (id: number | null) => this.start(id))
    handle('virtual-camera-stop', () => this.stop())
    screen.on('display-removed', (_event, display) => {
      if (this.preferredDisplayId !== display.id || this.statusValue.phase !== 'running') return
      this.statusValue = { ...this.statusValue, source: 'internal' }; this.publish()
    })
  }
  isInternalProgramOutputActive(): boolean {
    return this.statusValue.source === 'internal' && ['starting', 'running'].includes(this.statusValue.phase)
  }
  notifyProgramOutputReady(): void {}
  usePhysicalProgramDisplay(id: number): void {
    this.preferredDisplayId = id
    if (this.statusValue.phase === 'running') { this.statusValue = { ...this.statusValue, source: 'display' }; this.publish() }
  }
  private publish(): void {
    const control = this.control()
    if (control && !control.isDestroyed() && !control.webContents.isDestroyed()) {
      control.webContents.send('virtual-camera-status-changed', { ...this.statusValue })
    }
  }
  private refreshStatus(): Promise<VirtualCameraStatus> {
    if (this.checkPending) return this.checkPending
    if (Date.now() - this.lastCheck < 2500 || this.writer) return Promise.resolve({ ...this.statusValue })
    this.checkPending = (async () => {
      let installed = false
      if (version() && existsSync(this.writerPath)) {
        try { installed = JSON.parse((await execute(this.writerPath, ['--status'], { timeout: 5000 })).stdout).installed === true }
        catch { /* the camera remains unavailable until macOS registers it */ }
      }
      this.statusValue = { ...this.statusValue, installed, available: installed && existsSync(this.writerPath) }
      if (installed && this.statusValue.phase === 'installing') this.statusValue = { ...this.statusValue, phase: 'idle', error: null }
      this.lastCheck = Date.now()
      return { ...this.statusValue }
    })().finally(() => { this.checkPending = null })
    return this.checkPending
  }
  private async install(): Promise<VirtualCameraStatus> {
    if (!version()) throw new Error('Виртуальная камера требует macOS 12.3 или новее.')
    if (this.writer) throw new Error('Сначала выключите виртуальную камеру.')
    if (this.installer) return { ...this.statusValue }
    const source = join(this.resources, 'PDM Camera Installer.app')
    if (!existsSync(source)) throw new Error('Компонент камеры отсутствует. Переустановите PDM.')
    const destination = '/Applications/PDM Camera Installer.app'
    // Camera extensions must be activated by a host in /Applications.
    // Keep an existing version until a complete replacement is copied.
    const staging = `/Applications/.pdm-camera-${process.pid}.app`
    const backup = `/Applications/.pdm-camera-previous-${process.pid}.app`
    try {
      if (existsSync(destination)) {
        const marker = JSON.parse(await readFile(join(destination, 'Contents/Resources/pdm-camera-build.json'), 'utf8'))
        if (marker.bundleId !== 'com.roland.pdm.camera.installer') throw new Error('Это имя в /Applications занято другой программой.')
      }
      await mkdir('/Applications', { recursive: true })
      await cp(source, staging, { recursive: true, force: false, errorOnExist: true })
      if (existsSync(destination)) await rename(destination, backup)
      try { await rename(staging, destination) }
      catch (error) { if (existsSync(backup)) await rename(backup, destination); throw error }
      await rm(backup, { recursive: true, force: true })
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw new Error(`Не удалось установить компонент в /Applications: ${String(error)}`)
    }
    this.statusValue = { ...this.statusValue, phase: 'installing', error: null }; this.publish()
    const child = spawn(join(destination, 'Contents/MacOS/PDM Camera Installer'), [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.installer = child
    let remainder = ''
    const initial = new Promise<VirtualCameraStatus>((resolve) => {
      let settled = false
      const finish = (): void => { if (!settled) { settled = true; clearTimeout(timeout); resolve({ ...this.statusValue }) } }
      const timeout = setTimeout(finish, 10000)
      child.stdout.on('data', (chunk: Buffer) => {
        remainder += chunk.toString(); const lines = remainder.split('\n'); remainder = lines.pop() || ''
        for (const line of lines) {
          try {
            const value = JSON.parse(line) as { phase: string; message?: string; code?: number }
            const failed = value.phase === 'error'
            this.statusValue = { ...this.statusValue, phase: failed ? 'error' : 'installing',
              error: failed ? `macOS отклонила компонент камеры (код ${value.code}): ${value.message}. Для выпуска нужна подпись Developer ID и нотариализация системного расширения.` : value.message || null }
            this.lastCheck = 0; this.publish(); finish()
          } catch { /* only structured status is shown */ }
        }
      })
      child.on('error', (error) => { this.statusValue = { ...this.statusValue, phase: 'error', error: String(error) }; this.publish(); finish() })
      child.on('exit', (code) => {
        if (this.installer === child) this.installer = null
        if (code !== 0 && this.statusValue.phase !== 'error') this.statusValue = { ...this.statusValue, phase: 'error', error: 'macOS отклонила установщик камеры. Для установки собственной камеры нужна сборка с подписью Developer ID и проверкой Apple.' }
        this.lastCheck = 0; this.publish(); finish()
      })
    })
    return initial
  }
  private async start(displayId: number | null): Promise<VirtualCameraStatus> {
    if (this.writer || this.statusValue.phase === 'starting') return { ...this.statusValue }
    const token = ++this.generation
    if (!(await this.refreshStatus()).available) throw new Error('Установите и разрешите виртуальную камеру PDM в macOS.')
    if (token !== this.generation) return { ...this.statusValue }
    if (displayId !== null && !screen.getAllDisplays().some(d => d.id === displayId)) throw new Error('Эфирный экран отключён.')
    const win = this.programWindow()
    if (!win || win.isDestroyed()) throw new Error('Эфирное окно PDM не готово.')
    if (displayId !== null && this.control() && screen.getDisplayMatching(this.control()!.getBounds()).id === displayId) throw new Error('Панель управления нельзя выдавать как камеру.')
    this.preferredDisplayId = displayId
    this.statusValue = { ...this.statusValue, phase: 'starting', source: displayId === null ? 'internal' : 'display', error: null }; this.publish()
    const child = spawn(this.writerPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.writer = child
    child.stdin.on('error', () => this.fail('Компонент камеры прекратил приём кадров.', token))
    child.on('error', () => this.fail('Не удалось запустить компонент камеры.', token))
    child.on('exit', () => this.fail('Компонент камеры остановился.', token))
    try {
      await new Promise<void>((resolve, reject) => {
        let remainder = ''
        const timeout = setTimeout(() => reject(new Error('Камера не ответила вовремя.')), 10000)
        child.once('error', (error) => { clearTimeout(timeout); reject(error) })
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('Компонент камеры остановился.')) })
        child.stdout.on('data', (chunk: Buffer) => {
          remainder += chunk.toString(); const lines = remainder.split('\n'); remainder = lines.pop() || ''
          for (const line of lines) {
            try { const status = JSON.parse(line); clearTimeout(timeout); if (status.phase === 'running') resolve(); else if (status.phase === 'error') reject(new Error(status.message)) } catch { /* ignore diagnostics */ }
          }
        })
      })
      if (token !== this.generation) return { ...this.statusValue }
      this.statusValue = { ...this.statusValue, phase: 'running', startedAt: Date.now() }; this.publish()
      const capture = async (): Promise<void> => {
        if (this.busy || this.writer !== child || child.stdin.writableNeedDrain) return
        const output = this.programWindow(); if (!output || output.isDestroyed()) return
        this.busy = true
        try {
          const frame = fitNativeImageToVirtualCameraFrame(await output.webContents.capturePage())
          if (this.writer === child && token === this.generation) child.stdin.write(frame)
        } catch { /* retry a window that is being moved */ }
        finally { this.busy = false }
      }
      void capture(); this.timer = setInterval(() => { void capture() }, 33)
      diagnosticLog('virtual-camera', 'Mac camera started 1920x1080@30')
      return { ...this.statusValue }
    } catch (error) { this.fail(String(error), token); throw error }
  }
  stop(): VirtualCameraStatus {
    this.generation++; clearInterval(this.timer); this.timer = undefined; this.busy = false
    const child = this.writer; this.writer = null
    if (child) { child.stdin.end(); const timeout = setTimeout(() => child.kill(), 2000); child.once('exit', () => clearTimeout(timeout)) }
    this.statusValue = { ...this.statusValue, phase: 'idle', source: null, startedAt: null, error: null }; this.publish()
    return { ...this.statusValue }
  }
  private fail(message: string, token: number): void {
    if (token !== this.generation) return
    this.stop(); this.statusValue = { ...this.statusValue, phase: 'error', error: message }; this.publish()
    diagnosticLog('virtual-camera', `Mac camera failed: ${message}`)
  }
}
