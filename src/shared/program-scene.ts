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
  placement: ProgramScenePlacement
  participantSize: ProgramSceneParticipantSize
  participantScale: number
  cornerStyle: ProgramSceneCornerStyle
  viewMode?: ProgramSceneViewMode
  transitionEffect?: ProgramSceneTransitionEffect
  transitionDurationMs?: number
  contentAspectRatio?: number | null
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
  placement: 'right-center',
  participantSize: 'medium',
  participantScale: 1,
  cornerStyle: 'sharp',
  viewMode: 'both',
  transitionEffect: 'smooth',
  transitionDurationMs: PROGRAM_SCENE_TRANSITION_DURATION_MS
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
