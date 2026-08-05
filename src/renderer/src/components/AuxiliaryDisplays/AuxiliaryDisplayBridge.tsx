import { useEffect } from 'react'
import { useAppStore } from '../../stores/useAppStore'

const notesCache = new Map<string, string>()

export function AuxiliaryDisplayBridge(): null {
  const {
    activeFile,
    currentSlide,
    totalSlides,
    pptxSlidesMap,
    pptxThumbnailsMap,
    speakerDisplayId,
    informationDisplayId,
    speakerDisplayEnabled,
    informationDisplayEnabled,
    informationMedia,
    backdropImage,
    timerRemaining,
    timerRunning,
    timerDuration,
    timerTextColor,
    timerWarningTextColor,
    timerOvertimeTextColor,
    timerTextOpacity,
    timerDisplayTarget,
    setSpeakerDisplayEnabled,
    setInformationDisplayEnabled,
    setInformationMedia
  } = useAppStore()

  useEffect(() => window.api.on('auxiliary-window-closed', (...args: unknown[]) => {
    const data = args[0] as { role?: AuxiliaryDisplayRole }
    if (data.role === 'speaker') setSpeakerDisplayEnabled(false)
    if (data.role === 'info') setInformationDisplayEnabled(false)
  }), [setInformationDisplayEnabled, setSpeakerDisplayEnabled])

  useEffect(() => window.api.on('information-video-ended', () => {
    const media = useAppStore.getState().informationMedia
    if (media?.type === 'video' && media.playing) {
      setInformationMedia({ ...media, playing: false })
    }
  }), [setInformationMedia])

  useEffect(() => {
    let cancelled = false
    if (!speakerDisplayEnabled || speakerDisplayId === null) {
      void window.api.closeAuxiliaryWindow('speaker')
      return
    }

    const sync = async (): Promise<void> => {
      const opened = await window.api.openAuxiliaryWindow('speaker', speakerDisplayId)
      if (cancelled) return
      if (!opened.success) {
        window.api.dbgLog(`speaker display open failed: ${opened.error || 'unknown error'}`)
        setSpeakerDisplayEnabled(false)
        return
      }

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
        !latest.speakerDisplayEnabled
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
    setSpeakerDisplayEnabled,
    speakerDisplayEnabled,
    speakerDisplayId,
    totalSlides
  ])

  useEffect(() => {
    let cancelled = false
    if (!informationDisplayEnabled || informationDisplayId === null) {
      void window.api.closeAuxiliaryWindow('info')
      return
    }

    const sync = async (): Promise<void> => {
      const opened = await window.api.openAuxiliaryWindow('info', informationDisplayId)
      if (cancelled) return
      if (!opened.success) {
        window.api.dbgLog(`information display open failed: ${opened.error || 'unknown error'}`)
        setInformationDisplayEnabled(false)
        return
      }
      const latest = useAppStore.getState()
      window.api.sendToAuxiliary('info', 'information-state', {
        media: latest.informationMedia,
        displayTimer: latest.timerDisplayTarget === 'information' && latest.timerDuration > 0,
        backdropImage: latest.backdropImage
      } satisfies InformationDisplayState)
      window.api.sendToAuxiliary('info', 'timer-update', {
        remaining: latest.timerRemaining,
        running: latest.timerRunning,
        duration: latest.timerDuration,
        textColor: latest.timerTextColor,
        warningTextColor: latest.timerWarningTextColor,
        overtimeTextColor: latest.timerOvertimeTextColor,
        textOpacity: latest.timerTextOpacity
      } satisfies TimerDisplayState)
    }

    void sync()
    return () => { cancelled = true }
  }, [
    informationDisplayEnabled,
    informationDisplayId,
    setInformationDisplayEnabled
  ])

  useEffect(() => {
    if (!informationDisplayEnabled) return
    window.api.sendToAuxiliary('info', 'information-state', {
      media: informationMedia,
      displayTimer: timerDisplayTarget === 'information' && timerDuration > 0,
      backdropImage
    } satisfies InformationDisplayState)
  }, [
    backdropImage,
    informationDisplayEnabled,
    informationMedia,
    timerDisplayTarget,
    timerDuration
  ])

  useEffect(() => {
    if (!informationDisplayEnabled) return
    window.api.sendToAuxiliary('info', 'timer-update', {
      remaining: timerRemaining,
      running: timerRunning,
      duration: timerDuration,
      textColor: timerTextColor,
      warningTextColor: timerWarningTextColor,
      overtimeTextColor: timerOvertimeTextColor,
      textOpacity: timerTextOpacity
    } satisfies TimerDisplayState)
  }, [
    informationDisplayEnabled,
    timerDuration,
    timerOvertimeTextColor,
    timerRemaining,
    timerRunning,
    timerTextColor,
    timerTextOpacity,
    timerWarningTextColor
  ])

  return null
}
