import { screen } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { diagnosticLog, formatDiagnosticError } from './diagnostic-log'
import { scriptPath } from './paths'

const execFileAsync = promisify(execFile)
let taskbarOperationTail: Promise<void> = Promise.resolve()
let finalRestoreRequested = false
let topologyRevision = 0
const hiddenTaskbarDisplays = new Map<number, string>()

export function invalidateTaskbarVisibilityCache(reason: string): void {
  topologyRevision++
  if (hiddenTaskbarDisplays.size === 0) return
  hiddenTaskbarDisplays.clear()
  diagnosticLog('display', `taskbar visibility cache invalidated reason=${reason}`)
}

function enqueueTaskbarOperation(operation: () => Promise<void>): Promise<void> {
  const next = taskbarOperationTail.then(operation, operation)
  taskbarOperationTail = next.catch(() => {})
  return next
}

export function hideTaskbarForDisplay(
  displayBounds: { x: number; y: number; width: number; height: number },
  controlWindowBounds?: { x: number; y: number; width: number; height: number }
): Promise<void> {
  if (process.platform !== 'win32' || finalRestoreRequested) return Promise.resolve()
  return enqueueTaskbarOperation(async () => {
    // A final restore requested while this operation was queued wins. This
    // prevents a late renderer IPC from hiding the shell after PDM has quit.
    if (finalRestoreRequested) return
    const revision = topologyRevision
    try {
      const targetDisplay = screen.getDisplayMatching(displayBounds)
      const physicalBounds = screen.dipToScreenRect(null, targetDisplay.bounds)
      const physicalBoundsKey = [
        physicalBounds.x,
        physicalBounds.y,
        physicalBounds.width,
        physicalBounds.height
      ].join(',')
      const protectedDisplay = controlWindowBounds
        ? screen.getDisplayMatching(controlWindowBounds)
        : screen.getPrimaryDisplay()
      const protectedPhysicalBounds = screen.dipToScreenRect(null, protectedDisplay.bounds)
      const primaryDisplay = screen.getPrimaryDisplay()
      if (targetDisplay.id === primaryDisplay.id || targetDisplay.id === protectedDisplay.id) {
        diagnosticLog(
          'display',
          `hide taskbar skipped protected display=${targetDisplay.id} ` +
          `primary=${primaryDisplay.id} control=${protectedDisplay.id}`
        )
        // Repair a taskbar that an older/stale request may already have hidden.
        await execFileAsync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NoProfile',
          '-File', scriptPath('manage-window.ps1'),
          '-Action', 'show-taskbar-on-display',
          '-X', String(physicalBounds.x),
          '-Y', String(physicalBounds.y),
          '-Width', String(physicalBounds.width),
          '-Height', String(physicalBounds.height)
        ], { timeout: 5000 })
        hiddenTaskbarDisplays.delete(targetDisplay.id)
        return
      }
      if (hiddenTaskbarDisplays.get(targetDisplay.id) === physicalBoundsKey) {
        diagnosticLog('display', `hide taskbar already applied display=${targetDisplay.id}`)
        return
      }
      diagnosticLog(
        'display',
        `hide taskbar display=${targetDisplay.id} dip=${JSON.stringify(targetDisplay.bounds)} ` +
        `physical=${JSON.stringify(physicalBounds)} protectedControl=${protectedDisplay.id}`
      )
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath('manage-window.ps1'),
        '-Action', 'hide-taskbar',
        '-X', String(physicalBounds.x),
        '-Y', String(physicalBounds.y),
        '-Width', String(physicalBounds.width),
        '-Height', String(physicalBounds.height),
        '-ProtectedX', String(protectedPhysicalBounds.x),
        '-ProtectedY', String(protectedPhysicalBounds.y),
        '-ProtectedWidth', String(protectedPhysicalBounds.width),
        '-ProtectedHeight', String(protectedPhysicalBounds.height)
      ], { timeout: 5000 })
      if (revision === topologyRevision && !finalRestoreRequested) {
        hiddenTaskbarDisplays.set(targetDisplay.id, physicalBoundsKey)
      }
    } catch (error) {
      diagnosticLog('display', `hide taskbar failed ${formatDiagnosticError(error)}`)
    }
  })
}

export function showAllTaskbars(final = false): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  if (final) finalRestoreRequested = true
  return enqueueTaskbarOperation(async () => {
    try {
      await execFileAsync('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', scriptPath('manage-window.ps1'),
        '-Action', 'show-taskbar'
      ], { timeout: 5000 })
      hiddenTaskbarDisplays.clear()
      diagnosticLog('display', `taskbars restored final=${finalRestoreRequested}`)
    } catch (error) {
      diagnosticLog('display', `show taskbar failed ${formatDiagnosticError(error)}`)
    }
  })
}
