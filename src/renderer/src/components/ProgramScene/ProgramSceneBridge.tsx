import { useCallback, useEffect } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { waitForNavigationTransitionEnd } from '../../navigation-transition'

function supportsProgramScene(file: ReturnType<typeof useAppStore.getState>['activeFile']): boolean {
  return !!file && (
    file.type === 'presentation' ||
    file.type === 'pdf' ||
    file.type === 'video' ||
    (file.type === 'other' && file.isImage === true)
  )
}

export function ProgramSceneBridge(): null {
  const programScene = useAppStore((state) => state.programScene)
  const captureSources = useAppStore((state) => state.captureSources)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const activeFile = useAppStore((state) => state.activeFile)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const displays = useAppStore((state) => state.displays)
  const pptxAspectRatios = useAppStore((state) => state.pptxAspectRatios)

  const selectedCapture = captureSources.find(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )?.capture ?? null
  const active = programScene.enabled && !!selectedCapture && !!backdropImage && supportsProgramScene(activeFile)
  const contentAspectRatio = activeFile?.type === 'presentation'
    ? pptxAspectRatios[activeFile.path] ?? null
    : null
  const targetDisplayId = selectedDisplayId ?? displays.find((display) => !display.isPrimary)?.id ?? null

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
      contentAspectRatio
    })
  }, [active, backdropImage, contentAspectRatio, programScene.cornerStyle, programScene.participantSize, programScene.placement, selectedCapture])

  useEffect(() => {
    sendState()
  }, [sendState])

  useEffect(() => window.api.on('program-scene-ready', sendState), [sendState])

  useEffect(() => {
    if (activeFile?.type !== 'presentation' || targetDisplayId === null) return
    let cancelled = false
    const updateLivePowerPoint = async (): Promise<void> => {
      // PreviewPanel owns the atomic PDF/video -> PowerPoint TAKE. Waiting here
      // prevents this reactive layout sync from queueing an extra Office move
      // ahead of the launch. Layout edits made while already live remain
      // immediate because no navigation transition is active then.
      await waitForNavigationTransitionEnd()
      if (cancelled) return
      if (active) {
        await window.api.openPresentationWindow(targetDisplayId, true)
        if (cancelled) return
        useAppStore.getState().setPresentationWindowOpen(true)
        sendState()
        await window.api.relocatePowerPoint(targetDisplayId, {
          enabled: true,
          placement: programScene.placement,
          participantSize: programScene.participantSize,
          cornerStyle: programScene.cornerStyle,
          contentAspectRatio
        })
        window.api.setActiveContentType('presentation')
        return
      }

      await window.api.relocatePowerPoint(targetDisplayId, {
        enabled: false,
        placement: programScene.placement,
        participantSize: programScene.participantSize,
        cornerStyle: programScene.cornerStyle,
        contentAspectRatio
      })
      if (cancelled) return
      if (useAppStore.getState().isPresentationWindowOpen) {
        await window.api.closePresentationWindow()
        useAppStore.getState().setPresentationWindowOpen(false)
        window.api.setActiveContentType('presentation')
      }
    }
    void updateLivePowerPoint().catch((error) => {
      window.api.dbgLog(`program scene PowerPoint update failed: ${String(error)}`)
    })
    return () => { cancelled = true }
  }, [active, activeFile?.type, contentAspectRatio, programScene.cornerStyle, programScene.participantSize, programScene.placement, sendState, targetDisplayId])

  return null
}
