/// <reference types="vite/client" />

interface FileEntry {
  id: string
  name: string
  path: string
  type: 'presentation' | 'pdf' | 'video' | 'other' | 'unknown'
  extension: string
  size: number
  isImage?: boolean
  isAudio?: boolean
}

interface DisplayInfo {
  id: number
  label: string
  isPrimary: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

interface MusicState {
  playing: boolean
  currentIndex: number
  currentTime: number
  duration: number
  volume: number
  loopTrack: boolean
  loopPlaylist: boolean
  trackName: string
  playlistLength: number
}

interface Api {
  selectFolder(): Promise<string | null>
  loadFolder(folderPath: string): Promise<{ files: FileEntry[]; subfolders: { name: string; path: string }[] }>
  getDisplays(): Promise<DisplayInfo[]>
  openPresentationWindow(displayId?: number): Promise<void>
  closePresentationWindow(): Promise<void>
  checkPowerPoint(): Promise<boolean>
  launchPowerPoint(filePath: string, monitorIndex?: number): Promise<{ success: boolean; output?: string; error?: string }>
  powerpointCommand(command: string, arg?: number): Promise<{ success: boolean; output?: string; error?: string }>
  generatePptxThumbnails(filePath: string): Promise<{ success: boolean; thumbnails?: string[]; slideCount?: number; error?: string }>
  readFile(filePath: string): Promise<ArrayBuffer>
  showOverlay(displayId?: number): Promise<void>
  hideOverlay(): Promise<void>
  selectBackdropImage(): Promise<string | null>
  switchAudioToExternal(): Promise<{ success: boolean; device?: string; error?: string }>
  restoreAudioDevice(): Promise<void>
  toggleGlobalHook(enable: boolean): Promise<boolean>
  selectSoundFile(): Promise<string | null>
  moveFile(srcPath: string, destFolder: string): Promise<{ success: boolean; newPath?: string; error?: string }>
  generateDocPreview(filePath: string): Promise<{ success: boolean; pdfPath?: string; error?: string }>
  showTimerOverlay(displayId?: number): Promise<void>
  hideTimerOverlay(): Promise<void>
  updateTimerOverlay(data: {
    remaining: number
    running: boolean
    duration: number
    posX: number
    posY: number
    scale: number
  }): void
  playTimerSound(type: string, filePath: string): void
  moveTimerOverlay(dx: number, dy: number): void
  resizeTimerOverlay(w: number, h: number): void
  selectMusicFiles(): Promise<string[] | null>
  selectMusicFolder(): Promise<string[] | null>
  musicSetPlaylist(files: string[], startIndex?: number): Promise<void>
  musicPlay(): Promise<void>
  musicPause(): Promise<void>
  musicStop(): Promise<void>
  musicNext(): Promise<void>
  musicPrev(): Promise<void>
  musicSetLoopTrack(value: boolean): Promise<void>
  musicSetLoopPlaylist(value: boolean): Promise<void>
  musicSetVolume(value: number): Promise<void>
  musicSeek(time: number): Promise<void>
  musicGetState(): Promise<MusicState | null>
  openFileExternal(filePath: string, displayBounds?: { x: number; y: number; width: number; height: number }): Promise<{ success: boolean; error?: string }>
  closeExternalFile(filePath?: string): Promise<void>
  minimizeExternalFile(filePath?: string): Promise<void>
  restoreExternalFile(filePath?: string, displayBounds?: { x: number; y: number; width: number; height: number }): Promise<void>
  setActiveContentType(type: string): void
  sendToPresentation(channel: string, ...args: unknown[]): void
  sendToControl(channel: string, ...args: unknown[]): void
  signalReady(): void
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
