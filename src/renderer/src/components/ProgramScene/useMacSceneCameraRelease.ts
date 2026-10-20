import { useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/useAppStore'

/** Release Scene-only cameras once both the preview and published Scene drop them. */
export function useMacSceneCameraRelease(): void {
  const scene = useAppStore((state) => state.programScene)
  const snapshot = useAppStore((state) => state.programSnapshot)
  const captures = useAppStore((state) => state.captureSources)
  const channels = useAppStore((state) => state.channels)
  const activeFile = useAppStore((state) => state.activeFile)
  const selectedFile = useAppStore((state) => state.selectedFile)
  const informationMedia = useAppStore((state) => state.informationMedia)
  const released = useRef(new Set<string>())

  useEffect(() => {
    if (window.api.platform !== 'darwin') return
    const used = new Set<string>()
    const retain = (file: { capture?: CaptureSourceConfig } | null | undefined): void => {
      if (file?.capture?.sourceId) used.add(file.capture.sourceId)
    }
    retain(activeFile)
    retain(selectedFile)
    retain(informationMedia)
    for (const channel of Object.values(channels)) retain(channel.file)
    if (scene.captureSourceId) used.add(scene.captureSourceId)
    if (snapshot?.scene.captureSourceId) used.add(snapshot.scene.captureSourceId)

    // A camera can also be the Scene background rather than its participant.
    for (const config of [scene.background, snapshot?.scene.background]) {
      if (config?.kind === 'channel' && config.channelId) retain(channels[config.channelId]?.file)
    }
    for (const entry of captures) {
      const sourceId = entry.capture?.sourceId
      if (!sourceId || !entry.sceneOnly || entry.capture?.captureKind !== 'device') continue
      if (used.has(sourceId)) {
        released.current.delete(sourceId)
      } else if (!released.current.has(sourceId)) {
        released.current.add(sourceId)
        window.api.sendToPresentation('capture-source-unregister', sourceId)
        window.api.dbgLog(`Scene camera released after hide source=${sourceId.slice(-8)}`)
      }
    }
  }, [scene, snapshot, captures, channels, activeFile, selectedFile, informationMedia])
}
