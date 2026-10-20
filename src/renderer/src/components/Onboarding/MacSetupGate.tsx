import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MacPermissionStatus, MacPresentationSupport, MacPrivacyPermission } from '../../../../shared/mac-setup'
import { MAC_KEYNOTE_REQUIRED_MESSAGE } from '../../../../shared/mac-setup'
import { MAC_PRESENTATION_SETUP_EVENT, requireMacPresentationSupport } from '../../mac-presentation-support'
import { useAppStore } from '../../stores/useAppStore'
import './mac-setup.css'

const permissionsReady = (status: MacPermissionStatus | null): boolean =>
  status?.screen === 'granted' && status.accessibility

export function isMacSetupOpen(): boolean {
  return window.api.platform === 'darwin' && !!document.querySelector('[data-mac-setup-dialog]')
}

export function MacSetupGate({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<MacPermissionStatus | null>(null)
  const [visible, setVisible] = useState(false)
  const [support, setSupport] = useState<MacPresentationSupport | null>(null)
  const [error, setError] = useState('')
  const [opened, setOpened] = useState<MacPrivacyPermission | null>(null)
  const [busy, setBusy] = useState(false)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const openedAtStartup = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const api = window.api.platform === 'darwin' ? window.api.macSetup : undefined
  const selectedFilePath = useAppStore((state) => state.selectedFile?.type === 'presentation' ? state.selectedFile.path : null)
  const selectedChannelPath = useAppStore((state) => {
    const file = state.selectedChannel ? state.channels[state.selectedChannel]?.file : null
    return file?.type === 'presentation' ? file.path : null
  })

  const openPrivacy = async (permission: MacPrivacyPermission): Promise<void> => {
    if (!api) return
    setError('')
    try { await api.openPrivacy(permission); setOpened(permission) }
    catch (error: unknown) { setError(`Не удалось открыть настройки: ${String(error)}`) }
  }

  useEffect(() => {
    if (!api) return
    let disposed = false
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const next = await api.permissions()
        if (disposed) return
        setStatus(next)
        if (!permissionsReady(next) && !openedAtStartup.current) {
          openedAtStartup.current = true
          setVisible(true)
          const permission = next.screen !== 'granted' ? 'screen' : 'accessibility'
          try { await api.openPrivacy(permission); if (!disposed) setOpened(permission) }
          catch (error: unknown) { if (!disposed) setError(`Не удалось открыть настройки: ${String(error)}`) }
        }
      } catch (error: unknown) {
        if (!disposed) { setVisible(true); setError(`Не удалось проверить разрешения: ${String(error)}`) }
      } finally { pending = false }
    }
    const checkOnFocus = (): void => { void refresh() }
    const showPresentationRequirement = (event: Event): void => {
      const next = (event as CustomEvent<MacPresentationSupport>).detail
      setSupport(next)
      if (next.installed && next.error) setError(next.error)
      setVisible(true)
      void refresh()
    }
    window.addEventListener(MAC_PRESENTATION_SETUP_EVENT, showPresentationRequirement)
    window.addEventListener('focus', checkOnFocus)
    const timer = setInterval(() => { if (visibleRef.current && document.hasFocus()) void refresh() }, 1500)
    void refresh()
    return () => {
      disposed = true
      clearInterval(timer)
      window.removeEventListener('focus', checkOnFocus)
      window.removeEventListener(MAC_PRESENTATION_SETUP_EVENT, showPresentationRequirement)
    }
  }, [api])

  useEffect(() => {
    if (api && (selectedFilePath || selectedChannelPath)) void requireMacPresentationSupport()
  }, [api, selectedFilePath, selectedChannelPath])

  useEffect(() => {
    if (!visible) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const trap = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); setVisible(false) }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === dialogRef.current)) {
          event.preventDefault(); buttons.at(-1)?.focus()
        } else if (!event.shiftKey && (document.activeElement === buttons.at(-1) || document.activeElement === dialogRef.current)) {
          event.preventDefault(); buttons[0]?.focus()
        }
      }
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', trap, true)
    return () => { window.removeEventListener('keydown', trap, true); if (previous?.isConnected) previous.focus() }
  }, [visible])

  const checkAgain = async (): Promise<void> => {
    if (!api) return
    setBusy(true); setError('')
    try {
      setStatus(await api.permissions())
      if (support) setSupport(await api.presentationSupport())
    } catch (error: unknown) { setError(`Проверка не завершена: ${String(error)}`) }
    finally { setBusy(false) }
  }
  const action = async (operation: () => Promise<void>): Promise<void> => {
    try { await operation() } catch (error: unknown) { setError(String(error)) }
  }
  const ready = permissionsReady(status) && (!support || support.installed)

  return <>
    <div className="mac-setup-workspace" inert={visible} aria-hidden={visible || undefined}>{children}</div>
    {api && visible && <div className="mac-setup-backdrop">
      <div data-mac-setup-dialog ref={dialogRef} className="mac-setup-dialog" tabIndex={-1} role="dialog" aria-modal="true" aria-label="Подготовка PDM на Mac">
        <button className="mac-setup-close" aria-label="Закрыть подготовку Mac" onClick={() => setVisible(false)}>×</button>
        <div className="mac-setup-label">PDM НА MAC</div>
        <h1>{ready ? 'Всё готово к работе' : support && !support.installed ? 'Для PPTX нужен Keynote' : 'Разрешим полноценный показ'}</h1>
        <p>В настройках macOS включите доступ именно для <strong>{__PDM_PRODUCT_NAME__}</strong>. У обычной и Stream-редакции отдельные разрешения.</p>
        {support && !support.installed && <section className="mac-setup-app" data-mac-keynote-required>
          <strong>Keynote не найден или недоступен</strong>
          <p>{support.error || MAC_KEYNOTE_REQUIRED_MESSAGE}</p>
          <button onClick={() => void action(api.openKeynoteDownload)}>Открыть Keynote в App Store</button>
        </section>}
        <div className="mac-setup-permissions">
          {([
            ['screen', 'Запись экрана и системного звука', 'Нужна для живого PPTX, захвата окон и трансляции.', status?.screen === 'granted'],
            ['accessibility', 'Универсальный доступ', 'Нужен для управления окнами Keynote, Word и Excel.', status?.accessibility === true]
          ] as const).map(([permission, title, detail, granted]) => <section key={permission} data-mac-permission={permission} data-granted={granted}>
            <div><strong><span className={granted ? 'mac-setup-ok' : 'mac-setup-missing'}>{granted ? '✓' : '○'}</span>{title}</strong><p>{detail}</p></div>
            <button data-mac-open-privacy={permission} onClick={() => void openPrivacy(permission)}>{granted ? 'Разрешено · настройки' : 'Открыть настройки'}</button>
          </section>)}
        </div>
        <div className="mac-setup-hint">
          <p>Конфиденциальность и безопасность → {opened === 'accessibility' ? 'Универсальный доступ' : 'Запись экрана и системного звука'}.</p>
          <p>Включите переключатель рядом с PDM. Если приложения нет в списке, нажмите «+» и добавьте запущенную копию. <button data-mac-show-application onClick={() => void action(api.showApplication)}>Показать PDM в Finder</button></p>
          <p>Если macOS предлагает закрыть и открыть PDM заново — соглашайтесь. После изменения записи экрана может понадобиться перезапуск.</p>
        </div>
        {error && <p role="alert" className="mac-setup-error">{error}</p>}
        <footer>
          <button data-mac-recheck disabled={busy} onClick={() => void checkAgain()}>{busy ? 'Проверяем…' : 'Проверить снова'}</button>
          {(ready || opened) && <button data-mac-restart onClick={() => void action(api.restart)}>Перезапустить PDM</button>}
          <button data-mac-continue className={ready ? 'mac-setup-primary' : ''} onClick={() => setVisible(false)}>{ready ? 'Продолжить' : 'Настроить позже'}</button>
        </footer>
      </div>
    </div>}
  </>
}
