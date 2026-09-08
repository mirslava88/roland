import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mediaUrl } from '../../media'
import { useAppStore } from '../../stores/useAppStore'
import { CaptureThumbnail } from '../Capture/CaptureThumbnail'
import { SlideRenderer } from '../Preview/PreviewPanel'
import {
  DEFAULT_PROGRAM_SCENE_LAYOUT,
  PROGRAM_SCENE_PARTICIPANT_SCALE_MAX,
  PROGRAM_SCENE_PARTICIPANT_SCALE_MIN,
  PROGRAM_SCENE_TRANSITION_DURATION_MS,
  normalizeProgramSceneParticipantScale
} from '../../../../shared/program-scene'
import type {
  ProgramSceneCornerStyle,
  ProgramSceneParticipantSize,
  ProgramScenePlacement,
  ProgramSceneTransitionEffect
} from '../../../../shared/program-scene'

interface Props {
  onClose: () => void
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

function TransitionEffectIcon({ effect }: { effect: ProgramSceneTransitionEffect }): JSX.Element {
  if (effect === 'zoom-fade') {
    return <span className="relative h-4 w-5"><i className="absolute left-0 top-1 h-2 w-2 rounded-sm border border-current opacity-40" /><i className="absolute bottom-0 right-0 h-3 w-3 rounded-sm border-2 border-current" /></span>
  }
  if (effect === 'instant') {
    return <span className="text-sm font-bold leading-none">⚡</span>
  }
  return <span className="relative h-4 w-5"><i className="absolute left-0 top-0 h-3 w-3 rounded-sm border border-current" /><i className="absolute bottom-0 right-0 h-3 w-3 rounded-sm border border-current" /></span>
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

export function ProgramSceneModal({ onClose }: Props): JSX.Element {
  const storedProgramScene = useAppStore((state) => state.programScene)
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
    viewMode: storedProgramScene?.viewMode ?? 'both'
  }
  const setProgramScene = useAppStore((state) => state.setProgramScene)
  const captureSources = useAppStore((state) => state.captureSources)
  const addCaptureSource = useAppStore((state) => state.addCaptureSource)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const activeFile = useAppStore((state) => state.activeFile)
  const currentSlide = useAppStore((state) => state.currentSlide)
  const selectedChannel = useAppStore((state) => state.selectedChannel)
  const selectedFile = useAppStore((state) => state.selectedFile)
  const channels = useAppStore((state) => state.channels)
  const pptxThumbnailsMap = useAppStore((state) => state.pptxThumbnailsMap)
  const [devices, setDevices] = useState<CaptureDeviceDescriptor[]>([])
  const [devicesLoading, setDevicesLoading] = useState(true)
  const [devicesError, setDevicesError] = useState<string | null>(null)
  const [transitionPreviewRevision, setTransitionPreviewRevision] = useState(0)
  const requestGenerationRef = useRef(0)
  const videoDevices = useMemo(
    () => devices.filter((device) => device.kind === 'videoinput'),
    [devices]
  )
  const selectedCapture = captureSources.find(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )?.capture ?? null
  const selectedCaptureExists = captureSources.some(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )
  const selectedChannelState = selectedChannel ? channels[selectedChannel] : null
  const candidatePreviewFile = activeFile || selectedChannelState?.file || selectedFile
  const previewFile = candidatePreviewFile && (
    candidatePreviewFile.type === 'presentation' ||
    candidatePreviewFile.type === 'pdf' ||
    candidatePreviewFile.type === 'video' ||
    (candidatePreviewFile.type === 'capture' && candidatePreviewFile.capture?.captureKind === 'desktop') ||
    (candidatePreviewFile.type === 'other' && candidatePreviewFile.isImage)
  ) ? candidatePreviewFile : null
  const previewSlide = activeFile
    ? currentSlide
    : selectedChannelState && selectedChannelState.file?.path === previewFile?.path
      ? selectedChannelState.slide
      : 1
  const previewPptxThumbnails = previewFile?.type === 'presentation'
    ? pptxThumbnailsMap[previewFile.path] || []
    : []
  const selectedCaptureMatchesContent = candidatePreviewFile?.type === 'capture' &&
    candidatePreviewFile.capture?.sourceId === selectedCapture?.sourceId
  const canEnable = !!backdropImage && selectedCaptureExists && !selectedCaptureMatchesContent
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
  const contentFarInset = `${4 + participantWidthPercent + 3}%`
  const contentWidth = `${89 - participantWidthPercent}%`
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
      entry.capture?.captureKind !== 'device' ||
      captureIsUsedOutsideProgramScene(state, sourceId)
    ) return
    addCaptureSource({ ...entry, sceneOnly: true })
  }, [addCaptureSource])

  const loadDevices = useCallback((): void => {
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

  const selectedOption = selectedCapture?.captureKind === 'desktop'
    ? `source:${selectedCapture.sourceId}`
    : selectedCapture?.videoDeviceId
      ? `device:${selectedCapture.videoDeviceId}`
      : ''

  const selectBackdrop = async (): Promise<void> => {
    const path = await window.api.selectBackdropImage()
    if (!path) return
    const state = useAppStore.getState()
    state.setBackdropImage(path)
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

  const selectExternalSource = (value: string): void => {
    if (!value) {
      setProgramScene({ captureSourceId: null, enabled: false })
      return
    }
    if (value.startsWith('source:')) {
      setProgramScene({ captureSourceId: value.slice('source:'.length) })
      return
    }
    const deviceId = value.slice('device:'.length)
    const device = videoDevices.find((candidate) => candidate.deviceId === deviceId)
    if (!device) return
    const existing = captureSources.find(
      (entry) => entry.capture?.captureKind !== 'desktop' && entry.capture?.videoDeviceId === device.deviceId
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

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-2" onMouseDown={onClose}>
      <div
        className="w-[520px] max-w-[92vw] rounded-xl border border-gray-700 bg-surface-300 p-3 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Картинка в картинке</h2>
            <p className="mt-1 text-xs text-gray-400">
              Фон остаётся на весь экран. Камера и презентация размещаются рядом и не перекрывают друг друга.
            </p>
          </div>
          <button className="text-xl leading-none text-gray-400 hover:text-white" onClick={onClose}>×</button>
        </div>

        <div
          className="relative mb-2 aspect-video overflow-hidden rounded-lg border border-gray-700 bg-gray-950 bg-cover bg-center"
          style={backdropImage ? { backgroundImage: `url(${mediaUrl(backdropImage)})` } : undefined}
        >
          <div
            className={`absolute flex items-center justify-center text-[11px] font-semibold text-gray-800 shadow-xl overflow-hidden ${previewFile ? 'bg-transparent' : 'bg-white/90'}`}
            style={{
              width: contentWidth,
              aspectRatio: '16 / 9',
              left: participantOnLeft ? contentFarInset : '4%',
              top: '50%',
              transform: 'translateY(-50%)',
              borderRadius: previewRadius
            }}
          >
            <div className="flex h-full w-full items-center justify-center" style={previewAnimationStyle}>
              {previewFile ? (
                <SlideRenderer
                  file={previewFile}
                  slideNum={previewSlide}
                  pptxThumbnails={previewPptxThumbnails}
                  onTotalSlides={() => undefined}
                />
              ) : (
                <span className="text-[10px] text-gray-500">ПРЕЗЕНТАЦИЯ НЕ ВЫБРАНА</span>
              )}
            </div>
          </div>
          <div
            className="absolute bg-slate-700 text-center text-[10px] text-white shadow-xl flex items-center justify-center overflow-hidden"
            style={{
              width: participantWidth,
              aspectRatio: `16 / ${9 * programScene.participantScale}`,
              left: participantOnLeft ? '4%' : undefined,
              right: participantOnLeft ? undefined : '4%',
              top: vertical === 'top' ? '10%' : vertical === 'center' ? '50%' : undefined,
              bottom: vertical === 'bottom' ? '10%' : undefined,
              transform: vertical === 'center' ? 'translateY(-50%)' : undefined,
              borderRadius: previewRadius
            }}
          >
            <div className="flex h-full w-full items-center justify-center" style={previewAnimationStyle}>
              {selectedCapture ? (
                <CaptureThumbnail
                  config={selectedCapture}
                  className="h-full w-full"
                  fit={selectedCapture.captureKind === 'device' ? 'cover' : 'contain'}
                />
              ) : (
                <span className="px-2">ВНЕШНИЙ ИСТОЧНИК НЕ ВЫБРАН</span>
              )}
            </div>
          </div>
          {!backdropImage && (
            <button
              type="button"
              onClick={() => void selectBackdrop()}
              className="absolute inset-x-0 bottom-2 z-10 mx-auto w-fit rounded-md border border-amber-400/50 bg-gray-950/90 px-3 py-1 text-center text-[10px] font-medium text-amber-300 shadow-lg hover:border-amber-300 hover:bg-gray-900 hover:text-amber-200"
              title="Выбрать изображение фона"
            >
              Сначала выберите фон
            </button>
          )}
        </div>

        <label className="mb-1 block text-xs text-gray-300">Внешний источник</label>
        <select
          value={selectedOption}
          onChange={(event) => selectExternalSource(event.target.value)}
          className="mb-2 w-full rounded-lg border border-gray-700 bg-surface-100 px-3 py-1 text-sm text-white outline-none focus:border-blue-500"
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
        {devicesError && (
          <div className="-mt-1 mb-2 flex items-center justify-between gap-3 text-xs text-amber-300">
            <span>{devicesError}</span>
            <button className="text-blue-300 hover:text-blue-200" onClick={loadDevices}>Обновить</button>
          </div>
        )}

        <div className="mb-2 grid grid-cols-2 gap-3">
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
            <div className="grid grid-cols-4 gap-1">
              {SIZES.map((item) => (
                <button
                  key={item.value}
                  onClick={() => setProgramScene({ participantSize: item.value })}
                  className={`rounded px-2 py-0.5 text-[10px] ${programScene.participantSize === item.value
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

        <div className="mb-2 grid grid-cols-2 gap-3">
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

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-gray-400">
            {!backdropImage
              ? 'Нужен выбранный фон.'
              : !selectedCaptureExists
                ? 'Выберите внешний источник.'
                : selectedCaptureMatchesContent
                  ? 'Для участника выберите источник, отличный от основного окна или экрана.'
                : 'Режим можно менять прямо во время эфира.'}
          </div>
          <button
            disabled={!canEnable && !programScene.enabled}
            onClick={() => setProgramScene(programScene.enabled
              ? { enabled: false }
              : { enabled: true, viewMode: 'both' })}
            className={`rounded-lg px-4 py-1 text-sm font-medium ${programScene.enabled
              ? 'bg-red-600 text-white hover:bg-red-500'
              : canEnable
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'cursor-not-allowed bg-gray-700 text-gray-500'}`}
          >
            {programScene.enabled ? 'Выключить режим' : 'Включить режим'}
          </button>
        </div>
      </div>
    </div>
  )
}
