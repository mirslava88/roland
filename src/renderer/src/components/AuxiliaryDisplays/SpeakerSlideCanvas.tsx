import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import { mediaUrl } from '../../media'
import {
  normalizeSpeakerSlideLayout,
  speakerCaptionPlacement,
  speakerSlideRect,
  type SpeakerCaption,
  type SpeakerSlideLayout
} from '../../../../shared/speaker-layout'

interface Props {
  layout: SpeakerSlideLayout
  isPdf: boolean
  current: ReactNode
  next: ReactNode
  backdropImage?: string | null
  fileName: string
  currentSlide: number
  totalSlides: number
  notes?: string
  timer?: ReactNode
  onResizeStart?: (slide: 'current' | 'next', event: ReactPointerEvent<HTMLButtonElement>) => void
  onCaptionPointerDown?: (caption: SpeakerCaption, event: ReactPointerEvent<HTMLDivElement>) => void
  onCaptionWheel?: (caption: SpeakerCaption, event: ReactWheelEvent<HTMLDivElement>) => void
  selectedCaptions?: SpeakerCaption[]
  scaleBadgeCaptions?: SpeakerCaption[]
}

export function SpeakerSlideCanvas({
  layout,
  isPdf,
  current,
  next,
  backdropImage,
  fileName,
  currentSlide,
  totalSlides,
  notes,
  timer,
  onResizeStart,
  onCaptionPointerDown,
  onCaptionWheel,
  selectedCaptions = [],
  scaleBadgeCaptions = []
}: Props): JSX.Element {
  const safeLayout = normalizeSpeakerSlideLayout(layout)
  const currentRect = speakerSlideRect(safeLayout, 'current', isPdf)
  const nextRect = speakerSlideRect(safeLayout, 'next', isPdf)
  const showBackdrop = safeLayout.showBackdrop && Boolean(backdropImage)
  const currentCaption = speakerCaptionPlacement(safeLayout, 'current', isPdf)
  const nextCaption = speakerCaptionPlacement(safeLayout, 'next', isPdf)
  const titleCaption = speakerCaptionPlacement(safeLayout, 'title', isPdf)
  const captionInteraction = onCaptionPointerDown
    ? 'cursor-move touch-none outline outline-1 outline-dashed outline-blue-400/70 hover:outline-blue-200'
    : 'pointer-events-none'
  const scaleBadge = (caption: SpeakerCaption, scale: number): ReactNode => scaleBadgeCaptions.includes(caption) && (
    <span
      className="pointer-events-none absolute right-0 top-0 z-40 rounded border border-blue-200 bg-blue-600 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white shadow-lg"
      style={{ transform: `translateY(-50%) scale(${1 / scale})`, transformOrigin: 'right center' }}
    >{Math.round(scale * 100)}%</span>
  )
  return (
    <div
      data-speaker-slide-canvas
      className="relative h-full w-full overflow-hidden bg-[#090b10] bg-cover bg-center text-white select-none"
      style={{ containerType: 'inline-size', ...(showBackdrop && backdropImage
        ? { backgroundImage: `url("${mediaUrl(backdropImage)}")` }
        : {}) }}
    >
      <section
        data-speaker-current-slide
        className={`absolute overflow-visible rounded-lg border border-gray-700 shadow-2xl ${showBackdrop ? 'bg-transparent' : 'bg-black'}`}
        style={{ left: `${currentRect.left}%`, top: `${currentRect.top}%`, width: `${currentRect.width}%`, height: `${currentRect.height}%` }}
      >
        <div className="h-full w-full overflow-hidden rounded-lg">{current}</div>
        {onResizeStart && (
          <button
            type="button"
            aria-label="Изменить размер текущего слайда"
            title="Потяните, чтобы изменить размер"
            className="absolute -bottom-2 -right-2 z-20 h-5 w-5 cursor-nwse-resize rounded border border-white bg-blue-500 shadow-md touch-none"
            onPointerDown={(event) => onResizeStart('current', event)}
          />
        )}
      </section>
      <aside
        data-speaker-next-slide
        className={`absolute overflow-visible rounded-lg border border-gray-700 ${showBackdrop ? 'bg-transparent' : 'bg-black'}`}
        style={{ left: `${nextRect.left}%`, top: `${nextRect.top}%`, width: `${nextRect.width}%`, height: `${nextRect.height}%` }}
      >
        <div className="h-full w-full overflow-hidden rounded-lg">{next}</div>
        {onResizeStart && (
          <button
            type="button"
            aria-label="Изменить размер следующего слайда"
            title="Потяните, чтобы изменить размер"
            className="absolute -bottom-2 -left-2 z-20 h-5 w-5 cursor-nesw-resize rounded border border-white bg-blue-500 shadow-md touch-none"
            onPointerDown={(event) => onResizeStart('next', event)}
          />
        )}
      </aside>
      <div
        data-speaker-caption-current
        onPointerDown={onCaptionPointerDown ? (event) => onCaptionPointerDown('current', event) : undefined}
        onWheel={onCaptionWheel ? (event) => onCaptionWheel('current', event) : undefined}
        className={`absolute z-30 whitespace-nowrap rounded bg-black/75 px-[0.45%] py-[0.25%] font-semibold shadow-md ${captionInteraction} ${selectedCaptions.includes('current') ? 'outline-2 outline-blue-300' : ''}`}
        style={{
          left: `${currentCaption.x}%`, top: `${currentCaption.y}%`,
          transform: `scale(${currentCaption.scale})`, transformOrigin: 'top left', fontSize: '0.83cqw'
        }}
      >
        Активный слайд · {currentSlide} / {totalSlides || '—'}
        {scaleBadge('current', currentCaption.scale)}
      </div>
      <div
        data-speaker-caption-next
        onPointerDown={onCaptionPointerDown ? (event) => onCaptionPointerDown('next', event) : undefined}
        onWheel={onCaptionWheel ? (event) => onCaptionWheel('next', event) : undefined}
        className={`absolute z-30 whitespace-nowrap rounded bg-black/75 px-[0.45%] py-[0.25%] font-semibold shadow-md ${captionInteraction} ${selectedCaptions.includes('next') ? 'outline-2 outline-blue-300' : ''}`}
        style={{
          left: `${nextCaption.x}%`, top: `${nextCaption.y}%`,
          transform: `scale(${nextCaption.scale})`, transformOrigin: 'top left', fontSize: '0.83cqw'
        }}
      >
        Следующий слайд · {currentSlide < totalSlides ? currentSlide + 1 : '—'} / {totalSlides || '—'}
        {scaleBadge('next', nextCaption.scale)}
      </div>
      {safeLayout.showTitle && <div
        data-speaker-caption-title
        onPointerDown={onCaptionPointerDown ? (event) => onCaptionPointerDown('title', event) : undefined}
        onWheel={onCaptionWheel ? (event) => onCaptionWheel('title', event) : undefined}
        className={`absolute z-30 whitespace-nowrap rounded-md border border-gray-700 bg-gray-900/90 px-[1%] py-[0.5%] text-right ${captionInteraction} ${selectedCaptions.includes('title') ? 'outline-2 outline-blue-300' : ''}`}
        style={{
          left: `${titleCaption.x}%`, top: `${titleCaption.y}%`, width: `${nextRect.width}%`,
          transform: `scale(${titleCaption.scale})`, transformOrigin: 'top left', fontSize: '0.94cqw'
        }}
      >
        <div className="truncate text-gray-300">{fileName}</div>
        {scaleBadge('title', titleCaption.scale)}
      </div>}
      {!isPdf && safeLayout.showNotes && (
        <section className="absolute bottom-[2%] left-[2%] h-[18%] w-[96%] overflow-hidden rounded-lg border border-gray-700 bg-gray-900/80 px-[1.5%] py-[0.5%]">
          <div className="text-[clamp(8px,0.8vw,13px)] uppercase tracking-wider text-gray-400">Заметки докладчика</div>
          <div className="h-full overflow-hidden whitespace-pre-wrap text-[clamp(12px,1.5vw,26px)] leading-snug text-gray-100">
            {notes?.trim() || 'Заметок к этому слайду нет'}
          </div>
        </section>
      )}
      {timer}
    </div>
  )
}
