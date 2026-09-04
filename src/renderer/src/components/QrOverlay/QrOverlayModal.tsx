import { useEffect, useMemo, useRef, useState } from 'react'
import {
  hasQrData,
  normalizeQrOverlay,
  type QrModuleStyle,
  type QrOverlayConfig
} from '../../../../shared/qr-overlay'
import { useAppStore } from '../../stores/useAppStore'
import { renderQrImage } from './qr-render'

const MODULE_STYLES: Array<{ value: QrModuleStyle; label: string }> = [
  { value: 'square', label: 'Квадраты' },
  { value: 'dots', label: 'Точки' },
  { value: 'rounded', label: 'Мягкие' }
]

const POSITIONS = [
  [16, 20], [50, 20], [84, 20],
  [16, 50], [50, 50], [84, 50],
  [16, 80], [50, 80], [84, 80]
] as const

export function QrOverlayModal({ onClose }: { onClose: () => void }): JSX.Element {
  const stored = useAppStore((state) => state.qrOverlay)
  const setQrOverlay = useAppStore((state) => state.setQrOverlay)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const outputAvailable = useAppStore((state) => (
    (state.activeFile !== null || state.isPresentationWindowOpen) &&
    state.displays.some((display) => !display.isPrimary && display.id === state.selectedDisplayId)
  ))
  const [draft, setDraft] = useState<QrOverlayConfig>(() => ({ ...stored }))
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [livePreview, setLivePreview] = useState(false)
  const initialConfigRef = useRef<QrOverlayConfig>({ ...stored })
  const livePreviewRef = useRef(false)
  const savedRef = useRef(false)
  const valid = hasQrData(draft)

  const update = (patch: Partial<QrOverlayConfig>): void => {
    setDraft((current) => normalizeQrOverlay({ ...current, ...patch }))
  }

  useEffect(() => {
    let cancelled = false
    if (!valid) {
      setPreview(null)
      setPreviewError('Заполните данные QR-кода')
      return
    }
    const timer = setTimeout(() => {
      void renderQrImage(draft).then((url) => {
        if (!cancelled) {
          setPreview(url)
          setPreviewError('')
        }
      }).catch((error: unknown) => {
        if (!cancelled) setPreviewError(String(error))
      })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    draft.contentType,
    draft.url,
    draft.wifiSsid,
    draft.wifiPassword,
    draft.wifiSecurity,
    draft.wifiHidden,
    draft.imagePath,
    draft.moduleStyle,
    draft.cornerStyle,
    draft.color,
    draft.logoPath,
    valid
  ])

  const sendLiveImage = (config: QrOverlayConfig, imageDataUrl: string): void => {
    const state = useAppStore.getState()
    const targetExists = state.displays.some(
      (display) => !display.isPrimary && display.id === state.selectedDisplayId
    )
    if ((!state.activeFile && !state.isPresentationWindowOpen) || !targetExists) {
      window.api.updateQrOverlay({ visible: false })
      return
    }
    window.api.updateQrOverlay({
      visible: true,
      displayId: state.selectedDisplayId,
      imageDataUrl,
      sizePercent: config.sizePercent,
      xPercent: config.xPercent,
      yPercent: config.yPercent,
      cornerStyle: config.cornerStyle
    })
  }

  const restoreSavedOutput = async (): Promise<void> => {
    const config = initialConfigRef.current
    if (!config.enabled || !hasQrData(config)) {
      window.api.updateQrOverlay({ visible: false })
      return
    }
    try {
      const imageDataUrl = await renderQrImage(config)
      sendLiveImage(config, imageDataUrl)
    } catch (error) {
      window.api.dbgLog(`QR live preview restore failed: ${String(error)}`)
      window.api.updateQrOverlay({ visible: false })
    }
  }

  useEffect(() => {
    livePreviewRef.current = livePreview
    if (!livePreview) return
    if (!draft.enabled || !valid || !preview || !outputAvailable) {
      window.api.updateQrOverlay({ visible: false })
      return
    }
    sendLiveImage(draft, preview)
  }, [
    livePreview,
    draft.enabled,
    preview,
    valid,
    outputAvailable,
    selectedDisplayId,
    draft.sizePercent,
    draft.xPercent,
    draft.yPercent,
    draft.cornerStyle
  ])

  useEffect(() => () => {
    if (livePreviewRef.current && !savedRef.current) void restoreSavedOutput()
  }, [])

  const activePosition = useMemo(() => POSITIONS.findIndex(([x, y]) => (
    Math.abs(x - draft.xPercent) < 2 && Math.abs(y - draft.yPercent) < 2
  )), [draft.xPercent, draft.yPercent])
  const previewPosition = useMemo(() => {
    const halfX = draft.sizePercent * 9 / 32
    const halfY = draft.sizePercent / 2
    return {
      x: Math.max(halfX + 1, Math.min(99 - halfX, draft.xPercent)),
      y: halfY >= 50 ? 50 : Math.max(halfY + 1, Math.min(99 - halfY, draft.yPercent))
    }
  }, [draft.sizePercent, draft.xPercent, draft.yPercent])

  const movePreviewQr = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    update({
      xPercent: (event.clientX - rect.left) / rect.width * 100,
      yPercent: (event.clientY - rect.top) / rect.height * 100
    })
  }

  const chooseLogo = async (): Promise<void> => {
    const path = await window.api.selectQrLogo()
    if (path) update({ logoPath: path })
  }

  const chooseQrImage = async (): Promise<void> => {
    const path = await window.api.selectQrImage()
    if (path) update({ imagePath: path })
  }

  const save = (): void => {
    savedRef.current = true
    setQrOverlay(draft)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-3" onMouseDown={onClose}>
      <div
        className="w-[720px] max-w-[96vw] rounded-xl border border-gray-700 bg-surface-300 p-4 text-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">QR-код в эфире</h2>
            <p className="text-[11px] text-gray-400">Ссылка или подключение к Wi‑Fi поверх любого контента</p>
          </div>
          <button type="button" onClick={onClose} className="px-2 text-xl text-gray-400 hover:text-white">×</button>
        </div>

        <div className="grid grid-cols-[1fr_238px] gap-4">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 rounded-lg bg-surface-200 p-1">
              <button type="button" onClick={() => update({ contentType: 'url' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'url' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Ссылка</button>
              <button type="button" onClick={() => update({ contentType: 'wifi' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'wifi' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Wi‑Fi</button>
              <button type="button" onClick={() => update({ contentType: 'file' })} className={`rounded-md py-1.5 text-xs ${draft.contentType === 'file' ? 'bg-blue-600' : 'hover:bg-gray-700'}`}>Из файла</button>
            </div>

            {draft.contentType === 'url' ? (
              <label className="block text-xs text-gray-300">Ссылка
                <input value={draft.url} onChange={(event) => update({ url: event.target.value })} placeholder="https://example.ru" className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-sm text-white outline-none focus:border-blue-500" />
              </label>
            ) : draft.contentType === 'wifi' ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2 block text-xs text-gray-300">Название сети
                  <input value={draft.wifiSsid} onChange={(event) => update({ wifiSsid: event.target.value })} className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-sm outline-none focus:border-blue-500" />
                </label>
                <label className="block text-xs text-gray-300">Защита
                  <select value={draft.wifiSecurity} onChange={(event) => update({ wifiSecurity: event.target.value as QrOverlayConfig['wifiSecurity'] })} className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2 py-1.5 text-sm">
                    <option value="WPA">WPA / WPA2 / WPA3</option><option value="WEP">WEP</option><option value="nopass">Без пароля</option>
                  </select>
                </label>
                <label className="block text-xs text-gray-300">Пароль
                  <input type="password" disabled={draft.wifiSecurity === 'nopass'} value={draft.wifiPassword} onChange={(event) => update({ wifiPassword: event.target.value })} className="mt-1 w-full rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-sm disabled:opacity-40" />
                </label>
                <label className="col-span-2 flex items-center gap-2 text-xs text-gray-300"><input type="checkbox" checked={draft.wifiHidden} onChange={(event) => update({ wifiHidden: event.target.checked })} /> Скрытая сеть</label>
              </div>
            ) : (
              <div>
                <div className="mb-1 text-xs text-gray-300">Готовый QR-код</div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => { void chooseQrImage() }} className="min-w-0 flex-1 truncate rounded-md border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-left text-xs hover:bg-gray-700" title={draft.imagePath || 'Выбрать изображение QR-кода'}>{draft.imagePath?.split(/[\\/]/).pop() || 'Выбрать файл QR-кода'}</button>
                  {draft.imagePath && <button type="button" onClick={() => update({ imagePath: null })} className="rounded-md border border-gray-700 px-2 text-gray-400 hover:text-white">×</button>}
                </div>
                <p className="mt-1 text-[10px] text-gray-400">PNG, JPG, BMP, WebP или SVG. Лучше использовать квадратное изображение.</p>
              </div>
            )}

            {draft.contentType !== 'file' && <div>
              <div className="mb-1 text-xs text-gray-300">Рисунок QR-кода</div>
              <div className="grid grid-cols-3 gap-1">
                {MODULE_STYLES.map((style) => <button key={style.value} type="button" onClick={() => update({ moduleStyle: style.value })} className={`rounded-md border px-1 py-1.5 text-[11px] ${draft.moduleStyle === style.value ? 'border-blue-400 bg-blue-600' : 'border-gray-700 bg-surface-100 hover:bg-gray-700'}`}>{style.label}</button>)}
              </div>
            </div>}

            <div className={`grid gap-3 ${draft.contentType === 'file' ? 'grid-cols-1' : 'grid-cols-2'}`}>
              <div>
                <div className="mb-1 text-xs text-gray-300">Углы</div>
                <div className="grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => update({ cornerStyle: 'sharp' })} className={`rounded-md border py-1.5 text-[11px] ${draft.cornerStyle === 'sharp' ? 'border-blue-400 bg-blue-600' : 'border-gray-700 bg-surface-100'}`}>Острые</button>
                  <button type="button" onClick={() => update({ cornerStyle: 'rounded' })} className={`rounded-md border py-1.5 text-[11px] ${draft.cornerStyle === 'rounded' ? 'border-blue-400 bg-blue-600' : 'border-gray-700 bg-surface-100'}`}>Скруглённые</button>
                </div>
              </div>
              {draft.contentType !== 'file' && <label className="block text-xs text-gray-300">Цвет QR-кода
                <div className="mt-1 flex items-center gap-2 rounded-md border border-gray-700 bg-surface-100 px-2 py-1">
                  <input type="color" value={draft.color} onChange={(event) => update({ color: event.target.value })} className="h-6 w-8 cursor-pointer bg-transparent" />
                  <span className="font-mono text-[11px] uppercase">{draft.color}</span>
                </div>
              </label>}
            </div>

            <div className={`grid items-end gap-3 ${draft.contentType === 'file' ? 'grid-cols-[118px] justify-end' : 'grid-cols-[1fr_118px]'}`}>
              {draft.contentType !== 'file' && <div>
                <div className="mb-1 text-xs text-gray-300">Логотип по центру</div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => { void chooseLogo() }} className="min-w-0 flex-1 truncate rounded-md border border-gray-700 bg-surface-100 px-2 py-1.5 text-left text-[11px] hover:bg-gray-700" title={draft.logoPath || 'Выбрать изображение'}>{draft.logoPath?.split(/[\\/]/).pop() || 'Выбрать логотип'}</button>
                  {draft.logoPath && <button type="button" onClick={() => update({ logoPath: null })} className="rounded-md border border-gray-700 px-2 text-gray-400 hover:text-white">×</button>}
                </div>
              </div>}
              <div>
                <div className="mb-1 text-xs text-gray-300">Положение</div>
                <div className="grid grid-cols-3 gap-1">
                  {POSITIONS.map(([x, y], index) => <button key={`${x}-${y}`} type="button" onClick={() => update({ xPercent: x, yPercent: y })} aria-label={`Позиция ${index + 1}`} className={`h-5 rounded-sm border ${activePosition === index ? 'border-blue-300 bg-blue-500' : 'border-gray-600 bg-surface-100 hover:bg-gray-600'}`} />)}
                </div>
              </div>
            </div>

            <label className="block text-xs text-gray-300">Размер: {Math.round(draft.sizePercent)}%
              <input type="range" min="10" max="100" step="1" value={draft.sizePercent} onChange={(event) => update({ sizePercent: Number(event.target.value) })} className="mt-1 w-full accent-blue-500" />
            </label>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs text-gray-300">Предпросмотр</span>
              <label className={`flex items-center gap-1.5 text-[10px] ${draft.enabled && outputAvailable ? 'text-emerald-300' : 'text-gray-500'}`} title={!draft.enabled ? 'Сначала включите «Показывать в эфире»' : outputAvailable ? 'Показывать изменения сразу на программном экране' : 'Сначала выведите контент в эфир'}>
                <input
                  type="checkbox"
                  checked={draft.enabled && livePreview}
                  disabled={!draft.enabled || !outputAvailable}
                  onChange={(event) => {
                    const checked = event.target.checked
                    setLivePreview(checked)
                    if (!checked) void restoreSavedOutput()
                  }}
                />
                В эфире
              </label>
            </div>
            <div
              className="relative aspect-video touch-none overflow-hidden rounded-lg border border-gray-700 bg-[radial-gradient(circle_at_center,#374151_0,#111827_70%)]"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                movePreviewQr(event)
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) movePreviewQr(event)
              }}
              onWheel={(event) => {
                event.preventDefault()
                const direction = event.deltaY < 0 ? 1 : -1
                update({ sizePercent: draft.sizePercent + direction * 2 })
              }}
            >
              {preview ? <img src={preview} draggable={false} className="pointer-events-none absolute" style={{ width: `${draft.sizePercent * 9 / 16}%`, left: `${previewPosition.x}%`, top: `${previewPosition.y}%`, transform: 'translate(-50%, -50%)', borderRadius: draft.cornerStyle === 'rounded' ? '10%' : 0 }} /> : <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-gray-400">{previewError || 'Подготовка…'}</div>}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-gray-400">Перетащите QR для точного положения, вращайте колесо мыши для изменения размера. Белое поле вокруг кода нужно для надёжного считывания.</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-gray-700 pt-3">
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.enabled} onChange={(event) => {
            const checked = event.target.checked
            update({ enabled: checked })
            if (!checked && livePreview) {
              setLivePreview(false)
              livePreviewRef.current = false
              void restoreSavedOutput()
            }
          }} /> Показывать в эфире</label>
          <div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">Отмена</button><button type="button" onClick={save} disabled={!valid} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40">Сохранить</button></div>
        </div>
      </div>
    </div>
  )
}
