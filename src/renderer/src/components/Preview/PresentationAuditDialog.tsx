import { useEffect } from 'react'
import type { PresentationAuditReport, PresentationAuditSlide } from '../../../../shared/presentation-audit'

interface Props {
  title: string
  report: PresentationAuditReport | null
  loading: boolean
  error: string | null
  onClose: () => void
  onRetry: () => void
  onPreview: (slide: number) => void
}

function SlideGroup({
  title, slides, description, onPreview
}: {
  title: string
  slides: PresentationAuditSlide[]
  description?: string
  onPreview: (slide: number) => void
}): JSX.Element {
  return <section className="rounded-lg border border-gray-700 bg-surface-200 p-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <span className="text-xs text-gray-400">{slides.length} сл.</span>
    </div>
    {description && <p className="mt-1 text-xs text-gray-400">{description}</p>}
    {slides.length ? <div className="mt-2 flex flex-wrap gap-1.5">
      {slides.map((slide) => <button
        key={slide.number}
        type="button"
        onClick={() => onPreview(slide.number)}
        className="rounded-md border border-blue-500/50 bg-blue-900/30 px-2 py-1 text-xs text-blue-100 hover:bg-blue-800/60"
        title={`Открыть слайд ${slide.number} в предпросмотре`}
      >{slide.number}</button>)}
    </div> : <p className="mt-2 text-xs text-gray-500">Не найдено</p>}
  </section>
}

export function PresentationAuditDialog({ title, report, loading, error, onClose, onRetry, onPreview }: Props): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/75 p-4" onMouseDown={onClose}>
    <div
      data-pdm-presentation-audit-dialog
      role="dialog"
      aria-modal="true"
      aria-label="Проверка презентации"
      className="flex max-h-[min(720px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-gray-600 bg-surface-300 shadow-2xl"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3 border-b border-gray-700 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-white">Проверка презентации</h2>
          <p className="truncate text-xs text-gray-400" title={title}>{title}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 text-xl text-gray-400 hover:bg-gray-700 hover:text-white" aria-label="Закрыть проверку">×</button>
      </div>
      <div className="min-h-0 overflow-y-auto p-4">
        {loading && <p role="status" className="text-sm text-blue-200">Проверяем слайды и шрифты…</p>}
        {error && <p role="alert" className="rounded-md bg-red-900/40 p-3 text-sm text-red-200">{error}</p>}
        {report && <>
          <p className="mb-3 text-xs text-gray-400">Проверено слайдов: {report.slideCount}. Нажмите номер, чтобы открыть слайд в предпросмотре, не меняя эфир.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <SlideGroup title="Видео" slides={report.slides.filter((slide) => slide.videos > 0)} description="Встроенные видеоролики" onPreview={onPreview} />
            <SlideGroup title="Аудио" slides={report.slides.filter((slide) => slide.audio > 0)} description="Встроенные звуковые файлы" onPreview={onPreview} />
            <SlideGroup title="Анимации" slides={report.slides.filter((slide) => slide.animations)} description="Анимация объектов на слайде" onPreview={onPreview} />
            <SlideGroup title="Медиа по ссылке" slides={report.slides.filter((slide) => slide.linkedMedia > 0)} description="Файл не встроен в презентацию: проверьте ссылку перед показом" onPreview={onPreview} />
          </div>
          <section className="mt-2 rounded-lg border border-gray-700 bg-surface-200 p-3">
            <h3 className="text-sm font-semibold text-white">Отсутствующие шрифты</h3>
            {!report.fontsChecked ? <p className="mt-2 text-xs text-amber-300">Не удалось получить список шрифтов этого компьютера.</p> :
              report.missingFonts.length ? <div className="mt-2 space-y-2">
                {report.missingFonts.map((font) => <div key={font} className="text-xs text-amber-200">
                  <span className="font-semibold">{font}</span>
                  <span className="text-gray-400"> · слайды: </span>
                  {report.slides.filter((slide) => slide.missingFonts.includes(font)).map((slide) => <button
                    key={slide.number}
                    type="button"
                    onClick={() => onPreview(slide.number)}
                    className="mr-1 rounded-sm underline hover:text-white"
                  >{slide.number}</button>)}
                </div>)}
              </div> : <p className="mt-2 text-xs text-gray-500">На слайдах не найдены явно заданные отсутствующие шрифты.</p>}
          </section>
          {report.warnings.map((warning) => <p key={warning} className="mt-2 text-xs text-amber-300">{warning}</p>)}
          <p className="mt-3 text-xs text-gray-500">Проверка анализирует содержимое PPTX, но не подтверждает фактическое воспроизведение видео, звука или анимации в эфире. Шрифты из оформления и темы без явного указания на слайде могут не попасть в список.</p>
        </>}
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-700 px-4 py-3">
        <button type="button" disabled={loading} onClick={onRetry} className="rounded-md border border-gray-600 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-40">Проверить снова</button>
        <button type="button" onClick={onClose} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500">Закрыть</button>
      </div>
    </div>
  </div>
}
