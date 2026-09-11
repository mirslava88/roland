export type ProgramScenePlacement =
  | 'right-top'
  | 'right-center'
  | 'right-bottom'
  | 'left-top'
  | 'left-center'
  | 'left-bottom'

export type ProgramSceneParticipantSize = 'small' | 'medium' | 'large' | 'half'
export type ProgramSceneCornerStyle = 'sharp' | 'rounded'
export type ProgramSceneViewMode = 'participant' | 'content' | 'both'
export type ProgramSceneTransitionEffect = 'smooth' | 'zoom-fade' | 'instant'
export type ProgramSceneBackgroundKind = 'image' | 'video' | 'channel'

export interface ProgramSceneBackgroundConfig {
  kind: ProgramSceneBackgroundKind
  videoPath: string | null
  channelId: string | null
  loop: boolean
  muted: boolean
}

export const DEFAULT_PROGRAM_SCENE_BACKGROUND: ProgramSceneBackgroundConfig = {
  kind: 'image',
  videoPath: null,
  channelId: null,
  loop: true,
  muted: true
}

export interface ProgramSceneChromaKeyConfig {
  enabled: boolean
  color: string
  tolerance: number
  softness: number
  spill: number
}

export const DEFAULT_PROGRAM_SCENE_CHROMA_KEY: ProgramSceneChromaKeyConfig = {
  enabled: false,
  color: '#00b140',
  tolerance: 32,
  softness: 18,
  spill: 55
}

export type ProgramSceneTextFontFamily =
  | 'arial'
  | 'verdana'
  | 'georgia'
  | 'times'
  | 'impact'
  | 'courier'

export interface ProgramSceneTextOverlay {
  id: string
  text: string
  visible: boolean
  xPercent: number
  yPercent: number
  widthPercent: number
  fontFamily: ProgramSceneTextFontFamily
  fontSizePercent: number
  color: string
}

export type ProgramSceneMediaLayerKind = 'image' | 'video'

export interface ProgramSceneMediaLayer {
  id: string
  kind: ProgramSceneMediaLayerKind
  path: string
  name: string
  xPercent: number
  yPercent: number
  widthPercent: number
  aspectRatio: number
  aboveContent: boolean
  visible: boolean
  loop: boolean
  muted: boolean
}

export const PROGRAM_SCENE_TEXT_FONT_FAMILIES: Record<ProgramSceneTextFontFamily, string> = {
  arial: 'Arial, sans-serif',
  verdana: 'Verdana, sans-serif',
  georgia: 'Georgia, serif',
  times: '"Times New Roman", serif',
  impact: 'Impact, Haettenschweiler, sans-serif',
  courier: '"Courier New", monospace'
}

const PROGRAM_SCENE_TEXT_FONTS = new Set<ProgramSceneTextFontFamily>(
  Object.keys(PROGRAM_SCENE_TEXT_FONT_FAMILIES) as ProgramSceneTextFontFamily[]
)

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.round(numeric * 100) / 100))
}

export function normalizeProgramSceneChromaKey(value: unknown): ProgramSceneChromaKeyConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    enabled: raw.enabled === true,
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)
      ? raw.color.toLowerCase()
      : DEFAULT_PROGRAM_SCENE_CHROMA_KEY.color,
    tolerance: clampNumber(raw.tolerance, DEFAULT_PROGRAM_SCENE_CHROMA_KEY.tolerance, 0, 100),
    softness: clampNumber(raw.softness, DEFAULT_PROGRAM_SCENE_CHROMA_KEY.softness, 0, 100),
    spill: clampNumber(raw.spill, DEFAULT_PROGRAM_SCENE_CHROMA_KEY.spill, 0, 100)
  }
}

export function normalizeProgramSceneBackground(value: unknown): ProgramSceneBackgroundConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const kind: ProgramSceneBackgroundKind = raw.kind === 'video' || raw.kind === 'channel'
    ? raw.kind
    : 'image'
  return {
    kind,
    videoPath: typeof raw.videoPath === 'string' && raw.videoPath.trim()
      ? raw.videoPath
      : null,
    channelId: typeof raw.channelId === 'string' && raw.channelId.trim()
      ? raw.channelId
      : null,
    loop: raw.loop !== false,
    muted: raw.muted !== false
  }
}

export function normalizeProgramSceneTextOverlays(value: unknown): ProgramSceneTextOverlay[] {
  if (!Array.isArray(value)) return []
  const usedIds = new Set<string>()
  return value.map((entry, index) => {
    const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const baseId = typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim().slice(0, 128)
      : `text-${index + 1}`
    let id = baseId
    let suffix = 2
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`
    usedIds.add(id)
    const widthPercent = clampNumber(raw.widthPercent, 34, 5, 100)
    const fontFamily = PROGRAM_SCENE_TEXT_FONTS.has(raw.fontFamily as ProgramSceneTextFontFamily)
      ? raw.fontFamily as ProgramSceneTextFontFamily
      : 'arial'
    return {
      id,
      text: typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').slice(0, 20_000) : '',
      visible: raw.visible !== false,
      xPercent: clampNumber(raw.xPercent, 10, 0, Math.max(0, 100 - widthPercent)),
      yPercent: clampNumber(raw.yPercent, 10, 0, 100),
      widthPercent,
      fontFamily,
      // 1–10% of the program height is presented to the operator as a
      // convenient 10–100% text scale.
      fontSizePercent: clampNumber(raw.fontSizePercent, 4, 1, 10),
      color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)
        ? raw.color
        : '#ffffff'
    }
  })
}

export function normalizeProgramSceneMediaLayers(value: unknown): ProgramSceneMediaLayer[] {
  if (!Array.isArray(value)) return []
  const usedIds = new Set<string>()
  return value.slice(0, 100).flatMap((entry, index) => {
    const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const path = typeof raw.path === 'string' ? raw.path.trim().slice(0, 32_768) : ''
    if (!path) return []
    const baseId = typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim().slice(0, 128)
      : `media-${index + 1}`
    let id = baseId
    let suffix = 2
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`
    usedIds.add(id)
    return [{
      id,
      kind: raw.kind === 'video' ? 'video' as const : 'image' as const,
      path,
      name: typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim().slice(0, 256)
        : path.replace(/\\/g, '/').split('/').pop() || `Слой ${index + 1}`,
      xPercent: clampNumber(raw.xPercent, 50, 0, 100),
      yPercent: clampNumber(raw.yPercent, 50, 0, 100),
      widthPercent: clampNumber(raw.widthPercent, 38, 5, 100),
      aspectRatio: clampNumber(raw.aspectRatio, 16 / 9, 0.1, 10),
      aboveContent: raw.aboveContent !== false,
      visible: raw.visible !== false,
      loop: raw.loop !== false,
      muted: raw.muted !== false
    }]
  })
}

export const PROGRAM_SCENE_TRANSITION_DURATION_MS = 650
export const PROGRAM_SCENE_PARTICIPANT_SCALE_MIN = 1
export const PROGRAM_SCENE_PARTICIPANT_SCALE_MAX = 2.5

export function normalizeProgramSceneParticipantScale(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.max(
    PROGRAM_SCENE_PARTICIPANT_SCALE_MIN,
    Math.min(PROGRAM_SCENE_PARTICIPANT_SCALE_MAX, Math.round(numeric * 100) / 100)
  )
}

export interface ProgramSceneLayoutConfig {
  enabled: boolean
  background?: ProgramSceneBackgroundConfig
  placement: ProgramScenePlacement
  participantSize: ProgramSceneParticipantSize
  participantScale: number
  cornerStyle: ProgramSceneCornerStyle
  viewMode?: ProgramSceneViewMode
  transitionEffect?: ProgramSceneTransitionEffect
  transitionDurationMs?: number
  contentAspectRatio?: number | null
  textOverlays?: ProgramSceneTextOverlay[]
  textOverlaysVisible?: boolean
  mediaLayers?: ProgramSceneMediaLayer[]
  mediaLayersVisible?: boolean
  chromaKey?: ProgramSceneChromaKeyConfig
}

export interface ProgramSceneRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ProgramSceneRects {
  content: ProgramSceneRect
  participant: ProgramSceneRect
}

export const DEFAULT_PROGRAM_SCENE_LAYOUT: ProgramSceneLayoutConfig = {
  enabled: false,
  background: { ...DEFAULT_PROGRAM_SCENE_BACKGROUND },
  placement: 'right-center',
  participantSize: 'medium',
  participantScale: 1,
  cornerStyle: 'sharp',
  viewMode: 'both',
  transitionEffect: 'smooth',
  transitionDurationMs: PROGRAM_SCENE_TRANSITION_DURATION_MS,
  textOverlays: [],
  textOverlaysVisible: true,
  mediaLayers: [],
  mediaLayersVisible: false,
  chromaKey: { ...DEFAULT_PROGRAM_SCENE_CHROMA_KEY }
}

const PARTICIPANT_WIDTH: Record<ProgramSceneParticipantSize, number> = {
  small: 0.2,
  medium: 0.26,
  large: 0.33,
  half: 0.5
}

/**
 * Builds two independent panes inside the program canvas. The participant
 * starts at 16:9 and can grow vertically into a portrait crop while keeping
 * its width. Presentation content uses its real aspect ratio when known. The
 * full canvas remains uncovered around them so the backdrop stays visible.
 */
export function getProgramSceneRects(
  width: number,
  height: number,
  config: Pick<ProgramSceneLayoutConfig, 'placement' | 'participantSize' | 'participantScale' | 'viewMode' | 'contentAspectRatio'>
): ProgramSceneRects {
  const participantSize = config.participantSize in PARTICIPANT_WIDTH
    ? config.participantSize
    : DEFAULT_PROGRAM_SCENE_LAYOUT.participantSize
  const placement = [
    'right-top', 'right-center', 'right-bottom',
    'left-top', 'left-center', 'left-bottom'
  ].includes(config.placement)
    ? config.placement
    : DEFAULT_PROGRAM_SCENE_LAYOUT.placement
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const marginX = Math.round(safeWidth * 0.035)
  const marginY = Math.round(safeHeight * 0.06)
  const gap = Math.round(safeWidth * 0.025)
  const availableWidth = safeWidth - marginX * 2 - gap
  const baseParticipantWidth = participantSize === 'half'
    ? Math.round(availableWidth / 2)
    : Math.round(safeWidth * PARTICIPANT_WIDTH[participantSize])
  const participantScale = normalizeProgramSceneParticipantScale(config.participantScale)
  const maxParticipantHeight = safeHeight - marginY * 2
  const participantWidth = baseParticipantWidth
  const participantHeight = Math.min(
    maxParticipantHeight,
    Math.round(participantWidth * 9 / 16 * participantScale)
  )
  const contentAreaWidth = safeWidth - marginX * 2 - gap - participantWidth
  const contentAreaHeight = safeHeight - marginY * 2
  const contentAspectRatio = typeof config.contentAspectRatio === 'number' &&
    Number.isFinite(config.contentAspectRatio) &&
    config.contentAspectRatio >= 0.2 &&
    config.contentAspectRatio <= 5
    ? config.contentAspectRatio
    : 16 / 9
  const contentWidth = Math.min(contentAreaWidth, Math.round(contentAreaHeight * contentAspectRatio))
  const contentHeight = Math.min(contentAreaHeight, Math.round(contentWidth / contentAspectRatio))
  const participantOnLeft = placement.startsWith('left-')
  const contentAreaX = participantOnLeft
    ? marginX + participantWidth + gap
    : marginX
  const contentX = contentAreaX + Math.round((contentAreaWidth - contentWidth) / 2)
  const participantX = participantOnLeft
    ? marginX
    : safeWidth - marginX - participantWidth
  const contentY = Math.round((safeHeight - contentHeight) / 2)
  const verticalPlacement = placement.split('-')[1]
  const participantY = verticalPlacement === 'top'
    ? marginY
    : verticalPlacement === 'bottom'
      ? safeHeight - marginY - participantHeight
      : Math.round((safeHeight - participantHeight) / 2)

  const content = { x: contentX, y: contentY, width: contentWidth, height: contentHeight }
  const participant = {
      x: participantX,
      y: participantY,
      width: participantWidth,
      height: participantHeight
  }
  return {
    content: config.viewMode === 'content'
      ? { x: 0, y: 0, width: safeWidth, height: safeHeight }
      : content,
    participant: config.viewMode === 'participant'
      ? { x: 0, y: 0, width: safeWidth, height: safeHeight }
      : participant
  }
}
