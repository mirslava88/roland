interface LaunchRuntime {
  processes(): Promise<number[]>
  launch(): Promise<void>
  delay(ms: number): Promise<void>
  attempts?: number
}

// A successful `open -n` can precede process discovery. Retain that launch
// across timeouts: another TAKE must reconcile it instead of opening a third,
// fourth, ... Keynote. Serialize launches, but never give two callers one PID.
export class MacKeynoteLauncher {
  private pending: Set<number> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private runtime: LaunchRuntime) {}

  spawn(claimed: number[] = []): Promise<number> {
    const result = this.tail.then(() => this.launch(claimed))
    this.tail = result.catch(() => undefined)
    return result
  }

  private async launch(claimed: number[]): Promise<number> {
    const current = await this.runtime.processes()
    if (this.pending) {
      const observed = current.filter(pid => !this.pending!.has(pid))
      const available = observed.find(pid => !claimed.includes(pid))
      if (available !== undefined) { this.pending = null; return available }
      // Initialization may already have adopted the late process as its
      // first engine. That resolves the earlier launch; create only its peer.
      if (observed.some(pid => claimed.includes(pid))) this.pending = null
    }
    if (!this.pending) {
      this.pending = new Set(current)
      try { await this.runtime.launch() }
      catch (error) {
        const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; launchNotStarted?: boolean }
        // A definite nonzero `open` exit did not launch an application.
        // A timeout or unknown outcome must retain the pending launch.
        if (failure.launchNotStarted || (typeof failure.code === 'number' && !failure.killed && !failure.signal)) this.pending = null
        throw error
      }
    }
    for (let attempt = 0; attempt < (this.runtime.attempts ?? 150); attempt++) {
      const pid = (await this.runtime.processes()).find(value => !this.pending!.has(value) && !claimed.includes(value))
      if (pid !== undefined) { this.pending = null; return pid }
      await this.runtime.delay(100)
    }
    throw new Error('Не удалось обнаружить запущенный Keynote. Откройте Keynote вручную и завершите его начальную настройку. Повторная попытка PDM проверит уже запущенный процесс.')
  }
}
