import { useEffect, useState } from 'react'

// The macOS green button enters simple fullscreen so the operator window stays
// in the same Space as Keynote. Reveal an exit control only at the top edge.
export function FullscreenExitControl(): JSX.Element | null {
  const [fullscreen, setFullscreen] = useState(false)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (window.api.platform !== 'darwin') return
    let active = true
    let eventRevision = 0
    const unsubscribe = window.api.on('control-fullscreen-changed', (value) => {
      eventRevision++
      setFullscreen(value === true)
      setHovered(false)
    })
    const initialRevision = eventRevision
    void window.api.getControlFullscreen().then((value) => {
      if (active && eventRevision === initialRevision) setFullscreen(value)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  if (window.api.platform !== 'darwin' || !fullscreen) return null

  return (
    <div
      className={`fixed inset-x-0 top-0 z-[200] flex justify-center ${hovered ? 'h-16' : 'h-4'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {hovered && (
        <button
          type="button"
          onClick={() => { void window.api.toggleControlFullscreen() }}
          className="absolute top-2 rounded-lg border border-gray-600 bg-surface-300 px-4 py-2 text-sm font-medium text-white shadow-xl hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-blue-400"
          aria-label="Выйти из полноэкранного режима"
          title="Выйти из полноэкранного режима"
        >
          ⤢ Выйти из полного экрана
        </button>
      )}
    </div>
  )
}
