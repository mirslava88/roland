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
import { SceneLayerControlBar, SceneLayerToggleButton } from '../ProgramScene/SceneLayerControlBar'
import { InlineQrDescription } from '../ProgramScene/SceneQrPreviewLayer'
import { resolveProgramSceneBackground } from '../../program-scene-background'
import {
  contrastingQrDescriptionTextColor,
  detectQrDescriptionBackgroundColor
} from './auto-background-color'
import {
  isQrEditorOutputOwned,
  setQrEditorOutputOwned
} from './qr-live-preview-session'
import { renderQrImage } from './qr-render'

const MODULE_STYLES: Array<{ value: QrModuleStyle; label: string }> = [
  { value: 'square', label: 'Квадраты' },
  { value: 'dots', label: 'Точки' },
  { value: 'rounded', label: 'Мягкие' }
]

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
    (file.type === 'capture' && (
      file.capture?.captureKind === 'desktop'
    ))
  )
}

export async function publishQrOverlay(
  config: QrOverlayConfig,
  shouldPublish: () => boolean = () => true
): Promise<void> {
  const state = useAppStore.getState()
  const targetExists = state.displays.some(
    (display) => !display.isPrimary && display.id === state.selectedDisplayId
  )
  if (!config.enabled || !hasQrData(config) ||
    (!state.activeFile && !state.isPresentationWindowOpen) || !targetExists) {
    if (shouldPublish()) window.api.updateQrOverlay({ visible: false })
    return
  }

  try {
    const pptxThumbnails = state.activeFile?.type === 'presentation'
      ? state.pptxThumbnailsMap[state.activeFile.path] || EMPTY_THUMBNAILS
      : EMPTY_THUMBNAILS
    const docPreviewPath = state.activeFile?.type === 'other'
      ? state.docPreviewsMap[state.activeFile.path] ?? null
      : null
    const outputDisplay = state.displays.find(
      (display) => !display.isPrimary && display.id === state.selectedDisplayId
    ) ?? state.displays.find((display) => !display.isPrimary)
    const outputWidth = Math.max(1, outputDisplay?.bounds.width ?? 1920)
    const outputHeight = Math.max(1, outputDisplay?.bounds.height ?? 1080)
    const selectedCapture = state.captureSources.find(
      (entry) => entry.capture?.sourceId === state.programScene.captureSourceId
    )?.capture ?? null
    const activeIsParticipant = state.activeFile?.type === 'capture' &&
      state.activeFile.capture?.sourceId === selectedCapture?.sourceId
    const sceneBackground = resolveProgramSceneBackground(state)
    const backgroundIsParticipant = sceneBackground?.type === 'capture' &&
      sceneBackground.capture.sourceId === selectedCapture?.sourceId
    const sceneActive = state.programScene.enabled && !!sceneBackground &&
      (!state.activeFile || supportsProgramScene(state.activeFile)) && !activeIsParticipant &&
      !backgroundIsParticipant
    const contentAspectRatio = state.activeFile?.type === 'presentation'
      ? state.pptxAspectRatios[state.activeFile.path] ?? null
      : null
    const sceneRects = getProgramSceneRects(outputWidth, outputHeight, {
      placement: state.programScene.placement,
      participantSize: state.programScene.participantSize,
      participantScale: state.programScene.participantScale,
      viewMode: state.programScene.viewMode,
      contentAspectRatio
    })
    const [imageDataUrl, detectedColor] = await Promise.all([
      renderQrImage(config),
      config.descriptionBackgroundAuto
        ? detectQrDescriptionBackgroundColor({
            file: state.activeFile,
            currentSlide: state.currentSlide,
            pptxThumbnails,
            docPreviewPath,
            layout: {
              outputWidth,
              outputHeight,
              contentRect: sceneActive ? sceneRects.content : undefined,
              contentAspectRatio,
              config
            }
          })
        : Promise.resolve(null)
    ])
    if (!shouldPublish()) return
    const backgroundColor = detectedColor ?? config.descriptionBackgroundColor
    window.api.updateQrOverlay({
      visible: true,
      displayId: state.selectedDisplayId,
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
  } catch (error) {
    window.api.dbgLog(`QR live update failed: ${String(error)}`)
    if (shouldPublish()) window.api.updateQrOverlay({ visible: false })
  }
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

export function QrOverlayModal({
  onClose,
  embedded = false,
  settingsOnly = false,
  manageOutputOwnership = true
}: {
  onClose: () => void
  embedded?: boolean
  settingsOnly?: boolean
  manageOutputOwnership?: boolean
}): JSX.Element {
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
  const channels = useAppStore((state) => state.channels)
  const pptxSlidesMap = useAppStore((state) => state.pptxSlidesMap)
  const draft = stored
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [settingsPanel, setSettingsPanel] = useState<'content' | 'design'>('content')
  const [detectedBackgroundColor, setDetectedBackgroundColor] = useState<string | null>(null)
  const latestConfigRef = useRef<QrOverlayConfig>(stored)
  const valid = hasQrData(draft)
  latestConfigRef.current = draft
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
  const sceneBackground = useMemo(
    () => resolveProgramSceneBackground(useAppStore.getState()),
    [backdropImage, channels, pptxSlidesMap, pptxThumbnailsMap, programScene.background]
  )
  const backgroundSourceIsParticipant = sceneBackground?.type === 'capture' &&
    sceneBackground.capture.sourceId === selectedSceneCapture?.sourceId
  const sceneActive = programScene.enabled && !!sceneBackground &&
    (!activeFile || supportsProgramScene(activeFile)) && !activeSourceIsParticipant &&
    !backgroundSourceIsParticipant
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
    setQrOverlay(patch)
  }

  useEffect(() => {
    if (!manageOutputOwnership) return
    setQrEditorOutputOwned(true)
    return () => {
      const config = latestConfigRef.current
      setQrEditorOutputOwned(false)
      void publishQrOverlay(config, () => !isQrEditorOutputOwned())
    }
  }, [manageOutputOwnership])

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
    draft.descriptionSide,
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
    <div
      className={embedded ? 'contents' : 'fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-3'}
      onMouseDown={embedded ? undefined : onClose}
    >
      <div
        data-qr-overlay-editor
        className={embedded
          ? 'flex min-h-0 w-full flex-1 flex-col text-white'
          : 'flex max-h-[96vh] w-[1040px] max-w-[96vw] flex-col rounded-xl border border-gray-700 bg-surface-300 p-4 text-white shadow-2xl'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {!embedded && <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">QR-код в эфире</h2>
            <p className="text-[11px] text-gray-400">Ссылка или подключение к Wi‑Fi поверх любого контента</p>
          </div>
          <button type="button" onClick={onClose} className="px-2 text-xl text-gray-400 hover:text-white">×</button>
        </div>}

        <SceneLayerControlBar
          active={draft.enabled}
          status={draft.enabled ? 'QR-код в эфире' : 'QR-код скрыт'}
          detail={valid ? 'Слой подготовлен' : 'Заполните данные QR-кода'}
        >
          <SceneLayerToggleButton
            buttonProps={{ 'data-qr-overlay-visible': true }}
            tone="air"
            pressed={draft.enabled}
            title="Показывать или скрывать QR-код в эфире"
            onPressedChange={(pressed) => {
              const nextConfig = normalizeQrOverlay({ ...draft, enabled: pressed })
              update({ enabled: pressed })
              if (!pressed) {
                window.api.updateQrOverlay({ visible: false })
              } else {
                void publishQrOverlay(nextConfig, () => isQrEditorOutputOwned())
              }
            }}
          >
            {draft.enabled ? 'Выйти из эфира' : 'Показать в эфире'}
          </SceneLayerToggleButton>
        </SceneLayerControlBar>

        <div className={embedded
          ? settingsOnly
            ? 'min-h-0 flex-1'
            : 'grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(400px,.85fr)] gap-3'
          : 'grid grid-cols-[1fr_238px] gap-4'}>
          <div
            data-qr-overlay-settings
            className={embedded
              ? 'min-h-0 space-y-2.5'
              : 'space-y-3'}
            style={embedded && !settingsOnly ? { gridColumn: '2', gridRow: '1' } : undefined}
          >
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-200 p-1" role="tablist" aria-label="Настройки QR-кода">
              <button
                data-qr-settings-panel="content"
                type="button"
                role="tab"
                aria-selected={settingsPanel === 'content'}
                onClick={() => setSettingsPanel('content')}
                className={`rounded-md py-1.5 text-xs font-medium ${settingsPanel === 'content' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}
              >
                Содержимое
              </button>
              <button
                data-qr-settings-panel="design"
                type="button"
                role="tab"
                aria-selected={settingsPanel === 'design'}
                onClick={() => setSettingsPanel('design')}
                className={`rounded-md py-1.5 text-xs font-medium ${settingsPanel === 'design' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}
              >
                Оформление
              </button>
            </div>

            <div hidden={settingsPanel !== 'content'} className="grid grid-cols-3 gap-1 rounded-lg bg-surface-200 p-1">
              <button type="button" onClick={() => update({ contentType: 'url' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'url' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Ссылка</button>
              <button type="button" onClick={() => update({ contentType: 'wifi' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'wifi' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Wi‑Fi</button>
              <button type="button" onClick={() => update({ contentType: 'file' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'file' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Из файла</button>
            </div>

            <div hidden={settingsPanel !== 'content'}>
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
            </div>

            <label hidden={settingsPanel !== 'content'} className="block text-xs text-gray-300">Описание рядом с QR-кодом
              <input
                value={draft.description}
                maxLength={160}
                onChange={(event) => update({ description: event.target.value })}
                placeholder="Например: Задать вопрос спикеру"
                className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-sm text-white outline-none focus:border-blue-500"
              />
            </label>

            {settingsPanel === 'content' && visibleDescription && (
              <div>
                <div className="mb-1 text-[11px] text-gray-400">Описание относительно QR-кода</div>
                <div className="grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => update({ descriptionSide: 'left' })} className={`rounded-md border py-1.5 text-xs ${draft.descriptionSide === 'left' ? 'border-blue-400 bg-blue-600 text-white' : 'border-gray-700 bg-surface-100 text-gray-300'}`}>Слева</button>
                  <button type="button" onClick={() => update({ descriptionSide: 'right' })} className={`rounded-md border py-1.5 text-xs ${draft.descriptionSide === 'right' ? 'border-blue-400 bg-blue-600 text-white' : 'border-gray-700 bg-surface-100 text-gray-300'}`}>Справа</button>
                </div>
              </div>
            )}

            <div hidden={settingsPanel !== 'design' || !visibleDescription} className="space-y-2 border-t border-gray-700 pt-2">
              <div className="text-xs font-medium text-gray-200">Оформление описания</div>
              <div className="grid grid-cols-2 gap-2">
                <label hidden={draft.descriptionBackgroundAuto && draft.descriptionTextAutoContrast} className="block text-[11px] text-gray-300">Цвет текста
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
                <label hidden={draft.descriptionBackgroundTransparent || draft.descriptionBackgroundAuto} className="block text-[11px] text-gray-300">Цвет подложки
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
              <div>
                <div className="mb-1 text-[11px] text-gray-400">Подложка</div>
                <div className="grid grid-cols-3 gap-1">
                  <button type="button" onClick={() => update({ descriptionBackgroundAuto: true, descriptionBackgroundTransparent: false })} className={`rounded-md border px-1 py-1.5 text-[10px] ${draft.descriptionBackgroundAuto ? 'border-blue-400 bg-blue-600 text-white' : 'border-gray-700 bg-surface-100 text-gray-300'}`}>Авто</button>
                  <button type="button" onClick={() => update({ descriptionBackgroundAuto: false, descriptionBackgroundTransparent: false })} className={`rounded-md border px-1 py-1.5 text-[10px] ${!draft.descriptionBackgroundAuto && !draft.descriptionBackgroundTransparent ? 'border-blue-400 bg-blue-600 text-white' : 'border-gray-700 bg-surface-100 text-gray-300'}`}>Цвет</button>
                  <button data-qr-description-background-transparent type="button" onClick={() => update({ descriptionBackgroundAuto: false, descriptionBackgroundTransparent: true })} className={`rounded-md border px-1 py-1.5 text-[10px] ${draft.descriptionBackgroundTransparent ? 'border-blue-400 bg-blue-600 text-white' : 'border-gray-700 bg-surface-100 text-gray-300'}`}>Прозрачная</button>
                </div>
              </div>
              {draft.descriptionBackgroundAuto && (
                <label className="flex items-center gap-2 text-[11px] text-gray-300">
                  <input type="checkbox" checked={draft.descriptionTextAutoContrast} onChange={(event) => update({ descriptionTextAutoContrast: event.target.checked })} />
                  Автоконтраст текста
                </label>
              )}
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

            {settingsPanel === 'design' && draft.contentType !== 'file' && <div>
              <div className="mb-1 text-xs text-gray-300">Рисунок QR-кода</div>
              <div className="grid grid-cols-3 gap-1">
                {MODULE_STYLES.map((style) => <button key={style.value} type="button" onClick={() => update({ moduleStyle: style.value })} className={`rounded-md border px-1 py-1.5 text-[11px] ${draft.moduleStyle === style.value ? 'border-blue-400 bg-blue-600' : 'border-gray-700 bg-surface-100 hover:bg-gray-700'}`}>{style.label}</button>)}
              </div>
            </div>}

            <div hidden={settingsPanel !== 'design'} className={`grid gap-3 ${draft.contentType === 'file' ? 'grid-cols-1' : 'grid-cols-2'}`}>
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

            {settingsPanel === 'design' && draft.contentType !== 'file' && <div>
                <div className="mb-1 text-xs text-gray-300">Логотип по центру</div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => { void chooseLogo() }} className="min-w-0 flex-1 truncate rounded-md border border-gray-700 bg-surface-100 px-2 py-1.5 text-left text-[11px] hover:bg-gray-700" title={draft.logoPath || 'Выбрать изображение'}>{draft.logoPath?.split(/[\\/]/).pop() || 'Выбрать логотип'}</button>
                  {draft.logoPath && <button type="button" onClick={() => update({ logoPath: null })} className="rounded-md border border-gray-700 px-2 text-gray-400 hover:text-white">×</button>}
                </div>
            </div>}

            <label hidden={settingsPanel !== 'content'} className="block text-xs text-gray-300">Размер QR: {Math.round(draft.sizePercent)}%
              <input type="range" min="10" max="100" step="1" value={draft.sizePercent} onChange={(event) => update({ sizePercent: Number(event.target.value) })} className="mt-1 block h-2 w-full accent-blue-500" />
            </label>
            <button
              hidden={settingsPanel !== 'content'}
              type="button"
              onClick={() => update({ xPercent: 50, yPercent: 50 })}
              className="w-full rounded-md border border-gray-700 bg-surface-100 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-600 hover:bg-gray-700 hover:text-white"
            >
              Вернуть QR в центр
            </button>
            <p hidden={settingsPanel !== 'content'} className="text-[10px] leading-4 text-gray-500">Точное положение меняется перетаскиванием в предпросмотре.</p>
          </div>

          {!settingsOnly && <div
            data-qr-overlay-preview
            className={embedded ? 'min-h-0' : undefined}
            style={embedded ? { gridColumn: '1', gridRow: '1' } : undefined}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs text-gray-300">Предпросмотр</span>
            </div>
            <div
              data-qr-overlay-preview-canvas
              className="relative touch-none overflow-hidden rounded-lg border border-gray-700 bg-gray-950"
              style={{
                aspectRatio: `${outputWidth} / ${outputHeight}`,
                containerType: 'size',
                width: 'min(100%, calc(max(64px, 100dvh - 390px) * 16 / 9))',
                marginInline: 'auto'
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
              {sceneActive && sceneBackground ? (
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  {sceneBackground.type === 'capture' ? (
                    <CaptureThumbnail
                      config={sceneBackground.capture}
                      className="absolute inset-0 h-full w-full"
                      fit="cover"
                    />
                  ) : sceneBackground.type === 'video' ? (
                    <video
                      src={mediaUrl(sceneBackground.path)}
                      autoPlay
                      playsInline
                      loop={sceneBackground.loop}
                      muted
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : sceneBackground.type === 'pdf' && programScene.background.channelId &&
                    channels[programScene.background.channelId]?.file ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-black">
                        <SlideRenderer
                          file={channels[programScene.background.channelId].file as FileEntry}
                          slideNum={sceneBackground.slide}
                          pptxThumbnails={[]}
                          onTotalSlides={() => undefined}
                        />
                      </div>
                  ) : (
                    <img
                      src={mediaUrl(sceneBackground.path)}
                      alt=""
                      draggable={false}
                      className="absolute inset-0 h-full w-full select-none object-cover"
                    />
                  )}
                  <div
                    className="absolute z-[1] overflow-hidden bg-transparent"
                    style={{
                      ...previewRectStyle(sceneRects.content),
                      borderRadius: sceneRadius
                    }}
                  >
                    {renderActiveContent()}
                  </div>
                  {selectedSceneCapture && programScene.viewMode !== 'content' && (
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
                        fit={selectedSceneCapture.captureKind === 'desktop'
                          ? 'contain'
                          : 'cover'}
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
                    gap: visibleDescription ? `${previewGapSharePercent}%` : 0,
                    flexDirection: draft.descriptionSide === 'left' ? 'row-reverse' : 'row'
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
                  <InlineQrDescription
                      text={draft.description}
                      interactive
                      onTextChange={(description) => update({ description })}
                      className="flex max-h-full flex-1 items-center overflow-hidden text-left shadow-lg"
                      style={{
                        color: effectiveDescriptionColor,
                        backgroundColor: draft.descriptionBackgroundTransparent
                          ? 'transparent'
                          : effectiveDescriptionBackgroundColor,
                        textShadow: 'none',
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
                  />
                </div>
              ) : <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-gray-950 px-3 text-center text-[11px] text-gray-400">{previewError || 'Подготовка…'}</div>}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-gray-400">Перетащите весь блок для точного положения, вращайте колесо мыши для изменения размера. Белое поле вокруг кода нужно для надёжного считывания.</p>
          </div>}
        </div>

      </div>
    </div>
  )
}
