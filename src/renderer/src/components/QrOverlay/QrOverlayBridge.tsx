import { useCallback, useEffect, useRef } from 'react'
import { hasQrData } from '../../../../shared/qr-overlay'
import { getProgramSceneRects } from '../../../../shared/program-scene'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'
import { resolveProgramSceneBackground } from '../../program-scene-background'
import {
  contrastingQrDescriptionTextColor,
  detectQrDescriptionBackgroundColor
} from './auto-background-color'
import { isQrEditorOutputOwned } from './qr-live-preview-session'
import { renderQrImage } from './qr-render'

const OFFICE_PROGRAM_EXTENSIONS = new Set(['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.ods'])

function supportsProgramScene(file: ReturnType<typeof useAppStore.getState>['activeFile']): boolean {
  return !!file && (
    file.type === 'presentation' ||
    file.type === 'pdf' ||
    file.type === 'video' ||
    (file.type === 'other' && (
      file.isImage === true || OFFICE_PROGRAM_EXTENSIONS.has(file.extension.toLowerCase())
    )) ||
    (file.type === 'capture' && (
      file.capture?.captureKind === 'desktop'
    ))
  )
}

export function QrOverlayBridge(): null {
  const draftConfig = useAppStore((state) => state.qrOverlay)
  const programSnapshot = useAppStore((state) => state.programSnapshot)
  const config = programSnapshot?.qrOverlay ?? draftConfig
  const internalProgramOutputActive = useAppStore((state) => state.internalProgramOutputActive)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const displayAssignments = useAppStore((state) => state.displayAssignments)
  const displays = useAppStore((state) => state.displays)
  const activeFile = useAppStore((state) => state.activeFile)
  const isPresentationWindowOpen = useAppStore((state) => state.isPresentationWindowOpen)
  const currentSlide = useAppStore((state) => state.currentSlide)
  const pptxThumbnailsMap = useAppStore((state) => state.pptxThumbnailsMap)
  const docPreviewsMap = useAppStore((state) => state.docPreviewsMap)
  const pptxAspectRatios = useAppStore((state) => state.pptxAspectRatios)
  const draftProgramScene = useAppStore((state) => state.programScene)
  const captureSources = useAppStore((state) => state.captureSources)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const channels = useAppStore((state) => state.channels)
  const pptxSlidesMap = useAppStore((state) => state.pptxSlidesMap)
  const programScene = programSnapshot?.scene ?? draftProgramScene
  const secretLoaded = useRef(false)

  useEffect(() => {
    let cancelled = false
    void window.api.loadQrWifiPassword().then((wifiPassword) => {
      if (cancelled) return
      secretLoaded.current = true
      const legacyPassword = useAppStore.getState().qrOverlay.wifiPassword
      if (legacyPassword) {
        // Rewriting through the sanitized persist projection removes plaintext
        // left by older builds; the encrypted main-process store keeps it.
        useAppStore.getState().setQrOverlay({ wifiPassword: legacyPassword })
        void window.api.saveQrWifiPassword(legacyPassword)
      } else if (wifiPassword) {
        useAppStore.getState().setQrOverlay({ wifiPassword })
      }
    }).catch(() => {
      secretLoaded.current = true
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!secretLoaded.current) return
    const timer = setTimeout(() => {
      void window.api.saveQrWifiPassword(draftConfig.wifiPassword)
    }, 250)
    return () => clearTimeout(timer)
  }, [draftConfig.wifiPassword])

  const sendRendererQrOverlay = useCallback((): void => {
    const visible = internalProgramOutputActive && config.enabled && hasQrData(config)
    window.api.sendToPresentation(
      'qr-overlay-renderer-update',
      visible ? { ...config, enabled: true } : null
    )
    window.api.dbgLog(
      `internal QR overlay active=${internalProgramOutputActive} visible=${visible} ` +
      `snapshotRevision=${programSnapshot?.revision ?? 0}`
    )
  }, [config, internalProgramOutputActive, programSnapshot?.revision])

  useEffect(sendRendererQrOverlay, [sendRendererQrOverlay])
  // A hot-unplug replaces the hidden Presentation Output renderer. Replay QR
  // after that renderer has installed its listeners instead of relying on the
  // earlier message that belonged to the retired window.
  useEffect(
    () => window.api.on('program-scene-ready', sendRendererQrOverlay),
    [sendRendererQrOverlay]
  )

  useEffect(() => {
    let cancelled = false
    if (isQrEditorOutputOwned()) return
    const outputDisplayId = connectedProgramDisplayId({ displays, displayAssignments, selectedDisplayId })
    const targetExists = outputDisplayId !== null
    const outputActive = activeFile !== null || isPresentationWindowOpen
    const visible = config.enabled && hasQrData(config) && targetExists && outputActive
    if (!visible) {
      window.api.updateQrOverlay({ visible: false })
      return
    }
    const timer = setTimeout(() => {
      if (isQrEditorOutputOwned()) return
      const pptxThumbnails = activeFile?.type === 'presentation'
        ? pptxThumbnailsMap[activeFile.path] || []
        : []
      const docPreviewPath = activeFile?.type === 'other'
        ? docPreviewsMap[activeFile.path] ?? null
        : null
      const outputDisplay = displays.find((display) => display.id === outputDisplayId)
      const outputWidth = Math.max(1, outputDisplay?.bounds.width ?? 1920)
      const outputHeight = Math.max(1, outputDisplay?.bounds.height ?? 1080)
      const selectedSceneCapture = captureSources.find(
        (entry) => entry.capture?.sourceId === programScene.captureSourceId
      )?.capture ?? null
      const activeSourceIsParticipant = activeFile?.type === 'capture' &&
        activeFile.capture?.sourceId === selectedSceneCapture?.sourceId
      const sceneState = programSnapshot
        ? { ...useAppStore.getState(), programScene: programSnapshot.scene }
        : useAppStore.getState()
      const sceneBackground = resolveProgramSceneBackground(sceneState)
      const backgroundSourceIsParticipant = sceneBackground?.type === 'capture' &&
        sceneBackground.capture.sourceId === selectedSceneCapture?.sourceId
      const sceneActive = programSnapshot !== null && programScene.enabled &&
        (!activeFile || supportsProgramScene(activeFile)) && !activeSourceIsParticipant &&
        !backgroundSourceIsParticipant
      const sceneRects = getProgramSceneRects(outputWidth, outputHeight, {
        placement: programScene.placement,
        participantSize: programScene.participantSize,
        participantScale: programScene.participantScale,
        viewMode: programScene.viewMode,
        contentAspectRatio: activeFile?.type === 'presentation'
          ? pptxAspectRatios[activeFile.path] ?? null
          : null
      })
      const automaticColor = config.descriptionBackgroundAuto
        ? detectQrDescriptionBackgroundColor({
            file: activeFile,
            currentSlide,
            pptxThumbnails,
            docPreviewPath,
            layout: {
              outputWidth,
              outputHeight,
              contentRect: sceneActive ? sceneRects.content : undefined,
              contentAspectRatio: activeFile?.type === 'presentation'
                ? pptxAspectRatios[activeFile.path] ?? null
                : null,
              config
            }
          })
        : Promise.resolve(null)
      void Promise.all([renderQrImage(config), automaticColor]).then(([imageDataUrl, detectedColor]) => {
        if (cancelled || isQrEditorOutputOwned()) return
        const backgroundColor = detectedColor ?? config.descriptionBackgroundColor
        window.api.updateQrOverlay({
          visible: true,
          displayId: outputDisplayId,
          imageDataUrl,
          sizePercent: config.sizePercent,
          xPercent: config.xPercent,
          yPercent: config.yPercent,
          cornerStyle: config.cornerStyle,
          description: config.description,
          descriptionColor: config.descriptionBackgroundAuto &&
            config.descriptionTextAutoContrast && detectedColor
            ? contrastingQrDescriptionTextColor(backgroundColor)
            : config.descriptionColor,
          descriptionBackgroundColor: backgroundColor,
          descriptionBackgroundTransparent: config.descriptionBackgroundTransparent,
          descriptionFontScale: config.descriptionFontScale,
          descriptionWidthPercent: config.descriptionWidthPercent,
          descriptionSide: config.descriptionSide
        })
      }).catch((error: unknown) => {
        window.api.dbgLog(`QR overlay generation failed: ${String(error)}`)
        if (!cancelled) window.api.updateQrOverlay({ visible: false })
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    config,
    selectedDisplayId,
    displayAssignments,
    displays,
    activeFile,
    isPresentationWindowOpen,
    currentSlide,
    pptxThumbnailsMap,
    docPreviewsMap,
    pptxAspectRatios,
    programScene,
    captureSources,
    backdropImage,
    channels,
    pptxSlidesMap
  ])

  useEffect(() => () => window.api.updateQrOverlay({ visible: false }), [])
  return null
}
