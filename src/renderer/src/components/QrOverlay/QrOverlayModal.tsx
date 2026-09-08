import { useEffect, useMemo, useRef, useState } from 'react'
import {
  hasQrData,
  normalizeQrOverlay,
  type QrModuleStyle,
  type QrOverlayConfig
} from '../../../../shared/qr-overlay'
import { getProgramSceneRects } from '../../../../shared/program-scene'
import { mediaUrl } from '../../media'
import { useAppStore } from '../../stores/useAppStore'
import { CaptureThumbnail } from '../Capture/CaptureThumbnail'
import { SlideRenderer } from '../Preview/PreviewPanel'
import {
  contrastingQrDescriptionTextColor,
  detectQrDescriptionBackgroundColor
} from './auto-background-color'
import { setQrLivePreviewActive } from './qr-live-preview-session'
import { renderQrImage } from './qr-render'

const MODULE_STYLES: Array<{ value: QrModuleStyle; label: string }> = [
  { value: 'square', label: 'Квадраты' },
  { value: 'dots', label: 'Точки' },
  { value: 'rounded', label: 'Мягкие' }
]

const POSITIONS = [
  [16, 20], [50, 20], [84, 20],
  [16, 50], [50, 50], [84, 50],
  [16, 80], [50, 80], [84, 80]
] as const

type QrColorField = 'color' | 'descriptionColor' | 'descriptionBackgroundColor'
type EyeDropperConstructor = new () => {
  open: () => Promise<{ sRGBHex: string }>
}

const OFFICE_PROGRAM_EXTENSIONS = new Set(['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.ods'])
const EMPTY_THUMBNAILS: string[] = []

function fittedRect(
  containerWidth: number,
  containerHeight: number,
  aspectRatio: number | null
): { x: number; y: number; width: number; height: number } {
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { x: 0, y: 0, width: containerWidth, height: containerHeight }
  }
  const width = Math.min(containerWidth, containerHeight * aspectRatio)
  const height = Math.min(containerHeight, width / aspectRatio)
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height
  }
}

function supportsProgramScene(file: ReturnType<typeof useAppStore.getState>['activeFile']): boolean {
  return !!file && (
    file.type === 'presentation' ||
    file.type === 'pdf' ||
    file.type === 'video' ||
    (file.type === 'other' && (
      file.isImage === true || OFFICE_PROGRAM_EXTENSIONS.has(file.extension.toLowerCase())
    )) ||
    (file.type === 'capture' && file.capture?.captureKind === 'desktop')
  )
}

function EyeDropperButton({
  onClick,
  disabled,
  available
}: {
  onClick: () => void
  disabled?: boolean
  available: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !available}
      className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded border border-gray-600 text-[15px] leading-none text-gray-200 hover:border-blue-400 hover:bg-blue-600/30 disabled:cursor-not-allowed disabled:opacity-30"
      title={available ? 'Взять цвет пипеткой из предпросмотра' : 'Пипетка недоступна в этой версии системы'}
      aria-label="Взять цвет пипеткой из предпросмотра"
    >
      ⌾
    </button>
  )
}

export function QrOverlayModal({ onClose }: { onClose: () => void }): JSX.Element {
  const stored = useAppStore((state) => state.qrOverlay)
  const setQrOverlay = useAppStore((state) => state.setQrOverlay)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const activeFile = useAppStore((state) => state.activeFile)
  const currentSlide = useAppStore((state) => state.currentSlide)
  const pptxThumbnailsMap = useAppStore((state) => state.pptxThumbnailsMap)
  const pptxAspectRatios = useAppStore((state) => state.pptxAspectRatios)
  const docPreviewsMap = useAppStore((state) => state.docPreviewsMap)
  const displays = useAppStore((state) => state.displays)
  const programScene = useAppStore((state) => state.programScene)
  const captureSources = useAppStore((state) => state.captureSources)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const outputAvailable = useAppStore((state) => (
    (state.activeFile !== null || state.isPresentationWindowOpen) &&
    state.displays.some((display) => !display.isPrimary && display.id === state.selectedDisplayId)
  ))
  const [draft, setDraft] = useState<QrOverlayConfig>(() => ({ ...stored }))
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [livePreview, setLivePreview] = useState(false)
  const [detectedBackgroundColor, setDetectedBackgroundColor] = useState<string | null>(null)
  const initialConfigRef = useRef<QrOverlayConfig>({ ...stored })
  const livePreviewRef = useRef(false)
  const savedRef = useRef(false)
  const valid = hasQrData(draft)
  const eyeDropperConstructor = (window as typeof window & {
    EyeDropper?: EyeDropperConstructor
  }).EyeDropper
  const eyeDropperAvailable = typeof eyeDropperConstructor === 'function'
  const activePptxThumbnails = activeFile?.type === 'presentation'
    ? pptxThumbnailsMap[activeFile.path] || EMPTY_THUMBNAILS
    : EMPTY_THUMBNAILS
  const activeDocPreviewPath = activeFile?.type === 'other'
    ? docPreviewsMap[activeFile.path] ?? null
    : null
  const outputDisplay = displays.find(
    (display) => !display.isPrimary && display.id === selectedDisplayId
  ) ?? displays.find((display) => !display.isPrimary)
  const outputWidth = Math.max(1, outputDisplay?.bounds.width ?? 1920)
  const outputHeight = Math.max(1, outputDisplay?.bounds.height ?? 1080)
  const outputAspectRatio = outputWidth / outputHeight
  const selectedSceneCapture = captureSources.find(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )?.capture ?? null
  const activeSourceIsParticipant = activeFile?.type === 'capture' &&
    activeFile.capture?.sourceId === selectedSceneCapture?.sourceId
  const sceneActive = programScene.enabled && !!selectedSceneCapture && !!backdropImage &&
    supportsProgramScene(activeFile) && !activeSourceIsParticipant
  const sceneContentAspectRatio = activeFile?.type === 'presentation'
    ? pptxAspectRatios[activeFile.path] ?? null
    : null
  const sceneRects = useMemo(() => getProgramSceneRects(outputWidth, outputHeight, {
    placement: programScene.placement,
    participantSize: programScene.participantSize,
    participantScale: programScene.participantScale,
    viewMode: programScene.viewMode,
    contentAspectRatio: sceneContentAspectRatio
  }), [
    outputWidth,
    outputHeight,
    programScene.placement,
    programScene.participantSize,
    programScene.participantScale,
    programScene.viewMode,
    sceneContentAspectRatio
  ])
  const standalonePptxRect = useMemo(
    () => fittedRect(outputWidth, outputHeight, sceneContentAspectRatio),
    [outputWidth, outputHeight, sceneContentAspectRatio]
  )

  const update = (patch: Partial<QrOverlayConfig>): void => {
    setDraft((current) => normalizeQrOverlay({ ...current, ...patch }))
  }

  const pickColor = async (field: QrColorField): Promise<void> => {
    if (!eyeDropperConstructor) return
    try {
      const result = await new eyeDropperConstructor().open()
      update({ [field]: result.sRGBHex })
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') {
        window.api.dbgLog(`QR color picker failed: ${String(error)}`)
      }
    }
  }

  useEffect(() => {
    let cancelled = false
    if (!draft.descriptionBackgroundAuto || !draft.description.trim()) {
      setDetectedBackgroundColor(null)
      return
    }
    void detectQrDescriptionBackgroundColor({
      file: activeFile,
      currentSlide,
      pptxThumbnails: activePptxThumbnails,
      docPreviewPath: activeDocPreviewPath,
      layout: {
        outputWidth,
        outputHeight,
        contentRect: sceneActive ? sceneRects.content : undefined,
        contentAspectRatio: sceneContentAspectRatio,
        config: draft
      }
    }).then((color) => {
      if (!cancelled) setDetectedBackgroundColor(color)
    })
    return () => {
      cancelled = true
    }
  }, [
    draft.descriptionBackgroundAuto,
    draft.description,
    activeFile,
    currentSlide,
    activePptxThumbnails,
    activeDocPreviewPath,
    outputWidth,
    outputHeight,
    sceneActive,
    sceneRects.content,
    sceneContentAspectRatio,
    draft.descriptionFontScale,
    draft.descriptionWidthPercent,
    draft.sizePercent,
    draft.xPercent,
    draft.yPercent
  ])

  const effectiveDescriptionBackgroundColor = draft.descriptionBackgroundAuto
    ? detectedBackgroundColor ?? draft.descriptionBackgroundColor
    : draft.descriptionBackgroundColor
  const effectiveDescriptionColor = draft.descriptionBackgroundAuto &&
    draft.descriptionTextAutoContrast && detectedBackgroundColor
    ? contrastingQrDescriptionTextColor(effectiveDescriptionBackgroundColor)
    : draft.descriptionColor

  useEffect(() => {
    let cancelled = false
    if (!valid) {
      setPreview(null)
      setPreviewError('Заполните данные QR-кода')
      return
    }
    const timer = setTimeout(() => {
      void renderQrImage(draft).then((url) => {
        if (!cancelled) {
          setPreview(url)
          setPreviewError('')
        }
      }).catch((error: unknown) => {
        if (!cancelled) setPreviewError(String(error))
      })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    draft.contentType,
    draft.url,
    draft.wifiSsid,
    draft.wifiPassword,
    draft.wifiSecurity,
    draft.wifiHidden,
    draft.imagePath,
    draft.moduleStyle,
    draft.cornerStyle,
    draft.color,
    draft.logoPath,
    valid
  ])

  const sendLiveImage = (
    config: QrOverlayConfig,
    imageDataUrl: string,
    resolvedColors?: { background: string; text: string }
  ): void => {
    const state = useAppStore.getState()
    const targetExists = state.displays.some(
      (display) => !display.isPrimary && display.id === state.selectedDisplayId
    )
    if ((!state.activeFile && !state.isPresentationWindowOpen) || !targetExists) {
      window.api.updateQrOverlay({ visible: false })
      return
    }
    window.api.updateQrOverlay({
      visible: true,
      displayId: state.selectedDisplayId,
      imageDataUrl,
      sizePercent: config.sizePercent,
      xPercent: config.xPercent,
      yPercent: config.yPercent,
      cornerStyle: config.cornerStyle,
      description: config.description,
      descriptionColor: resolvedColors?.text ?? config.descriptionColor,
      descriptionBackgroundColor: resolvedColors?.background ?? config.descriptionBackgroundColor,
      descriptionBackgroundTransparent: config.descriptionBackgroundTransparent,
      descriptionFontScale: config.descriptionFontScale,
      descriptionWidthPercent: config.descriptionWidthPercent
    })
  }

  const restoreSavedOutput = async (): Promise<void> => {
    const config = initialConfigRef.current
    if (!config.enabled || !hasQrData(config)) {
      window.api.updateQrOverlay({ visible: false })
      return
    }
    try {
      const state = useAppStore.getState()
      const pptxThumbnails = state.activeFile?.type === 'presentation'
        ? state.pptxThumbnailsMap[state.activeFile.path] || EMPTY_THUMBNAILS
        : EMPTY_THUMBNAILS
      const docPreviewPath = state.activeFile?.type === 'other'
        ? state.docPreviewsMap[state.activeFile.path] ?? null
        : null
      const outputDisplay = state.displays.find(
        (display) => !display.isPrimary && display.id === state.selectedDisplayId
      ) ?? state.displays.find((display) => !display.isPrimary)
      const restoreOutputWidth = Math.max(1, outputDisplay?.bounds.width ?? 1920)
      const restoreOutputHeight = Math.max(1, outputDisplay?.bounds.height ?? 1080)
      const selectedCapture = state.captureSources.find(
        (entry) => entry.capture?.sourceId === state.programScene.captureSourceId
      )?.capture ?? null
      const activeIsParticipant = state.activeFile?.type === 'capture' &&
        state.activeFile.capture?.sourceId === selectedCapture?.sourceId
      const restoreSceneActive = state.programScene.enabled && !!selectedCapture && !!state.backdropImage &&
        supportsProgramScene(state.activeFile) && !activeIsParticipant
      const restoreSceneRects = getProgramSceneRects(restoreOutputWidth, restoreOutputHeight, {
        placement: state.programScene.placement,
        participantSize: state.programScene.participantSize,
        participantScale: state.programScene.participantScale,
        viewMode: state.programScene.viewMode,
        contentAspectRatio: state.activeFile?.type === 'presentation'
          ? state.pptxAspectRatios[state.activeFile.path] ?? null
          : null
      })
      const [imageDataUrl, automaticColor] = await Promise.all([
        renderQrImage(config),
        config.descriptionBackgroundAuto
          ? detectQrDescriptionBackgroundColor({
              file: state.activeFile,
              currentSlide: state.currentSlide,
              pptxThumbnails,
              docPreviewPath,
              layout: {
                outputWidth: restoreOutputWidth,
                outputHeight: restoreOutputHeight,
                contentRect: restoreSceneActive ? restoreSceneRects.content : undefined,
                contentAspectRatio: state.activeFile?.type === 'presentation'
                  ? state.pptxAspectRatios[state.activeFile.path] ?? null
                  : null,
                config
              }
            })
          : Promise.resolve(null)
      ])
      const background = automaticColor ?? config.descriptionBackgroundColor
      sendLiveImage(config, imageDataUrl, {
        background,
        text: config.descriptionBackgroundAuto && config.descriptionTextAutoContrast && automaticColor
          ? contrastingQrDescriptionTextColor(background)
          : config.descriptionColor
      })
    } catch (error) {
      window.api.dbgLog(`QR live preview restore failed: ${String(error)}`)
      window.api.updateQrOverlay({ visible: false })
    }
  }

  useEffect(() => {
    livePreviewRef.current = livePreview
    setQrLivePreviewActive(livePreview)
    if (!livePreview) return
    if (!draft.enabled || !valid || !preview || !outputAvailable) {
      window.api.updateQrOverlay({ visible: false })
      return
    }
    sendLiveImage(draft, preview, {
      background: effectiveDescriptionBackgroundColor,
      text: effectiveDescriptionColor
    })
  }, [
    livePreview,
    draft.enabled,
    preview,
    valid,
    outputAvailable,
    selectedDisplayId,
    draft.sizePercent,
    draft.xPercent,
    draft.yPercent,
    draft.cornerStyle,
    draft.description,
    draft.descriptionColor,
    draft.descriptionBackgroundColor,
    draft.descriptionBackgroundAuto,
    draft.descriptionTextAutoContrast,
    draft.descriptionBackgroundTransparent,
    draft.descriptionFontScale,
    draft.descriptionWidthPercent,
    effectiveDescriptionBackgroundColor,
    effectiveDescriptionColor
  ])

  useEffect(() => () => {
    setQrLivePreviewActive(false)
    if (livePreviewRef.current && !savedRef.current) void restoreSavedOutput()
  }, [])

  const activePosition = useMemo(() => POSITIONS.findIndex(([x, y]) => (
    Math.abs(x - draft.xPercent) < 2 && Math.abs(y - draft.yPercent) < 2
  )), [draft.xPercent, draft.yPercent])
  const visibleDescription = draft.description.trim()
  // The live overlay sizes the QR square from the output height. Convert that
  // size to a width percentage using the selected display's real aspect ratio.
  const previewQrWidthPercent = draft.sizePercent / outputAspectRatio
  const descriptionWidthRatio = draft.descriptionWidthPercent / 100
  const previewGapWidthPercent = visibleDescription ? previewQrWidthPercent * 0.045 : 0
  const previewRightInsetPercent = 16 / outputWidth * 100
  const previewDescriptionWidthPercent = visibleDescription
    ? Math.max(0, Math.min(
        previewQrWidthPercent * descriptionWidthRatio,
        100 - previewQrWidthPercent - previewGapWidthPercent - previewRightInsetPercent
      ))
    : 0
  const previewBlockWidthPercent = previewQrWidthPercent + previewGapWidthPercent + previewDescriptionWidthPercent
  const previewQrSharePercent = previewQrWidthPercent / previewBlockWidthPercent * 100
  const previewGapSharePercent = previewGapWidthPercent / previewBlockWidthPercent * 100
  const previewPosition = useMemo(() => {
    const halfX = previewBlockWidthPercent / 2
    const halfY = draft.sizePercent / 2
    return {
      x: Math.max(halfX + 1, Math.min(99 - halfX, draft.xPercent)),
      y: halfY >= 50 ? 50 : Math.max(halfY + 1, Math.min(99 - halfY, draft.yPercent))
    }
  }, [draft.sizePercent, draft.xPercent, draft.yPercent, previewBlockWidthPercent])

  const movePreviewQr = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    update({
      xPercent: (event.clientX - rect.left) / rect.width * 100,
      yPercent: (event.clientY - rect.top) / rect.height * 100
    })
  }

  const chooseLogo = async (): Promise<void> => {
    const path = await window.api.selectQrLogo()
    if (path) update({ logoPath: path })
  }

  const chooseQrImage = async (): Promise<void> => {
    const path = await window.api.selectQrImage()
    if (path) update({ imagePath: path })
  }

  const save = (): void => {
    savedRef.current = true
    setQrLivePreviewActive(false)
    setQrOverlay(draft)
    onClose()
  }

  const renderActiveContent = (): JSX.Element => {
    const thumbnail = activeFile?.type === 'presentation'
      ? activePptxThumbnails[Math.max(0, currentSlide - 1)]
      : null
    if (thumbnail) {
      // PowerPoint's exported thumbnail can carry its own padding/aspect. The
      // actual slide-show follows the presentation geometry, so fill that exact
      // rectangle here as well to keep the QR preview spatially identical.
      return (
        <img
          src={mediaUrl(thumbnail)}
          alt=""
          draggable={false}
          className="h-full w-full select-none object-fill"
        />
      )
    }
    return (
      <SlideRenderer
        file={activeFile!}
        slideNum={currentSlide}
        pptxThumbnails={activePptxThumbnails}
        onTotalSlides={() => undefined}
      />
    )
  }

  const previewRectStyle = (rect: typeof sceneRects.content): React.CSSProperties => ({
    left: `${rect.x / outputWidth * 100}%`,
    top: `${rect.y / outputHeight * 100}%`,
    width: `${rect.width / outputWidth * 100}%`,
    height: `${rect.height / outputHeight * 100}%`
  })
  const sceneRadius = programScene.viewMode === 'both' && programScene.cornerStyle === 'rounded'
    ? '0.45rem'
    : 0

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-3" onMouseDown={onClose}>
      <div
        className="w-[720px] max-w-[96vw] rounded-xl border border-gray-700 bg-surface-300 p-4 text-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">QR-код в эфире</h2>
            <p className="text-[11px] text-gray-400">Ссылка или подключение к Wi‑Fi поверх любого контента</p>
          </div>
          <button type="button" onClick={onClose} className="px-2 text-xl text-gray-400 hover:text-white">×</button>
        </div>

        <div className="grid grid-cols-[1fr_238px] gap-4">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 rounded-lg bg-surface-200 p-1">
              <button type="button" onClick={() => update({ contentType: 'url' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'url' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Ссылка</button>
              <button type="button" onClick={() => update({ contentType: 'wifi' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'wifi' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Wi‑Fi</button>
              <button type="button" onClick={() => update({ contentType: 'file' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'file' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Из файла</button>
            </div>

            {draft.contentType === 'url' ? (
              <label className="block text-xs text-gray-300">Ссылка
                <input value={draft.url} onChange={(event) => update({ url: event.target.value })} placeholder="https://example.ru" className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-sm text-white outline-none focus:border-blue-500" />
              </label>
            ) : draft.contentType === 'wifi' ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2 block text-xs text-gray-300">Название сети
                  <input value={draft.wifiSsid} onChange={(event) => update({ wifiSsid: event.target.value })} className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-sm outline-none focus:border-blue-500" />
                </label>
                <label className="block text-xs text-gray-300">Защита
                  <select value={draft.wifiSecurity} onChange={(event) => update({ wifiSecurity: event.target.value as QrOverlayConfig['wifiSecurity'] })} className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2 py-1.5 text-sm">
                    <option value="WPA">WPA / WPA2 / WPA3</option><option value="WEP">WEP</option><option value="nopass">Без пароля</option>
                  </select>
                </label>
                <label className="block text-xs text-gray-300">Пароль
                  <input type="password" disabled={draft.wifiSecurity === 'nopass'} value={draft.wifiPassword} onChange={(event) => update({ wifiPassword: event.target.value })} className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-sm disabled:opacity-40" />
                </label>
                <label className="col-span-2 flex items-center gap-2 text-xs text-gray-300"><input type="checkbox" checked={draft.wifiHidden} onChange={(event) => update({ wifiHidden: event.target.checked })} /> Скрытая сеть</label>
              </div>
            ) : (
              <div>
                <div className="mb-1 text-xs text-gray-300">Готовый QR-код</div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => { void chooseQrImage() }} className="min-w-0 flex-1 truncate rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-left text-xs hover:bg-gray-700" title={draft.imagePath || 'Выбрать изображение QR-кода'}>{draft.imagePath?.split(/[\\/]/).pop() || 'Выбрать файл QR-кода'}</button>
                  {draft.imagePath && <button type="button" onClick={() => update({ imagePath: null })} className="rounded-md border border-gray-700 px-2 text-gray-400 hover:text-white">×</button>}
                </div>
                <p className="mt-1 text-[10px] text-gray-400">PNG, JPG, BMP, WebP или SVG. Лучше использовать квадратное изображение.</p>
              </div>
            )}

            <label className="block text-xs text-gray-300">Описание рядом с QR-кодом
              <input
                value={draft.description}
                maxLength={160}
                onChange={(event) => update({ description: event.target.value })}
                placeholder="Например: Задать вопрос спикеру"
                className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-sm text-white outline-none focus:border-blue-500"
              />
            </label>

            <div className={`space-y-2 ${visibleDescription ? '' : 'opacity-45'}`}>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-gray-300">Цвет текста
                  <div className="mt-1 flex items-center gap-2 rounded-md border border-gray-700 bg-surface-100 px-2 py-1">
                    <input
                      type="color"
                      value={effectiveDescriptionColor}
                      disabled={!visibleDescription || (
                        draft.descriptionBackgroundAuto && draft.descriptionTextAutoContrast
                      )}
                      onChange={(event) => update({ descriptionColor: event.target.value })}
                      className="h-5 w-7 cursor-pointer bg-transparent disabled:cursor-not-allowed"
                    />
                    <span className="font-mono text-[10px] uppercase">{effectiveDescriptionColor}</span>
                    <EyeDropperButton
                      available={eyeDropperAvailable}
                      disabled={!visibleDescription || (
                        draft.descriptionBackgroundAuto && draft.descriptionTextAutoContrast
                      )}
                      onClick={() => { void pickColor('descriptionColor') }}
                    />
                  </div>
                </label>
                <label className={`block text-[11px] text-gray-300 ${draft.descriptionBackgroundTransparent || draft.descriptionBackgroundAuto ? 'opacity-45' : ''}`}>Цвет подложки
                  <div className="mt-1 flex items-center gap-2 rounded-md border border-gray-700 bg-surface-100 px-2 py-1">
                    <input
                      type="color"
                      value={effectiveDescriptionBackgroundColor}
                      disabled={!visibleDescription || draft.descriptionBackgroundTransparent || draft.descriptionBackgroundAuto}
                      onChange={(event) => update({ descriptionBackgroundColor: event.target.value })}
                      className="h-5 w-7 cursor-pointer bg-transparent disabled:cursor-not-allowed"
                    />
                    <span className="font-mono text-[10px] uppercase">{effectiveDescriptionBackgroundColor}</span>
                    <EyeDropperButton
                      available={eyeDropperAvailable}
                      disabled={!visibleDescription || draft.descriptionBackgroundTransparent || draft.descriptionBackgroundAuto}
                      onClick={() => { void pickColor('descriptionBackgroundColor') }}
                    />
                  </div>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <label className="flex items-center gap-2 text-[11px] text-gray-300">
                  <input
                    type="checkbox"
                    checked={draft.descriptionBackgroundAuto}
                    disabled={!visibleDescription}
                    onChange={(event) => update({
                      descriptionBackgroundAuto: event.target.checked,
                      descriptionBackgroundTransparent: event.target.checked
                        ? false
                        : draft.descriptionBackgroundTransparent
                    })}
                  />
                  Автоцвет со слайда
                </label>
                <label className={`flex items-center gap-2 text-[11px] text-gray-300 ${draft.descriptionBackgroundAuto ? '' : 'opacity-45'}`}>
                  <input
                    type="checkbox"
                    checked={draft.descriptionTextAutoContrast}
                    disabled={!visibleDescription || !draft.descriptionBackgroundAuto}
                    onChange={(event) => update({
                      descriptionTextAutoContrast: event.target.checked
                    })}
                  />
                  Автоконтраст текста
                </label>
                <label className="flex items-center gap-2 text-[11px] text-gray-300">
                  <input
                    type="checkbox"
                    checked={draft.descriptionBackgroundTransparent}
                    disabled={!visibleDescription}
                    onChange={(event) => update({
                      descriptionBackgroundTransparent: event.target.checked,
                      descriptionBackgroundAuto: event.target.checked
                        ? false
                        : draft.descriptionBackgroundAuto
                    })}
                  />
                  Прозрачная подложка
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-[11px] text-gray-300">Размер шрифта: {Math.round(draft.descriptionFontScale * 100)}%
                  <input
                    type="range"
                    min="50"
                    max="200"
                    step="5"
                    value={Math.round(draft.descriptionFontScale * 100)}
                    disabled={!visibleDescription}
                    onChange={(event) => update({ descriptionFontScale: Number(event.target.value) / 100 })}
                    className="block h-2 w-full accent-blue-500 disabled:cursor-not-allowed"
                  />
                </label>
                <label className="block text-[11px] text-gray-300">Ширина описания: {Math.round(draft.descriptionWidthPercent)}%
                  <input
                    type="range"
                    min="40"
                    max="160"
                    step="5"
                    value={Math.round(draft.descriptionWidthPercent)}
                    disabled={!visibleDescription}
                    onChange={(event) => update({ descriptionWidthPercent: Number(event.target.value) })}
                    className="block h-2 w-full accent-blue-500 disabled:cursor-not-allowed"
                  />
                </label>
              </div>
            </div>

            {draft.contentType !== 'file' && <div>
              <div className="mb-1 text-xs text-gray-300">Рисунок QR-кода</div>
              <div className="grid grid-cols-3 gap-1">
                {MODULE_STYLES.map((style) => <button key={style.value} type="button" onClick={() => update({ moduleStyle: style.value })} className={`rounded-md border px-1 py-1.5 text-[11px] ${draft.moduleStyle === style.value ? 'border-blue-400 bg-blue-600' : 'border-gray-700 bg-surface-100 hover:bg-gray-700'}`}>{style.label}</button>)}
              </div>
            </div>}

            <div className={`grid gap-3 ${draft.contentType === 'file' ? 'grid-cols-1' : 'grid-cols-2'}`}>
              <div>
                <div className="mb-1 text-xs text-gray-300">Углы</div>
                <div className="grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => update({ cornerStyle: 'sharp' })} className={`rounded-md border py-1.5 text-[11px] ${draft.cornerStyle === 'sharp' ? 'border-blue-400 bg-blue-600' : 'border-gray-700 bg-surface-100'}`}>Острые</button>
                  <button type="button" onClick={() => update({ cornerStyle: 'rounded' })} className={`rounded-md border py-1.5 text-[11px] ${draft.cornerStyle === 'rounded' ? 'border-blue-400 bg-blue-600' : 'border-gray-700 bg-surface-100'}`}>Скруглённые</button>
                </div>
              </div>
              {draft.contentType !== 'file' && <label className="block text-xs text-gray-300">Цвет QR-кода
                <div className="mt-1 flex items-center gap-2 rounded-md border border-gray-700 bg-surface-100 px-2 py-1">
                  <input type="color" value={draft.color} onChange={(event) => update({ color: event.target.value })} className="h-6 w-8 cursor-pointer bg-transparent" />
                  <span className="font-mono text-[11px] uppercase">{draft.color}</span>
                  <EyeDropperButton
                    available={eyeDropperAvailable}
                    onClick={() => { void pickColor('color') }}
                  />
                </div>
              </label>}
            </div>

            <div className={`grid items-end gap-3 ${draft.contentType === 'file' ? 'grid-cols-[118px] justify-end' : 'grid-cols-[1fr_118px]'}`}>
              {draft.contentType !== 'file' && <div>
                <div className="mb-1 text-xs text-gray-300">Логотип по центру</div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => { void chooseLogo() }} className="min-w-0 flex-1 truncate rounded-md border border-gray-700 bg-surface-100 px-2 py-1.5 text-left text-[11px] hover:bg-gray-700" title={draft.logoPath || 'Выбрать изображение'}>{draft.logoPath?.split(/[\\/]/).pop() || 'Выбрать логотип'}</button>
                  {draft.logoPath && <button type="button" onClick={() => update({ logoPath: null })} className="rounded-md border border-gray-700 px-2 text-gray-400 hover:text-white">×</button>}
                </div>
              </div>}
              <div>
                <div className="mb-1 text-xs text-gray-300">Положение</div>
                <div className="grid grid-cols-3 gap-1">
                  {POSITIONS.map(([x, y], index) => <button key={`${x}-${y}`} type="button" onClick={() => update({ xPercent: x, yPercent: y })} aria-label={`Позиция ${index + 1}`} className={`h-5 rounded-sm border ${activePosition === index ? 'border-blue-300 bg-blue-500' : 'border-gray-600 bg-surface-100 hover:bg-gray-600'}`} />)}
                </div>
              </div>
            </div>

            <label className="block text-xs text-gray-300">Размер: {Math.round(draft.sizePercent)}%
              <input type="range" min="10" max="100" step="1" value={draft.sizePercent} onChange={(event) => update({ sizePercent: Number(event.target.value) })} className="mt-1 w-full accent-blue-500" />
            </label>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs text-gray-300">Предпросмотр</span>
              <label className={`flex items-center gap-1.5 text-[10px] ${draft.enabled && outputAvailable ? 'text-emerald-300' : 'text-gray-500'}`} title={!draft.enabled ? 'Сначала включите «Показывать в эфире»' : outputAvailable ? 'Показывать изменения сразу на программном экране' : 'Сначала выведите контент в эфир'}>
                <input
                  type="checkbox"
                  checked={draft.enabled && livePreview}
                  disabled={!draft.enabled || !outputAvailable}
                  onChange={(event) => {
                    const checked = event.target.checked
                    livePreviewRef.current = checked
                    setQrLivePreviewActive(checked)
                    setLivePreview(checked)
                    if (!checked) void restoreSavedOutput()
                  }}
                />
                В эфире
              </label>
            </div>
            <div
              className="relative touch-none overflow-hidden rounded-lg border border-gray-700 bg-gray-950"
              style={{
                aspectRatio: `${outputWidth} / ${outputHeight}`,
                containerType: 'size'
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                movePreviewQr(event)
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) movePreviewQr(event)
              }}
              onWheel={(event) => {
                event.preventDefault()
                const direction = event.deltaY < 0 ? 1 : -1
                update({ sizePercent: draft.sizePercent + direction * 2 })
              }}
            >
              {sceneActive && selectedSceneCapture && backdropImage ? (
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  <img
                    src={mediaUrl(backdropImage)}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 h-full w-full select-none object-cover"
                  />
                  <div
                    className="absolute z-[1] overflow-hidden bg-transparent"
                    style={{
                      ...previewRectStyle(sceneRects.content),
                      borderRadius: sceneRadius
                    }}
                  >
                    {renderActiveContent()}
                  </div>
                  {programScene.viewMode !== 'content' && (
                    <div
                      className="absolute z-[2] overflow-hidden bg-black"
                      style={{
                        ...previewRectStyle(sceneRects.participant),
                        borderRadius: sceneRadius
                      }}
                    >
                      <CaptureThumbnail
                        config={selectedSceneCapture}
                        className="h-full w-full"
                        fit={selectedSceneCapture.captureKind === 'device' ? 'cover' : 'contain'}
                      />
                    </div>
                  )}
                </div>
              ) : activeFile ? (
                <div
                  className="pointer-events-none absolute flex items-center justify-center overflow-hidden"
                  style={activeFile.type === 'presentation'
                    ? previewRectStyle(standalonePptxRect)
                    : { inset: 0 }}
                >
                  {renderActiveContent()}
                </div>
              ) : (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_center,#374151_0,#111827_70%)] px-3 text-center text-[10px] text-gray-400">
                  Сначала выведите материал в эфир
                </div>
              )}
              {preview ? (
                <div
                  className="pointer-events-none absolute z-10 flex items-center"
                  style={{
                    width: `${previewBlockWidthPercent}%`,
                    height: `${draft.sizePercent}%`,
                    left: `${previewPosition.x}%`,
                    top: `${previewPosition.y}%`,
                    transform: 'translate(-50%, -50%)',
                    gap: visibleDescription ? `${previewGapSharePercent}%` : 0
                  }}
                >
                  <img
                    src={preview}
                    draggable={false}
                    className="h-full shrink-0 select-none"
                    style={{
                      width: visibleDescription ? `${previewQrSharePercent}%` : '100%',
                      borderRadius: draft.cornerStyle === 'rounded' ? '10%' : 0
                    }}
                  />
                  {visibleDescription && (
                    <div
                      className="flex max-h-full flex-1 items-center overflow-hidden text-left shadow-lg"
                      style={{
                        color: effectiveDescriptionColor,
                        backgroundColor: draft.descriptionBackgroundTransparent
                          ? 'transparent'
                          : effectiveDescriptionBackgroundColor,
                        textShadow: draft.descriptionBackgroundTransparent
                          ? '0 1px 3px rgba(0,0,0,.95), 0 0 8px rgba(0,0,0,.72)'
                          : 'none',
                        padding: `${Math.max(
                          6 / outputHeight * 100,
                          draft.sizePercent * 0.055
                        )}cqh`,
                        fontFamily: 'Arial, sans-serif',
                        fontWeight: 700,
                        lineHeight: 1.15,
                        overflowWrap: 'anywhere',
                        whiteSpace: 'pre-wrap',
                        fontSize: `${Math.max(
                          10 / outputHeight * 100,
                          draft.sizePercent * 0.075 * draft.descriptionFontScale
                        )}cqh`,
                        borderRadius: draft.cornerStyle === 'rounded' ? '0.45rem' : 0
                      }}
                    >
                      {visibleDescription}
                    </div>
                  )}
                </div>
              ) : <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-gray-400">{previewError || 'Подготовка…'}</div>}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-gray-400">Перетащите весь блок для точного положения, вращайте колесо мыши для изменения размера. Белое поле вокруг кода нужно для надёжного считывания.</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-gray-700 pt-3">
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.enabled} onChange={(event) => {
            const checked = event.target.checked
            update({ enabled: checked })
            if (!checked && livePreview) {
              setLivePreview(false)
              livePreviewRef.current = false
              setQrLivePreviewActive(false)
              void restoreSavedOutput()
            }
          }} /> Показывать в эфире</label>
          <div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">Отмена</button><button type="button" onClick={save} disabled={!valid} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40">Сохранить</button></div>
        </div>
      </div>
    </div>
  )
}
