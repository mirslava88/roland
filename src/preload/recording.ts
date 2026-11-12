import { contextBridge, ipcRenderer } from 'electron'

// The recording worker runs the same isolated PCM capture page as streaming,
// but receives separate commands and has a separate permission partition.
contextBridge.exposeInMainWorld('streamCapture', {
  onCommand: (listener: (id: number, command: string, data: unknown) => void) => {
    ipcRenderer.on('record-command', (_event, id, command, data) => listener(id, command, data))
  },
  reply: (id: number, value: unknown, error?: string) => ipcRenderer.send('record-reply', id, value, error),
  chunk: (bytes: ArrayBuffer, capturedAt: number): Promise<boolean> => ipcRenderer.invoke('record-chunk', bytes, capturedAt),
  fail: (message: string) => ipcRenderer.send('record-failed', message)
})
