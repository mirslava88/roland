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
import { BroadcastTitlesOverlay } from './BroadcastTitlesOverlay'

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

export function BroadcastTitles(): JSX.Element {
  const [open, setOpen] = useState(false)
  const isVisible = useAppStore((state) => {
    const selectedCapture = state.selectedChannel
      ? state.channels[state.selectedChannel]?.file?.capture
      : undefined
    const activeCapture = state.activeFile?.type === 'capture' ? state.activeFile.capture : undefined
    const informationCapture = state.informationMedia?.type === 'capture'
      ? state.informationMedia.capture
      : undefined
    const sourceIdentity = captureSourceIdentity(selectedCapture || activeCapture || informationCapture)
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

function BroadcastTitlesModal({ onClose }: { onClose: () => void }): JSX.Element {
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
    setBroadcastTitles,
    setCaptureTitlesOutput
  } = useAppStore()

  const selectedFile = selectedChannel ? channels[selectedChannel]?.file : null
  const selectedCapture = selectedFile?.type === 'capture' ? selectedFile.capture : undefined
  const activeCapture = activeFile?.type === 'capture' ? activeFile.capture : undefined
  const informationCapture = informationMedia?.type === 'capture' ? informationMedia.capture : undefined
  const previewUsesInformationFallback = !selectedCapture && !activeCapture && !!informationCapture
  const previewCapture = selectedCapture || activeCapture || informationCapture
  const sourceIdentity = captureSourceIdentity(previewCapture)
  const activeSourceIdentity = programCaptureTitlesSourceIdentity
  const informationSourceIdentity = informationMedia?.type === 'capture'
    ? captureSourceIdentity(informationMedia.capture)
    : null
  const broadcastTitlesOutput = sourceIdentity
    ? captureTitlesOutputs[sourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : DEFAULT_BROADCAST_TITLES_OUTPUT
  const setTargetTitlesOutput = (update: Partial<BroadcastTitlesOutput>): void => {
    if (sourceIdentity) setCaptureTitlesOutput(sourceIdentity, update)
  }
  const captureOnAir = !!sourceIdentity && (
    sourceIdentity === activeSourceIdentity || (
      sourceIdentity === informationSourceIdentity &&
      displays.some((display) => (
        !display.isPrimary && displayAssignments[String(display.id)] === 'information'
      ))
    )
  )
  const selectedSpeaker = broadcastTitles.speakers.find(
    (speaker) => speaker.id === broadcastTitles.selectedSpeakerId
  ) || null
  const selectedSpeakerIsLive = !!selectedSpeaker &&
    broadcastTitlesOutput.speakerVisible &&
    broadcastTitlesOutput.speakerId === selectedSpeaker.id
  const speakerHasChanges = !!selectedSpeaker && (
    selectedSpeaker.name !== broadcastTitlesOutput.speakerName ||
    selectedSpeaker.role !== broadcastTitlesOutput.speakerRole ||
    broadcastTitles.speakerEnterEffect !== broadcastTitlesOutput.speakerEnterEffect ||
    broadcastTitles.speakerExitEffect !== broadcastTitlesOutput.speakerExitEffect ||
    broadcastTitles.speakerAutoHideSeconds !== broadcastTitlesOutput.speakerAutoHideSeconds ||
    broadcastTitles.speakerStyle !== broadcastTitlesOutput.speakerStyle ||
    broadcastTitles.speakerTextColor !== broadcastTitlesOutput.speakerTextColor ||
    broadcastTitles.speakerBackgroundStart !== broadcastTitlesOutput.speakerBackgroundStart ||
    broadcastTitles.speakerBackgroundEnd !== broadcastTitlesOutput.speakerBackgroundEnd ||
    broadcastTitles.speakerAccentStart !== broadcastTitlesOutput.speakerAccentStart ||
    broadcastTitles.speakerAccentEnd !== broadcastTitlesOutput.speakerAccentEnd
  )
  const eventHasChanges = broadcastTitles.eventLabel !== broadcastTitlesOutput.eventLabel ||
    broadcastTitles.eventInfo !== broadcastTitlesOutput.eventInfo ||
    broadcastTitles.eventEnterEffect !== broadcastTitlesOutput.eventEnterEffect ||
    broadcastTitles.eventExitEffect !== broadcastTitlesOutput.eventExitEffect ||
    broadcastTitles.eventAutoHideSeconds !== broadcastTitlesOutput.eventAutoHideSeconds ||
    broadcastTitles.eventPosition !== broadcastTitlesOutput.eventPosition ||
    broadcastTitles.eventStyle !== broadcastTitlesOutput.eventStyle ||
    broadcastTitles.eventTextColor !== broadcastTitlesOutput.eventTextColor ||
    broadcastTitles.eventBackgroundStart !== broadcastTitlesOutput.eventBackgroundStart ||
    broadcastTitles.eventBackgroundEnd !== broadcastTitlesOutput.eventBackgroundEnd ||
    broadcastTitles.eventAccentStart !== broadcastTitlesOutput.eventAccentStart ||
    broadcastTitles.eventAccentEnd !== broadcastTitlesOutput.eventAccentEnd
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

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4">
      <div className="flex h-[min(900px,96vh)] w-[min(1320px,97vw)] flex-col overflow-hidden rounded-2xl border border-gray-700 bg-surface-300 shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-800 px-5 py-3">
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
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.35fr)_minmax(440px,.9fr)] gap-4 p-4">
          <section className="flex min-h-0 flex-col rounded-xl border border-gray-700 bg-black/40 p-3">
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
                    <div className="text-4xl font-light tracking-[.18em] text-gray-300">LIVE</div>
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

          <aside className="min-h-0 space-y-3 overflow-y-auto pr-1">
            <section className="rounded-xl border border-gray-700 bg-surface-200 p-4">
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
                <div className="space-y-3 border-t border-gray-700 pt-3">
                  <label className="block">
                    <span className="mb-1 block text-[10px] text-gray-400">ФИО выступающего</span>
                    <input
                      type="text"
                      maxLength={120}
                      value={selectedSpeaker.name}
                      onChange={(event) => updateSpeaker(selectedSpeaker.id, { name: event.target.value })}
                      placeholder="Иванов Иван Иванович"
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

                  <EffectControls
                    enterEffect={broadcastTitles.speakerEnterEffect}
                    exitEffect={broadcastTitles.speakerExitEffect}
                    autoHideSeconds={broadcastTitles.speakerAutoHideSeconds}
                    onEnterEffect={(speakerEnterEffect) => setBroadcastTitles({ speakerEnterEffect })}
                    onExitEffect={(speakerExitEffect) => setBroadcastTitles({ speakerExitEffect })}
                    onAutoHide={(speakerAutoHideSeconds) => setBroadcastTitles({ speakerAutoHideSeconds })}
                  />

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

                  {selectedSpeakerIsLive && speakerHasChanges && (
                    <p className="text-[10px] text-amber-400">В эфире остаётся предыдущий вариант — нажмите «Обновить».</p>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={publishSpeaker}
                      disabled={!sourceIdentity || !selectedSpeaker.name.trim()}
                      className="rounded-lg bg-cyan-700 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {selectedSpeakerIsLive ? 'Обновить' : 'Показать'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTargetTitlesOutput({ speakerVisible: false })}
                      disabled={!broadcastTitlesOutput.speakerVisible}
                      className="rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-xs font-semibold text-gray-300 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      Скрыть
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-gray-700 bg-surface-200 p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <h3 className="text-sm font-semibold text-white">Информация о мероприятии</h3>
                {broadcastTitlesOutput.eventVisible && (
                  <span className="ml-auto rounded-full bg-red-900/60 px-2 py-0.5 text-[9px] font-semibold text-red-300">В ЭФИРЕ</span>
                )}
              </div>

              <label className="mb-3 block">
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
                maxLength={320}
                rows={3}
                value={broadcastTitles.eventInfo}
                onChange={(event) => setBroadcastTitles({ eventInfo: event.target.value })}
                placeholder={'Ежегодная конференция\nМосква • 2026'}
                className="w-full resize-none rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-sm leading-snug text-white outline-hidden placeholder:text-gray-600 focus:border-emerald-500"
              />

              <div className="mt-3">
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

              <div className="mt-3">
                <EffectControls
                  enterEffect={broadcastTitles.eventEnterEffect}
                  exitEffect={broadcastTitles.eventExitEffect}
                  autoHideSeconds={broadcastTitles.eventAutoHideSeconds}
                  onEnterEffect={(eventEnterEffect) => setBroadcastTitles({ eventEnterEffect })}
                  onExitEffect={(eventExitEffect) => setBroadcastTitles({ eventExitEffect })}
                  onAutoHide={(eventAutoHideSeconds) => setBroadcastTitles({ eventAutoHideSeconds })}
                />
                <div className="mt-3">
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

              {broadcastTitlesOutput.eventVisible && eventHasChanges && (
                <p className="mt-2 text-[10px] text-amber-400">В эфире остаётся предыдущий вариант — нажмите «Обновить».</p>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={publishEvent}
                  disabled={!sourceIdentity || !broadcastTitles.eventInfo.trim()}
                  className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {broadcastTitlesOutput.eventVisible ? 'Обновить' : 'Показать'}
                </button>
                <button
                  type="button"
                  onClick={() => setTargetTitlesOutput({ eventVisible: false })}
                  disabled={!broadcastTitlesOutput.eventVisible}
                  className="rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-xs font-semibold text-gray-300 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Скрыть
                </button>
              </div>
            </section>

            <button
              type="button"
              onClick={() => setTargetTitlesOutput({ speakerVisible: false, eventVisible: false })}
              disabled={!anythingVisible}
              className="w-full rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2.5 text-xs font-semibold text-red-300 hover:bg-red-950/60 disabled:cursor-not-allowed disabled:opacity-30"
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
      <label className="col-span-2 flex items-center gap-2 rounded-lg border border-gray-700 bg-surface-100 px-2.5 py-2">
        <span className="min-w-0 flex-1 text-[10px] text-gray-400">Автоматически скрыть через</span>
        <input
          type="number"
          min={0}
          max={86400}
          step={1}
          value={autoHideSeconds}
          onChange={(event) => onAutoHide(parseSeconds(event.target.value))}
          className="w-20 rounded-md border border-gray-700 bg-surface-200 px-2 py-1 text-right text-xs text-white outline-hidden focus:border-cyan-500"
        />
        <span className="text-[10px] text-gray-500">сек. (0 — выкл.)</span>
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
    <label className="flex min-w-0 items-center gap-1.5 rounded-md border border-gray-700 bg-surface-100 px-1.5 py-1.5">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-5 w-6 shrink-0 cursor-pointer border-0 bg-transparent p-0"
      />
      <span className="min-w-0 truncate text-[9px] text-gray-400" title={`${label}: ${value}`}>
        {label}
      </span>
    </label>
  )
}
