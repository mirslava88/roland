import { useEffect } from 'react'
import {
  captureSourceIdentity,
  DEFAULT_BROADCAST_TITLES_OUTPUT,
  useAppStore,
  type BroadcastTitlesOutput
} from '../../stores/useAppStore'
import { resolveProgramSceneBackground } from '../../program-scene-background'

const OFFICE_PROGRAM_EXTENSIONS = new Set(['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.ods'])

function supportsProgramSceneTitles(file: ReturnType<typeof useAppStore.getState>['activeFile']): boolean {
  return !!file && (
    file.type === 'presentation' ||
    file.type === 'pdf' ||
    file.type === 'video' ||
    (file.type === 'other' && (
      file.isImage === true || OFFICE_PROGRAM_EXTENSIONS.has(file.extension.toLowerCase())
    )) ||
    (file.type === 'capture' && (
      file.capture?.captureKind === 'desktop'
    ))
  )
}

function sceneTitleSourceIdentity(state: ReturnType<typeof useAppStore.getState>): string | null {
  const supportedContent = !state.activeFile || supportsProgramSceneTitles(state.activeFile)
  const background = resolveProgramSceneBackground(state)
  if (!state.programScene.enabled || !background || !supportedContent) return null
  const capture = state.captureSources.find(
    (entry) => entry.capture?.sourceId === state.programScene.captureSourceId
  )?.capture
  if (state.activeFile?.type === 'capture' && state.activeFile.capture?.sourceId === capture?.sourceId) return null
  if (background.type === 'capture' && background.capture.sourceId === capture?.sourceId) return null
  return captureSourceIdentity(capture)
}

function effectiveProgramTitleSourceIdentity(
  state: ReturnType<typeof useAppStore.getState>
): string | null {
  return sceneTitleSourceIdentity(state) || state.programCaptureTitlesSourceIdentity
}

function currentProgramTitlesOutput(): BroadcastTitlesOutput {
  const state = useAppStore.getState()
  const sourceIdentity = effectiveProgramTitleSourceIdentity(state)
  const output = sourceIdentity
    ? state.captureTitlesOutputs[sourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : DEFAULT_BROADCAST_TITLES_OUTPUT
  return { ...output, sourceIdentity }
}

function identityForCommittedSource(sourceId: string): string | null {
  const state = useAppStore.getState()
  const candidates = [
    state.activeFile?.type === 'capture' ? state.activeFile.capture : undefined,
    state.informationMedia?.type === 'capture' ? state.informationMedia.capture : undefined,
    ...state.captureSources.map((entry) => entry.capture),
    ...Object.values(state.channels).map((channel) => channel.file?.capture)
  ]
  const capture = candidates.find((candidate) => candidate?.sourceId === sourceId)
  return captureSourceIdentity(capture)
}

function CaptureTitlesAutoHide({
  sourceIdentity,
  output,
  active
}: {
  sourceIdentity: string
  output: BroadcastTitlesOutput
  active: boolean
}): null {
  const setCaptureTitlesOutput = useAppStore((state) => state.setCaptureTitlesOutput)

  useEffect(() => {
    if (!active || !output.speakerVisible || output.speakerAutoHideSeconds <= 0) return
    const timer = setTimeout(() => {
      setCaptureTitlesOutput(sourceIdentity, { speakerVisible: false })
    }, output.speakerAutoHideSeconds * 1000)
    return () => clearTimeout(timer)
  }, [
    output.speakerVisible,
    output.speakerRevision,
    output.speakerId,
    output.speakerName,
    output.speakerRole,
    output.speakerAutoHideSeconds,
    output.speakerStyle,
    output.speakerTextColor,
    output.speakerBackgroundStart,
    output.speakerBackgroundEnd,
    output.speakerAccentStart,
    output.speakerAccentEnd,
    active,
    setCaptureTitlesOutput,
    sourceIdentity
  ])

  useEffect(() => {
    if (!active || !output.eventVisible || output.eventAutoHideSeconds <= 0) return
    const timer = setTimeout(() => {
      setCaptureTitlesOutput(sourceIdentity, { eventVisible: false })
    }, output.eventAutoHideSeconds * 1000)
    return () => clearTimeout(timer)
  }, [
    output.eventVisible,
    output.eventRevision,
    output.eventLabel,
    output.eventInfo,
    output.eventAutoHideSeconds,
    output.eventPosition,
    output.eventStyle,
    output.eventTextColor,
    output.eventBackgroundStart,
    output.eventBackgroundEnd,
    output.eventAccentStart,
    output.eventAccentEnd,
    active,
    setCaptureTitlesOutput,
    sourceIdentity
  ])

  return null
}

export function BroadcastTitlesBridge(): JSX.Element | null {
  const captureOutputs = useAppStore((state) => state.captureTitlesOutputs)
  const activeSourceIdentity = useAppStore((state) => state.programCaptureTitlesSourceIdentity)
  const activeFile = useAppStore((state) => state.activeFile)
  const captureSources = useAppStore((state) => state.captureSources)
  const programScene = useAppStore((state) => state.programScene)
  const backdropImage = useAppStore((state) => state.backdropImage)
  const channels = useAppStore((state) => state.channels)
  const pptxSlidesMap = useAppStore((state) => state.pptxSlidesMap)
  const pptxThumbnailsMap = useAppStore((state) => state.pptxThumbnailsMap)
  const informationMedia = useAppStore((state) => state.informationMedia)
  const informationOutputAssigned = useAppStore((state) => (
    state.displays.some((display) => (
      !display.isPrimary && state.displayAssignments[String(display.id)] === 'information'
    ))
  ))
  const informationSourceIdentity = informationOutputAssigned && informationMedia?.type === 'capture'
    ? captureSourceIdentity(informationMedia.capture)
    : null
  // This is the source actually painted by PresentationApp, not the next TAKE
  // selected in the control store.  Keep its auto-hide clock running until the
  // output renderer confirms the handoff or a native output is revealed.
  void backdropImage
  void channels
  void pptxSlidesMap
  void pptxThumbnailsMap
  const sceneSourceIdentity = sceneTitleSourceIdentity(useAppStore.getState())
  const programSourceIdentity = sceneSourceIdentity || activeSourceIdentity
  const output = programSourceIdentity
    ? captureOutputs[programSourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : DEFAULT_BROADCAST_TITLES_OUTPUT
  const programOutput = { ...output, sourceIdentity: programSourceIdentity }

  useEffect(() => {
    window.api.sendToPresentation('broadcast-titles-update', programOutput)
  }, [programSourceIdentity, output])

  useEffect(() => window.api.on('broadcast-titles-ready', () => {
    window.api.sendToPresentation(
      'broadcast-titles-update',
      currentProgramTitlesOutput()
    )
  }), [])

  useEffect(() => window.api.on('presentation-content-ready', (...args: unknown[]) => {
    const payload = args[0] as { type?: string; sourceId?: string } | undefined
    const state = useAppStore.getState()
    if (payload?.type === 'capture' && payload.sourceId) {
      const sourceIdentity = identityForCommittedSource(payload.sourceId)
      state.setProgramCaptureTitlesSourceIdentity(sourceIdentity)
      window.api.dbgLog(
        `program titles committed source=${payload.sourceId.slice(-8)} identity=${sourceIdentity || 'unknown'}`
      )
      return
    }
    state.setProgramCaptureTitlesSourceIdentity(null)
  }), [])

  useEffect(() => window.api.on('presentation-content-cleared', () => {
    useAppStore.getState().setProgramCaptureTitlesSourceIdentity(null)
  }), [])

  return (
    <>
      {Object.entries(captureOutputs).map(([sourceIdentity, captureOutput]) => (
        <CaptureTitlesAutoHide
          key={sourceIdentity}
          sourceIdentity={sourceIdentity}
          output={captureOutput}
          active={sourceIdentity === programSourceIdentity || sourceIdentity === informationSourceIdentity}
        />
      ))}
    </>
  )
}
