import { ChildProcess, spawn } from 'child_process'
import { createInterface, Interface } from 'readline'
import { scriptPath } from './paths'
import { diagnosticLog, formatDiagnosticError } from './diagnostic-log'

type PendingRequest = {
  cmd: string
  args: Record<string, unknown>
  resolve: (value: DaemonResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout | null
  onEvent?: (event: DaemonResponse) => void
}

type CleanupRecoveryCommand = 'commit-open' | 'close'
type TimedOutStatefulRequest = { cmd: string; args: Record<string, unknown> }

// OPEN was never written: there is no new slideshow to abort or conceal.
export class PowerPointPreOpenRecoveryError extends Error {}

export interface DaemonResponse {
  id: number
  ok: boolean
  slide?: number
  slideCount?: number
  slideWidth?: number
  slideHeight?: number
  bulkExport?: boolean
  exportPending?: boolean
  nextSlide?: number
  boundary?: boolean
  notes?: string
  error?: string
  event?: string
  path?: string
  targetPath?: string
  transactionPending?: boolean
  cleanupPending?: boolean
  hwnd?: number
  pid?: number
  managed?: boolean
  reusedPrevious?: boolean
  previousHwnd?: number
  previousPid?: number
  previousPath?: string
  previousSlide?: number
  sharesPreviousPresentation?: boolean
  presentationRelationshipKnown?: boolean
  sessionUncertain?: boolean
}

export type PowerPointDaemonSend = (
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs?: number,
  onEvent?: (event: DaemonResponse) => void
) => Promise<DaemonResponse>

class PowerPointDaemon {
  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private ready: Promise<void> | null = null
  private operationTail: Promise<void> = Promise.resolve()
  private shuttingDown = false
  private acceptingRawSends = true
  private processGeneration = 0
  private cleanupBarrier: Promise<void> | null = null
  private cleanupBarrierId: number | null = null
  private cleanupBarrierCommand: CleanupRecoveryCommand | null = null
  private resolveCleanupBarrier: (() => void) | null = null
  private rejectCleanupBarrier: ((error: Error) => void) | null = null
  private sessionUncertain = false
  private livePowerPointKnown = false
  private cleanupRecoveryRequired: CleanupRecoveryCommand | null = null
  private cleanupRecoveryError: string | null = null
  private closeCleanupRetryAttempts = 0
  private closeCleanupRetryTimer: NodeJS.Timeout | null = null
  private commitCleanupRetryAttempts = 0
  private commitCleanupRetryTimer: NodeJS.Timeout | null = null
  private managedResourcesKnown = false
  private timedOutStatefulRequests = new Map<number, TimedOutStatefulRequest>()

  private startCleanupBarrier(id: number, command: CleanupRecoveryCommand): void {
    if (this.cleanupBarrierId === id && this.cleanupBarrier) return
    let resolveBarrier!: () => void
    let rejectBarrier!: (error: Error) => void
    this.cleanupBarrier = new Promise<void>((resolve, reject) => {
      resolveBarrier = resolve
      rejectBarrier = reject
    })
    void this.cleanupBarrier.catch(() => undefined)
    this.cleanupBarrierId = id
    this.cleanupBarrierCommand = command
    this.resolveCleanupBarrier = resolveBarrier
    this.rejectCleanupBarrier = rejectBarrier
  }

  private clearCloseCleanupRetryTimer(): void {
    if (!this.closeCleanupRetryTimer) return
    clearTimeout(this.closeCleanupRetryTimer)
    this.closeCleanupRetryTimer = null
  }

  private clearCommitCleanupRetryTimer(): void {
    if (!this.commitCleanupRetryTimer) return
    clearTimeout(this.commitCleanupRetryTimer)
    this.commitCleanupRetryTimer = null
  }

  private clearCleanupRecovery(command: CleanupRecoveryCommand): void {
    // A successful CLOSE retires the accepted target as well as any retained
    // commit transaction, so it resolves either kind of recovery requirement.
    if (command === 'close' || this.cleanupRecoveryRequired === command) {
      this.cleanupRecoveryRequired = null
      this.cleanupRecoveryError = null
    }
    if (command === 'commit-open' || command === 'close') {
      this.clearCommitCleanupRetryTimer()
      this.commitCleanupRetryAttempts = 0
    }
    if (command === 'close') {
      this.clearCloseCleanupRetryTimer()
      this.closeCleanupRetryAttempts = 0
    }
  }

  private scheduleCloseCleanupRetry(): void {
    const maxAttempts = 3
    if (
      this.shuttingDown ||
      this.sessionUncertain ||
      this.cleanupRecoveryRequired !== 'close' ||
      this.cleanupBarrier ||
      this.closeCleanupRetryTimer ||
      this.closeCleanupRetryAttempts >= maxAttempts
    ) {
      return
    }

    const attempt = this.closeCleanupRetryAttempts + 1
    const delayMs = [250, 750, 1500][attempt - 1] ?? 1500
    this.closeCleanupRetryTimer = setTimeout(() => {
      this.closeCleanupRetryTimer = null
      if (
        this.shuttingDown ||
        this.sessionUncertain ||
        this.cleanupRecoveryRequired !== 'close' ||
        this.cleanupBarrier
      ) {
        return
      }
      this.closeCleanupRetryAttempts = attempt
      diagnosticLog('ppt-daemon', `automatic close cleanup retry BEGIN attempt=${attempt}/${maxAttempts}`)
      void this.runExclusive(async (send) => {
        // A manual CLOSE may have completed while this retry was waiting for
        // the daemon operation lock. Do not enqueue a redundant mutation.
        if (
          this.shuttingDown ||
          this.sessionUncertain ||
          this.cleanupRecoveryRequired !== 'close' ||
          this.cleanupBarrier
        ) {
          return
        }
        const result = await send('close', {}, 20_000)
        if (!result.ok && this.cleanupRecoveryRequired === 'close' && !this.cleanupBarrier) {
          this.cleanupRecoveryError = result.error || this.cleanupRecoveryError
          this.scheduleCloseCleanupRetry()
        }
      }).catch((error) => {
        diagnosticLog(
          'ppt-daemon',
          `automatic close cleanup retry failed attempt=${attempt}/${maxAttempts}: ${formatDiagnosticError(error)}`
        )
        if (this.cleanupRecoveryRequired === 'close' && !this.cleanupBarrier) {
          this.cleanupRecoveryError = formatDiagnosticError(error)
          this.scheduleCloseCleanupRetry()
        }
      })
    }, delayMs)
  }

  private scheduleCommitCleanupRetry(): void {
    const maxAttempts = 3
    if (
      this.shuttingDown ||
      this.sessionUncertain ||
      this.cleanupRecoveryRequired !== 'commit-open' ||
      this.cleanupBarrier ||
      this.commitCleanupRetryTimer ||
      this.commitCleanupRetryAttempts >= maxAttempts
    ) return

    const attempt = this.commitCleanupRetryAttempts + 1
    const delayMs = [500, 1500, 3000][attempt - 1] ?? 3000
    this.commitCleanupRetryTimer = setTimeout(() => {
      this.commitCleanupRetryTimer = null
      if (
        this.shuttingDown ||
        this.sessionUncertain ||
        this.cleanupRecoveryRequired !== 'commit-open' ||
        this.cleanupBarrier
      ) return

      this.commitCleanupRetryAttempts = attempt
      diagnosticLog('ppt-daemon', `automatic commit cleanup retry BEGIN attempt=${attempt}/${maxAttempts}`)
      void this.runExclusive(async (send) => {
        if (
          this.shuttingDown ||
          this.sessionUncertain ||
          this.cleanupRecoveryRequired !== 'commit-open' ||
          this.cleanupBarrier
        ) return

        // The PowerShell command acknowledges after exact HWND verification;
        // its COM retirement phase remains protected by the cleanup barrier.
        const result = await send('commit-open', {}, 20_000)
        if (!result.ok && this.cleanupRecoveryRequired === 'commit-open' && !this.cleanupBarrier) {
          this.cleanupRecoveryError = result.error || this.cleanupRecoveryError
          this.scheduleCommitCleanupRetry()
        }
      }).catch((error) => {
        diagnosticLog(
          'ppt-daemon',
          `automatic commit cleanup retry failed attempt=${attempt}/${maxAttempts}: ${formatDiagnosticError(error)}`
        )
        if (this.cleanupRecoveryRequired === 'commit-open' && !this.cleanupBarrier) {
          this.cleanupRecoveryError = formatDiagnosticError(error)
          this.scheduleCommitCleanupRetry()
        }
      })
    }, delayMs)
  }

  private assertRecoveryCommandAllowed(cmd: string): void {
    const recovery = this.cleanupRecoveryRequired
    if (!recovery) return

    const closeRecoveryCommands = new Set(['close', 'open-status', 'current'])
    const commitRecoveryCommands = new Set([
      'commit-open',
      'close',
      'open-status',
      'current',
      'next',
      'prev',
      'goto',
      'relocate',
      'snapshot'
    ])
    const allowed = recovery === 'close' ? closeRecoveryCommands : commitRecoveryCommands
    if (allowed.has(cmd)) return

    const detail = this.cleanupRecoveryError ? ` Last cleanup error: ${this.cleanupRecoveryError}` : ''
    throw new Error(
      `PowerPoint ${recovery} cleanup is incomplete; '${cmd}' is blocked until CLOSE/recovery succeeds.${detail}`
    )
  }

  private isOwnershipStatefulCommand(cmd: string): boolean {
    return cmd === 'open' || cmd === 'abort-open' || cmd === 'prepare' ||
      cmd === 'sync-prepared' || cmd === 'export' || cmd === 'notes'
  }

  private assertTimedOutStatefulCommandAllowed(cmd: string): void {
    for (const request of this.timedOutStatefulRequests.values()) {
      const allowed = request.cmd === 'open'
        ? new Set(['abort-open', 'open-status', 'close'])
        : request.cmd === 'abort-open'
          ? new Set(['abort-open', 'close'])
          : new Set(['sync-prepared', 'close'])
      if (allowed.has(cmd)) continue
      throw new Error(
        `PowerPoint command '${request.cmd}' timed out and may still be executing; ` +
        `'${cmd}' is blocked until its terminal response or ownership cleanup`
      )
    }
  }

  private markResourcesBeforeSend(cmd: string, args: Record<string, unknown>): void {
    if (cmd === 'prepare' || cmd === 'open' || cmd === 'export' || cmd === 'notes') {
      this.managedResourcesKnown = true
    } else if (cmd === 'sync-prepared') {
      const paths = Array.isArray(args.paths) ? args.paths : []
      if (paths.length > 0) this.managedResourcesKnown = true
    }
  }

  private applyTerminalResponseState(
    cmd: string,
    args: Record<string, unknown>,
    msg: DaemonResponse
  ): void {
    if (msg.sessionUncertain) this.sessionUncertain = true
    if (cmd === 'open' && msg.ok) this.livePowerPointKnown = true
    if (cmd === 'close' && msg.ok) this.livePowerPointKnown = false
    if (cmd === 'sync-prepared' && msg.ok) {
      const paths = Array.isArray(args.paths) ? args.paths : []
      if (paths.length === 0 && !this.livePowerPointKnown) {
        this.managedResourcesKnown = false
      }
    }
  }

  private settleCleanupBarrier(ok: boolean, error?: string): void {
    const command = this.cleanupBarrierCommand
    const resolve = this.resolveCleanupBarrier
    this.cleanupBarrier = null
    this.cleanupBarrierId = null
    this.cleanupBarrierCommand = null
    this.resolveCleanupBarrier = null
    this.rejectCleanupBarrier = null
    if (ok) {
      if (command) this.clearCleanupRecovery(command)
      if (command === 'close') {
        this.livePowerPointKnown = false
        this.managedResourcesKnown = false
      }
      resolve?.()
    } else {
      // The daemon is alive and retained the exact transaction/COM identities.
      // Release the physical-busy barrier, then constrain subsequent commands
      // to the recovery surface for the command that failed.
      if (command) {
        if (command === 'close' && this.cleanupRecoveryRequired !== 'close') {
          this.closeCleanupRetryAttempts = 0
        }
        if (command === 'commit-open' && this.cleanupRecoveryRequired !== 'commit-open') {
          this.commitCleanupRetryAttempts = 0
        }
        this.cleanupRecoveryRequired = command
        this.cleanupRecoveryError = error || 'PowerPoint post-ack cleanup remains pending'
      } else {
        this.sessionUncertain = true
      }
      resolve?.()
      if (command === 'close') this.scheduleCloseCleanupRetry()
      if (command === 'commit-open') this.scheduleCommitCleanupRetry()
    }
  }

  private spawn(): Promise<void> {
    if (this.ready) return this.ready

    this.ready = new Promise<void>((resolve, reject) => {
      const script = scriptPath('powerpoint-daemon.ps1')
      const generation = ++this.processGeneration
      diagnosticLog('ppt-daemon', `spawn script=${script}`)
      const proc = spawn(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-NoLogo', '-NoProfile', '-File', script],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      )
      this.proc = proc

      const readyTimer = setTimeout(() => {
        if (generation !== this.processGeneration) return
        const error = new Error('daemon ready timeout')
        diagnosticLog('ppt-daemon', error.message)
        reject(error)
        try { proc.kill() } catch { /* ignore */ }
        this.cleanup(generation)
      }, 10000)

      this.rl = createInterface({ input: proc.stdout! })
      this.rl.on('line', (line) => this.handleLine(line, readyTimer, resolve))

      if (proc.stderr) {
        proc.stderr.setEncoding('utf8')
        let buf = ''
        proc.stderr.on('data', (chunk: string) => {
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

      proc.on('exit', (code, signal) => {
        clearTimeout(readyTimer)
        reject(new Error(`daemon exited before ready code=${code ?? '-'} signal=${signal ?? '-'}`))
        diagnosticLog('ppt-daemon', `exit code=${code ?? '-'} signal=${signal ?? '-'}`)
        this.cleanup(generation)
      })
      proc.on('error', (err) => {
        diagnosticLog('ppt-daemon', `process error: ${formatDiagnosticError(err)}`)
        clearTimeout(readyTimer)
        reject(err)
        this.cleanup(generation)
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
    if (msg.sessionUncertain) {
      this.sessionUncertain = true
      diagnosticLog('ppt-daemon', `session marked uncertain by daemon response id=${msg.id}`)
    }
    if (msg.event === 'command-complete' && msg.id === this.cleanupBarrierId) {
      this.settleCleanupBarrier(msg.ok, msg.error)
      diagnosticLog('ppt-daemon', `post-ack cleanup complete id=${msg.id} ok=${msg.ok}`)
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
      if (p.timer) clearTimeout(p.timer)
      this.pending.delete(msg.id)
      this.applyTerminalResponseState(p.cmd, p.args, msg)
      if (msg.cleanupPending && (p.cmd === 'commit-open' || p.cmd === 'close')) {
        this.startCleanupBarrier(msg.id, p.cmd)
      }
      p.resolve(msg)
      return
    }
    const timedOut = this.timedOutStatefulRequests.get(msg.id)
    if (timedOut && !msg.event) {
      this.timedOutStatefulRequests.delete(msg.id)
      this.applyTerminalResponseState(timedOut.cmd, timedOut.args, msg)
      diagnosticLog(
        'ppt-daemon',
        `late terminal response cmd=${timedOut.cmd} id=${msg.id} ok=${msg.ok}`
      )
      return
    }
    // A timed-out mutating request remains in the PowerShell stdin stream.
    // Its late terminal response must still create/settle the pessimistic
    // barrier so a following command is never written behind unknown work.
    if (msg.id === this.cleanupBarrierId && !msg.event) {
      if (!msg.cleanupPending) this.settleCleanupBarrier(msg.ok, msg.error)
      return
    }
  }

  private cleanup(generation = this.processGeneration): void {
    if (generation !== this.processGeneration) return
    const exitedDuringCleanup = this.cleanupBarrier !== null
    const exitedWithPendingCommand = this.pending.size > 0
    const exitedWithRecoveryRequired = this.cleanupRecoveryRequired !== null
    const exitedWithTimedOutStatefulCommand = this.timedOutStatefulRequests.size > 0
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error('daemon exited'))
    }
    this.pending.clear()
    this.timedOutStatefulRequests.clear()
    const rejectBarrier = this.rejectCleanupBarrier
    this.cleanupBarrier = null
    this.cleanupBarrierId = null
    this.cleanupBarrierCommand = null
    this.resolveCleanupBarrier = null
    this.rejectCleanupBarrier = null
    this.clearCloseCleanupRetryTimer()
    this.clearCommitCleanupRetryTimer()
    rejectBarrier?.(new Error('PowerPoint daemon exited during post-ack cleanup'))
    if (!this.shuttingDown && (
      exitedDuringCleanup ||
      exitedWithPendingCommand ||
      exitedWithRecoveryRequired ||
      exitedWithTimedOutStatefulCommand ||
      this.livePowerPointKnown ||
      this.managedResourcesKnown
    )) {
      this.sessionUncertain = true
      diagnosticLog('ppt-daemon', 'session marked uncertain after daemon exit with active PowerPoint work')
    }
    if (this.rl) this.rl.close()
    this.rl = null
    this.proc = null
    this.ready = null
  }

  private async ensureReady(): Promise<void> {
    if (this.sessionUncertain) {
      throw new Error('PowerPoint state is uncertain after a failed cleanup. Restart PDM before using PowerPoint again.')
    }
    if (!this.acceptingRawSends) {
      throw new Error('PowerPoint daemon is shutting down')
    }
    if (
      this.proc &&
      !this.proc.killed &&
      this.proc.exitCode === null &&
      this.proc.signalCode === null &&
      this.ready
    ) {
      return this.ready
    }
    this.ready = null
    return this.spawn()
  }

  warmup(): void {
    // PowerShell + Add-Type initialization takes several seconds on some
    // machines. Start it with the app so the first TAKE does not pay that cost.
    if (this.shuttingDown) return
    void this.ensureReady()
      .then(() => diagnosticLog('ppt-daemon', 'warmup ready'))
      .catch((err) => diagnosticLog('ppt-daemon', `warmup failed: ${formatDiagnosticError(err)}`))
  }

  private async waitForCleanup(cmd: string): Promise<void> {
    const barrier = this.cleanupBarrier
    if (!barrier) return
    let timer: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        barrier,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`PowerPoint cleanup is still busy before '${cmd}'`)), 60_000)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async recoverCloseBeforeOpen(): Promise<void> {
    // Already inside the operation lock: a timer queued behind this OPEN
    // cannot recover CLOSE for us. Retry the retained, ownership-aware CLOSE
    // here, and wait for its terminal cleanup (not merely the early ACK).
    for (let attempt = 1; this.cleanupRecoveryRequired === 'close' && attempt <= 3; attempt++) {
      diagnosticLog('ppt-daemon', `close recovery before open BEGIN attempt=${attempt}`)
      const result = await this.sendRaw('close', {}, 0)
      await this.waitForCleanup('open')
      if (result.ok && !this.cleanupRecoveryRequired) return
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250))
    }
    if (this.cleanupRecoveryRequired === 'close' && !this.sessionUncertain) {
      throw new PowerPointPreOpenRecoveryError(
        `PowerPoint is still finishing the previous presentation cleanup. Try again. ${this.cleanupRecoveryError ?? ''}`
      )
    }
    this.assertRecoveryCommandAllowed('open')
  }

  private async sendRaw(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = 20000,
    onEvent?: (event: DaemonResponse) => void
  ): Promise<DaemonResponse> {
    if (this.sessionUncertain) {
      throw new Error(`PowerPoint state is uncertain; '${cmd}' is blocked until PDM restarts`)
    }
    this.assertTimedOutStatefulCommandAllowed(cmd)
    if (cmd === 'close') {
      this.clearCloseCleanupRetryTimer()
      this.clearCommitCleanupRetryTimer()
    }
    if (cmd === 'commit-open') this.clearCommitCleanupRetryTimer()
    if (!this.acceptingRawSends) {
      throw new Error(`PowerPoint daemon rejected '${cmd}' during shutdown`)
    }
    await this.waitForCleanup(cmd)
    if (cmd === 'open') await this.recoverCloseBeforeOpen()
    if (!this.acceptingRawSends) {
      throw new Error(`PowerPoint daemon rejected '${cmd}' during shutdown`)
    }
    // The barrier may have completed with a tracked cleanup failure while this
    // caller was waiting. Re-evaluate the command-aware recovery gate now.
    this.assertRecoveryCommandAllowed(cmd)
    this.assertTimedOutStatefulCommandAllowed(cmd)
    await this.ensureReady()
    if (!this.acceptingRawSends) {
      throw new Error(`PowerPoint daemon rejected '${cmd}' during shutdown`)
    }
    this.assertRecoveryCommandAllowed(cmd)
    this.assertTimedOutStatefulCommandAllowed(cmd)
    const id = this.nextId++
    const req = { id, cmd, ...args }
    this.markResourcesBeforeSend(cmd, args)
    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (cmd === 'commit-open' || cmd === 'close') {
              this.pending.delete(id)
              this.startCleanupBarrier(id, cmd)
              diagnosticLog('ppt-daemon', `pessimistic barrier armed after '${cmd}' timeout id=${id}`)
            } else if (this.isOwnershipStatefulCommand(cmd)) {
              this.pending.delete(id)
              this.timedOutStatefulRequests.set(id, { cmd, args })
              diagnosticLog('ppt-daemon', `stateful timeout retained cmd=${cmd} id=${id}`)
            } else {
              this.pending.delete(id)
            }
            reject(new Error(`daemon cmd '${cmd}' timed out`))
          }, timeoutMs)
        : null
      this.pending.set(id, { cmd, args, resolve, reject, timer, onEvent })
      try {
        this.proc!.stdin!.write(JSON.stringify(req) + '\n', (err) => {
          if (err) {
            if (timer) clearTimeout(timer)
            this.pending.delete(id)
            reject(err)
          }
        })
      } catch (e) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  /**
   * Serialize every PowerPoint daemon operation. The PowerShell host itself is
   * single-threaded, but writing several requests to its stdin concurrently
   * allowed prepare/export/notes to land between an `open` and its
   * `commit-open`. Holding this lock across a multi-command transaction keeps
   * the physical slideshow and renderer state atomic.
   */
  async runExclusive<T>(operation: (send: PowerPointDaemonSend) => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      throw new Error('PowerPoint daemon is shutting down')
    }
    const previous = this.operationTail
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.operationTail = previous.catch(() => undefined).then(() => gate)

    await previous.catch(() => undefined)
    try {
      const rawSend: PowerPointDaemonSend = (cmd, args, timeoutMs, onEvent) =>
        this.sendRaw(cmd, args, timeoutMs, onEvent)
      return await operation(rawSend)
    } finally {
      release()
    }
  }

  send(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = 20000,
    onEvent?: (event: DaemonResponse) => void
  ): Promise<DaemonResponse> {
    return this.runExclusive((send) => send(cmd, args, timeoutMs, onEvent))
  }

  fireAndForget(cmd: string, args: Record<string, unknown> = {}): void {
    // Тихое подавление ошибок тут раньше скрывало daemon crash: операторы
    // видели "команда не сработала" без единого лога (audit F-202). Логируем.
    this.send(cmd, args)
      .catch((err) => {
        console.error(`[DAEMON] fireAndForget failed cmd=${cmd}:`, err)
      })
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.clearCloseCleanupRetryTimer()
    this.clearCommitCleanupRetryTimer()

    // Let a transaction that already wrote `open` finish its matching
    // commit/abort. If Office is unresponsive, stop accepting raw follow-up
    // writes and queue `exit`; EOF/exit cleanup in the PowerShell host then
    // closes every PDM-owned document without spawning a second daemon.
    let drained = false
    await Promise.race([
      this.operationTail.catch(() => undefined).then(() => { drained = true }),
      new Promise<void>((resolve) => setTimeout(resolve, 6000))
    ])
    this.acceptingRawSends = false
    if (!drained) {
      diagnosticLog('ppt-daemon', 'shutdown operation drain timeout; queueing ownership-aware exit')
    }

    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin?.write(JSON.stringify({ id: 0, cmd: 'exit' }) + '\n')
      proc.stdin?.end()
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      // `exit` is queued behind the current PowerShell command. Full-slide
      // export is allowed up to 240 s, so a short cleanup timer would kill the
      // daemon before its export finally/Restore block and orphan POWERPNT.
      // Wait that bounded command budget plus cleanup margin. We deliberately
      // never force-kill a potentially borrowed user PowerPoint process.
      const killTimer = setTimeout(() => {
        diagnosticLog('ppt-daemon', 'shutdown cleanup timeout after 270s; terminating daemon host only')
        try { proc.kill() } catch { /* ignore */ }
        resolve()
      }, 270_000)
      proc.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
    })
    this.cleanup()
  }
}

export const pptDaemon = new PowerPointDaemon()
