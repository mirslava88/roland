import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mediaUrl } from '../../media'
import { useAppStore } from '../../stores/useAppStore'
import { CaptureThumbnail } from '../Capture/CaptureThumbnail'
import { normalizeProgramSceneAudio, type ProgramSceneAudioStatus } from '../../../../shared/program-scene-audio'
import { SlideRenderer } from '../Preview/PreviewPanel'
import {
  DEFAULT_PROGRAM_SCENE_LAYOUT,
  DEFAULT_PROGRAM_SCENE_CHROMA_KEY,
  PROGRAM_SCENE_PARTICIPANT_SCALE_MAX,
  PROGRAM_SCENE_PARTICIPANT_SCALE_MIN,
  PROGRAM_SCENE_TRANSITION_DURATION_MS,
  normalizeProgramSceneParticipantScale,
  normalizeProgramSceneBackground,
  normalizeProgramSceneChromaKey,
  normalizeProgramSceneMediaLayers,
  normalizeProgramSceneTextOverlays
} from '../../../../shared/program-scene'
import type {
  ProgramSceneCornerStyle,
  ProgramSceneBackgroundKind,
  ProgramSceneChromaKeyConfig,
  ProgramSceneParticipantSize,
  ProgramScenePlacement,
  ProgramSceneTransitionEffect
} from '../../../../shared/program-scene'
import {
  isProgramSceneBackgroundChannelSupported,
  resolveProgramSceneBackground
} from '../../program-scene-background'
import {
  ProgramSceneMediaLayerEditor,
  ProgramSceneMediaLayerSurface,
  moveProgramSceneMediaLayer
} from './ProgramSceneMediaLayers'
import {
  ProgramSceneTextOverlayEditor,
  ProgramSceneTextOverlayLayer
} from './ProgramSceneTextOverlays'
import { QrOverlayModal, publishQrOverlay } from '../QrOverlay/QrOverlayModal'
import { isQrEditorOutputOwned, setQrEditorOutputOwned } from '../QrOverlay/qr-live-preview-session'
import { BroadcastTitlesModal } from '../BroadcastTitles/BroadcastTitles'
import { SceneLayerControlBar, SceneLayerToggleButton } from './SceneLayerControlBar'
import { SceneQrPreviewLayer } from './SceneQrPreviewLayer'
import { hasQrData, normalizeQrOverlay } from '../../../../shared/qr-overlay'

interface Props {
  onClose: () => void
  initialEditor?: 'qr'
}

type CanvasSelection =
  | { kind: 'text'; id: string }
  | { kind: 'media'; id: string }
  | { kind: 'qr' }
  | { kind: 'chroma' }
  | null

interface SceneContextMenuState {
  clientX: number
  clientY: number
  xPercent: number
  yPercent: number
  chooserOnly?: boolean
  target:
    | { kind: 'canvas' }
    | { kind: 'background' }
    | { kind: 'content' }
    | { kind: 'external' }
    | { kind: 'qr' }
    | { kind: 'text'; id: string }
    | { kind: 'media'; id: string }
}

interface DeviceResponse {
  requestId: string
  devices: CaptureDeviceDescriptor[]
  error?: string
}

const PLACEMENTS: Array<{ value: ProgramScenePlacement; label: string }> = [
  { value: 'left-top', label: 'Слева сверху' },
  { value: 'right-top', label: 'Справа сверху' },
  { value: 'left-center', label: 'Слева по центру' },
  { value: 'right-center', label: 'Справа по центру' },
  { value: 'left-bottom', label: 'Слева снизу' },
  { value: 'right-bottom', label: 'Справа снизу' }
]

const SIZES: Array<{ value: ProgramSceneParticipantSize; label: string }> = [
  { value: 'small', label: 'Меньше' },
  { value: 'medium', label: 'Средний' },
  { value: 'large', label: 'Больше' },
  { value: 'half', label: 'Пополам' }
]

const CORNERS: Array<{ value: ProgramSceneCornerStyle; label: string }> = [
  { value: 'sharp', label: 'Острые' },
  { value: 'rounded', label: 'Скруглённые' }
]

const TRANSITION_EFFECTS: Array<{ value: ProgramSceneTransitionEffect; label: string }> = [
  { value: 'smooth', label: 'Плавное изменение' },
  { value: 'zoom-fade', label: 'Масштаб с затуханием' },
  { value: 'instant', label: 'Без анимации' }
]

const BACKGROUND_KINDS: Array<{ value: ProgramSceneBackgroundKind; label: string }> = [
  { value: 'image', label: 'Картинка' },
  { value: 'video', label: 'Видео' },
  { value: 'channel', label: 'Канал' }
]

function shortFileName(path: string | null): string {
  if (!path) return ''
  return path.replace(/\\/g, '/').split('/').pop() || path
}

function canPreviewSceneContent(file: FileEntry | null | undefined): file is FileEntry {
  return Boolean(file && (
    file.type === 'presentation' ||
    file.type === 'pdf' ||
    file.type === 'video' ||
    (file.type === 'capture' && file.capture?.captureKind === 'desktop') ||
    (file.type === 'other' && file.isImage)
  ))
}

function TransitionEffectIcon({ effect }: { effect: ProgramSceneTransitionEffect }): JSX.Element {
  if (effect === 'zoom-fade') {
    return <span className="relative h-4 w-5"><i className="absolute left-0 top-1 h-2 w-2 rounded-sm border border-current opacity-40" /><i className="absolute bottom-0 right-0 h-3 w-3 rounded-sm border-2 border-current" /></span>
  }
  if (effect === 'instant') {
    return <span className="text-sm font-bold leading-none">⚡</span>
  }
  return <span className="relative h-4 w-5"><i className="absolute left-0 top-0 h-3 w-3 rounded-sm border border-current" /><i className="absolute bottom-0 right-0 h-3 w-3 rounded-sm border border-current" /></span>
}

function ChromaKeyPanel({
  config,
  available,
  pickerActive,
  onChange,
  onPickerToggle,
  onReset
}: {
  config: ProgramSceneChromaKeyConfig
  available: boolean
  pickerActive: boolean
  onChange: (update: Partial<ProgramSceneChromaKeyConfig>) => void
  onPickerToggle: () => void
  onReset: () => void
}): JSX.Element {
  return (
    <div data-program-scene-chroma className="rounded-lg border border-blue-500/50 bg-surface-100 p-3 shadow-sm shadow-blue-950/30">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-white">Хромакей</div>
          <div className="text-[10px] text-gray-400">Удаление цветного фона камеры или платы захвата</div>
        </div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-200">
          <input
            data-program-scene-chroma-toggle
            type="checkbox"
            checked={config.enabled}
            disabled={!available}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          Включён
        </label>
      </div>
      <div className="mb-3 flex items-center gap-2">
        <input
          data-program-scene-chroma-color
          type="color"
          aria-label="Цвет хромакея"
          value={config.color}
          disabled={!available}
          onChange={(event) => onChange({ color: event.target.value, enabled: true })}
          className="h-8 w-10 cursor-pointer rounded border border-gray-600 bg-gray-900 p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
        />
        <button type="button" data-program-scene-chroma-preset="green" aria-label="Зелёный фон"
          disabled={!available} onClick={() => onChange({ color: '#00b140', enabled: true })}
          className="h-7 w-7 rounded-full border border-white/50 bg-[#00b140] shadow disabled:opacity-40" />
        <button type="button" data-program-scene-chroma-preset="blue" aria-label="Синий фон"
          disabled={!available} onClick={() => onChange({ color: '#1769e0', enabled: true })}
          className="h-7 w-7 rounded-full border border-white/50 bg-[#1769e0] shadow disabled:opacity-40" />
        <button
          type="button"
          data-program-scene-chroma-picker
          disabled={!available}
          aria-pressed={pickerActive}
          onClick={onPickerToggle}
          className={`rounded border px-2 py-1.5 text-xs disabled:opacity-40 ${pickerActive
            ? 'border-blue-400 bg-blue-600 text-white'
            : 'border-gray-600 bg-gray-900 text-gray-200 hover:border-gray-400'}`}
        >
          Пипетка
        </button>
        <button type="button" disabled={!available} onClick={onReset}
          className="ml-auto rounded px-2 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white disabled:opacity-40">
          Сброс
        </button>
      </div>
      <div className="grid gap-3">
        {([
          ['tolerance', 'Допуск'],
          ['softness', 'Мягкость'],
          ['spill', 'Ореол']
        ] as const).map(([key, label]) => (
          <label key={key} className="min-w-0 text-xs text-gray-400">
            <span className="mb-1 flex justify-between gap-2"><span>{label}</span><span className="tabular-nums text-gray-200">{Math.round(config[key])}</span></span>
            <input
              data-program-scene-chroma-control={key}
              type="range"
              min={0}
              max={100}
              step={1}
              value={config[key]}
              disabled={!available || !config.enabled}
              onChange={(event) => onChange({ [key]: Number(event.target.value) })}
              className="block w-full cursor-pointer accent-blue-500 disabled:cursor-not-allowed disabled:opacity-35"
            />
          </label>
        ))}
      </div>
      {!available && (
        <div className="mt-3 text-xs text-amber-300">Хромакей доступен только для камеры или платы видеозахвата.</div>
      )}
    </div>
  )
}

function captureIsUsedOutsideProgramScene(
  state: ReturnType<typeof useAppStore.getState>,
  sourceId: string
): boolean {
  return Object.values(state.channels).some(
    (channel) => channel.file?.capture?.sourceId === sourceId
  ) || state.selectedFile?.capture?.sourceId === sourceId ||
    state.activeFile?.capture?.sourceId === sourceId ||
    state.informationMedia?.capture?.sourceId === sourceId
}

export function ProgramSceneModal({ onClose, initialEditor }: Props): JSX.Element {
  const [activePanel, setActivePanel] = useState<'picture' | 'layers' | 'text' | 'titles' | 'qr'>('picture')
  const storedProgramScene = useAppStore((state) => state.programScene)
  const [textOverlayDraft, setTextOverlayDraft] = useState(() => (
    normalizeProgramSceneTextOverlays(storedProgramScene?.textOverlays)
  ))
  const [mediaLayerDraft, setMediaLayerDraft] = useState(() => (
    normalizeProgramSceneMediaLayers(storedProgramScene?.mediaLayers)
  ))
  const scenePlacement = PLACEMENTS.some((item) => item.value === storedProgramScene?.placement)
    ? storedProgramScene.placement
    : DEFAULT_PROGRAM_SCENE_LAYOUT.placement
  const sceneParticipantSize = SIZES.some((item) => item.value === storedProgramScene?.participantSize)
    ? storedProgramScene.participantSize
    : DEFAULT_PROGRAM_SCENE_LAYOUT.participantSize
  const sceneCornerStyle = CORNERS.some((item) => item.value === storedProgramScene?.cornerStyle)
    ? storedProgramScene.cornerStyle
    : DEFAULT_PROGRAM_SCENE_LAYOUT.cornerStyle
  const sceneParticipantScale = normalizeProgramSceneParticipantScale(
    storedProgramScene?.participantScale
  )
  const [participantScaleDraft, setParticipantScaleDraft] = useState(sceneParticipantScale)
  const [chromaColorPickerActive, setChromaColorPickerActive] = useState(false)
  const sceneTransitionEffect = TRANSITION_EFFECTS.some((item) => item.value === storedProgramScene?.transitionEffect)
    ? storedProgramScene.transitionEffect
    : DEFAULT_PROGRAM_SCENE_LAYOUT.transitionEffect ?? 'smooth'
  const programScene = {
    ...DEFAULT_PROGRAM_SCENE_LAYOUT,
    ...storedProgramScene,
    enabled: storedProgramScene?.enabled === true,
    captureSourceId: storedProgramScene?.captureSourceId ?? null,
    placement: scenePlacement,
    participantSize: sceneParticipantSize,
    participantScale: participantScaleDraft,
    cornerStyle: sceneCornerStyle,
    transitionEffect: sceneTransitionEffect,
    viewMode: storedProgramScene?.viewMode ?? 'both',
    textOverlays: textOverlayDraft,
    textOverlaysVisible: storedProgramScene?.textOverlaysVisible !== false,
    mediaLayers: mediaLayerDraft,
    mediaLayersVisible: storedProgramScene?.mediaLayersVisible === true,
    background: normalizeProgramSceneBackground(storedProgramScene?.background),
    chromaKey: normalizeProgramSceneChromaKey(storedProgramScene?.chromaKey)
  }
  const setProgramScene = useAppStore((state) => state.setProgramScene)
  const captureSources = useAppStore((state) => state.captureSources)
  const addCaptureSource = useAppStore((state) => state.addCaptureSource)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const activeFile = useAppStore((state) => state.activeFile)
  const currentSlide = useAppStore((state) => state.currentSlide)
  const selectedChannel = useAppStore((state) => state.selectedChannel)
  const setSelectedChannel = useAppStore((state) => state.setSelectedChannel)
  const selectedFile = useAppStore((state) => state.selectedFile)
  const channels = useAppStore((state) => state.channels)
  const channelIds = useAppStore((state) => state.channelIds)
  const pptxThumbnailsMap = useAppStore((state) => state.pptxThumbnailsMap)
  const pptxSlidesMap = useAppStore((state) => state.pptxSlidesMap)
  const pptxAspectRatios = useAppStore((state) => state.pptxAspectRatios)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const displays = useAppStore((state) => state.displays)
  const qrOverlay = useAppStore((state) => state.qrOverlay)
  const setQrOverlay = useAppStore((state) => state.setQrOverlay)
  const [devices, setDevices] = useState<CaptureDeviceDescriptor[]>([])
  const [devicesLoading, setDevicesLoading] = useState(true)
  const [devicesError, setDevicesError] = useState<string | null>(null)
  const [transitionPreviewRevision, setTransitionPreviewRevision] = useState(0)
  const [selectedTextOverlayId, setSelectedTextOverlayId] = useState<string | null>(
    () => programScene.textOverlays[0]?.id ?? null
  )
  const [selectedMediaLayerId, setSelectedMediaLayerId] = useState<string | null>(
    () => programScene.mediaLayers.at(-1)?.id ?? null
  )
  const [canvasSelection, setCanvasSelection] = useState<CanvasSelection>(
    initialEditor === 'qr' ? { kind: 'qr' } : null
  )
  const [sceneContextMenu, setSceneContextMenu] = useState<SceneContextMenuState | null>(null)
  const [previewChannelId, setPreviewChannelId] = useState<string | null>(null)
  const previewCanvasRef = useRef<HTMLDivElement>(null)
  const contentPreviewRef = useRef<HTMLDivElement>(null)
  const participantPreviewRef = useRef<HTMLDivElement>(null)
  const [measuredContentFrame, setMeasuredContentFrame] = useState<{
    aspectRatio: number
    widthPercent: number
    heightPercent: number
  } | null>(null)
  const lastPublishedQrRef = useRef(JSON.stringify(qrOverlay))
  const requestGenerationRef = useRef(0)
  const videoDevices = useMemo(
    () => devices.filter((device) => device.kind === 'videoinput'),
    [devices]
  )
  const selectedCapture = captureSources.find(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )?.capture ?? null
  const chromaAvailable = selectedCapture?.captureKind === 'device'
  const sceneAudio = normalizeProgramSceneAudio(storedProgramScene.audio)
  const audioDevices = devices.filter((device) => device.kind === 'audioinput')
  const [audioStatus, setAudioStatus] = useState<ProgramSceneAudioStatus>({ phase: 'idle', message: '' })

  const updateChromaKey = (update: Partial<ProgramSceneChromaKeyConfig>): void => {
    setProgramScene({
      chromaKey: normalizeProgramSceneChromaKey({ ...programScene.chromaKey, ...update })
    })
  }

  useEffect(() => {
    if (!chromaAvailable) setChromaColorPickerActive(false)
  }, [chromaAvailable])

  useEffect(() => {
    const participant = participantPreviewRef.current
    if (!participant) return
    const changeCameraHeight = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      event.preventDefault()
      event.stopPropagation()
      const step = event.deltaY < 0 ? 0.05 : -0.05
      const current = normalizeProgramSceneParticipantScale(
        useAppStore.getState().programScene.participantScale
      )
      const next = normalizeProgramSceneParticipantScale(current + step)
      setParticipantScaleDraft(next)
      setProgramScene({ participantScale: next })
    }
    participant.addEventListener('wheel', changeCameraHeight, { passive: false })
    return () => participant.removeEventListener('wheel', changeCameraHeight)
  }, [setProgramScene])
  const selectedChannelState = selectedChannel ? channels[selectedChannel] : null
  const previewChannelState = previewChannelId ? channels[previewChannelId] : null
  const previewableContentChannels = channelIds.flatMap((id) => {
    const channel = channels[id]
    if (!canPreviewSceneContent(channel?.file)) return []
    return [{ id, channel, file: channel.file }]
  })
  const candidatePreviewFile = previewChannelState?.file || activeFile || selectedChannelState?.file || selectedFile
  const previewFile = canPreviewSceneContent(candidatePreviewFile) ? candidatePreviewFile : null
  const previewSlide = previewFile && previewChannelState?.file?.path === previewFile.path
    ? previewChannelState.slide
    : previewFile && activeFile?.path === previewFile.path
      ? currentSlide
      : previewFile && selectedChannelState?.file?.path === previewFile.path
        ? selectedChannelState.slide
        : 1
  const previewPptxThumbnails = previewFile?.type === 'presentation'
    ? pptxSlidesMap[previewFile.path] || pptxThumbnailsMap[previewFile.path] || []
    : []
  useEffect(() => {
    setMeasuredContentFrame(null)
    const root = contentPreviewRef.current
    if (!root || !previewFile) return
    const readAspectRatio = (): void => {
      const media = root.querySelector<HTMLImageElement | HTMLCanvasElement | HTMLVideoElement>('img, canvas, video')
      if (!media) return
      const width = media instanceof HTMLImageElement
        ? media.naturalWidth
        : media instanceof HTMLVideoElement
          ? media.videoWidth
          : media.width
      const height = media instanceof HTMLImageElement
        ? media.naturalHeight
        : media instanceof HTMLVideoElement
          ? media.videoHeight
          : media.height
      const ratio = width / height
      const canvasRect = previewCanvasRef.current?.getBoundingClientRect()
      const mediaRect = media.getBoundingClientRect()
      if (Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 5 && canvasRect?.width && canvasRect.height) {
        const next = {
          aspectRatio: ratio,
          widthPercent: mediaRect.width / canvasRect.width * 100,
          heightPercent: mediaRect.height / canvasRect.height * 100
        }
        setMeasuredContentFrame((current) => !current ||
          Math.abs(current.aspectRatio - next.aspectRatio) > 0.001 ||
          Math.abs(current.widthPercent - next.widthPercent) > 0.1 ||
          Math.abs(current.heightPercent - next.heightPercent) > 0.1
          ? next
          : current)
      }
    }
    const observer = new MutationObserver(readAspectRatio)
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['width', 'height', 'src'] })
    root.addEventListener('load', readAspectRatio, true)
    readAspectRatio()
    return () => {
      observer.disconnect()
      root.removeEventListener('load', readAspectRatio, true)
    }
  }, [previewFile?.path, previewSlide])
  const outputDisplay = displays.find(
    (display) => !display.isPrimary && display.id === selectedDisplayId
  ) ?? displays.find((display) => !display.isPrimary)
  const outputWidth = Math.max(1, outputDisplay?.bounds?.width ?? 1920)
  const outputHeight = Math.max(1, outputDisplay?.bounds?.height ?? 1080)
  const selectedCaptureMatchesContent = candidatePreviewFile?.type === 'capture' &&
    candidatePreviewFile.capture?.sourceId === selectedCapture?.sourceId
  const backgroundSource = resolveProgramSceneBackground(useAppStore.getState())
  const backgroundChannel = programScene.background.channelId
    ? channels[programScene.background.channelId] ?? null
    : null
  const backgroundCaptureMatchesParticipant = backgroundSource?.type === 'capture' &&
    backgroundSource.capture.sourceId === selectedCapture?.sourceId
  const canEnable = !!backgroundSource &&
    (!selectedCapture || (!selectedCaptureMatchesContent && !backgroundCaptureMatchesParticipant))
  const participantOnLeft = programScene.placement.startsWith('left-')
  const vertical = programScene.placement.split('-')[1]
  const participantBaseWidthPercent = programScene.participantSize === 'small'
    ? 20
    : programScene.participantSize === 'large'
      ? 33
      : programScene.participantSize === 'half'
        ? 44.5
        : 26
  const participantWidthPercent = participantBaseWidthPercent
  const participantWidth = `${participantWidthPercent}%`
  const contentAreaLeftPercent = participantOnLeft ? 4 + participantWidthPercent + 3 : 4
  const contentAreaWidthPercent = 89 - participantWidthPercent
  const storedContentAspectRatio = previewFile?.type === 'presentation'
    ? pptxAspectRatios[previewFile.path] ?? null
    : null
  const contentAspectRatio = measuredContentFrame?.aspectRatio ?? storedContentAspectRatio ?? 16 / 9
  const previewCanvasAspectRatio = 16 / 9
  const fittedContentWidthPercent = Math.min(
    contentAreaWidthPercent,
    88 * contentAspectRatio / previewCanvasAspectRatio
  )
  const contentWidthPercent = fittedContentWidthPercent
  const contentHeightPercent = contentWidthPercent * previewCanvasAspectRatio / contentAspectRatio
  const contentLeftPercent = contentAreaLeftPercent + (contentAreaWidthPercent - contentWidthPercent) / 2
  const previewRadius = programScene.cornerStyle === 'rounded' ? '0.75rem' : 0
  const previewEffectVariant = transitionPreviewRevision % 2 === 0 ? 'a' : 'b'
  const previewAnimationName = programScene.transitionEffect === 'smooth'
    ? `pdm-scene-smooth-${previewEffectVariant}`
    : programScene.transitionEffect === 'zoom-fade'
      ? `pdm-scene-zoom-fade-${previewEffectVariant}`
      : null
  const previewAnimationStyle = transitionPreviewRevision > 0 && previewAnimationName
    ? { animation: `${previewAnimationName} ${PROGRAM_SCENE_TRANSITION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) backwards` }
    : undefined

  const selectTransitionEffect = (effect: ProgramSceneTransitionEffect): void => {
    setProgramScene({ transitionEffect: effect })
    setTransitionPreviewRevision((revision) => revision + 1)
  }

  const updateTextOverlayPosition = (id: string, xPercent: number, yPercent: number): void => {
    updateTextOverlays(programScene.textOverlays.map((overlay) => (
      overlay.id === id ? { ...overlay, xPercent, yPercent } : overlay
    )))
  }

  useEffect(() => {
    if (previewChannelId && !canPreviewSceneContent(channels[previewChannelId]?.file)) {
      setPreviewChannelId(null)
    }
  }, [channels, previewChannelId])

  const updateTextOverlays = (textOverlays: typeof programScene.textOverlays): void => {
    const normalized = normalizeProgramSceneTextOverlays(textOverlays)
    setTextOverlayDraft(normalized)
  }

  const updateMediaLayers = (mediaLayers: typeof programScene.mediaLayers): void => {
    const normalized = normalizeProgramSceneMediaLayers(mediaLayers)
    setMediaLayerDraft(normalized)
    if (selectedMediaLayerId && !normalized.some((layer) => layer.id === selectedMediaLayerId)) {
      setSelectedMediaLayerId(normalized.at(-1)?.id ?? null)
    }
  }

  const updateMediaLayer = (id: string, update: Partial<(typeof programScene.mediaLayers)[number]>): void => {
    updateMediaLayers(programScene.mediaLayers.map((layer) => layer.id === id ? { ...layer, ...update } : layer))
  }

  const closeModal = (): void => {
    // PiP settings historically apply when the window closes. While live
    // preview is off, the draft stays local during editing and is committed
    // once at the end instead of exposing every intermediate movement.
    setProgramScene({ textOverlays: textOverlayDraft, mediaLayers: mediaLayerDraft })
    onClose()
  }

  useEffect(() => {
    // The shared scene canvas is an editor. Keep QR movement and styling local
    // until the operator explicitly shows it or closes the Scene window.
    setQrEditorOutputOwned(true)
    return () => {
      const config = useAppStore.getState().qrOverlay
      setQrEditorOutputOwned(false)
      void publishQrOverlay(config, () => !isQrEditorOutputOwned())
    }
  }, [])

  useEffect(() => {
    if (!sceneContextMenu) return
    const dismiss = (): void => setSceneContextMenu(null)
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [sceneContextMenu])

  useEffect(() => {
    // Builds before sceneOnly existed stored scene-picked devices in the
    // general capture library. Hide such a device when it has never been used
    // independently in a channel, on air, or on an information display.
    const state = useAppStore.getState()
    const sourceId = state.programScene.captureSourceId
    if (!sourceId) return
    const entry = state.captureSources.find((source) => source.capture?.sourceId === sourceId)
    if (
      !entry ||
      entry.sceneOnly ||
      !entry.capture || entry.capture.captureKind !== 'device' ||
      captureIsUsedOutsideProgramScene(state, sourceId)
    ) return
    addCaptureSource({ ...entry, sceneOnly: true })
  }, [addCaptureSource])

  const loadDevices = useCallback((includeAudio = false): void => {
    const generation = ++requestGenerationRef.current
    const requestId = `program-scene-devices-${crypto.randomUUID()}`
    setDevicesLoading(true)
    setDevicesError(null)
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = (): void => {}
    const finish = (response?: DeviceResponse): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      unsubscribe()
      if (generation !== requestGenerationRef.current) return
      setDevicesLoading(false)
      setDevices(response?.devices ?? [])
      setDevicesError(response?.error || (!response ? 'Не удалось получить список устройств.' : null))
    }
    unsubscribe = window.api.on('capture-devices-response', (...args: unknown[]) => {
      const response = args[0] as DeviceResponse
      if (response?.requestId === requestId) finish(response)
    })
    timeout = setTimeout(() => finish(), 15_000)
    window.api.sendToPresentation('capture-devices-request', { requestId, includeAudio })
  }, [])

  useEffect(() => {
    loadDevices()
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribeDevices = window.api.on('capture-devices-changed', () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(loadDevices, 350)
    })
    const unsubscribeHub = window.api.on('capture-hub-ready', () => loadDevices())
    return () => {
      requestGenerationRef.current += 1
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubscribeDevices()
      unsubscribeHub()
    }
  }, [loadDevices])

  useEffect(() => {
    const unsubscribe = window.api.on('program-scene-audio-status', (...args: unknown[]) => {
      const status = args[0] as ProgramSceneAudioStatus | undefined
      if (status && ['idle', 'starting', 'live', 'error'].includes(status.phase)) setAudioStatus(status)
    })
    window.api.sendToPresentation('program-scene-audio-status-request')
    return unsubscribe
  }, [])

  const selectedOption = selectedCapture?.captureKind === 'desktop'
    ? `source:${selectedCapture.sourceId}`
    : selectedCapture?.videoDeviceId
      ? `device:${selectedCapture.videoDeviceId}`
      : ''
  const effectiveEditorPanel = activePanel === 'picture' && canvasSelection
    ? canvasSelection.kind === 'media'
      ? 'layers'
      : canvasSelection.kind === 'text'
        ? 'text'
        : canvasSelection.kind === 'qr'
          ? 'qr'
          : 'chroma'
    : activePanel
  const layerControlPanel = effectiveEditorPanel === 'layers' || effectiveEditorPanel === 'text'
    ? effectiveEditorPanel
    : 'picture'
  const sceneDraftDirty = JSON.stringify(textOverlayDraft) !== JSON.stringify(
    normalizeProgramSceneTextOverlays(storedProgramScene.textOverlays)
  ) || JSON.stringify(mediaLayerDraft) !== JSON.stringify(
    normalizeProgramSceneMediaLayers(storedProgramScene.mediaLayers)
  ) || JSON.stringify(qrOverlay) !== lastPublishedQrRef.current

  const selectBackdrop = async (): Promise<void> => {
    const path = await window.api.selectBackdropImage()
    if (!path) return
    const state = useAppStore.getState()
    state.setBackdropImage(path)
    state.setProgramScene({
      background: normalizeProgramSceneBackground({
        ...state.programScene.background,
        kind: 'image'
      })
    })
    // Match the toolbar behaviour: if nothing is on air, the chosen backdrop
    // becomes the idle program picture immediately while this modal stays open.
    if (!state.activeFile) {
      await window.api.switchAudioToExternal()
      if (!state.isPresentationWindowOpen) {
        await window.api.openPresentationWindow(state.selectedDisplayId ?? undefined)
        state.setPresentationWindowOpen(true)
      }
      window.api.sendToPresentation('load-content', {
        type: 'backdrop',
        path,
        name: 'Backdrop'
      })
    }
  }

  const selectBackgroundVideo = async (): Promise<void> => {
    const paths = await window.api.selectVideoFiles()
    const path = paths?.[0]
    if (!path) return
    const state = useAppStore.getState()
    state.setProgramScene({
      background: normalizeProgramSceneBackground({
        ...state.programScene.background,
        kind: 'video',
        videoPath: path
      })
    })
  }

  const addTextAt = (xPercent = 10, yPercent = 10): void => {
    const id = `text-${crypto.randomUUID()}`
    const widthPercent = 34
    updateTextOverlays([...programScene.textOverlays, {
      id,
      text: 'Новый текст',
      visible: true,
      xPercent: Math.max(0, Math.min(100 - widthPercent, xPercent)),
      yPercent: Math.max(0, Math.min(90, yPercent)),
      widthPercent,
      fontFamily: 'arial',
      fontSizePercent: 4,
      color: '#ffffff'
    }])
    setSelectedTextOverlayId(id)
    setCanvasSelection({ kind: 'text', id })
    setActivePanel('picture')
  }

  const addImageLayer = async (position?: { xPercent: number; yPercent: number }): Promise<void> => {
    const path = await window.api.selectBackdropImage()
    if (!path) return
    const id = `media-${crypto.randomUUID()}`
    updateMediaLayers([...programScene.mediaLayers, {
      id,
      kind: 'image',
      path,
      name: shortFileName(path) || 'Картинка',
      xPercent: position?.xPercent ?? 50,
      yPercent: position?.yPercent ?? 50,
      widthPercent: 38,
      aspectRatio: 16 / 9,
      aboveContent: true,
      visible: true,
      loop: true,
      muted: true
    }])
    setSelectedMediaLayerId(id)
    setCanvasSelection({ kind: 'media', id })
  }

  const addVideoLayers = async (position?: { xPercent: number; yPercent: number }): Promise<void> => {
    const paths = await window.api.selectVideoFiles()
    if (!paths?.length) return
    const added = paths.map((path) => ({
      id: `media-${crypto.randomUUID()}`,
      kind: 'video' as const,
      path,
      name: shortFileName(path) || 'Видео',
      xPercent: position?.xPercent ?? 50,
      yPercent: position?.yPercent ?? 50,
      widthPercent: 42,
      aspectRatio: 16 / 9,
      aboveContent: true,
      visible: true,
      loop: true,
      muted: true
    }))
    updateMediaLayers([...programScene.mediaLayers, ...added])
    const selectedId = added.at(-1)?.id ?? null
    setSelectedMediaLayerId(selectedId)
    if (selectedId) setCanvasSelection({ kind: 'media', id: selectedId })
  }

  const selectBackgroundKind = (kind: ProgramSceneBackgroundKind): void => {
    setProgramScene({
      background: normalizeProgramSceneBackground({
        ...programScene.background,
        kind
      })
    })
  }

  const publishSceneDraft = async (enableScene = false): Promise<void> => {
    setProgramScene({
      ...(enableScene ? { enabled: true, viewMode: 'both' as const } : {}),
      textOverlays: textOverlayDraft,
      mediaLayers: mediaLayerDraft,
      ...(enableScene && textOverlayDraft.length > 0 ? { textOverlaysVisible: true } : {}),
      ...(enableScene && mediaLayerDraft.some((layer) => layer.visible) ? { mediaLayersVisible: true } : {})
    })
    const currentQr = useAppStore.getState().qrOverlay
    const nextQr = currentQr.sceneVisible !== false && hasQrData(currentQr)
      ? normalizeQrOverlay({ ...currentQr, enabled: true })
      : currentQr
    if (nextQr !== currentQr) setQrOverlay({ enabled: true })
    const state = useAppStore.getState()
    const channelToTake = enableScene
      ? previewChannelId || (!state.activeFile ? state.selectedChannel : null)
      : null
    const channelFile = channelToTake ? state.channels[channelToTake]?.file : null
    if (channelToTake && channelFile && state.activeFile?.path !== channelFile.path) {
      window.dispatchEvent(new CustomEvent('take-channel', { detail: channelToTake }))
    } else if (enableScene && !state.activeFile && !state.isPresentationWindowOpen) {
      await window.api.openPresentationWindow(state.selectedDisplayId ?? undefined)
      state.setPresentationWindowOpen(true)
      window.api.setActiveContentType('backdrop')
    }
    lastPublishedQrRef.current = JSON.stringify(nextQr)
    await publishQrOverlay(nextQr, () => isQrEditorOutputOwned())
  }

  const setPictureVisible = async (pressed: boolean): Promise<void> => {
    if (!pressed) {
      window.dispatchEvent(new CustomEvent('close-program-output'))
      return
    }
    await publishSceneDraft(true)
  }

  const selectExternalSource = (value: string): void => {
    if (!value) {
      setProgramScene({ captureSourceId: null })
      return
    }
    if (value.startsWith('source:')) {
      const sourceId = value.slice('source:'.length)
      setProgramScene({ captureSourceId: sourceId })
      return
    }
    const deviceId = value.slice('device:'.length)
    const device = videoDevices.find((candidate) => candidate.deviceId === deviceId)
    if (!device) return
    const existing = captureSources.find(
      (entry) => entry.capture?.captureKind === 'device' && entry.capture.videoDeviceId === device.deviceId
    )
    if (existing?.capture) {
      const state = useAppStore.getState()
      if (!captureIsUsedOutsideProgramScene(state, existing.capture.sourceId)) {
        addCaptureSource({ ...existing, sceneOnly: true })
      }
      setProgramScene({ captureSourceId: existing.capture.sourceId })
      return
    }
    const sourceId = `capture-${crypto.randomUUID()}`
    const capture: CaptureSourceConfig = {
      sourceId,
      captureKind: 'device',
      videoDeviceId: device.deviceId,
      videoLabel: device.label,
      videoGroupId: device.groupId || undefined,
      audioEnabled: false
    }
    const entry: FileEntry = {
      id: sourceId,
      name: device.label,
      path: `capture://${sourceId}`,
      type: 'capture',
      extension: 'LIVE',
      size: 0,
      sceneOnly: true,
      capture
    }
    addCaptureSource(entry)
    window.api.sendToPresentation('capture-source-register', capture)
    setProgramScene({ captureSourceId: sourceId })
  }

  const selectExternalSourceFromScene = (value: string): void => {
    selectExternalSource(value)
    setCanvasSelection(null)
    setActivePanel('picture')
    setSceneContextMenu(null)
  }

  const openExternalSourceMenu = (event: React.MouseEvent<HTMLElement>): void => {
    event.stopPropagation()
    const canvasRect = previewCanvasRef.current?.getBoundingClientRect()
    if (!canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0) return
    setCanvasSelection(null)
    setSceneContextMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      xPercent: (event.clientX - canvasRect.left) / canvasRect.width * 100,
      yPercent: (event.clientY - canvasRect.top) / canvasRect.height * 100,
      chooserOnly: true,
      target: { kind: 'external' }
    })
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-black/70 p-2" onMouseDown={closeModal}>
      <div
        data-program-scene-modal
        className="flex h-[576px] max-h-[96dvh] w-[1040px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-gray-700 bg-surface-300 p-3 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="mb-2 flex shrink-0 items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Сцена</h2>
          </div>
          <button className="text-xl leading-none text-gray-400 hover:text-white" onClick={closeModal}>×</button>
        </div>

        <div className="mb-3 grid shrink-0 grid-cols-2 gap-1 rounded-lg bg-surface-200 p-1" role="tablist" aria-label="Разделы сцены">
          {([
            ['picture', 'Сцена для эфира'],
            ['titles', 'Титры']
          ] as const).map(([panel, label]) => (
            <button
              key={panel}
              type="button"
              role="tab"
              aria-selected={activePanel === panel}
              data-scene-panel={panel}
              onClick={() => {
                setActivePanel(panel)
                setSceneContextMenu(null)
                if (panel === 'picture') setCanvasSelection(null)
              }}
              className={`rounded-md py-1.5 text-xs font-medium transition-colors ${activePanel === panel
                ? 'bg-blue-600 text-white'
                : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {activePanel !== 'titles' && effectiveEditorPanel !== 'qr' && (
          <SceneLayerControlBar
            active={layerControlPanel === 'picture'
              ? programScene.enabled
              : layerControlPanel === 'layers'
                ? programScene.mediaLayersVisible
                : programScene.textOverlaysVisible}
            status={layerControlPanel === 'picture'
              ? programScene.enabled ? 'Сцена в эфире' : 'Сцена скрыта'
              : layerControlPanel === 'layers'
                ? programScene.mediaLayersVisible ? 'Слои в эфире' : 'Слои скрыты'
              : programScene.textOverlaysVisible ? 'Текст в эфире' : 'Текст скрыт'}
            detail={layerControlPanel === 'picture'
              ? programScene.enabled && sceneDraftDirty
                ? 'Есть изменения — нажмите ↻'
                : !backgroundSource
                ? 'Выберите фоновое изображение'
                : !selectedCapture
                  ? 'Сцена готова без внешнего источника'
                  : selectedCaptureMatchesContent
                    ? 'Выберите источник, отличный от основного'
                    : backgroundCaptureMatchesParticipant
                      ? 'Камера участника и нижний слой должны отличаться'
                    : 'Слой подготовлен'
              : layerControlPanel === 'layers'
                ? programScene.mediaLayers.length > 0
                  ? `${programScene.mediaLayers.length} медиаслоёв`
                  : 'Добавьте картинку или видео'
              : programScene.textOverlays.length > 0
                ? `${programScene.textOverlays.length} текстовых блоков`
                : 'Добавьте текстовый блок'}
          >
            {layerControlPanel === 'picture' ? (
              <>
              <SceneLayerToggleButton
                buttonProps={{ 'data-program-scene-picture-visible': true }}
                tone="air"
                pressed={programScene.enabled}
                disabled={!canEnable && !programScene.enabled}
                title={canEnable || programScene.enabled ? 'Показывать или скрывать Сцену для эфира' : 'Выберите фоновое изображение'}
                onPressedChange={(pressed) => void setPictureVisible(pressed)}
              >
                {programScene.enabled ? 'Выйти из эфира' : 'Показать в эфире'}
              </SceneLayerToggleButton>
              <button
                type="button"
                data-program-scene-refresh
                aria-label="Обновить сцену в эфире"
                title={programScene.enabled
                  ? 'Передать в эфир изменения из предпросмотра'
                  : 'Сначала покажите сцену в эфире'}
                disabled={!programScene.enabled}
                onClick={() => void publishSceneDraft(false)}
                className={`flex h-7 w-7 items-center justify-center rounded-full border text-base font-bold leading-none transition-colors ${!programScene.enabled
                  ? 'cursor-not-allowed border-gray-800 bg-surface-100 text-gray-600'
                  : sceneDraftDirty
                    ? 'border-blue-300 bg-blue-600 text-white shadow-[0_0_10px_rgba(37,99,235,.45)] hover:bg-blue-500'
                    : 'border-gray-600 bg-surface-100 text-gray-300 hover:border-blue-400 hover:bg-blue-700 hover:text-white'}`}
              >
                ↻
              </button>
              </>
            ) : layerControlPanel === 'layers' ? (
              <>
                <SceneLayerToggleButton
                  buttonProps={{ 'data-program-scene-media-visible': true }}
                  tone="air"
                  pressed={programScene.mediaLayersVisible}
                  disabled={programScene.mediaLayers.length === 0 && !programScene.mediaLayersVisible}
                  title="Показывать или скрывать все медиаслои в эфире"
                  onPressedChange={(pressed) => setProgramScene(pressed
                    ? { mediaLayersVisible: true, mediaLayers: mediaLayerDraft }
                    : { mediaLayersVisible: false })}
                >
                  {programScene.mediaLayersVisible ? 'Выйти из эфира' : 'Показать в эфире'}
                </SceneLayerToggleButton>
                <button
                  type="button"
                  data-program-scene-refresh
                  aria-label="Обновить сцену в эфире"
                  title={programScene.enabled ? 'Передать в эфир изменения из предпросмотра' : 'Сначала покажите сцену в эфире'}
                  disabled={!programScene.enabled}
                  onClick={() => void publishSceneDraft(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-600 bg-surface-100 text-base font-bold leading-none text-gray-300 transition-colors hover:border-blue-400 hover:bg-blue-700 hover:text-white disabled:cursor-not-allowed disabled:border-gray-800 disabled:text-gray-600"
                >↻</button>
              </>
            ) : (
              <>
                <SceneLayerToggleButton
                  buttonProps={{ 'data-program-scene-text-visible': true }}
                  tone="air"
                  pressed={programScene.textOverlaysVisible}
                  title="Показывать или скрывать все текстовые блоки в эфире"
                  onPressedChange={(pressed) => setProgramScene(pressed
                    ? { textOverlaysVisible: true, textOverlays: textOverlayDraft }
                    : { textOverlaysVisible: false })}
                >
                  {programScene.textOverlaysVisible ? 'Выйти из эфира' : 'Показать в эфире'}
                </SceneLayerToggleButton>
                <button
                  type="button"
                  data-program-scene-refresh
                  aria-label="Обновить сцену в эфире"
                  title={programScene.enabled ? 'Передать в эфир изменения из предпросмотра' : 'Сначала покажите сцену в эфире'}
                  disabled={!programScene.enabled}
                  onClick={() => void publishSceneDraft(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-600 bg-surface-100 text-base font-bold leading-none text-gray-300 transition-colors hover:border-blue-400 hover:bg-blue-700 hover:text-white disabled:cursor-not-allowed disabled:border-gray-800 disabled:text-gray-600"
                >↻</button>
              </>
            )}
          </SceneLayerControlBar>
        )}

        <div
          data-scene-editor="picture-text"
          hidden={activePanel === 'titles'}
          className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)] gap-3"
        >
          <section className="min-h-0">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs text-gray-300">Предпросмотр</span>
        </div>
        <div
          ref={previewCanvasRef}
          data-program-scene-preview
          className="relative mb-2 aspect-video overflow-hidden rounded-lg border border-gray-700 bg-gray-950"
          style={{
            width: `min(100%, calc(max(64px, 100dvh - ${devicesError ? 430 : 390}px) * 16 / 9))`,
            marginInline: 'auto'
          }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setCanvasSelection(null)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) return
            const target = event.target instanceof Element ? event.target : null
            const textObject = target?.closest<HTMLElement>('[data-program-scene-text-id]')
            const mediaObject = target?.closest<HTMLElement>('[data-program-scene-media-id]')
            const qrObject = target?.closest<HTMLElement>('[data-scene-qr-object]')
            let contextTarget: SceneContextMenuState['target'] = { kind: 'canvas' }
            if (textObject?.dataset.programSceneTextId) {
              const id = textObject.dataset.programSceneTextId
              setSelectedTextOverlayId(id)
              setCanvasSelection({ kind: 'text', id })
              contextTarget = { kind: 'text', id }
            } else if (mediaObject?.dataset.programSceneMediaId) {
              const id = mediaObject.dataset.programSceneMediaId
              setSelectedMediaLayerId(id)
              setCanvasSelection({ kind: 'media', id })
              contextTarget = { kind: 'media', id }
            } else if (qrObject) {
              setCanvasSelection({ kind: 'qr' })
              contextTarget = { kind: 'qr' }
            } else {
              setCanvasSelection(null)
              const containsPoint = (element: Element | null): boolean => {
                if (!element) return false
                const bounds = element.getBoundingClientRect()
                return event.clientX >= bounds.left && event.clientX <= bounds.right &&
                  event.clientY >= bounds.top && event.clientY <= bounds.bottom
              }
              const participant = event.currentTarget.querySelector('[data-program-scene-participant-preview]')
              const content = event.currentTarget.querySelector('.pdm-pip-content-preview')
              if (containsPoint(participant)) {
                contextTarget = { kind: 'external' }
              } else if (containsPoint(content)) {
                contextTarget = { kind: 'content' }
              } else if (backgroundSource && !containsPoint(content)) {
                contextTarget = { kind: 'background' }
              }
            }
            setSceneContextMenu({
              clientX: event.clientX,
              clientY: event.clientY,
              xPercent: (event.clientX - rect.left) / rect.width * 100,
              yPercent: (event.clientY - rect.top) / rect.height * 100,
              target: contextTarget
            })
          }}
        >
          {backdropImage && (
            <img
              data-program-scene-canvas-background
              src={mediaUrl(backdropImage)}
              alt="Фон сцены"
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
              draggable={false}
            />
          )}
          <ProgramSceneMediaLayerSurface
            layers={programScene.mediaLayers}
            placement="below"
            interactive={activePanel === 'picture' || activePanel === 'layers'}
            selectedId={selectedMediaLayerId}
            onSelect={(id) => {
              setSelectedMediaLayerId(id)
              setCanvasSelection({ kind: 'media', id })
            }}
            onMove={(id, xPercent, yPercent) => updateMediaLayer(id, { xPercent, yPercent })}
            onScale={(id, widthPercent) => updateMediaLayer(id, { widthPercent })}
            onAspectRatio={(id, aspectRatio) => updateMediaLayer(id, { aspectRatio })}
          />
          <div
            ref={contentPreviewRef}
            className={`pdm-pip-content-preview absolute flex items-center justify-center text-[11px] font-semibold text-gray-800 shadow-xl overflow-hidden ${activePanel === 'picture' || activePanel === 'layers' ? 'pointer-events-none' : ''} ${previewFile ? 'bg-transparent' : 'bg-white/90'}`}
            style={{
              width: `${contentWidthPercent}%`,
              height: `${contentHeightPercent}%`,
              left: `${contentLeftPercent}%`,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 2,
              borderRadius: previewRadius,
              '--pdm-pip-preview-radius': typeof previewRadius === 'number' ? `${previewRadius}px` : previewRadius
            } as React.CSSProperties}
          >
            <div className="flex h-full w-full items-center justify-center" style={previewAnimationStyle}>
              {previewFile ? (
                <SlideRenderer
                  file={previewFile}
                  slideNum={previewSlide}
                  pptxThumbnails={previewPptxThumbnails}
                  onTotalSlides={() => undefined}
                  onAspectRatio={(aspectRatio) => {
                    setMeasuredContentFrame((current) => current && Math.abs(current.aspectRatio - aspectRatio) <= 0.001
                      ? current
                      : { aspectRatio, widthPercent: 0, heightPercent: 0 })
                  }}
                />
              ) : (
                <button
                  type="button"
                  data-program-scene-select-content
                  className="pointer-events-auto rounded-md border border-gray-400/60 bg-white/80 px-3 py-2 text-[10px] font-semibold text-gray-600 hover:border-blue-500 hover:bg-blue-50 hover:text-blue-700"
                  title="Выбрать презентацию или другой материал из канала"
                  onClick={(event) => {
                    event.stopPropagation()
                    const canvasRect = previewCanvasRef.current?.getBoundingClientRect()
                    if (!canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0) return
                    setCanvasSelection(null)
                    setSceneContextMenu({
                      clientX: event.clientX,
                      clientY: event.clientY,
                      xPercent: (event.clientX - canvasRect.left) / canvasRect.width * 100,
                      yPercent: (event.clientY - canvasRect.top) / canvasRect.height * 100,
                      chooserOnly: true,
                      target: { kind: 'content' }
                    })
                  }}
                >
                  ПРЕЗЕНТАЦИЯ НЕ ВЫБРАНА
                </button>
              )}
            </div>
          </div>
          <div
            ref={participantPreviewRef}
            data-program-scene-participant-preview
            onClick={(event) => {
              if (selectedCapture && !chromaColorPickerActive) openExternalSourceMenu(event)
            }}
            className={`absolute bg-slate-700 text-center text-[10px] text-white shadow-xl flex items-center justify-center overflow-hidden ${activePanel === 'picture' ? 'cursor-pointer' : ''}`}
            title={selectedCapture ? 'Нажмите, чтобы выбрать внешний источник; колесо меняет высоту камеры' : undefined}
            style={{
              width: participantWidth,
              aspectRatio: `16 / ${9 * programScene.participantScale}`,
              left: participantOnLeft ? '4%' : undefined,
              right: participantOnLeft ? undefined : '4%',
              top: vertical === 'top' ? '10%' : vertical === 'center' ? '50%' : undefined,
              bottom: vertical === 'bottom' ? '10%' : undefined,
              transform: vertical === 'center' ? 'translateY(-50%)' : undefined,
              zIndex: 4,
              borderRadius: previewRadius
            }}
          >
            <div data-program-scene-key-fill-preview className="absolute inset-0 flex items-center justify-center overflow-hidden bg-black">
              {backgroundSource?.type === 'image' && (
                <img
                  src={mediaUrl(backgroundSource.path)}
                  alt="Заполнение хромакея"
                  className="absolute inset-0 h-full w-full object-cover"
                  draggable={false}
                />
              )}
              {backgroundSource?.type === 'video' && (
                <video
                  key={backgroundSource.path}
                  src={mediaUrl(backgroundSource.path)}
                  autoPlay
                  playsInline
                  loop={backgroundSource.loop}
                  muted={backgroundSource.muted}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
              {backgroundSource?.type === 'pdf' && backgroundChannel?.file && (
                <div className="absolute inset-0 flex items-center justify-center bg-black">
                  <SlideRenderer
                    file={backgroundChannel.file}
                    slideNum={backgroundSource.slide}
                    pptxThumbnails={[]}
                    onTotalSlides={() => undefined}
                  />
                </div>
              )}
              {backgroundSource?.type === 'capture' && (
                <CaptureThumbnail
                  config={backgroundSource.capture}
                  className="absolute inset-0 h-full w-full"
                  fit="cover"
                />
              )}
            </div>
            <div className="relative z-[1] flex h-full w-full items-center justify-center" style={previewAnimationStyle}>
              {selectedCapture ? (
                <CaptureThumbnail
                  config={selectedCapture}
                  className="h-full w-full"
                  chromaKey={programScene.chromaKey}
                  colorPickerActive={chromaColorPickerActive}
                  onColorPick={(color) => {
                    updateChromaKey({ color, enabled: true })
                    setChromaColorPickerActive(false)
                  }}
                  fit={selectedCapture.captureKind === 'desktop'
                    ? 'contain'
                    : 'cover'}
                />
              ) : (
                <button
                  type="button"
                  data-program-scene-select-external-source
                  onClick={openExternalSourceMenu}
                  className="relative z-[2] rounded-md border border-white/30 bg-black/35 px-3 py-2 text-[10px] font-semibold text-white hover:border-blue-300 hover:bg-blue-600"
                >
                  Выберите внешний источник
                </button>
              )}
            </div>
          </div>
          <ProgramSceneMediaLayerSurface
            layers={programScene.mediaLayers}
            placement="above"
            interactive={activePanel === 'picture' || activePanel === 'layers'}
            selectedId={selectedMediaLayerId}
            onSelect={(id) => {
              setSelectedMediaLayerId(id)
              setCanvasSelection({ kind: 'media', id })
            }}
            onMove={(id, xPercent, yPercent) => updateMediaLayer(id, { xPercent, yPercent })}
            onScale={(id, widthPercent) => updateMediaLayer(id, { widthPercent })}
            onAspectRatio={(id, aspectRatio) => updateMediaLayer(id, { aspectRatio })}
          />
          <ProgramSceneTextOverlayLayer
            overlays={programScene.textOverlays}
            interactive={activePanel === 'picture' || activePanel === 'text'}
            selectedId={selectedTextOverlayId}
            onSelect={(id) => {
              setSelectedTextOverlayId(id)
              setCanvasSelection({ kind: 'text', id })
            }}
            onMove={updateTextOverlayPosition}
            onScale={(id, fontSizePercent) => updateTextOverlays(
              programScene.textOverlays.map((overlay) => (
                overlay.id === id ? { ...overlay, fontSizePercent } : overlay
              ))
            )}
            onWidthChange={(id, widthPercent) => updateTextOverlays(
              programScene.textOverlays.map((overlay) => (
                overlay.id === id ? { ...overlay, widthPercent } : overlay
              ))
            )}
            onTextChange={(id, text) => updateTextOverlays(
              programScene.textOverlays.map((overlay) => (
                overlay.id === id ? { ...overlay, text } : overlay
              ))
            )}
          />
          <SceneQrPreviewLayer
            config={qrOverlay}
            outputWidth={outputWidth}
            outputHeight={outputHeight}
            shown={activePanel === 'qr' || qrOverlay.sceneVisible !== false}
            interactive={activePanel === 'picture' || activePanel === 'qr'}
            selected={canvasSelection?.kind === 'qr' || activePanel === 'qr'}
            onSelect={() => setCanvasSelection({ kind: 'qr' })}
            onChange={setQrOverlay}
          />
          {activePanel === 'picture' && !backgroundSource && (
            <button
              type="button"
              onClick={() => programScene.background.kind === 'video'
                ? void selectBackgroundVideo()
                : programScene.background.kind === 'image'
                  ? void selectBackdrop()
                  : undefined}
              className="absolute inset-x-0 bottom-2 z-10 mx-auto w-fit rounded-md border border-amber-400/50 bg-gray-950/90 px-3 py-1 text-center text-[10px] font-medium text-amber-300 shadow-lg hover:border-amber-300 hover:bg-gray-900 hover:text-amber-200"
              title="Выбрать нижний слой сцены"
            >
              Выберите фоновое изображение
            </button>
          )}
        </div>

          </section>
          <section className="flex min-h-0 flex-col">

        {effectiveEditorPanel === 'chroma' ? (
          <ChromaKeyPanel
            config={programScene.chromaKey}
            available={chromaAvailable}
            pickerActive={chromaColorPickerActive}
            onChange={updateChromaKey}
            onPickerToggle={() => {
              updateChromaKey({ enabled: true })
              setChromaColorPickerActive((active) => !active)
            }}
            onReset={() => {
              setChromaColorPickerActive(false)
              setProgramScene({ chromaKey: { ...DEFAULT_PROGRAM_SCENE_CHROMA_KEY } })
            }}
          />
        ) : effectiveEditorPanel === 'layers' ? (
          <ProgramSceneMediaLayerEditor
            layers={programScene.mediaLayers}
            selectedId={selectedMediaLayerId}
            onSelect={(id) => {
              setSelectedMediaLayerId(id)
              setCanvasSelection(id ? { kind: 'media', id } : null)
            }}
            onChange={updateMediaLayers}
            onAddImage={() => void addImageLayer()}
            onAddVideo={() => void addVideoLayers()}
          />
        ) : effectiveEditorPanel === 'text' ? (
          <ProgramSceneTextOverlayEditor
            overlays={programScene.textOverlays}
            selectedId={selectedTextOverlayId}
            onSelectedIdChange={(id) => {
              setSelectedTextOverlayId(id)
              setCanvasSelection(id ? { kind: 'text', id } : null)
            }}
            onChange={updateTextOverlays}
          />
        ) : effectiveEditorPanel === 'qr' ? (
          <QrOverlayModal
            embedded
            settingsOnly
            manageOutputOwnership={false}
            onClose={() => setCanvasSelection(null)}
          />
        ) : <>

        <div data-program-scene-background className="mb-1.5 rounded-lg border border-blue-500/50 bg-surface-100 p-1.5 shadow-sm shadow-blue-950/30">
          <div className="flex items-center gap-2">
            <span className="w-[118px] shrink-0 text-[11px] font-semibold leading-tight text-white">Фон под хромакеем</span>
            <div className="grid min-w-0 flex-1 grid-cols-3 gap-1">
              {BACKGROUND_KINDS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  data-scene-background-kind={item.value}
                  onClick={() => selectBackgroundKind(item.value)}
                  className={`h-8 min-w-0 rounded-md border px-2 text-xs font-semibold transition-colors ${programScene.background.kind === item.value
                    ? 'border-blue-400 bg-blue-600 text-white shadow-sm shadow-blue-950/40'
                    : 'border-gray-600 bg-gray-900 text-gray-200 hover:border-gray-400 hover:bg-gray-800'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {programScene.background.kind === 'image' && (
            <button type="button" onClick={() => void selectBackdrop()}
              className="mt-1 flex h-7 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-gray-600 bg-gray-900 px-2 text-[10px] text-gray-200 hover:border-gray-400">
              <span className="truncate">{shortFileName(backdropImage) || 'Изображение не выбрано'}</span>
              <span className="shrink-0 text-blue-300">Выбрать</span>
            </button>
          )}
          {programScene.background.kind === 'video' && (
            <div className="mt-1 flex h-7 min-w-0 items-center gap-2">
              <button type="button" onClick={() => void selectBackgroundVideo()}
                className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-gray-600 bg-gray-900 px-2 text-[10px] text-gray-200 hover:border-gray-400">
                <span className="truncate">{shortFileName(programScene.background.videoPath) || 'Видео не выбрано'}</span>
                <span className="shrink-0 text-blue-300">Выбрать</span>
              </button>
              <label className="flex shrink-0 items-center gap-1 text-[10px] text-gray-300">
                <input type="checkbox" checked={programScene.background.loop}
                  onChange={(event) => setProgramScene({ background: { ...programScene.background, loop: event.target.checked } })} />
                Повтор
              </label>
              <label className="flex shrink-0 items-center gap-1 text-[10px] text-gray-300">
                <input type="checkbox" checked={!programScene.background.muted}
                  onChange={(event) => setProgramScene({ background: { ...programScene.background, muted: !event.target.checked } })} />
                Звук
              </label>
            </div>
          )}
          {programScene.background.kind === 'channel' && (
            <div className="mt-1 flex h-7 min-w-0 items-center gap-2">
              <select
                aria-label="Канал нижнего слоя"
                value={programScene.background.channelId ?? ''}
                onChange={(event) => setProgramScene({
                  background: { ...programScene.background, channelId: event.target.value || null }
                })}
                className="h-7 min-w-0 flex-1 rounded-md border border-gray-600 bg-gray-900 px-2 text-[10px] text-white"
              >
                <option value="">Выберите канал</option>
                {channelIds.map((channelId) => {
                  const file = channels[channelId]?.file
                  if (!isProgramSceneBackgroundChannelSupported(file)) return null
                  return <option key={channelId} value={channelId}>Канал {channelId} — {file?.name}</option>
                })}
              </select>
              {backgroundSource?.type === 'video' && (
                <>
                  <label className="flex shrink-0 items-center gap-1 text-[10px] text-gray-300">
                    <input type="checkbox" checked={programScene.background.loop}
                      onChange={(event) => setProgramScene({ background: { ...programScene.background, loop: event.target.checked } })} />
                    Повтор
                  </label>
                  <label className="flex shrink-0 items-center gap-1 text-[10px] text-gray-300">
                    <input type="checkbox" checked={!programScene.background.muted}
                      onChange={(event) => setProgramScene({ background: { ...programScene.background, muted: !event.target.checked } })} />
                    Звук
                  </label>
                </>
              )}
            </div>
          )}
        </div>

        <div className="mb-1 flex items-center gap-2">
          <label className="w-[118px] shrink-0 text-[11px] font-medium text-gray-300">Камера поверх</label>
          <select
            value={selectedOption}
            onChange={(event) => selectExternalSource(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-lg border border-gray-700 bg-surface-100 px-2 text-xs text-white outline-none focus:border-blue-500"
          >
            <option value="">{devicesLoading ? 'Поиск камер и плат захвата…' : 'Выберите внешний источник'}</option>
            {videoDevices.length > 0 && (
              <optgroup label="Подключённые камеры и платы захвата">
                {videoDevices.map((device) => (
                  <option key={device.deviceId} value={`device:${device.deviceId}`}>
                    {device.label}
                  </option>
                ))}
              </optgroup>
            )}
            {captureSources.some((entry) => entry.capture?.captureKind === 'desktop') && (
              <optgroup label="Добавленные окна и экраны">
                {captureSources.map((entry) => entry.capture?.captureKind === 'desktop' && (
                  <option key={entry.capture.sourceId} value={`source:${entry.capture.sourceId}`}>
                    {entry.name || entry.capture.videoLabel || 'Окно или экран'}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        {devicesError && (
          <div className="-mt-1 mb-2 flex items-center justify-between gap-3 text-xs text-amber-300">
            <span>{devicesError}</span>
            <button className="text-blue-300 hover:text-blue-200" onClick={() => loadDevices()}>Обновить</button>
          </div>
        )}

        <div className="mb-1 rounded-md border border-gray-700 bg-surface-100 px-2 py-1">
          <div className="flex items-center gap-2">
            <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-gray-200">
              <input type="checkbox" checked={sceneAudio.enabled} disabled={!selectedCapture}
                onChange={(event) => {
                  setProgramScene({ audio: { ...sceneAudio, enabled: event.target.checked } })
                  if (event.target.checked) loadDevices(true)
                }} />
              Звук камеры
            </label>
            <select aria-label="Аудиовход камеры" value={sceneAudio.deviceId}
              disabled={!selectedCapture}
              onChange={(event) => {
                const device = audioDevices.find((item) => item.deviceId === event.target.value)
                setProgramScene({ audio: { ...sceneAudio, deviceId: device?.deviceId ?? '', groupId: device?.groupId ?? '', label: device?.label ?? '' } })
              }}
              className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-900 px-1 py-1 text-[11px] text-white disabled:opacity-40">
              <option value="">Выберите аудиовход</option>
              {sceneAudio.deviceId && !audioDevices.some((device) => device.deviceId === sceneAudio.deviceId) && (
                <option value={sceneAudio.deviceId}>{sceneAudio.label || 'Сохранённый вход'} — недоступен</option>
              )}
              {audioDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
            </select>
            <button type="button" title="Обновить аудиовходы и повторить подключение" aria-label="Обновить аудиовходы"
              onClick={() => { loadDevices(true); window.api.sendToPresentation('program-scene-audio-retry') }}
              className="shrink-0 px-1 text-blue-300 hover:text-blue-200">↻</button>
          </div>
          {(sceneAudio.enabled || audioStatus.phase === 'error') && <div className={`mt-1 truncate text-[10px] ${sceneAudio.enabled && audioStatus.phase === 'error' ? 'text-amber-300' : 'text-gray-400'}`}
            title="Звук сохраняется во всех трёх раскладках и отключается вместе с картинкой Сцены. В стриме выбирайте «Весь системный звук»; не подключайте этот же вход второй раз как микрофон. Используйте наушники или микшер, чтобы избежать акустической обратной связи.">
            {sceneAudio.enabled && audioStatus.message ? audioStatus.message : 'Включается вместе с картинкой Сцены. В стрим — через системный звук.'}
          </div>}
        </div>

        <div className="mb-1 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-xs text-gray-300">Положение участника</div>
            <div className="grid grid-cols-2 gap-1">
              {PLACEMENTS.map((item) => {
                const participantLeft = item.value.startsWith('left-')
                const participantVertical = item.value.split('-')[1]
                const selected = programScene.placement === item.value
                return (
                  <button
                    key={item.value}
                    type="button"
                    title={item.label}
                    aria-label={item.label}
                    onClick={() => setProgramScene({ placement: item.value })}
                    className={`rounded-md border p-0.5 transition-colors ${selected
                      ? 'border-blue-400 bg-blue-600/35'
                      : 'border-gray-700 bg-surface-100 hover:border-gray-500 hover:bg-gray-700/70'}`}
                  >
                    <span className="relative block h-6 overflow-hidden rounded-sm border border-gray-600 bg-gray-950">
                      <span
                        className="absolute bottom-[12%] top-[12%] rounded-[2px] bg-gray-200"
                        style={participantLeft
                          ? { left: '38%', right: '7%' }
                          : { left: '7%', right: '38%' }}
                      />
                      <span
                        className={`absolute h-[34%] w-[27%] rounded-[2px] border ${selected
                          ? 'border-cyan-200 bg-cyan-400'
                          : 'border-slate-400 bg-slate-600'}`}
                        style={{
                          left: participantLeft ? '7%' : undefined,
                          right: participantLeft ? undefined : '7%',
                          top: participantVertical === 'top'
                            ? '9%'
                            : participantVertical === 'center'
                              ? '50%'
                              : undefined,
                          bottom: participantVertical === 'bottom' ? '9%' : undefined,
                          transform: participantVertical === 'center' ? 'translateY(-50%)' : undefined
                        }}
                      />
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-gray-300">Размер участника</div>
            <div className="grid grid-cols-2 gap-1">
              {SIZES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  data-scene-size={item.value}
                  onClick={() => setProgramScene({ participantSize: item.value })}
                  className={`w-full rounded px-2 py-1 text-[10px] ${programScene.participantSize === item.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-surface-100 text-gray-300 hover:bg-gray-700'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] text-gray-400">
              <span>Высота камеры</span>
              <span className="tabular-nums text-gray-300">{Math.round(programScene.participantScale * 100)}%</span>
            </div>
            <input
              data-program-scene-participant-scale
              type="range"
              min={PROGRAM_SCENE_PARTICIPANT_SCALE_MIN * 100}
              max={PROGRAM_SCENE_PARTICIPANT_SCALE_MAX * 100}
              step={5}
              value={Math.round(programScene.participantScale * 100)}
              onChange={(event) => setParticipantScaleDraft(Number(event.target.value) / 100)}
              onPointerUp={(event) => setProgramScene({
                participantScale: Number(event.currentTarget.value) / 100
              })}
              onKeyUp={(event) => setProgramScene({
                participantScale: Number(event.currentTarget.value) / 100
              })}
              onBlur={(event) => setProgramScene({
                participantScale: Number(event.currentTarget.value) / 100
              })}
              className="h-1.5 w-full cursor-pointer accent-blue-500"
              title="Окно камеры увеличивается по высоте; видео не деформируется, а аккуратно обрезается по бокам"
            />
          </div>
        </div>

        <div className="mb-1 grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-xs text-gray-300">Углы</div>
            <div className="grid grid-cols-2 gap-1">
              {CORNERS.map((item) => (
                <button
                  key={item.value}
                  onClick={() => setProgramScene({ cornerStyle: item.value })}
                  className={`rounded px-2 py-0.5 text-[10px] ${programScene.cornerStyle === item.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-surface-100 text-gray-300 hover:bg-gray-700'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 h-4 text-xs text-gray-300">Эффект переключения</div>
            <div className="grid grid-cols-3 gap-1">
              {TRANSITION_EFFECTS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  onClick={() => selectTransitionEffect(item.value)}
                  className={`flex h-6 items-center justify-center rounded border ${programScene.transitionEffect === item.value
                    ? 'border-blue-400 bg-blue-600 text-white'
                    : 'border-gray-700 bg-surface-100 text-gray-300 hover:border-gray-500 hover:bg-gray-700'}`}
                >
                  <TransitionEffectIcon effect={item.value} />
                </button>
              ))}
            </div>
          </div>
        </div>

        </>}
          </section>
        </div>

        <div data-scene-editor="titles" hidden={activePanel !== 'titles'} className="flex min-h-0 flex-1 overflow-hidden">
          <BroadcastTitlesModal embedded onClose={closeModal} />
        </div>

        {sceneContextMenu && (
          <div
            data-scene-context-menu
            className="fixed z-[160] max-h-[calc(100vh-16px)] w-52 overflow-y-auto rounded-lg border border-gray-600 bg-gray-950 p-1.5 text-xs text-white shadow-2xl"
            style={{
              left: Math.max(8, Math.min(sceneContextMenu.clientX, window.innerWidth - 220)),
              top: Math.max(8, Math.min(sceneContextMenu.clientY, window.innerHeight - 330))
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {!sceneContextMenu.chooserOnly && <>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Добавить в сцену</div>
              <button
                type="button"
                data-scene-add="background"
                onClick={() => {
                  setCanvasSelection(null)
                  setActivePanel('picture')
                  setSceneContextMenu(null)
                  void selectBackdrop()
                }}
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600"
              >
                Фон
              </button>
              <button
                type="button"
                data-scene-add="text"
                onClick={() => {
                  addTextAt(sceneContextMenu.xPercent, sceneContextMenu.yPercent)
                  setSceneContextMenu(null)
                }}
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600"
              >
                Текст
              </button>
              <button
                type="button"
                data-scene-add="qr"
                onClick={() => {
                  setQrOverlay({ sceneVisible: true })
                  setCanvasSelection({ kind: 'qr' })
                  setActivePanel('picture')
                  setSceneContextMenu(null)
                }}
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600"
              >
                QR-код
              </button>
              <button
                type="button"
                data-scene-add="image"
                onClick={() => {
                  const position = { xPercent: sceneContextMenu.xPercent, yPercent: sceneContextMenu.yPercent }
                  setSceneContextMenu(null)
                  void addImageLayer(position)
                }}
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600"
              >
                Слой — картинка
              </button>
              <button
                type="button"
                data-scene-add="video"
                onClick={() => {
                  const position = { xPercent: sceneContextMenu.xPercent, yPercent: sceneContextMenu.yPercent }
                  setSceneContextMenu(null)
                  void addVideoLayers(position)
                }}
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600"
              >
                Слой — видео
              </button>
              <div className="my-1 border-t border-gray-700" />
            </>}
            {sceneContextMenu.target.kind === 'media' && (
              <>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Слой</div>
                <button type="button" data-scene-object-action="up"
                  onClick={() => {
                    updateMediaLayers(moveProgramSceneMediaLayer(programScene.mediaLayers, sceneContextMenu.target.kind === 'media' ? sceneContextMenu.target.id : '', 'up'))
                    setSceneContextMenu(null)
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600">Выше</button>
                <button type="button" data-scene-object-action="down"
                  onClick={() => {
                    updateMediaLayers(moveProgramSceneMediaLayer(programScene.mediaLayers, sceneContextMenu.target.kind === 'media' ? sceneContextMenu.target.id : '', 'down'))
                    setSceneContextMenu(null)
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600">Ниже</button>
                <button type="button" data-scene-object-action="hide"
                  onClick={() => {
                    if (sceneContextMenu.target.kind === 'media') updateMediaLayer(sceneContextMenu.target.id, { visible: false })
                    setSceneContextMenu(null)
                  }}
                  className="block w-full rounded bg-red-950/65 px-2 py-1.5 text-left font-medium text-red-200 hover:bg-red-800">Скрыть</button>
                <div className="my-1 border-t border-gray-700" />
              </>
            )}
            {sceneContextMenu.target.kind === 'qr' && (
              <>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">QR-код</div>
                <button type="button" data-scene-object-action="hide"
                  onClick={() => {
                    setQrOverlay({ sceneVisible: false, enabled: false })
                    setCanvasSelection(null)
                    setSceneContextMenu(null)
                  }}
                  className="block w-full rounded bg-red-950/65 px-2 py-1.5 text-left font-medium text-red-200 hover:bg-red-800">Скрыть</button>
                <div className="my-1 border-t border-gray-700" />
              </>
            )}
            {sceneContextMenu.target.kind === 'text' && (
              <>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Текст</div>
                <button type="button" data-scene-object-action="hide"
                  onClick={() => {
                    if (sceneContextMenu.target.kind === 'text') {
                      updateTextOverlays(programScene.textOverlays.map((overlay) => (
                        overlay.id === sceneContextMenu.target.id ? { ...overlay, visible: false } : overlay
                      )))
                    }
                    setCanvasSelection(null)
                    setSceneContextMenu(null)
                  }}
                  className="block w-full rounded bg-red-950/65 px-2 py-1.5 text-left font-medium text-red-200 hover:bg-red-800">Скрыть</button>
                <div className="my-1 border-t border-gray-700" />
              </>
            )}
            {sceneContextMenu.target.kind === 'content' && (
              <>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Презентация</div>
                {previewableContentChannels.length > 0 ? (
                  <div className="max-h-36 overflow-y-auto">
                    {previewableContentChannels.map(({ id, channel, file }) => {
                      const name = channel.caption.trim() || shortFileName(file.path) || file.name || `Канал ${id}`
                      return (
                        <button
                          key={id}
                          type="button"
                          data-scene-content-channel={id}
                          title={`Канал ${id} — ${name}`}
                          onClick={() => {
                            setPreviewChannelId(id)
                            setSelectedChannel(id)
                            setCanvasSelection(null)
                            setSceneContextMenu(null)
                          }}
                          className={`block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600 ${previewChannelId === id ? 'bg-blue-700 text-white' : ''}`}
                        >
                          <span className="block text-[10px] text-gray-400">Канал {id}</span>
                          <span className="block truncate text-xs">{name}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="px-2 py-1.5 text-[11px] text-gray-500">Нет каналов с материалом</div>
                )}
                <div className="my-1 border-t border-gray-700" />
              </>
            )}
            {sceneContextMenu.target.kind === 'external' && (
              <>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  {sceneContextMenu.chooserOnly ? 'Выберите внешний источник' : 'Действия источника'}
                </div>
                {selectedCapture && !sceneContextMenu.chooserOnly && (
                  <button
                    type="button"
                    data-scene-object-action="chroma"
                    disabled={!chromaAvailable}
                    title={chromaAvailable ? 'Открыть только настройки хромакея' : 'Хромакей доступен только для камеры или платы видеозахвата'}
                    onClick={() => {
                      setCanvasSelection({ kind: 'chroma' })
                      setActivePanel('picture')
                      setSceneContextMenu(null)
                    }}
                    className="block w-full rounded px-2 py-1.5 text-left font-medium text-emerald-300 hover:bg-emerald-900/50 disabled:cursor-not-allowed disabled:text-gray-600"
                  >
                    Хромакей
                  </button>
                )}
                {sceneContextMenu.chooserOnly && <div data-scene-external-source-picker className="max-h-44 overflow-y-auto">
                  {devicesLoading && (
                    <div className="px-2 py-1.5 text-[11px] text-gray-500">Поиск камер и плат захвата…</div>
                  )}
                  {videoDevices.map((device) => {
                    const value = `device:${device.deviceId}`
                    return (
                      <button
                        key={value}
                        type="button"
                        data-scene-external-source={value}
                        title={device.label}
                        onClick={() => selectExternalSourceFromScene(value)}
                        className={`block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600 ${selectedOption === value ? 'bg-blue-700 text-white' : ''}`}
                      >
                        <span className="block text-[10px] text-gray-400">Камера или плата захвата</span>
                        <span className="block truncate text-xs">{device.label}</span>
                      </button>
                    )
                  })}
                  {captureSources.flatMap((entry) => {
                    const capture = entry.capture
                    if (capture?.captureKind !== 'desktop') return []
                    const value = `source:${capture.sourceId}`
                    const name = entry.name || capture.videoLabel || 'Окно или экран'
                    return [(
                      <button
                        key={value}
                        type="button"
                        data-scene-external-source={value}
                        title={name}
                        onClick={() => selectExternalSourceFromScene(value)}
                        className={`block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600 ${selectedOption === value ? 'bg-blue-700 text-white' : ''}`}
                      >
                        <span className="block text-[10px] text-gray-400">Окно или экран</span>
                        <span className="block truncate text-xs">{name}</span>
                      </button>
                    )]
                  })}
                  {!devicesLoading && videoDevices.length === 0 && !captureSources.some((entry) => entry.capture?.captureKind === 'desktop') && (
                    <div className="px-2 py-1.5 text-[11px] text-gray-500">Нет доступных внешних источников</div>
                  )}
                </div>}
                {sceneContextMenu.chooserOnly && devicesError && (
                  <button type="button" onClick={() => loadDevices()}
                    className="block w-full rounded px-2 py-1.5 text-left text-amber-300 hover:bg-gray-800">Обновить список</button>
                )}
                {selectedCapture && !sceneContextMenu.chooserOnly && <button type="button" data-scene-object-action="hide"
                  onClick={() => {
                    setProgramScene({ captureSourceId: null })
                    setCanvasSelection(null)
                    setSceneContextMenu(null)
                  }}
                  className="block w-full rounded bg-red-950/65 px-2 py-1.5 text-left font-medium text-red-200 hover:bg-red-800">Скрыть</button>}
                <div className="my-1 border-t border-gray-700" />
              </>
            )}
            {!sceneContextMenu.chooserOnly && <>
            {(programScene.mediaLayers.length > 0 || programScene.textOverlays.length > 0 || hasQrData(qrOverlay)) && (
              <>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Настроить</div>
                {programScene.mediaLayers.length > 0 && (
                  <button
                    type="button"
                    data-scene-manage="layers"
                    onClick={() => {
                      const selectedId = programScene.mediaLayers.some((layer) => layer.id === selectedMediaLayerId)
                        ? selectedMediaLayerId
                        : programScene.mediaLayers.at(-1)?.id ?? null
                      setSelectedMediaLayerId(selectedId)
                      setCanvasSelection(selectedId ? { kind: 'media', id: selectedId } : null)
                      setActivePanel('picture')
                      setSceneContextMenu(null)
                    }}
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600"
                  >
                    Слои сцены ({programScene.mediaLayers.length})
                  </button>
                )}
                {programScene.textOverlays.length > 0 && (
                  <button
                    type="button"
                    data-scene-manage="text"
                    onClick={() => {
                      const selectedId = programScene.textOverlays.some((overlay) => overlay.id === selectedTextOverlayId)
                        ? selectedTextOverlayId
                        : programScene.textOverlays.at(-1)?.id ?? null
                      setSelectedTextOverlayId(selectedId)
                      setCanvasSelection(selectedId ? { kind: 'text', id: selectedId } : null)
                      setActivePanel('picture')
                      setSceneContextMenu(null)
                    }}
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600"
                  >
                    Текстовые блоки ({programScene.textOverlays.length})
                  </button>
                )}
                {hasQrData(qrOverlay) && (
                  <button
                    type="button"
                    data-scene-manage="qr"
                    onClick={() => {
                      setCanvasSelection({ kind: 'qr' })
                      setActivePanel('picture')
                      setSceneContextMenu(null)
                    }}
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-blue-600"
                  >
                    QR-код
                  </button>
                )}
                <div className="my-1 border-t border-gray-700" />
              </>
            )}
            </>}
          </div>
        )}
      </div>
    </div>
  )
}
