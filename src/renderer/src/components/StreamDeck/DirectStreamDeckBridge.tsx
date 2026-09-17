import { useEffect, useMemo, useState } from 'react'
import {
  DIRECT_STREAM_DECK_ACTION_LABELS,
  DIRECT_STREAM_DECK_CONFIG_EVENT,
  type DirectStreamDeckAction,
  type DirectStreamDeckCommand,
  type DirectStreamDeckConfig,
  type DirectStreamDeckKeyState
} from '../../../../shared/direct-stream-deck'
import { useAppStore } from '../../stores/useAppStore'
import { readDirectStreamDeckConfig } from '../../direct-stream-deck-config'
import { sendTimerCommand } from '../../timer-controls'
import {
  directStreamDeckChannelLabel,
  directStreamDeckSpeakerLabel,
  executeDirectStreamDeckAction
} from './direct-stream-deck-logic'

const ACTION_KEY_LABELS: Partial<Record<DirectStreamDeckAction['kind'], string>> = {
  'previous-slide': '◀ СЛАЙД',
  'next-slide': 'СЛАЙД ▶',
  'toggle-output': 'В ЭФИР',
  'play-channel-video': '▶ ВИДЕО КАНАЛ',
  'scene-toggle': 'СЦЕНА В ЭФИР',
  'scene-content': 'ТОЛЬКО ПРЕЗА',
  'scene-participant': 'ТОЛЬКО УЧАСТНИК',
  'scene-both': 'УЧАСТНИК + ПРЕЗА',
  'titles-speaker': 'ТИТР ФИО',
  'titles-event': 'ТИТР СОБЫТИЕ',
  'titles-all': 'ТИТРЫ ВСЕ',
  'titles-hide': 'ТИТРЫ СКРЫТЬ',
  'qr-toggle': 'QR-КОД',
  'timer-start-pause': 'ТАЙМЕР ▶Ⅱ',
  'timer-reset': 'ТАЙМЕР СБРОС',
  'timer-plus-5': 'ТАЙМЕР +5',
  'timer-minus-5': 'ТАЙМЕР −5',
  'music-previous': 'МУЗЫКА ◀',
  'music-play-pause': 'МУЗЫКА ▶Ⅱ',
  'music-stop': 'МУЗЫКА СТОП',
  'music-next': 'МУЗЫКА ▶'
}

export function DirectStreamDeckBridge(): null {
  const [config, setConfig] = useState<DirectStreamDeckConfig>(() => readDirectStreamDeckConfig())
  const [musicPlaying, setMusicPlaying] = useState(false)
  const channelIds = useAppStore((state) => state.channelIds)
  const channels = useAppStore((state) => state.channels)
  const selectedChannel = useAppStore((state) => state.selectedChannel)
  const liveChannel = useAppStore((state) => state.liveChannel)
  const activeFile = useAppStore((state) => state.activeFile)
  const isPresentationWindowOpen = useAppStore((state) => state.isPresentationWindowOpen)
  const programSceneEnabled = useAppStore((state) => state.programScene.enabled)
  const programSceneViewMode = useAppStore((state) => state.programScene.viewMode)
  const broadcastTitles = useAppStore((state) => state.broadcastTitles)
  const qrOverlay = useAppStore((state) => state.qrOverlay)
  const timerRunning = useAppStore((state) => state.timerRunning)
  const timerDuration = useAppStore((state) => state.timerDuration)
  const captureTitlesOutputs = useAppStore((state) => state.captureTitlesOutputs)
  const musicPlaylist = useAppStore((state) => state.musicPlaylist)

  const outputActive = programSceneEnabled ||
    (isPresentationWindowOpen && activeFile !== null) ||
    activeFile?.type === 'presentation' ||
    (activeFile?.type === 'other' && !activeFile.isImage)
  const titlesVisible = Object.values(captureTitlesOutputs).some(
    (titles) => titles.speakerVisible || titles.eventVisible
  )

  useEffect(() => {
    const handleConfig = (event: Event): void => {
      setConfig((event as CustomEvent<DirectStreamDeckConfig>).detail)
    }
    window.addEventListener(DIRECT_STREAM_DECK_CONFIG_EVENT, handleConfig)
    void window.api.configureDirectStreamDeck(readDirectStreamDeckConfig())
    return () => window.removeEventListener(DIRECT_STREAM_DECK_CONFIG_EVENT, handleConfig)
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = (): void => {
      void window.api.musicGetState().then((state) => {
        if (!cancelled) setMusicPlaying(state?.playing === true)
      }).catch(() => undefined)
    }
    poll()
    const timer = setInterval(poll, 1000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  useEffect(() => window.api.on('direct-stream-deck-command', (...args: unknown[]) => {
    const command = args[0] as DirectStreamDeckCommand | undefined
    const action = command?.action
    if (!action) return
    void executeDirectStreamDeckAction(action, command.keyIndex, {
      getState: useAppStore.getState,
      dispatch: (type, detail) => {
        window.dispatchEvent(detail === undefined
          ? new Event(type)
          : new CustomEvent(type, { detail }))
      },
      sendToPresentation: (channel, payload) => window.api.sendToPresentation(channel, payload),
      sendTimerCommand,
      musicGetState: window.api.musicGetState,
      musicPlay: window.api.musicPlay,
      musicPause: window.api.musicPause,
      musicStop: window.api.musicStop,
      musicPrevious: window.api.musicPrev,
      musicNext: window.api.musicNext,
      log: window.api.dbgLog
    })
  }), [])

  const keyStates = useMemo<DirectStreamDeckKeyState[]>(() => (
    Array.from({ length: 32 }, (_, index) => {
      const action = config.mappings[String(index)] ?? { kind: 'none' as const }
      if (action.kind === 'take-channel' || action.kind === 'play-channel-video') {
        const channelIndex = action.channelId ? channelIds.indexOf(action.channelId) : -1
        const channel = action.channelId ? channels[action.channelId] : undefined
        const active = action.channelId === liveChannel
        return {
          index,
          label: `${action.kind === 'play-channel-video' ? '▶ ' : ''}${directStreamDeckChannelLabel(
            channelIndex >= 0 ? channelIndex : index,
            channel?.caption ?? '',
            channel?.file?.name ?? ''
          )}`,
          color: active ? '#c51d34' : action.channelId === selectedChannel ? '#1769aa' : '#183447',
          active,
          disabled: action.kind === 'play-channel-video'
            ? channel?.file?.type !== 'video'
            : !channel?.file
        }
      }
      const active = action.kind === 'toggle-output' ? outputActive
        : action.kind === 'scene-toggle' ? programSceneEnabled
          : action.kind === 'scene-content' ? programSceneEnabled && programSceneViewMode === 'content'
            : action.kind === 'scene-participant' ? programSceneEnabled && programSceneViewMode === 'participant'
              : action.kind === 'scene-both' ? programSceneEnabled && programSceneViewMode === 'both'
        : action.kind === 'qr-toggle' ? qrOverlay.enabled
          : action.kind === 'timer-start-pause' ? timerRunning
            : action.kind === 'music-play-pause' ? musicPlaying
              : action.kind.startsWith('titles-') ? titlesVisible
                : false
      const disabled = action.kind === 'none' ||
        (action.kind.startsWith('scene-') && action.kind !== 'scene-toggle' && !programSceneEnabled) ||
        (action.kind.startsWith('music-') && musicPlaylist.length === 0) ||
        (action.kind.startsWith('timer-') && timerDuration <= 0 && action.kind !== 'timer-plus-5')
      return {
        index,
        label: action.kind === 'none' ? ''
          : (action.kind === 'titles-speaker' || action.kind === 'titles-all') && action.speakerId
            ? directStreamDeckSpeakerLabel(
                action.kind,
                broadcastTitles.speakers.find((speaker) => speaker.id === action.speakerId)?.name || ''
              ) || ACTION_KEY_LABELS[action.kind]
            : ACTION_KEY_LABELS[action.kind] || DIRECT_STREAM_DECK_ACTION_LABELS[action.kind],
        color: active ? '#c51d34' : action.kind.startsWith('music-') ? '#4c2b78'
          : action.kind.startsWith('timer-') ? '#805714'
            : action.kind.startsWith('titles-') ? '#773044'
              : action.kind === 'qr-toggle' ? '#155b57' : '#21445c',
        active,
        disabled
      }
    })
  ), [
    config, channelIds, channels, selectedChannel, liveChannel, outputActive,
    programSceneEnabled, programSceneViewMode, broadcastTitles.speakers,
    qrOverlay.enabled, timerRunning, timerDuration, musicPlaying, musicPlaylist.length, titlesVisible
  ])

  useEffect(() => {
    window.api.updateDirectStreamDeckKeys(keyStates)
  }, [keyStates])

  return null
}
