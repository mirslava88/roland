import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  moveTimerOverlay: (dx: number, dy: number): void => {
    ipcRenderer.send('move-timer-overlay', Number(dx), Number(dy))
  },
  resizeTimerOverlay: (width: number, height: number): void => {
    ipcRenderer.send('resize-timer-overlay', Number(width), Number(height))
  }
})
