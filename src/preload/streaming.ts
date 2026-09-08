import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('streamCapture', {
  onCommand: (listener: (id: number, command: string, data: unknown) => void) => {
    ipcRenderer.on('stream-command', (_event, id, command, data) => listener(id, command, data))
  },
  reply: (id: number, value: unknown, error?: string) => ipcRenderer.send('stream-reply', id, value, error),
  chunk: (bytes: ArrayBuffer, capturedAt: number): Promise<boolean> => ipcRenderer.invoke('stream-chunk', bytes, capturedAt),
  fail: (message: string) => ipcRenderer.send('stream-failed', message)
})
