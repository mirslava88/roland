const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  setControlPreviewFullscreen: (enabled) => ipcRenderer.invoke('set-control-preview-fullscreen', enabled),
  setChannelPreviewKeyboardGuard: (enabled) => ipcRenderer.invoke('set-channel-preview-keyboard-guard', enabled)
})
