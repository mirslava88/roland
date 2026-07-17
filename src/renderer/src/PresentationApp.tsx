import { useState, useEffect, useCallback, useRef } from 'react'
import { mediaUrl } from './media'
import { PdfViewer } from './components/PresentationView/PdfViewer'
import { VideoViewer } from './components/PresentationView/VideoViewer'

interface ContentPayload {
  type: 'presentation' | 'pdf' | 'video' | 'backdrop' | 'other'
  path: string
  name: string
  startSlide?: number
  startTime?: number
  autoplay?: boolean
  isImage?: boolean
}

interface ContentSlot {
  payload: ContentPayload | null
  revision: number
}

type SlotIndex = 0 | 1

export function PresentationApp(): JSX.Element {
  const [slots, setSlots] = useState<[ContentSlot, ContentSlot]>([
    { payload: null, revision: 0 },
    { payload: null, revision: 0 }
  ])
  const [activeSlot, setActiveSlot] = useState<SlotIndex>(0)
  const slotsRef = useRef(slots)
  const activeSlotRef = useRef<SlotIndex>(activeSlot)
  const contentRef = useRef<ContentPayload | null>(null)
  const revisionRef = useRef(0)
  const pendingRef = useRef<{ slot: SlotIndex; revision: number } | null>(null)

  slotsRef.current = slots
  activeSlotRef.current = activeSlot
  contentRef.current = slots[activeSlot].payload

  const notifyControlAfterPaint = useCallback((): void => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.api.dbgLog('PresApp: sendToControl(presentation-content-ready)')
        window.api.sendToControl('presentation-content-ready')
      })
    })
  }, [])

  const commitReadySlot = useCallback((slot: SlotIndex, revision: number): void => {
    const pending = pendingRef.current
    const current = slotsRef.current[slot]
    if (
      !pending ||
      pending.slot !== slot ||
      pending.revision !== revision ||
      current.revision !== revision
    ) {
      window.api.dbgLog(`PresApp: ignoring stale ready slot=${slot} revision=${revision}`)
      return
    }

    pendingRef.current = null
    const oldSlot = activeSlotRef.current
    if (slot === oldSlot) {
      notifyControlAfterPaint()
      return
    }

    // Both layers are already fully painted in the same Chromium surface.
    // One React commit flips their opacity, so DWM sees one window and one
    // content boundary instead of an overlay/fullscreen HWND race.
    activeSlotRef.current = slot
    setActiveSlot(slot)
    window.api.dbgLog(`PresApp: atomic slot swap ${oldSlot}->${slot} revision=${revision}`)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setSlots((previous) => {
          const next: [ContentSlot, ContentSlot] = [previous[0], previous[1]]
          next[oldSlot] = { payload: null, revision: previous[oldSlot].revision }
          return next
        })
        window.api.dbgLog(`PresApp: retired old slot=${oldSlot}`)
        window.api.sendToControl('presentation-content-ready')
      })
    })
  }, [notifyControlAfterPaint])

  const loadContent = useCallback((payload: ContentPayload): void => {
    const currentSlot = activeSlotRef.current
    const currentPayload = slotsRef.current[currentSlot].payload
    const revision = ++revisionRef.current
    const isBufferedElectronTransition =
      currentPayload !== null &&
      (currentPayload.type === 'pdf' || currentPayload.type === 'video') &&
      (payload.type === 'pdf' || payload.type === 'video') &&
      (currentPayload.type === 'video' || payload.type === 'video')
    const targetSlot: SlotIndex = isBufferedElectronTransition
      ? (currentSlot === 0 ? 1 : 0)
      : currentSlot

    window.api.dbgLog(
      `PresApp: setContent type=${payload.type} path=${payload.path.split(/[\\/]/).pop()} ` +
      `startSlide=${payload.startSlide ?? '-'} slot=${targetSlot} buffered=${isBufferedElectronTransition}`
    )
    pendingRef.current = { slot: targetSlot, revision }
    setSlots((previous) => {
      const next: [ContentSlot, ContentSlot] = [previous[0], previous[1]]
      next[targetSlot] = { payload, revision }
      return next
    })
  }, [])

  useEffect(() => {
    const unsubLoad = window.api.on('load-content', (...args: unknown[]) => {
      const payload = args[0] as ContentPayload
      window.api.dbgLog(`PresApp: load-content received type=${payload.type}`)
      loadContent(payload)
    })

    const unsubStop = window.api.on('stop', () => {
      if (contentRef.current?.type === 'video') return
      const slot = activeSlotRef.current
      setSlots((previous) => {
        const next: [ContentSlot, ContentSlot] = [previous[0], previous[1]]
        next[slot] = { payload: null, revision: previous[slot].revision }
        return next
      })
    })

    window.api.signalReady()
    return () => {
      unsubLoad()
      unsubStop()
    }
  }, [loadContent])

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

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden">
      {slots.map((slot, index) => (
        <div
          key={index}
          className="absolute inset-0 flex items-center justify-center bg-black"
          style={{
            opacity: activeSlot === index ? 1 : 0,
            zIndex: activeSlot === index ? 1 : 0,
            pointerEvents: activeSlot === index ? 'auto' : 'none'
          }}
        >
          {renderSlot(slot, index as SlotIndex)}
        </div>
      ))}
      {!slots[activeSlot].payload && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-700 text-lg select-none">
          Waiting for content...
        </div>
      )}
    </div>
  )
}
