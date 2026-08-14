import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { mediaUrl } from '../../media'
import { renderPdfiumPageToCanvas, warmPdfiumDocument } from '../../pdfium-renderer'
import { DesktopCapturePicker } from '../Capture/DesktopCapturePicker'
import { BroadcastTitlesOverlay } from '../BroadcastTitles/BroadcastTitlesOverlay'
import {
  captureSourceIdentity,
  DEFAULT_BROADCAST_TITLES_OUTPUT,
  useAppStore,
  type BroadcastTitlesOutput,
  type DisplayOutputMode,
  type InformationMediaConfig,
  type InformationMediaType
} from '../../stores/useAppStore'
import {
  setDisplayAssignmentWithProgramRouting,
  switchPrimaryProgramDisplay
} from '../../program-display-routing'

interface AuxiliaryDisplaysModalProps {
  onClose: () => void
}

const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'pptm', 'pps', 'ppsx'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'svg'])

const TYPE_LABELS: Record<InformationMediaType, string> = {
  presentation: 'PowerPoint',
  pdf: 'PDF',
  video: 'Видео',
  image: 'Изображение',
  capture: 'Внешний источник'
}

interface DeviceResponse {
  requestId: string
  devices: CaptureDeviceDescriptor[]
  error?: string
}

function InformationPdfPreview({ filePath, page }: { filePath: string; page: number }): JSX.Element {
  const [frame, setFrame] = useState<{ filePath: string; page: number; src: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)

    const render = async (): Promise<void> => {
      try {
        const nativePath = await window.api.renderPdfPage(filePath, page - 1, 720)
        if (cancelled) return
        if (nativePath) {
          setFrame({ filePath, page, src: mediaUrl(nativePath) })
          setLoading(false)
          return
        }

        const rendered = await renderPdfiumPageToCanvas({
          filePath,
          pageNumber: page,
          targetWidth: 720,
          targetHeight: 405,
          lane: 'background'
        })
        if (cancelled) return
        setFrame({ filePath, page, src: rendered.canvas.toDataURL('image/png') })
        setLoading(false)
      } catch (error) {
        if (cancelled) return
        setLoading(false)
        setFailed(true)
        window.api.dbgLog(`information PDF preview failed page=${page}: ${String(error)}`)
      }
    }

    void render()
    return () => { cancelled = true }
  }, [filePath, page])

  const isCurrentFrame = frame?.filePath === filePath && frame.page === page
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      {frame && (
        <img
          src={frame.src}
          className={`h-full w-full object-contain transition-none ${isCurrentFrame ? 'opacity-100' : 'opacity-50'}`}
          draggable={false}
        />
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/45 text-xs text-gray-300">
          Подготовка страницы {page}…
        </div>
      )}
      {failed && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-4 text-center text-xs text-red-300">
          Не удалось подготовить превью PDF
        </div>
      )}
    </div>
  )
}

function InformationDevicePicker({
  onClose,
  onSelect
}: {
  onClose: () => void
  onSelect: (device: CaptureDeviceDescriptor) => void
}): JSX.Element {
  const [devices, setDevices] = useState<CaptureDeviceDescriptor[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestGenerationRef = useRef(0)
  const videoDevices = useMemo(
    () => devices.filter((device) => device.kind === 'videoinput'),
    [devices]
  )

  const loadDevices = useCallback((): void => {
    const generation = ++requestGenerationRef.current
    const requestId = `information-capture-devices-${crypto.randomUUID()}`
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = (): void => {}
    setLoading(true)
    setError(null)

    const finish = (response?: DeviceResponse): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      unsubscribe()
      if (generation !== requestGenerationRef.current) return
      setLoading(false)
      if (!response) {
        setError('Не удалось получить список устройств. Нажмите «Обновить список».')
        return
      }
      const videos = response.devices.filter((device) => device.kind === 'videoinput')
      setDevices(videos)
      setError(response.error || null)
      setSelectedId((current) => videos.some((device) => device.deviceId === current)
        ? current
        : videos[0]?.deviceId || '')
    }

    unsubscribe = window.api.on('capture-devices-response', (...args: unknown[]) => {
      const response = args[0] as DeviceResponse
      if (response?.requestId === requestId) finish(response)
    })
    timeout = setTimeout(() => finish(), 15000)
    window.api.sendToPresentation('capture-devices-request', { requestId })
  }, [])

  useEffect(() => {
    loadDevices()
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribeDevices = window.api.on('capture-devices-changed', () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(loadDevices, 350)
    })
    const unsubscribeHub = window.api.on('capture-hub-ready', loadDevices)
    return () => {
      requestGenerationRef.current += 1
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubscribeDevices()
      unsubscribeHub()
    }
  }, [loadDevices])

  const selectedDevice = videoDevices.find((device) => device.deviceId === selectedId)

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/75 p-6">
      <div
        className="w-full max-w-lg rounded-xl border border-gray-700 bg-surface-300 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-700 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">Внешний источник</h2>
            <p className="mt-1 text-xs text-gray-500">Плата видеозахвата, USB-камера или веб-камера</p>
          </div>
          <button onClick={onClose} className="text-xl text-gray-500 hover:text-white">✕</button>
        </div>

        <div className="px-5 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-10 text-sm text-gray-400">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-white" />
              Получение списка устройств…
            </div>
          ) : (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-gray-300">Источник изображения</span>
                <select
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                  className="w-full rounded-md border border-gray-600 bg-surface-100 px-3 py-2 text-sm text-white outline-hidden focus:border-blue-500"
                >
                  {videoDevices.length === 0 && <option value="">Устройства не найдены</option>}
                  {videoDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-[10px] leading-relaxed text-gray-500">
                Видеосигнал будет показан на всех информационных экранах. Звук не передаётся.
              </p>
              {error && (
                <div className="mt-4 rounded-md border border-red-800/70 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-700 px-5 py-4">
          <button onClick={loadDevices} disabled={loading} className="text-xs text-gray-400 hover:text-white disabled:opacity-40">
            Обновить список
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md px-4 py-2 text-xs text-gray-300 hover:bg-surface-100">
              Отмена
            </button>
            <button
              onClick={() => { if (selectedDevice) onSelect(selectedDevice) }}
              disabled={loading || !selectedDevice}
              className="rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
            >
              Воспроизвести
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function extensionOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || ''
}

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function formatMediaTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remainder = safeSeconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(remainder)}`
    : `${pad(minutes)}:${pad(remainder)}`
}

function mediaTypeOf(filePath: string): InformationMediaType | null {
  const extension = extensionOf(filePath)
  if (PRESENTATION_EXTENSIONS.has(extension)) return 'presentation'
  if (extension === 'pdf') return 'pdf'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return null
}

export function AuxiliaryDisplaysModal({ onClose }: AuxiliaryDisplaysModalProps): JSX.Element {
  const {
    displays,
    displayAssignments,
    displayNames,
    selectedDisplayId,
    activeFile,
    isPresentationWindowOpen,
    informationMedia,
    broadcastTitles,
    captureTitlesOutputs,
    setDisplayName,
    setInformationMedia,
    setBroadcastTitles,
    setCaptureTitlesOutput
  } = useAppStore()
  const [mediaStatus, setMediaStatus] = useState('')
  const [loadingMedia, setLoadingMedia] = useState(false)
  const [switchingPrimaryId, setSwitchingPrimaryId] = useState<number | null>(null)
  const [displayStatus, setDisplayStatus] = useState('')
  const [devicePickerOpen, setDevicePickerOpen] = useState(false)
  const [desktopPickerOpen, setDesktopPickerOpen] = useState(false)
  const [titlesMenu, setTitlesMenu] = useState<{ x: number; y: number } | null>(null)

  const informationSourceIdentity = informationMedia?.type === 'capture'
    ? captureSourceIdentity(informationMedia.capture)
    : null
  const informationTitlesOutput = informationSourceIdentity
    ? captureTitlesOutputs[informationSourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : DEFAULT_BROADCAST_TITLES_OUTPUT
  const informationTitlesVisible = informationTitlesOutput.speakerVisible || informationTitlesOutput.eventVisible

  const externalDisplays = useMemo(
    () => displays.filter((display) => !display.isPrimary),
    [displays]
  )
  const informationDisplayIds = useMemo(() => externalDisplays
    .filter((display) => displayAssignments[String(display.id)] === 'information')
    .map((display) => display.id), [displayAssignments, externalDisplays])

  useEffect(() => {
    let cancelled = false
    let pushRevision = 0
    const unsubscribe = window.api.on('displays-changed', () => { pushRevision++ })
    const requestRevision = pushRevision
    window.api.getDisplays().then((nextDisplays) => {
      if (cancelled || pushRevision !== requestRevision) return
      useAppStore.getState().setDisplays(nextDisplays)
      window.api.dbgLog(`screens modal refreshed display topology count=${nextDisplays.length}`)
    }).catch((error: unknown) => {
      window.api.dbgLog(`screens modal display refresh failed error=${String(error)}`)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (informationMedia?.type !== 'capture') setTitlesMenu(null)
  }, [informationMedia?.type])

  const openTitlesMenu = (clientX: number, clientY: number): void => {
    if (!informationSourceIdentity) return
    const menuWidth = 320
    const menuHeight = Math.min(620, 310 + broadcastTitles.speakers.length * 54)
    setTitlesMenu({
      x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8))
    })
  }

  const publishInformationSpeaker = (speakerId: string): void => {
    if (!informationSourceIdentity) return
    const speaker = useAppStore.getState().broadcastTitles.speakers.find((item) => item.id === speakerId)
    if (!speaker?.name.trim()) return
    const titles = useAppStore.getState().broadcastTitles
    setBroadcastTitles({ selectedSpeakerId: speaker.id })
    setCaptureTitlesOutput(informationSourceIdentity, {
      speakerId: speaker.id,
      speakerName: speaker.name,
      speakerRole: speaker.role,
      speakerEnterEffect: titles.speakerEnterEffect,
      speakerExitEffect: titles.speakerExitEffect,
      speakerAutoHideSeconds: titles.speakerAutoHideSeconds,
      speakerStyle: titles.speakerStyle,
      speakerTextColor: titles.speakerTextColor,
      speakerBackgroundStart: titles.speakerBackgroundStart,
      speakerBackgroundEnd: titles.speakerBackgroundEnd,
      speakerAccentStart: titles.speakerAccentStart,
      speakerAccentEnd: titles.speakerAccentEnd,
      speakerVisible: true
    })
    setTitlesMenu(null)
  }

  const publishInformationEvent = (): void => {
    if (!informationSourceIdentity) return
    const titles = useAppStore.getState().broadcastTitles
    if (!titles.eventInfo.trim()) return
    setCaptureTitlesOutput(informationSourceIdentity, {
      eventLabel: titles.eventLabel,
      eventInfo: titles.eventInfo,
      eventEnterEffect: titles.eventEnterEffect,
      eventExitEffect: titles.eventExitEffect,
      eventAutoHideSeconds: titles.eventAutoHideSeconds,
      eventPosition: titles.eventPosition,
      eventStyle: titles.eventStyle,
      eventTextColor: titles.eventTextColor,
      eventBackgroundStart: titles.eventBackgroundStart,
      eventBackgroundEnd: titles.eventBackgroundEnd,
      eventAccentStart: titles.eventAccentStart,
      eventAccentEnd: titles.eventAccentEnd,
      eventVisible: true
    })
    setTitlesMenu(null)
  }

  const updateInformationTitles = (update: Partial<BroadcastTitlesOutput>): void => {
    if (informationSourceIdentity) setCaptureTitlesOutput(informationSourceIdentity, update)
  }

  const chooseInformationMedia = async (): Promise<void> => {
    const path = await window.api.selectInformationMedia()
    if (!path) return
    const type = mediaTypeOf(path)
    if (!type) {
      setMediaStatus('Этот формат не поддерживается')
      return
    }

    setLoadingMedia(true)
    setMediaStatus(type === 'presentation' ? 'Подготовка слайдов PowerPoint…' : 'Подготовка файла…')
    try {
      let totalSlides = type === 'image' ? 1 : 0
      let slideImages: string[] = []

      if (type === 'presentation') {
        const result = await window.api.generatePptxSlides(path, 1920, 1080)
        if (!result.success || !result.slides?.length) {
          throw new Error(result.error || 'Не удалось подготовить слайды PowerPoint')
        }
        slideImages = result.slides
        totalSlides = result.slideCount || result.slides.length
      } else if (type === 'pdf') {
        const data = await window.api.readFile(path)
        totalSlides = await warmPdfiumDocument(path, 'background', data.slice(0))
      }

      const media: InformationMediaConfig = {
        type,
        path,
        name: fileNameOf(path),
        currentSlide: 1,
        totalSlides,
        slideImages,
        playing: false,
        currentTime: 0,
        duration: 0,
        seekRevision: 0,
        loop: false
      }
      setInformationMedia(media)
      setMediaStatus('')
    } catch (error) {
      setMediaStatus(`Не удалось открыть файл: ${String(error)}`)
    } finally {
      setLoadingMedia(false)
    }
  }

  const moveSlide = (delta: number): void => {
    if (!informationMedia || informationMedia.totalSlides < 1) return
    const currentSlide = Math.max(1, Math.min(
      informationMedia.totalSlides,
      informationMedia.currentSlide + delta
    ))
    setInformationMedia({ ...informationMedia, currentSlide })
  }

  const toggleInformationVideo = (): void => {
    if (informationMedia?.type !== 'video') return
    const duration = informationMedia.duration || 0
    const currentTime = informationMedia.currentTime || 0
    const restartFromBeginning = !informationMedia.playing && duration > 0 && currentTime >= duration - 0.15
    setInformationMedia({
      ...informationMedia,
      playing: !informationMedia.playing,
      currentTime: restartFromBeginning ? 0 : currentTime,
      seekRevision: restartFromBeginning
        ? (informationMedia.seekRevision || 0) + 1
        : informationMedia.seekRevision || 0
    })
  }

  const stopInformationVideo = (): void => {
    if (informationMedia?.type !== 'video') return
    setInformationMedia({
      ...informationMedia,
      playing: false,
      currentTime: 0,
      seekRevision: (informationMedia.seekRevision || 0) + 1
    })
  }

  const seekInformationVideo = (time: number): void => {
    if (informationMedia?.type !== 'video') return
    const duration = informationMedia.duration || 0
    const currentTime = Math.max(0, duration > 0 ? Math.min(time, duration) : time)
    setInformationMedia({
      ...informationMedia,
      currentTime,
      seekRevision: (informationMedia.seekRevision || 0) + 1
    })
  }

  const selectExternalDevice = (device: CaptureDeviceDescriptor): void => {
    const sourceId = `information-capture-${crypto.randomUUID()}`
    const capture: CaptureSourceConfig = {
      sourceId,
      captureKind: 'device',
      videoDeviceId: device.deviceId,
      videoLabel: device.label,
      videoGroupId: device.groupId || undefined,
      audioEnabled: false
    }
    setInformationMedia({
      type: 'capture',
      path: `capture://${sourceId}`,
      name: device.label,
      currentSlide: 1,
      totalSlides: 1,
      slideImages: [],
      playing: true,
      capture
    })
    window.api.dbgLog(
      `information source selected kind=device id=${sourceId.slice(-8)} label=${device.label}`
    )
    setMediaStatus('')
    setDevicePickerOpen(false)
  }

  const selectDesktopSource = (source: DesktopCaptureSourceDescriptor): void => {
    const resolvedCaptureId = source.isMinimized
      ? undefined
      : source.captureId || (
          source.id.startsWith('window:') || source.id.startsWith('screen:')
            ? source.id
            : undefined
        )
    if (!resolvedCaptureId && source.kind !== 'window') {
      setMediaStatus('Windows не смогла подготовить выбранный экран для захвата.')
      setDesktopPickerOpen(false)
      return
    }
    const sourceId = `information-desktop-${crypto.randomUUID()}`
    const capture: CaptureSourceConfig = {
      sourceId,
      captureKind: 'desktop',
      desktopSourceId: resolvedCaptureId,
      desktopSourceKey: source.id,
      desktopSourceType: source.kind,
      desktopDisplayId: source.displayId,
      desktopAppIcon: source.appIcon,
      videoLabel: source.name || (source.kind === 'window' ? 'Окно программы' : 'Экран'),
      audioEnabled: false
    }
    setInformationMedia({
      type: 'capture',
      path: `desktop-capture://${sourceId}`,
      name: capture.videoLabel,
      currentSlide: 1,
      totalSlides: 1,
      slideImages: [],
      playing: true,
      capture
    })
    window.api.dbgLog(
      `information source selected kind=${source.kind} id=${sourceId.slice(-8)} deferred=${!resolvedCaptureId} label=${capture.videoLabel}`
    )
    setMediaStatus('')
    setDesktopPickerOpen(false)
  }

  const currentPreview = informationMedia?.type === 'presentation'
    ? informationMedia.slideImages[informationMedia.currentSlide - 1]
    : informationMedia?.type === 'image'
      ? informationMedia.path
      : null

  const makePrimaryDisplay = async (displayId: number): Promise<boolean> => {
    if (displayId === selectedDisplayId || switchingPrimaryId !== null) return false
    const outputIsLive = activeFile !== null || isPresentationWindowOpen
    setSwitchingPrimaryId(displayId)
    setDisplayStatus(outputIsLive ? 'Перенос главного эфира на выбранный дисплей…' : '')
    try {
      const result = await switchPrimaryProgramDisplay(displayId)
      if (!result.success) {
        setDisplayStatus(`Не удалось назначить главный дисплей: ${result.error || 'неизвестная ошибка'}`)
        return false
      }
      setDisplayStatus('')
      return true
    } catch (error) {
      setDisplayStatus(`Не удалось назначить главный дисплей: ${String(error)}`)
      return false
    } finally {
      setSwitchingPrimaryId(null)
    }
  }

  const handleDisplayAssignmentChange = async (
    displayId: number,
    mode: DisplayOutputMode
  ): Promise<void> => {
    if (switchingPrimaryId !== null) return
    const latest = useAppStore.getState()
    const replacementDisplayId = latest.selectedDisplayId === displayId && mode !== 'program'
      ? latest.displays
        .filter((display) => !display.isPrimary && display.id !== displayId)
        .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
        .find((display) => latest.displayAssignments[String(display.id)] === 'program')?.id
      : undefined

    setSwitchingPrimaryId(replacementDisplayId ?? displayId)
    setDisplayStatus(
      replacementDisplayId !== undefined && (latest.activeFile !== null || latest.isPresentationWindowOpen)
        ? 'Перенос главного эфира перед сменой назначения…'
        : ''
    )
    try {
      const result = await setDisplayAssignmentWithProgramRouting(displayId, mode)
      if (!result.success) {
        setDisplayStatus(`Не удалось изменить назначение дисплея: ${result.error || 'неизвестная ошибка'}`)
        return
      }
      setDisplayStatus('')
    } catch (error) {
      setDisplayStatus(`Не удалось изменить назначение дисплея: ${String(error)}`)
    } finally {
      setSwitchingPrimaryId(null)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70">
        <div
          className="w-[820px] max-w-[94vw] max-h-[88vh] overflow-hidden rounded-xl border border-gray-700 bg-surface-200 shadow-2xl flex flex-col"
          onClick={(event) => event.stopPropagation()}
        >
        <header className="shrink-0 px-5 py-3 border-b border-gray-700 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Экраны PDM</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">Назначение мониторов, суфлёр, мультимедиа и таймеры</p>
          </div>
          <button
            onClick={onClose}
            disabled={switchingPrimaryId !== null}
            className="text-lg text-gray-500 hover:text-white disabled:cursor-wait disabled:opacity-30"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <section className="rounded-xl border border-gray-700 bg-surface-100 p-4">
            <div className="mb-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Выбор дисплеев</h3>
                <p className="text-[10px] text-gray-500 mt-1">
                  Основной экран с интерфейсом PDM не меняется. Один режим можно назначить сразу нескольким мониторам.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {externalDisplays.map((display, index) => {
                const mode = displayAssignments[String(display.id)] || 'off'
                const customName = displayNames[String(display.id)] || ''
                const isPrimaryProgram = mode === 'program' && display.id === selectedDisplayId
                const programDescription = mode === 'program'
                  ? isPrimaryProgram
                    ? 'ГЛАВНЫЙ ЭФИРНЫЙ ДИСПЛЕЙ'
                    : 'Живая копия основного эфира'
                  : null
                return (
                <div
                  key={display.id}
                  className={`min-w-0 rounded-lg border p-3 transition-colors ${
                    isPrimaryProgram
                      ? 'border-amber-400 bg-amber-500/10 ring-2 ring-amber-400/50 shadow-lg shadow-amber-950/40'
                      : 'border-gray-700 bg-surface-200'
                  }`}
                >
                  <input
                    type="text"
                    value={customName}
                    maxLength={80}
                    placeholder="Добавить имя экрана"
                    aria-label={`Имя монитора ${index + 1}`}
                    onChange={(event) => setDisplayName(display.id, event.target.value)}
                    className="mb-1.5 w-full rounded-sm border border-gray-700 bg-surface-100 px-2 py-1.5 text-xs font-medium text-white outline-hidden placeholder:text-gray-600 hover:border-gray-600 focus:border-accent"
                  />
                  <span className="block text-[10px] text-gray-400 truncate" title={display.label}>
                    Монитор {index + 1} · {display.label}
                  </span>
                  <span className="block text-[10px] text-gray-500 mb-2">
                    {display.bounds.width}×{display.bounds.height} · масштаб {Math.round(display.scaleFactor * 100)}%
                  </span>
                  <select
                    className="w-full min-w-0 bg-surface-100 border border-gray-700 rounded-sm px-2 py-1.5 text-[10px] text-gray-200 outline-hidden hover:border-gray-600 focus:border-accent"
                    value={mode}
                    aria-label={`Режим монитора ${customName || display.label}`}
                    disabled={switchingPrimaryId !== null}
                    onChange={(event) => {
                      void handleDisplayAssignmentChange(
                        display.id,
                        event.target.value as DisplayOutputMode
                      )
                    }}
                  >
                    <option value="off">Выключен</option>
                    <option value="program">Основной эфир</option>
                    <option value="speaker">Суфлёр</option>
                    <option value="information">Информационный экран</option>
                    <option value="timer">Таймер</option>
                    <option value="event-timer">Таймер мероприятия</option>
                  </select>
                  {programDescription && (
                    <span className={`mt-2 flex items-center justify-between gap-2 text-[10px] ${
                      isPrimaryProgram ? 'font-black tracking-wide text-amber-300' : 'text-blue-300'
                    }`}>
                      <span>{isPrimaryProgram ? `★ ${programDescription}` : programDescription}</span>
                      {display.id !== selectedDisplayId && (
                        <button
                          type="button"
                          disabled={switchingPrimaryId !== null}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            void makePrimaryDisplay(display.id)
                          }}
                          className="shrink-0 rounded-sm border border-blue-700 px-1.5 py-0.5 text-[9px] hover:bg-blue-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                          title={activeFile !== null || isPresentationWindowOpen
                            ? 'Перенести главный эфир на этот дисплей во время показа'
                            : 'Использовать этот монитор как источник для копий эфира'}
                        >
                          {switchingPrimaryId === display.id ? 'Перенос…' : 'Сделать главным'}
                        </button>
                      )}
                    </span>
                  )}
                </div>
              )})}
            </div>

            {displayStatus && (
              <div className={`mt-3 text-xs ${displayStatus.startsWith('Не удалось') ? 'text-red-400' : 'text-amber-300'}`}>
                {displayStatus}
              </div>
            )}

            {displays.length === 0 ? (
              <div className="mt-3 text-xs text-gray-400">Поиск подключённых мониторов…</div>
            ) : externalDisplays.length === 0 && (
              <div className="mt-3 text-xs text-amber-300">Дополнительные мониторы не обнаружены.</div>
            )}
          </section>

          <section className="rounded-xl border border-gray-700 bg-surface-100 p-4">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-white">Мультимедиа на информационных экранах</h3>
              <p className="text-[10px] text-gray-500 mt-1">Один источник синхронно показывается на всех мониторах с режимом «Информационный экран»</p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  disabled={loadingMedia}
                  onClick={chooseInformationMedia}
                  className="rounded-lg bg-purple-700 px-3 py-2 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50"
                >
                  {loadingMedia ? 'Подготовка…' : 'Выбрать файл'}
                </button>
                <button
                  onClick={() => setDevicePickerOpen(true)}
                  className="rounded-lg bg-blue-700 px-3 py-2 text-xs font-medium text-white hover:bg-blue-600"
                >
                  Внешний источник
                </button>
                <button
                  onClick={() => setDesktopPickerOpen(true)}
                  className="rounded-lg bg-sky-700 px-3 py-2 text-xs font-medium text-white hover:bg-sky-600"
                >
                  Окно / экран
                </button>
                <button
                  disabled={!informationMedia}
                  onClick={() => setInformationMedia(null)}
                  className="ml-auto shrink-0 rounded-lg border border-red-700 bg-red-950/50 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-900/60 hover:text-red-200 disabled:cursor-not-allowed disabled:border-gray-700 disabled:bg-surface-200 disabled:text-gray-600 disabled:opacity-70"
                >
                  Отключить контент на информационном экране
                </button>
              </div>
            </div>

            {informationMedia ? (
              <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4">
                <div className="min-w-0 space-y-4">
                  <div className="rounded-lg border border-gray-700 bg-surface-200 p-3">
                    <div className="text-[10px] uppercase tracking-wide text-purple-300 mb-1">
                      {informationMedia.type === 'capture' && informationMedia.capture?.captureKind === 'desktop'
                        ? informationMedia.capture.desktopSourceType === 'screen' ? 'Экран' : 'Окно программы'
                        : TYPE_LABELS[informationMedia.type]}
                    </div>
                    <div className="truncate text-sm text-white" title={informationMedia.path}>{informationMedia.name}</div>
                    <div className="truncate text-[10px] text-gray-500 mt-1" title={informationMedia.path}>{informationMedia.path}</div>
                  </div>

                  {(informationMedia.type === 'presentation' || informationMedia.type === 'pdf') && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => moveSlide(-1)}
                        disabled={informationMedia.currentSlide <= 1}
                        className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 disabled:opacity-30"
                      >
                        ◀
                      </button>
                      <div className="min-w-[90px] text-center text-sm tabular-nums text-white">
                        {informationMedia.currentSlide} / {informationMedia.totalSlides}
                      </div>
                      <button
                        onClick={() => moveSlide(1)}
                        disabled={informationMedia.currentSlide >= informationMedia.totalSlides}
                        className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 disabled:opacity-30"
                      >
                        ▶
                      </button>
                    </div>
                  )}

                  {informationMedia.type === 'video' && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={toggleInformationVideo}
                          className={`min-w-[142px] rounded-lg px-5 py-2 text-xs font-medium text-white ${
                            informationMedia.playing ? 'bg-yellow-700 hover:bg-yellow-600' : 'bg-green-700 hover:bg-green-600'
                          }`}
                        >
                          {informationMedia.playing ? '⏸ Пауза' : '▶ Воспроизвести'}
                        </button>
                        <button
                          onClick={stopInformationVideo}
                          className="rounded-lg bg-red-800 px-4 py-2 text-xs font-medium text-white hover:bg-red-700"
                          title="Остановить видео и вернуться в начало"
                        >
                          ■ Стоп
                        </button>
                        <button
                          onClick={() => setInformationMedia({
                            ...informationMedia,
                            loop: !informationMedia.loop
                          })}
                          className={`rounded-lg border px-4 py-2 text-xs font-medium transition-colors ${
                            informationMedia.loop
                              ? 'border-purple-400 bg-purple-700 text-white hover:bg-purple-600'
                              : 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white'
                          }`}
                          title={informationMedia.loop
                            ? 'Зацикливание включено'
                            : 'Зациклить видеоролик'}
                          aria-pressed={informationMedia.loop || false}
                        >
                          ↻ Зациклить
                        </button>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-gray-300">
                          {formatMediaTime(informationMedia.currentTime || 0)}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, informationMedia.duration || 0)}
                          step={0.1}
                          value={Math.min(informationMedia.currentTime || 0, informationMedia.duration || 0)}
                          disabled={!informationMedia.duration}
                          onChange={(event) => seekInformationVideo(Number(event.target.value))}
                          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-purple-500 disabled:cursor-not-allowed disabled:opacity-40"
                          aria-label="Позиция видеоролика"
                        />
                        <span className="w-12 shrink-0 text-[11px] tabular-nums text-gray-400">
                          {formatMediaTime(informationMedia.duration || 0)}
                        </span>
                      </div>
                    </div>
                  )}

                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-gray-500">
                    <span>Предварительный просмотр</span>
                    {informationSourceIdentity && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          const bounds = event.currentTarget.getBoundingClientRect()
                          openTitlesMenu(bounds.right - 320, bounds.bottom + 6)
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        }}
                        className={`rounded-md border px-2 py-0.5 text-[9px] font-semibold shadow transition-colors ${
                          informationTitlesVisible
                            ? 'border-cyan-400 bg-cyan-700 text-white hover:bg-cyan-600'
                            : 'border-gray-600 bg-surface-100 text-gray-300 hover:border-cyan-500 hover:text-white'
                        }`}
                        title="Выбрать титр для этого внешнего источника"
                      >
                        ▰ Титры
                      </button>
                    )}
                  </div>
                  <div
                    className="relative aspect-video rounded-lg border border-gray-700 bg-black overflow-hidden flex items-center justify-center"
                    onContextMenu={(event) => {
                      if (!informationSourceIdentity) return
                      event.preventDefault()
                      event.stopPropagation()
                      openTitlesMenu(event.clientX, event.clientY)
                    }}
                    title={informationSourceIdentity ? 'Правый клик — выбрать титр' : undefined}
                  >
                    {currentPreview ? (
                      <img src={mediaUrl(currentPreview)} className="h-full w-full object-contain" draggable={false} />
                    ) : informationMedia.type === 'pdf' ? (
                      <InformationPdfPreview
                        filePath={informationMedia.path}
                        page={informationMedia.currentSlide}
                      />
                    ) : informationMedia.type === 'capture' ? (
                      <div className="text-center text-gray-400">
                        <div className="text-4xl mb-2">LIVE</div>
                        <div className="text-xs">
                          {informationMedia.capture?.captureKind === 'desktop'
                            ? informationMedia.capture.desktopSourceType === 'screen' ? 'Захват экрана' : 'Захват окна программы'
                            : 'Внешний видеосигнал'}
                        </div>
                      </div>
                    ) : informationMedia.type === 'video' ? (
                      <video
                        src={mediaUrl(informationMedia.path)}
                        className="h-full w-full object-contain"
                        muted
                        playsInline
                        preload="metadata"
                        onLoadedMetadata={(event) => {
                          const duration = Number.isFinite(event.currentTarget.duration)
                            ? event.currentTarget.duration
                            : 0
                          const current = useAppStore.getState().informationMedia
                          if (
                            current?.type === 'video' &&
                            current.path === informationMedia.path &&
                            Math.abs((current.duration || 0) - duration) > 0.05
                          ) {
                            setInformationMedia({ ...current, duration })
                          }
                        }}
                      />
                    ) : (
                      <div className="text-center text-gray-400">
                        <div className="text-4xl mb-2">▶</div>
                        <div className="text-xs">Видео готово к воспроизведению</div>
                      </div>
                    )}
                    {informationSourceIdentity && (
                      <BroadcastTitlesOverlay
                        key={informationSourceIdentity}
                        titles={informationTitlesOutput}
                      />
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-700 px-5 py-8 text-center text-xs text-gray-500">
                Файл не выбран. На экране будет показана общая подложка или чёрный фон.
              </div>
            )}

            {mediaStatus && <div className="mt-3 text-xs text-amber-300">{mediaStatus}</div>}
          </section>
          </div>
        </div>
      </div>
      {titlesMenu && createPortal(
        <>
          <div
            className="fixed inset-0 z-[150]"
            onMouseDown={(event) => {
              event.stopPropagation()
              setTitlesMenu(null)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setTitlesMenu(null)
            }}
          />
          <div
            className="fixed z-[151] max-h-[calc(100vh-16px)] w-[320px] overflow-y-auto rounded-xl border border-gray-700 bg-surface-300 shadow-2xl"
            style={{
              left: titlesMenu.x,
              top: titlesMenu.y,
              maxHeight: Math.max(160, window.innerHeight - titlesMenu.y - 8)
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="border-b border-gray-700 px-3 py-2.5">
              <div className="text-xs font-semibold text-white">Титры информационного экрана</div>
              <div className="mt-0.5 truncate text-[10px] text-gray-500">
                {informationMedia?.name || 'Внешний источник'}
              </div>
            </div>

            <div className="border-b border-gray-700 p-1.5">
              <div className="px-2 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-[.12em] text-emerald-400">
                Информация о мероприятии
              </div>
              <button
                type="button"
                disabled={!broadcastTitles.eventInfo.trim()}
                onClick={publishInformationEvent}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                  informationTitlesOutput.eventVisible ? 'bg-emerald-900/40' : 'hover:bg-gray-700/70'
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${informationTitlesOutput.eventVisible ? 'bg-red-500' : 'bg-emerald-500'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-gray-100">
                    {broadcastTitles.eventLabel.trim() || 'Без заголовка'}
                  </span>
                  <span className="block truncate text-[10px] text-gray-500">
                    {broadcastTitles.eventInfo.trim() || 'Заполните информацию через кнопку «▰ Титры»'}
                  </span>
                </span>
                {informationTitlesOutput.eventVisible && (
                  <span className="text-[8px] font-semibold text-red-300">ЭФИР</span>
                )}
              </button>
              {informationTitlesOutput.eventVisible && (
                <button
                  type="button"
                  onClick={() => {
                    updateInformationTitles({ eventVisible: false })
                    setTitlesMenu(null)
                  }}
                  className="mt-1 w-full rounded-md px-2.5 py-1.5 text-left text-[10px] font-medium text-red-300 hover:bg-red-950/40"
                >
                  Скрыть информацию о мероприятии
                </button>
              )}
            </div>

            <div className="px-3 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[.12em] text-cyan-400">
              Выступающие
            </div>
            {broadcastTitles.speakers.length > 0 ? (
              <div className="max-h-[310px] overflow-y-auto p-1.5">
                {broadcastTitles.speakers.map((speaker) => {
                  const live = informationTitlesOutput.speakerVisible &&
                    informationTitlesOutput.speakerId === speaker.id
                  return (
                    <button
                      key={speaker.id}
                      type="button"
                      disabled={!speaker.name.trim()}
                      onClick={() => publishInformationSpeaker(speaker.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                        live ? 'bg-cyan-900/45' : 'hover:bg-gray-700/70'
                      }`}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${live ? 'bg-red-500' : 'bg-cyan-600'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-gray-100">
                          {speaker.name.trim() || 'ФИО не заполнено'}
                        </span>
                        <span className="block truncate text-[10px] text-gray-500">
                          {speaker.role.trim() || 'Должность не указана'}
                        </span>
                      </span>
                      {live && <span className="text-[8px] font-semibold text-red-300">ЭФИР</span>}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="px-3 py-5 text-center text-[11px] text-gray-500">
                Сначала добавьте выступающих через кнопку «▰ Титры» в верхней панели.
              </div>
            )}

            {informationTitlesOutput.speakerVisible && (
              <button
                type="button"
                onClick={() => {
                  updateInformationTitles({ speakerVisible: false })
                  setTitlesMenu(null)
                }}
                className="w-full border-t border-gray-700 px-3 py-2.5 text-left text-[11px] font-medium text-red-300 hover:bg-red-950/40"
              >
                Скрыть титр выступающего
              </button>
            )}

            <div className="border-t border-gray-700 px-3 py-2.5">
              {informationTitlesVisible && (
                <button
                  type="button"
                  onClick={() => {
                    updateInformationTitles({ speakerVisible: false, eventVisible: false })
                    setTitlesMenu(null)
                  }}
                  className="mb-2 w-full rounded-md border border-red-900/70 bg-red-950/30 px-2.5 py-1.5 text-left text-[10px] font-medium text-red-300 hover:bg-red-950/60"
                >
                  Скрыть все титры этого источника
                </button>
              )}
              <p className="text-[9px] leading-relaxed text-gray-500">
                Если этот же источник выбран в канале, титр синхронно появится и там.
              </p>
            </div>
          </div>
        </>,
        document.body
      )}
      {devicePickerOpen && (
        <InformationDevicePicker
          onClose={() => setDevicePickerOpen(false)}
          onSelect={selectExternalDevice}
        />
      )}
      {desktopPickerOpen && (
        <DesktopCapturePicker
          excludedDisplayId={null}
          excludedDisplayIds={informationDisplayIds}
          overlayZClassName="z-[130]"
          onClose={() => setDesktopPickerOpen(false)}
          onSelect={selectDesktopSource}
        />
      )}
    </>
  )
}
