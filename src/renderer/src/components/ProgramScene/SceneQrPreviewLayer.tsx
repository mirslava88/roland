import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { hasQrData, type QrOverlayConfig } from '../../../../shared/qr-overlay'
import { renderQrImage } from '../QrOverlay/qr-render'

interface Props {
  config: QrOverlayConfig
  outputWidth: number
  outputHeight: number
  shown?: boolean
  interactive?: boolean
  selected?: boolean
  onSelect?: () => void
  onChange?: (patch: Partial<QrOverlayConfig>) => void
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

interface InlineQrDescriptionProps {
  text: string
  interactive: boolean
  className?: string
  style?: CSSProperties
  onFocus?: () => void
  onTextChange?: (text: string) => void
}

export function InlineQrDescription({
  text,
  interactive,
  className,
  style,
  onFocus,
  onTextChange
}: InlineQrDescriptionProps): JSX.Element {
  const elementRef = useRef<HTMLDivElement>(null)
  const editingRef = useRef(false)

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || editingRef.current || element.textContent === text) return
    element.textContent = text
  }, [text])

  return (
    <div
      ref={elementRef}
      data-qr-description-preview
      data-qr-description-inline-editor={interactive ? true : undefined}
      contentEditable={interactive ? 'plaintext-only' : false}
      suppressContentEditableWarning
      spellCheck={false}
      dir="ltr"
      className={`${className ?? ''} ${interactive ? 'pointer-events-auto cursor-text select-text outline-none ring-1 ring-blue-300/70 focus:ring-2' : ''}`}
      style={style}
      onFocus={() => {
        editingRef.current = true
        onFocus?.()
      }}
      onBlur={() => { editingRef.current = false }}
      onPointerDown={(event) => {
        if (!interactive) return
        event.stopPropagation()
      }}
      onClick={(event) => {
        if (!interactive) return
        event.stopPropagation()
      }}
      onInput={(event) => {
        if (!interactive || !onTextChange) return
        onTextChange(event.currentTarget.innerText.replace(/\r\n?/g, '\n'))
      }}
    />
  )
}

export function SceneQrPreviewLayer({
  config,
  outputWidth,
  outputHeight,
  shown = true,
  interactive = false,
  selected = false,
  onSelect,
  onChange
}: Props): JSX.Element | null {
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const valid = hasQrData(config)

  useEffect(() => {
    let cancelled = false
    if (!valid) {
      setImageDataUrl(null)
      return
    }
    const timer = setTimeout(() => {
      void renderQrImage(config).then((url) => {
        if (!cancelled) setImageDataUrl(url)
      }).catch(() => {
        if (!cancelled) setImageDataUrl(null)
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    config.contentType,
    config.url,
    config.wifiSsid,
    config.wifiPassword,
    config.wifiSecurity,
    config.wifiHidden,
    config.imagePath,
    config.moduleStyle,
    config.cornerStyle,
    config.color,
    config.logoPath,
    valid
  ])

  const geometry = useMemo(() => {
    const outputAspectRatio = Math.max(0.1, outputWidth / Math.max(1, outputHeight))
    const qrWidthPercent = config.sizePercent / outputAspectRatio
    const description = config.description.trim()
    const descriptionActive = Boolean(description) || (interactive && selected)
    const descriptionWidthPercent = descriptionActive
      ? qrWidthPercent * config.descriptionWidthPercent / 100
      : 0
    const gapWidthPercent = descriptionActive ? qrWidthPercent * 0.045 : 0
    const blockWidthPercent = qrWidthPercent + descriptionWidthPercent + gapWidthPercent
    const halfX = blockWidthPercent / 2
    const halfY = config.sizePercent / 2
    return {
      description,
      descriptionActive,
      qrShare: blockWidthPercent > 0 ? qrWidthPercent / blockWidthPercent * 100 : 100,
      gapShare: blockWidthPercent > 0 ? gapWidthPercent / blockWidthPercent * 100 : 0,
      blockWidthPercent,
      x: clamp(config.xPercent, Math.min(50, halfX + 1), Math.max(50, 99 - halfX)),
      y: halfY >= 50 ? 50 : clamp(config.yPercent, halfY + 1, 99 - halfY)
    }
  }, [config.description, config.descriptionWidthPercent, config.sizePercent, config.xPercent, config.yPercent, interactive, outputHeight, outputWidth, selected])

  useEffect(() => {
    const layer = layerRef.current
    if (!layer || !interactive || !onChange) return
    const handleWheel = (event: WheelEvent): void => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-scene-qr-object]')
        : null
      if (!target || !layer.contains(target)) return
      // Chromium can make framework wheel handlers passive. The explicit
      // listener keeps the Scene window fixed while the wheel scales QR.
      event.preventDefault()
      event.stopPropagation()
      onSelect?.()
      onChange({ sizePercent: clamp(config.sizePercent + (event.deltaY < 0 ? 2 : -2), 10, 100) })
    }
    layer.addEventListener('wheel', handleWheel, { passive: false })
    return () => layer.removeEventListener('wheel', handleWheel)
  }, [config.sizePercent, interactive, onChange, onSelect])

  if (!shown || !imageDataUrl) return null

  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const root = layerRef.current
    if (!interactive || !drag || !root || !onChange) return
    const rect = root.getBoundingClientRect()
    onChange({
      xPercent: (event.clientX - rect.left - drag.offsetX) / Math.max(1, rect.width) * 100,
      yPercent: (event.clientY - rect.top - drag.offsetY) / Math.max(1, rect.height) * 100
    })
  }

  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute inset-0 z-[10] overflow-hidden"
      style={{ containerType: 'size' }}
      data-scene-qr-layer
      onPointerMove={move}
      onPointerUp={(event) => {
        dragRef.current = null
        try {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        } catch { /* pointer already ended */ }
      }}
      onPointerCancel={() => { dragRef.current = null }}
    >
      <div
        data-scene-qr-object
        className={`absolute flex items-center ${interactive ? 'pointer-events-auto cursor-move touch-none select-none' : ''} ${interactive && selected ? 'rounded ring-2 ring-blue-300 ring-offset-2 ring-offset-black/70' : ''}`}
        style={{
          width: `${geometry.blockWidthPercent}%`,
          height: `${config.sizePercent}%`,
          left: `${geometry.x}%`,
          top: `${geometry.y}%`,
          transform: 'translate(-50%, -50%)',
          gap: geometry.descriptionActive ? `${geometry.gapShare}%` : 0,
          flexDirection: config.descriptionSide === 'left' ? 'row-reverse' : 'row'
        }}
        onPointerDown={(event) => {
          if (!interactive || !layerRef.current || event.button !== 0) return
          const rect = layerRef.current.getBoundingClientRect()
          dragRef.current = {
            offsetX: event.clientX - rect.left - rect.width * geometry.x / 100,
            offsetY: event.clientY - rect.top - rect.height * geometry.y / 100
          }
          onSelect?.()
          layerRef.current.setPointerCapture(event.pointerId)
          event.preventDefault()
          event.stopPropagation()
        }}
        title={interactive ? 'Перетащите QR-код; колесо мыши меняет размер' : undefined}
      >
        <img
          src={imageDataUrl}
          draggable={false}
          className="h-full shrink-0 select-none"
          style={{
            width: geometry.descriptionActive ? `${geometry.qrShare}%` : '100%',
            borderRadius: config.cornerStyle === 'rounded' ? '10%' : 0
          }}
        />
        {geometry.descriptionActive && (
          <InlineQrDescription
            text={config.description}
            interactive={interactive}
            onFocus={onSelect}
            onTextChange={(description) => onChange?.({ description })}
            className="flex max-h-full flex-1 items-center overflow-hidden text-left shadow-lg"
            style={{
              color: config.descriptionColor,
              backgroundColor: config.descriptionBackgroundTransparent
                ? 'transparent'
                : config.descriptionBackgroundColor,
              padding: `${Math.max(6 / Math.max(1, outputHeight) * 100, config.sizePercent * 0.055)}cqh`,
              fontFamily: 'Arial, sans-serif',
              fontWeight: 700,
              lineHeight: 1.15,
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
              fontSize: `${Math.max(10 / Math.max(1, outputHeight) * 100, config.sizePercent * 0.075 * config.descriptionFontScale)}cqh`,
              borderRadius: config.cornerStyle === 'rounded' ? '0.45rem' : 0
            }}
          />
        )}
      </div>
    </div>
  )
}
