import { useEffect, useRef } from 'react'
import { acquireOutputTransition } from '../../output-transition-lock'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'
import { isNavigationTransitionActive, waitForNavigationTransitionEnd } from '../../navigation-transition'

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
  const displays = useAppStore((state) => state.displays)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const displayAssignments = useAppStore((state) => state.displayAssignments)
  const lastSignatureRef = useRef('')
  const previousPhysicalRouteRef = useRef<number | null | undefined>(undefined)
  const displayTopologySignature = displays
    .map((display) => `${display.id}:${display.isPrimary ? 1 : 0}`)
    .sort()
    .join('|')
  const physicalProgramDisplayId = connectedProgramDisplayId({
    displays,
    selectedDisplayId,
    displayAssignments
  })

  useEffect(() => {
    const state = useAppStore.getState()
    const nextPhysicalRoute = connectedProgramDisplayId(state)
    const previousPhysicalRoute = previousPhysicalRouteRef.current
    previousPhysicalRouteRef.current = nextPhysicalRoute
    if (previousPhysicalRoute === undefined || previousPhysicalRoute === nextPhysicalRoute) return

    // Display assignments can already request a transactional TAKE themselves.
    // This effect is keyed only by the connected topology, so it covers the
    // missing case: plugging or unplugging Program while content stays live.
    const timer = setTimeout(() => {
      const latest = useAppStore.getState()
      const latestPhysicalRoute = connectedProgramDisplayId(latest)
      if (latestPhysicalRoute !== previousPhysicalRouteRef.current) return
      const liveChannelId = latest.liveChannel
      const liveFile = liveChannelId ? latest.channels[liveChannelId]?.file : null
      // PPTX/PDF already used this transactional route recovery. A live
      // camera uses the same persistent PresentationApp surface, so it must
      // be promoted through the normal TAKE path too when Program appears or
      // disappears. Reusing the current channel keeps the existing USB stream
      // warm; only the output window placement/visibility changes.
      if (!liveChannelId || (
        liveFile?.type !== 'presentation' &&
        liveFile?.type !== 'pdf' &&
        liveFile?.type !== 'capture'
      )) return
      window.api.dbgLog(
        `program topology refresh requested channel=${liveChannelId} type=${liveFile.type} ` +
        `from=${previousPhysicalRoute ?? 'internal'} to=${latestPhysicalRoute ?? 'internal'}`
      )
      window.dispatchEvent(new CustomEvent('presentation-route-refresh-needed', {
        detail: { displayId: latestPhysicalRoute ?? undefined, speakerOnly: false }
      }))
    }, 250)
    return () => clearTimeout(timer)
  // Intentionally topology-only: manual role changes already publish their
  // own route refresh and must not cause a duplicate TAKE.
  }, [displayTopologySignature])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const release = await acquireOutputTransition('internal-program-lifecycle')
      try {
        if (cancelled || useAppStore.getState().internalProgramOutputActive !== active) return
        if (active) await window.api.prepareInternalProgramOutput()
        else await window.api.releaseInternalProgramOutput()
      } finally { release() }
    })().catch((error) => window.api.dbgLog(`internal program output lifecycle failed: ${String(error)}`))
    return () => { cancelled = true }
  }, [active])

  useEffect(() => {
    if (!active) {
      lastSignatureRef.current = ''
      return
    }
    let cancelled = false
    const publish = async (): Promise<void> => {
      // Never race a transactional TAKE's prepared/ready acknowledgement.
      // Once it finishes, publish the current snapshot even if no slide change
      // follows; PDF→native PowerPoint otherwise leaves capturePage() empty
      // until the operator advances the deck.
      if (isNavigationTransitionActive()) {
        window.api.dbgLog('internal program output sync deferred: transactional TAKE owns output')
        await waitForNavigationTransitionEnd()
        if (cancelled) return
        window.api.dbgLog('internal program output sync resumed after transactional TAKE')
      }
      const release = await acquireOutputTransition('internal-program-publish')
      try {
        if (cancelled) return
        const latest = useAppStore.getState()
        if (!latest.internalProgramOutputActive || latest.activeFile !== activeFile || latest.currentSlide !== currentSlide) return
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
          // Route belongs to the signature: HDMI removal must republish the
          // current slide even when neither the file nor slide number changed.
          // The physical Scene deliberately suspends this Chromium content so
          // native PowerPoint can occupy the presentation pane. Headless output
          // has no native HWND to capture, therefore restore the cached slide in
          // the same compositor used by Stream and PDM Virtual Camera.
          const signature = `pptx:${physicalProgramDisplayId ?? 'internal'}:${activeFile.path}:${currentSlide}:${framePath}`
          if (signature === lastSignatureRef.current) return
          lastSignatureRef.current = signature
          window.api.sendToPresentation('load-content', {
            type: 'other',
            path: framePath,
            name: activeFile.name,
            isImage: true,
            takeId: `internal-pptx-${Date.now()}`
          })
          if (physicalProgramDisplayId === null) {
            window.api.sendToPresentation('resume-active-content')
            window.api.dbgLog('internal program output restored cached PPTX content for headless Scene capture')
          }
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
      } finally { release() }
    }
    void publish().catch((error) => {
      window.api.dbgLog(`internal program output sync failed: ${String(error)}`)
    })
    return () => { cancelled = true }
  }, [active, activeFile, backdropImage, currentSlide, physicalProgramDisplayId, pptxSlidesMap, pptxThumbnailsMap, programSnapshot, videoLoopTrack])

  return null
}
