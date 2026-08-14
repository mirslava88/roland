import {
  useAppStore,
  type DisplayOutputMode
} from './stores/useAppStore'
import { acquireOutputTransition } from './output-transition-lock'

export interface ProgramDisplayRoutingResult {
  success: boolean
  changed: boolean
  primaryDisplayId: number | null
  error?: string
}

interface SwitchPrimaryOptions {
  force?: boolean
  previousDisplayId?: number | null
}

function waitForProgramMirror(displayId: number, sourceDisplayId: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = (): void => {}
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe()
      resolve(ready)
    }
    // A cold desktop-capture mirror needs several seconds on Windows while
    // the fullscreen renderer receives media permission and paints its first
    // frame. Four seconds expired just before the real ready signal on 4K
    // displays and exposed a black handoff.
    const timeout = setTimeout(() => finish(false), 8000)
    unsubscribe = window.api.on('program-mirror-ready', (...args: unknown[]) => {
      const data = args[0] as { displayId?: number | null; sourceDisplayId?: number | null }
      if (data.displayId === displayId && data.sourceDisplayId === sourceDisplayId) finish(true)
    })
  })
}

function sortedExternalDisplayIds(): number[] {
  return useAppStore.getState().displays
    .filter((display) => !display.isPrimary)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((display) => display.id)
}

/**
 * Moves the actual live output before changing the logical primary display.
 * Keeping this operation outside the modal makes every display-assignment UI
 * use the same ordering and prevents a selected id from getting ahead of the
 * real PowerPoint/Presentation Output window.
 */
async function switchPrimaryProgramDisplayUnlocked(
  displayId: number,
  options: SwitchPrimaryOptions = {}
): Promise<ProgramDisplayRoutingResult> {
  const initial = useAppStore.getState()
  const previousDisplayId = options.previousDisplayId === undefined
    ? initial.selectedDisplayId
    : options.previousDisplayId
  if (previousDisplayId === displayId && !options.force) {
    return { success: true, changed: false, primaryDisplayId: displayId }
  }

  const targetDisplay = initial.displays.find((display) => (
    !display.isPrimary && display.id === displayId
  ))
  if (!targetDisplay) {
    return {
      success: false,
      changed: false,
      primaryDisplayId: initial.selectedDisplayId,
      error: 'Выбранный внешний дисплей не подключён.'
    }
  }
  if (initial.displayAssignments[String(displayId)] !== 'program') {
    return {
      success: false,
      changed: false,
      primaryDisplayId: initial.selectedDisplayId,
      error: 'Сначала назначьте выбранному дисплею режим «Основной эфир».'
    }
  }

  const activeFile = initial.activeFile
  const outputIsLive = activeFile !== null || initial.isPresentationWindowOpen
  const activeExternalDocument =
    activeFile?.type === 'other' && !activeFile.isImage && !activeFile.isAudio
  const presentationWindowIsProgramOutput =
    activeFile?.type === 'pdf' ||
    activeFile?.type === 'video' ||
    activeFile?.type === 'capture' ||
    (activeFile?.type === 'other' && activeFile.isImage) ||
    (activeFile?.type === 'other' && activeFile.isAudio && initial.isPresentationWindowOpen) ||
    (activeFile === null && initial.isPresentationWindowOpen)
  const capturesTargetDisplay =
    activeFile?.type === 'capture' &&
    activeFile.capture?.captureKind === 'desktop' &&
    activeFile.capture.desktopSourceType === 'screen' &&
    activeFile.capture.desktopDisplayId === String(displayId)
  if (capturesTargetDisplay) {
    return {
      success: false,
      changed: false,
      primaryDisplayId: initial.selectedDisplayId,
      error: 'Этот монитор сейчас захватывается как источник. Назначьте главным другой монитор.'
    }
  }
  let transitionProtected = false
  let physicalOutputMoved = false
  let logicalPrimaryCommitted = false

  window.api.dbgLog(
    `primary display switch begin previous=${previousDisplayId ?? 'none'} target=${displayId} ` +
    `live=${outputIsLive} content=${activeFile?.type ?? 'none'}`
  )

  try {
    if (outputIsLive && previousDisplayId !== null && previousDisplayId !== displayId) {
      let freezeFrame: string | null = null
      let freezeImagePath: string | null = null
      if (activeFile?.type === 'presentation') {
        freezeImagePath = await window.api.snapshotSlideshow()
      } else if (activeExternalDocument) {
        // Word/Excel is a native window above the Chromium backdrop. Capturing
        // Presentation Output here would freeze only that hidden backdrop.
        freezeFrame = await window.api.captureDisplay(previousDisplayId)
      } else if (initial.isPresentationWindowOpen) {
        freezeFrame = await window.api.capturePresentationFrame()
      }
      if (!freezeFrame && !freezeImagePath) {
        freezeFrame = await window.api.captureDisplay(previousDisplayId)
      }
      if (freezeFrame || freezeImagePath) {
        await window.api.showOverlay(
          previousDisplayId,
          freezeFrame || undefined,
          freezeImagePath || undefined,
          'cover'
        )
        transitionProtected = true
      }
    }

    if (outputIsLive) {
      if (activeFile?.type === 'presentation') {
        // The persistent Chromium surface may still contain the previous PDF
        // underneath PowerPoint. Move/fullscreen that background first. Moving
        // it after the slideshow can raise it above PowerPoint and also lets a
        // delayed metrics sync target the old display. PowerPoint must be the
        // final native window placed on the new program display.
        physicalOutputMoved = true
        const presentationPlaced = await window.api.placePresentationWindow(displayId)
        if (!presentationPlaced) {
          throw new Error('Фоновое окно эфира не подготовлено на выбранном дисплее.')
        }
        // The native helper can move the slideshow before its IPC reply is
        // delivered. Treat the operation as physically attempted up front so
        // a rejection/timeout also runs the strict rollback path.
        const result = await window.api.relocatePowerPoint(displayId)
        if (!result.success) throw new Error(result.error || 'PowerPoint не перенёс эфир')
      } else if (activeExternalDocument) {
        // Keep any selected backdrop below Word/Excel: move the Chromium
        // surface first, then raise/verify the native document last.
        if (initial.isPresentationWindowOpen) {
          physicalOutputMoved = true
          const presentationPlaced = await window.api.placePresentationWindow(displayId)
          if (!presentationPlaced) {
            throw new Error('Фоновое окно эфира не перенеслось на выбранный дисплей.')
          }
        }
        // restoreExternalFile can likewise partially move a native window and
        // then fail while verifying it. A failed attempt must be rolled back.
        physicalOutputMoved = true
        const result = await window.api.restoreExternalFile(activeFile.path, targetDisplay.bounds)
        if (!result.success) throw new Error(result.error || 'Окно программы не перенеслось на выбранный дисплей')
      } else {
        if (presentationWindowIsProgramOutput) physicalOutputMoved = true
        const presentationPlaced = await window.api.placePresentationWindow(displayId)
        if (!presentationPlaced && presentationWindowIsProgramOutput) {
          throw new Error('Окно основного эфира не готово к переносу.')
        }
      }
    }

    const mirrorReady = outputIsLive && previousDisplayId !== null && previousDisplayId !== displayId
      ? waitForProgramMirror(previousDisplayId, displayId)
      : Promise.resolve(true)

    const beforeCommit = useAppStore.getState()
    if (beforeCommit.displayAssignments[String(displayId)] !== 'program') {
      throw new Error('Назначение целевого дисплея изменилось во время переноса эфира.')
    }
    beforeCommit.setSelectedDisplayId(displayId)
    if (useAppStore.getState().selectedDisplayId !== displayId) {
      throw new Error('Главный эфирный дисплей не удалось закрепить в настройках.')
    }
    logicalPrimaryCommitted = true

    const ready = await mirrorReady
    if (!ready && outputIsLive && previousDisplayId !== null) {
      window.api.dbgLog(
        `primary display switch: mirror ready timeout display=${previousDisplayId} source=${displayId}`
      )
    }
    window.api.dbgLog(
      `primary display switch complete previous=${previousDisplayId ?? 'none'} target=${displayId} mirrorReady=${ready}`
    )
    return { success: true, changed: true, primaryDisplayId: displayId }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    if (
      logicalPrimaryCommitted &&
      previousDisplayId !== null &&
      useAppStore.getState().displayAssignments[String(previousDisplayId)] === 'program'
    ) {
      useAppStore.getState().setSelectedDisplayId(previousDisplayId)
    }
    if (physicalOutputMoved && previousDisplayId !== null && previousDisplayId !== displayId) {
      const previousDisplay = useAppStore.getState().displays.find((display) => display.id === previousDisplayId)
      try {
        if (!previousDisplay) throw new Error('прежний дисплей отключён')
        if (activeFile?.type === 'presentation') {
          // Restore the background first and PowerPoint last for the same
          // z-order/last-intent guarantee used by the forward transfer.
          const presentationRolledBack = await window.api.placePresentationWindow(previousDisplayId)
          if (!presentationRolledBack) {
            throw new Error('фоновое окно эфира не вернулось на прежний дисплей')
          }
          const rollback = await window.api.relocatePowerPoint(previousDisplayId)
          if (!rollback.success) throw new Error(rollback.error || 'PowerPoint не вернулся на прежний дисплей')
        } else if (activeExternalDocument) {
          if (initial.isPresentationWindowOpen) {
            const presentationRolledBack = await window.api.placePresentationWindow(previousDisplayId)
            if (!presentationRolledBack) {
              throw new Error('фоновое окно эфира не вернулось на прежний дисплей')
            }
          }
          const rollback = await window.api.restoreExternalFile(activeFile.path, previousDisplay.bounds)
          if (!rollback.success) throw new Error(rollback.error || 'окно программы не вернулось на прежний дисплей')
        } else {
          const presentationRolledBack = await window.api.placePresentationWindow(previousDisplayId)
          if (presentationWindowIsProgramOutput && !presentationRolledBack) {
            throw new Error('окно основного эфира не вернулось на прежний дисплей')
          }
        }
        window.api.dbgLog(
          `primary display switch rollback complete target=${displayId} previous=${previousDisplayId}`
        )
      } catch (rollbackError) {
        message += ` Не удалось вернуть вывод на прежний дисплей: ${String(rollbackError)}`
        window.api.dbgLog(
          `primary display switch rollback failed target=${displayId} previous=${previousDisplayId}: ${String(rollbackError)}`
        )
      }
    }
    window.api.dbgLog(
      `primary display switch failed previous=${previousDisplayId ?? 'none'} target=${displayId}: ${message}`
    )
    return {
      success: false,
      changed: false,
      primaryDisplayId: useAppStore.getState().selectedDisplayId,
      error: message
    }
  } finally {
    if (transitionProtected) {
      try {
        await window.api.hideOverlay()
      } catch (error) {
        window.api.dbgLog(`primary display switch: overlay cleanup failed: ${String(error)}`)
      }
      useAppStore.getState().setOverlayState({ kind: 'hidden' })
    }
  }
}

export async function switchPrimaryProgramDisplay(
  displayId: number,
  options: SwitchPrimaryOptions = {}
): Promise<ProgramDisplayRoutingResult> {
  const release = await acquireOutputTransition(`display-primary:${displayId}`)
  try {
    return await switchPrimaryProgramDisplayUnlocked(displayId, options)
  } finally {
    release()
  }
}

/**
 * Changes a display role without ever allowing the store's automatic primary
 * selection to outrun the physical output. When the current primary is changed
 * to Speaker/Info/etc., an existing program mirror is promoted first.
 */
export async function setDisplayAssignmentWithProgramRouting(
  displayId: number,
  mode: DisplayOutputMode
): Promise<ProgramDisplayRoutingResult> {
  const release = await acquireOutputTransition(`display-role:${displayId}:${mode}`)
  try {
    const before = useAppStore.getState()
    const previousMode = before.displayAssignments[String(displayId)] || 'off'
    if (previousMode === mode) {
      return {
        success: true,
        changed: false,
        primaryDisplayId: before.selectedDisplayId
      }
    }

    if (before.selectedDisplayId === displayId && mode !== 'program') {
      const replacementDisplayId = sortedExternalDisplayIds().find((candidateId) => (
        candidateId !== displayId && before.displayAssignments[String(candidateId)] === 'program'
      ))
      if (replacementDisplayId !== undefined) {
        const switched = await switchPrimaryProgramDisplayUnlocked(replacementDisplayId)
        if (!switched.success) return switched
      }
    }

    const stateBeforeAssignment = useAppStore.getState()
    const primaryBeforeAssignment = stateBeforeAssignment.selectedDisplayId
    stateBeforeAssignment.setDisplayAssignment(displayId, mode)

    // If there was no program display, assigning the first one makes it primary
    // in Zustand immediately. Force the real output to follow that new id too.
    if (
      mode === 'program' &&
      primaryBeforeAssignment === null &&
      useAppStore.getState().selectedDisplayId === displayId &&
      (stateBeforeAssignment.activeFile !== null || stateBeforeAssignment.isPresentationWindowOpen)
    ) {
      const switched = await switchPrimaryProgramDisplayUnlocked(displayId, {
        force: true,
        previousDisplayId: null
      })
      if (!switched.success) {
        useAppStore.getState().setDisplayAssignment(displayId, previousMode)
        return switched
      }
    }

    return {
      success: true,
      changed: true,
      primaryDisplayId: useAppStore.getState().selectedDisplayId
    }
  } finally {
    release()
  }
}
