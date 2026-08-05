import { useEffect, useState } from 'react'
import { mediaUrl } from '../../media'
import { warmPdfiumDocument } from '../../pdfium-renderer'
import {
  useAppStore,
  type InformationMediaConfig,
  type InformationMediaType
} from '../../stores/useAppStore'

interface AuxiliaryDisplaysModalProps {
  onClose: () => void
}

const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'pptm', 'pps', 'ppsx'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'svg'])

const TYPE_LABELS: Record<InformationMediaType, string> = {
  presentation: 'PowerPoint',
  pdf: 'PDF',
  video: 'Видео',
  image: 'Изображение'
}

function displayStatus(connected: boolean, enabled: boolean): string {
  if (!connected) return 'Монитор не назначен'
  return enabled ? 'Включён' : 'Выключен'
}

function extensionOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || ''
}

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function mediaTypeOf(filePath: string): InformationMediaType | null {
  const extension = extensionOf(filePath)
  if (PRESENTATION_EXTENSIONS.has(extension)) return 'presentation'
  if (extension === 'pdf') return 'pdf'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return null
}

export function AuxiliaryDisplaysModal({ onClose }: AuxiliaryDisplaysModalProps): JSX.Element {
  const {
    displays,
    speakerDisplayId,
    informationDisplayId,
    speakerDisplayEnabled,
    informationDisplayEnabled,
    informationMedia,
    timerDisplayTarget,
    setSpeakerDisplayEnabled,
    setInformationDisplayEnabled,
    setInformationMedia
  } = useAppStore()
  const [mediaStatus, setMediaStatus] = useState('')
  const [loadingMedia, setLoadingMedia] = useState(false)

  const speakerConnected = speakerDisplayId !== null && displays.some((display) => display.id === speakerDisplayId)
  const informationConnected = informationDisplayId !== null && displays.some((display) => display.id === informationDisplayId)

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const chooseInformationMedia = async (): Promise<void> => {
    const path = await window.api.selectInformationMedia()
    if (!path) return
    const type = mediaTypeOf(path)
    if (!type) {
      setMediaStatus('Этот формат не поддерживается')
      return
    }

    setLoadingMedia(true)
    setMediaStatus(type === 'presentation' ? 'Подготовка слайдов PowerPoint…' : 'Подготовка файла…')
    try {
      let totalSlides = type === 'image' ? 1 : 0
      let slideImages: string[] = []

      if (type === 'presentation') {
        const result = await window.api.generatePptxSlides(path, 1920, 1080)
        if (!result.success || !result.slides?.length) {
          throw new Error(result.error || 'Не удалось подготовить слайды PowerPoint')
        }
        slideImages = result.slides
        totalSlides = result.slideCount || result.slides.length
      } else if (type === 'pdf') {
        const data = await window.api.readFile(path)
        totalSlides = await warmPdfiumDocument(path, 'background', data.slice(0))
      }

      const media: InformationMediaConfig = {
        type,
        path,
        name: fileNameOf(path),
        currentSlide: 1,
        totalSlides,
        slideImages,
        playing: false
      }
      setInformationMedia(media)
      setMediaStatus('')
      if (informationConnected) setInformationDisplayEnabled(true)
    } catch (error) {
      setMediaStatus(`Не удалось открыть файл: ${String(error)}`)
    } finally {
      setLoadingMedia(false)
    }
  }

  const moveSlide = (delta: number): void => {
    if (!informationMedia || informationMedia.totalSlides < 1) return
    const currentSlide = Math.max(1, Math.min(
      informationMedia.totalSlides,
      informationMedia.currentSlide + delta
    ))
    setInformationMedia({ ...informationMedia, currentSlide })
  }

  const currentPreview = informationMedia?.type === 'presentation'
    ? informationMedia.slideImages[informationMedia.currentSlide - 1]
    : informationMedia?.type === 'image'
      ? informationMedia.path
      : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="w-[820px] max-w-[94vw] max-h-[88vh] overflow-hidden rounded-xl border border-gray-700 bg-surface-200 shadow-2xl flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 px-5 py-3 border-b border-gray-700 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Дополнительные дисплеи</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">Дисплей 2 — суфлёр · Дисплей 3 — мультимедиа и таймер</p>
          </div>
          <button onClick={onClose} className="text-lg text-gray-500 hover:text-white">✕</button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <section className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-gray-700 bg-surface-100 p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Дисплей 2 — Суфлёр</h3>
                  <p className="text-[10px] text-gray-500 mt-1">Текущий и следующий слайд PPTX/PDF, заметки PowerPoint</p>
                </div>
                <span className={`text-[10px] ${speakerDisplayEnabled && speakerConnected ? 'text-emerald-400' : 'text-gray-500'}`}>
                  {displayStatus(speakerConnected, speakerDisplayEnabled)}
                </span>
              </div>
              <button
                disabled={!speakerConnected}
                onClick={() => setSpeakerDisplayEnabled(!speakerDisplayEnabled)}
                className={`w-full rounded-lg px-4 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  speakerDisplayEnabled
                    ? 'bg-red-600/80 hover:bg-red-600 text-white'
                    : 'bg-blue-600 hover:bg-blue-500 text-white'
                }`}
              >
                {speakerDisplayEnabled ? 'Выключить суфлёр' : 'Включить суфлёр'}
              </button>
            </div>

            <div className="rounded-xl border border-gray-700 bg-surface-100 p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Дисплей 3 — Информационный</h3>
                  <p className="text-[10px] text-gray-500 mt-1">Независимый показ мультимедиа или таймера</p>
                </div>
                <span className={`text-[10px] ${informationDisplayEnabled && informationConnected ? 'text-emerald-400' : 'text-gray-500'}`}>
                  {displayStatus(informationConnected, informationDisplayEnabled)}
                </span>
              </div>
              <button
                disabled={!informationConnected}
                onClick={() => setInformationDisplayEnabled(!informationDisplayEnabled)}
                className={`w-full rounded-lg px-4 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  informationDisplayEnabled
                    ? 'bg-red-600/80 hover:bg-red-600 text-white'
                    : 'bg-blue-600 hover:bg-blue-500 text-white'
                }`}
              >
                {informationDisplayEnabled ? 'Скрыть информационный экран' : 'Показать информационный экран'}
              </button>
            </div>
          </section>

          {(!speakerConnected || !informationConnected) && (
            <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
              Назначьте физические мониторы во вкладке «Настройки → Дисплеи». Дисплей 0 всегда остаётся операторским.
            </div>
          )}

          <section className="rounded-xl border border-gray-700 bg-surface-100 p-4">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Мультимедиа на Дисплее 3</h3>
                <p className="text-[10px] text-gray-500 mt-1">PPTX, PDF, видео и изображения работают независимо от основного эфира</p>
              </div>
              <button
                disabled={loadingMedia}
                onClick={chooseInformationMedia}
                className="shrink-0 rounded-lg bg-purple-700 hover:bg-purple-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
              >
                {loadingMedia ? 'Подготовка…' : 'Выбрать файл'}
              </button>
            </div>

            {informationMedia ? (
              <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4">
                <div className="min-w-0 space-y-4">
                  <div className="rounded-lg border border-gray-700 bg-surface-200 p-3">
                    <div className="text-[10px] uppercase tracking-wide text-purple-300 mb-1">
                      {TYPE_LABELS[informationMedia.type]}
                    </div>
                    <div className="truncate text-sm text-white" title={informationMedia.path}>{informationMedia.name}</div>
                    <div className="truncate text-[10px] text-gray-500 mt-1" title={informationMedia.path}>{informationMedia.path}</div>
                  </div>

                  {(informationMedia.type === 'presentation' || informationMedia.type === 'pdf') && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => moveSlide(-1)}
                        disabled={informationMedia.currentSlide <= 1}
                        className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 disabled:opacity-30"
                      >
                        ◀
                      </button>
                      <div className="min-w-[90px] text-center text-sm tabular-nums text-white">
                        {informationMedia.currentSlide} / {informationMedia.totalSlides}
                      </div>
                      <button
                        onClick={() => moveSlide(1)}
                        disabled={informationMedia.currentSlide >= informationMedia.totalSlides}
                        className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 disabled:opacity-30"
                      >
                        ▶
                      </button>
                    </div>
                  )}

                  {informationMedia.type === 'video' && (
                    <button
                      onClick={() => setInformationMedia({ ...informationMedia, playing: !informationMedia.playing })}
                      className={`rounded-lg px-5 py-2 text-xs font-medium text-white ${
                        informationMedia.playing ? 'bg-yellow-700 hover:bg-yellow-600' : 'bg-green-700 hover:bg-green-600'
                      }`}
                    >
                      {informationMedia.playing ? '⏸ Пауза' : '▶ Воспроизвести'}
                    </button>
                  )}

                  <button
                    onClick={() => setInformationMedia(null)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Убрать файл с информационного экрана
                  </button>
                </div>

                <div>
                  <div className="text-[10px] text-gray-500 mb-1">Предварительный просмотр</div>
                  <div className="aspect-video rounded-lg border border-gray-700 bg-black overflow-hidden flex items-center justify-center">
                    {currentPreview ? (
                      <img src={mediaUrl(currentPreview)} className="h-full w-full object-contain" draggable={false} />
                    ) : informationMedia.type === 'pdf' ? (
                      <div className="text-center text-gray-400">
                        <div className="text-4xl mb-2">PDF</div>
                        <div className="text-xs">Страница {informationMedia.currentSlide}</div>
                      </div>
                    ) : (
                      <div className="text-center text-gray-400">
                        <div className="text-4xl mb-2">▶</div>
                        <div className="text-xs">Видео готово к воспроизведению</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-700 px-5 py-8 text-center text-xs text-gray-500">
                Файл не выбран. На экране будет показана общая подложка или чёрный фон.
              </div>
            )}

            {mediaStatus && <div className="mt-3 text-xs text-amber-300">{mediaStatus}</div>}
            {timerDisplayTarget === 'information' && (
              <div className="mt-4 rounded-lg border border-blue-700/50 bg-blue-950/30 px-4 py-3 text-xs text-blue-200">
                Таймер настроен на Дисплей 3. Пока он установлен, таймер временно показывается вместо выбранного файла.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
