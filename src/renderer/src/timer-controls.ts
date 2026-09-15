import { mediaUrl } from './media'

export type TimerCommand =
  | { type: 'set-duration'; seconds: number }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'reset' }
  | { type: 'add-minutes'; minutes: number }
  | { type: 'apply-state'; duration: number; remaining: number; running: boolean }

export const TIMER_COMMAND_EVENT = 'pdm-timer-command'

export function sendTimerCommand(command: TimerCommand): void {
  window.dispatchEvent(new CustomEvent<TimerCommand>(TIMER_COMMAND_EVENT, { detail: command }))
}

export function playTimerSound(rawPath: string, kind: 'warning' | 'end'): void {
  try {
    const url = mediaUrl(rawPath)
    window.api.dbgLog(`Timer: play ${kind} sound url=${url}`)
    const audio = new Audio(url)
    audio.volume = 1
    void audio.play().then(() => {
      window.api.dbgLog(`Timer: ${kind} sound playing OK`)
    }).catch((error) => {
      window.api.dbgLog(`Timer: ${kind} sound play() failed: ${String(error)}`)
    })
  } catch (error) {
    window.api.dbgLog(`Timer: ${kind} sound Audio() threw: ${String(error)}`)
  }
}
