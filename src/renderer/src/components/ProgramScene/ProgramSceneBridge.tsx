import { useCallback, useEffect, useMemo, useRef } from 'react'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'
import { waitForNavigationTransitionEnd } from '../../navigation-transition'
import { acquireOutputTransition } from '../../output-transition-lock'
import { PROGRAM_SCENE_TRANSITION_DURATION_MS } from '../../../../shared/program-scene'
import { resolveProgramSceneBackground } from '../../program-scene-background'
import { shouldRenderTimerInProgramRenderer, shouldShowTimerOnProgram } from '../../timer-controls'

const OFFICE_PROGRAM_EXTENSIONS = new Set(['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.ods'])

function isOfficeProgramDocument(file: ReturnType<typeof useAppStore.getState>['activeFile']): boolean {
  return !!file && file.type === 'other' && OFFICE_PROGRAM_EXTENSIONS.has(file.extension.toLowerCase())
}

function supportsProgramScene(file: ReturnType<typeof useAppStore.getState>['activeFile']): boolean {
  return !!file && (
    file.type === 'presentation' ||
    file.type === 'pdf' ||
    file.type === 'video' ||
    (file.type === 'other' && file.isImage === true) ||
    isOfficeProgramDocument(file) ||
    (file.type === 'capture' && (
      file.capture?.captureKind === 'desktop'
    ))
  )
}

export function ProgramSceneBridge(): null {
  const draftScene = useAppStore((state) => state.programScene)
  const programSnapshot = useAppStore((state) => state.programSnapshot)
  const programScene = programSnapshot?.scene ?? draftScene
  const transitionDurationMs = programScene.transitionEffect === 'instant'
    ? 0
    : PROGRAM_SCENE_TRANSITION_DURATION_MS
  const captureSources = useAppStore((state) => state.captureSources)
  const draftBackdropImage = useAppStore((state) => state.backdropImage)
  const backdropImage = programSnapshot?.backdropImage ?? draftBackdropImage
  const channels = useAppStore((state) => state.channels)
  const pptxSlidesMap = useAppStore((state) => state.pptxSlidesMap)
  const pptxThumbnailsMap = useAppStore((state) => state.pptxThumbnailsMap)
  const background = useMemo(
    () => resolveProgramSceneBackground({
      ...useAppStore.getState(),
      programScene
    }),
    [channels, pptxSlidesMap, pptxThumbnailsMap, programScene]
  )
  const activeFile = useAppStore((state) => state.activeFile)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const displays = useAppStore((state) => state.displays)
  const displayAssignments = useAppStore((state) => state.displayAssignments)
  const internalProgramOutputActive = useAppStore((state) => state.internalProgramOutputActive)
  const timerRemaining = useAppStore((state) => state.timerRemaining)
  const timerRunning = useAppStore((state) => state.timerRunning)
  const timerDuration = useAppStore((state) => state.timerDuration)
  const timerOutputVisible = useAppStore((state) => state.timerOutputVisible)
  const timerOutputOwner = useAppStore((state) => state.timerOutputOwner)
  const timerOverlayPosition = useAppStore((state) => state.timerOverlayPosition)
  const timerOverlayScale = useAppStore((state) => state.timerOverlayScale)
  const timerTextColor = useAppStore((state) => state.timerTextColor)
  const timerWarningTextColor = useAppStore((state) => state.timerWarningTextColor)
  const timerOvertimeTextColor = useAppStore((state) => state.timerOvertimeTextColor)
  const timerTextOpacity = useAppStore((state) => state.timerTextOpacity)
  const pptxAspectRatios = useAppStore((state) => state.pptxAspectRatios)
  const previousViewModeRef = useRef(programScene.viewMode)
  const rendererAppliedRevisionRef = useRef(0)
  const mediaOverlayAppliedRevisionRef = useRef(0)
  const captureRegistrationSignatureRef = useRef('')

  const confirmPublishedRevision = useCallback((revision: number): void => {
    if (
      revision > 0 &&
      rendererAppliedRevisionRef.current === revision &&
      mediaOverlayAppliedRevisionRef.current === revision
    ) {
      useAppStore.getState().confirmProgramSnapshot(revision)
    }
  }, [])

  const selectedCapture = captureSources.find(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )?.capture ?? null
  const activeSourceIsParticipant = activeFile?.type === 'capture' &&
    activeFile.capture?.sourceId === selectedCapture?.sourceId
  const backgroundSourceIsParticipant = background?.type === 'capture' &&
    background.capture.sourceId === selectedCapture?.sourceId
  const active = !!programSnapshot && programScene.enabled &&
    (!activeFile || supportsProgramScene(activeFile)) &&
    !activeSourceIsParticipant && !backgroundSourceIsParticipant
  const contentAspectRatio = activeFile?.type === 'presentation'
    ? pptxAspectRatios[activeFile.path] ?? null
    : null
  const targetDisplayId = connectedProgramDisplayId({ displays, selectedDisplayId, displayAssignments })
  const hasDedicatedTimerDisplay = displays.some((display) => (
    !display.isPrimary && displayAssignments[String(display.id)] === 'timer'
  ))
  const timerTargetsProgram = shouldShowTimerOnProgram({
    duration: timerDuration,
    outputVisible: timerOutputVisible,
    outputOwner: timerOutputOwner,
    hasDedicatedTimerDisplay
  })
  const upperMediaLayers = useMemo(
    () => programScene.mediaLayers.filter((layer) => layer.visible && layer.aboveContent),
    [programScene.mediaLayers]
  )
  // One media renderer for both native Office and renderer PDF output: switching
  // the content type must not remount unchanged image/video layers.
  const externalMediaOverlayActive = active && programScene.mediaLayersVisible &&
    targetDisplayId !== null && upperMediaLayers.length > 0

  const sendState = useCallback((forceCaptureRegistration = false): void => {
    const capturesToRegister = [
      selectedCapture,
      background?.type === 'capture' ? background.capture : null
    ].filter((capture): capture is CaptureSourceConfig => !!capture)
      .filter((capture, index, captures) => (
        captures.findIndex((candidate) => candidate.sourceId === capture.sourceId) === index
      ))
    const captureRegistrationSignature = JSON.stringify(capturesToRegister)
    if (
      forceCaptureRegistration ||
      captureRegistrationSignatureRef.current !== captureRegistrationSignature
    ) {
      captureRegistrationSignatureRef.current = captureRegistrationSignature
      for (const capture of capturesToRegister) {
        window.api.sendToPresentation('capture-source-register', capture)
      }
    }
    window.api.sendToPresentation('program-scene-update', {
      revision: programSnapshot?.revision ?? 0,
      active,
      capture: selectedCapture,
      backdropPath: backdropImage,
      background,
      placement: programScene.placement,
      participantSize: programScene.participantSize,
      participantScale: programScene.participantScale,
      cornerStyle: programScene.cornerStyle,
      viewMode: programScene.viewMode,
      transitionEffect: programScene.transitionEffect,
      transitionDurationMs,
      contentAspectRatio,
      textOverlays: programScene.textOverlays,
      textOverlaysVisible: programScene.textOverlaysVisible,
      mediaLayers: programScene.mediaLayers,
      mediaLayersVisible: programScene.mediaLayersVisible,
      externalMediaOverlayActive,
      chromaKey: programScene.chromaKey,
      // QR has its own output bridge just like the native physical overlay.
      // Keeping it out of Scene state prevents unrelated Scene refreshes from
      // clearing the QR on a headless stream/virtual-camera surface.
      qrOverlay: null,
      // The live timer store is the single authority after a Scene snapshot
      // has been published. This keeps toolbar/Stream Deck updates and the
      // internal Program output in lockstep with the native WPF overlay.
      timer: shouldRenderTimerInProgramRenderer(internalProgramOutputActive, targetDisplayId, timerTargetsProgram)
        ? {
            duration: timerDuration,
            remaining: timerRemaining,
            running: timerRunning,
            visible: true,
            position: { ...timerOverlayPosition },
            scale: timerOverlayScale,
            textColor: timerTextColor,
            warningTextColor: timerWarningTextColor,
            overtimeTextColor: timerOvertimeTextColor,
            textOpacity: timerTextOpacity
          }
        : null
    })
    const revision = programSnapshot?.revision ?? 0
    void window.api.updateProgramSceneMediaOverlay({
      visible: externalMediaOverlayActive,
      displayId: targetDisplayId,
      layers: upperMediaLayers
    }).then((result) => {
      if (!result.success) throw new Error(result.error || 'Не удалось обновить медиаслои.')
      mediaOverlayAppliedRevisionRef.current = revision
      confirmPublishedRevision(revision)
    }).catch((error) => {
      const message = String(error)
      window.api.dbgLog(`program scene media overlay update failed: ${message}`)
      if (revision > 0) useAppStore.getState().failProgramSnapshot(revision, message)
    })
  }, [active, backdropImage, background, confirmPublishedRevision, contentAspectRatio, externalMediaOverlayActive, internalProgramOutputActive, programScene.chromaKey, programScene.cornerStyle, programScene.mediaLayers, programScene.mediaLayersVisible, programScene.participantScale, programScene.participantSize, programScene.placement, programScene.textOverlays, programScene.textOverlaysVisible, programScene.transitionEffect, programScene.viewMode, programSnapshot, selectedCapture, targetDisplayId, timerDuration, timerOverlayPosition, timerOverlayScale, timerOvertimeTextColor, timerRemaining, timerRunning, timerTargetsProgram, timerTextColor, timerTextOpacity, timerWarningTextColor, transitionDurationMs, upperMediaLayers])

  // Audio changes must not touch native Office placement, video registration or
  // the held PowerPoint frame used for smooth PiP transitions.
  const sendAudio = useCallback(() => {
    window.api.sendToPresentation('program-scene-audio-update', programScene.audio)
  }, [programScene.audio])
  useEffect(sendAudio, [sendAudio])
  useEffect(() => window.api.on('program-scene-audio-ready', sendAudio), [sendAudio])

  const sendStateRef = useRef(sendState)
  sendStateRef.current = sendState

  useEffect(() => {
    sendState()
  }, [sendState])

  useEffect(() => window.api.on('program-scene-ready', () => sendState(true)), [sendState])

  useEffect(() => window.api.on('program-scene-applied', (...args: unknown[]) => {
    const revision = Number((args[0] as { revision?: unknown } | undefined)?.revision)
    if (Number.isInteger(revision) && revision > 0) {
      rendererAppliedRevisionRef.current = revision
      confirmPublishedRevision(revision)
    }
  }), [confirmPublishedRevision])

  useEffect(() => {
    const revision = programSnapshot?.revision
    if (!revision) return
    const timeout = setTimeout(() => {
      const status = useAppStore.getState().programOutputStatus
      if (status.desiredRevision === revision && status.phase === 'publishing') {
        useAppStore.getState().failProgramSnapshot(
          revision,
          'Окно эфира не подтвердило обновление сцены.'
        )
      }
    }, 6_000)
    return () => clearTimeout(timeout)
  }, [programSnapshot?.revision])

  useEffect(() => () => {
    void window.api.updateProgramSceneMediaOverlay({ visible: false, displayId: null, layers: [] })
  }, [])

  useEffect(() => {
    const livePowerPoint = activeFile?.type === 'presentation'
    const liveOfficeDocument = isOfficeProgramDocument(activeFile)
    const previousViewMode = previousViewModeRef.current
    previousViewModeRef.current = programScene.viewMode
    // Keep the transition history current even while PDF/video is live. This
    // prevents a later PowerPoint take from being mistaken for a participant
    // focus transition that happened on another content type.
    if ((!livePowerPoint && !liveOfficeDocument) || targetDisplayId === null) return
    const enteringPowerPointParticipantFocus = livePowerPoint &&
      active &&
      previousViewMode !== 'participant' &&
      programScene.viewMode === 'participant'
    const leavingPowerPointParticipantFocus = livePowerPoint &&
      active &&
      previousViewMode === 'participant' &&
      programScene.viewMode !== 'participant'
    const nonSmoothPowerPointTransition = livePowerPoint &&
      active &&
      previousViewMode !== programScene.viewMode &&
      programScene.transitionEffect !== 'smooth' &&
      programScene.transitionEffect !== 'instant'
    let cancelled = false
    const ownedRevision = useAppStore.getState().programSnapshot?.revision
    const updateLiveNativeContent = async (): Promise<void> => {
      // PreviewPanel owns the atomic PDF/video -> PowerPoint TAKE. Waiting here
      // prevents this reactive layout sync from queueing an extra Office move
      // ahead of the launch. Layout edits made while already live remain
      // immediate because no navigation transition is active then.
      await waitForNavigationTransitionEnd()
      if (cancelled) return
      const release = await acquireOutputTransition('scene-native-sync')
      try {
        if (cancelled) return
        if (leavingPowerPointParticipantFocus || nonSmoothPowerPointTransition) {
          // The renderer reveals a frozen frame while the participant shrinks.
          // Keep native PowerPoint underneath until that movement finishes, then
          // swap the identical frame back to the live slideshow.
          await new Promise((resolve) => setTimeout(resolve, transitionDurationMs))
          if (cancelled) return
        }
        const currentState = useAppStore.getState()
        const targetDisplay = currentState.displays.find((display) => display.id === targetDisplayId)
        if (active && programScene.viewMode === 'participant') {
          if (enteringPowerPointParticipantFocus) {
            // Toolbar has already raised the painted snapshot/participant scene
            // before publishing this mode.  Reopening and moving the BrowserWindow
            // here caused a second DWM z-order swap and a visible PowerPoint blink.
            window.api.setActiveContentType('presentation')
            return
          }
          await window.api.openPresentationWindow(targetDisplayId, true)
          if (cancelled) return
          useAppStore.getState().setPresentationWindowOpen(true)
          sendStateRef.current()
          await window.api.raisePresentationWindow()
          if (cancelled) return
          window.api.setActiveContentType(livePowerPoint ? 'presentation' : 'other')
          return
        }
        if (liveOfficeDocument && activeFile) {
          if (!targetDisplay) throw new Error('Целевой эфирный дисплей отключён.')
          if (active) {
            await window.api.openPresentationWindow(targetDisplayId, true)
            if (cancelled) return
            useAppStore.getState().setPresentationWindowOpen(true)
            sendStateRef.current()
          }
          const result = await window.api.restoreExternalFile(
            activeFile.path,
            targetDisplay.bounds,
            {
              enabled: active,
              placement: programScene.placement,
              participantSize: programScene.participantSize,
              participantScale: programScene.participantScale,
              cornerStyle: programScene.cornerStyle,
              viewMode: programScene.viewMode,
              transitionEffect: programScene.transitionEffect,
              transitionDurationMs,
              contentAspectRatio: null
            }
          )
          if (!result.success) throw new Error(result.error || 'Word/Excel не применил раскладку эфира.')
          if (cancelled) return
          window.api.setActiveContentType('other')
          return
        }
        if (active) {
          await window.api.openPresentationWindow(targetDisplayId, true)
          if (cancelled) return
          useAppStore.getState().setPresentationWindowOpen(true)
          sendStateRef.current()
          await window.api.relocatePowerPoint(targetDisplayId, {
            enabled: true,
            placement: programScene.placement,
            participantSize: programScene.participantSize,
            participantScale: programScene.participantScale,
            cornerStyle: programScene.cornerStyle,
            viewMode: programScene.viewMode,
            transitionEffect: programScene.transitionEffect,
            // The renderer has already animated the identical held frame. Move
            // native PowerPoint underneath it in one step, then uncover it;
            // animating the HWND again would make one button press take twice
            // the configured duration.
            transitionDurationMs: leavingPowerPointParticipantFocus || nonSmoothPowerPointTransition
              ? 0
              : transitionDurationMs,
            contentAspectRatio
          })
          if (cancelled) return
          if (leavingPowerPointParticipantFocus || nonSmoothPowerPointTransition) {
            window.api.sendToPresentation('program-scene-powerpoint-hold-clear')
          }
          window.api.setActiveContentType('presentation')
          return
        }

        await window.api.relocatePowerPoint(targetDisplayId, {
          enabled: false,
          placement: programScene.placement,
          participantSize: programScene.participantSize,
          participantScale: programScene.participantScale,
          cornerStyle: programScene.cornerStyle,
          viewMode: programScene.viewMode,
          transitionEffect: programScene.transitionEffect,
          transitionDurationMs,
          contentAspectRatio
        })
        if (cancelled) return
        if (useAppStore.getState().isPresentationWindowOpen) {
          // Native PowerPoint owns the physical Program display when Scene is
          // disabled. A stream/virtual camera may still be capturing the same
          // Chromium Program surface, where PreviewPanel has just painted the
          // matching cached PPTX frame. Parking that surface here clears its
          // first frame and leaves VKS black until the next slide navigation.
          // Keep it warm and painted for the simultaneous internal consumer;
          // the native slideshow remains above it on the physical display.
          if (useAppStore.getState().internalProgramOutputActive) {
            window.api.dbgLog('program scene native sync preserved internal PPTX frame for stream/virtual camera')
            window.api.setActiveContentType('presentation')
            return
          }
          await window.api.closePresentationWindow()
          if (cancelled) return
          useAppStore.getState().setPresentationWindowOpen(false)
          window.api.setActiveContentType('presentation')
        }
      } finally { release() }
    }
    void updateLiveNativeContent().catch((error) => {
      const message = String(error)
      window.api.dbgLog(`program scene native content update failed: ${message}`)
      if (!cancelled && ownedRevision) useAppStore.getState().failProgramSnapshot(ownedRevision, message)
    })
    return () => { cancelled = true }
  }, [active, activeFile?.extension, activeFile?.path, activeFile?.type, contentAspectRatio, programScene.cornerStyle, programScene.participantScale, programScene.participantSize, programScene.placement, programScene.transitionEffect, programScene.viewMode, targetDisplayId, transitionDurationMs])

  return null
}
