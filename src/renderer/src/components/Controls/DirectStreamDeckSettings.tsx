import { useEffect, useMemo, useState } from 'react'
import {
  DIRECT_STREAM_DECK_ACTIONS,
  DIRECT_STREAM_DECK_ACTION_LABELS,
  createDefaultDirectStreamDeckConfig,
  type DirectStreamDeckActionKind,
  type DirectStreamDeckConfig,
  type DirectStreamDeckDeviceInfo,
  type DirectStreamDeckStatus
} from '../../../../shared/direct-stream-deck'
import { useAppStore } from '../../stores/useAppStore'
import { readDirectStreamDeckConfig, saveDirectStreamDeckConfig } from '../../direct-stream-deck-config'

const EMPTY_STATUS: DirectStreamDeckStatus = {
  enabled: false,
  connecting: false,
  connected: false,
  deviceName: null,
  serialNumber: null,
  keyCount: 0,
  columns: 0,
  rows: 0,
  error: null
}

function keyCaption(
  config: DirectStreamDeckConfig,
  index: number,
  channels: ReturnType<typeof useAppStore.getState>['channels'],
  speakers: ReturnType<typeof useAppStore.getState>['broadcastTitles']['speakers']
): string {
  const action = config.mappings[String(index)]
  if (!action || action.kind === 'none') return 'Не назначено'
  if (action.kind === 'take-channel' || action.kind === 'play-channel-video') {
    const channel = action.channelId ? channels[action.channelId] : undefined
    return channel?.caption.trim() || channel?.file?.name || `Канал ${index + 1}`
  }
  if ((action.kind === 'titles-speaker' || action.kind === 'titles-all') && action.speakerId) {
    const speaker = speakers.find((entry) => entry.id === action.speakerId)
    if (speaker?.name.trim()) {
      if (action.kind === 'titles-all') {
        const surname = speaker.name.trim().split(/\s+/)[0]
        return `Титры все — ${surname}`
      }
      return speaker.name.trim()
    }
  }
  return DIRECT_STREAM_DECK_ACTION_LABELS[action.kind]
}

export function DirectStreamDeckSettings(): JSX.Element {
  const channels = useAppStore((state) => state.channels)
  const channelIds = useAppStore((state) => state.channelIds)
  const broadcastTitles = useAppStore((state) => state.broadcastTitles)
  const [config, setConfig] = useState<DirectStreamDeckConfig>(() => readDirectStreamDeckConfig())
  const [status, setStatus] = useState<DirectStreamDeckStatus>(EMPTY_STATUS)
  const [devices, setDevices] = useState<DirectStreamDeckDeviceInfo[]>([])
  const [selectedKey, setSelectedKey] = useState(0)
  const [scanning, setScanning] = useState(false)

  const refreshDevices = async (): Promise<void> => {
    setScanning(true)
    try {
      setDevices(await window.api.listDirectStreamDecks())
      const current = await window.api.getDirectStreamDeckStatus()
      if (current) setStatus(current)
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void refreshDevices()
    return window.api.on('direct-stream-deck-status', (...args: unknown[]) => {
      setStatus(args[0] as DirectStreamDeckStatus)
    })
  }, [])

  const applyConfig = (next: DirectStreamDeckConfig): void => {
    const saved = saveDirectStreamDeckConfig(next)
    setConfig(saved)
    void window.api.configureDirectStreamDeck(saved).then((nextStatus) => {
      if (nextStatus) setStatus(nextStatus)
    })
  }

  const setAction = (kind: DirectStreamDeckActionKind): void => {
    const current = config.mappings[String(selectedKey)]
    const nextChannelId = current?.kind === 'take-channel' && current.channelId
      ? current.channelId
      : channelIds[Math.min(selectedKey, Math.max(0, channelIds.length - 1))]
    const nextVideoChannelId = current?.kind === 'play-channel-video' && current.channelId
      ? current.channelId
      : channelIds.find((channelId) => channels[channelId]?.file?.type === 'video')
    const nextSpeakerId = (current?.kind === 'titles-speaker' || current?.kind === 'titles-all') && current.speakerId
      ? current.speakerId
      : broadcastTitles.selectedSpeakerId || broadcastTitles.speakers[0]?.id
    applyConfig({
      ...config,
      mappings: {
        ...config.mappings,
        [String(selectedKey)]: {
          kind,
          ...(kind === 'take-channel' && nextChannelId ? { channelId: nextChannelId } : {}),
          ...(kind === 'play-channel-video' && nextVideoChannelId ? { channelId: nextVideoChannelId } : {}),
          ...((kind === 'titles-speaker' || kind === 'titles-all') && nextSpeakerId
            ? { speakerId: nextSpeakerId }
            : {})
        }
      }
    })
  }

  const selectedAction = config.mappings[String(selectedKey)] ?? { kind: 'none' as const }
  const deviceColumns = status.columns || 8
  const keyCount = status.keyCount || 32
  const gridStyle = useMemo(() => ({
    gridTemplateColumns: `repeat(${deviceColumns}, minmax(0, 1fr))`
  }), [deviceColumns])

  return (
    <div className="space-y-4 text-xs text-gray-300">
      <section className="rounded-lg border border-gray-700 bg-surface-100 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-white">Прямое USB-подключение</h3>
            <p className="mt-1 text-[10px] leading-4 text-gray-400">
              PDM управляет Stream Deck сам. Программа Elgato и официальный плагин не нужны.
            </p>
          </div>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[11px] text-gray-200">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => applyConfig({ ...config, enabled: event.target.checked })}
              className="h-4 w-4 accent-blue-500"
            />
            Включить
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${status.connected
            ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
            : status.connecting ? 'animate-pulse bg-yellow-400' : 'bg-gray-600'}`} />
          <span className="font-medium text-gray-200">
            {status.connected
              ? `Подключён: ${status.deviceName || 'Stream Deck'}`
              : status.connecting ? 'Подключение…' : 'Не подключён'}
          </span>
          {status.serialNumber && <span className="text-[10px] text-gray-500">№ {status.serialNumber}</span>}
        </div>
        {status.error && (
          <p className="mt-2 rounded border border-red-800/70 bg-red-950/30 px-3 py-2 text-[10px] text-red-200">
            {status.error}
          </p>
        )}

        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
          <select
            value={config.serialNumber ?? ''}
            onChange={(event) => applyConfig({ ...config, serialNumber: event.target.value || null })}
            className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-xs text-white"
          >
            <option value="">Первый найденный Stream Deck</option>
            {devices.map((device) => (
              <option key={device.path} value={device.serialNumber ?? ''}>
                {device.name}{device.serialNumber ? ` — ${device.serialNumber}` : ''}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void refreshDevices()}
              disabled={scanning}
              className="rounded border border-gray-600 px-3 py-2 text-[11px] hover:border-blue-400 hover:text-white disabled:opacity-50"
            >
              {scanning ? 'Поиск…' : 'Обновить'}
            </button>
            {config.enabled && !status.connected && (
              <button
                type="button"
                onClick={() => void window.api.connectDirectStreamDeck().then((value) => value && setStatus(value))}
                disabled={status.connecting}
                className="rounded bg-blue-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                Подключить
              </button>
            )}
          </div>
        </div>

        <label className="mt-3 grid grid-cols-[105px_1fr_38px] items-center gap-2 text-[11px] text-gray-400">
          <span>Яркость кнопок</span>
          <input
            type="range"
            min={10}
            max={100}
            value={config.brightness}
            onChange={(event) => applyConfig({ ...config, brightness: Number(event.target.value) })}
            className="accent-blue-500"
          />
          <span className="text-right text-gray-200">{config.brightness}%</span>
        </label>
      </section>

      <section className="rounded-lg border border-gray-700 bg-surface-100 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Кнопки Stream Deck XL</h3>
            <p className="mt-1 text-[10px] text-gray-500">Выберите кнопку на схеме, затем назначьте действие.</p>
          </div>
          <button
            type="button"
            onClick={() => applyConfig({ ...createDefaultDirectStreamDeckConfig(), enabled: config.enabled, serialNumber: config.serialNumber, brightness: config.brightness })}
            className="rounded border border-gray-600 px-3 py-1.5 text-[10px] text-gray-300 hover:border-blue-400 hover:text-white"
          >
            Стандартная раскладка
          </button>
        </div>

        <div className="grid gap-2" style={gridStyle}>
          {Array.from({ length: keyCount }, (_, index) => {
            const action = config.mappings[String(index)]
            const assigned = action && action.kind !== 'none'
            return (
              <button
                key={index}
                type="button"
                onClick={() => setSelectedKey(index)}
                title={keyCaption(config, index, channels, broadcastTitles.speakers)}
                className={`aspect-square min-w-0 rounded-lg border p-1 text-[9px] font-semibold leading-tight transition-colors ${selectedKey === index
                  ? 'border-blue-300 bg-blue-600 text-white ring-2 ring-blue-400/30'
                  : assigned ? 'border-gray-600 bg-[#172734] text-gray-100 hover:border-blue-500'
                    : 'border-gray-800 bg-gray-950 text-gray-600 hover:border-gray-600'}`}
              >
                <span className="block text-[8px] opacity-50">{index + 1}</span>
                <span className="line-clamp-3">{keyCaption(config, index, channels, broadcastTitles.speakers)}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-4 grid grid-cols-[125px_1fr] items-center gap-3 rounded border border-gray-700 bg-gray-950/50 p-3">
          <label className="text-[11px] text-gray-400">Кнопка {selectedKey + 1}</label>
          <select
            value={selectedAction.kind}
            onChange={(event) => setAction(event.target.value as DirectStreamDeckActionKind)}
            className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-xs text-white"
          >
            {DIRECT_STREAM_DECK_ACTIONS.map((kind) => (
              <option key={kind} value={kind}>{DIRECT_STREAM_DECK_ACTION_LABELS[kind]}</option>
            ))}
          </select>
          {(selectedAction.kind === 'take-channel' || selectedAction.kind === 'play-channel-video') && (
            <>
              <label className="text-[11px] text-gray-400">
                {selectedAction.kind === 'play-channel-video' ? 'Канал с видео' : 'Какой канал'}
              </label>
              <select
                value={selectedAction.channelId ?? ''}
                onChange={(event) => applyConfig({
                  ...config,
                  mappings: {
                    ...config.mappings,
                    [String(selectedKey)]: { kind: selectedAction.kind, channelId: event.target.value }
                  }
                })}
                className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-xs text-white"
              >
                {selectedAction.kind === 'play-channel-video' && !channelIds.some(
                  (channelId) => channels[channelId]?.file?.type === 'video'
                ) && <option value="">Добавьте видео в канал</option>}
                {channelIds.filter((channelId) => (
                  selectedAction.kind !== 'play-channel-video' || channels[channelId]?.file?.type === 'video'
                )).map((channelId) => {
                  const channel = channels[channelId]
                  const index = channelIds.indexOf(channelId)
                  const name = channel?.caption.trim() || channel?.file?.name || 'пустой'
                  return <option key={channelId} value={channelId}>Канал {index + 1} — {name}</option>
                })}
              </select>
            </>
          )}
          {(selectedAction.kind === 'titles-speaker' || selectedAction.kind === 'titles-all') && (
            <>
              <label className="text-[11px] text-gray-400">Какое ФИО</label>
              <select
                value={selectedAction.speakerId ?? ''}
                onChange={(event) => applyConfig({
                  ...config,
                  mappings: {
                    ...config.mappings,
                    [String(selectedKey)]: {
                      kind: selectedAction.kind,
                      speakerId: event.target.value || undefined
                    }
                  }
                })}
                className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-xs text-white"
              >
                <option value="">Выбранное в Титрах</option>
                {broadcastTitles.speakers.map((speaker) => (
                  <option key={speaker.id} value={speaker.id}>
                    {speaker.name.trim() || 'Без имени'}{speaker.role.trim() ? ` — ${speaker.role.trim()}` : ''}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </section>

      <p className="text-[10px] leading-4 text-gray-500">
        Если запущена программа Elgato Stream Deck, она может занять устройство. PDM не закрывает её автоматически — закройте её вручную и нажмите «Подключить».
      </p>
    </div>
  )
}
