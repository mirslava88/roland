import { screen, type Display, type Rectangle } from 'electron'
import { getProgramSceneRects, type ProgramSceneLayoutConfig } from '../shared/program-scene'
import {
  DEFAULT_CONTENT_ZOOM,
  normalizeContentZoom,
  type ContentZoomState
} from '../shared/content-zoom'

let activePowerPointSceneLayout: ProgramSceneLayoutConfig | null = null
let activePowerPointZoom: ContentZoomState = { ...DEFAULT_CONTENT_ZOOM }

export function getActivePowerPointSceneLayout(): ProgramSceneLayoutConfig | null {
  return activePowerPointSceneLayout
}

export function setActivePowerPointSceneLayout(layout: ProgramSceneLayoutConfig | null): void {
  activePowerPointSceneLayout = layout?.enabled ? { ...layout } : null
}

export function getActivePowerPointZoom(): ContentZoomState {
  return activePowerPointZoom
}

export function setActivePowerPointZoom(zoom: Partial<ContentZoomState> | null): ContentZoomState {
  activePowerPointZoom = normalizeContentZoom(zoom)
  return activePowerPointZoom
}

export interface PowerPointNativePlacement {
  bounds: Rectangle
  clipBounds: Rectangle | null
  cornerRadius: number
}

export function getPowerPointNativePlacement(
  display: Display,
  sceneLayout: ProgramSceneLayoutConfig | null | undefined = activePowerPointSceneLayout,
  zoom: ContentZoomState = activePowerPointZoom
): PowerPointNativePlacement {
  const baseDip = sceneLayout?.enabled
    ? (() => {
        const { content } = getProgramSceneRects(display.bounds.width, display.bounds.height, sceneLayout)
        return {
          x: display.bounds.x + content.x,
          y: display.bounds.y + content.y,
          width: content.width,
          height: content.height
        }
      })()
    : display.bounds
  const base = screen.dipToScreenRect(null, baseDip)
  const normalized = normalizeContentZoom(zoom)
  const scale = normalized.enabled ? normalized.scale : 1
  const width = Math.max(1, Math.round(base.width * scale))
  const height = Math.max(1, Math.round(base.height * scale))
  const bounds = {
    x: Math.round(base.x - (width - base.width) * normalized.originX),
    y: Math.round(base.y - (height - base.height) * normalized.originY),
    width,
    height
  }
  const rounded = sceneLayout?.enabled && sceneLayout.cornerStyle === 'rounded'
  return {
    bounds,
    clipBounds: scale > 1 || rounded ? base : null,
    cornerRadius: rounded ? Math.max(12, Math.round(22 * display.scaleFactor)) : 0
  }
}
