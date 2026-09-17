import {
  DIRECT_STREAM_DECK_CONFIG_EVENT,
  DIRECT_STREAM_DECK_STORAGE_KEY,
  createDefaultDirectStreamDeckConfig,
  normalizeDirectStreamDeckConfig,
  type DirectStreamDeckConfig
} from '../../shared/direct-stream-deck'

export function readDirectStreamDeckConfig(): DirectStreamDeckConfig {
  try {
    return normalizeDirectStreamDeckConfig(JSON.parse(localStorage.getItem(DIRECT_STREAM_DECK_STORAGE_KEY) ?? 'null'))
  } catch {
    return createDefaultDirectStreamDeckConfig()
  }
}

export function saveDirectStreamDeckConfig(config: DirectStreamDeckConfig): DirectStreamDeckConfig {
  const normalized = normalizeDirectStreamDeckConfig(config)
  localStorage.setItem(DIRECT_STREAM_DECK_STORAGE_KEY, JSON.stringify(normalized))
  window.dispatchEvent(new CustomEvent<DirectStreamDeckConfig>(
    DIRECT_STREAM_DECK_CONFIG_EVENT,
    { detail: normalized }
  ))
  return normalized
}
