import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),

  loadFolder: (folderPath: string) => ipcRenderer.invoke('load-folder', folderPath),

  getDisplays: () => ipcRenderer.invoke('get-displays'),

  openPresentationWindow: (displayId?: number) =>
    ipcRenderer.invoke('open-presentation-window', displayId),

  closePresentationWindow: () => ipcRenderer.invoke('close-presentation-window'),

  checkPowerPoint: (): Promise<boolean> => ipcRenderer.invoke('check-powerpoint'),

  launchPowerPoint: (filePath: string, monitorIndex?: number) =>
    ipcRenderer.invoke('launch-powerpoint', filePath, monitorIndex),

  powerpointCommand: (command: string, arg?: number) =>
    ipcRenderer.invoke('powerpoint-command', command, arg),

  generatePptxThumbnails: (filePath: string) =>
    ipcRenderer.invoke('generate-pptx-thumbnails', filePath),

  readFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('read-file', filePath),

  showOverlay: (displayId?: number) => ipcRenderer.invoke('show-overlay', displayId),

  hideOverlay: () => ipcRenderer.invoke('hide-overlay'),

  selectBackdropImage: (): Promise<string | null> => ipcRenderer.invoke('select-backdrop-image'),

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

  updateTimerOverlay: (data: {
    remaining: number
    running: boolean
    duration: number
    posX: number
    posY: number
    scale: number
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

  musicSetPlaylist: (files: string[], startIndex?: number): Promise<void> =>
    ipcRenderer.invoke('music-set-playlist', files, startIndex),

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

  openFileExternal: (filePath: string, displayBounds?: { x: number; y: number; width: number; height: number }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('open-file-external', filePath, displayBounds),

  closeExternalFile: (filePath?: string): Promise<void> => ipcRenderer.invoke('close-external-file', filePath),

  minimizeExternalFile: (filePath?: string): Promise<void> => ipcRenderer.invoke('minimize-external-file', filePath),

  restoreExternalFile: (filePath?: string, displayBounds?: { x: number; y: number; width: number; height: number }): Promise<void> =>
    ipcRenderer.invoke('restore-external-file', filePath, displayBounds),

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
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
