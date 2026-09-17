import { useEffect, useRef, useState, type ReactNode, type JSX } from 'react'
import { LAST_TRAINING_STEP, ONBOARDING_EVENT, readIntroduction, saveIntroduction, type IntroductionProgress } from './training-model'
import './introduction.css'

export function Introduction({ children }: { children: ReactNode }): JSX.Element {
  const [progress] = useState(() => readIntroduction(localStorage))
  const [mode, setMode] = useState<'welcome' | 'training' | 'closed'>(() => progress.status === 'new' || progress.status === 'paused' ? 'welcome' : 'closed')
  const [step, setStep] = useState(progress.status === 'paused' ? progress.step : 0)
  const stepRef = useRef(step)
  stepRef.current = step
  const [error, setError] = useState('')
  const [panelHint, setPanelHint] = useState('')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const active = mode !== 'closed'
  const close = (status: IntroductionProgress['status'] = 'paused'): void => {
    const saved = readIntroduction(localStorage)
    saveIntroduction(localStorage, { status: saved.status === 'completed' && status === 'paused' ? 'completed' : status, step: stepRef.current })
    setPanelHint('')
    setMode('closed')
  }
  useEffect(() => {
    const open = (): void => {
      const saved = readIntroduction(localStorage)
      setStep(saved.status === 'paused' ? saved.step : 0); setError(''); setPanelHint(''); setMode('welcome')
    }
    window.addEventListener(ONBOARDING_EVENT, open)
    return () => window.removeEventListener(ONBOARDING_EVENT, open)
  }, [])
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (event.data?.kind === 'pdm-training-panel-hint') {
        setPanelHint(event.data.open === true && typeof event.data.title === 'string'
          ? typeof event.data.text === 'string' && event.data.text.trim()
            ? event.data.text
            : `${event.data.title} открыто — спокойно осмотрите настройки, затем закройте окно крестиком`
          : '')
        return
      }
      if (event.data?.kind !== 'pdm-training-progress') return
      const next = event.data.step
      if (!Number.isInteger(next) || next < 0 || next > LAST_TRAINING_STEP) return
      setStep(next)
      saveIntroduction(localStorage, { status: event.data.completed === true ? 'completed' : 'paused', step: next })
      if (event.data.close === true) setMode('closed')
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(() => {
    if (!active) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const trap = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close(mode === 'training' ? 'paused' : 'skipped') }
      if (event.key === 'Tab' && mode === 'welcome') {
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first?.focus() }
      }
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', trap, true)
    return () => { window.removeEventListener('keydown', trap, true); if (previous?.isConnected) previous.focus() }
  }, [active, mode])
  const theme = document.querySelector('.theme-classic') ? 'classic' : 'broadcast-pro'
  // Keep the iframe URL stable when progress messages update the parent step.
  const [session, setSession] = useState({ step: 0, theme: 'broadcast-pro' })
  const begin = (): void => { setSession({ step, theme }); setError(''); setPanelHint(''); setMode('training') }
  const src = new URL('training.html', window.location.href)
  src.searchParams.set('step', String(session.step)); src.searchParams.set('theme', session.theme)

  return <>
    <div className="intro-real-workspace" inert={active} aria-hidden={active || undefined}>{children}</div>
    {active && <div data-pdm-onboarding className={mode === 'training' ? 'intro-interface-host' : 'intro-backdrop'} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Знакомство с PDM" className={mode === 'training' ? 'intro-interface-dialog' : 'intro-dialog intro-welcome'}>
        {mode === 'welcome' ? <>
          <button className="intro-welcome-close" aria-label="Закрыть знакомство" onClick={() => close('skipped')}>✕</button>
          <span className="intro-label">ДОБРО ПОЖАЛОВАТЬ В PDM</span>
          <h1>Подготовим ваш<br />первый показ</h1>
          <p>Программа по шагам покажет, как добавить презентацию, вывести её на экран и использовать основные возможности PDM.</p>
          <div className="intro-welcome-display"><span>▱ → ▱</span><div><strong>Перед настоящим показом подключите второй экран</strong><p>Это может быть телевизор, проектор или другой монитор. Если изображения на нём нет, нажмите клавиши Windows и P, затем выберите «Расширить».</p></div></div>
          <div className="intro-note">Обучение можно пройти и без второго экрана. Здесь можно нажимать всё без страха: ваши рабочие каналы останутся как были, а зрители ничего не увидят.</div>
          <div className="intro-welcome-actions"><button className="intro-primary" onClick={begin}>{step > 0 ? 'Продолжить обучение' : 'Пройти обучение'}</button><button onClick={() => close('skipped')}>Пропустить обучение</button></div>
          <small>Повторить знакомство: Настройки → Помощь → Обучение</small>
        </> : <>
          <header className={`intro-interface-header${panelHint ? ' intro-interface-header-panel' : ''}`}><strong>Обучение PDM</strong><span>{panelHint || 'Пошаговое знакомство с основными возможностями приложения'}</span><button onClick={() => close()} aria-label="Закрыть обучение">Продолжить позже ✕</button></header>
          {error ? <p className="intro-frame-error">{error}</p> : <iframe ref={frameRef} title="Интерактивное знакомство с интерфейсом PDM" src={src.href} sandbox="allow-scripts allow-same-origin" allow="camera 'none'; microphone 'none'; display-capture 'none'; autoplay 'none'" onError={() => setError('Не удалось открыть обучение. Закройте окно и попробуйте снова.')} />}
        </>}
      </div>
    </div>}
  </>
}
