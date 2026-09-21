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

export interface TimerCommandModel {
  duration: number
  remaining: number
  running: boolean
  outputVisible: boolean
  outputOwner: 'toolbar' | 'scene' | null
  warned: boolean
  ended: boolean
}

export interface ProgramTimerRoute {
  duration: number
  outputVisible: boolean
  outputOwner: 'toolbar' | 'scene' | null
  hasDedicatedTimerDisplay: boolean
}

/**
 * A toolbar timer uses a dedicated timer display when one is assigned. A
 * Scene-owned timer is always part of Program as an overlay, even when the
 * venue also has a separate timer display.
 */
export function shouldShowTimerOnProgram(route: ProgramTimerRoute): boolean {
  return route.duration > 0 && route.outputVisible && (
    !route.hasDedicatedTimerDisplay || route.outputOwner === 'scene'
  )
}

/** Pure transition used by toolbar, Scene and Stream Deck timer commands. */
export function reduceTimerCommand(model: TimerCommandModel, command: TimerCommand): TimerCommandModel {
  if (command.type === 'apply-state') {
    const duration = Math.max(0, Math.round(command.duration))
    if (duration <= 0) {
      return {
        duration: 0, remaining: 0, running: false,
        outputVisible: false, outputOwner: null, warned: false, ended: false
      }
    }
    const remaining = Math.round(command.remaining)
    return {
      duration,
      remaining,
      running: command.running,
      outputVisible: true,
      outputOwner: 'scene',
      warned: remaining <= 60,
      ended: remaining <= 0
    }
  }
  if (command.type === 'set-duration') {
    const duration = Math.max(0, Math.round(command.seconds))
    return duration <= 0
      ? model
      : { ...model, duration, remaining: duration, warned: false, ended: false }
  }
  if (command.type === 'start') {
    if (model.duration <= 0) return model
    return {
      ...model,
      running: true,
      outputVisible: true,
      outputOwner: model.outputOwner ?? 'toolbar',
      warned: model.remaining <= 60,
      ended: model.remaining <= 0
    }
  }
  if (command.type === 'pause') return { ...model, running: false }
  if (command.type === 'stop') {
    return {
      duration: 0, remaining: 0, running: false,
      outputVisible: false, outputOwner: null, warned: false, ended: false
    }
  }
  if (command.type === 'reset') {
    return { ...model, remaining: model.duration, running: false, warned: false, ended: false }
  }
  const delta = command.minutes * 60
  if (model.duration <= 0 && delta <= 0) return model
  const remaining = model.remaining + delta
  return {
    ...model,
    // +/- changes the running remainder, not the duration used by Reset.
    // A positive adjustment is also allowed to create a previously unset
    // timer, matching the Scene editor.
    duration: model.duration > 0 ? model.duration : delta,
    remaining,
    outputVisible: true,
    outputOwner: model.outputVisible ? model.outputOwner : 'toolbar',
    warned: remaining > 60 ? false : model.warned,
    ended: remaining > 0 ? false : model.ended
  }
}

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
