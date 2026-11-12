import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { constants } from 'fs'
import { existsSync } from 'fs'
import { copyFile, link, stat, unlink } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import type { RecordingEditOptions, RecordingEditSource, RecordingEditStatus, RecordingWaveformWindow } from '../shared/recording'
import { timelineDuration, type RecordingClip } from '../shared/recording-timeline'
import { editTimelineArguments, previewFrame, probeRecording, startEdit, timelineFrame, timelineThumbnails, timelineWaveform, timelineWaveformRange } from './recording-editor-engine'
import type { ChildProcess } from 'child_process'
import { isTrustedWindowMainFrame } from './renderer-security'

const idle = (): RecordingEditStatus => ({ phase: 'idle', progress: 0, outputs: [] })

export class RecordingEditorManager {
  private source: RecordingEditSource | null = null
  private status: RecordingEditStatus = idle()
  private child: ChildProcess | null = null
  private task: Promise<void> | null = null
  private cancelled = false
  private timelineAbort: AbortController | null = null
  private thumbnailCache: string[] | null = null
  private frameCache = new Map<string, string>()
  private waveformCache: string | null | undefined = undefined
  private waveformWindowsCache = new Map<string, string | null>()
  private thumbnailTask: Promise<string[]> | null = null
  private waveformTask: Promise<string | null> | null = null
  private waveformWindowsAbort: AbortController | null = null
  private selectionBusy = false
  private selectionEpoch = 0

  constructor(private ffmpegPath: string, private control: () => BrowserWindow | null,
    private lastRecording: () => string | undefined, private recordingActive: () => boolean) {
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (process.platform === 'darwin'
          ? !isTrustedWindowMainFrame(event, this.control(), 'index.html')
          : event.sender !== this.control()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Недоступно.')
        return fn(...args)
      })
    }
    handle('record-edit-open', (useLast: boolean) => this.open(useLast === true))
    handle('record-edit-frame', (time: number) => this.frame(time))
    handle('record-edit-thumbnails', () => this.thumbnails())
    handle('record-edit-timeline-frames', (times: number[]) => this.timelineFrames(times))
    handle('record-edit-waveform', () => this.waveform())
    handle('record-edit-waveform-windows', (windows: RecordingWaveformWindow[]) => this.waveformWindows(windows))
    handle('record-edit-timeline-cancel', () => this.cancelTimeline())
    handle('record-edit-export', (options: RecordingEditOptions) => this.export(options))
    handle('record-edit-status', () => ({ ...this.status }))
    handle('record-edit-cancel', () => this.cancel())
  }

  isBusy(): boolean { return this.task !== null || process.platform === 'darwin' && this.selectionBusy }

  private async select<T>(operation: () => Promise<T>): Promise<T> {
    if (process.platform !== 'darwin') return operation()
    if (this.selectionBusy) throw new Error('Дождитесь завершения выбора файла.')
    this.selectionBusy = true
    try { return await operation() } finally { this.selectionBusy = false }
  }

  private cancelTimeline(): void {
    this.timelineAbort?.abort()
    this.waveformWindowsAbort?.abort()
    this.waveformWindowsAbort = null
    this.timelineAbort = new AbortController()
    this.thumbnailTask = null
    this.waveformTask = null
  }

  private async open(useLast: boolean): Promise<RecordingEditSource | null> {
    return this.select(() => this.openSelected(useLast))
  }

  private async openSelected(useLast: boolean, epoch = this.selectionEpoch): Promise<RecordingEditSource | null> {
    if (this.recordingActive() || this.task) throw new Error('Сначала завершите текущую запись или монтаж.')
    if (!existsSync(this.ffmpegPath)) throw new Error('Компонент монтажа FFmpeg не найден.')
    let path = useLast ? this.lastRecording() : undefined
    if (!path) {
      const options: Electron.OpenDialogOptions = { title: 'Выбрать запись для монтажа',
        properties: ['openFile'], filters: [{ name: 'Записи PDM', extensions: ['mp4', 'mkv'] }] }
      const parent = this.control()
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      path = result.filePaths[0]
    }
    if (!['.mp4', '.mkv'].includes(extname(path).toLowerCase()) || !(await stat(path)).isFile()) {
      throw new Error('Выберите готовую запись MP4 или MKV.')
    }
    if (process.platform === 'darwin' && epoch !== this.selectionEpoch) throw new Error('Открытие записи отменено.')
    const source = await probeRecording(this.ffmpegPath, path)
    if (process.platform === 'darwin' && epoch !== this.selectionEpoch) throw new Error('Открытие записи отменено.')
    if (this.source?.path !== source.path) {
      this.cancelTimeline()
      this.thumbnailCache = null
      this.frameCache.clear()
      this.waveformCache = undefined
      this.waveformWindowsCache.clear()
      this.thumbnailTask = null
      this.waveformTask = null
    }
    this.source = source
    this.status = idle()
    return source
  }

  private frame(time: number): Promise<string> {
    if (!this.source || !Number.isFinite(time) || time < 0 || time > this.source.duration) throw new Error('Выберите кадр внутри записи.')
    return previewFrame(this.ffmpegPath, this.source, time)
  }

  private thumbnails(): Promise<string[]> {
    if (!this.source) throw new Error('Сначала выберите запись.')
    if (this.thumbnailCache) return Promise.resolve(this.thumbnailCache)
    if (this.thumbnailTask) return this.thumbnailTask
    const source = this.source
    const task = timelineThumbnails(this.ffmpegPath, source, this.timelineAbort?.signal)
      .then(frames => { if (this.source === source) this.thumbnailCache = frames; return frames })
    this.thumbnailTask = task
    void task.then(() => { if (this.thumbnailTask === task) this.thumbnailTask = null },
      () => { if (this.thumbnailTask === task) this.thumbnailTask = null })
    return task
  }

  private waveform(): Promise<string | null> {
    if (!this.source) throw new Error('Сначала выберите запись.')
    if (this.waveformCache !== undefined) return Promise.resolve(this.waveformCache)
    if (this.waveformTask) return this.waveformTask
    const source = this.source
    const task = timelineWaveform(this.ffmpegPath, source, this.timelineAbort?.signal)
      .then(image => { if (this.source === source) this.waveformCache = image; return image })
    this.waveformTask = task
    void task.then(() => { if (this.waveformTask === task) this.waveformTask = null },
      () => { if (this.waveformTask === task) this.waveformTask = null })
    return task
  }

  private async timelineFrames(times: number[]): Promise<string[]> {
    const source = this.source
    if (!source || !Array.isArray(times) || times.length > 64 || times.some(time =>
      !Number.isFinite(time) || time < 0 || time > source.duration)) throw new Error('Неверные точки ленты кадров.')
    const pending = [...new Set(times.map(time => time.toFixed(3)))].filter(key => !this.frameCache.has(key))
    let next = 0
    const signal = this.timelineAbort?.signal
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const key = pending[next++]
        const image = await timelineFrame(this.ffmpegPath, source, Math.max(0, Math.min(source.duration - 0.05, Number(key))), signal)
        if (this.source === source && !signal?.aborted) {
          if (this.frameCache.size >= 256) this.frameCache.delete(this.frameCache.keys().next().value!)
          this.frameCache.set(key, image)
        }
      }
    }
    await Promise.all([worker(), worker()])
    return times.map(time => this.frameCache.get(time.toFixed(3)) || '')
  }

  private async waveformWindows(windows: RecordingWaveformWindow[]): Promise<(string | null)[]> {
    const source = this.source
    if (!source || !Array.isArray(windows) || windows.length > 24 || windows.some(window => !window ||
      !Number.isFinite(window.start) || !Number.isFinite(window.end) || !Number.isInteger(window.width) ||
      window.width < 16 || window.width > 2048 || window.start < 0 ||
      window.end - window.start < 0.0005 || window.end > source.duration + 0.01)) {
      throw new Error('Неверный участок звуковой волны.')
    }
    const key = (item: RecordingWaveformWindow): string => `${item.start.toFixed(6)}:${item.end.toFixed(6)}:${item.width}`
    this.waveformWindowsAbort?.abort()
    const controller = new AbortController()
    this.waveformWindowsAbort = controller
    const pending = [...new Map(windows.map(item => [key(item), item])).entries()]
      .filter(([cacheKey]) => !this.waveformWindowsCache.has(cacheKey))
    const results = new Map<string, string | null>()
    let next = 0
    const signal = controller.signal
    const worker = async (): Promise<void> => {
      while (next < pending.length && !signal.aborted) {
        const [cacheKey, item] = pending[next++]
        let image: string | null = null
        for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
          try { image = await timelineWaveformRange(this.ffmpegPath, source, item.start, item.end, item.width, signal); break }
          catch (error) {
            if (signal.aborted) return
            if (attempt === 1) console.warn('[record-edit-waveform] window unavailable after retry',
              { start: item.start, end: item.end, width: item.width, error })
            else await new Promise(resolve => setTimeout(resolve, 250))
          }
        }
        if (signal.aborted) return
        results.set(cacheKey, image)
        if (image && this.source === source) {
          if (this.waveformWindowsCache.size >= 128) this.waveformWindowsCache.delete(this.waveformWindowsCache.keys().next().value!)
          this.waveformWindowsCache.set(cacheKey, image)
        }
      }
    }
    try { await Promise.all([worker(), worker(), worker()]) }
    finally { if (this.waveformWindowsAbort === controller) this.waveformWindowsAbort = null }
    return windows.map(item => results.get(key(item)) ?? this.waveformWindowsCache.get(key(item)) ?? null)
  }

  private async export(options: RecordingEditOptions): Promise<RecordingEditStatus> {
    return this.select(() => this.exportSelected(options))
  }

  private async exportSelected(options: RecordingEditOptions, epoch = this.selectionEpoch): Promise<RecordingEditStatus> {
    const source = this.source
    if (!source || this.task || this.recordingActive()) throw new Error('Выберите готовую запись и завершите текущую операцию.')
    if (!options || !['fragment', 'separate', 'timeline'].includes(options.mode) ||
      !['lossless-mkv', 'quality-mp4'].includes(options.format)) {
      throw new Error('Проверьте начало и конец фрагмента.')
    }
    const clips: RecordingClip[] = options.clips ?? [{ start: options.start, end: options.end }]
    if (!Array.isArray(clips) || clips.length < 1 || clips.length > 128 || clips.some(clip => !clip ||
      !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 ||
      clip.end - clip.start < 0.04 || clip.end > source.duration + 0.02) || timelineDuration(clips) < 0.04) {
      throw new Error('Проверьте фрагменты на монтажной шкале.')
    }
    if (options.mode === 'separate' && !source.hasAudio) throw new Error('В записи нет звуковой дорожки.')
    const ext = options.format === 'lossless-mkv' ? 'mkv' : 'mp4'
    const stem = basename(source.path, extname(source.path))
    let outputs: string[]
    if (options.mode !== 'separate') {
      const dialogOptions: Electron.SaveDialogOptions = { title: options.mode === 'timeline' ? 'Сохранить монтаж' : 'Сохранить фрагмент записи',
        defaultPath: join(dirname(source.path), `${stem}_${options.mode === 'timeline' ? 'монтаж' : 'фрагмент'}.${ext}`),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }], properties: ['showOverwriteConfirmation'] }
      const parent = this.control()
      const result = parent ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
      if (result.canceled || !result.filePath) return { ...this.status }
      outputs = [result.filePath.toLowerCase().endsWith(`.${ext}`) ? result.filePath : `${result.filePath}.${ext}`]
    } else {
      const dialogOptions: Electron.OpenDialogOptions = { title: 'Папка для отдельных видео и звука',
        defaultPath: dirname(source.path), properties: ['openDirectory'] }
      const parent = this.control()
      const result = parent ? await dialog.showOpenDialog(parent, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
      if (result.canceled || !result.filePaths[0]) return { ...this.status }
      outputs = [join(result.filePaths[0], `${stem}_видео.${ext}`), join(result.filePaths[0], `${stem}_звук.wav`)]
    }
    if (outputs.some(path => existsSync(path))) throw new Error('Файл результата уже существует. Выберите другое имя или папку.')
    if (process.platform === 'darwin' && epoch !== this.selectionEpoch) throw new Error('Монтаж отменён.')
    this.cancelled = false
    this.status = { phase: 'running', progress: 0, outputs: [] }
    const work = this.run(source, options, clips, outputs)
    this.task = work
    void work.finally(() => { if (this.task === work) this.task = null })
    return { ...this.status }
  }

  private async run(source: RecordingEditSource, options: RecordingEditOptions, clips: RecordingClip[], outputs: string[]): Promise<void> {
    const tempPaths = outputs.map(path => join(dirname(path), `.${basename(path)}.${randomUUID()}.part`))
    const published: string[] = []
    try {
      const tracks: Array<'both' | 'video' | 'audio'> = options.mode === 'separate' ? ['video', 'audio'] : ['both']
      const length = timelineDuration(clips)
      for (let i = 0; i < tracks.length; i++) {
        if (this.cancelled) throw new Error('Монтаж отменён.')
        const args = editTimelineArguments(source, clips, options.format, tracks[i], tempPaths[i])
        const process = startEdit(this.ffmpegPath, args, length, fraction => {
          this.status = { ...this.status, progress: (i + fraction) / tracks.length }
        })
        this.child = process.child
        await process.done
        this.child = null
      }
      if (this.cancelled) throw new Error('Монтаж отменён.')
      for (let i = 0; i < outputs.length; i++) {
        if (existsSync(outputs[i])) throw new Error('Файл результата появился во время монтажа. Выберите другое имя.')
        try { await link(tempPaths[i], outputs[i]) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Файл результата уже существует.')
          await copyFile(tempPaths[i], outputs[i], constants.COPYFILE_EXCL)
        }
        published.push(outputs[i])
        await unlink(tempPaths[i])
      }
      this.status = { phase: 'done', progress: 1, outputs, message: 'Готово. Исходная запись сохранена без изменений.' }
    } catch (error) {
      for (const path of published) await unlink(path).catch(() => {})
      this.status = { phase: this.cancelled ? 'idle' : 'error', progress: 0, outputs: [],
        message: this.cancelled ? 'Монтаж отменён.' : error instanceof Error ? error.message : 'Не удалось завершить монтаж.' }
    } finally {
      this.child = null
      for (const path of tempPaths) await unlink(path).catch(() => {})
    }
  }

  async cancel(): Promise<void> {
    if (!this.task) return
    this.cancelled = true
    this.child?.kill()
    await this.task
  }

  async shutdown(): Promise<void> {
    if (process.platform === 'darwin') this.selectionEpoch++
    this.timelineAbort?.abort()
    this.waveformWindowsAbort?.abort()
    await this.cancel()
  }
}
