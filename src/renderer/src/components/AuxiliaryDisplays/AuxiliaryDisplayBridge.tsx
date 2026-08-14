import { useEffect, useMemo, useRef } from 'react'
import { useAppStore, type DisplayOutputMode } from '../../stores/useAppStore'

const notesCache = new Map<string, string>()

function sendProgramMirrorState(state: ReturnType<typeof useAppStore.getState>): void {
  const {
    activeFile,
    backdropImage,
    currentSlide,
    displays,
    isPlaying,
    isPresentationWindowOpen,
    pptxAspectRatios,
    selectedDisplayId,
    videoLoopTrack,
    videoPlayback
  } = state
  const sourceDisplay = displays.find((display) => display.id === selectedDisplayId)
  const presentationAspectRatio = activeFile?.type === 'presentation'
    ? pptxAspectRatios[activeFile.path] ?? null
    : null
  const playback = activeFile?.type === 'video'
    ? videoPlayback[activeFile.path]
    : undefined
  let directContent: ProgramDirectContent | null = null
  if (activeFile?.type === 'pdf') {
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
    backdropImage
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
  setDisplayAssignment: (displayId: number, mode: DisplayOutputMode) => void
): void {
  const signature = ids.join(',')
  useEffect(() => {
    let cancelled = false
    const reconcile = async (): Promise<void> => {
      await window.api.closeAuxiliaryWindow(role)
      for (const displayId of ids) {
        if (cancelled) return
        const opened = await window.api.openAuxiliaryWindow(role, displayId)
        // A newer role/primary-display reconciliation may have replaced this
        // run while the native fullscreen window was opening. Never let a
        // stale failure turn the newly assigned program display back to Off.
        if (cancelled) return
        if (!opened.success) {
          window.api.dbgLog(`${role} display open failed id=${displayId}: ${opened.error || 'unknown error'}`)
          setDisplayAssignment(displayId, 'off')
        }
      }
    }
    void reconcile()
    return () => { cancelled = true }
  }, [role, setDisplayAssignment, signature])
}

export function AuxiliaryDisplayBridge(): null {
  const taskbarSyncChainRef = useRef<Promise<void>>(Promise.resolve())
  const taskbarSyncRevisionRef = useRef(0)
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
    backdropImage,
    videoLoopTrack,
    videoPlayback,
    timerRemaining,
    timerRunning,
    timerDuration,
    timerTextColor,
    timerWarningTextColor,
    timerOvertimeTextColor,
    timerTextOpacity,
    eventTimer,
    eventTimerOutput,
    setDisplayAssignment,
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

  useAuxiliaryWindows('mirror', roleIds.mirror, setDisplayAssignment)
  useAuxiliaryWindows('speaker', roleIds.speaker, setDisplayAssignment)
  useAuxiliaryWindows('info', roleIds.info, setDisplayAssignment)
  useAuxiliaryWindows('timer', roleIds.timer, setDisplayAssignment)
  useAuxiliaryWindows('event-timer', roleIds.eventTimer, setDisplayAssignment)
  useAuxiliaryWindows('backdrop', roleIds.backdrop, setDisplayAssignment)

  const externalDisplays = useMemo(() => displays
    .filter((display) => !display.isPrimary), [displays])
  const externalDisplaySignature = externalDisplays.map((display) => (
    `${display.id}:${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}@${display.scaleFactor}`
  )).join('|')
  const hasInformationOutput = informationMedia !== null &&
    Object.values(displayAssignments).includes('information')
  const hasTimerOutput = timerDuration > 0 &&
    Object.values(displayAssignments).includes('timer')
  const hasEventTimerOutput = eventTimerOutput?.live === true &&
    Object.values(displayAssignments).includes('event-timer')
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
  }, [externalDisplaySignature, taskbarOutputPhase, taskbarSuppressionActive])

  useEffect(() => window.api.on('auxiliary-window-closed', (...args: unknown[]) => {
    const data = args[0] as { role?: AuxiliaryDisplayRole; displayId?: number }
    if (typeof data.displayId === 'number') setDisplayAssignment(data.displayId, 'off')
  }), [setDisplayAssignment])

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
    currentSlide,
    displays,
    isPlaying,
    isPresentationWindowOpen,
    pptxAspectRatios,
    selectedDisplayId,
    videoLoopTrack,
    videoPlayback
  ])

  useEffect(() => {
    let cancelled = false
    const sync = async (): Promise<void> => {
      const supported = activeFile?.type === 'presentation' || activeFile?.type === 'pdf'
      if (!activeFile || !supported) {
        window.api.sendToAuxiliary('speaker', 'speaker-state', {
          active: false,
          fileType: null,
          filePath: null,
          fileName: '',
          currentSlide: 1,
          totalSlides: 0,
          notes: '',
          backdropImage
        } satisfies SpeakerDisplayState)
        return
      }

      const slideImages = activeFile.type === 'presentation'
        ? pptxSlidesMap[activeFile.path] || pptxThumbnailsMap[activeFile.path] || []
        : []
      const knownTotal = Math.max(totalSlides, slideImages.length)
      const safeCurrent = Math.max(1, knownTotal > 0 ? Math.min(currentSlide, knownTotal) : currentSlide)
      const baseState: SpeakerDisplayState = {
        active: true,
        fileType: activeFile.type === 'presentation' ? 'presentation' : 'pdf',
        filePath: activeFile.path,
        fileName: activeFile.name,
        currentSlide: safeCurrent,
        totalSlides: knownTotal,
        currentImagePath: slideImages[safeCurrent - 1] || null,
        nextImagePath: safeCurrent < knownTotal ? slideImages[safeCurrent] || null : null,
        notes: '',
        backdropImage
      }

      if (activeFile.type !== 'presentation') {
        window.api.sendToAuxiliary('speaker', 'speaker-state', baseState)
        return
      }

      const cacheKey = `${activeFile.path}|${safeCurrent}`
      const cachedNotes = notesCache.get(cacheKey)
      window.api.sendToAuxiliary('speaker', 'speaker-state', {
        ...baseState,
        notes: cachedNotes || ''
      })
      if (cachedNotes !== undefined) return

      const notesResult = await window.api.getPptxSlideNotes(activeFile.path, safeCurrent)
      if (cancelled) return
      const latest = useAppStore.getState()
      if (
        latest.activeFile?.path !== activeFile.path ||
        latest.currentSlide !== safeCurrent ||
        !Object.values(latest.displayAssignments).includes('speaker')
      ) return
      const notes = notesResult.success ? notesResult.notes || '' : ''
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
    totalSlides
  ])

  useEffect(() => {
    window.api.sendToAuxiliary('backdrop', 'backdrop-state', { backdropImage })
    window.api.sendToAuxiliary('info', 'information-state', {
      media: informationMedia,
      displayTimer: false,
      backdropImage
    } satisfies InformationDisplayState)
    window.api.sendToAuxiliary('timer', 'information-state', {
      media: null,
      displayTimer: timerDuration > 0,
      backdropImage
    } satisfies InformationDisplayState)
  }, [backdropImage, informationMedia, timerDuration])

  useEffect(() => {
    const timerState = {
      remaining: timerRemaining,
      running: timerRunning,
      duration: timerDuration,
      textColor: timerTextColor,
      warningTextColor: timerWarningTextColor,
      overtimeTextColor: timerOvertimeTextColor,
      textOpacity: timerTextOpacity
    } satisfies TimerDisplayState
    window.api.sendToAuxiliary('timer', 'timer-update', timerState)
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
