import { ChildProcess, spawn } from 'child_process'
import { createInterface, Interface } from 'readline'
import { scriptPath } from './paths'
import { diagnosticLog, formatDiagnosticError } from './diagnostic-log'

type PendingRequest = {
  resolve: (value: DaemonResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  onEvent?: (event: DaemonResponse) => void
}

export interface DaemonResponse {
  id: number
  ok: boolean
  slide?: number
  slideCount?: number
  slideWidth?: number
  slideHeight?: number
  boundary?: boolean
  notes?: string
  error?: string
  event?: string
  path?: string
}

class PowerPointDaemon {
  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private ready: Promise<void> | null = null

  private spawn(): Promise<void> {
    if (this.ready) return this.ready

    this.ready = new Promise<void>((resolve, reject) => {
      const script = scriptPath('powerpoint-daemon.ps1')
      diagnosticLog('ppt-daemon', `spawn script=${script}`)
      this.proc = spawn(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-NoLogo', '-NoProfile', '-File', script],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      )

      const readyTimer = setTimeout(() => reject(new Error('daemon ready timeout')), 10000)

      this.rl = createInterface({ input: this.proc.stdout! })
      this.rl.on('line', (line) => this.handleLine(line, readyTimer, resolve))

      if (this.proc.stderr) {
        this.proc.stderr.setEncoding('utf8')
        let buf = ''
        this.proc.stderr.on('data', (chunk: string) => {
          buf += chunk
          let idx: number
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).replace(/\r$/, '')
            buf = buf.slice(idx + 1)
            if (line.length > 0) {
              console.log(line)
              diagnosticLog('ppt-daemon', line)
            }
          }
        })
      }

      this.proc.on('exit', (code, signal) => {
        diagnosticLog('ppt-daemon', `exit code=${code ?? '-'} signal=${signal ?? '-'}`)
        this.cleanup()
      })
      this.proc.on('error', (err) => {
        diagnosticLog('ppt-daemon', `process error: ${formatDiagnosticError(err)}`)
        clearTimeout(readyTimer)
        reject(err)
        this.cleanup()
      })
    })

    return this.ready
  }

  private handleLine(
    line: string,
    readyTimer: NodeJS.Timeout,
    readyResolve: () => void
  ): void {
    let msg: DaemonResponse
    try {
      msg = JSON.parse(line) as DaemonResponse
    } catch {
      return
    }
    if (msg.event === 'ready') {
      clearTimeout(readyTimer)
      readyResolve()
      return
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      if (msg.event) {
        try {
          p.onEvent?.(msg)
        } catch (err) {
          diagnosticLog('ppt-daemon', `progress callback failed: ${formatDiagnosticError(err)}`)
        }
        return
      }
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      p.resolve(msg)
    }
  }

  private cleanup(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('daemon exited'))
    }
    this.pending.clear()
    if (this.rl) this.rl.close()
    this.rl = null
    this.proc = null
    this.ready = null
  }

  private async ensureReady(): Promise<void> {
    if (this.proc && !this.proc.killed && this.ready) {
      return this.ready
    }
    this.ready = null
    return this.spawn()
  }

  warmup(): void {
    // PowerShell + Add-Type initialization takes several seconds on some
    // machines. Start it with the app so the first TAKE does not pay that cost.
    void this.ensureReady()
      .then(() => diagnosticLog('ppt-daemon', 'warmup ready'))
      .catch((err) => diagnosticLog('ppt-daemon', `warmup failed: ${formatDiagnosticError(err)}`))
  }

  async send(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = 20000,
    onEvent?: (event: DaemonResponse) => void
  ): Promise<DaemonResponse> {
    await this.ensureReady()
    const id = this.nextId++
    const req = { id, cmd, ...args }
    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`daemon cmd '${cmd}' timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, onEvent })
      try {
        this.proc!.stdin!.write(JSON.stringify(req) + '\n', (err) => {
          if (err) {
            clearTimeout(timer)
            this.pending.delete(id)
            reject(err)
          }
        })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  fireAndForget(cmd: string, args: Record<string, unknown> = {}): void {
    // Тихое подавление ошибок тут раньше скрывало daemon crash: операторы
    // видели "команда не сработала" без единого лога (audit F-202). Логируем.
    this.ensureReady()
      .then(() => {
        const id = this.nextId++
        const req = { id, cmd, ...args }
        try {
          this.proc!.stdin!.write(JSON.stringify(req) + '\n')
        } catch (err) {
          console.error(`[DAEMON] fireAndForget stdin write failed cmd=${cmd}:`, err)
        }
      })
      .catch((err) => {
        console.error(`[DAEMON] fireAndForget ensureReady failed cmd=${cmd}:`, err)
      })
  }

  async shutdown(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin?.write(JSON.stringify({ id: 0, cmd: 'exit' }) + '\n')
      proc.stdin?.end()
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      // The PowerShell daemon restores a user-owned editor or calls Quit() on
      // a Roland-owned PowerPoint instance before exiting. Give COM enough
      // time to finish; the previous 500 ms timeout orphaned hidden POWERPNT.
      const killTimer = setTimeout(() => {
        diagnosticLog('ppt-daemon', 'shutdown cleanup timeout; terminating daemon host')
        try { proc.kill() } catch { /* ignore */ }
        resolve()
      }, 6000)
      proc.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
    })
    this.cleanup()
  }
}

export const pptDaemon = new PowerPointDaemon()
