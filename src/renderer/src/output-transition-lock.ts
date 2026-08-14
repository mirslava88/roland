let outputTransitionTail: Promise<void> = Promise.resolve()
let outputTransitionSequence = 0

/**
 * Serializes operations which mutate the shared program output, PowerPoint and
 * transition overlay. TAKE and display routing must never run concurrently.
 */
export async function acquireOutputTransition(label: string): Promise<() => void> {
  const sequence = ++outputTransitionSequence
  let unlockGate = (): void => {}
  const gate = new Promise<void>((resolve) => { unlockGate = resolve })
  const previous = outputTransitionTail.catch(() => {})
  outputTransitionTail = previous.then(() => gate)

  await previous
  try { window.api.dbgLog(`output transition lock acquired seq=${sequence} label=${label}`) } catch { /* renderer is closing */ }
  let released = false
  return () => {
    if (released) return
    released = true
    unlockGate()
    try { window.api.dbgLog(`output transition lock released seq=${sequence} label=${label}`) } catch { /* renderer is closing */ }
  }
}
