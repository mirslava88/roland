export interface ProgramSceneAudioConfig {
  enabled: boolean
  deviceId: string
  groupId: string
  label: string
}

export const DEFAULT_PROGRAM_SCENE_AUDIO: ProgramSceneAudioConfig = {
  enabled: false, deviceId: '', groupId: '', label: ''
}

export function normalizeProgramSceneAudio(value: unknown): ProgramSceneAudioConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 1024) : ''
  return { enabled: raw.enabled === true, deviceId: text(raw.deviceId), groupId: text(raw.groupId), label: text(raw.label) }
}

export interface ProgramSceneAudioStatus {
  phase: 'idle' | 'starting' | 'live' | 'error'
  message: string
}

/** Never silently fall back to an unrelated/default microphone after unplugging. */
export function resolveProgramSceneAudioDevice(
  config: ProgramSceneAudioConfig,
  devices: Array<{ kind: string; deviceId: string; groupId: string; label: string }>
): string | null {
  const inputs = devices.filter((device) => device.kind === 'audioinput')
  const exact = inputs.find((device) => device.deviceId === config.deviceId)
  if (exact) return exact.deviceId
  const realInputs = inputs.filter((device) => !['default', 'communications'].includes(device.deviceId))
  const grouped = config.groupId ? realInputs.filter((device) => device.groupId === config.groupId) : []
  if (grouped.length === 1) return grouped[0].deviceId
  const labelled = config.label ? realInputs.filter((device) => device.label === config.label) : []
  return labelled.length === 1 ? labelled[0].deviceId : null
}
