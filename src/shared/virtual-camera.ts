export type VirtualCameraPhase = 'idle' | 'installing' | 'starting' | 'running' | 'error'
export type VirtualCameraSource = 'internal' | 'display' | null

export interface VirtualCameraStatus {
  phase: VirtualCameraPhase
  supported: boolean
  installed: boolean
  available: boolean
  source: VirtualCameraSource
  error: string | null
  name: string
  width: 1920
  height: 1080
  fps: 30
  startedAt: number | null
}

export interface VirtualCameraApi {
  status(): Promise<VirtualCameraStatus>
  install(): Promise<VirtualCameraStatus>
  start(displayId: number | null): Promise<VirtualCameraStatus>
  stop(): Promise<VirtualCameraStatus>
}
