import { useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/useAppStore'

/**
 * Keeps the hidden Chromium program surface authoritative when Stream runs
 * without a physical Program display. Native PowerPoint must never open over
 * the operator window in this mode, so prepared slide frames are published as
 * ordinary images. Other media keeps using the normal PresentationApp path.
 */
export function InternalProgramOutputBridge(): null {
  const active = useAppStore((state) => state.internalProgramOutputActive)
  const activeFile = useAppStore((state) => state.activeFile)
  const currentSlide = useAppStore((state) => state.currentSlide)
  const pptxSlidesMap = useAppStore((state) => state.pptxSlidesMap)
  const pptxThumbnailsMap = useAppStore((state) => state.pptxThumbnailsMap)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const programSnapshot = useAppStore((state) => state.programSnapshot)
  const videoLoopTrack = useAppStore((state) => state.videoLoopTrack)
  const lastSignatureRef = useRef('')

  useEffect(() => {
    if (!active) {
      lastSignatureRef.current = ''
      return
    }
    let cancelled = false
    const publish = async (): Promise<void> => {
      await window.api.prepareInternalProgramOutput()
      if (cancelled) return

      if (!activeFile) {
        const outputBackdrop = programSnapshot?.backdropImage ?? backdropImage
        const signature = `backdrop:${outputBackdrop ?? ''}:scene-${programSnapshot?.revision ?? 0}`
        if (signature === lastSignatureRef.current) return
        lastSignatureRef.current = signature
        if (outputBackdrop) {
          window.api.sendToPresentation('load-content', {
            type: 'backdrop', path: outputBackdrop, name: 'Фон'
          })
        } else {
          window.api.sendToPresentation('clear-active-content')
        }
        return
      }

      if (activeFile.type === 'presentation') {
        const frames = pptxSlidesMap[activeFile.path] || pptxThumbnailsMap[activeFile.path] || []
        const framePath = frames[Math.max(0, currentSlide - 1)]
        if (!framePath) return
        const signature = `pptx:${activeFile.path}:${currentSlide}:${framePath}`
        if (signature === lastSignatureRef.current) return
        lastSignatureRef.current = signature
        window.api.sendToPresentation('load-content', {
          type: 'other',
          path: framePath,
          name: activeFile.name,
          isImage: true,
          takeId: `internal-pptx-${Date.now()}`
        })
        window.api.setActiveContentType('presentation')
        return
      }

      if (activeFile.type === 'pdf') {
        const signature = `pdf:${activeFile.path}:${currentSlide}`
        if (signature === lastSignatureRef.current) return
        const previousWasSamePdf = lastSignatureRef.current.startsWith(`pdf:${activeFile.path}:`)
        lastSignatureRef.current = signature
        if (previousWasSamePdf) {
          window.api.sendToPresentation('navigate-slide', currentSlide)
        } else {
          window.api.sendToPresentation('load-content', {
            ...activeFile,
            startSlide: currentSlide,
            takeId: `internal-pdf-${Date.now()}`
          })
        }
        window.api.setActiveContentType('pdf')
        return
      }

      const signature = `${activeFile.type}:${activeFile.path}`
      if (signature === lastSignatureRef.current) return
      lastSignatureRef.current = signature
      if (activeFile.type === 'capture' && activeFile.capture) {
        window.api.sendToPresentation('capture-source-register', activeFile.capture)
      }
      const playback = activeFile.type === 'video'
        ? useAppStore.getState().videoPlayback[activeFile.path]
        : undefined
      window.api.sendToPresentation('load-content', {
        ...activeFile,
        startTime: playback?.currentTime ?? 0,
        autoplay: playback?.playing ?? true,
        loop: activeFile.type === 'video' ? videoLoopTrack : undefined,
        takeId: `internal-${Date.now()}`
      })
      window.api.setActiveContentType(activeFile.type)
    }
    void publish().catch((error) => {
      window.api.dbgLog(`internal program output sync failed: ${String(error)}`)
    })
    return () => { cancelled = true }
  }, [active, activeFile, backdropImage, currentSlide, pptxSlidesMap, pptxThumbnailsMap, programSnapshot, videoLoopTrack])

  return null
}
