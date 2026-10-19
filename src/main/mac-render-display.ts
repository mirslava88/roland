import { app, screen, type Display, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { join } from 'path'
import { createInterface } from 'readline'
import { diagnosticLog } from './diagnostic-log'
import type { PixelSize } from '../shared/presentation-output'

export const MAC_RENDER_DISPLAY_LABEL = 'PDM Internal Render Surface'
export function isMacRenderDisplay(display: Pick<Display, 'label'>): boolean {
  return process.platform === 'darwin' && display.label?.startsWith(MAC_RENDER_DISPLAY_LABEL) === true
}

interface CursorGuard {
  startRenderCursorGuard(): boolean
  refreshRenderCursorGuard(): boolean
  stopRenderCursorGuard(): void
  configureRenderDisplay(id: number, layout: number[][]): boolean
}

type Surface = { id: number; width: number; height: number }
class MacRenderDisplay {
  private child: ChildProcessWithoutNullStreams | null = null
  private surface: Surface | null = null
  private guard: CursorGuard | null = null
  private pending: { resolve: (value: Surface) => void; reject: (error: Error) => void } | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private unavailableUntil = 0
  private lastLayout: number[][] = []
  private tileWidth = 1280
  private tileHeight = 720
  private compositor: { window: BrowserWindow; size: PixelSize } | null = null
  private compositorHeight = 0

  player(pixels: PixelSize, slot: number): Promise<{ display: Display; x: number; y: number } | null> {
    return this.reserve(pixels, slot === 1 ? 1 : 0)
  }

  compositorWindow(pixels: PixelSize, window: BrowserWindow): Promise<{ display: Display; x: number; y: number } | null> {
    return this.reserve(pixels, 'compositor', window)
  }

  releaseCompositor(): void { this.compositor = null }

  private reserve(pixels: PixelSize, slot: 0 | 1 | 'compositor', window?: BrowserWindow) {
    const result = this.tail.then(async () => {
      if (slot === 'compositor') {
        this.compositor = { window: window!, size: pixels }
        this.compositorHeight = Math.max(this.compositorHeight, pixels.height)
      } else {
        this.tileWidth = Math.max(this.tileWidth, pixels.width)
        this.tileHeight = Math.max(this.tileHeight, pixels.height)
      }
      const required = {
        // Keep the second player's origin stable when a signal grows from
        // HD to 4K/8K. Moving it only when it is selected leaves its warm
        // capture underneath the enlarged first player in the meantime.
        width: Math.max(8192 + 128 + this.tileWidth, this.compositor?.size.width || 0),
        // Reserve the compositor row before starting either native player.
        // Growing the display later lets AppKit move existing Keynote windows
        // back onto physical monitors, after their bounds were verified.
        height: this.tileHeight + Math.max(this.tileHeight, this.compositorHeight) + 128
      }
      let display = await this.ensureNow(required)
      if (!display && slot === 'compositor' && this.surface &&
          screen.getAllDisplays().some((candidate) => candidate.id === this.surface!.id)) {
        // A mode change can briefly remove the virtual screen from Electron's
        // topology even after the native player verified it. Retry this same
        // online surface once; the normal failure cooldown would otherwise
        // prevent restoring the compositor for a full minute.
        diagnosticLog('pptx-quality', 'retry compositor placement after render display mode change')
        this.unavailableUntil = 0
        display = await this.ensureNow(required)
      }
      if (!display) return null
      const compositorY = display.bounds.y + this.tileHeight + 128
      // Move the compositor out of an enlarged player's area before letting
      // that player start. Window capture must never depend on z-order.
      if (this.compositor && !this.compositor.window.isDestroyed()) {
        this.compositor.window.setContentBounds({ x: display.bounds.x + 64, y: compositorY,
          width: this.compositor.size.width, height: this.compositor.size.height })
      }
      return { display, x: display.bounds.x + (slot === 1 ? 8192 + 128 : 64),
        y: slot === 'compositor' ? compositorY : display.bounds.y + 64 }
    })
    this.tail = result.catch(() => undefined)
    return result
  }

  private native(): CursorGuard {
    if (!this.guard) {
      this.guard = require(app.isPackaged ? join(process.resourcesPath, 'mac-office-accessibility.node')
        : join(__dirname, '../../build/mac-office-accessibility.node')) as CursorGuard
    }
    return this.guard
  }

  refreshCursorGuard(): void {
    if (!this.child || !this.guard) return
    try { this.guard.refreshRenderCursorGuard() }
    catch (error) { diagnosticLog('pptx-quality', `render cursor refresh failed: ${String(error)}`) }
  }

  ensure(pixels: PixelSize): Promise<Display | null> {
    const result = this.tail.then(() => this.ensureNow(pixels))
    this.tail = result.catch(() => undefined)
    return result
  }

  private async ensureNow(pixels: PixelSize): Promise<Display | null> {
    if (this.stopped || Date.now() < this.unavailableUntil) return null
    const width = Math.max(this.surface?.width || 0, Math.ceil(pixels.width) + 256)
    const height = Math.max(this.surface?.height || 0, Math.ceil(pixels.height) + 256)
    // Electron's application connection owns the authoritative desktop layout.
    // A standalone CoreGraphics helper can retain a stale geometry cache.
    const expected = screen.getAllDisplays().filter((d) => d.id !== this.surface?.id)
      .map((d) => [d.id, d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height])
    this.lastLayout = expected
    try {
      if (!this.surface || this.surface.width < width || this.surface.height < height) {
        // Install the mouse boundary before adding any invisible desktop.
        if (!this.native().startRenderCursorGuard()) throw new Error('Render cursor guard unavailable')
        const mode = new Promise<Surface>((resolve, reject) => { this.pending = { resolve, reject } })
        const timeout = setTimeout(() => this.pending?.reject(new Error('Внутренняя поверхность не ответила за 15 секунд')), 15_000)
        try {
          if (!this.child) {
            const path = app.isPackaged ? join(process.resourcesPath, 'mac-render-display')
              : join(__dirname, '../../build/mac-render-display')
            const child = spawn(path, [String(width), String(height)], { stdio: ['pipe', 'pipe', 'pipe'] })
            this.child = child
            const lines = createInterface({ input: child.stdout })
            lines.on('line', (line) => {
              if (this.child !== child || line.length > 4096) return
              try {
                const value = JSON.parse(line) as Surface & { error?: string }
                if (value.error) this.pending?.reject(new Error(value.error))
                else if (Number.isInteger(value.id) && value.id > 0 && value.width > 0 && value.height > 0) {
                  this.surface = value
                  this.pending?.resolve(value)
                }
              } catch { this.pending?.reject(new Error('Некорректный ответ внутренней поверхности')) }
            })
            child.stderr.on('data', (data) => diagnosticLog('pptx-quality', `render helper: ${String(data).slice(0, 500)}`))
            child.stdin.on('error', () => undefined)
            child.on('error', (error) => this.pending?.reject(error))
            child.on('exit', (code, signal) => {
              lines.close()
              if (this.child !== child) return
              this.child = null; this.surface = null
              this.pending?.reject(new Error(`Внутренняя поверхность остановилась (${code ?? signal})`))
              try { this.guard?.stopRenderCursorGuard() } catch { /* process is shutting down */ }
              try { this.guard?.configureRenderDisplay(0, this.lastLayout) } catch { /* monitor may be disconnected */ }
              diagnosticLog('pptx-quality', `render surface stopped code=${code} signal=${signal}`)
            })
          } else {
            this.child.stdin.write(JSON.stringify({ width, height }) + '\n')
          }
          await mode
        } finally { clearTimeout(timeout); this.pending = null }
      }
      // Electron receives display notifications after CoreGraphics applies the
      // mode. Never return a requested size until the actual display matches.
      const deadline = Date.now() + 5000
      let configured = false
      let stableGeometry = ''
      while (Date.now() < deadline && !this.stopped) {
        const display = screen.getAllDisplays().find((d) => d.id === this.surface?.id)
        const layoutExact = expected.every(([id, x, y]) => {
          const actual = screen.getAllDisplays().find((d) => d.id === id)
          return !actual || (actual.bounds.x === x && actual.bounds.y === y)
        })
        if (display && this.surface && (!configured || !layoutExact)) {
          if (!this.native().configureRenderDisplay(this.surface.id, expected)) throw new Error('Не удалось сохранить расположение экранов')
          configured = true; stableGeometry = ''
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        if (display && this.surface && display.bounds.width * display.scaleFactor === this.surface.width &&
            display.bounds.height * display.scaleFactor === this.surface.height && layoutExact) {
          const geometry = JSON.stringify(display.bounds)
          if (stableGeometry === geometry) {
            this.refreshCursorGuard()
            diagnosticLog('pptx-quality', `render surface ready id=${display.id} pixels=${this.surface.width}x${this.surface.height}`)
            return display
          }
          stableGeometry = geometry
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('Внутренняя поверхность не появилась в конфигурации macOS')
    } catch (error) {
      diagnosticLog('pptx-quality', `native render surface unavailable: ${String(error)}`)
      this.unavailableUntil = Date.now() + 60_000
      if (!this.surface) {
        this.child?.kill('SIGTERM')
        if (!this.child) this.guard?.stopRenderCursorGuard()
      }
      return null
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.lastLayout = screen.getAllDisplays().filter((d) => d.id !== this.surface?.id)
      .map((d) => [d.id, d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height])
    this.pending?.reject(new Error('PDM завершает работу'))
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
        child.once('exit', () => { clearTimeout(timeout); resolve() })
        child.stdin.end()
        child.kill('SIGTERM')
      })
    }
    this.child = null; this.surface = null
    this.guard?.stopRenderCursorGuard()
  }
}

export const macRenderDisplay = new MacRenderDisplay()
