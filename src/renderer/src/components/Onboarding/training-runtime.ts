import type { VirtualCameraStatus } from '../../../../shared/virtual-camera'
import type { RecordingEditSource, RecordingSettings, RecordingStatus, RecordingWaveformWindow } from '../../../../shared/recording'

// Installed before importing App/store. No preload, main process or parent API.
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
export const emitTraining = (event: string, ...args: unknown[]): void => {
  listeners.get(event)?.forEach(listener => listener(...args))
}
export const TRAINING_FILE = { id: 'pdm-training-deck', name: 'Открытие мероприятия.pptx', path: 'training://presentation.pptx', type: 'presentation', extension: '.pptx', size: 102400 } as const
export const TRAINING_FILE_SECOND = { id: 'pdm-training-deck-2', name: 'Доклад спикера.pptx', path: 'training://speaker.pptx', type: 'presentation', extension: '.pptx', size: 128000 } as const
export const TRAINING_DISPLAYS = [
  { id: 1, label: 'Компьютер оператора', isPrimary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
  { id: 2, label: 'Учебный экран зрителей', isPrimary: false, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }
]
function makeTrainingFrames(titles: string[], colors: [string, string]): string[] {
  return titles.map((title, i) => {
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createLinearGradient(0, 0, 1280, 720); gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1])
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1280, 720)
  ctx.strokeStyle = '#41c2de38'; ctx.lineWidth = 60; ctx.beginPath(); ctx.arc(1140, 250, 280, 0, Math.PI * 2); ctx.stroke()
  ctx.fillStyle = '#7ed5ff'; ctx.font = '22px Segoe UI'; ctx.fillText(`ЗНАКОМСТВО С PDM · ${i + 1} / 3`, 90, 180)
  ctx.fillStyle = '#fff'; ctx.font = 'bold 64px Segoe UI'; ctx.fillText(title, 90, 340)
  ctx.fillStyle = '#bddbe8'; ctx.font = '28px Segoe UI'; ctx.fillText('Учебные материалы · Только внутри программы', 90, 415)
  return canvas.toDataURL('image/png')
  })
}
export const trainingFrames = makeTrainingFrames(['Открытие мероприятия', 'Программа дня', 'Добро пожаловать'], ['#143c56', '#166b7c'])
export const trainingFramesSecond = makeTrainingFrames(['Доклад выступающего', 'Главная мысль', 'Спасибо за внимание'], ['#3f255f', '#7c315f'])
export const trainingCalls: string[] = []
const TRAINING_RECORDING_PATH = 'training://recording.mp4'
const TRAINING_RECORDING_SOURCE: RecordingEditSource = {
  path: TRAINING_RECORDING_PATH, duration: 8, hasAudio: true, format: 'mp4', frameRate: 24
}
let trainingRecordingSettings: RecordingSettings = { format: 'quality-mp4', fps: 30, audio: 'system', microphoneId: '' }
let trainingRecordingStatus: RecordingStatus = {
  phase: 'idle', startedAt: null, frames: 0, fps: 0, droppedFrames: 0, sizeBytes: 0
}
export function setTrainingRecordingStage(stage: 'ready' | 'running' | 'finished'): void {
  trainingRecordingStatus = stage === 'running'
    ? { phase: 'running', startedAt: Date.now() - 5000, frames: 120, fps: 24, droppedFrames: 0,
      sizeBytes: 200000, source: 'display' }
    : { phase: 'idle', startedAt: null, frames: stage === 'finished' ? 192 : 0, fps: 0,
      droppedFrames: 0, sizeBytes: stage === 'finished' ? 403429 : 0,
      ...(stage === 'finished' ? { path: TRAINING_RECORDING_PATH } : {}) }
}
function trainingWaveform(window: RecordingWaveformWindow): string {
  const width = Math.max(16, Math.min(2048, Math.round(window.width)))
  const count = Math.ceil(width / 4) + 1
  const strokes = Array.from({ length: count }, (_, index) => {
    const x = Math.min(width, index * 4)
    const time = window.start + (window.end - window.start) * index / Math.max(1, count - 1)
    const amplitude = 3 + Math.abs(Math.sin(time * 18) * Math.cos(time * 7)) * 17
    return `M${x} ${Math.round(24 - amplitude)}V${Math.round(24 + amplitude)} M${x} ${Math.round(72 - amplitude)}V${Math.round(72 + amplitude)}`
  }).join(' ')
  return `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="96" viewBox="0 0 ${width} 96"><path d="${strokes}" stroke="#79d8f4" stroke-width="2" opacity=".85"/></svg>`)}`
}

export function installTrainingRuntime(): void {
  if (window === window.top) throw new Error('Training may only run in its isolated frame')
  // A preload accidentally attached to a subframe is a safety error, not a fallback.
  if (window.api) throw new Error('Training cannot inherit the real Electron API')
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size }, clear: () => values.clear(), key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)) }, removeItem: key => { values.delete(key) }
  }
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: false, writable: false })
  Object.defineProperty(window, 'sessionStorage', { value: storage, configurable: false, writable: false })
  const asyncValue = (name: string, result: unknown) => (..._args: unknown[]) => { trainingCalls.push(name); return Promise.resolve(result) }
  const cache = { success: true, slides: trainingFrames, thumbnails: trainingFrames, slideCount: 3, aspectRatio: 16 / 9 }
  let audioDevices = [
    { id: 'training-speakers', name: 'Динамики компьютера (учебные)', isDefault: true },
    { id: 'training-hdmi', name: 'Проектор / HDMI (учебный)', isDefault: false }
  ]
  let virtualCameraStatus: VirtualCameraStatus = {
    phase: 'idle', supported: true, installed: true, available: true, source: null,
    error: null, name: 'PDM Virtual Camera', width: 1920, height: 1080, fps: 30, startedAt: null
  }
  const trainingCaptureDevices = [
    { deviceId: 'training-camera', kind: 'videoinput', label: 'Учебная камера с зелёным фоном', groupId: 'training-camera-group' },
    { deviceId: 'training-microphone', kind: 'audioinput', label: 'Микрофон учебной камеры', groupId: 'training-camera-group' }
  ]
  const api = {
    platform: new URLSearchParams(location.search).get('platform') === 'darwin' ? 'darwin' : 'win32',
    macSetup: { presentationSupport: asyncValue('macSetup.presentationSupport', { installed: true }), permissions: asyncValue('macSetup.permissions', { screen: 'granted', accessibility: true }) },
    ensureCameraAccess: asyncValue('ensureCameraAccess', 'granted'),
    dbgLog() {}, on(event: string, fn: (...args: unknown[]) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); return () => { listeners.get(event)?.delete(fn) } },
    getDisplays: asyncValue('getDisplays', TRAINING_DISPLAYS), getDrives: asyncValue('getDrives', []),
    loadFolder: asyncValue('loadFolder', { files: [TRAINING_FILE, TRAINING_FILE_SECOND], subfolders: [] }), watchFolder() {},
    selectFolder: asyncValue('selectFolder', 'Учебные материалы'), getPathForFile() { return '' },
    preparePptxCache: asyncValue('preparePptxCache', cache), generatePptxSlides: asyncValue('generatePptxSlides', cache),
    generatePptxThumbnails: asyncValue('generatePptxThumbnails', cache),
    launchPowerPoint: asyncValue('launchPowerPoint', { success: true }),
    validateConfigPaths: async (paths: string[]) => paths.map(path => ({
      path,
      exists: path === TRAINING_FILE.path || path === TRAINING_FILE_SECOND.path,
      isDirectory: false
    })),
    getTimerOverlayLayout: asyncValue('getTimerOverlayLayout', { x: .9, y: .9, scale: 1 }),
    selectBackdropImage: asyncValue('selectBackdropImage', trainingFrames[0]), switchAudioToExternal: asyncValue('switchAudioToExternal', { success: true }),
    selectSoundFile: asyncValue('selectSoundFile', null),
    toggleGlobalHook: async (enabled: boolean) => enabled,
    updateProgramSceneMediaOverlay: asyncValue('updateProgramSceneMediaOverlay', { success: true }),
    updateQrOverlay: asyncValue('updateQrOverlay', { success: true }),
    hideQrOverlay: asyncValue('hideQrOverlay', { success: true }), showQrOverlay: asyncValue('showQrOverlay', { success: true }),
    updateTimerOverlay: asyncValue('updateTimerOverlay', { success: true }), hideTimerOverlay: asyncValue('hideTimerOverlay', { success: true }), showTimerOverlay: asyncValue('showTimerOverlay', { success: true }),
    openPresentationWindow: asyncValue('openPresentationWindow', { success: true }), closePresentationWindow: asyncValue('closePresentationWindow', { success: true }),
    relocatePowerPoint: asyncValue('relocatePowerPoint', { success: true }), raisePresentationWindow: asyncValue('raisePresentationWindow', { success: true }),
    setActiveContentType() {}, hideOverlay: asyncValue('hideOverlay', { success: true }), showOverlay: asyncValue('showOverlay', { success: true }),
    musicGetState: asyncValue('musicGetState', { playing: false, currentIndex: 0, currentTime: 0, duration: 0, volume: 0, trackName: '', loopTrack: false }),
    getAudioDevices: () => { trainingCalls.push('getAudioDevices'); return Promise.resolve(audioDevices.map(device => ({ ...device }))) },
    setAudioDevice: (deviceId: string) => {
      trainingCalls.push('setAudioDevice')
      if (!audioDevices.some(device => device.id === deviceId)) return Promise.resolve({ success: false, error: 'Учебное устройство не найдено' })
      audioDevices = audioDevices.map(device => ({ ...device, isDefault: device.id === deviceId }))
      return Promise.resolve({ success: true })
    },
    virtualCamera: {
      status: () => { trainingCalls.push('virtualCamera.status'); return Promise.resolve({ ...virtualCameraStatus }) },
      install: () => { trainingCalls.push('virtualCamera.install'); return Promise.resolve({ ...virtualCameraStatus }) },
      start: () => {
        trainingCalls.push('virtualCamera.start')
        virtualCameraStatus = { ...virtualCameraStatus, phase: 'running', source: 'display', startedAt: Date.now() }
        return Promise.resolve({ ...virtualCameraStatus })
      },
      stop: () => {
        trainingCalls.push('virtualCamera.stop')
        virtualCameraStatus = { ...virtualCameraStatus, phase: 'idle', source: null, startedAt: null }
        return Promise.resolve({ ...virtualCameraStatus })
      }
    },
    ...(__PDM_STREAM_ENABLED__ ? { recording: {
      load: () => { trainingCalls.push('recording.load'); return Promise.resolve({ ...trainingRecordingSettings }) },
      save: (settings: RecordingSettings) => { trainingCalls.push('recording.save'); trainingRecordingSettings = { ...settings }; return Promise.resolve() },
      devices: asyncValue('recording.devices', [{ id: 'training-mic', label: 'Учебный микрофон' }]),
      status: () => { trainingCalls.push('recording.status'); return Promise.resolve({ ...trainingRecordingStatus }) },
      start: (settings: RecordingSettings) => {
        trainingCalls.push('recording.start'); trainingRecordingSettings = { ...settings }
        setTrainingRecordingStage('running'); return Promise.resolve(true)
      },
      stop: () => { trainingCalls.push('recording.stop'); setTrainingRecordingStage('finished'); return Promise.resolve() },
      editOpen: (useLast = false) => { trainingCalls.push(`recording.editOpen:${useLast}`); return Promise.resolve({ ...TRAINING_RECORDING_SOURCE }) },
      editFrame: (time: number) => { trainingCalls.push('recording.editFrame'); return Promise.resolve(trainingFrames[Math.min(2, Math.floor(time / 8 * 3))]) },
      editThumbnails: () => { trainingCalls.push('recording.editThumbnails'); return Promise.resolve(Array.from({ length: 12 }, (_, index) => trainingFrames[Math.floor(index / 4)])) },
      editTimelineFrames: (times: number[]) => { trainingCalls.push('recording.editTimelineFrames'); return Promise.resolve(times.map(time => trainingFrames[Math.min(2, Math.floor(time / 8 * 3))])) },
      editWaveform: () => { trainingCalls.push('recording.editWaveform'); return Promise.resolve(trainingWaveform({ start: 0, end: 8, width: 1200 })) },
      editWaveformWindows: (windows: RecordingWaveformWindow[]) => { trainingCalls.push('recording.editWaveformWindows'); return Promise.resolve(windows.map(trainingWaveform)) },
      editTimelineCancel: asyncValue('recording.editTimelineCancel', undefined),
      editStatus: asyncValue('recording.editStatus', { phase: 'idle', progress: 0, outputs: [] }),
      editExport: asyncValue('recording.editExport', { phase: 'done', progress: 1, outputs: ['Учебный монтаж.mp4'] }),
      editCancel: asyncValue('recording.editCancel', undefined)
    } } : {}),
    setControlPreviewFullscreen: asyncValue('setControlPreviewFullscreen', true),
    getAppVersion: asyncValue('getAppVersion', 'Учебный режим'),
    getDesktopCaptureSources: asyncValue('getDesktopCaptureSources', []),
    sendToPresentation(event: string, payload?: unknown) {
      trainingCalls.push(`sendToPresentation:${event}`)
      if (event === 'program-scene-update') setTimeout(() => emitTraining('program-scene-applied', { revision: (payload as { revision?: number })?.revision }), 0)
      if (event === 'capture-devices-request') {
        const request = payload as { requestId?: string; includeAudio?: boolean } | undefined
        setTimeout(() => emitTraining('capture-devices-response', {
          requestId: request?.requestId,
          devices: request?.includeAudio ? trainingCaptureDevices : trainingCaptureDevices.filter(device => device.kind === 'videoinput')
        }), 0)
      }
    },
    powerpointCommand: asyncValue('powerpointCommand', { success: true }),
    streaming: { load: asyncValue('streaming.load', { available: false, canSave: false, settings: { destinations: [], audio: {}, video: {} }, warning: 'Стрим отключён в обучении' }), status: asyncValue('streaming.status', { phase: 'idle', destinations: [] }), start: asyncValue('streaming.start', { success: false, error: 'Стрим отключён в обучении' }), stop: asyncValue('streaming.stop', { success: false }) }
  }
  // Unknown actions fail closed. Nothing is ever forwarded to another window.
  const fakeApi = new Proxy(api, { get(target, name) {
    if (name in target) return target[name as keyof typeof target]
    return asyncValue(String(name), { success: false, error: 'Это действие недоступно в учебном режиме' })
  } })
  Object.defineProperty(window, 'api', { value: Object.freeze(fakeApi), configurable: false, writable: false })
  const cameraCanvas = document.createElement('canvas')
  cameraCanvas.width = 960; cameraCanvas.height = 540
  const cameraContext = cameraCanvas.getContext('2d')!
  cameraContext.fillStyle = '#00b140'; cameraContext.fillRect(0, 0, cameraCanvas.width, cameraCanvas.height)
  cameraContext.fillStyle = '#f1c7a5'; cameraContext.beginPath(); cameraContext.arc(480, 175, 78, 0, Math.PI * 2); cameraContext.fill()
  cameraContext.fillStyle = '#27334b'; cameraContext.fillRect(350, 255, 260, 285)
  cameraContext.fillStyle = '#ffffff'; cameraContext.font = 'bold 28px Segoe UI'; cameraContext.fillText('УЧЕБНАЯ КАМЕРА', 330, 500)
  const mediaDevices = trainingCaptureDevices.map(device => ({ ...device, toJSON() { return this } })) as MediaDeviceInfo[]
  const media = {
    enumerateDevices: async () => mediaDevices,
    getUserMedia: async () => {
      const canvasWithStream = cameraCanvas as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream }
      return canvasWithStream.captureStream?.(5) ?? new MediaStream()
    },
    getDisplayMedia: async () => { throw new Error('Захват экрана отключён в обучении') }
  }
  Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: false })
  window.alert = message => window.dispatchEvent(new CustomEvent('training-notice', { detail: String(message) }))
  window.confirm = () => false
  const errors: string[] = []
  window.addEventListener('error', event => errors.push(String(event.error || event.message)))
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
  Object.assign(window, { trainingErrors: errors })
}
