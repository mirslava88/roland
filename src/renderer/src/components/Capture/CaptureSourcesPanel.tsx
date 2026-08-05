import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { CaptureThumbnail } from './CaptureThumbnail'
import { DesktopCapturePicker } from './DesktopCapturePicker'

interface DeviceResponse {
  requestId: string
  devices: CaptureDeviceDescriptor[]
  error?: string
}

export function CaptureSourcesPanel(): JSX.Element {
  const {
    captureSources,
    addCaptureSource,
    removeCaptureSource,
    channels,
    selectedFile,
    selectFile,
    activeFile,
    selectedDisplayId
  } = useAppStore()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [desktopPickerOpen, setDesktopPickerOpen] = useState(false)
  const [devices, setDevices] = useState<CaptureDeviceDescriptor[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [panelMessage, setPanelMessage] = useState<string | null>(null)
  const [videoDeviceId, setVideoDeviceId] = useState('')
  const [audioEnabled, setAudioEnabled] = useState(false)
  const [audioDeviceId, setAudioDeviceId] = useState('')
  const deviceRequestGenerationRef = useRef(0)

  const videoDevices = useMemo(
    () => devices.filter((device) => device.kind === 'videoinput'),
    [devices]
  )
  const audioDevices = useMemo(
    () => devices.filter((device) => device.kind === 'audioinput'),
    [devices]
  )

  const loadDevices = useCallback((): void => {
    const generation = ++deviceRequestGenerationRef.current
    setLoading(true)
    setError(null)
    const requestId = `capture-devices-${crypto.randomUUID()}`
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let unsub = (): void => {}
    const finish = (response?: DeviceResponse): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      unsub()
      if (generation !== deviceRequestGenerationRef.current) return
      setLoading(false)
      if (!response) {
        setError('Не удалось получить список устройств. Нажмите «Обновить список».')
        return
      }
      setDevices(response.devices)
      setError(response.error || null)
      const videos = response.devices.filter((device) => device.kind === 'videoinput')
      const audios = response.devices.filter((device) => device.kind === 'audioinput')
      setVideoDeviceId((current) => videos.some((device) => device.deviceId === current)
        ? current
        : videos[0]?.deviceId || '')
      setAudioDeviceId((current) => audios.some((device) => device.deviceId === current)
        ? current
        : '')
      if (audios.length === 0) setAudioEnabled(false)
    }
    unsub = window.api.on('capture-devices-response', (...args: unknown[]) => {
      const response = args[0] as DeviceResponse
      if (response?.requestId === requestId) finish(response)
    })
    timeout = setTimeout(() => finish(), 15000)
    window.api.sendToPresentation('capture-devices-request', { requestId })
  }, [])

  useEffect(() => {
    if (!pickerOpen) return
    loadDevices()
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const unsub = window.api.on('capture-devices-changed', () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(loadDevices, 350)
    })
    const unsubHubReady = window.api.on('capture-hub-ready', () => loadDevices())
    return () => {
      deviceRequestGenerationRef.current += 1
      if (refreshTimer) clearTimeout(refreshTimer)
      unsub()
      unsubHubReady()
    }
  }, [pickerOpen, loadDevices])

  useEffect(() => {
    const video = videoDevices.find((device) => device.deviceId === videoDeviceId)
    if (!video) return
    const groupedAudio = video.groupId
      ? audioDevices.find((device) => device.groupId && device.groupId === video.groupId)
      : undefined
    // Never silently fall back to the laptop microphone. Only an endpoint
    // explicitly grouped with this UVC device may be selected automatically.
    setAudioDeviceId(groupedAudio?.deviceId || '')
  }, [audioDevices, videoDeviceId, videoDevices])

  const addSelectedDevice = (): void => {
    const video = videoDevices.find((device) => device.deviceId === videoDeviceId)
    if (!video) {
      setError('Выберите устройство видеозахвата.')
      return
    }

    const existing = captureSources.find(
      (source) => source.capture?.videoDeviceId === video.deviceId
    )
    if (existing) {
      selectFile(existing)
      setPickerOpen(false)
      setPanelMessage('Это устройство уже добавлено.')
      setTimeout(() => setPanelMessage(null), 2500)
      return
    }

    const audio = audioEnabled
      ? audioDevices.find((device) => device.deviceId === audioDeviceId)
      : undefined
    if (audioEnabled && !audio) {
      setError('Выберите аудиовход. Микрофон ноутбука автоматически не включается.')
      return
    }
    const sourceId = `capture-${crypto.randomUUID()}`
    const capture: CaptureSourceConfig = {
      sourceId,
      videoDeviceId: video.deviceId,
      videoLabel: video.label,
      videoGroupId: video.groupId || undefined,
      audioEnabled: audioEnabled && !!audio,
      audioDeviceId: audio?.deviceId,
      audioLabel: audio?.label
    }
    const entry: FileEntry = {
      id: sourceId,
      name: video.label,
      path: `capture://${sourceId}`,
      type: 'capture',
      extension: 'LIVE',
      size: 0,
      capture
    }
    addCaptureSource(entry)
    selectFile(entry)
    window.api.sendToPresentation('capture-source-register', capture)
    window.api.dbgLog(
      `Capture UI: source added id=${sourceId.slice(-8)} label=${video.label} audio=${audioEnabled}`
    )
    setPickerOpen(false)
  }

  const addDesktopSource = (desktopSource: DesktopCaptureSourceDescriptor): void => {
    // Chromium may keep returning a stale capture id for an iconic HWND. A
    // minimized window must remain completely deferred until "В эфир" even
    // when such an id is present in the picker response.
    const resolvedCaptureId = desktopSource.isMinimized
      ? undefined
      : desktopSource.captureId || (
          desktopSource.id.startsWith('window:') || desktopSource.id.startsWith('screen:')
            ? desktopSource.id
            : undefined
        )
    const canResolveWhenTaken = desktopSource.kind === 'window' && !!desktopSource.id
    if (!resolvedCaptureId && !canResolveWhenTaken) {
      setPanelMessage('Windows не смогла подготовить выбранное окно для захвата.')
      setTimeout(() => setPanelMessage(null), 3000)
      return
    }
    const existing = captureSources.find((source) => (
      source.capture?.captureKind === 'desktop' &&
      (
        source.capture.desktopSourceKey === desktopSource.id ||
        (
          !!resolvedCaptureId &&
          !source.capture.desktopSourceKey &&
          source.capture.desktopSourceId === resolvedCaptureId
        )
      )
    ))
    if (existing) {
      const existingIsLive = activeFile?.capture?.sourceId === existing.capture?.sourceId
      // Re-adding the source that is already on air must not unregister its
      // live layer. Keep the working id until the next explicit TAKE resolves
      // the latest HWND state.
      const effectiveCaptureId = resolvedCaptureId || (
        existingIsLive ? existing.capture?.desktopSourceId : undefined
      )
      const refreshedConfig: CaptureSourceConfig = {
        ...existing.capture!,
        desktopSourceId: effectiveCaptureId,
        desktopSourceKey: desktopSource.id,
        desktopSourceType: desktopSource.kind,
        desktopDisplayId: desktopSource.displayId,
        desktopAppIcon: desktopSource.appIcon || existing.capture?.desktopAppIcon,
        audioEnabled: false,
        videoLabel: desktopSource.name || 'Окно программы'
      }
      const refreshedEntry: FileEntry = {
        ...existing,
        name: refreshedConfig.videoLabel,
        capture: refreshedConfig
      }
      addCaptureSource(refreshedEntry)
      for (const [channelId, channel] of Object.entries(channels)) {
        if (channel.file?.id === existing.id) {
          useAppStore.getState().setChannelFile(channelId, refreshedEntry)
        }
      }
      if (activeFile?.id === existing.id) {
        useAppStore.getState().setActiveFile(refreshedEntry)
      }
      selectFile(refreshedEntry)
      setDesktopPickerOpen(false)
      const config = refreshedConfig
      // Re-adding the same item doubles as an explicit reconnect. Desktop
      // source ids must never be recovered by title because two unrelated
      // windows may have the same name.
      if (!existingIsLive) {
        window.api.sendToPresentation('capture-source-unregister', config.sourceId)
        if (config.desktopSourceId) {
          setTimeout(() => {
            window.api.sendToPresentation('capture-source-register', config)
          }, 120)
        }
      }
      setPanelMessage(existingIsLive
        ? 'Источник уже находится в эфире.'
        : config.desktopSourceId
          ? 'Источник уже добавлен — переподключаем его.'
          : 'Источник уже добавлен — окно подключится при выходе в эфир.')
      setTimeout(() => setPanelMessage(null), 2500)
      return
    }

    const sourceId = `capture-${crypto.randomUUID()}`
    const capture: CaptureSourceConfig = {
      sourceId,
      captureKind: 'desktop',
      desktopSourceId: resolvedCaptureId,
      desktopSourceKey: desktopSource.id,
      desktopSourceType: desktopSource.kind,
      desktopDisplayId: desktopSource.displayId,
      desktopAppIcon: desktopSource.appIcon,
      videoLabel: desktopSource.name || (desktopSource.kind === 'window' ? 'Окно программы' : 'Экран'),
      audioEnabled: false
    }
    const entry: FileEntry = {
      id: sourceId,
      name: capture.videoLabel,
      path: `desktop-capture://${sourceId}`,
      type: 'capture',
      extension: desktopSource.kind === 'window' ? 'ОКНО' : 'ЭКРАН',
      size: 0,
      capture
    }
    addCaptureSource(entry)
    selectFile(entry)
    if (capture.desktopSourceId) {
      window.api.sendToPresentation('capture-source-register', capture)
    }
    window.api.dbgLog(
      `Capture UI: desktop source added id=${sourceId.slice(-8)} kind=${desktopSource.kind} deferred=${!capture.desktopSourceId} label=${capture.videoLabel}`
    )
    setDesktopPickerOpen(false)
  }

  const removeSource = (source: FileEntry): void => {
    const sourceId = source.capture?.sourceId
    if (!sourceId) return
    const assigned = Object.values(channels).some(
      (channel) => channel.file?.capture?.sourceId === sourceId
    )
    if (assigned) {
      setPanelMessage('Сначала уберите этот источник из каналов.')
      setTimeout(() => setPanelMessage(null), 3000)
      return
    }
    window.api.sendToPresentation('capture-source-unregister', sourceId)
    removeCaptureSource(sourceId)
    window.api.dbgLog(`Capture UI: source removed id=${sourceId.slice(-8)}`)
  }

  return (
    <>
      <div className="shrink-0 border-b border-gray-800 bg-surface-300">
        <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
          <span className="text-[10px] font-bold uppercase text-gray-500">Внешние источники</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 px-3 pb-2">
          <button
            onClick={() => setPickerOpen(true)}
            className="rounded-sm bg-blue-600/80 hover:bg-blue-500 px-2 py-1 text-[10px] font-semibold text-white transition-colors"
            title="Добавить плату видеозахвата, USB-камеру или веб-камеру"
          >
            ＋ Камера / плата
          </button>
          <button
            onClick={() => setDesktopPickerOpen(true)}
            className="rounded-sm bg-cyan-700/80 hover:bg-cyan-600 px-2 py-1 text-[10px] font-semibold text-white transition-colors"
            title="Добавить открытое окно программы или экран"
          >
            ＋ Окно / экран
          </button>
        </div>
        {panelMessage && (
          <div className="px-3 pb-2 text-[10px] text-yellow-400">{panelMessage}</div>
        )}
        {captureSources.length > 0 && (
          <div className="max-h-52 overflow-y-auto px-2 pb-2 space-y-2">
            {captureSources.map((source) => {
              const config = source.capture!
              const selected = selectedFile?.capture?.sourceId === config.sourceId
              const active = activeFile?.capture?.sourceId === config.sourceId
              return (
                <div
                  key={config.sourceId}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/json', JSON.stringify(source))
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => selectFile(source)}
                  className={`group rounded-lg border overflow-hidden cursor-grab active:cursor-grabbing transition-colors ${
                    active
                      ? 'border-red-500/70 ring-1 ring-red-500/40'
                      : selected
                        ? 'border-blue-500/70'
                        : 'border-gray-700 hover:border-gray-600'
                  }`}
                >
                  <CaptureThumbnail config={config} className="h-24" showName />
                  <div className="flex items-center gap-2 bg-surface-200 px-2 py-1.5">
                    <span className="text-[9px] font-bold text-blue-400">
                      {config.captureKind === 'desktop'
                        ? (config.desktopSourceType === 'screen' ? 'ЭКРАН' : 'ОКНО')
                        : 'ВИДЕОВХОД'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-gray-300">
                      {config.captureKind === 'desktop'
                        ? ''
                        : (config.audioEnabled ? 'Видео + звук' : 'Только видео')}
                    </span>
                    <button
                      onClick={(event) => {
                        event.stopPropagation()
                        removeSource(source)
                      }}
                      className="text-gray-500 hover:text-red-400 px-1 text-xs opacity-60 group-hover:opacity-100"
                      title="Удалить внешний источник"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-gray-700 bg-surface-300 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-700 px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-white">Добавить внешний источник</h2>
                <p className="mt-1 text-xs text-gray-500">Плата видеозахвата, USB-камера или веб-камера</p>
              </div>
              <button onClick={() => setPickerOpen(false)} className="text-xl text-gray-500 hover:text-white">✕</button>
            </div>

            <div className="space-y-4 px-5 py-5">
              {loading ? (
                <div className="flex items-center justify-center gap-3 py-10 text-sm text-gray-400">
                  <span className="h-5 w-5 rounded-full border-2 border-gray-600 border-t-white animate-spin" />
                  Поиск устройств…
                </div>
              ) : (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-gray-300">Устройство видеозахвата</span>
                    <select
                      value={videoDeviceId}
                      onChange={(event) => setVideoDeviceId(event.target.value)}
                      className="w-full rounded-md border border-gray-600 bg-surface-100 px-3 py-2 text-sm text-white outline-hidden focus:border-blue-500"
                    >
                      {videoDevices.length === 0 && <option value="">Устройства не найдены</option>}
                      {videoDevices.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-center gap-3 text-sm text-gray-300">
                    <input
                      type="checkbox"
                      checked={audioEnabled}
                      onChange={(event) => setAudioEnabled(event.target.checked)}
                      disabled={audioDevices.length === 0}
                      className="h-4 w-4 accent-blue-500"
                    />
                    Передавать звук с выбранного аудиовхода
                  </label>

                  {audioEnabled && (
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-gray-300">Аудиовход</span>
                      <select
                        value={audioDeviceId}
                        onChange={(event) => setAudioDeviceId(event.target.value)}
                        className="w-full rounded-md border border-gray-600 bg-surface-100 px-3 py-2 text-sm text-white outline-hidden focus:border-blue-500"
                      >
                        <option value="">Выберите аудиовход</option>
                        {audioDevices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                        ))}
                      </select>
                      <p className="mt-1.5 text-[10px] text-gray-500">
                        Для HDMI-платы обычно подходит аудиовход с похожим названием.
                      </p>
                    </label>
                  )}

                  {error && (
                    <div className="rounded-md border border-red-800/70 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                      {error}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-700 px-5 py-4">
              <button
                onClick={loadDevices}
                disabled={loading}
                className="text-xs text-gray-400 hover:text-white disabled:opacity-40"
              >
                Обновить список
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setPickerOpen(false)}
                  className="rounded-md px-4 py-2 text-xs text-gray-300 hover:bg-surface-100"
                >
                  Отмена
                </button>
                <button
                  onClick={addSelectedDevice}
                  disabled={loading || !videoDeviceId}
                  className="rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
                >
                  Добавить
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {desktopPickerOpen && (
        <DesktopCapturePicker
          excludedDisplayId={selectedDisplayId}
          onClose={() => setDesktopPickerOpen(false)}
          onSelect={addDesktopSource}
        />
      )}
    </>
  )
}
