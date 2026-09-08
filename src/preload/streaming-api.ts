import { ipcRenderer } from 'electron'
import type { StreamingApi } from '../shared/streaming'

export const streamingApi: StreamingApi = {
  load: () => ipcRenderer.invoke('stream-load'),
  save: (settings) => ipcRenderer.invoke('stream-save', settings),
  devices: () => ipcRenderer.invoke('stream-devices'),
  check: (settings) => ipcRenderer.invoke('stream-check', settings),
  start: (settings, displayId) => ipcRenderer.invoke('stream-start', settings, displayId),
  stop: () => ipcRenderer.invoke('stream-stop'),
  status: () => ipcRenderer.invoke('stream-status')
}
