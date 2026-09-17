import { useMemo, useState } from 'react'
import {
  captureSourceIdentity,
  DEFAULT_BROADCAST_TITLES_OUTPUT,
  useAppStore,
  type BroadcastSpeaker,
  type BroadcastTitleEffect,
  type BroadcastTitlePosition,
  type BroadcastTitleStyle,
  type BroadcastTitlesOutput
} from '../../stores/useAppStore'
import { CaptureThumbnail } from '../Capture/CaptureThumbnail'
import { SceneLayerControlBar, SceneLayerToggleButton } from '../ProgramScene/SceneLayerControlBar'
import { BroadcastTitlesOverlay } from './BroadcastTitlesOverlay'
import { resolveProgramSceneBackground } from '../../program-scene-background'

const ENTER_EFFECT_OPTIONS: Array<{ value: BroadcastTitleEffect; label: string }> = [
  { value: 'instant', label: 'Мгновенно' },
  { value: 'fade', label: 'Плавное появление' },
  { value: 'slide-left', label: 'Выплывание слева' },
  { value: 'slide-right', label: 'Выплывание справа' },
  { value: 'slide-up', label: 'Выплывание снизу' },
  { value: 'scale', label: 'Увеличение' }
]

const EXIT_EFFECT_OPTIONS: Array<{ value: BroadcastTitleEffect; label: string }> = [
  { value: 'instant', label: 'Мгновенно' },
  { value: 'fade', label: 'Плавное исчезновение' },
  { value: 'slide-left', label: 'Уход влево' },
  { value: 'slide-right', label: 'Уход вправо' },
  { value: 'slide-up', label: 'Уход вниз' },
  { value: 'scale', label: 'Уменьшение' }
]

const POSITION_OPTIONS: Array<{ value: BroadcastTitlePosition; icon: string; label: string }> = [
  { value: 'top-left', icon: '↖', label: 'Слева вверху' },
  { value: 'top-center', icon: '↑', label: 'По центру вверху' },
  { value: 'top-right', icon: '↗', label: 'Справа вверху' },
  { value: 'center-left', icon: '←', label: 'Слева по центру' },
  { value: 'center', icon: '•', label: 'По центру' },
  { value: 'center-right', icon: '→', label: 'Справа по центру' },
  { value: 'bottom-left', icon: '↙', label: 'Слева внизу' },
  { value: 'bottom-center', icon: '↓', label: 'По центру внизу' },
  { value: 'bottom-right', icon: '↘', label: 'Справа внизу' }
]

const STYLE_OPTIONS: Array<{ value: BroadcastTitleStyle; label: string }> = [
  { value: 'rounded', label: 'Скруглённый прямоугольник' },
  { value: 'rectangle', label: 'Строгий прямоугольник' },
  { value: 'slant-right', label: 'Наклонная правая сторона' },
  { value: 'slant-left', label: 'Наклонная левая сторона' },
  { value: 'pill', label: 'Капсула' }
]

function createSpeakerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `speaker-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function parseSeconds(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(86400, parsed)) : 0
}

const OFFICE_PROGRAM_EXTENSIONS = new Set(['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.ods'])

function supportsProgramSceneTitles(file?: FileEntry | null): boolean {
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

export function BroadcastTitles(): JSX.Element {
  const [open, setOpen] = useState(false)
  const isVisible = useAppStore((state) => {
    const selectedCapture = state.selectedChannel
      ? state.channels[state.selectedChannel]?.file?.capture
      : undefined
    const activeCapture = state.activeFile?.type === 'capture' ? state.activeFile.capture : undefined
    const sceneBackground = resolveProgramSceneBackground(state)
    const sceneSupportsTitles = state.programScene.enabled &&
      (!state.activeFile || supportsProgramSceneTitles(state.activeFile))
    const sceneCapture = sceneSupportsTitles
      ? state.captureSources.find(
        (entry) => entry.capture?.sourceId === state.programScene.captureSourceId
      )?.capture
      : undefined
    const informationCapture = state.informationMedia?.type === 'capture'
      ? state.informationMedia.capture
      : undefined
    const sceneCaptureConflicts = !!sceneCapture && (
      (state.activeFile?.type === 'capture' && state.activeFile.capture?.sourceId === sceneCapture.sourceId) ||
      (sceneBackground?.type === 'capture' && sceneBackground.capture.sourceId === sceneCapture.sourceId)
    )
    const sceneSourceIdentity = sceneCaptureConflicts ? null : captureSourceIdentity(sceneCapture)
    const informationSourceIdentity = captureSourceIdentity(informationCapture)
    const informationOutputAssigned = state.displays.some((display) => (
      !display.isPrimary && state.displayAssignments[String(display.id)] === 'information'
    ))
    const sourceIdentity = sceneSourceIdentity || state.programCaptureTitlesSourceIdentity ||
      (informationOutputAssigned ? informationSourceIdentity : null) ||
      captureSourceIdentity(selectedCapture) || captureSourceIdentity(activeCapture) ||
      informationSourceIdentity
    const output = sourceIdentity
      ? state.captureTitlesOutputs[sourceIdentity]
      : undefined
    return !!output && (output.speakerVisible || output.eventVisible)
  })

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-[11px] px-1.5 py-1 rounded-lg font-medium transition-colors border whitespace-nowrap ${
          isVisible
            ? 'bg-cyan-700/80 border-cyan-500 text-white hover:bg-cyan-700'
            : 'bg-surface-100 border-gray-700 text-gray-300 hover:bg-gray-700'
        }`}
        title="Титры поверх внешнего источника"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        ▰ Титры
      </button>
      {open && <BroadcastTitlesModal onClose={() => setOpen(false)} />}
    </>
  )
}

interface BroadcastTitlesModalProps {
  onClose: () => void
  embedded?: boolean
}

export function BroadcastTitlesModal({ onClose, embedded = false }: BroadcastTitlesModalProps): JSX.Element {
  const {
    activeFile,
    informationMedia,
    displayAssignments,
    displays,
    programCaptureTitlesSourceIdentity,
    selectedChannel,
    channels,
    broadcastTitles,
    captureTitlesOutputs,
    captureSources,
    backdropImage,
    programScene,
    setBroadcastTitles,
    setCaptureTitlesOutput
  } = useAppStore()

  const selectedFile = selectedChannel ? channels[selectedChannel]?.file : null
  const selectedCapture = selectedFile?.type === 'capture' ? selectedFile.capture : undefined
  const activeCapture = activeFile?.type === 'capture' ? activeFile.capture : undefined
  const sceneBackground = resolveProgramSceneBackground(useAppStore.getState())
  const sceneSupportsTitles = programScene.enabled &&
    (!activeFile || supportsProgramSceneTitles(activeFile))
  const sceneCapture = sceneSupportsTitles
    ? captureSources.find((entry) => entry.capture?.sourceId === programScene.captureSourceId)?.capture
    : undefined
  const informationCapture = informationMedia?.type === 'capture' ? informationMedia.capture : undefined
  const sceneCaptureConflicts = !!sceneCapture && (
    (activeFile?.type === 'capture' && activeFile.capture?.sourceId === sceneCapture.sourceId) ||
    (sceneBackground?.type === 'capture' && sceneBackground.capture.sourceId === sceneCapture.sourceId)
  )
  const sceneSourceIdentity = sceneCaptureConflicts ? null : captureSourceIdentity(sceneCapture)
  const activeSourceIdentity = sceneSourceIdentity || programCaptureTitlesSourceIdentity
  const informationSourceIdentity = captureSourceIdentity(informationCapture)
  const informationOutputAssigned = displays.some((display) => (
    !display.isPrimary && displayAssignments[String(display.id)] === 'information'
  ))
  // Target what is actually visible before considering a merely selected
  // channel. Otherwise a selected, off-air capture steals title commands from
  // the camera currently shown on the information display.
  const sourceIdentity = activeSourceIdentity ||
    (informationOutputAssigned ? informationSourceIdentity : null) ||
    captureSourceIdentity(selectedCapture) || captureSourceIdentity(activeCapture) ||
    informationSourceIdentity
  const previewCapture = [sceneCapture, activeCapture, selectedCapture, ...captureSources.map((entry) => entry.capture), informationCapture]
    .find((capture) => captureSourceIdentity(capture) === sourceIdentity)
  const previewUsesInformationFallback = previewCapture === informationCapture &&
    sourceIdentity === informationSourceIdentity && !activeSourceIdentity
  const broadcastTitlesOutput = sourceIdentity
    ? captureTitlesOutputs[sourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : DEFAULT_BROADCAST_TITLES_OUTPUT
  const setTargetTitlesOutput = (update: Partial<BroadcastTitlesOutput>): void => {
    if (sourceIdentity) setCaptureTitlesOutput(sourceIdentity, update)
  }
  const captureOnAir = !!sourceIdentity && (
    sourceIdentity === activeSourceIdentity || (
      sourceIdentity === informationSourceIdentity &&
      informationOutputAssigned
    )
  )
  const targetsInformationOutput = !!sourceIdentity && !activeSourceIdentity &&
    informationOutputAssigned && sourceIdentity === informationSourceIdentity
  const selectedSpeaker = broadcastTitles.speakers.find(
    (speaker) => speaker.id === broadcastTitles.selectedSpeakerId
  ) || null
  const anythingVisible = broadcastTitlesOutput.speakerVisible || broadcastTitlesOutput.eventVisible

  const previewTitles = useMemo<BroadcastTitlesOutput>(() => ({
    speakerRevision: 0,
    eventRevision: 0,
    speakerId: selectedSpeaker?.id || null,
    speakerName: selectedSpeaker?.name || '',
    speakerRole: selectedSpeaker?.role || '',
    eventLabel: broadcastTitles.eventLabel,
    eventInfo: broadcastTitles.eventInfo,
    speakerEnterEffect: broadcastTitles.speakerEnterEffect,
    speakerExitEffect: broadcastTitles.speakerExitEffect,
    speakerAutoHideSeconds: broadcastTitles.speakerAutoHideSeconds,
    speakerStyle: broadcastTitles.speakerStyle,
    speakerTextColor: broadcastTitles.speakerTextColor,
    speakerBackgroundStart: broadcastTitles.speakerBackgroundStart,
    speakerBackgroundEnd: broadcastTitles.speakerBackgroundEnd,
    speakerAccentStart: broadcastTitles.speakerAccentStart,
    speakerAccentEnd: broadcastTitles.speakerAccentEnd,
    eventEnterEffect: broadcastTitles.eventEnterEffect,
    eventExitEffect: broadcastTitles.eventExitEffect,
    eventAutoHideSeconds: broadcastTitles.eventAutoHideSeconds,
    eventPosition: broadcastTitles.eventPosition,
    eventStyle: broadcastTitles.eventStyle,
    eventTextColor: broadcastTitles.eventTextColor,
    eventBackgroundStart: broadcastTitles.eventBackgroundStart,
    eventBackgroundEnd: broadcastTitles.eventBackgroundEnd,
    eventAccentStart: broadcastTitles.eventAccentStart,
    eventAccentEnd: broadcastTitles.eventAccentEnd,
    speakerVisible: !!selectedSpeaker?.name.trim(),
    eventVisible: broadcastTitles.eventInfo.trim().length > 0
  }), [broadcastTitles, selectedSpeaker])

  const updateSpeaker = (id: string, update: Partial<BroadcastSpeaker>): void => {
    setBroadcastTitles({
      speakers: broadcastTitles.speakers.map((speaker) => speaker.id === id
        ? { ...speaker, ...update }
        : speaker)
    })
  }

  const addSpeaker = (): void => {
    const speaker: BroadcastSpeaker = { id: createSpeakerId(), name: '', role: '' }
    setBroadcastTitles({
      speakers: [...broadcastTitles.speakers, speaker],
      selectedSpeakerId: speaker.id
    })
  }

  const removeSpeaker = (id: string): void => {
    const nextSpeakers = broadcastTitles.speakers.filter((speaker) => speaker.id !== id)
    const nextSelectedId = broadcastTitles.selectedSpeakerId === id
      ? nextSpeakers[0]?.id || null
      : broadcastTitles.selectedSpeakerId
    setBroadcastTitles({ speakers: nextSpeakers, selectedSpeakerId: nextSelectedId })
  }

  const publishSpeaker = (): void => {
    if (!selectedSpeaker?.name.trim()) return
    setTargetTitlesOutput({
      speakerId: selectedSpeaker.id,
      speakerName: selectedSpeaker.name,
      speakerRole: selectedSpeaker.role,
      speakerEnterEffect: broadcastTitles.speakerEnterEffect,
      speakerExitEffect: broadcastTitles.speakerExitEffect,
      speakerAutoHideSeconds: broadcastTitles.speakerAutoHideSeconds,
      speakerStyle: broadcastTitles.speakerStyle,
      speakerTextColor: broadcastTitles.speakerTextColor,
      speakerBackgroundStart: broadcastTitles.speakerBackgroundStart,
      speakerBackgroundEnd: broadcastTitles.speakerBackgroundEnd,
      speakerAccentStart: broadcastTitles.speakerAccentStart,
      speakerAccentEnd: broadcastTitles.speakerAccentEnd,
      speakerVisible: true
    })
  }

  const publishEvent = (): void => {
    if (!broadcastTitles.eventInfo.trim()) return
    setTargetTitlesOutput({
      eventLabel: broadcastTitles.eventLabel,
      eventInfo: broadcastTitles.eventInfo,
      eventEnterEffect: broadcastTitles.eventEnterEffect,
      eventExitEffect: broadcastTitles.eventExitEffect,
      eventAutoHideSeconds: broadcastTitles.eventAutoHideSeconds,
      eventPosition: broadcastTitles.eventPosition,
      eventStyle: broadcastTitles.eventStyle,
      eventTextColor: broadcastTitles.eventTextColor,
      eventBackgroundStart: broadcastTitles.eventBackgroundStart,
      eventBackgroundEnd: broadcastTitles.eventBackgroundEnd,
      eventAccentStart: broadcastTitles.eventAccentStart,
      eventAccentEnd: broadcastTitles.eventAccentEnd,
      eventVisible: true
    })
  }

  const publishAllTitles = (): void => {
    if (!sourceIdentity || !selectedSpeaker?.name.trim() || !broadcastTitles.eventInfo.trim()) return
    publishSpeaker()
    publishEvent()
  }

  return (
    <div className={embedded ? 'contents' : 'fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4'}>
      <div data-broadcast-titles-editor={embedded ? true : undefined} className={embedded
        ? 'flex min-h-0 w-full flex-1 flex-col overflow-hidden text-white'
        : 'flex h-[min(900px,96vh)] w-[min(1320px,97vw)] flex-col overflow-hidden rounded-2xl border border-gray-700 bg-surface-300 shadow-2xl'}>
        {!embedded && <div className="flex shrink-0 items-center gap-3 border-b border-gray-800 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-white">Титры внешнего источника</h2>
            <p className="mt-0.5 text-[11px] text-gray-500">Список выступающих и информация о мероприятии</p>
          </div>
          <div className="flex-1" />
          <div className={`rounded-full px-3 py-1 text-[10px] font-medium ${
            captureOnAir
              ? 'bg-emerald-900/60 text-emerald-300'
              : anythingVisible
                ? 'bg-amber-900/50 text-amber-300'
                : 'bg-gray-800 text-gray-500'
          }`}>
            {captureOnAir
              ? 'Внешний источник в эфире'
              : anythingVisible
                ? 'Титры подготовлены и появятся на внешнем источнике'
                : 'Титры скрыты'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
            title="Закрыть"
            aria-label="Закрыть панель титров"
          >
            ✕
          </button>
        </div>}

        <SceneLayerControlBar
          active={anythingVisible}
          status={!anythingVisible
            ? 'Титры скрыты'
            : broadcastTitlesOutput.speakerVisible && broadcastTitlesOutput.eventVisible
              ? 'Выступающий и мероприятие в эфире'
              : broadcastTitlesOutput.speakerVisible
                ? 'Выступающий в эфире'
                : 'Мероприятие в эфире'}
          detail={!sourceIdentity
            ? 'Выберите внешний источник'
            : captureOnAir
              ? targetsInformationOutput
                ? 'Слой виден на информационном экране'
                : 'Слой виден на программном экране'
              : 'Слой подготовлен для внешнего источника'}
        >
          <button
            data-broadcast-titles-show-all
            type="button"
            disabled={!sourceIdentity || !selectedSpeaker?.name.trim() || !broadcastTitles.eventInfo.trim()}
            onClick={publishAllTitles}
            title="Показать титр выступающего и информацию о мероприятии"
            className="h-7 rounded-md border border-red-400 bg-red-600 px-3 text-[10px] font-semibold text-white shadow-[0_0_10px_rgba(220,38,38,.35)] transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:border-gray-800 disabled:bg-surface-100 disabled:text-gray-600 disabled:shadow-none"
          >
            Показать все
          </button>
          <SceneLayerToggleButton
            buttonProps={{ 'data-broadcast-titles-speaker-visible': true }}
            pressed={broadcastTitlesOutput.speakerVisible}
            tone="air"
            disabled={!broadcastTitlesOutput.speakerVisible && (!sourceIdentity || !selectedSpeaker?.name.trim())}
            title="Показать или скрыть титр выступающего"
            onPressedChange={(pressed) => {
              if (pressed) publishSpeaker()
              else setTargetTitlesOutput({ speakerVisible: false })
            }}
          >
            Выступающий
          </SceneLayerToggleButton>
          <SceneLayerToggleButton
            buttonProps={{ 'data-broadcast-titles-event-visible': true }}
            pressed={broadcastTitlesOutput.eventVisible}
            tone="air"
            disabled={!broadcastTitlesOutput.eventVisible && (!sourceIdentity || !broadcastTitles.eventInfo.trim())}
            title="Показать или скрыть информацию о мероприятии"
            onPressedChange={(pressed) => {
              if (pressed) publishEvent()
              else setTargetTitlesOutput({ eventVisible: false })
            }}
          >
            Мероприятие
          </SceneLayerToggleButton>
        </SceneLayerControlBar>

        <div className={`grid min-h-0 flex-1 ${embedded
          ? 'grid-cols-[minmax(420px,2fr)_minmax(0,3fr)] gap-3'
          : 'grid-cols-[minmax(0,3fr)_minmax(440px,2fr)] gap-4 p-4'}`}>
          <section data-broadcast-titles-preview className="flex min-h-0 flex-col rounded-xl border border-gray-700 bg-black/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[.16em] text-gray-400">Предварительный просмотр</span>
              <span className="text-[10px] text-gray-600">Изменения здесь не меняют эфир</span>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-700 bg-[radial-gradient(circle_at_30%_30%,#253a48_0%,#111827_48%,#05070b_100%)]">
              {previewCapture && !previewUsesInformationFallback ? (
                <div className="absolute inset-0">
                  <CaptureThumbnail config={previewCapture} className="h-full w-full" />
                </div>
              ) : previewCapture ? (
                <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_50%_35%,#244050_0%,#111827_52%,#05070b_100%)]">
                  <div className="max-w-[80%] text-center text-gray-400">
                    <div className="text-4xl font-light tracking-[.18em] text-gray-300">ЭФИР</div>
                    <div className="mt-2 truncate text-xs text-gray-400">{previewCapture.videoLabel}</div>
                    <div className="mt-1 text-[10px] text-gray-600">Информационный внешний источник</div>
                  </div>
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center text-gray-600">
                    <div className="mb-2 text-4xl opacity-40">◉</div>
                    <div className="text-xs">Выберите канал с внешним источником</div>
                  </div>
                </div>
              )}
              <BroadcastTitlesOverlay titles={previewTitles} />
            </div>
          </section>

          <aside className={embedded
            ? 'grid min-h-0 grid-cols-2 gap-3 overflow-hidden'
            : 'min-h-0 space-y-3 overflow-y-auto pr-1'}>
            <section className={`rounded-xl border border-gray-700 bg-surface-200 ${embedded ? 'min-h-0 overflow-hidden p-3' : 'p-4'}`}>
              <div className="mb-3 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-gradient-to-b from-emerald-400 to-cyan-500" />
                <h3 className="text-sm font-semibold text-white">Выступающие</h3>
                <span className="text-[10px] text-gray-500">{broadcastTitles.speakers.length}</span>
                <button
                  type="button"
                  onClick={addSpeaker}
                  className="ml-auto rounded-lg bg-cyan-800 px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-cyan-700"
                >
                  + Добавить
                </button>
              </div>

              {broadcastTitles.speakers.length > 0 ? (
                <div className="mb-3 max-h-44 space-y-1.5 overflow-y-auto pr-1">
                  {broadcastTitles.speakers.map((speaker, index) => {
                    const selected = speaker.id === selectedSpeaker?.id
                    const live = broadcastTitlesOutput.speakerVisible && broadcastTitlesOutput.speakerId === speaker.id
                    return (
                      <div
                        key={speaker.id}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                          selected ? 'border-cyan-600 bg-cyan-950/30' : 'border-gray-750 bg-surface-100 hover:border-gray-600'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setBroadcastTitles({ selectedSpeakerId: speaker.id })}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate text-xs font-medium text-white">
                            {speaker.name.trim() || `Выступающий ${index + 1}`}
                          </div>
                          <div className="truncate text-[10px] text-gray-500">{speaker.role.trim() || 'Должность не указана'}</div>
                        </button>
                        {live && <span className="rounded-full bg-red-900/60 px-1.5 py-0.5 text-[8px] font-semibold text-red-300">ЭФИР</span>}
                        <button
                          type="button"
                          onClick={() => removeSpeaker(speaker.id)}
                          className="rounded p-1 text-gray-600 hover:bg-red-950/50 hover:text-red-300"
                          title="Удалить выступающего"
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={addSpeaker}
                  className="mb-3 w-full rounded-lg border border-dashed border-gray-700 px-3 py-4 text-xs text-gray-500 hover:border-cyan-700 hover:text-cyan-300"
                >
                  Добавить первого выступающего
                </button>
              )}

              {selectedSpeaker && (
                <div className={embedded
                  ? 'grid grid-cols-2 gap-2 border-t border-gray-700 pt-2'
                  : 'space-y-3 border-t border-gray-700 pt-3'}>
                  <label className="block">
                    <span className="mb-1 block text-[10px] text-gray-400">ФИО выступающего</span>
                    <input
                      data-pdm-training-speaker-name
                      type="text"
                      maxLength={120}
                      value={selectedSpeaker.name}
                      onChange={(event) => updateSpeaker(selectedSpeaker.id, { name: event.target.value })}
                      placeholder="Имя выступающего"
                      className="w-full rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-sm text-white outline-hidden placeholder:text-gray-600 focus:border-cyan-500"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[10px] text-gray-400">Должность</span>
                    <input
                      type="text"
                      maxLength={180}
                      value={selectedSpeaker.role}
                      onChange={(event) => updateSpeaker(selectedSpeaker.id, { role: event.target.value })}
                      placeholder="Генеральный директор компании"
                      className="w-full rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-sm text-white outline-hidden placeholder:text-gray-600 focus:border-cyan-500"
                    />
                  </label>

                  <div>
                    <EffectControls
                      enterEffect={broadcastTitles.speakerEnterEffect}
                      exitEffect={broadcastTitles.speakerExitEffect}
                      autoHideSeconds={broadcastTitles.speakerAutoHideSeconds}
                      onEnterEffect={(speakerEnterEffect) => setBroadcastTitles({ speakerEnterEffect })}
                      onExitEffect={(speakerExitEffect) => setBroadcastTitles({ speakerExitEffect })}
                      onAutoHide={(speakerAutoHideSeconds) => setBroadcastTitles({ speakerAutoHideSeconds })}
                    />
                  </div>

                  <div>
                    <DesignControls
                      style={broadcastTitles.speakerStyle}
                      textColor={broadcastTitles.speakerTextColor}
                      backgroundStart={broadcastTitles.speakerBackgroundStart}
                      backgroundEnd={broadcastTitles.speakerBackgroundEnd}
                      accentStart={broadcastTitles.speakerAccentStart}
                      accentEnd={broadcastTitles.speakerAccentEnd}
                      accentLabel="Полоска слева"
                      accentSide="left"
                      onChange={(update) => setBroadcastTitles({
                        speakerStyle: update.style ?? broadcastTitles.speakerStyle,
                        speakerTextColor: update.textColor ?? broadcastTitles.speakerTextColor,
                        speakerBackgroundStart: update.backgroundStart ?? broadcastTitles.speakerBackgroundStart,
                        speakerBackgroundEnd: update.backgroundEnd ?? broadcastTitles.speakerBackgroundEnd,
                        speakerAccentStart: update.accentStart ?? broadcastTitles.speakerAccentStart,
                        speakerAccentEnd: update.accentEnd ?? broadcastTitles.speakerAccentEnd
                      })}
                    />
                  </div>

                </div>
              )}
            </section>

            <section className={`rounded-xl border border-gray-700 bg-surface-200 ${embedded
              ? 'grid min-h-0 grid-cols-2 content-start gap-x-3 gap-y-2 overflow-hidden p-2.5'
              : 'p-4'}`}>
              <div className={`${embedded ? 'col-span-2' : 'mb-3'} flex items-center gap-2`}>
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <h3 className="text-sm font-semibold text-white">Информация о мероприятии</h3>
                {broadcastTitlesOutput.eventVisible && (
                  <span className="ml-auto rounded-full bg-red-900/60 px-2 py-0.5 text-[9px] font-semibold text-red-300">В ЭФИРЕ</span>
                )}
              </div>

              <label className={embedded ? 'block' : 'mb-3 block'}>
                <span className="mb-1 block text-[10px] text-gray-400">Заголовок над информацией</span>
                <input
                  type="text"
                  maxLength={80}
                  value={broadcastTitles.eventLabel}
                  onChange={(event) => setBroadcastTitles({ eventLabel: event.target.value })}
                  placeholder="МЕРОПРИЯТИЕ"
                  className="w-full rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-sm text-white outline-hidden placeholder:text-gray-600 focus:border-emerald-500"
                />
              </label>

              <textarea
                data-pdm-training-event-info
                maxLength={320}
                rows={embedded ? 2 : 3}
                value={broadcastTitles.eventInfo}
                onChange={(event) => setBroadcastTitles({ eventInfo: event.target.value })}
                placeholder={'Ежегодная конференция\nМосква • 2026'}
                className="w-full resize-none rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-sm leading-snug text-white outline-hidden placeholder:text-gray-600 focus:border-emerald-500"
              />

              <div className={embedded ? 'col-start-1' : 'mt-3'}>
                <span className="mb-1.5 block text-[10px] text-gray-400">Положение на экране</span>
                <div className="grid grid-cols-3 gap-1.5">
                  {POSITION_OPTIONS.map((position) => (
                    <button
                      key={position.value}
                      type="button"
                      onClick={() => setBroadcastTitles({ eventPosition: position.value })}
                      className={`rounded-md border py-1.5 text-sm ${
                        broadcastTitles.eventPosition === position.value
                          ? 'border-emerald-500 bg-emerald-900/50 text-emerald-200'
                          : 'border-gray-700 bg-surface-100 text-gray-500 hover:border-gray-600 hover:text-gray-300'
                      }`}
                      title={position.label}
                    >
                      {position.icon}
                    </button>
                  ))}
                </div>
              </div>

              <div className={embedded ? 'col-start-2 row-start-2 row-span-3' : 'mt-3'}>
                <EffectControls
                  enterEffect={broadcastTitles.eventEnterEffect}
                  exitEffect={broadcastTitles.eventExitEffect}
                  autoHideSeconds={broadcastTitles.eventAutoHideSeconds}
                  onEnterEffect={(eventEnterEffect) => setBroadcastTitles({ eventEnterEffect })}
                  onExitEffect={(eventExitEffect) => setBroadcastTitles({ eventExitEffect })}
                  onAutoHide={(eventAutoHideSeconds) => setBroadcastTitles({ eventAutoHideSeconds })}
                />
                <div className={embedded ? 'mt-2' : 'mt-3'}>
                  <DesignControls
                    style={broadcastTitles.eventStyle}
                    textColor={broadcastTitles.eventTextColor}
                    backgroundStart={broadcastTitles.eventBackgroundStart}
                    backgroundEnd={broadcastTitles.eventBackgroundEnd}
                    accentStart={broadcastTitles.eventAccentStart}
                    accentEnd={broadcastTitles.eventAccentEnd}
                    accentLabel="Полоска справа"
                    accentSide="right"
                    onChange={(update) => setBroadcastTitles({
                      eventStyle: update.style ?? broadcastTitles.eventStyle,
                      eventTextColor: update.textColor ?? broadcastTitles.eventTextColor,
                      eventBackgroundStart: update.backgroundStart ?? broadcastTitles.eventBackgroundStart,
                      eventBackgroundEnd: update.backgroundEnd ?? broadcastTitles.eventBackgroundEnd,
                      eventAccentStart: update.accentStart ?? broadcastTitles.eventAccentStart,
                      eventAccentEnd: update.accentEnd ?? broadcastTitles.eventAccentEnd
                    })}
                  />
                </div>
              </div>

            </section>

            <button
              type="button"
              onClick={() => setTargetTitlesOutput({ speakerVisible: false, eventVisible: false })}
              disabled={!anythingVisible}
              className={`${embedded ? 'col-span-2' : 'w-full'} rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2.5 text-xs font-semibold text-red-300 hover:bg-red-950/60 disabled:cursor-not-allowed disabled:opacity-30`}
            >
              Скрыть все титры
            </button>
          </aside>
        </div>
      </div>
    </div>
  )
}

interface EffectControlsProps {
  enterEffect: BroadcastTitleEffect
  exitEffect: BroadcastTitleEffect
  autoHideSeconds: number
  onEnterEffect: (effect: BroadcastTitleEffect) => void
  onExitEffect: (effect: BroadcastTitleEffect) => void
  onAutoHide: (seconds: number) => void
}

function EffectControls({
  enterEffect,
  exitEffect,
  autoHideSeconds,
  onEnterEffect,
  onExitEffect,
  onAutoHide
}: EffectControlsProps): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block">
        <span className="mb-1 block text-[10px] text-gray-400">Появление</span>
        <select
          value={enterEffect}
          onChange={(event) => onEnterEffect(event.target.value as BroadcastTitleEffect)}
          className="w-full rounded-lg border border-gray-700 bg-surface-100 px-2 py-2 text-[11px] text-gray-200 outline-hidden focus:border-cyan-500"
        >
          {ENTER_EFFECT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[10px] text-gray-400">Исчезновение</span>
        <select
          value={exitEffect}
          onChange={(event) => onExitEffect(event.target.value as BroadcastTitleEffect)}
          className="w-full rounded-lg border border-gray-700 bg-surface-100 px-2 py-2 text-[11px] text-gray-200 outline-hidden focus:border-cyan-500"
        >
          {EXIT_EFFECT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label
        data-broadcast-titles-auto-hide
        className="col-span-2 grid grid-cols-[minmax(0,1fr)_56px_auto] items-center gap-1.5 rounded-lg border border-gray-700 bg-surface-100 px-2 py-1.5"
        title="0 секунд — не скрывать автоматически"
      >
        <span className="min-w-0 text-[10px] leading-tight text-gray-400">Автоматически скрыть через</span>
        <input
          type="number"
          min={0}
          max={86400}
          step={1}
          value={autoHideSeconds}
          onChange={(event) => onAutoHide(parseSeconds(event.target.value))}
          className="h-7 w-14 rounded-md border border-gray-700 bg-surface-200 px-1.5 text-center text-xs text-white outline-hidden focus:border-cyan-500"
        />
        <span className="whitespace-nowrap text-[10px] text-gray-500">сек.</span>
      </label>
    </div>
  )
}

interface TitleDesignUpdate {
  style?: BroadcastTitleStyle
  textColor?: string
  backgroundStart?: string
  backgroundEnd?: string
  accentStart?: string
  accentEnd?: string
}

interface DesignControlsProps {
  style: BroadcastTitleStyle
  textColor: string
  backgroundStart: string
  backgroundEnd: string
  accentStart: string
  accentEnd: string
  accentLabel: string
  accentSide: 'left' | 'right'
  onChange: (update: TitleDesignUpdate) => void
}

function DesignControls({
  style,
  textColor,
  backgroundStart,
  backgroundEnd,
  accentStart,
  accentEnd,
  accentLabel,
  accentSide,
  onChange
}: DesignControlsProps): JSX.Element {
  return (
    <div className="rounded-lg border border-gray-700 bg-black/15 p-2.5">
      <div>
        <span className="mb-1.5 block text-[10px] text-gray-400">Стиль титра</span>
        <div className="grid grid-cols-5 gap-1.5">
          {STYLE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange({ style: option.value })}
              className={`flex h-10 min-w-0 items-center justify-center rounded-md border transition-colors ${
                style === option.value
                  ? 'border-cyan-500 bg-cyan-950/55 text-cyan-300'
                  : 'border-gray-700 bg-surface-100 text-gray-500 hover:border-gray-500 hover:text-gray-300'
              }`}
              title={option.label}
              aria-label={option.label}
              aria-pressed={style === option.value}
            >
              <StyleIcon style={option.value} accentSide={accentSide} />
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <ColorControl label="Текст" value={textColor} onChange={(value) => onChange({ textColor: value })} />
        <ColorControl label="Фон 1" value={backgroundStart} onChange={(value) => onChange({ backgroundStart: value })} />
        <ColorControl label="Фон 2" value={backgroundEnd} onChange={(value) => onChange({ backgroundEnd: value })} />
      </div>
      <div className="mt-2">
        <span className="mb-1 block text-[10px] text-gray-400">{accentLabel} — градиент</span>
        <div className="grid grid-cols-2 gap-2">
          <ColorControl label="Начало" value={accentStart} onChange={(value) => onChange({ accentStart: value })} />
          <ColorControl label="Конец" value={accentEnd} onChange={(value) => onChange({ accentEnd: value })} />
        </div>
      </div>
    </div>
  )
}

function StyleIcon({
  style,
  accentSide
}: {
  style: BroadcastTitleStyle
  accentSide: 'left' | 'right'
}): JSX.Element {
  const shape = style === 'slant-right'
    ? <polygon points="3,4 39,4 45,22 3,22" />
    : style === 'slant-left'
      ? <polygon points="9,4 45,4 45,22 3,22" />
      : <rect x="3" y="4" width="42" height="18" rx={style === 'rounded' ? 4 : style === 'pill' ? 9 : 0} />
  const accent = accentSide === 'left'
    ? style === 'slant-left'
      ? <line x1="10" y1="6" x2="5" y2="20" />
      : <line x1="6" y1="6" x2="6" y2="20" />
    : style === 'slant-right'
      ? <line x1="39" y1="6" x2="43" y2="20" />
      : <line x1="42" y1="6" x2="42" y2="20" />

  return (
    <svg viewBox="0 0 48 26" className="h-7 w-11 max-w-full" aria-hidden="true">
      <g fill="currentColor" fillOpacity=".12" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        {shape}
      </g>
      <g stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        {accent}
      </g>
    </svg>
  )
}

function ColorControl({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label data-broadcast-titles-color={label} className="flex min-w-0 flex-col items-stretch gap-0.5 rounded-md border border-gray-700 bg-surface-100 px-1 py-1">
      <span className="whitespace-nowrap text-center text-[9px] font-medium leading-none text-gray-300" title={`${label}: ${value}`}>
        {label}
      </span>
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="h-4 w-full cursor-pointer border-0 bg-transparent p-0"
      />
    </label>
  )
}
