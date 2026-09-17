export interface ProgramSceneChannelState {
  liveChannel: string | null
  sceneContentChannelId: string | null
  selectedChannel: string | null
  channels: Record<string, { file?: unknown } | undefined>
}

/** Select the source that is actually on air before falling back to draft/UI state. */
export function resolveProgramSceneChannel(state: ProgramSceneChannelState): string | null {
  if (state.liveChannel && state.channels[state.liveChannel]?.file) return state.liveChannel
  if (state.sceneContentChannelId && state.channels[state.sceneContentChannelId]?.file) {
    return state.sceneContentChannelId
  }
  if (state.selectedChannel && state.channels[state.selectedChannel]?.file) return state.selectedChannel
  return null
}
