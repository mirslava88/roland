import type { DirectStreamDeckAction } from '../../../../shared/direct-stream-deck'
import { hasQrData, type QrOverlayConfig } from '../../../../shared/qr-overlay'
import type { TimerCommand } from '../../timer-controls'

interface StreamDeckChannelFile {
  type: string
  path: string
}

interface StreamDeckState {
  channels: Record<string, { file?: StreamDeckChannelFile | null } | undefined>
  liveChannel: string | null
  activeFile: { path: string } | null
  qrOverlay: QrOverlayConfig
  programSnapshot: unknown
  timerRunning: boolean
  setSelectedChannel: (channelId: string) => void
  setIsPlaying: (playing: boolean) => void
  setVideoPlayback: (path: string, state: { playing: boolean }) => void
  setQrOverlay: (patch: Partial<QrOverlayConfig>) => void
  publishProgramSnapshot: (channelId?: string, patch?: { qrOverlay?: QrOverlayConfig }) => unknown
}

export interface DirectStreamDeckActionEnvironment {
  getState: () => StreamDeckState
  dispatch: (type: string, detail?: unknown) => void
  sendToPresentation: (channel: string, payload?: unknown) => void
  sendTimerCommand: (command: TimerCommand) => void
  musicGetState: () => Promise<{ playing?: boolean } | null | undefined>
  musicPlay: () => Promise<unknown>
  musicPause: () => Promise<unknown>
  musicStop: () => Promise<unknown>
  musicPrevious: () => Promise<unknown>
  musicNext: () => Promise<unknown>
  log: (message: string) => void
}

export function directStreamDeckChannelLabel(index: number, caption: string, fileName: string): string {
  const name = caption.trim() || fileName.replace(/\.[^.]+$/, '').trim()
  return name ? `${index + 1} ${name}` : `КАНАЛ ${index + 1}`
}

export function directStreamDeckSpeakerLabel(kind: DirectStreamDeckAction['kind'], name: string): string {
  const cleanName = name.trim()
  if (kind !== 'titles-all') return cleanName
  const surname = cleanName.split(/\s+/)[0] || cleanName
  return `ТИТРЫ ВСЕ ${surname}`
}

export async function executeDirectStreamDeckAction(
  action: DirectStreamDeckAction,
  keyIndex: number,
  environment: DirectStreamDeckActionEnvironment
): Promise<void> {
  const state = environment.getState()
  environment.log(`Stream Deck command key=${keyIndex} action=${action.kind}`)
  switch (action.kind) {
    case 'take-channel': {
      if (!action.channelId || !state.channels[action.channelId]?.file) return
      state.setSelectedChannel(action.channelId)
      environment.dispatch('take-channel', action.channelId)
      return
    }
    case 'play-channel-video': {
      const channel = action.channelId ? state.channels[action.channelId] : undefined
      if (!action.channelId || channel?.file?.type !== 'video') return
      state.setSelectedChannel(action.channelId)
      if (state.liveChannel === action.channelId && state.activeFile?.path === channel.file.path) {
        environment.sendToPresentation('play-pause', true)
        state.setIsPlaying(true)
        state.setVideoPlayback(channel.file.path, { playing: true })
        return
      }
      environment.dispatch('take-channel-video', action.channelId)
      return
    }
    case 'previous-slide':
    case 'next-slide':
      environment.dispatch('pdm-direct-navigation', action.kind === 'next-slide' ? 'next' : 'prev')
      return
    case 'toggle-output':
      environment.dispatch('pdm-toggle-program-output')
      return
    case 'scene-toggle':
      environment.dispatch('pdm-toggle-program-scene')
      return
    case 'scene-content':
    case 'scene-participant':
    case 'scene-both':
      environment.dispatch(
        'pdm-program-scene-view-mode',
        action.kind === 'scene-content'
          ? 'content'
          : action.kind === 'scene-participant' ? 'participant' : 'both'
      )
      return
    case 'titles-speaker':
    case 'titles-event':
    case 'titles-all':
    case 'titles-hide':
      environment.dispatch('pdm-broadcast-titles-command', {
        kind: action.kind,
        speakerId: action.speakerId
      })
      return
    case 'qr-toggle': {
      if (!hasQrData(state.qrOverlay)) {
        environment.dispatch('open-program-scene', { editor: 'qr' })
        return
      }
      const qrOverlay = { ...state.qrOverlay, enabled: !state.qrOverlay.enabled }
      state.setQrOverlay({ enabled: qrOverlay.enabled })
      if (state.programSnapshot) state.publishProgramSnapshot(undefined, { qrOverlay })
      return
    }
    case 'timer-start-pause':
      environment.sendTimerCommand({ type: state.timerRunning ? 'pause' : 'start' })
      return
    case 'timer-reset':
      environment.sendTimerCommand({ type: 'reset' })
      return
    case 'timer-plus-5':
      environment.sendTimerCommand({ type: 'add-minutes', minutes: 5 })
      return
    case 'timer-minus-5':
      environment.sendTimerCommand({ type: 'add-minutes', minutes: -5 })
      return
    case 'music-previous':
      await environment.musicPrevious()
      return
    case 'music-play-pause': {
      const music = await environment.musicGetState()
      if (music?.playing) await environment.musicPause()
      else await environment.musicPlay()
      return
    }
    case 'music-stop':
      await environment.musicStop()
      return
    case 'music-next':
      await environment.musicNext()
      return
    case 'none':
      return
  }
}
