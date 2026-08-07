import { useState, useEffect, useCallback, useRef } from 'react'
import { mediaUrl } from './media'
import { PdfViewer } from './components/PresentationView/PdfViewer'
import { VideoViewer } from './components/PresentationView/VideoViewer'
import {
  CaptureHub,
  type CaptureTakeRequest
} from './components/PresentationView/CaptureHub'
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
  const slotsRef = useRef(slots)
  const activeLayerRef = useRef<ActiveLayer>(activeLayer)
  const activeSlotRef = useRef<SlotIndex>(0)
  const activePayloadRef = useRef<ContentPayload | null>(null)
  const revisionRef = useRef(0)
  const pendingRef = useRef<PendingContent | null>(null)

  slotsRef.current = slots
  activeLayerRef.current = activeLayer

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
      {!hasVisibleContent && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-700 text-lg select-none">
          Waiting for content...
        </div>
      )}
    </div>
  )
}
