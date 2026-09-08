let livePreviewActive = false

export function isQrLivePreviewActive(): boolean {
  return livePreviewActive
}

export function setQrLivePreviewActive(active: boolean): void {
  livePreviewActive = active
}
