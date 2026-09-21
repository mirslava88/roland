import { contextBridge, ipcRenderer } from 'electron'

const INBOUND_CHANNELS = new Set([
  'prewarm-pdf',
  'release-prewarmed-pdf',
  'load-content',
  'stop',
  'capture-audio-live',
  'commit-content-load',
  'cancel-content-load',
  'suspend-active-content',
  'resume-active-content',
  'clear-active-content',
  'navigate-slide',
  'navigate-pdf',
  'play-pause',
  'seek',
  'set-volume',
  'set-loop',
  'capture-source-state-request',
  'capture-source-register',
  'capture-source-unregister',
  'capture-devices-request',
  'program-scene-update',
  'program-scene-audio-retry',
  'program-scene-audio-update',
  'program-scene-audio-status-request',
  'program-scene-powerpoint-hold',
  'program-scene-powerpoint-hold-clear',
  'content-zoom-update',
  'broadcast-titles-update',
  'speaker-state',
  'speaker-timer-update',
  'event-timer-state',
  'information-state',
  'timer-update',
  'backdrop-state',
  'mirror-state',
  'program-timer-overlay',
  'program-mirror-transition-complete'
])

const OUTBOUND_CHANNELS = new Set([
  'presentation-content-ready',
  'presentation-content-committed',
  'presentation-content-prepared',
  'presentation-content-error',
  'pdf-channel-cache-status',
  'presentation-content-suspended',
  'presentation-content-cleared',
  'program-scene-applied',
  'program-scene-ready',
  'content-zoom-ready',
  'broadcast-titles-ready',
  'program-scene-powerpoint-hold-ready',
  'program-scene-powerpoint-hold-error',
  'slide-info',
  'request-close-presentation',
  'video-state',
  'video-time',
  'video-ended',
  'capture-source-state',
  'capture-preview-frame',
  'capture-devices-response',
  'capture-devices-changed',
  'capture-hub-ready',
  'program-scene-audio-status',
  'program-scene-audio-ready',
  'speaker-state-ready',
  'event-timer-ready',
  'timer-state-ready',
  'information-video-state',
  'information-video-ended',
  'information-state-ready',
  'program-mirror-state-ready',
  'program-mirror-ready'
])

const api = {
  readFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('read-output-file', filePath),
  getWindowDisplayScaleFactor: (): Promise<number> =>
    ipcRenderer.invoke('get-window-display-scale-factor'),
  renderPdfPage: (filePath: string, pageIndex: number, width: number): Promise<string | null> =>
    ipcRenderer.invoke('render-pdf-page', filePath, pageIndex, width),
  getScreenCaptureSource: (displayId: number): Promise<string | null> =>
    ipcRenderer.invoke('get-screen-capture-source', displayId),
  prepareDesktopCaptureSource: (sourceId: string) =>
    ipcRenderer.invoke('prepare-desktop-capture-source', sourceId),
  releaseBrowserFullscreen: (keepSourceKey?: string) =>
    ipcRenderer.invoke('release-browser-fullscreen', keepSourceKey),
  releaseProgramMirrorHold: (transitionId: string): Promise<boolean> =>
    ipcRenderer.invoke('release-program-mirror-hold', transitionId),
  sendToControl: (channel: string, ...args: unknown[]): void => {
    if (OUTBOUND_CHANNELS.has(channel)) ipcRenderer.send('send-to-control', channel, ...args)
  },
  signalReady: (): void => ipcRenderer.send('presentation-ready'),
  dbgLog: (message: string): void => ipcRenderer.send('dbg-log', String(message).slice(0, 2000)),
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    if (!INBOUND_CHANNELS.has(channel)) return () => undefined
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
