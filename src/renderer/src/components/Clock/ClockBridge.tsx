import { useCallback, useEffect } from 'react'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'

export function ClockBridge(): null {
  const programClock = useAppStore((state) => state.programClock)
  const speakerClock = useAppStore((state) => state.speakerClock)
  const displays = useAppStore((state) => state.displays)
  const displayAssignments = useAppStore((state) => state.displayAssignments)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const internalProgramOutputActive = useAppStore((state) => state.internalProgramOutputActive)
  const programDisplayId = connectedProgramDisplayId({ displays, displayAssignments, selectedDisplayId })

  const sendProgram = useCallback((): void => {
    window.api.sendToPresentation('program-clock-update',
      internalProgramOutputActive && programDisplayId === null ? programClock : null)
  }, [internalProgramOutputActive, programClock, programDisplayId])
  const sendSpeaker = useCallback((): void => {
    window.api.sendToAuxiliary('speaker', 'speaker-clock-update', speakerClock)
  }, [speakerClock])
  const sendMirror = useCallback((): void => {
    window.api.sendToAuxiliary('mirror', 'mirror-clock-update', programClock)
  }, [programClock])

  useEffect(sendProgram, [sendProgram])
  useEffect(sendSpeaker, [sendSpeaker])
  useEffect(sendMirror, [sendMirror])
  useEffect(() => window.api.on('program-scene-ready', sendProgram), [sendProgram])
  useEffect(() => window.api.on('speaker-state-ready', sendSpeaker), [sendSpeaker])
  useEffect(() => window.api.on('program-mirror-state-ready', sendMirror), [sendMirror])

  useEffect(() => {
    window.api.updateClockOverlay({
      visible: programClock.enabled && programDisplayId !== null,
      displayId: programDisplayId,
      x: programClock.position.x,
      y: programClock.position.y,
      scale: programClock.scale,
      color: programClock.color,
      opacity: programClock.opacity
    })
  }, [programClock, programDisplayId])

  return null
}
