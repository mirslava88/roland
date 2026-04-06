/// <reference types="vite/client" />

interface FileEntry {
  id: string
  name: string
  path: string
  type: 'presentation' | 'pdf' | 'video' | 'unknown'
  extension: string
  size: number
}

interface DisplayInfo {
  id: number
  label: string
  isPrimary: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

interface Api {
  selectFolder(): Promise<string | null>
  loadFolder(folderPath: string): Promise<FileEntry[]>
  getDisplays(): Promise<DisplayInfo[]>
  openPresentationWindow(displayId?: number): Promise<void>
  closePresentationWindow(): Promise<void>
  checkPowerPoint(): Promise<boolean>
  launchPowerPoint(filePath: string, monitorIndex?: number): Promise<{ success: boolean; output?: string; error?: string }>
  powerpointCommand(command: string, arg?: number): Promise<{ success: boolean; output?: string; error?: string }>
  generatePptxThumbnails(filePath: string): Promise<{ success: boolean; thumbnails?: string[]; slideCount?: number; error?: string }>
  showOverlay(displayId?: number): Promise<void>
  hideOverlay(): Promise<void>
  sendToPresentation(channel: string, ...args: unknown[]): void
  sendToControl(channel: string, ...args: unknown[]): void
  on(channel: string, callback: (...args: unknown[]) => void): () => void
}

declare global {
  interface Window {
    api: Api
    electron: {
      process: {
        platform: string
      }
    }
  }
}
