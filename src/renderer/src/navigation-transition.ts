export type NavigationDirection = 'next' | 'prev'
export type NavigationRequest =
  | { kind: 'relative'; direction: NavigationDirection }
  | { kind: 'absolute'; slide: number }

let transitionActive = false
let queuedRequests: NavigationRequest[] = []
const transitionEndWaiters = new Set<() => void>()

function describeRequest(request: NavigationRequest): string {
  return request.kind === 'relative' ? request.direction : `goto:${request.slide}`
}

export function beginNavigationTransition(): void {
  transitionActive = true
  queuedRequests = []
  window.api.dbgLog('NavigationTransition: BEGIN')
}

export function queueNavigationDuringTransition(direction: NavigationDirection): boolean {
  if (!transitionActive) return false
  queuedRequests.push({ kind: 'relative', direction })
  window.api.dbgLog(
    `NavigationTransition: queued ${direction}, count=${queuedRequests.length}`
  )
  return true
}

export function queueAbsoluteNavigationDuringTransition(slide: number): boolean {
  if (!transitionActive) return false
  queuedRequests.push({ kind: 'absolute', slide })
  window.api.dbgLog(
    `NavigationTransition: queued goto:${slide}, count=${queuedRequests.length}`
  )
  return true
}

export function finishNavigationTransition(): NavigationRequest[] {
  const queued = queuedRequests
  transitionActive = false
  queuedRequests = []
  window.api.dbgLog(
    `NavigationTransition: END queued=${queued.map(describeRequest).join(',') || 'none'}`
  )
  for (const resolve of transitionEndWaiters) resolve()
  transitionEndWaiters.clear()
  return queued
}

export function waitForNavigationTransitionEnd(): Promise<void> {
  if (!transitionActive) return Promise.resolve()
  return new Promise<void>((resolve) => transitionEndWaiters.add(resolve))
}

export function drainNavigationTransition(): NavigationRequest[] {
  const queued = queuedRequests
  queuedRequests = []
  if (queued.length > 0) {
    window.api.dbgLog(
      `NavigationTransition: DRAIN queued=${queued.map(describeRequest).join(',')}`
    )
  }
  return queued
}

export function pendingNavigationCount(): number {
  return queuedRequests.length
}
