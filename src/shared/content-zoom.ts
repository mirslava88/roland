export interface ContentZoomState {
  enabled: boolean
  scale: number
  originX: number
  originY: number
}

export const DEFAULT_CONTENT_ZOOM: ContentZoomState = {
  enabled: false,
  scale: 1,
  originX: 0.5,
  originY: 0.5
}

export function normalizeContentZoom(value?: Partial<ContentZoomState> | null): ContentZoomState {
  const enabled = value?.enabled === true
  const scale = enabled && typeof value?.scale === 'number' && Number.isFinite(value.scale)
    ? Math.max(1, Math.min(3, value.scale))
    : 1
  const clampOrigin = (origin: unknown): number => typeof origin === 'number' && Number.isFinite(origin)
    ? Math.max(0, Math.min(1, origin))
    : 0.5
  return {
    enabled,
    scale,
    originX: clampOrigin(value?.originX),
    originY: clampOrigin(value?.originY)
  }
}
