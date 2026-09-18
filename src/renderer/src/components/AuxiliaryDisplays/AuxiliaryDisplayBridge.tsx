import { useEffect, useMemo, useRef, useState } from 'react'
import {
  captureSourceIdentity,
  DEFAULT_BROADCAST_TITLES_OUTPUT,
  useAppStore
} from '../../stores/useAppStore'
import { waitForNavigationTransitionEnd } from '../../navigation-transition'
import { resolveProgramSceneBackground } from '../../program-scene-background'

const notesCache = new Map<string, string>()
const notesInflight = new Map<string, Promise<string>>()

function getSlideNotes(filePath: string, slide: number): Promise<string> {
  const key = `${filePath}|${slide}`
  const existing = notesInflight.get(key)
  if (existing) return existing
  const request = window.api.getPptxSlideNotes(filePath, slide)
    .then((result) => result.success ? result.notes || '' : '')
    .catch(() => '')
    .finally(() => notesInflight.delete(key))
  notesInflight.set(key, request)
  return request
}

function currentInformationDisplayState(): InformationDisplayState {
  const state = useAppStore.getState()
  const sourceIdentity = state.informationMedia?.type === 'capture'
    ? captureSourceIdentity(state.informationMedia.capture)
    : null
  return {
    media: state.informationMedia,
    displayTimer: false,
    backdropImage: state.backdropImage,
    titleSourceIdentity: sourceIdentity,
    titles: sourceIdentity
      ? state.captureTitlesOutputs[sourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
      : DEFAULT_BROADCAST_TITLES_OUTPUT
  }
}

function currentInformationTitlesState(): Pick<InformationDisplayState, 'titleSourceIdentity' | 'titles'> {
  const state = useAppStore.getState()
  const titleSourceIdentity = state.informationMedia?.type === 'capture'
    ? captureSourceIdentity(state.informationMedia.capture)
    : null
  return {
    titleSourceIdentity,
    titles: titleSourceIdentity
      ? state.captureTitlesOutputs[titleSourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
      : DEFAULT_BROADCAST_TITLES_OUTPUT
  }
}

function currentTimerDisplayState(): TimerDisplayState {
  const state = useAppStore.getState()
  return {
    remaining: state.timerRemaining,
    running: state.timerRunning,
    duration: state.timerDuration,
    textColor: state.timerTextColor,
    warningTextColor: state.timerWarningTextColor,
    overtimeTextColor: state.timerOvertimeTextColor,
    textOpacity: state.timerTextOpacity
  }
}

function currentSpeakerDisplayState(
  state: ReturnType<typeof useAppStore.getState>
): SpeakerDisplayState {
  const {
    activeFile,
    backdropImage,
    currentSlide,
    totalSlides,
    pptxSlidesMap,
    pptxThumbnailsMap
  } = state
  const supported = activeFile?.type === 'presentation' || activeFile?.type === 'pdf'
  if (!activeFile || !supported) {
    return {
      active: false,
      fileType: null,
      filePath: null,
      fileName: '',
      currentSlide: 1,
      totalSlides: 0,
      notes: '',
      backdropImage
    }
  }

  const slideImages = activeFile.type === 'presentation'
    ? pptxSlidesMap[activeFile.path] || pptxThumbnailsMap[activeFile.path] || []
    : []
  const knownTotal = Math.max(totalSlides, slideImages.length)
  const safeCurrent = Math.max(1, knownTotal > 0 ? Math.min(currentSlide, knownTotal) : currentSlide)
  return {
    active: true,
    fileType: activeFile.type === 'presentation' ? 'presentation' : 'pdf',
    filePath: activeFile.path,
    fileName: activeFile.name,
    currentSlide: safeCurrent,
    totalSlides: knownTotal,
    currentImagePath: slideImages[safeCurrent - 1] || null,
    nextImagePath: safeCurrent < knownTotal ? slideImages[safeCurrent] || null : null,
    notes: activeFile.type === 'presentation'
      ? notesCache.get(`${activeFile.path}|${safeCurrent}`) || ''
      : '',
    backdropImage
  }
}

function sendProgramMirrorState(state: ReturnType<typeof useAppStore.getState>): void {
  const {
    activeFile,
    backdropImage,
    currentSlide,
    displays,
    isPlaying,
    isPresentationWindowOpen,
    pptxAspectRatios,
    programScene: draftProgramScene,
    programSnapshot,
    selectedDisplayId,
    videoLoopTrack,
    videoPlayback
  } = state
  const programScene = programSnapshot?.scene ?? draftProgramScene
  const sourceDisplay = displays.find((display) => display.id === selectedDisplayId)
  const presentationAspectRatio = activeFile?.type === 'presentation'
    ? pptxAspectRatios[activeFile.path] ?? null
    : null
  const playback = activeFile?.type === 'video'
    ? videoPlayback[activeFile.path]
    : undefined
  const sceneBackground = resolveProgramSceneBackground({ ...state, programScene })
  const selectedSceneCapture = state.captureSources.find(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )?.capture
  const sceneContentSupported = !activeFile || (
    activeFile.type === 'presentation' ||
    activeFile.type === 'pdf' ||
    activeFile.type === 'video' ||
    (activeFile.type === 'other' && activeFile.isImage === true) ||
    (activeFile.type === 'capture' && activeFile.capture?.captureKind === 'desktop')
  )
  const sceneActive = programSnapshot !== null && programScene.enabled &&
    sceneContentSupported &&
    !(activeFile?.type === 'capture' && activeFile.capture?.sourceId === selectedSceneCapture?.sourceId) &&
    !(sceneBackground?.type === 'capture' && sceneBackground.capture.sourceId === selectedSceneCapture?.sourceId)
  const sceneCapture = sceneActive ? selectedSceneCapture : undefined
  const titleSourceIdentity = sceneCapture
    ? captureSourceIdentity(sceneCapture)
    : activeFile?.type === 'capture'
      ? captureSourceIdentity(activeFile.capture)
      : null
  const titles = titleSourceIdentity
    ? state.captureTitlesOutputs[titleSourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : DEFAULT_BROADCAST_TITLES_OUTPUT
  let directContent: ProgramDirectContent | null = null
  if (sceneActive) {
    // A composite spans the Electron underlay and, for PowerPoint, a native
    // window. Capture the final program display so mirror outputs are exact.
    directContent = null
  } else if (activeFile?.type === 'pdf') {
    directContent = {
      type: 'pdf',
      path: activeFile.path,
      currentSlide
    }
  } else if (activeFile?.type === 'video') {
    directContent = {
      type: 'video',
      path: activeFile.path,
      currentTime: playback?.currentTime ?? 0,
      playing: playback?.playing ?? isPlaying,
      loop: videoLoopTrack
    }
  } else if (activeFile?.type === 'other' && activeFile.isImage) {
    directContent = { type: 'image', path: activeFile.path }
  } else if (activeFile?.type === 'capture' && activeFile.capture) {
    directContent = {
      type: 'capture',
      path: activeFile.path,
      capture: activeFile.capture
    }
  } else if (backdropImage && (!activeFile || activeFile.isAudio)) {
    directContent = { type: 'backdrop', path: backdropImage }
  }
  const mirrorActive = activeFile !== null || isPresentationWindowOpen || directContent !== null
  window.api.sendToAuxiliary('mirror', 'mirror-state', {
    sourceDisplayId: selectedDisplayId,
    sourcePixelWidth: sourceDisplay
      ? Math.round(sourceDisplay.bounds.width * sourceDisplay.scaleFactor)
      : null,
    sourcePixelHeight: sourceDisplay
      ? Math.round(sourceDisplay.bounds.height * sourceDisplay.scaleFactor)
      : null,
    sourceDipHeight: sourceDisplay?.bounds.height ?? null,
    contentType: activeFile?.type ?? null,
    contentAspectRatio: presentationAspectRatio,
    directContent,
    active: mirrorActive,
    backdropImage,
    titleSourceIdentity,
    titles
  })
  if (activeFile?.type === 'presentation') {
    window.api.dbgLog(
      `program mirror state source=${sourceDisplay?.id ?? 'none'} ` +
      `size=${sourceDisplay ? `${sourceDisplay.bounds.width}x${sourceDisplay.bounds.height}` : 'none'} ` +
      `pptxAspect=${presentationAspectRatio ?? 'missing'} file=${activeFile.path}`
    )
  }
}

function useAuxiliaryWindows(
  role: AuxiliaryDisplayRole,
  ids: number[],
  topologyRevision: number
): void {
  const signature = ids.join(',')
  const previousIdsRef = useRef<number[]>([])
  useEffect(() => {
    let cancelled = false
    const previousIds = previousIdsRef.current
    previousIdsRef.current = [...ids]
    const reconcile = async (): Promise<void> => {
      const desiredIds = new Set(ids)
      // Close only displays that no longer carry this role. Re-running a
      // topology reconciliation must not blink healthy windows on the other
      // outputs just because one monitor was switched to another input.
      for (const previousDisplayId of previousIds) {
        if (desiredIds.has(previousDisplayId)) continue
        await window.api.closeAuxiliaryWindow(role, previousDisplayId)
      }
      for (const displayId of ids) {
        if (cancelled) return
        let opened: Awaited<ReturnType<typeof window.api.openAuxiliaryWindow>> | null = null
        for (let attempt = 1; attempt <= 5 && !cancelled; attempt++) {
          opened = await window.api.openAuxiliaryWindow(role, displayId)
          if (opened.success) break
          window.api.dbgLog(
            `${role} display open retry id=${displayId} attempt=${attempt}/5: ` +
            `${opened.error || 'unknown error'}`
          )
          if (attempt < 5) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 300))
          }
        }
        // Opening can race Windows' remove/add topology stabilization. A
        // transient failure must never rewrite the user's desired role to Off;
        // the next topology reconciliation will try again.
        if (!cancelled && !opened?.success) {
          window.api.dbgLog(`${role} display unavailable id=${displayId}; assignment retained`)
        }
      }
    }
    void reconcile()
    return () => { cancelled = true }
  }, [role, signature, topologyRevision])
}

export function AuxiliaryDisplayBridge(): null {
  const taskbarSyncChainRef = useRef<Promise<void>>(Promise.resolve())
  const taskbarSyncRevisionRef = useRef(0)
  const [displayTopologyRevision, setDisplayTopologyRevision] = useState(0)
  const {
    activeFile,
    isPlaying,
    isPresentationWindowOpen,
    currentSlide,
    totalSlides,
    pptxSlidesMap,
    pptxAspectRatios,
    pptxThumbnailsMap,
    displays,
    displayAssignments,
    selectedDisplayId,
    informationMedia,
    captureTitlesOutputs,
    backdropImage,
    programScene,
    videoLoopTrack,
    videoPlayback,
    timerRemaining,
    timerRunning,
    timerDuration,
    timerOutputVisible,
    timerTextColor,
    timerWarningTextColor,
    timerOvertimeTextColor,
    timerTextOpacity,
    eventTimer,
    eventTimerOutput,
    setInformationMedia
  } = useAppStore()

  const roleIds = useMemo(() => {
    const sortedDisplays = displays
      .filter((display) => !display.isPrimary)
      .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    const ids = (mode: Exclude<DisplayOutputMode, 'off'>): number[] => sortedDisplays
      .filter((display) => displayAssignments[String(display.id)] === mode)
      .map((display) => display.id)
    const program = ids('program')
    return {
      mirror: program.filter((displayId) => displayId !== selectedDisplayId),
      speaker: ids('speaker'),
      info: ids('information'),
      timer: ids('timer'),
      eventTimer: ids('event-timer'),
      backdrop: sortedDisplays
        .filter((display) => {
          const mode = displayAssignments[String(display.id)]
          return mode === undefined || mode === 'off'
        })
        .map((display) => display.id)
    }
  }, [displayAssignments, displays, selectedDisplayId])

  // Windows can publish remove + add for the same display id before React
  // commits an intermediate render. The final roleIds signature is then
  // unchanged even though main already closed that display's native window.
  // Count every topology push so the surviving assignment is always reopened.
  useEffect(() => window.api.on('displays-changed', () => {
    setDisplayTopologyRevision((revision) => revision + 1)
  }), [])

  useAuxiliaryWindows('mirror', roleIds.mirror, displayTopologyRevision)
  useAuxiliaryWindows('speaker', roleIds.speaker, displayTopologyRevision)
  useAuxiliaryWindows('info', roleIds.info, displayTopologyRevision)
  useAuxiliaryWindows('timer', roleIds.timer, displayTopologyRevision)
  useAuxiliaryWindows('event-timer', roleIds.eventTimer, displayTopologyRevision)
  useAuxiliaryWindows('backdrop', roleIds.backdrop, displayTopologyRevision)

  const externalDisplays = useMemo(() => displays
    .filter((display) => !display.isPrimary), [displays])
  const externalDisplaySignature = externalDisplays.map((display) => (
    `${display.id}:${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}@${display.scaleFactor}`
  )).join('|')
  const hasInformationOutput = informationMedia !== null && roleIds.info.length > 0
  const informationSourceIdentity = informationMedia?.type === 'capture'
    ? captureSourceIdentity(informationMedia.capture)
    : null
  const informationTitles = informationSourceIdentity
    ? captureTitlesOutputs[informationSourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : DEFAULT_BROADCAST_TITLES_OUTPUT
  const hasTimerOutput = timerOutputVisible && timerDuration > 0 && roleIds.timer.length > 0
  const hasEventTimerOutput = eventTimerOutput?.live === true && roleIds.eventTimer.length > 0
  const taskbarSuppressionActive =
    externalDisplays.length > 0 && (
      backdropImage !== null ||
      activeFile !== null ||
      isPresentationWindowOpen ||
      hasInformationOutput ||
      hasTimerOutput ||
      hasEventTimerOutput
    )
  const taskbarOutputPhase = backdropImage && !activeFile
    ? 'idle-backdrop'
    : activeFile
      ? `live-${activeFile.type}`
      : hasInformationOutput
        ? 'information'
        : hasTimerOutput
          ? 'timer'
          : hasEventTimerOutput
            ? 'event-timer'
            : isPresentationWindowOpen
              ? 'program-window'
              : 'none'

  useEffect(() => {
    const revision = ++taskbarSyncRevisionRef.current
    // Serialize PowerShell taskbar operations. If the operator exits while a
    // hide request is still running, the queued show request must always be
    // the final operation so Windows is restored reliably.
    taskbarSyncChainRef.current = taskbarSyncChainRef.current
      .catch(() => {})
      .then(async () => {
        if (revision !== taskbarSyncRevisionRef.current) return
        if (!taskbarSuppressionActive) {
          // During a native TAKE Windows can briefly report no external display
          // or the renderer can pass through an empty activeFile state. Never
          // turn that transient frame into a global taskbar restore over the
          // live program output; wait for the topology/output state to settle.
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (revision !== taskbarSyncRevisionRef.current) return
          const latest = useAppStore.getState()
          const latestExternalDisplays = latest.displays.filter((display) => !display.isPrimary)
          if (latestExternalDisplays.length === 0) return
          const stillNeedsSuppression = latest.backdropImage !== null ||
            latest.activeFile !== null ||
            latest.isPresentationWindowOpen ||
            latest.informationMedia !== null ||
            (latest.timerOutputVisible && latest.timerDuration > 0) ||
            latest.eventTimerOutput?.live === true
          if (stillNeedsSuppression) {
            for (const display of latestExternalDisplays) {
              if (revision !== taskbarSyncRevisionRef.current) return
              await window.api.hideTaskbar(display.bounds)
            }
            return
          }
          await window.api.showTaskbar()
          return
        }
        // A selected backdrop is the idle output of every external display,
        // regardless of its assigned role. Hide every secondary taskbar so it
        // cannot sit over the backdrop, speaker view or independent media.
        for (const display of externalDisplays) {
          if (revision !== taskbarSyncRevisionRef.current) return
          await window.api.hideTaskbar(display.bounds)
        }
      })
  }, [displayTopologyRevision, externalDisplaySignature, taskbarOutputPhase, taskbarSuppressionActive])

  useEffect(() => window.api.on('event-timer-ready', (...args: unknown[]) => {
    const data = args[0] as { displayId?: number } | undefined
    const state = useAppStore.getState()
    const current = state.eventTimerOutput || { ...state.eventTimer, running: false, live: false }
    window.api.dbgLog(`event timer ready acknowledged display=${data?.displayId ?? 'unknown'} live=${current.live}`)
    window.api.sendToAuxiliary('event-timer', 'event-timer-state', {
      ...current,
      fallbackBackdropImage: state.backdropImage
    } satisfies EventTimerDisplayState)
  }), [])

  useEffect(() => window.api.on('program-mirror-state-ready', (...args: unknown[]) => {
    const data = args[0] as { displayId?: number | null } | undefined
    window.api.dbgLog(`program mirror state listener ready display=${data?.displayId ?? 'unknown'}`)
    // The auxiliary renderer installs its React listener after did-finish-load.
    // Re-send a fresh snapshot now so it cannot miss main's earlier cache replay.
    sendProgramMirrorState(useAppStore.getState())
  }), [])

  useEffect(() => window.api.on('information-state-ready', (...args: unknown[]) => {
    const data = args[0] as { displayId?: number | null } | undefined
    window.api.dbgLog(`information display state listener ready display=${data?.displayId ?? 'unknown'}`)
    window.api.sendToAuxiliary('info', 'information-state', currentInformationDisplayState())
    window.api.sendToAuxiliary('info', 'information-titles-update', currentInformationTitlesState())
  }), [])

  useEffect(() => window.api.on('timer-state-ready', (...args: unknown[]) => {
    const data = args[0] as { displayId?: number | null } | undefined
    const state = useAppStore.getState()
    window.api.dbgLog(`timer display state listener ready display=${data?.displayId ?? 'unknown'}`)
    window.api.sendToAuxiliary('timer', 'information-state', {
      media: null,
      displayTimer: state.timerOutputVisible && state.timerDuration > 0,
      backdropImage: state.backdropImage,
      titleSourceIdentity: null
    } satisfies InformationDisplayState)
    window.api.sendToAuxiliary('timer', 'timer-update', currentTimerDisplayState())
  }), [])

  useEffect(() => window.api.on('speaker-state-ready', (...args: unknown[]) => {
    const data = args[0] as { displayId?: number | null } | undefined
    window.api.dbgLog(`speaker display state listener ready display=${data?.displayId ?? 'unknown'}`)
    // did-finish-load can happen before SpeakerDisplay installs its React IPC
    // listener. Re-send the complete current slide after that listener is ready.
    window.api.sendToAuxiliary(
      'speaker',
      'speaker-state',
      currentSpeakerDisplayState(useAppStore.getState())
    )
  }), [])

  useEffect(() => window.api.on('information-video-ended', (...args: unknown[]) => {
    const ended = args[0] as { path?: string; currentTime?: number; duration?: number } | undefined
    const media = useAppStore.getState().informationMedia
    if (media?.type === 'video' && media.playing && (!ended?.path || ended.path === media.path)) {
      const duration = Number.isFinite(ended?.duration)
        ? Math.max(0, ended?.duration as number)
        : media.duration || 0
      setInformationMedia({
        ...media,
        playing: false,
        currentTime: duration || media.currentTime || 0,
        duration
      })
    }
  }), [setInformationMedia])

  useEffect(() => window.api.on('information-video-state', (...args: unknown[]) => {
    const update = args[0] as { path?: string; currentTime?: number; duration?: number }
    const media = useAppStore.getState().informationMedia
    if (media?.type !== 'video' || !update || update.path !== media.path) return
    const currentTime = Number.isFinite(update.currentTime)
      ? Math.max(0, update.currentTime as number)
      : media.currentTime || 0
    const duration = Number.isFinite(update.duration)
      ? Math.max(0, update.duration as number)
      : media.duration || 0
    if (
      Math.abs((media.currentTime || 0) - currentTime) < 0.05 &&
      Math.abs((media.duration || 0) - duration) < 0.05
    ) return
    setInformationMedia({ ...media, currentTime, duration })
  }), [setInformationMedia])

  useEffect(() => {
    sendProgramMirrorState(useAppStore.getState())
  }, [
    activeFile,
    backdropImage,
    captureTitlesOutputs,
    currentSlide,
    displays,
    isPlaying,
    isPresentationWindowOpen,
    pptxAspectRatios,
    programScene,
    selectedDisplayId,
    videoLoopTrack,
    videoPlayback
  ])

  useEffect(() => {
    let cancelled = false
    const sync = async (): Promise<void> => {
      // Do not touch the PowerPoint COM queue when no speaker display exists.
      // More importantly, never let a notes request start ahead of a TAKE:
      // opening/closing a temporary Office session can otherwise delay the
      // actual slideshow by several seconds.
      if (roleIds.speaker.length === 0) return
      const baseState = currentSpeakerDisplayState(useAppStore.getState())
      if (!baseState.active || !activeFile) {
        window.api.sendToAuxiliary('speaker', 'speaker-state', baseState)
        return
      }

      if (activeFile.type !== 'presentation') {
        window.api.sendToAuxiliary('speaker', 'speaker-state', baseState)
        return
      }

      const safeCurrent = baseState.currentSlide
      const cacheKey = `${activeFile.path}|${safeCurrent}`
      const cachedNotes = notesCache.get(cacheKey)
      window.api.sendToAuxiliary('speaker', 'speaker-state', baseState)
      if (cachedNotes !== undefined) return

      await waitForNavigationTransitionEnd()
      if (cancelled) return
      const latest = useAppStore.getState()
      if (
        latest.activeFile?.path !== activeFile.path ||
        latest.currentSlide !== safeCurrent ||
        !latest.displays.some((display) => (
          !display.isPrimary && latest.displayAssignments[String(display.id)] === 'speaker'
        ))
      ) return
      const notes = await getSlideNotes(activeFile.path, safeCurrent)
      if (cancelled) return
      notesCache.set(cacheKey, notes)
      window.api.sendToAuxiliary('speaker', 'speaker-state', { ...baseState, notes })
    }

    void sync()
    return () => { cancelled = true }
  }, [
    activeFile,
    backdropImage,
    currentSlide,
    pptxSlidesMap,
    pptxThumbnailsMap,
    roleIds.speaker,
    totalSlides
  ])

  useEffect(() => {
    window.api.sendToAuxiliary('backdrop', 'backdrop-state', { backdropImage })
    window.api.sendToAuxiliary('info', 'information-state', currentInformationDisplayState())
    window.api.sendToAuxiliary('timer', 'information-state', {
      media: null,
      displayTimer: timerOutputVisible && timerDuration > 0,
      backdropImage,
      titleSourceIdentity: null
    } satisfies InformationDisplayState)
  }, [backdropImage, informationMedia, informationTitles, timerDuration, timerOutputVisible])

  useEffect(() => {
    const titlesState = currentInformationTitlesState()
    window.api.sendToAuxiliary('info', 'information-titles-update', titlesState)
    window.api.dbgLog(
      `information titles sent source=${titlesState.titleSourceIdentity ? 'set' : 'none'} ` +
      `speaker=${titlesState.titles?.speakerVisible === true} event=${titlesState.titles?.eventVisible === true}`
    )
  }, [informationSourceIdentity, informationTitles])

  useEffect(() => {
    window.api.sendToAuxiliary('timer', 'timer-update', currentTimerDisplayState())
  }, [
    timerDuration,
    timerOvertimeTextColor,
    timerRemaining,
    timerRunning,
    timerTextColor,
    timerTextOpacity,
    timerWarningTextColor
  ])

  useEffect(() => {
    window.api.sendToAuxiliary(
      'event-timer',
      'event-timer-state',
      {
        ...(eventTimerOutput || { ...eventTimer, running: false, live: false }),
        fallbackBackdropImage: backdropImage
      } satisfies EventTimerDisplayState
    )
  }, [backdropImage, eventTimer, eventTimerOutput])

  return null
}
