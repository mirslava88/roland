import { useEffect } from 'react'
import { useAppStore } from '../../stores/useAppStore'

export function BroadcastTitlesBridge(): null {
  const output = useAppStore((state) => state.broadcastTitlesOutput)

  useEffect(() => {
    window.api.sendToPresentation('broadcast-titles-update', output)
  }, [output])

  useEffect(() => window.api.on('broadcast-titles-ready', () => {
    window.api.sendToPresentation(
      'broadcast-titles-update',
      useAppStore.getState().broadcastTitlesOutput
    )
  }), [])

  useEffect(() => {
    if (!output.speakerVisible || output.speakerAutoHideSeconds <= 0) return
    const timer = setTimeout(() => {
      useAppStore.getState().setBroadcastTitlesOutput({ speakerVisible: false })
    }, output.speakerAutoHideSeconds * 1000)
    return () => clearTimeout(timer)
  }, [
    output.speakerVisible,
    output.speakerId,
    output.speakerName,
    output.speakerRole,
    output.speakerAutoHideSeconds,
    output.speakerStyle,
    output.speakerTextColor,
    output.speakerBackgroundStart,
    output.speakerBackgroundEnd,
    output.speakerAccentStart,
    output.speakerAccentEnd
  ])

  useEffect(() => {
    if (!output.eventVisible || output.eventAutoHideSeconds <= 0) return
    const timer = setTimeout(() => {
      useAppStore.getState().setBroadcastTitlesOutput({ eventVisible: false })
    }, output.eventAutoHideSeconds * 1000)
    return () => clearTimeout(timer)
  }, [
    output.eventVisible,
    output.eventLabel,
    output.eventInfo,
    output.eventAutoHideSeconds,
    output.eventPosition,
    output.eventStyle,
    output.eventTextColor,
    output.eventBackgroundStart,
    output.eventBackgroundEnd,
    output.eventAccentStart,
    output.eventAccentEnd
  ])

  return null
}
