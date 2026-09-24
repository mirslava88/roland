import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { streamingApi } from './streaming-api'
import type {
  DirectStreamDeckConfig,
  DirectStreamDeckDeviceInfo,
  DirectStreamDeckKeyState,
  DirectStreamDeckStatus
} from '../shared/direct-stream-deck'
import type { VirtualCameraApi } from '../shared/virtual-camera'

interface DriveInfo {
  name: string
  root: string
  label: string
  totalSize: number
  freeSize: number
  isRemovable: boolean
}

interface MusicState {
  playing: boolean
  currentIndex: number
  currentTime: number
  duration: number
  volume: number
  loopTrack: boolean
  loopPlaylist: boolean
  trackName: string
  playlistLength: number
}

const api = {
  ...(__PDM_STREAM_ENABLED__ ? { streaming: streamingApi } : {}),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  virtualCamera: {
    status: () => ipcRenderer.invoke('virtual-camera-status'),
    install: () => ipcRenderer.invoke('virtual-camera-install'),
    start: (displayId: number | null) => ipcRenderer.invoke('virtual-camera-start', displayId),
    stop: () => ipcRenderer.invoke('virtual-camera-stop')
  } satisfies VirtualCameraApi,
  loadQrWifiPassword: (): Promise<string> => ipcRenderer.invoke('qr-wifi-password-load'),
  saveQrWifiPassword: (password: string): Promise<boolean> =>
    ipcRenderer.invoke('qr-wifi-password-save', password),

  listDirectStreamDecks: (): Promise<DirectStreamDeckDeviceInfo[]> =>
    ipcRenderer.invoke('direct-stream-deck-list'),

  getDirectStreamDeckStatus: (): Promise<DirectStreamDeckStatus | null> =>
    ipcRenderer.invoke('direct-stream-deck-status'),

  configureDirectStreamDeck: (config: DirectStreamDeckConfig): Promise<DirectStreamDeckStatus | null> =>
    ipcRenderer.invoke('direct-stream-deck-configure', config),

  connectDirectStreamDeck: (): Promise<DirectStreamDeckStatus | null> =>
    ipcRenderer.invoke('direct-stream-deck-connect'),

  disconnectDirectStreamDeck: (): Promise<DirectStreamDeckStatus | null> =>
    ipcRenderer.invoke('direct-stream-deck-disconnect'),

  updateDirectStreamDeckKeys: (states: DirectStreamDeckKeyState[]): void =>
    ipcRenderer.send('direct-stream-deck-keys', states),

  saveAppConfig: (content: string): Promise<{ success: boolean; canceled: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('save-app-config', content),

  loadAppConfig: (): Promise<{ success: boolean; canceled: boolean; path?: string; content?: string; error?: string }> =>
    ipcRenderer.invoke('load-app-config'),

  validateConfigPaths: (paths: string[]): Promise<Array<{ path: string; exists: boolean; isDirectory: boolean }>> =>
    ipcRenderer.invoke('validate-config-paths', paths),

  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),

  loadFolder: (folderPath: string) => ipcRenderer.invoke('load-folder', folderPath),

  watchFolder: (folderPath: string | null) => ipcRenderer.invoke('watch-folder', folderPath),

  getDisplays: () => ipcRenderer.invoke('get-displays'),

  getWindowDisplayScaleFactor: (): Promise<number> =>
    ipcRenderer.invoke('get-window-display-scale-factor'),

  openDiagnosticLogFolder: (): Promise<{ success: boolean; path: string; error?: string }> =>
    ipcRenderer.invoke('open-diagnostic-log-folder'),

  openDisplaySettings: () => ipcRenderer.invoke('open-display-settings'),

  setDisplayMode: (mode: 'internal' | 'clone' | 'extend' | 'external') =>
    ipcRenderer.invoke('set-display-mode', mode),

  getDisplayModes: () => ipcRenderer.invoke('get-display-modes'),

  setDisplayResolution: (deviceName: string, width: number, height: number, frequency?: number) =>
    ipcRenderer.invoke('set-display-resolution', deviceName, width, height, frequency),

  openPresentationWindow: (displayId?: number, behindPowerPoint?: boolean) =>
    ipcRenderer.invoke('open-presentation-window', displayId, behindPowerPoint),
  prepareInternalProgramOutput: () => ipcRenderer.invoke('prepare-internal-program-output'),
  releaseInternalProgramOutput: () => ipcRenderer.invoke('release-internal-program-output'),

  placePresentationWindow: (displayId?: number): Promise<boolean> =>
    ipcRenderer.invoke('place-presentation-window', displayId),

  raisePresentationWindow: (): Promise<boolean> =>
    ipcRenderer.invoke('raise-presentation-window'),

  openAuxiliaryWindow: (role: 'mirror' | 'speaker' | 'info' | 'timer' | 'event-timer' | 'backdrop', displayId: number) =>
    ipcRenderer.invoke('open-auxiliary-window', role, displayId),

  closeAuxiliaryWindow: (role: 'mirror' | 'speaker' | 'info' | 'timer' | 'event-timer' | 'backdrop', displayId?: number) =>
    ipcRenderer.invoke('close-auxiliary-window', role, displayId),

  sendToAuxiliary: (role: 'mirror' | 'speaker' | 'info' | 'timer' | 'event-timer' | 'backdrop', channel: string, ...args: unknown[]): void => {
    ipcRenderer.send('send-to-auxiliary', role, channel, ...args)
  },

  freezeProgramMirrors: (transitionId: string): Promise<{ armed: number }> =>
    ipcRenderer.invoke('freeze-program-mirrors', transitionId),

  completeProgramMirrorTransition: (
    transitionId: string
  ): Promise<{ released: number; remaining: number }> =>
    ipcRenderer.invoke('complete-program-mirror-transition', transitionId),

  releaseProgramMirrorHold: (transitionId: string): Promise<boolean> =>
    ipcRenderer.invoke('release-program-mirror-hold', transitionId),

  getScreenCaptureSource: (displayId: number): Promise<string | null> =>
    ipcRenderer.invoke('get-screen-capture-source', displayId),

  closePresentationWindow: () => ipcRenderer.invoke('close-presentation-window'),

  checkPowerPoint: (): Promise<boolean> => ipcRenderer.invoke('check-powerpoint'),

  preparePowerPoint: (filePath: string) =>
    ipcRenderer.invoke('prepare-powerpoint', filePath),

  preparePptxCache: (filePath: string) =>
    ipcRenderer.invoke('prepare-pptx-cache', filePath),

  syncPreparedPowerPoints: (filePaths: string[]) =>
    ipcRenderer.invoke('sync-prepared-powerpoints', filePaths),

  launchPowerPoint: (
    filePath: string,
    displayId?: number,
    startSlide?: number,
    sceneLayout?: unknown,
    deferPromotion?: boolean
  ) => ipcRenderer.invoke(
    'launch-powerpoint',
    filePath,
    displayId,
    startSlide,
    sceneLayout,
    deferPromotion
  ),

  powerpointCommand: (command: string, arg?: number | { stopAtBoundary?: boolean }) =>
    ipcRenderer.invoke('powerpoint-command', command, arg),

  relocatePowerPoint: (displayId: number, sceneLayout?: unknown) =>
    ipcRenderer.invoke('relocate-powerpoint', displayId, sceneLayout),

  setPowerPointZoom: (displayId: number, zoom: unknown) =>
    ipcRenderer.invoke('set-powerpoint-zoom', displayId, zoom),

  setExternalFileZoom: (filePath: string, zoom: unknown) =>
    ipcRenderer.invoke('set-external-file-zoom', filePath, zoom),

  generatePptxThumbnails: (filePath: string, keepPrepared?: boolean) =>
    ipcRenderer.invoke('generate-pptx-thumbnails', filePath, keepPrepared),

  getPptxSlideNotes: (filePath: string, slide: number) =>
    ipcRenderer.invoke('get-pptx-slide-notes', filePath, slide),

  generatePptxSlides: (filePath: string, width?: number, height?: number) =>
    ipcRenderer.invoke('generate-pptx-slides', filePath, width, height),

  readFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('read-file', filePath),

  showOverlay: (
    displayId?: number,
    freezeImageDataUrl?: string,
    imagePath?: string,
    placement?: 'cover' | 'underlay',
    safetyLock?: boolean
  ) => ipcRenderer.invoke(
    'show-overlay', displayId, freezeImageDataUrl, imagePath, placement, safetyLock
  ),

  swapOverlayImage: (imagePath: string): Promise<void> =>
    ipcRenderer.invoke('swap-overlay-image', imagePath),

  pinOverlay: (): Promise<void> => ipcRenderer.invoke('pin-overlay'),

  snapshotSlideshow: (): Promise<string | null> =>
    ipcRenderer.invoke('snapshot-slideshow'),

  renderPdfPage: (filePath: string, pageIndex: number, width: number): Promise<string | null> =>
    ipcRenderer.invoke('render-pdf-page', filePath, pageIndex, width),

  hideOverlay: () => ipcRenderer.invoke('hide-overlay'),

  captureAndSwapOverlay: (): Promise<boolean> => ipcRenderer.invoke('capture-and-swap-overlay'),

  captureDisplay: (displayId?: number): Promise<string | null> =>
    ipcRenderer.invoke('capture-display', displayId),

  capturePresentationFrame: (): Promise<string | null> =>
    ipcRenderer.invoke('capture-presentation-frame'),

  captureProgramPreviewFrame: (): Promise<{ dataUrl: string; width: number; height: number } | null> =>
    ipcRenderer.invoke('capture-program-preview-frame'),

  getDesktopCaptureSources: (
    types?: Array<'window' | 'screen'>,
    excludedDisplayId?: number
  ) =>
    ipcRenderer.invoke('get-desktop-capture-sources', types, excludedDisplayId),

  prepareDesktopCaptureSource: (sourceId: string) =>
    ipcRenderer.invoke('prepare-desktop-capture-source', sourceId),

  releaseBrowserFullscreen: (keepSourceKey?: string): Promise<{ released: number; remaining: number }> =>
    ipcRenderer.invoke('release-browser-fullscreen', keepSourceKey),

  selectBackdropImage: (): Promise<string | null> => ipcRenderer.invoke('select-backdrop-image'),
  selectSceneLayerFiles: (): Promise<string[] | null> => ipcRenderer.invoke('select-scene-layer-files'),

  selectQrLogo: (): Promise<string | null> => ipcRenderer.invoke('select-qr-logo'),

  selectQrImage: (): Promise<string | null> => ipcRenderer.invoke('select-qr-image'),

  updateQrOverlay: (data: unknown): void => {
    ipcRenderer.send('qr-overlay-update', data)
  },

  updateProgramSceneMediaOverlay: (data: unknown): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('program-scene-media-overlay-update', data),

  selectInformationMedia: (): Promise<string | null> => ipcRenderer.invoke('select-information-media'),

  getAudioDevices: (): Promise<{ id: string; name: string; isDefault: boolean }[]> =>
    ipcRenderer.invoke('get-audio-devices'),

  setAudioDevice: (deviceId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('set-audio-device', deviceId),

  switchAudioToExternal: (): Promise<{ success: boolean; device?: string; error?: string }> =>
    ipcRenderer.invoke('switch-audio-to-external'),

  restoreAudioDevice: (): Promise<void> => ipcRenderer.invoke('restore-audio-device'),

  toggleGlobalHook: (enable: boolean): Promise<boolean> =>
    ipcRenderer.invoke('toggle-global-hook', enable),

  selectSoundFile: (): Promise<string | null> =>
    ipcRenderer.invoke('select-sound-file'),

  moveFile: (srcPath: string, destFolder: string): Promise<{ success: boolean; newPath?: string; error?: string }> =>
    ipcRenderer.invoke('move-file', srcPath, destFolder),

  generateDocPreview: (filePath: string): Promise<{ success: boolean; pdfPath?: string; error?: string }> =>
    ipcRenderer.invoke('generate-doc-preview', filePath),

  hideTaskbar: (displayBounds: { x: number; y: number; width: number; height: number }): Promise<void> =>
    ipcRenderer.invoke('hide-taskbar', displayBounds),

  showTaskbar: (): Promise<void> =>
    ipcRenderer.invoke('show-taskbar'),

  getDrives: (): Promise<DriveInfo[]> => ipcRenderer.invoke('get-drives'),

  renameFile: (filePath: string, newName: string): Promise<{ success: boolean; newPath?: string; error?: string }> =>
    ipcRenderer.invoke('rename-file', filePath, newName),

  copyFilesToFolder: (filePaths: string[], destFolder: string): Promise<{ success: boolean; name: string; error?: string }[]> =>
    ipcRenderer.invoke('copy-files-to-folder', filePaths, destFolder),

  deleteItems: (paths: string[], permanent: boolean): Promise<{ success: boolean; path: string; error?: string }[]> =>
    ipcRenderer.invoke('delete-items', paths, permanent),

  copyItemsToFolder: (srcPaths: string[], destFolder: string): Promise<{ success: boolean; name: string; error?: string }[]> =>
    ipcRenderer.invoke('copy-items-to-folder', srcPaths, destFolder),

  moveItem: (srcPath: string, destFolder: string): Promise<{ success: boolean; newPath?: string; error?: string }> =>
    ipcRenderer.invoke('move-item', srcPath, destFolder),

  showTimerOverlay: (displayId?: number) => ipcRenderer.invoke('show-timer-overlay', displayId),

  hideTimerOverlay: () => ipcRenderer.invoke('hide-timer-overlay'),

  getTimerOverlayLayout: (): Promise<{ x: number; y: number; scale: number; valid: boolean }> =>
    ipcRenderer.invoke('get-timer-overlay-layout'),

  updateTimerOverlay: (data: {
    remaining: number
    running: boolean
    duration: number
    posX: number
    posY: number
    scale: number
    textColor: string
    warningTextColor: string
    overtimeTextColor: string
    textOpacity: number
  }): void => {
    ipcRenderer.send('timer-overlay-update', data)
  },

  playTimerSound: (type: string, filePath: string): void => {
    ipcRenderer.send('timer-play-sound', type, filePath)
  },

  moveTimerOverlay: (dx: number, dy: number): void => {
    ipcRenderer.send('move-timer-overlay', dx, dy)
  },

  resizeTimerOverlay: (w: number, h: number): void => {
    ipcRenderer.send('resize-timer-overlay', w, h)
  },

  selectMusicFiles: (): Promise<string[] | null> => ipcRenderer.invoke('select-music-files'),

  selectMusicFolder: (): Promise<string[] | null> => ipcRenderer.invoke('select-music-folder'),

  musicSetPlaylist: (files: string[], startIndex?: number, autoplay?: boolean): Promise<void> =>
    ipcRenderer.invoke('music-set-playlist', files, startIndex, autoplay),

  musicPlay: (): Promise<void> => ipcRenderer.invoke('music-play'),

  musicPause: (): Promise<void> => ipcRenderer.invoke('music-pause'),

  musicStop: (): Promise<void> => ipcRenderer.invoke('music-stop'),

  musicNext: (): Promise<void> => ipcRenderer.invoke('music-next'),

  musicPrev: (): Promise<void> => ipcRenderer.invoke('music-prev'),

  musicSetLoopTrack: (value: boolean): Promise<void> => ipcRenderer.invoke('music-set-loop-track', value),

  musicSetLoopPlaylist: (value: boolean): Promise<void> => ipcRenderer.invoke('music-set-loop-playlist', value),

  musicSetVolume: (value: number): Promise<void> => ipcRenderer.invoke('music-set-volume', value),

  musicSeek: (time: number): Promise<void> => ipcRenderer.invoke('music-seek', time),

  musicGetState: (): Promise<MusicState | null> => ipcRenderer.invoke('music-get-state'),

  selectVideoFiles: (): Promise<string[] | null> => ipcRenderer.invoke('select-video-files'),
  selectVideoFolder: (): Promise<string[] | null> => ipcRenderer.invoke('select-video-folder'),

  openFileExternal: (filePath: string, displayBounds?: { x: number; y: number; width: number; height: number }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('open-file-external', filePath, displayBounds),

  closeExternalFile: (filePath?: string): Promise<{ success: boolean; error?: string; windowGone?: boolean }> =>
    ipcRenderer.invoke('close-external-file', filePath),

  minimizeExternalFile: (filePath?: string): Promise<{ success: boolean; error?: string; windowGone?: boolean }> =>
    ipcRenderer.invoke('minimize-external-file', filePath),

  restoreExternalFile: (filePath?: string, displayBounds?: { x: number; y: number; width: number; height: number }, sceneLayout?: unknown): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('restore-external-file', filePath, displayBounds, sceneLayout),

  setActiveContentType: (type: string): void => {
    ipcRenderer.send('set-active-content-type', type)
  },

  sendToPresentation: (channel: string, ...args: unknown[]): void => {
    ipcRenderer.send('send-to-presentation', channel, ...args)
  },

  sendToControl: (channel: string, ...args: unknown[]): void => {
    ipcRenderer.send('send-to-control', channel, ...args)
  },

  signalReady: (): void => {
    ipcRenderer.send('presentation-ready')
  },

  dbgLog: (msg: string): void => {
    ipcRenderer.send('dbg-log', msg)
  },

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      callback(...args)
    }
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.api = api
}
