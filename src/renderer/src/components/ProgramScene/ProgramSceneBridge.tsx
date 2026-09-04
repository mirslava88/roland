import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { waitForNavigationTransitionEnd } from '../../navigation-transition'
import { PROGRAM_SCENE_TRANSITION_DURATION_MS } from '../../../../shared/program-scene'

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
    (file.type === 'capture' && file.capture?.captureKind === 'desktop')
  )
}

export function ProgramSceneBridge(): null {
  const programScene = useAppStore((state) => state.programScene)
  const transitionDurationMs = programScene.transitionEffect === 'instant'
    ? 0
    : PROGRAM_SCENE_TRANSITION_DURATION_MS
  const captureSources = useAppStore((state) => state.captureSources)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const activeFile = useAppStore((state) => state.activeFile)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const displays = useAppStore((state) => state.displays)
  const pptxAspectRatios = useAppStore((state) => state.pptxAspectRatios)
  const previousViewModeRef = useRef(programScene.viewMode)

  const selectedCapture = captureSources.find(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )?.capture ?? null
  const activeSourceIsParticipant = activeFile?.type === 'capture' &&
    activeFile.capture?.sourceId === selectedCapture?.sourceId
  const active = programScene.enabled && !!selectedCapture && !!backdropImage &&
    supportsProgramScene(activeFile) && !activeSourceIsParticipant
  const contentAspectRatio = activeFile?.type === 'presentation'
    ? pptxAspectRatios[activeFile.path] ?? null
    : null
  const connectedSelectedDisplay = selectedDisplayId !== null
    ? displays.find((display) => display.id === selectedDisplayId && !display.isPrimary)
    : null
  const targetDisplayId = connectedSelectedDisplay?.id ??
    displays.find((display) => !display.isPrimary)?.id ??
    null

  const sendState = useCallback((): void => {
    if (selectedCapture) {
      window.api.sendToPresentation('capture-source-register', selectedCapture)
    }
    window.api.sendToPresentation('program-scene-update', {
      active,
      capture: selectedCapture,
      backdropPath: backdropImage,
      placement: programScene.placement,
      participantSize: programScene.participantSize,
      cornerStyle: programScene.cornerStyle,
      viewMode: programScene.viewMode,
      transitionEffect: programScene.transitionEffect,
      transitionDurationMs,
      contentAspectRatio
    })
  }, [active, backdropImage, contentAspectRatio, programScene.cornerStyle, programScene.participantSize, programScene.placement, programScene.transitionEffect, programScene.viewMode, selectedCapture, transitionDurationMs])

  const sendStateRef = useRef(sendState)
  sendStateRef.current = sendState

  useEffect(() => {
    sendState()
  }, [sendState])

  useEffect(() => window.api.on('program-scene-ready', sendState), [sendState])

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
    const updateLiveNativeContent = async (): Promise<void> => {
      // PreviewPanel owns the atomic PDF/video -> PowerPoint TAKE. Waiting here
      // prevents this reactive layout sync from queueing an extra Office move
      // ahead of the launch. Layout edits made while already live remain
      // immediate because no navigation transition is active then.
      await waitForNavigationTransitionEnd()
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
            cornerStyle: programScene.cornerStyle,
            viewMode: programScene.viewMode,
            transitionEffect: programScene.transitionEffect,
            transitionDurationMs,
            contentAspectRatio: null
          }
        )
        if (!result.success) throw new Error(result.error || 'Word/Excel не применил раскладку эфира.')
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
        cornerStyle: programScene.cornerStyle,
        viewMode: programScene.viewMode,
        transitionEffect: programScene.transitionEffect,
        transitionDurationMs,
        contentAspectRatio
      })
      if (cancelled) return
      if (useAppStore.getState().isPresentationWindowOpen) {
        await window.api.closePresentationWindow()
        useAppStore.getState().setPresentationWindowOpen(false)
        window.api.setActiveContentType('presentation')
      }
    }
    void updateLiveNativeContent().catch((error) => {
      window.api.dbgLog(`program scene native content update failed: ${String(error)}`)
    })
    return () => { cancelled = true }
  }, [active, activeFile?.extension, activeFile?.path, activeFile?.type, contentAspectRatio, programScene.cornerStyle, programScene.participantSize, programScene.placement, programScene.transitionEffect, programScene.viewMode, targetDisplayId, transitionDurationMs])

  return null
}
