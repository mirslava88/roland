// Deliberately independent of the application store and Electron IPC.
export const ONBOARDING_KEY = 'pdm-introduction-v5'
export const ONBOARDING_EVENT = 'pdm-open-introduction'
export const LAST_TRAINING_STEP = 31
export interface IntroductionProgress { status: 'new' | 'paused' | 'skipped' | 'completed'; step: number }
export function readIntroduction(storage: Pick<Storage, 'getItem'>): IntroductionProgress {
  try {
    const value = JSON.parse(storage.getItem(ONBOARDING_KEY) || 'null')
    if (value && ['paused', 'skipped', 'completed'].includes(value.status)) {
      return { status: value.status, step: Number.isInteger(value.step) ? Math.max(0, Math.min(LAST_TRAINING_STEP, value.step)) : 0 }
    }
  } catch { /* Unavailable or malformed storage must not break startup. */ }
  return { status: 'new', step: 0 }
}
export function saveIntroduction(storage: Pick<Storage, 'setItem'>, progress: IntroductionProgress): void {
  try { storage.setItem(ONBOARDING_KEY, JSON.stringify(progress)) } catch { /* Session still works. */ }
}
export function isIntroductionOpen(): boolean {
  return !!document.querySelector('[data-pdm-onboarding]')
}
export function openIntroduction(): void { window.dispatchEvent(new Event(ONBOARDING_EVENT)) }
