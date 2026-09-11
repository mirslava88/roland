import { useEffect } from 'react'
import { hasQrData } from '../../../../shared/qr-overlay'
import { getProgramSceneRects } from '../../../../shared/program-scene'
import { useAppStore } from '../../stores/useAppStore'
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
  const config = useAppStore((state) => state.qrOverlay)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const displays = useAppStore((state) => state.displays)
  const activeFile = useAppStore((state) => state.activeFile)
  const isPresentationWindowOpen = useAppStore((state) => state.isPresentationWindowOpen)
  const currentSlide = useAppStore((state) => state.currentSlide)
  const pptxThumbnailsMap = useAppStore((state) => state.pptxThumbnailsMap)
  const docPreviewsMap = useAppStore((state) => state.docPreviewsMap)
  const pptxAspectRatios = useAppStore((state) => state.pptxAspectRatios)
  const programScene = useAppStore((state) => state.programScene)
  const captureSources = useAppStore((state) => state.captureSources)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const channels = useAppStore((state) => state.channels)
  const pptxSlidesMap = useAppStore((state) => state.pptxSlidesMap)

  useEffect(() => {
    let cancelled = false
    if (isQrEditorOutputOwned()) return
    const targetExists = displays.some((display) => !display.isPrimary && display.id === selectedDisplayId)
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
      const outputDisplay = displays.find(
        (display) => !display.isPrimary && display.id === selectedDisplayId
      ) ?? displays.find((display) => !display.isPrimary)
      const outputWidth = Math.max(1, outputDisplay?.bounds.width ?? 1920)
      const outputHeight = Math.max(1, outputDisplay?.bounds.height ?? 1080)
      const selectedSceneCapture = captureSources.find(
        (entry) => entry.capture?.sourceId === programScene.captureSourceId
      )?.capture ?? null
      const activeSourceIsParticipant = activeFile?.type === 'capture' &&
        activeFile.capture?.sourceId === selectedSceneCapture?.sourceId
      const sceneBackground = resolveProgramSceneBackground(useAppStore.getState())
      const backgroundSourceIsParticipant = sceneBackground?.type === 'capture' &&
        sceneBackground.capture.sourceId === selectedSceneCapture?.sourceId
      const sceneActive = programScene.enabled && !!sceneBackground &&
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
          displayId: selectedDisplayId,
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
