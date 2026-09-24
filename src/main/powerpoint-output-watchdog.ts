export interface PowerPointOutputIdentity {
  pid: number
  filePath: string
  displayId: number
}

/** Observe only the exact process returned by a committed PDM OPEN. No COM
 * polling, process termination, or attachment to unrelated Office instances. */
export class PowerPointOutputWatchdog {
  private current: PowerPointOutputIdentity | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private failures = new Map<string, { at: number; count: number }>()

  constructor(
    private lost: (identity: PowerPointOutputIdentity, retryAllowed: boolean) => void,
    private alive: (pid: number) => boolean = (pid) => {
      try { process.kill(pid, 0); return true }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
    },
    private now: () => number = Date.now
  ) {}

  arm(identity: PowerPointOutputIdentity): void {
    this.clear()
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return
    this.current = { ...identity }
    this.timer = setInterval(() => this.check(), 500)
    this.timer.unref()
  }

  check(): void {
    const identity = this.current
    if (!identity || this.alive(identity.pid)) return
    this.clear() // One notification per committed process; no retry loop here.
    const key = identity.filePath.toLocaleLowerCase()
    const previous = this.failures.get(key)
    const at = this.now()
    const count = previous && at - previous.at < 120_000 ? previous.count + 1 : 1
    this.failures.set(key, { at, count })
    // Bound both retry rate and bookkeeping for long operator sessions.
    for (const [path, entry] of this.failures) if (at - entry.at >= 120_000) this.failures.delete(path)
    this.lost(identity, count <= 2)
  }

  clear(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.current = null
  }
}
