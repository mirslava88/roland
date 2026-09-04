import { useEffect } from 'react'
import { hasQrData } from '../../../../shared/qr-overlay'
import { useAppStore } from '../../stores/useAppStore'
import { renderQrImage } from './qr-render'

export function QrOverlayBridge(): null {
  const config = useAppStore((state) => state.qrOverlay)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const displays = useAppStore((state) => state.displays)
  const activeFile = useAppStore((state) => state.activeFile)
  const isPresentationWindowOpen = useAppStore((state) => state.isPresentationWindowOpen)

  useEffect(() => {
    let cancelled = false
    const targetExists = displays.some((display) => !display.isPrimary && display.id === selectedDisplayId)
    const outputActive = activeFile !== null || isPresentationWindowOpen
    const visible = config.enabled && hasQrData(config) && targetExists && outputActive
    if (!visible) {
      window.api.updateQrOverlay({ visible: false })
      return
    }
    const timer = setTimeout(() => {
      void renderQrImage(config).then((imageDataUrl) => {
        if (cancelled) return
        window.api.updateQrOverlay({
          visible: true,
          displayId: selectedDisplayId,
          imageDataUrl,
          sizePercent: config.sizePercent,
          xPercent: config.xPercent,
          yPercent: config.yPercent,
          cornerStyle: config.cornerStyle
        })
      }).catch((error: unknown) => {
        window.api.dbgLog(`QR overlay generation failed: ${String(error)}`)
        if (!cancelled) window.api.updateQrOverlay({ visible: false })
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [config, selectedDisplayId, displays, activeFile, isPresentationWindowOpen])

  useEffect(() => () => window.api.updateQrOverlay({ visible: false }), [])
  return null
}
