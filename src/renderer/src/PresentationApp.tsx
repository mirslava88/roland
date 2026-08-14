import { useState, useEffect, useCallback, useRef } from 'react'
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
  ensurePdfLiveCache,
  type PdfLivePrewarmRequest
} from './pdf-live-cache'

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
  const broadcastTitlesRef = useRef(broadcastTitles)
  const slotsRef = useRef(slots)
  const activeLayerRef = useRef<ActiveLayer>(activeLayer)
  const activeSlotRef = useRef<SlotIndex>(0)
  const activePayloadRef = useRef<ContentPayload | null>(null)
  const revisionRef = useRef(0)
  const pendingRef = useRef<PendingContent | null>(null)

  slotsRef.current = slots
  activeLayerRef.current = activeLayer
  broadcastTitlesRef.current = broadcastTitles

  const notifyControlAfterPaint = useCallback((payload: ContentPayload): void => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
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
    const oldLayer = activeLayerRef.current
    activePayloadRef.current = pending.payload
    setCaptureAudioSourceId(null)
    activeSlotRef.current = slot
    if (oldLayer.kind === 'slot' && slot === oldLayer.slot) {
      notifyControlAfterPaint(pending.payload)
      return
    }

    activeLayerRef.current = { kind: 'slot', slot }
    setActiveLayer({ kind: 'slot', slot })
    window.api.dbgLog(
      `PresApp: atomic layer swap ${oldLayer.kind === 'slot' ? `slot-${oldLayer.slot}` : `capture-${oldLayer.sourceId.slice(-8)}`}->slot-${slot} revision=${revision}`
    )
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
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
    setCaptureTakeRequest(null)
    const oldLayer = activeLayerRef.current
    activePayloadRef.current = pending.payload
    setCaptureAudioSourceId(pending.payload.captureAudioOnCommit === false ? null : sourceId)
    if (oldLayer.kind === 'capture' && oldLayer.sourceId === sourceId) {
      notifyControlAfterPaint(pending.payload)
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
    const currentIsElectronLive =
      currentPayload !== null &&
      (currentPayload.type === 'pdf' || currentPayload.type === 'video' || currentPayload.type === 'capture')
    const targetIsElectronLive = payload.type === 'pdf' || payload.type === 'video'
    const isBufferedElectronTransition =
      currentIsElectronLive &&
      targetIsElectronLive &&
      (
        currentPayload?.type === 'video' ||
        currentPayload?.type === 'capture' ||
        payload.type === 'video'
      )
    const targetSlot: SlotIndex = isBufferedElectronTransition
      ? otherSlot(currentSlot)
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

    const unsubLoad = window.api.on('load-content', (...args: unknown[]) => {
      const payload = args[0] as ContentPayload
      window.api.dbgLog(`PresApp: load-content received type=${payload.type}`)
      loadContent(payload)
    })

    const unsubStop = window.api.on('stop', () => {
      if (activePayloadRef.current?.type === 'video' || activePayloadRef.current?.type === 'capture') return
      const layer = activeLayerRef.current
      if (layer.kind !== 'slot') return
      activePayloadRef.current = null
      setSlots((previous) => {
        const next: [ContentSlot, ContentSlot] = [previous[0], previous[1]]
        next[layer.slot] = { payload: null, revision: previous[layer.slot].revision }
        return next
      })
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

    const unsubClearActive = window.api.on('clear-active-content', () => {
      pendingRef.current = null
      setCaptureTakeRequest(null)
      setCaptureAudioSourceId(null)
      activePayloadRef.current = null
      activeSlotRef.current = 0
      activeLayerRef.current = { kind: 'slot', slot: 0 }
      setActiveLayer({ kind: 'slot', slot: 0 })
      setSlots((previous) => [
        { payload: null, revision: previous[0].revision },
        { payload: null, revision: previous[1].revision }
      ])
      window.api.sendToControl('presentation-content-cleared')
      window.api.dbgLog('PresApp: active output cleared; capture sources remain warm')
    })

    window.api.signalReady()
    return () => {
      unsubPdfPrewarm()
      unsubLoad()
      unsubStop()
      unsubCaptureAudioLive()
      unsubCommit()
      unsubCancel()
      unsubClearActive()
    }
  }, [commitReadyCapture, loadContent])

  useEffect(() => {
    const unsubscribe = window.api.on('broadcast-titles-update', (...args: unknown[]) => {
      const nextTitles = normalizeBroadcastTitles(args[0])
      broadcastTitlesRef.current = nextTitles
      setBroadcastTitles(nextTitles)
    })
    window.api.sendToControl('broadcast-titles-ready')
    return unsubscribe
  }, [])

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
          className="w-full h-full object-contain select-none"
          draggable={false}
          onLoad={onReady}
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

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden">
      {slots.map((slot, index) => {
        const isActive = activeLayer.kind === 'slot' && activeLayer.slot === index
        return (
          <div
            key={index}
            className="absolute inset-0 flex items-center justify-center bg-black"
            style={{
              opacity: isActive ? 1 : 0,
              zIndex: isActive ? 1 : 0,
              pointerEvents: isActive ? 'auto' : 'none'
            }}
          >
            {renderSlot(slot, index as SlotIndex)}
          </div>
        )
      })}
      <CaptureHub
        activeSourceId={activeCaptureId}
        audioSourceId={captureAudioSourceId}
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
      {!hasVisibleContent && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-700 text-lg select-none">
          Waiting for content...
        </div>
      )}
    </div>
  )
}
