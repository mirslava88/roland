import type { DaemonResponse, PowerPointDaemonSend } from './powerpoint-daemon'

// Each small batch releases the normal daemon lock. TAKE keeps its existing
// multi-command exclusive transaction; no second COM host or ownership model.
export async function exportPptxIncrementally(
  send: PowerPointDaemonSend,
  args: { path: string; outputDir: string; width: number; height: number },
  onEvent?: (event: DaemonResponse) => void,
  signal?: AbortSignal
): Promise<DaemonResponse> {
  const started = Date.now()
  let startSlide = 1
  while (true) {
    signal?.throwIfAborted()
    if (Date.now() - started > 240_000) throw new Error('PPTX background export timed out')
    const result = await send('export', {
      ...args, progress: true, incremental: true, startSlide, batchSize: 4
    }, 240_000, onEvent)
    signal?.throwIfAborted()
    if (!result.ok || result.bulkExport || !result.exportPending) return result
    if (!Number.isInteger(result.nextSlide) || result.nextSlide! <= startSlide ||
      !result.slideCount || result.nextSlide! > result.slideCount) {
      throw new Error('Invalid PowerPoint export continuation')
    }
    startSlide = result.nextSlide!
    // Give renderer IPC/navigation requests a turn before the next batch.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
