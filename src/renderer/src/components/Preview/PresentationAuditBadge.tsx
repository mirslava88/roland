import type { PresentationAuditReport } from '../../../../shared/presentation-audit'

interface Props {
  report: PresentationAuditReport | null
  loading: boolean
  error: string | null
  compact: boolean
  onClick: () => void
  channel: string
}

export function PresentationAuditBadge({ report, loading, error, compact, onClick, channel }: Props): JSX.Element {
  const videoSlides = report?.slides.filter((slide) => slide.videos > 0).length || 0
  const audioSlides = report?.slides.filter((slide) => slide.audio > 0).length || 0
  const animationSlides = report?.slides.filter((slide) => slide.animations).length || 0
  const fontSlides = report?.slides.filter((slide) => slide.missingFonts.length > 0).length || 0
  const linkedSlides = report?.slides.filter((slide) => slide.linkedMedia > 0).length || 0
  const extraWarnings = report?.warnings.filter((message) => !message.startsWith('Список установленных шрифтов')).length || 0
  const warning = Boolean(error || fontSlides || linkedSlides || report?.warnings.length)
  const items = [
    { key: 'video', label: 'Видео', count: videoSlides, color: 'text-blue-200' },
    { key: 'audio', label: 'Аудио', count: audioSlides, color: 'text-cyan-200' },
    { key: 'animation', label: 'Анимации', count: animationSlides, color: 'text-violet-200' },
    { key: 'fonts', label: 'Шрифты', count: fontSlides, color: 'text-amber-200' },
    { key: 'links', label: 'Ссылки', count: linkedSlides, color: 'text-amber-200' }
  ].filter((item) => item.count > 0)
  const label = loading ? 'Проверяем презентацию' : error ? 'Проверка недоступна' : 'Проверка презентации'

  return <button
    type="button"
    data-pdm-presentation-audit={channel}
    onClick={(event) => { event.stopPropagation(); onClick() }}
    onDoubleClick={(event) => event.stopPropagation()}
    className={`absolute bottom-1.5 left-1.5 z-20 flex max-w-[calc(100%-12px)] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border bg-gray-950/90 text-left font-semibold shadow-lg backdrop-blur-sm hover:bg-gray-900/95 ${compact ? 'px-1.5 py-0.5 text-[8px]' : 'px-2 py-1 text-[9px]'} ${warning ? 'border-amber-500/80' : 'border-gray-500/70'}`}
    aria-label={`${label}. Нажмите для подробностей`}
    title={`${label}. Нажмите для подробностей`}
  >
    {loading ? <span className="text-blue-200">Проверяем…</span> : error ? <span className="text-amber-200">Проверка ⚠</span> : report ? <>
      {items.map((item) => <span key={item.key} data-pdm-audit-summary={item.key} className={`${item.color} whitespace-nowrap`}>{item.label}</span>)}
      {!report.fontsChecked && !fontSlides && <span data-pdm-audit-summary="fonts-unknown" className="whitespace-nowrap text-amber-200">Шрифты</span>}
      {extraWarnings > 0 && <span data-pdm-audit-summary="warnings" className="whitespace-nowrap text-amber-200">Замечания</span>}
      {!items.length && report.fontsChecked && !extraWarnings && <span className="text-gray-300">Проверено ✓</span>}
    </> : <span className="text-gray-300">Проверка</span>}
  </button>
}
