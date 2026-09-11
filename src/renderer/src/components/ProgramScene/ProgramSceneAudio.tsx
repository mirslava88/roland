import { useEffect, useRef, useState } from 'react'
import { DEFAULT_PROGRAM_SCENE_AUDIO, normalizeProgramSceneAudio, type ProgramSceneAudioStatus } from '../../../../shared/program-scene-audio'
import { ProgramSceneAudioSession } from './program-scene-audio-session'

export function ProgramSceneAudio({ active }: { active: boolean }): null {
  const [config, setConfig] = useState(DEFAULT_PROGRAM_SCENE_AUDIO)
  const session = useRef<ProgramSceneAudioSession | null>(null)
  useEffect(() => {
    let lastStatus: ProgramSceneAudioStatus = { phase: 'idle', message: '' }
    const audio = new ProgramSceneAudioSession(navigator.mediaDevices, () => new Audio(), (status) => {
      lastStatus = status
      window.api.sendToControl('program-scene-audio-status', status)
    })
    session.current = audio
    const retry = (): void => { void audio.retry() }
    const devicesChanged = (): void => { void audio.devicesChanged() }
    const stop = (): void => audio.stop()
    const unsubscribe = window.api.on('program-scene-audio-retry', retry)
    const unsubscribeConfig = window.api.on('program-scene-audio-update', (...args: unknown[]) => {
      setConfig(normalizeProgramSceneAudio(args[0]))
    })
    const unsubscribeStatus = window.api.on('program-scene-audio-status-request', () => {
      window.api.sendToControl('program-scene-audio-status', lastStatus)
    })
    navigator.mediaDevices.addEventListener('devicechange', devicesChanged)
    window.addEventListener('pagehide', stop)
    window.api.sendToControl('program-scene-audio-ready')
    return () => {
      unsubscribe()
      unsubscribeConfig()
      unsubscribeStatus()
      navigator.mediaDevices.removeEventListener('devicechange', devicesChanged)
      window.removeEventListener('pagehide', stop)
      audio.stop()
      session.current = null
    }
  }, [])
  useEffect(() => {
    void session.current?.set(active ? config : null)
  }, [active, config.enabled, config.deviceId, config.groupId, config.label])
  return null
}
