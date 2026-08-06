import { useAppStore } from './stores/useAppStore'

export type ChannelBoundaryDirection = 'next' | 'prev'

/**
 * Starts the nearest populated channel in the requested direction after slide
 * navigation reaches a real document boundary. Empty channels are skipped.
 */
export function takeAdjacentChannel(direction: ChannelBoundaryDirection): boolean {
  const state = useAppStore.getState()
  if (!state.channelBoundaryNavigationEnabled || !state.liveChannel) return false

  const currentIndex = state.channelIds.indexOf(state.liveChannel)
  if (currentIndex < 0) return false
  const step = direction === 'next' ? 1 : -1
  let targetIndex = currentIndex + step
  while (
    targetIndex >= 0 &&
    targetIndex < state.channelIds.length &&
    !state.channels[state.channelIds[targetIndex]]?.file
  ) {
    targetIndex += step
  }
  if (targetIndex < 0 || targetIndex >= state.channelIds.length) return false

  const targetChannel = state.channelIds[targetIndex]

  useAppStore.setState({
    selectedChannel: targetChannel,
    currentChannelPage: Math.floor(targetIndex / state.channelGridSize)
  })
  window.api.dbgLog(
    `channel-boundary: ${direction} ${state.liveChannel}->${targetChannel}`
  )
  window.dispatchEvent(new CustomEvent('take-channel', { detail: targetChannel }))
  return true
}
