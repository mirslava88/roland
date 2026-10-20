import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import { dirname, resolve } from 'path'
import { keynoteNative } from './mac-native-office'
import { diagnosticLog } from './diagnostic-log'
import { MAC_KEYNOTE_REQUIRED_MESSAGE, type MacPermissionStatus, type MacPresentationSupport } from '../shared/mac-setup'

const privacyUrls = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
} as const

export function macPermissionStatus(): MacPermissionStatus {
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false)
  }
}

let screenRequest: Promise<unknown> | null = null
export async function openMacPrivacy(permission: unknown): Promise<void> {
  if (permission !== 'screen' && permission !== 'accessibility') throw new Error('Неизвестное разрешение macOS.')
  if (permission === 'accessibility') {
    // Register the current edition in TCC; macOS owns the actual consent.
    systemPreferences.isTrustedAccessibilityClient(true)
  } else if (systemPreferences.getMediaAccessStatus('screen') !== 'granted' && !screenRequest) {
    // Asking for sources registers PDM in Screen Recording. Do not wait for
    // the system consent dialog before opening its settings pane.
    screenRequest = desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .catch(error => diagnosticLog('mac-setup', `screen access request: ${String(error)}`))
      .finally(() => { screenRequest = null })
  }
  await shell.openExternal(privacyUrls[permission])
}

export async function macPresentationSupport(): Promise<MacPresentationSupport> {
  try {
    await keynoteNative(0, 'application')
    return { installed: true }
  } catch (error) {
    if (/установите Keynote/i.test(String(error))) return { installed: false, error: MAC_KEYNOTE_REQUIRED_MESSAGE }
    return { installed: false, error: `Не удалось проверить Keynote. ${String(error)}` }
  }
}

export async function requireMacKeynote(): Promise<void> {
  const support = await macPresentationSupport()
  if (!support.installed) throw new Error(support.error || MAC_KEYNOTE_REQUIRED_MESSAGE)
}

export function openKeynoteDownload(): Promise<void> {
  return shell.openExternal('https://apps.apple.com/app/keynote/id361285480?platform=mac')
}

export function showMacApplication(): void {
  shell.showItemInFolder(app.isPackaged ? resolve(dirname(process.execPath), '../..') : app.getAppPath())
}
