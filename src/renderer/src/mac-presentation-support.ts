import type { MacPresentationSupport } from '../../shared/mac-setup'

export const MAC_PRESENTATION_SETUP_EVENT = 'pdm-mac-presentation-setup'
let pending: Promise<boolean> | null = null

export function requireMacPresentationSupport(): Promise<boolean> {
  if (window.api.platform !== 'darwin' || !window.api.macSetup) return Promise.resolve(true)
  if (!pending) pending = Promise.all([
    window.api.macSetup.presentationSupport(), window.api.macSetup.permissions()
  ]).then(([support, permissions]) => {
    const ready = support.installed && permissions.screen === 'granted' && permissions.accessibility
    if (!ready) window.dispatchEvent(new CustomEvent<MacPresentationSupport>(MAC_PRESENTATION_SETUP_EVENT, { detail: support }))
    return ready
  }).catch((error: unknown) => {
    window.dispatchEvent(new CustomEvent<MacPresentationSupport>(MAC_PRESENTATION_SETUP_EVENT, {
      detail: { installed: true, error: `Не удалось проверить готовность PPTX: ${String(error)}` }
    }))
    return false
  }).finally(() => { pending = null })
  return pending
}
