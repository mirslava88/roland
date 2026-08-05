import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { createInterface, Interface } from 'readline'
import { diagnosticLog, formatDiagnosticError } from './diagnostic-log'
import { scriptPath } from './paths'

export interface NativeWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeTopLevelWindow {
  /** Unsigned HWND encoded as a decimal string so it is never rounded by JSON. */
  hwnd: string
  ownerHwnd: string | null
  pid: number
  threadId: number
  zOrder: number
  title: string
  className: string
  processName: string
  /** Executable path used only inside the main process to resolve an app icon. */
  processPath: string
  visible: boolean
  minimized: boolean
  maximized: boolean
  cloaked: boolean
  hung: boolean
  toolWindow: boolean
  appWindow: boolean
  noActivate: boolean
  bounds: NativeWindowBounds
  normalBounds: NativeWindowBounds
  /** Chromium/Electron's Windows source id for this HWND. */
  captureSourceId: string
}

interface RawNativeTopLevelWindow extends Omit<NativeTopLevelWindow, 'captureSourceId'> {}

export interface NativeWindowRestoreResult {
  hwnd: string
  valid: boolean
  requested: boolean
  wasMinimized: boolean
  minimized: boolean
  visible: boolean
  activated: boolean
  foreground: boolean
}

export interface NativeWindowListOptions {
  /** PIDs belonging to PDM (main + renderer processes) that must not be listed. */
  excludedPids?: Iterable<number>
  /** Diagnostic/raw modes. Normal UI should keep these false. */
  includeInvisible?: boolean
  includeCloaked?: boolean
  includeToolWindows?: boolean
  includeOwnedWindows?: boolean
  includeUntitled?: boolean
}

interface DaemonResponse {
  id?: number | null
  event?: string
  ok: boolean
  error?: string
  windows?: RawNativeTopLevelWindow[]
  result?: NativeWindowRestoreResult
}

interface PendingRequest {
  resolve: (response: DaemonResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

// These HWNDs are desktop-shell implementation details, not programs the user
// can meaningfully put on air.  Office, Explorer, classic console and Windows
// Terminal classes are deliberately not on this list.
const SYSTEM_WINDOW_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'DV2ControlHost',
  'MsgrIMEWindowClass',
  'SysShadow',
  'TaskListThumbnailWnd',
  'XamlExplorerHostIslandWindow'
])

function normalizeHwnd(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  try {
    return BigInt(text).toString(10)
  } catch {
    return null
  }
}

/** Build the stable media source id used by Electron on Windows. */
export function captureSourceIdForHwnd(hwnd: string): string {
  const normalized = normalizeHwnd(hwnd)
  if (!normalized) throw new Error(`Invalid HWND '${hwnd}'`)
  return `window:${normalized}:0`
}

/** Extract and normalize the HWND portion of an Electron desktop source id. */
export function hwndFromCaptureSourceId(sourceId: string): string | null {
  const match = /^window:([^:]+):/.exec(sourceId)
  return match ? normalizeHwnd(match[1]) : null
}

export function isSameNativeWindow(sourceId: string, hwnd: string): boolean {
  const sourceHwnd = hwndFromCaptureSourceId(sourceId)
  const nativeHwnd = normalizeHwnd(hwnd)
  return sourceHwnd !== null && nativeHwnd !== null && sourceHwnd === nativeHwnd
}

class NativeWindowDaemon {
  private process: ChildProcessWithoutNullStreams | null = null
  private lines: Interface | null = null
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()

  get supported(): boolean {
    return process.platform === 'win32'
  }

  warmup(): void {
    if (!this.supported) return
    void this.ensureReady().catch((error) => {
      diagnosticLog('window-enumerator', `warmup failed ${formatDiagnosticError(error)}`)
    })
  }

  async listRawWindows(): Promise<RawNativeTopLevelWindow[]> {
    if (!this.supported) return []
    const response = await this.send('list', {}, 5000)
    return Array.isArray(response.windows) ? response.windows : []
  }

  async listWindows(options: NativeWindowListOptions = {}): Promise<NativeTopLevelWindow[]> {
    const excludedPids = new Set(options.excludedPids ?? [])
    const raw = await this.listRawWindows()
    return raw
      .filter((window) => !excludedPids.has(window.pid))
      .filter((window) => options.includeUntitled || window.title.trim().length > 0)
      // IsWindowVisible stays true for minimized applications, so this retains
      // precisely the windows Chromium's source enumeration tends to omit.
      .filter((window) => options.includeInvisible || window.visible)
      .filter((window) => options.includeCloaked || !window.cloaked)
      .filter((window) => options.includeToolWindows || !window.toolWindow || window.appWindow)
      // Owned top-level HWNDs are normally dialogs, menus and helper surfaces.
      // WS_EX_APPWINDOW is the explicit signal that an owned HWND should still
      // be presented as a standalone application window.
      .filter((window) => options.includeOwnedWindows || !window.ownerHwnd || window.appWindow)
      .filter((window) => !SYSTEM_WINDOW_CLASSES.has(window.className))
      .map((window) => ({
        ...window,
        hwnd: normalizeHwnd(window.hwnd) ?? window.hwnd,
        captureSourceId: captureSourceIdForHwnd(window.hwnd)
      }))
  }

  async restoreWindow(hwnd: string, activate = false): Promise<NativeWindowRestoreResult> {
    if (!this.supported) {
      return {
        hwnd,
        valid: false,
        requested: false,
        wasMinimized: false,
        minimized: false,
        visible: false,
        activated: false,
        foreground: false
      }
    }
    const normalized = normalizeHwnd(hwnd)
    if (!normalized) throw new Error(`Invalid HWND '${hwnd}'`)
    const response = await this.send('restore', { hwnd: normalized, activate }, 3000)
    if (!response.result) throw new Error('Window enumerator returned no restore result')
    return response.result
  }

  async shutdown(): Promise<void> {
    const child = this.process
    if (!child) return
    try {
      await this.send('exit', {}, 1000)
    } catch {
      // Best effort: application shutdown must not wait on a helper process.
    }
    if (this.process === child && child.exitCode === null) child.kill()
    this.cleanup(new Error('window enumerator stopped'))
  }

  private ensureReady(): Promise<void> {
    if (!this.supported) return Promise.resolve()
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      const script = scriptPath('window-enumerator-daemon.ps1')
      diagnosticLog('window-enumerator', `spawn script=${script}`)
      const child = spawn(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-NoLogo', '-NoProfile', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      this.process = child
      // Windows PowerShell 5 consumes/transforms the first redirected stdin
      // record while entering -File mode on some hosts (it arrives as ".").
      // Sacrifice one harmless ping before exposing readiness so the first real
      // list request from the picker is never lost.
      child.stdin.write(`${JSON.stringify({ id: -1, cmd: 'ping' })}\n`)
      this.lines = createInterface({ input: child.stdout })
      this.lines.on('line', (line) => this.handleLine(line))

      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8000)
      })
      child.on('error', (error) => this.cleanup(error))
      child.on('exit', (code, signal) => {
        const detail = stderr.trim() ? ` stderr=${stderr.trim()}` : ''
        this.cleanup(new Error(`window enumerator exited code=${code ?? '-'} signal=${signal ?? '-'}${detail}`))
      })

      this.readyTimer = setTimeout(() => {
        const error = new Error('window enumerator ready timeout')
        try { child.kill() } catch { /* already gone */ }
        this.cleanup(error)
      }, 10000)
    })
    return this.readyPromise
  }

  private handleLine(line: string): void {
    let message: DaemonResponse
    try {
      message = JSON.parse(line) as DaemonResponse
    } catch {
      diagnosticLog('window-enumerator', `ignored non-JSON stdout: ${line.slice(0, 500)}`)
      return
    }

    if (message.event === 'ready') {
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = null
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
      diagnosticLog('window-enumerator', 'ready')
      return
    }

    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message)
    else pending.reject(new Error(message.error || 'Window enumerator request failed'))
  }

  private async send(
    command: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<DaemonResponse> {
    await this.ensureReady()
    const child = this.process
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error('Window enumerator is not running')
    }

    const id = this.nextId++
    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`window enumerator '${command}' timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, cmd: command, ...args })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private cleanup(error: Error): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.readyReject?.(error)
    this.readyResolve = null
    this.readyReject = null
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    this.lines?.close()
    this.lines = null
    this.process = null
    this.readyPromise = null
    diagnosticLog('window-enumerator', formatDiagnosticError(error))
  }
}

export const nativeWindowDaemon = new NativeWindowDaemon()
