const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  auditPresentation: async () => ({ success: true, report: {
    slideCount: 3,
    slides: [
      { number: 1, videos: 1, audio: 0, linkedMedia: 0, animations: true, missingFonts: ['Отсутствующий шрифт'] },
      { number: 2, videos: 0, audio: 1, linkedMedia: 0, animations: false, missingFonts: [] },
      { number: 3, videos: 0, audio: 0, linkedMedia: 1, animations: false, missingFonts: [] }
    ],
    missingFonts: ['Отсутствующий шрифт'], fontsChecked: true, warnings: []
  } }),
  setControlPreviewFullscreen: (enabled) => ipcRenderer.invoke('set-control-preview-fullscreen', enabled),
  setChannelPreviewKeyboardGuard: (enabled) => ipcRenderer.invoke('set-channel-preview-keyboard-guard', enabled)
})
