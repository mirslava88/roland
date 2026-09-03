import { useState, useEffect, useCallback, useRef } from 'react'
import { flushSync } from 'react-dom'
import { mediaUrl } from './media'
import { PdfViewer } from './components/PresentationView/PdfViewer'
import { VideoViewer } from './components/PresentationView/VideoViewer'
import {
  CaptureHub,
  type CaptureTakeRequest
} from './components/PresentationView/CaptureHub'
import { BroadcastTitlesOverlay } from './components/BroadcastTitles/BroadcastTitlesOverlay'
import {
  captureSourceIdentity,
  type BroadcastTitleEffect,
  type BroadcastTitlePosition,
  type BroadcastTitleStyle,
  type BroadcastTitlesOutput
} from './stores/useAppStore'
import {
  cancelPdfLivePrewarmFile,
  cancelPdfLivePrewarmJobs,
  ensurePdfLiveCache,
  type PdfLivePrewarmRequest
} from './pdf-live-cache'
import { releasePdfiumResources } from './pdfium-renderer'
import {
  DEFAULT_PROGRAM_SCENE_LAYOUT,
  getProgramSceneRects,
  type ProgramSceneCornerStyle,
  type ProgramSceneParticipantSize,
  type ProgramScenePlacement
} from '../../shared/program-scene'
import {
  DEFAULT_CONTENT_ZOOM,
  normalizeContentZoom,
  type ContentZoomState
} from '../../shared/content-zoom'

interface ContentPayload {
  type: 'presentation' | 'pdf' | 'video' | 'capture' | 'backdrop' | 'other'
  path: string
  name: string
  startSlide?: number
  startTime?: number
  autoplay?: boolean
  isImage?: boolean
  capture?: CaptureSourceConfig
  captureAudioOnCommit?: boolean
  takeId?: string
}

interface ContentSlot {
  payload: ContentPayload | null
  revision: number
}

interface ProgramScenePayload {
  active: boolean
  capture: CaptureSourceConfig | null
  backdropPath: string | null
  placement: ProgramScenePlacement
  participantSize: ProgramSceneParticipantSize
  cornerStyle: ProgramSceneCornerStyle
  contentAspectRatio: number | null
}

const EMPTY_PROGRAM_SCENE: ProgramScenePayload = {
  active: false,
  capture: null,
  backdropPath: null,
  placement: DEFAULT_PROGRAM_SCENE_LAYOUT.placement,
  participantSize: DEFAULT_PROGRAM_SCENE_LAYOUT.participantSize,
  cornerStyle: DEFAULT_PROGRAM_SCENE_LAYOUT.cornerStyle,
  contentAspectRatio: null
}

type SlotIndex = 0 | 1
type ActiveLayer =
  | { kind: 'slot'; slot: SlotIndex }
  | { kind: 'capture'; sourceId: string }
type PendingContent =
  | { kind: 'slot'; slot: SlotIndex; revision: number; payload: ContentPayload }
  | { kind: 'capture'; sourceId: string; revision: number; payload: ContentPayload }

const HIDDEN_BROADCAST_TITLES: BroadcastTitlesOutput = {
  sourceIdentity: null,
  speakerRevision: 0,
  eventRevision: 0,
  speakerId: null,
  speakerName: '',
  speakerRole: '',
  eventLabel: 'МЕРОПРИЯТИЕ',
  eventInfo: '',
  speakerEnterEffect: 'slide-left',
  speakerExitEffect: 'slide-left',
  speakerAutoHideSeconds: 0,
  speakerStyle: 'rounded',
  speakerTextColor: '#ffffff',
  speakerBackgroundStart: '#070d18',
  speakerBackgroundEnd: '#0f222e',
  speakerAccentStart: '#3ee59b',
  speakerAccentEnd: '#24b8d8',
  eventEnterEffect: 'fade',
  eventExitEffect: 'fade',
  eventAutoHideSeconds: 0,
  eventPosition: 'top-right',
  eventStyle: 'rounded',
  eventTextColor: '#ffffff',
  eventBackgroundStart: '#070d18',
  eventBackgroundEnd: '#0d1b28',
  eventAccentStart: '#5be5b2',
  eventAccentEnd: '#24b8d8',
  speakerVisible: false,
  eventVisible: false
}

const BROADCAST_TITLE_EFFECTS: BroadcastTitleEffect[] = ['instant', 'fade', 'slide-left', 'slide-right', 'slide-up', 'scale']
const BROADCAST_TITLE_STYLES: BroadcastTitleStyle[] = ['rounded', 'rectangle', 'slant-right', 'slant-left', 'pill']
const BROADCAST_TITLE_POSITIONS: BroadcastTitlePosition[] = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right'
]

function normalizeBroadcastTitles(value: unknown): BroadcastTitlesOutput {
  const raw = value && typeof value === 'object'
    ? value as Partial<BroadcastTitlesOutput>
    : {}
  const effect = (candidate: unknown, fallback: BroadcastTitleEffect): BroadcastTitleEffect => (
    typeof candidate === 'string' && BROADCAST_TITLE_EFFECTS.includes(candidate as BroadcastTitleEffect)
      ? candidate as BroadcastTitleEffect
      : fallback
  )
  const style = (candidate: unknown, fallback: BroadcastTitleStyle): BroadcastTitleStyle => (
    candidate === 'cut-corner'
      ? 'slant-right'
      :
    typeof candidate === 'string' && BROADCAST_TITLE_STYLES.includes(candidate as BroadcastTitleStyle)
      ? candidate as BroadcastTitleStyle
      : fallback
  )
  const color = (candidate: unknown, fallback: string): string => (
    typeof candidate === 'string' && /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : fallback
  )
  return {
    sourceIdentity: typeof raw.sourceIdentity === 'string'
      ? raw.sourceIdentity.slice(0, 4096)
      : null,
    speakerRevision: typeof raw.speakerRevision === 'number' && Number.isFinite(raw.speakerRevision)
      ? Math.max(0, Math.round(raw.speakerRevision))
      : 0,
    eventRevision: typeof raw.eventRevision === 'number' && Number.isFinite(raw.eventRevision)
      ? Math.max(0, Math.round(raw.eventRevision))
      : 0,
    speakerId: typeof raw.speakerId === 'string' ? raw.speakerId.slice(0, 80) : null,
    speakerName: typeof raw.speakerName === 'string' ? raw.speakerName.slice(0, 120) : '',
    speakerRole: typeof raw.speakerRole === 'string' ? raw.speakerRole.slice(0, 180) : '',
    eventLabel: typeof raw.eventLabel === 'string'
      ? raw.eventLabel.replace(/[\r\n\t]+/g, ' ').slice(0, 80)
      : 'МЕРОПРИЯТИЕ',
    eventInfo: typeof raw.eventInfo === 'string' ? raw.eventInfo.replace(/\r/g, '').slice(0, 320) : '',
    speakerEnterEffect: effect(raw.speakerEnterEffect, 'slide-left'),
    speakerExitEffect: effect(raw.speakerExitEffect, 'slide-left'),
    speakerAutoHideSeconds: typeof raw.speakerAutoHideSeconds === 'number'
      ? Math.max(0, Math.min(86400, Math.round(raw.speakerAutoHideSeconds)))
      : 0,
    speakerStyle: style(raw.speakerStyle, 'rounded'),
    speakerTextColor: color(raw.speakerTextColor, '#ffffff'),
    speakerBackgroundStart: color(raw.speakerBackgroundStart, '#070d18'),
    speakerBackgroundEnd: color(raw.speakerBackgroundEnd, '#0f222e'),
    speakerAccentStart: color(raw.speakerAccentStart, '#3ee59b'),
    speakerAccentEnd: color(raw.speakerAccentEnd, '#24b8d8'),
    eventEnterEffect: effect(raw.eventEnterEffect, 'fade'),
    eventExitEffect: effect(raw.eventExitEffect, 'fade'),
    eventAutoHideSeconds: typeof raw.eventAutoHideSeconds === 'number'
      ? Math.max(0, Math.min(86400, Math.round(raw.eventAutoHideSeconds)))
      : 0,
    eventPosition: typeof raw.eventPosition === 'string' && BROADCAST_TITLE_POSITIONS.includes(raw.eventPosition as BroadcastTitlePosition)
      ? raw.eventPosition as BroadcastTitlePosition
      : 'top-right',
    eventStyle: style(raw.eventStyle, 'rounded'),
    eventTextColor: color(raw.eventTextColor, '#ffffff'),
    eventBackgroundStart: color(raw.eventBackgroundStart, '#070d18'),
    eventBackgroundEnd: color(raw.eventBackgroundEnd, '#0d1b28'),
    eventAccentStart: color(raw.eventAccentStart, '#5be5b2'),
    eventAccentEnd: color(raw.eventAccentEnd, '#24b8d8'),
    speakerVisible: raw.speakerVisible === true,
    eventVisible: raw.eventVisible === true
  }
}

function otherSlot(slot: SlotIndex): SlotIndex {
  return slot === 0 ? 1 : 0
}

export function PresentationApp(): JSX.Element {
  const [slots, setSlots] = useState<[ContentSlot, ContentSlot]>([
    { payload: null, revision: 0 },
    { payload: null, revision: 0 }
  ])
  const [activeLayer, setActiveLayer] = useState<ActiveLayer>({ kind: 'slot', slot: 0 })
  const [captureAudioSourceId, setCaptureAudioSourceId] = useState<string | null>(null)
  const [captureTakeRequest, setCaptureTakeRequest] = useState<CaptureTakeRequest | null>(null)
  const [broadcastTitles, setBroadcastTitles] = useState<BroadcastTitlesOutput>(HIDDEN_BROADCAST_TITLES)
  const [programScene, setProgramScene] = useState<ProgramScenePayload>(EMPTY_PROGRAM_SCENE)
  const [contentZoom, setContentZoom] = useState<ContentZoomState>(DEFAULT_CONTENT_ZOOM)
  const [activeContentSuspended, setActiveContentSuspended] = useState(false)
  const [slotAspectRatios, setSlotAspectRatios] = useState<[
    { revision: number; value: number | null },
    { revision: number; value: number | null }
  ]>([
    { revision: 0, value: null },
    { revision: 0, value: null }
  ])
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const broadcastTitlesRef = useRef(broadcastTitles)
  const slotsRef = useRef(slots)
  const activeLayerRef = useRef<ActiveLayer>(activeLayer)
  const activeSlotRef = useRef<SlotIndex>(0)
  const activePayloadRef = useRef<ContentPayload | null>(null)
  const revisionRef = useRef(0)
  const pendingRef = useRef<PendingContent | null>(null)
  const postCommitGenerationRef = useRef(0)

  slotsRef.current = slots
  activeLayerRef.current = activeLayer
  broadcastTitlesRef.current = broadcastTitles

  const notifyControlAfterPaint = useCallback((
    payload: ContentPayload,
    postCommitGeneration: number
  ): void => {
    requestAnimationFrame(() => {
      if (
        postCommitGeneration !== postCommitGenerationRef.current ||
        activePayloadRef.current !== payload
      ) {
        window.api.dbgLog(`PresApp: skipped stale painted ACK take=${payload.takeId ?? '-'}`)
        return
      }
      requestAnimationFrame(() => {
        if (
          postCommitGeneration !== postCommitGenerationRef.current ||
          activePayloadRef.current !== payload
        ) {
          window.api.dbgLog(`PresApp: skipped stale painted ACK take=${payload.takeId ?? '-'}`)
          return
        }
        window.api.dbgLog(`PresApp: sendToControl(presentation-content-ready) take=${payload.takeId ?? '-'}`)
        window.api.sendToControl('presentation-content-ready', {
          takeId: payload.takeId,
          type: payload.type,
          sourceId: payload.capture?.sourceId
        })
      })
    })
  }, [])

  const commitReadySlot = useCallback((slot: SlotIndex, revision: number): void => {
    const pending = pendingRef.current
    const current = slotsRef.current[slot]
    if (
      !pending ||
      pending.kind !== 'slot' ||
      pending.slot !== slot ||
      pending.revision !== revision ||
      current.revision !== revision
    ) {
      window.api.dbgLog(`PresApp: ignoring stale slot ready slot=${slot} revision=${revision}`)
      return
    }

    pendingRef.current = null
    const postCommitGeneration = ++postCommitGenerationRef.current
    const oldLayer = activeLayerRef.current
    activePayloadRef.current = pending.payload
    setCaptureAudioSourceId(null)
    activeSlotRef.current = slot
    if (pending.payload.type === 'backdrop') {
      cancelPdfLivePrewarmJobs()
      releasePdfiumResources()
      window.api.dbgLog('PresApp: idle backdrop committed; heavy PDF resources released')
    }
    if (oldLayer.kind === 'slot' && slot === oldLayer.slot) {
      // onReady means the target media frame exists. Mark the TAKE committed
      // synchronously so a controller timeout cannot issue a stale rollback in
      // the one-frame gap before the painted ACK below.
      window.api.sendToControl('presentation-content-committed', {
        takeId: pending.payload.takeId,
        type: pending.payload.type,
        sourceId: pending.payload.capture?.sourceId
      })
      notifyControlAfterPaint(pending.payload, postCommitGeneration)
      return
    }

    activeLayerRef.current = { kind: 'slot', slot }
    // Commit the opacity/z-index swap before publishing the committed marker.
    // This keeps the marker a true DOM transaction boundary rather than merely
    // an indication that React has queued the state update.
    flushSync(() => setActiveLayer({ kind: 'slot', slot }))
    window.api.sendToControl('presentation-content-committed', {
      takeId: pending.payload.takeId,
      type: pending.payload.type,
      sourceId: pending.payload.capture?.sourceId
    })
    window.api.dbgLog(
      `PresApp: atomic layer swap ${oldLayer.kind === 'slot' ? `slot-${oldLayer.slot}` : `capture-${oldLayer.sourceId.slice(-8)}`}->slot-${slot} revision=${revision}`
    )
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (
          postCommitGeneration !== postCommitGenerationRef.current ||
          activePayloadRef.current !== pending.payload ||
          activeLayerRef.current.kind !== 'slot' ||
          activeLayerRef.current.slot !== slot
        ) {
          window.api.dbgLog(`PresApp: skipped stale slot retirement/ACK revision=${revision}`)
          return
        }
        const retireSlot = oldLayer.kind === 'slot' ? oldLayer.slot : otherSlot(slot)
        if (retireSlot !== slot) {
          setSlots((previous) => {
            const next: [ContentSlot, ContentSlot] = [previous[0], previous[1]]
            next[retireSlot] = { payload: null, revision: previous[retireSlot].revision }
            return next
          })
          window.api.dbgLog(`PresApp: retired old slot=${retireSlot}`)
        }
        window.api.sendToControl('presentation-content-ready', {
          takeId: pending.payload.takeId,
          type: pending.payload.type,
          sourceId: pending.payload.capture?.sourceId
        })
      })
    })
  }, [notifyControlAfterPaint])

  const commitReadyCapture = useCallback((sourceId: string, revision: number): void => {
    const pending = pendingRef.current
    if (
      !pending ||
      pending.kind !== 'capture' ||
      pending.sourceId !== sourceId ||
      pending.revision !== revision
    ) {
      window.api.dbgLog(`PresApp: ignoring stale capture ready source=${sourceId.slice(-8)} revision=${revision}`)
      return
    }

    pendingRef.current = null
    const postCommitGeneration = ++postCommitGenerationRef.current
    setCaptureTakeRequest(null)
    const oldLayer = activeLayerRef.current
    activePayloadRef.current = pending.payload
    setCaptureAudioSourceId(pending.payload.captureAudioOnCommit === false ? null : sourceId)
    if (oldLayer.kind === 'capture' && oldLayer.sourceId === sourceId) {
      notifyControlAfterPaint(pending.payload, postCommitGeneration)
      return
    }

    // The picture switches before the control renderer receives the ready ACK.
    // Hide A's title synchronously when the next picture belongs to B.  Separate
    // PDM records of the same physical camera/window share one stable identity,
    // so their title stays continuous instead of being restarted unnecessarily.
    const nextTitleSourceIdentity = captureSourceIdentity(pending.payload.capture)
    if ((broadcastTitlesRef.current.sourceIdentity || null) !== nextTitleSourceIdentity) {
      const hiddenTitles = {
        ...HIDDEN_BROADCAST_TITLES,
        sourceIdentity: nextTitleSourceIdentity
      }
      broadcastTitlesRef.current = hiddenTitles
      setBroadcastTitles(hiddenTitles)
    }

    activeLayerRef.current = { kind: 'capture', sourceId }
    setActiveLayer({ kind: 'capture', sourceId })
    window.api.dbgLog(
      `PresApp: atomic layer swap ${oldLayer.kind === 'slot' ? `slot-${oldLayer.slot}` : `capture-${oldLayer.sourceId.slice(-8)}`}->capture-${sourceId.slice(-8)} revision=${revision}`
    )
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (
          postCommitGeneration !== postCommitGenerationRef.current ||
          activePayloadRef.current !== pending.payload ||
          activeLayerRef.current.kind !== 'capture' ||
          activeLayerRef.current.sourceId !== sourceId
        ) {
          window.api.dbgLog(`PresApp: skipped stale capture retirement/ACK revision=${revision}`)
          return
        }
        if (oldLayer.kind === 'slot') {
          setSlots((previous) => {
            const next: [ContentSlot, ContentSlot] = [previous[0], previous[1]]
            next[oldLayer.slot] = {
              payload: null,
              revision: previous[oldLayer.slot].revision
            }
            return next
          })
          window.api.dbgLog(`PresApp: retired old slot=${oldLayer.slot}; capture remains warm`)
        }
        window.api.sendToControl('presentation-content-ready', {
          takeId: pending.payload.takeId,
          type: pending.payload.type,
          sourceId
        })
      })
    })
  }, [notifyControlAfterPaint])

  const prepareCaptureTake = useCallback((sourceId: string, revision: number): void => {
    const pending = pendingRef.current
    if (
      !pending ||
      pending.kind !== 'capture' ||
      pending.sourceId !== sourceId ||
      pending.revision !== revision
    ) return
    setCaptureTakeRequest(null)
    if (!pending.payload.takeId) {
      commitReadyCapture(sourceId, revision)
      return
    }
    window.api.dbgLog(
      `PresApp: capture prepared source=${sourceId.slice(-8)} revision=${revision} take=${pending.payload.takeId}`
    )
    window.api.sendToControl('presentation-content-prepared', {
      takeId: pending.payload.takeId,
      type: 'capture',
      sourceId,
      revision
    })
  }, [commitReadyCapture])

  const failCaptureTake = useCallback((sourceId: string, revision: number, message: string): void => {
    const pending = pendingRef.current
    if (
      !pending ||
      pending.kind !== 'capture' ||
      pending.sourceId !== sourceId ||
      pending.revision !== revision
    ) return
    pendingRef.current = null
    setCaptureTakeRequest(null)
    window.api.dbgLog(`PresApp: capture take failed source=${sourceId.slice(-8)} error=${message}`)
    window.api.sendToControl('presentation-content-error', {
      type: 'capture',
      sourceId,
      revision,
      takeId: pending.payload.takeId,
      message
    })
  }, [])

  const loadContent = useCallback((payload: ContentPayload): void => {
    postCommitGenerationRef.current += 1
    const currentLayer = activeLayerRef.current
    const currentPayload = activePayloadRef.current
    const revision = ++revisionRef.current

    if (payload.type === 'capture') {
      const sourceId = payload.capture?.sourceId
      if (!sourceId) {
        window.api.sendToControl('presentation-content-error', {
          type: 'capture',
          revision,
          takeId: payload.takeId,
          message: 'У внешнего источника отсутствуют параметры подключения.'
        })
        return
      }
      pendingRef.current = { kind: 'capture', sourceId, revision, payload }
      setCaptureTakeRequest({ sourceId, revision })
      window.api.dbgLog(
        `PresApp: prepare capture source=${sourceId.slice(-8)} revision=${revision} ` +
        `current=${currentPayload?.type ?? 'none'}`
      )
      return
    }

    const currentSlot = activeSlotRef.current
    // Never replace the currently-painted slot before the next PDF/video/image
    // has produced a real ready frame.  Besides preventing a black transition,
    // this makes cancel-content-load transactional: a timeout can simply drop
    // the staging slot and the previous output is still mounted and visible.
    // The overlap lasts only until commitReadySlot retires the old slot.
    const hasPaintedSlotToPreserve =
      currentLayer.kind === 'slot' && currentPayload !== null
    const isBufferedElectronTransition = hasPaintedSlotToPreserve
    const targetSlot: SlotIndex = hasPaintedSlotToPreserve
      ? otherSlot(currentLayer.slot)
      : currentLayer.kind === 'slot'
        ? currentLayer.slot
        : currentSlot

    window.api.dbgLog(
      `PresApp: setContent type=${payload.type} path=${payload.path.split(/[\\/]/).pop()} ` +
      `startSlide=${payload.startSlide ?? '-'} slot=${targetSlot} buffered=${isBufferedElectronTransition}`
    )
    setCaptureTakeRequest(null)
    pendingRef.current = { kind: 'slot', slot: targetSlot, revision, payload }
    setSlots((previous) => {
      const next: [ContentSlot, ContentSlot] = [previous[0], previous[1]]
      next[targetSlot] = { payload, revision }
      return next
    })
  }, [])

  useEffect(() => {
    const unsubPdfPrewarm = window.api.on('prewarm-pdf', (...args: unknown[]) => {
      const raw = args[0] as Partial<PdfLivePrewarmRequest> | undefined
      if (
        !raw ||
        typeof raw.filePath !== 'string' ||
        typeof raw.cacheKey !== 'string' ||
        !Number.isFinite(raw.targetWidth) ||
        !Number.isFinite(raw.targetHeight)
      ) return

      const request: PdfLivePrewarmRequest = {
        filePath: raw.filePath,
        cacheKey: raw.cacheKey,
        targetWidth: Math.max(64, Math.round(raw.targetWidth as number)),
        targetHeight: Math.max(64, Math.round(raw.targetHeight as number)),
        anchorPage: Number.isFinite(raw.anchorPage)
          ? Math.max(1, Math.round(raw.anchorPage as number))
          : 1
      }
      window.api.sendToControl('pdf-channel-cache-status', {
        filePath: request.filePath,
        cacheKey: request.cacheKey,
        status: 'loading'
      })
      let completionSent = false
      const sendCompletion = (result: {
        success: boolean
        totalPages: number
        cachedPages: number
        error?: string
      }): void => {
        if (completionSent) return
        completionSent = true
        window.api.dbgLog(
          `PDF channel cache: SEND status=${result.success ? 'ready' : 'error'} ` +
          `cached=${result.cachedPages}/${result.totalPages} file=${request.filePath}`
        )
        window.api.sendToControl('pdf-channel-cache-status', {
          filePath: request.filePath,
          cacheKey: request.cacheKey,
          status: result.success ? 'ready' : 'error',
          totalPages: result.totalPages,
          cachedPages: result.cachedPages,
          error: result.error
        })
      }
      void ensurePdfLiveCache(request, (cachedPages, totalPages) => {
        // Notify the operator window from the rendering loop itself. PDF.js
        // promise cleanup has proved capable of delaying the outer `.then`,
        // while the exact-size frames are already fully prepared.
        if (totalPages > 0 && cachedPages >= totalPages) {
          sendCompletion({ success: true, totalPages, cachedPages })
        }
      }).then((result) => {
        sendCompletion(result)
      }).catch((error) => {
        sendCompletion({
          success: false,
          totalPages: 0,
          cachedPages: 0,
          error: String(error)
        })
      })
    })

    const unsubPdfRelease = window.api.on('release-prewarmed-pdf', (...args: unknown[]) => {
      const request = args[0] as { filePath?: string } | undefined
      if (!request?.filePath) return
      if (
        activePayloadRef.current?.type === 'pdf' &&
        activePayloadRef.current.path === request.filePath
      ) {
        window.api.dbgLog(`PDF channel cache: release deferred for live file=${request.filePath}`)
        return
      }
      cancelPdfLivePrewarmFile(request.filePath)
    })

    const unsubLoad = window.api.on('load-content', (...args: unknown[]) => {
      const payload = args[0] as ContentPayload
      window.api.dbgLog(`PresApp: load-content received type=${payload.type}`)
      loadContent(payload)
    })

    const unsubStop = window.api.on('stop', () => {
      // The video transport's Stop button means pause + rewind and must remain
      // replayable through Play. A true output close uses clear-active-content,
      // which unmounts VideoViewer and releases its decoder/src below.
      if (
        activePayloadRef.current?.type === 'video' ||
        activePayloadRef.current?.type === 'capture'
      ) return
      // For non-video output, do not leave a target staged behind the old
      // layer: a late onReady must not resurrect it after STOP.
      const layer = activeLayerRef.current
      if (layer.kind !== 'slot') return
      postCommitGenerationRef.current += 1
      pendingRef.current = null
      setCaptureTakeRequest(null)
      cancelPdfLivePrewarmJobs()
      releasePdfiumResources()
      activePayloadRef.current = null
      activeSlotRef.current = layer.slot
      setSlots((previous) => [
        { payload: null, revision: previous[0].revision },
        { payload: null, revision: previous[1].revision }
      ])
      window.api.dbgLog('PresApp: STOP cleared active and staged output; heavy resources released')
    })

    const unsubCaptureAudioLive = window.api.on('capture-audio-live', (...args: unknown[]) => {
      const sourceId = typeof args[0] === 'string' ? args[0] : null
      setCaptureAudioSourceId(sourceId)
      window.api.dbgLog(`PresApp: capture audio live source=${sourceId?.slice(-8) ?? 'none'}`)
    })

    const unsubCommit = window.api.on('commit-content-load', (...args: unknown[]) => {
      const request = args[0] as { takeId?: string }
      const pending = pendingRef.current
      if (
        !request?.takeId ||
        !pending ||
        pending.kind !== 'capture' ||
        pending.payload.takeId !== request.takeId
      ) return
      window.api.dbgLog(`PresApp: capture commit accepted take=${request.takeId}`)
      commitReadyCapture(pending.sourceId, pending.revision)
    })

    const unsubCancel = window.api.on('cancel-content-load', (...args: unknown[]) => {
      const request = args[0] as { takeId?: string }
      const pending = pendingRef.current
      if (!request?.takeId || !pending || pending.payload.takeId !== request.takeId) return
      postCommitGenerationRef.current += 1
      pendingRef.current = null
      setCaptureTakeRequest(null)
      if (pending.kind === 'slot') {
        setSlots((previous) => {
          if (previous[pending.slot].revision !== pending.revision) return previous
          const next: [ContentSlot, ContentSlot] = [previous[0], previous[1]]
          next[pending.slot] = { payload: null, revision: pending.revision }
          return next
        })
      }
      window.api.dbgLog(`PresApp: pending content cancelled take=${request.takeId}`)
    })

    const unsubSuspendActive = window.api.on('suspend-active-content', () => {
      setActiveContentSuspended(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.api.sendToControl('presentation-content-suspended')
        window.api.dbgLog('PresApp: active content suspended and painted for native takeover')
      }))
    })

    const unsubResumeActive = window.api.on('resume-active-content', () => {
      setActiveContentSuspended(false)
      window.api.dbgLog('PresApp: suspended active content restored after native takeover failure')
    })

    const unsubClearActive = window.api.on('clear-active-content', () => {
      postCommitGenerationRef.current += 1
      cancelPdfLivePrewarmJobs()
      releasePdfiumResources()
      pendingRef.current = null
      setCaptureTakeRequest(null)
      setCaptureAudioSourceId(null)
      activePayloadRef.current = null
      activeSlotRef.current = 0
      activeLayerRef.current = { kind: 'slot', slot: 0 }
      setActiveContentSuspended(false)
      setActiveLayer({ kind: 'slot', slot: 0 })
      setSlots((previous) => [
        { payload: null, revision: previous[0].revision },
        { payload: null, revision: previous[1].revision }
      ])
      // Notify the controller only after React has committed the empty slots
      // and Chromium has crossed a paint boundary. The transition cover can
      // then be removed without exposing one last frame of the old document
      // underneath a reduced PowerPoint window in the program scene.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.api.sendToControl('presentation-content-cleared')
        window.api.dbgLog('PresApp: active output cleared and painted; document/media resources released; capture sources remain warm')
      }))
    })

    window.api.signalReady()
    return () => {
      unsubPdfPrewarm()
      unsubPdfRelease()
      unsubLoad()
      unsubStop()
      unsubCaptureAudioLive()
      unsubCommit()
      unsubCancel()
      unsubSuspendActive()
      unsubResumeActive()
      unsubClearActive()
    }
  }, [commitReadyCapture, loadContent])

  useEffect(() => {
    const updateViewport = (): void => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.on('program-scene-update', (...args: unknown[]) => {
      const raw = args[0] as Partial<ProgramScenePayload> | undefined
      const capture = raw?.capture?.sourceId ? raw.capture : null
      setProgramScene({
        active: raw?.active === true && !!capture,
        capture,
        backdropPath: typeof raw?.backdropPath === 'string' ? raw.backdropPath : null,
        placement: typeof raw?.placement === 'string'
          ? raw.placement as ProgramScenePlacement
          : DEFAULT_PROGRAM_SCENE_LAYOUT.placement,
        participantSize: raw?.participantSize === 'small' ||
          raw?.participantSize === 'large' ||
          raw?.participantSize === 'half'
          ? raw.participantSize
          : 'medium',
        cornerStyle: raw?.cornerStyle === 'rounded' ? 'rounded' : 'sharp',
        contentAspectRatio: typeof raw?.contentAspectRatio === 'number' && Number.isFinite(raw.contentAspectRatio)
          ? raw.contentAspectRatio
          : null
      })
    })
    window.api.sendToControl('program-scene-ready')
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.on('content-zoom-update', (...args: unknown[]) => {
      setContentZoom(normalizeContentZoom(args[0] as Partial<ContentZoomState> | undefined))
    })
    window.api.sendToControl('content-zoom-ready')
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.on('broadcast-titles-update', (...args: unknown[]) => {
      const nextTitles = normalizeBroadcastTitles(args[0])
      broadcastTitlesRef.current = nextTitles
      setBroadcastTitles(nextTitles)
    })
    window.api.sendToControl('broadcast-titles-ready')
    return unsubscribe
  }, [])

  const reportSlotAspectRatio = (
    index: SlotIndex,
    revision: number,
    value: number
  ): void => {
    if (!Number.isFinite(value) || value < 0.2 || value > 5) return
    setSlotAspectRatios((previous) => {
      const current = previous[index]
      if (current.revision === revision && current.value !== null && Math.abs(current.value - value) < 0.0001) {
        return previous
      }
      const next = [...previous] as typeof previous
      next[index] = { revision, value }
      return next
    })
  }

  const renderSlot = (slot: ContentSlot, index: SlotIndex): JSX.Element | null => {
    const content = slot.payload
    if (!content) return null
    const onReady = (): void => commitReadySlot(index, slot.revision)

    if (content.type === 'pdf') {
      return (
        <PdfViewer
          filePath={content.path}
          startSlide={content.startSlide}
          requestId={slot.revision}
          onReady={onReady}
          transparentBackground={programScene.active}
          roundedContent={programScene.active && programScene.cornerStyle === 'rounded'}
          onAspectRatio={(value) => reportSlotAspectRatio(index, slot.revision, value)}
        />
      )
    }
    if (content.type === 'video') {
      return (
        <VideoViewer
          key={`video-${slot.revision}`}
          filePath={content.path}
          startTime={content.startTime}
          autoplay={content.autoplay}
          onReady={onReady}
          transparentBackground={programScene.active}
          roundedContent={programScene.active && programScene.cornerStyle === 'rounded'}
          onAspectRatio={(value) => reportSlotAspectRatio(index, slot.revision, value)}
        />
      )
    }
    if (content.type === 'backdrop') {
      return (
        <img
          src={mediaUrl(content.path)}
          alt="Backdrop"
          className="w-full h-full object-cover select-none"
          draggable={false}
          onLoad={onReady}
        />
      )
    }
    if (content.type === 'other' && content.isImage) {
      return (
        <img
          src={mediaUrl(content.path)}
          alt={content.name}
          className="max-w-full max-h-full w-auto h-auto object-contain select-none"
          style={{ borderRadius: programScene.active && programScene.cornerStyle === 'rounded' ? '1.25rem' : 0 }}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              reportSlotAspectRatio(index, slot.revision, image.naturalWidth / image.naturalHeight)
            }
            onReady()
          }}
        />
      )
    }
    if (content.type === 'presentation') {
      return (
        <div className="text-gray-500 text-center select-none">
          <p className="text-lg mb-2">PowerPoint Presentation Active</p>
          <p className="text-sm text-gray-600">{content.name}</p>
          <p className="text-xs text-gray-700 mt-2">Managed by native PowerPoint application</p>
        </div>
      )
    }
    return null
  }

  const activeCaptureId = activeLayer.kind === 'capture' ? activeLayer.sourceId : null
  const hasVisibleContent = activeLayer.kind === 'capture' || !!slots[activeLayer.slot].payload
  const sceneActive = programScene.active && activeLayer.kind !== 'capture'
  const activeSlotContent = activeLayer.kind === 'slot'
    ? slots[activeLayer.slot].payload
    : null
  const activeSlotAspect = activeLayer.kind === 'slot' &&
    slotAspectRatios[activeLayer.slot].revision === slots[activeLayer.slot].revision
    ? slotAspectRatios[activeLayer.slot].value
    : null
  // activeFile in the control window changes at TAKE start, while the old
  // Electron slot intentionally remains visible until the target is ready.
  // Keep that outgoing PDF/video/image on its own measured aspect instead of
  // prematurely applying the incoming PowerPoint ratio and visibly resizing
  // the old frame during the transition.
  const effectiveContentAspectRatio = activeSlotContent && activeSlotContent.type !== 'presentation'
    ? activeSlotAspect
    : programScene.contentAspectRatio ?? activeSlotAspect
  const sceneRects = getProgramSceneRects(viewport.width, viewport.height, {
    ...programScene,
    contentAspectRatio: effectiveContentAspectRatio
  })
  const contentStyle = sceneActive
    ? {
        left: sceneRects.content.x,
        top: sceneRects.content.y,
        width: sceneRects.content.width,
        height: sceneRects.content.height,
        borderRadius: '0.5rem'
      }
    : { inset: 0 }
  const participantStyle = {
    left: sceneRects.participant.x,
    top: sceneRects.participant.y,
    width: sceneRects.participant.width,
    height: sceneRects.participant.height
  }
  const sceneBorderRadius = programScene.cornerStyle === 'rounded' ? '1.25rem' : 0
  const zoomTransform = contentZoom.enabled && contentZoom.scale > 1
    ? `scale(${contentZoom.scale})`
    : undefined
  const zoomOrigin = `${contentZoom.originX * 100}% ${contentZoom.originY * 100}%`

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden">
      {sceneActive && programScene.backdropPath && (
        <img
          src={mediaUrl(programScene.backdropPath)}
          alt="Program backdrop"
          className="absolute inset-0 z-0 w-full h-full object-cover select-none"
          draggable={false}
        />
      )}
      {slots.map((slot, index) => {
        const isActive = activeLayer.kind === 'slot' && activeLayer.slot === index
        return (
          <div
            key={index}
            className={`absolute overflow-hidden shadow-2xl ${sceneActive ? 'bg-transparent' : 'bg-black'}`}
            style={{
              ...contentStyle,
              opacity: isActive && !activeContentSuspended ? 1 : 0,
              zIndex: isActive ? 1 : 0,
              pointerEvents: isActive ? 'auto' : 'none',
              borderRadius: sceneActive ? sceneBorderRadius : 0
            }}
          >
            <div
              className="flex h-full w-full items-center justify-center"
              style={{
                transform: isActive ? zoomTransform : undefined,
                transformOrigin: zoomOrigin
              }}
            >
              {renderSlot(slot, index as SlotIndex)}
            </div>
          </div>
        )
      })}
      <CaptureHub
        activeSourceId={activeCaptureId}
        audioSourceId={captureAudioSourceId}
        sceneSourceId={sceneActive ? programScene.capture?.sourceId ?? null : null}
        sceneStyle={{ ...participantStyle, borderRadius: sceneBorderRadius }}
        takeRequest={captureTakeRequest}
        onTakeReady={prepareCaptureTake}
        onTakeError={failCaptureTake}
      />
      {activeLayer.kind === 'capture' && (
        <BroadcastTitlesOverlay
          key={broadcastTitles.sourceIdentity || 'no-program-title-source'}
          titles={broadcastTitles}
        />
      )}
      {sceneActive && (
        <div
          className="absolute overflow-hidden pointer-events-none"
          style={{
            ...participantStyle,
            zIndex: 4,
            borderRadius: sceneBorderRadius
          }}
        >
          <BroadcastTitlesOverlay
            key={broadcastTitles.sourceIdentity || 'no-program-scene-title-source'}
            titles={broadcastTitles}
          />
        </div>
      )}
      {!hasVisibleContent && !sceneActive && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-700 text-lg select-none">
          Waiting for content...
        </div>
      )}
    </div>
  )
}
