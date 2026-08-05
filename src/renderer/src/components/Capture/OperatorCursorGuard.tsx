import { useEffect, useRef } from 'react'

interface OperatorCursorGuardProps {
  enabled: boolean
}

type ProxyCursorShape = 'arrow' | 'pointer' | 'text'

// Rasterized from the standard Windows Aero cursor resources. Keeping these
// as DOM images (instead of CSS cursor URLs) is intentional: Chromium's
// window-capture backend can composite a native/CSS cursor into the captured
// application, while this operator-only layer remains inside PDM.
const WINDOWS_CURSOR_IMAGES: Record<ProxyCursorShape, string> = {
  arrow: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADjSURBVGhD7dPBCoJAFIVhx3Shpfj+r1HLVu56AWkrbaSVkFDRYuIMKcNg1s574XwgDMLA/Z0xMqaweV7YSCsEbJJSbwQCQG3EGKA2wg9QGREGqIuYCwA1Ed8CQEXEUsDj+ZIfsRQAfX+THfErALruKjfinwBo24uLCPevLgwYhvu0xsDhE+5fnR+A4U1U2v3hOAVkmcChfWPAODzueRyX7h2uDdbhHlEQ4A+Pd0lS2bo+uQisRZ8Crok/PPin0DRn+acwB18ew7t/QWPA7nMKaVrZreQrRERERERERERERET6vAEH+ndgRhLnxwAAAABJRU5ErkJggg==',
  pointer: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAH4SURBVGhD7ZixSxxREIftz/f27d7KJRe50wMFIwnhREgTkUQ0kkLSCP4dphCbNEHSCqZLLBQtDGlSWIXIEcEgFleoKCmFI4fVBeVQDibMyC57Q4xn43sm88HCcMs+ft/jHTO7bW1/QKsQjJ8HY3KgVRr4fefB8KXSFqyvfyEJft95/HQPNBoNODs7h0y2//YJBGEvRGDN7zvPPydgTCddSvl06XbfbSkusPbxM6ysfiKJ4WcvYWh4AjwvQyJOynCBZF2v1+HoqAJ+UCCRC5k7bknw0BH5wkDT7ycnp1Cp/CQZvoZVWhHgMnwNqyRDYx+IGHw8Fte3RgCPSESt9iuuv25sxrVVAa1D8P0c7bTnZSlIUqAVrApgeNxN3N2Z2TcQZvqazn0rWBUwQR6+bW7HYXCIKw6ONAW8CqsCngrh/oMnUK0ex4GSdStYFUCwEY2/mKLp87rgMzi98jVvHGOyMP3qNc93JVFX5utZAWedpeU1nvGv4JyEz/G1rICT5t3Oh3Bw8IPnvJTR55NuDXRaZ2hASzaty3i/uAKeuedO+AhsaI+KT6Fc3uWZCXzdnHs7Tz1Dtxv3BBCtO+g4YXPb+r4De/uH1CMW3n2gdwL806uUdjN8hEopwCNlgi4wQTd9avEwuHLozAuCIAiCIAiCIAiCIAj/Jb8BInhLfVqoKT8AAAAASUVORK5CYII=',
  text: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABiSURBVGhD7dBBCsAgDARA///pFmotKnptIsyAByPCbkoB4C/XZDdL6w34nc09r3HXNfxs/pNWX2B+O4IC0RSIpkA0BaIpEO3IAk/azmKUu0wL3c7mnte46xp2NQMAAAAgvRsutRD+04i4HAAAAABJRU5ErkJggg=='
}

function getProxyCursorShape(target: EventTarget | null): ProxyCursorShape {
  if (!(target instanceof Element)) return 'arrow'

  if (target.closest('textarea, [contenteditable="true"], input:not([type]), input[type="text"], input[type="number"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="tel"]')) {
    return 'text'
  }

  if (target.closest('a[href], .cursor-pointer, .cursor-grab, .cursor-grabbing')) {
    return 'pointer'
  }

  return 'arrow'
}

const CURSOR_HOTSPOTS: Record<ProxyCursorShape, readonly [number, number]> = {
  arrow: [0, 0],
  pointer: [6, 0],
  text: [15, 16]
}

/**
 * Chromium's Windows window-capture backend composites the system cursor by
 * screen coordinates. That makes the cursor visible in a captured window even
 * while the operator is actually working in PDM above it.
 *
 * While PDM has focus, hide the system cursor in this renderer and draw an
 * operator-only DOM cursor instead. The DOM cursor is not part of the external
 * window's captured surface. As soon as PDM loses focus, the native cursor is
 * restored so it is visible when the operator works in the demonstrated app.
 */
export function OperatorCursorGuard({ enabled }: OperatorCursorGuardProps): JSX.Element {
  const cursorRef = useRef<HTMLDivElement>(null)
  const enabledRef = useRef(enabled)
  const focusedRef = useRef(document.hasFocus())
  const pointerInsideRef = useRef(false)
  const applyRef = useRef<() => void>(() => undefined)

  enabledRef.current = enabled

  useEffect(() => {
    let guardWasActive = false

    const apply = (): void => {
      const guardActive = enabledRef.current && focusedRef.current
      document.documentElement.classList.toggle('pdm-window-cursor-guard', guardActive)

      if (cursorRef.current) {
        cursorRef.current.dataset.visible = String(guardActive && pointerInsideRef.current)
      }

      if (guardActive !== guardWasActive) {
        guardWasActive = guardActive
        window.api.dbgLog(
          `OperatorCursorGuard: native cursor ${guardActive ? 'hidden in PDM' : 'restored'}`
        )
      }
    }

    applyRef.current = apply

    const moveProxy = (event: PointerEvent): void => {
      pointerInsideRef.current = true
      if (cursorRef.current) {
        const shape = getProxyCursorShape(event.target)
        const [hotspotX, hotspotY] = CURSOR_HOTSPOTS[shape]
        cursorRef.current.dataset.shape = shape
        cursorRef.current.style.transform = `translate3d(${event.clientX - hotspotX}px, ${event.clientY - hotspotY}px, 0)`
      }
      apply()
    }

    const handleMouseOut = (event: MouseEvent): void => {
      if (event.relatedTarget !== null) return
      pointerInsideRef.current = false
      apply()
    }

    const handleFocus = (): void => {
      focusedRef.current = true
      apply()
    }

    const handleBlur = (): void => {
      focusedRef.current = false
      apply()
    }

    window.addEventListener('pointermove', moveProxy, { passive: true })
    window.addEventListener('pointerdown', moveProxy, { passive: true })
    window.addEventListener('mouseout', handleMouseOut)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    apply()

    return () => {
      window.removeEventListener('pointermove', moveProxy)
      window.removeEventListener('pointerdown', moveProxy)
      window.removeEventListener('mouseout', handleMouseOut)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      document.documentElement.classList.remove('pdm-window-cursor-guard')
      if (cursorRef.current) cursorRef.current.dataset.visible = 'false'
      applyRef.current = () => undefined
    }
  }, [])

  useEffect(() => {
    applyRef.current()
  }, [enabled])

  return (
    <div
      ref={cursorRef}
      className="pdm-operator-cursor-proxy"
      data-visible="false"
      data-shape="arrow"
      aria-hidden="true"
    >
      <img className="pdm-proxy-arrow" src={WINDOWS_CURSOR_IMAGES.arrow} alt="" draggable={false} />
      <img className="pdm-proxy-pointer" src={WINDOWS_CURSOR_IMAGES.pointer} alt="" draggable={false} />
      <img className="pdm-proxy-text" src={WINDOWS_CURSOR_IMAGES.text} alt="" draggable={false} />
    </div>
  )
}
