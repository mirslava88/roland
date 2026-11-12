import { ipcRenderer } from 'electron'
import type { RecordingApi } from '../shared/recording'

export const recordingApi: RecordingApi = {
  load: () => ipcRenderer.invoke('record-load'),
  save: (settings) => ipcRenderer.invoke('record-save', settings),
  devices: () => ipcRenderer.invoke('record-devices'),
  start: (settings, displayId) => ipcRenderer.invoke('record-start', settings, displayId),
  stop: () => ipcRenderer.invoke('record-stop'),
  status: () => ipcRenderer.invoke('record-status'),
  editOpen: (useLast) => ipcRenderer.invoke('record-edit-open', useLast === true),
  editFrame: (time) => ipcRenderer.invoke('record-edit-frame', time),
  editThumbnails: () => ipcRenderer.invoke('record-edit-thumbnails'),
  editTimelineFrames: (times) => ipcRenderer.invoke('record-edit-timeline-frames', times),
  editWaveform: () => ipcRenderer.invoke('record-edit-waveform'),
  editWaveformWindows: (windows) => ipcRenderer.invoke('record-edit-waveform-windows', windows),
  editTimelineCancel: () => ipcRenderer.invoke('record-edit-timeline-cancel'),
  editExport: (options) => ipcRenderer.invoke('record-edit-export', options),
  editStatus: () => ipcRenderer.invoke('record-edit-status'),
  editCancel: () => ipcRenderer.invoke('record-edit-cancel')
}
