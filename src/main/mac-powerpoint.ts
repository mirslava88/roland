import { app, desktopCapturer, screen, systemPreferences, webContents } from 'electron'
import { ChildProcess, execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'
import { promisify } from 'util'
import type { DaemonResponse } from './powerpoint-daemon'
import { inspectMacPptxAnimations, type MacPptxAnimationInfo } from './mac-pptx-animation'
import { planPresentationCapture, type PresentationCaptureProfile } from '../shared/presentation-output'
import { diagnosticLog } from './diagnostic-log'
import { matchesRendererPage } from './renderer-security'
import { isMacRenderDisplay, macRenderDisplay } from './mac-render-display'
import { MacKeynotePool, type KeynoteShow } from './mac-keynote-pool'

const execFileAsync = promisify(execFile)
const keynoteBackdrop = (): string => app.isPackaged
  ? join(process.resourcesPath, 'mac-keynote-backdrop')
  : join(__dirname, '../../build/mac-keynote-backdrop')
const renderer = (): string => app.isPackaged
  ? join(process.resourcesPath, 'mac-pdf-pages')
  : join(__dirname, '../../build/mac-pdf-pages')

async function keynoteCapturePlan(displayId: number, aspect: number, slot: number) {
  const displays = screen.getAllDisplays().filter((display) => !isMacRenderDisplay(display))
  const target = displays.find((display) => display.id === displayId)
  if (!target) throw new Error('Эфирный дисплей отключён')
  const primary = screen.getPrimaryDisplay()
  const hosts = [primary, ...displays.filter((d) => d.id !== primary.id)].map((display) => ({ ...display,
    workArea: { ...display.workArea, height: Math.min(display.workArea.height, display.bounds.height - 96) } }))
  const plan = planPresentationCapture(target, hosts, aspect)
  // Keep enough room for Keynote's own window constraints. On a 4K monitor,
  // its windowed player can otherwise lose the menu-bar height and upscale.
  // Reserve the whole output box so changing a deck's aspect ratio never
  // reconfigures the surface during an otherwise identical PPTX transition.
  const placement = await macRenderDisplay.player({
    width: Math.max(1280, Math.ceil(target.bounds.width * target.scaleFactor)),
    height: Math.max(720, Math.ceil(target.bounds.height * target.scaleFactor)) }, slot)
  if (placement) {
    const render = placement.display
    diagnosticLog('pptx-quality', `target=${displayId} required=${plan.profile.width}x${plan.profile.height} render=${render.id}`)
    return { profile: plan.profile,
      args: [String(render.bounds.x), String(render.bounds.y),
        String(Math.ceil(plan.profile.width / render.scaleFactor)),
        String(Math.ceil(plan.profile.height / render.scaleFactor))],
      parking: [String(placement.x), String(placement.y)] }
  }
  diagnosticLog('pptx-quality', `target=${displayId} required=${plan.profile.width}x${plan.profile.height} ` +
    `fps=${plan.profile.frameRate} host=${plan.host.id} scale=${plan.host.scaleFactor} ` +
    `window=${plan.windowWidth}x${plan.windowHeight}`)
  return { profile: plan.profile, args: [String(plan.host.bounds.x), String(plan.host.bounds.y),
    String(plan.windowWidth), String(plan.windowHeight)], parking: [String(plan.parkedX), String(plan.parkedY)] }
}

function publishCaptureProfile(show: KeynoteShow): void {
  if (!show.windowId || !show.captureProfile) return
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed() && matchesRendererPage(contents.getURL(), 'presentation.html')) {
      contents.send('keynote-capture-update', { path: show.path,
        captureSourceId: `window:${show.windowId}:0`, captureProfile: show.captureProfile })
    }
  }
}

let keynoteCaptureSourcesVerified = false
let keynoteCaptureProbe: Promise<string | null> | null = null

async function keynoteCaptureError(): Promise<string | null> {
  const access = systemPreferences.getMediaAccessStatus('screen')
  if (access === 'denied' || access === 'restricted') {
    keynoteCaptureSourcesVerified = false
    return 'macOS не разрешает PDM запись экрана; включите её для живых анимаций Keynote'
  }
  if (keynoteCaptureSourcesVerified) return null
  if (!keynoteCaptureProbe) {
    keynoteCaptureProbe = (async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'], thumbnailSize: { width: 1, height: 1 }
        })
        if (sources.length > 0) {
          keynoteCaptureSourcesVerified = true
          return null
        }
      } catch { /* screen capture is unavailable in this app session */ }
      return 'macOS не предоставила PDM источник записи экрана для Keynote'
    })()
  }
  const probe = keynoteCaptureProbe
  try { return await probe }
  finally { if (keynoteCaptureProbe === probe) keynoteCaptureProbe = null }
}

let exportTail: Promise<void> = Promise.resolve()
let queuedPowerPointExports = 0
let pool: MacKeynotePool | null = null
function playerPool(): MacKeynotePool {
  if (!pool) pool = new MacKeynotePool({
    plan: (displayId, aspect, slot) => {
      const target = displayId ?? screen.getAllDisplays().find(display =>
        display.id !== screen.getPrimaryDisplay().id && !isMacRenderDisplay(display))?.id ?? screen.getPrimaryDisplay().id
      return keynoteCapturePlan(target, aspect, slot)
    },
    status: (path, status, progress) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && matchesRendererPage(contents.getURL(), 'index.html')) contents.send('mac-keynote-status', { path, status, progress })
      }
    },
    warm: async (show) => {
      // ScreenCaptureKit caches its shareable windows. Refresh that list after
      // Keynote creates a new player, before any renderer opens its stream.
      const sources = await desktopCapturer.getSources({
        types: ['window'], thumbnailSize: { width: 0, height: 0 }
      })
      if (!sources.some(source => source.id === `window:${show.windowId}:0`)) {
        throw new Error('macOS не предоставила окно показа Keynote для захвата')
      }
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && matchesRendererPage(contents.getURL(), 'presentation.html')) {
          contents.send('keynote-source-prewarm', { sourceId: `window:${show.windowId}:0`, profile: show.captureProfile })
        }
      }
    },
    retire: (sourceId) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && matchesRendererPage(contents.getURL(), 'presentation.html')) contents.send('keynote-source-retire', { sourceId })
      }
    }
  })
  return pool
}
let backdropProcess: ChildProcess | null = null
let backdropDisplayId: number | null = null

function stopKeynoteBackdrop(): void {
  backdropProcess?.kill('SIGTERM')
  backdropProcess = null
  backdropDisplayId = null
}

async function startKeynoteBackdrop(displayId: number): Promise<void> {
  if (backdropProcess && backdropProcess.exitCode === null &&
      backdropProcess.signalCode === null && backdropDisplayId === displayId) return
  stopKeynoteBackdrop()
  const child = spawn(keynoteBackdrop(), [String(displayId)], { stdio: 'ignore' })
  let startError: Error | null = null
  child.on('error', (error) => { startError = error })
  child.on('exit', () => {
    if (backdropProcess === child) {
      backdropProcess = null
      backdropDisplayId = null
    }
  })
  backdropProcess = child
  backdropDisplayId = displayId
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (startError || child.exitCode !== null || child.signalCode !== null) {
    stopKeynoteBackdrop()
    throw startError || new Error('Keynote output backdrop did not start')
  }
}

function serializeExport<T>(operation: () => Promise<T>): Promise<T> {
  queuedPowerPointExports++
  const job = exportTail.then(operation, operation)
  exportTail = job.then(() => undefined, () => undefined)
  return job.finally(() => { queuedPowerPointExports-- })
}

async function exportPdf(path: string, use: (pdf: string) => Promise<void>): Promise<void> {
  // Use the live importer's owned copy, on the standby process queue. A
  // separate PowerPoint import/export must never gate a Keynote TAKE.
  await serializeExport(() => playerPool().exportPdf(path, use))
}

function renderPdf(
  action: 'metadata' | 'render', pdf: string, outputDir?: string,
  width?: number, height?: number,
  onEvent?: (event: DaemonResponse) => void,
  signal?: AbortSignal
): Promise<{ slideCount: number; slideWidth: number; slideHeight: number }> {
  return new Promise((resolve, reject) => {
    const args = [action, pdf]
    if (action === 'render') args.push(outputDir!, String(width), String(height))
    const child = spawn(renderer(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    let metadata: { slideCount: number; slideWidth: number; slideHeight: number } | null = null
    let lastSlide = 0
    let errors = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      lines.close()
      if (error) reject(error)
      else if (metadata && (action === 'metadata' || lastSlide === metadata.slideCount)) resolve(metadata)
      else reject(new Error('Incomplete PDF slide export'))
    }
    const abort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line) as { slide?: number; slideCount: number; slideWidth: number; slideHeight: number; path?: string }
        if (!metadata) {
          metadata = value
        } else if (value.slide && value.path) {
          lastSlide = value.slide
          onEvent?.({ id: 0, ok: true, event: 'slide-exported', slide: value.slide,
            slideCount: value.slideCount, slideWidth: value.slideWidth,
            slideHeight: value.slideHeight, path: value.path })
        }
      } catch { /* malformed renderer output is caught as incomplete export */ }
    })
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4096) })
    child.on('error', finish)
    child.on('close', (code) => finish(code === 0 && !signal?.aborted
      ? undefined : new Error(signal?.aborted ? 'PowerPoint export cancelled' : errors || `PDF renderer exited ${code}`)))
  })
}

export const macPowerPoint = {
  captureProfile(): PresentationCaptureProfile | null { return pool?.current?.captureProfile ?? null },
  retainPrepared(paths: string[]): void { playerPool().retain(paths) },
  prewarm(path: string, displayId?: number, preferred = false): Promise<{slideCount?: number}> {
    return playerPool().prewarm(path, displayId, preferred)
  },
  async prewarmAnimated(path: string): Promise<MacPptxAnimationInfo> {
    const info = await inspectMacPptxAnimations(path)
    if (info.hasAnimations) void keynoteCaptureError().catch(() => undefined)
    return info
  },
  async installed(): Promise<boolean> {
    for (const name of ['Keynote', 'Microsoft PowerPoint']) {
      if (existsSync(`/Applications/${name}.app`) || existsSync(join(homedir(), `Applications/${name}.app`))) return true
    }
    for (const name of ['Keynote', 'Microsoft PowerPoint']) {
      try { await execFileAsync('/usr/bin/open', ['-Ra', name], { timeout: 5000 }); return true }
      catch { /* try the other installed engine */ }
    }
    return false
  },

  async prepare(path: string): Promise<DaemonResponse> {
    try {
      let result: { slideCount: number; slideWidth: number; slideHeight: number } | null = null
      await exportPdf(path, async (pdf) => { result = await renderPdf('metadata', pdf) })
      return { id: 0, ok: true, ...result! }
    } catch (error) { return { id: 0, ok: false, error: String(error) } }
  },

  async export(path: string, outputDir: string, width: number, height: number,
    onEvent: (event: DaemonResponse) => void, signal?: AbortSignal): Promise<DaemonResponse> {
    try {
      let result: { slideCount: number; slideWidth: number; slideHeight: number } | null = null
      await exportPdf(path, async (pdf) => {
        signal?.throwIfAborted()
        result = await renderPdf('render', pdf, outputDir, width, height, onEvent, signal)
      })
      await writeFile(join(outputDir, 'complete.txt'), String(result!.slideCount))
      return { id: 0, ok: true, ...result! }
    } catch (error) { return { id: 0, ok: false, error: String(error) } }
  },

  async launch(path: string, startSlide: number,
    _bounds: { x: number; y: number; width: number; height: number }, displayId: number, internalOutput = false) {
    try {
      const captureError = await keynoteCaptureError()
      if (captureError) return { success: false, error: captureError, safeToUncover: true }
      const show = await playerPool().take(path, startSlide, displayId)
      if (internalOutput) stopKeynoteBackdrop()
      else await startKeynoteBackdrop(displayId)
      return { success: true, output: JSON.stringify({ Status: 'ok', Backend: 'keynote',
        SlideCount: show.slideCount, CurrentSlide: show.slide, CaptureSourceId: `window:${show.windowId}:0`, CaptureProfile: show.captureProfile }) }
    } catch (error) { return { success: false, error: String(error), safeToUncover: true } }
  },
  async command(command: string, arg?: number | { stopAtBoundary?: boolean }) {
    try {
      const result = await playerPool().command(command, arg)
      if (command === 'close') stopKeynoteBackdrop()
      else if (command === 'goto' && playerPool().current) publishCaptureProfile(playerPool().current!)
      return { success: true, output: JSON.stringify(result) }
    } catch (error) { return { success: false, error: String(error) } }
  },
  async relocate(_bounds: { x: number; y: number; width: number; height: number }, displayId: number) {
    try {
      const show = await playerPool().relocate(displayId)
      if (show) { publishCaptureProfile(show); await startKeynoteBackdrop(displayId) }
      return { success: true }
    } catch (error) { return { success: false, error: String(error) } }
  },
  async refreshCapture(sourceId: string) {
    try { await playerPool().refresh(sourceId); return { success: true } }
    catch (error) { return { success: false, error: String(error) } }
  },
  async notes(path: string, slide: number) {
    try { return { success: true, notes: await playerPool().notes(path, slide) } }
    catch (error) { return { success: false, error: String(error) } }
  },
  async shutdown(): Promise<void> {
    await pool?.shutdown()
    stopKeynoteBackdrop()
    await macRenderDisplay.shutdown()
  }
}
