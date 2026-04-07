import { contextBridge, ipcRenderer } from 'electron'
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

  switchAudioToExternal: (): Promise<{ success: boolean; device?: string; error?: string }> =>
    ipcRenderer.invoke('switch-audio-to-external'),

  restoreAudioDevice: (): Promise<void> => ipcRenderer.invoke('restore-audio-device'),

  toggleGlobalHook: (enable: boolean): Promise<boolean> =>
    ipcRenderer.invoke('toggle-global-hook', enable),

  sendToPresentation: (channel: string, ...args: unknown[]): void => {
    ipcRenderer.send('send-to-presentation', channel, ...args)
  },

  sendToControl: (channel: string, ...args: unknown[]): void => {
    ipcRenderer.send('send-to-control', channel, ...args)
  },

  signalReady: (): void => {
    ipcRenderer.send('presentation-ready')
  },

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
