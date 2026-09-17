import { useEffect, useRef, useState, type JSX } from 'react'
import { useAppStore } from '../../stores/useAppStore'

interface Lesson {
  title: string
  text: string
  selector: string
  kind: 'file' | 'fileSecond' | 'channel' | 'channelSecond' | 'take' | 'takeSecond' | 'slide' | 'click' | 'panel' | 'scene' | 'menu' | 'text' | 'publish' | 'draft' | 'refresh' | 'external' | 'chroma' | 'qr' | 'titles' | 'titlesPublish' | 'closedScene' | 'layout' | 'settings' | 'exit'
  panelSelector?: string
  panelHint?: string
  doneText?: string
  holdMs?: number
}

const lessons: Lesson[] = [
  { title: 'Перетащите первую презентацию', text: 'Возьмите мышкой «Открытие мероприятия» слева и перетащите её в первый пустой канал. Жёлтая стрелка показывает куда.', selector: '.pdm-main-workspace', kind: 'file' },
  { title: 'Добавьте ещё одну презентацию', text: 'В один проект можно заранее положить много презентаций. Перетащите «Доклад спикера» во второй канал.', selector: '.pdm-main-workspace', kind: 'fileSecond', doneText: 'Теперь оба материала готовы в соседних каналах. Так можно заранее собрать всю программу мероприятия.', holdMs: 4000 },
  { title: 'Выберите первый канал', text: 'Один раз нажмите на первый канал. Зелёная рамка означает: канал выбран. Красная рамка означает: его уже видят зрители.', selector: '.pdm-channel-card', kind: 'channel' },
  { title: 'Покажите первую презентацию', text: 'Нажмите красную кнопку «В эфир». В обучении настоящий экран зрителей не включится.', selector: '[data-toolbar-item="output"]', kind: 'take' },
  { title: 'Подготовьте следующий канал', text: 'Нажмите на второй канал. Он станет выбранным, но зрители пока продолжат видеть первый.', selector: '.pdm-channel-card', kind: 'channelSecond' },
  { title: 'Переключитесь без паузы', text: 'Нажмите красную кнопку «В эфир» прямо внутри второго канала. Вторая презентация сразу заменит первую — так материалы переключаются без закрытия показа и чёрного экрана.', selector: '[data-pdm-channel-take]', kind: 'takeSecond', doneText: 'В эфире уже второй канал. Первый остаётся готовым, и к нему можно так же быстро вернуться.', holdMs: 3500 },
  { title: 'Покажите второй слайд', text: 'Нажмите вторую картинку слайда справа.', selector: '.pdm-slide-navigator', kind: 'slide' },
  { title: 'Видео', text: 'Нажмите «Видео». Откроется окно, где можно выбрать ролики, поставить их на паузу, перемотать или повторить.', selector: '[data-toolbar-item="video"] button:first-child', kind: 'panel', panelSelector: '[data-pdm-training-panel="video"]' },
  { title: 'Музыка', text: 'Нажмите «Музыка». Откроется окно выбора фоновой музыки, громкости и повтора.', selector: '[data-toolbar-item="music"] button:first-child', kind: 'panel', panelSelector: '[data-pdm-training-panel="music"]' },
  { title: 'Фон', text: 'Нажмите «Фон». В обычной работе программа предложит выбрать картинку, которая будет находиться позади презентации.', selector: '[data-toolbar-item="backdrop"] button', kind: 'click', doneText: 'Учебный фон выбран. У этой кнопки нет отдельного окна настроек: повторное нажатие выключает фон.' },
  { title: 'Автоматическое переключение', text: 'Нажмите «Авто». Когда презентация закончится, программа сама перейдёт к следующему готовому каналу.', selector: '[data-toolbar-item="auto"] button', kind: 'click', doneText: 'Автоматическое переключение включено. Состояние всегда написано прямо на кнопке: «Вкл» или «Выкл».' },
  { title: 'Кликер', text: 'Посмотрите, что написано на кнопке, и нажмите её. Кликер переключится: включённый выключится, а выключенный включится.', selector: '[data-toolbar-item="clicker"] button', kind: 'click' },
  { title: 'Таймер доклада', text: 'Нажмите «Таймер доклада». Откроются время, кнопки запуска, оформление и звуковые сигналы.', selector: '[data-toolbar-item="timer"] button:first-child', kind: 'panel', panelSelector: '[data-pdm-training-panel="timer"]' },
  { title: 'Большой таймер', text: 'Нажмите «Таймер+». Откроется большой таймер мероприятия с дополнительными настройками.', selector: '[data-toolbar-item="eventTimer"] button:first-child', kind: 'panel', panelSelector: '[data-pdm-training-panel="event-timer"]' },
  { title: 'Другие экраны', text: 'Нажмите «Экраны». В открывшемся окне можно назначить суфлёр, информационный экран, копию показа или отдельный таймер.', selector: '[data-toolbar-item="displays"] button', kind: 'panel', panelSelector: '[data-pdm-display-modal]' },
  { title: 'Откройте Сцену', text: 'В Сцене можно собрать всё вместе: презентацию, камеру, фон, картинки, видео, надписи, QR-код, таймер и титры. Здесь же можно убрать зелёный фон у камеры.', selector: '[data-toolbar-item="pip"]', kind: 'scene' },
  { title: 'Откройте меню Сцены', text: 'Нажмите правой кнопкой мыши внутри большого окна предпросмотра. В этом меню добавляются все элементы Сцены.', selector: '[data-program-scene-preview]', kind: 'menu' },
  { title: 'Добавьте текст', text: 'В открытом меню выберите «Текст». Нажмите на появившуюся надпись и напечатайте свою. Клавиша Enter начнёт новую строку. Надпись можно двигать мышкой, а колёсиком менять её размер.', selector: '[data-program-scene-modal]', kind: 'text' },
  { title: 'Покажите подготовленную Сцену', text: 'Нажмите общую красную кнопку «Показать в эфире». Всё подготовленное в Сцене появится у зрителей одновременно.', selector: '[data-program-scene-picture-visible]', kind: 'publish' },
  { title: 'Измените надпись', text: 'Покрутите колесо над текстом или перетащите его. Пока вы редактируете Сцену, зрители не увидят эти перемещения.', selector: '[data-program-scene-preview]', kind: 'draft' },
  { title: 'Обновите эфир', text: 'Нажмите круглую стрелку ↻. После этого зрители увидят все подготовленные изменения.', selector: '[data-program-scene-refresh]', kind: 'refresh' },
  { title: 'Добавьте камеру', text: 'Нажмите «Выберите внешний источник», затем выберите учебную камеру. В работе здесь появятся подключённые камеры, платы захвата, окна и экраны.', selector: '[data-program-scene-select-external-source]', kind: 'external' },
  { title: 'Включите хромакей', text: 'Нажмите правой кнопкой на изображение камеры, выберите «Хромакей» и поставьте галочку «Включён». Эти настройки убирают зелёный или синий фон только внутри камеры.', selector: '[data-program-scene-participant-preview]', kind: 'chroma', doneText: 'Зелёный фон камеры удалён. Кнопки «Картинка», «Видео» и «Канал» позволяют подложить изображение только вместо зелёнки.', holdMs: 3500 },
  { title: 'Добавьте QR-код', text: 'Нажмите правой кнопкой в предпросмотре, выберите «QR-код» и введите полный адрес, например https://example.ru. Когда закончите ввод, нажмите внутри предпросмотра: QR можно двигать мышкой и менять колёсиком.', selector: '[data-program-scene-preview]', kind: 'qr', doneText: 'QR-код готов. Посмотрите результат в предпросмотре: его можно перетаскивать мышкой и менять колёсиком.', holdMs: 6000 },
  { title: 'Подготовьте титры', text: 'Откройте вкладку «Титры». Полностью введите ФИО выступающего и название мероприятия, затем нажмите внутри предпросмотра, чтобы спокойно посмотреть результат.', selector: '[data-program-scene-modal] [data-scene-panel="titles"]', kind: 'titles', doneText: 'ФИО и название мероприятия готовы. В большом предпросмотре видно, как титры будут выглядеть у зрителей.', holdMs: 5000 },
  { title: 'Покажите титры', text: 'Нажмите красную кнопку «Показать все». Отдельными кнопками «Выступающий» и «Мероприятие» можно выводить каждый титр по отдельности.', selector: '[data-broadcast-titles-show-all]', kind: 'titlesPublish', doneText: 'Оба титра показаны поверх выбранной камеры. Настройки времени могут скрыть каждый из них автоматически.', holdMs: 3500 },
  { title: 'Закройте Сцену', text: 'Закройте окно крестиком. Все настройки останутся в учебном черновике.', selector: '[data-program-scene-modal] > div:first-child button:last-child', kind: 'closedScene', doneText: 'Сцена закрыта, а подготовленные настройки сохранены. Открыть её снова можно той же кнопкой на панели.', holdMs: 4000 },
  { title: 'Три вида Сцены', text: 'Первая кнопка показывает человека, вторая — презентацию, третья — человека и презентацию вместе. Нажмите среднюю кнопку.', selector: '[data-toolbar-item="pipViews"] button:nth-child(2)', kind: 'layout' },
  { title: 'Настройки звука', text: 'Нажмите «Настройки». В разделе «Аудиовыход» выберите учебный «Проектор / HDMI», затем закройте окно крестиком.', selector: '[data-toolbar-item="settings"] button', kind: 'settings', panelSelector: '[data-pdm-training-panel="settings"]', panelHint: 'Выберите «Проектор / HDMI (учебный)», затем закройте настройки крестиком' },
  { title: 'Стрим', text: 'Нажмите «Стрим». Здесь выбираются площадки, качество изображения и звук. Дополнительный монитор для стрима не обязателен.', selector: '[data-toolbar-item="stream"] button', kind: 'panel', panelSelector: '[data-pdm-training-panel="stream"]' },
  { title: 'Завершите показ', text: 'Нажмите «Выйти из эфира». Канал и общая Сцена синхронно перестанут быть активными.', selector: '[data-toolbar-item="output"]', kind: 'exit' }
]

interface Rect { left: number; top: number; right: number; bottom: number }
interface DragGuide { fromX: number; fromY: number; toX: number; toY: number }
export const LAST_INTERFACE_TOUR_STEP = lessons.length - 1

export function InterfaceTour({ initialStep }: { initialStep: number }): JSX.Element {
  const [step, setStep] = useState(Math.min(initialStep, LAST_INTERFACE_TOUR_STEP))
  const [ready, setReady] = useState(false)
  const [finished, setFinished] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [panelVisible, setPanelVisible] = useState(false)
  const [actionResult, setActionResult] = useState('')
  const [rect, setRect] = useState<Rect>({ left: 0, top: 0, right: 0, bottom: 0 })
  const [dragGuide, setDragGuide] = useState<DragGuide | null>(null)
  const [dragSourceRect, setDragSourceRect] = useState<Rect | null>(null)
  const [moveGuide, setMoveGuide] = useState<Rect | null>(null)
  const baseline = useRef('')
  const revision = useRef(0)
  const edited = useRef(false)
  const clicked = useRef(false)
  const panelOpened = useRef(false)
  const audioSelected = useRef(false)
  const advancing = useRef(false)
  const readyStep = useRef(-1)
  const current = lessons[step]
  const notify = (completed = false, close = false): void => {
    window.parent.postMessage({ kind: 'pdm-training-progress', step, completed, close }, '*')
  }

  useEffect(() => { notify() }, [step])
  useEffect(() => {
    window.parent.postMessage({ kind: 'pdm-training-panel-hint', open: panelVisible, title: current.title, text: current.panelHint }, '*')
    return () => { window.parent.postMessage({ kind: 'pdm-training-panel-hint', open: false }, '*') }
  }, [panelVisible, current.title, current.panelHint])
  useEffect(() => {
    baseline.current = ''; edited.current = false; clicked.current = false; panelOpened.current = false; audioSelected.current = false; advancing.current = false; readyStep.current = -1
    revision.current = useAppStore.getState().programSnapshot?.revision ?? 0
    setReady(false); setPanelVisible(false); setActionResult('')
    const input = (event: Event): void => { if ((event.target as Element).closest('[data-program-scene-inline-text]')) edited.current = true }
    const click = (event: MouseEvent): void => {
      if (advancing.current) return
      if (current.kind === 'click' && (event.target as Element).closest(current.selector)) clicked.current = true
      if (current.kind === 'settings' && (event.target as Element).closest('[data-pdm-audio-device="training-hdmi"]')) audioSelected.current = true
    }
    document.addEventListener('input', input)
    document.addEventListener('click', click, true)
    const inspect = (): void => {
      const s = useAppStore.getState()
      const firstChannelId = s.channelIds[0]
      const secondChannelId = s.channelIds[1]
      const channel = s.channels[firstChannelId]
      const secondChannel = s.channels[secondChannelId]
      const firstChannelElement = document.querySelector<HTMLElement>(`[data-pdm-channel-id="${firstChannelId}"]`)
      const secondChannelElement = document.querySelector<HTMLElement>(`[data-pdm-channel-id="${secondChannelId}"]`)
      const scene = document.querySelector<HTMLElement>('[data-program-scene-modal]')
      const panel = current.panelSelector ? document.querySelector<HTMLElement>(current.panelSelector) : null
      const text = document.querySelector<HTMLElement>('[data-program-scene-text-id]')
      const textContent = text?.querySelector<HTMLElement>('[data-program-scene-inline-text]')?.innerText.trim() ?? ''
      const geometry = text ? `${text.style.left}|${text.style.top}|${text.style.width}|${text.style.fontSize}` : ''
      if (current.kind === 'draft' && geometry && !baseline.current) baseline.current = geometry
      let complete = false
      if (current.kind === 'file') complete = !!channel?.file
      if (current.kind === 'fileSecond') complete = !!secondChannel?.file
      if (current.kind === 'channel') complete = !!channel?.file && s.selectedChannel === s.channelIds[0]
      if (current.kind === 'channelSecond') complete = !!secondChannel?.file && s.selectedChannel === secondChannelId
      if (current.kind === 'take') complete = !!s.activeFile && s.liveChannel === s.channelIds[0] && firstChannelElement?.getAttribute('aria-busy') !== 'true'
      if (current.kind === 'takeSecond') complete = !!s.activeFile && s.liveChannel === secondChannelId && secondChannelElement?.getAttribute('aria-busy') !== 'true'
      if (current.kind === 'slide') complete = s.currentSlide === 2
      if (current.kind === 'click') complete = clicked.current
      if (current.kind === 'panel') {
        if (panel) panelOpened.current = true
        const optionalStreamMissing = current.title === 'Стрим' && !document.querySelector('[data-toolbar-item="stream"]')
        complete = optionalStreamMissing || (panelOpened.current && !panel)
        setPanelVisible(!!panel)
      }
      if (current.kind === 'settings') {
        if (panel) panelOpened.current = true
        if (document.querySelector('[data-pdm-audio-device="training-hdmi"][aria-pressed="true"]')) audioSelected.current = true
        complete = panelOpened.current && audioSelected.current && !panel
        setPanelVisible(!!panel)
      }
      if (current.kind === 'scene') complete = !!scene
      if (current.kind === 'menu') complete = !!document.querySelector('[data-scene-add="text"]')
      if (current.kind === 'text') complete = edited.current && !!textContent
      if (current.kind === 'publish') complete = s.programScene.enabled && s.programOutputStatus.phase === 'live'
      if (current.kind === 'draft') complete = !!geometry && geometry !== baseline.current
      if (current.kind === 'refresh') complete = (s.programSnapshot?.revision ?? 0) > revision.current && s.programOutputStatus.phase === 'live'
      if (current.kind === 'external') complete = !!s.programScene.captureSourceId
      if (current.kind === 'chroma') complete = s.programScene.chromaKey.enabled
      if (current.kind === 'qr') {
        const qrInput = document.querySelector<HTMLElement>('[data-pdm-training-qr-url]')
        let validAddress = false
        try {
          const address = new URL(s.qrOverlay.url.trim())
          validAddress = (address.protocol === 'http:' || address.protocol === 'https:') && !!address.hostname
        } catch { /* wait for a complete address */ }
        complete = s.qrOverlay.sceneVisible !== false && validAddress && document.activeElement !== qrInput
      }
      if (current.kind === 'titles') {
        const selectedSpeaker = s.broadcastTitles.speakers.find(speaker => speaker.id === s.broadcastTitles.selectedSpeakerId)
        const speakerInput = document.querySelector<HTMLElement>('[data-pdm-training-speaker-name]')
        const eventInput = document.querySelector<HTMLElement>('[data-pdm-training-event-info]')
        complete = document.querySelector('[data-scene-panel="titles"]')?.getAttribute('aria-selected') === 'true' &&
          (selectedSpeaker?.name.trim().length ?? 0) >= 3 && s.broadcastTitles.eventInfo.trim().length >= 4 &&
          document.activeElement !== speakerInput && document.activeElement !== eventInput
      }
      if (current.kind === 'titlesPublish') complete =
        document.querySelector('[data-broadcast-titles-speaker-visible]')?.getAttribute('aria-pressed') === 'true' &&
        document.querySelector('[data-broadcast-titles-event-visible]')?.getAttribute('aria-pressed') === 'true'
      if (current.kind === 'closedScene') complete = !scene
      if (current.kind === 'layout') complete = s.programScene.viewMode === 'content'
      if (current.kind === 'exit') complete = !s.activeFile && !s.programScene.enabled
      if (complete && current.kind === 'click' && current.title === 'Кликер') {
        setActionResult(s.globalHookEnabled
          ? 'Кликер включён. На кнопке теперь написано «Вкл». Ещё одно нажатие снова его выключит.'
          : 'Кликер выключен. На кнопке теперь написано «Выкл». Ещё одно нажатие снова его включит.')
      }
      if (complete) readyStep.current = step
      setReady(complete)
      let target = document.querySelector<HTMLElement>(current.selector)
      if (panel) target = panel
      if (current.kind === 'file') target = document.querySelector<HTMLElement>(`[data-pdm-channel-id="${firstChannelId}"]`) ?? target
      if (current.kind === 'fileSecond') target = document.querySelector<HTMLElement>(`[data-pdm-channel-id="${secondChannelId}"]`) ?? target
      if (current.kind === 'channel') target = document.querySelector<HTMLElement>(`[data-pdm-channel-id="${firstChannelId}"]`) ?? target
      if (current.kind === 'channelSecond') target = document.querySelector<HTMLElement>(`[data-pdm-channel-id="${secondChannelId}"]`) ?? target
      if (current.kind === 'takeSecond') target = document.querySelector<HTMLElement>(`[data-pdm-channel-id="${secondChannelId}"] [data-pdm-channel-take]`) ?? target
      if (current.kind === 'external') target = document.querySelector<HTMLElement>('[data-scene-external-source-picker]') ?? target
      if (current.kind === 'chroma') target = document.querySelector<HTMLElement>('[data-program-scene-chroma-toggle]') ?? document.querySelector<HTMLElement>('[data-scene-object-action="chroma"]') ?? target
      if (current.kind === 'qr') target = document.querySelector<HTMLElement>('[data-pdm-training-qr-url]') ?? document.querySelector<HTMLElement>('[data-scene-add="qr"]') ?? target
      if (current.kind === 'titles') {
        const titlesActive = document.querySelector('[data-scene-panel="titles"]')?.getAttribute('aria-selected') === 'true'
        if (titlesActive) {
          const speakerInput = document.querySelector<HTMLElement>('[data-pdm-training-speaker-name]')
          const eventInput = document.querySelector<HTMLElement>('[data-pdm-training-event-info]')
          const selectedSpeaker = s.broadcastTitles.speakers.find(speaker => speaker.id === s.broadcastTitles.selectedSpeakerId)
          if (document.activeElement === speakerInput || (selectedSpeaker?.name.trim().length ?? 0) < 3) target = speakerInput ?? target
          else if (document.activeElement === eventInput || s.broadcastTitles.eventInfo.trim().length < 4) target = eventInput ?? target
          else target = document.querySelector<HTMLElement>('[data-broadcast-titles-preview]') ?? target
        }
      }
      if (current.kind === 'qr' && complete) target = document.querySelector<HTMLElement>('[data-program-scene-preview]') ?? target
      if ((current.kind === 'scene' || current.kind === 'text' || current.kind === 'menu' || current.kind === 'draft') && scene) target = scene
      if (target) {
        const r = target.getBoundingClientRect()
        const next = { left: Math.max(0, r.left - 5), top: Math.max(0, r.top - 5), right: Math.min(innerWidth, r.right + 5), bottom: Math.min(innerHeight, r.bottom + 5) }
        setRect(old => Object.keys(next).every(key => Math.abs(old[key as keyof Rect] - next[key as keyof Rect]) < 1) ? old : next)
      }
      if (current.kind === 'file' || current.kind === 'fileSecond') {
        const index = current.kind === 'fileSecond' ? 1 : 0
        const sourceId = index === 1 ? 'pdm-training-deck-2' : 'pdm-training-deck'
        const source = document.querySelector<HTMLElement>(`[data-pdm-file-id="${sourceId}"]`)?.getBoundingClientRect()
        const destinationId = current.kind === 'fileSecond' ? secondChannelId : firstChannelId
        const destination = document.querySelector<HTMLElement>(`[data-pdm-channel-id="${destinationId}"]`)?.getBoundingClientRect()
        if (source && destination) {
          const next = {
            fromX: source.right - 8,
            fromY: source.top + source.height / 2,
            toX: destination.left + Math.min(100, destination.width * .22),
            toY: destination.top + destination.height / 2
          }
          setDragGuide(old => old && Object.keys(next).every(key => Math.abs(old[key as keyof DragGuide] - next[key as keyof DragGuide]) < 1) ? old : next)
          const nextSource = { left: source.left - 4, top: source.top - 4, right: source.right + 4, bottom: source.bottom + 4 }
          setDragSourceRect(old => old && Object.keys(nextSource).every(key => Math.abs(old[key as keyof Rect] - nextSource[key as keyof Rect]) < 1) ? old : nextSource)
        }
      } else {
        setDragGuide(null)
        setDragSourceRect(null)
      }
      if (current.kind === 'draft' && text) {
        const r = text.getBoundingClientRect()
        const next = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
        setMoveGuide(old => old && Object.keys(next).every(key => Math.abs(old[key as keyof Rect] - next[key as keyof Rect]) < 1) ? old : next)
      } else setMoveGuide(null)
    }
    const timer = setInterval(inspect, 100); inspect()
    return () => { clearInterval(timer); document.removeEventListener('input', input); document.removeEventListener('click', click, true) }
  }, [step])

  useEffect(() => {
    if (!ready || readyStep.current !== step || finished || advancing.current) return
    if (current.doneText || actionResult) return
    advancing.current = true
    const timer = window.setTimeout(() => {
      if (step === LAST_INTERFACE_TOUR_STEP) { setFinished(true); notify(true); return }
      setStep(value => value + 1)
    }, current.holdMs ?? (current.kind === 'click' ? 4000 : 650))
    return () => clearTimeout(timer)
  }, [ready, finished, step, actionResult, current.doneText])

  const continueAfterResult = (): void => {
    if (!ready || finished || !(current.doneText || actionResult)) return
    advancing.current = false
    setStep(value => Math.min(value + 1, LAST_INTERFACE_TOUR_STEP))
  }

  const width = Math.min(340, innerWidth - 24)
  const defaultLeft = rect.right + width + 20 < innerWidth ? rect.right + 12 : rect.left > width + 20 ? rect.left - width - 12 : innerWidth - width - 16
  const qrInputOpen = current.kind === 'qr' && !!document.querySelector('[data-pdm-training-qr-url]')
  const qrPreviewRect = current.kind === 'qr'
    ? document.querySelector<HTMLElement>('[data-program-scene-preview]')?.getBoundingClientRect()
    : undefined
  const qrInstructionLeft = qrInputOpen
    ? Math.min(innerWidth - width - 16, Math.max(16, rect.left))
    : qrPreviewRect
      ? Math.min(innerWidth - width - 16, Math.max(16, qrPreviewRect.right + 12))
      : defaultLeft
  const left = current.kind === 'qr' && !ready
    ? qrInstructionLeft
    : defaultLeft
  const top = rect.bottom + 335 < innerHeight ? rect.bottom + 12 : Math.max(14, innerHeight - 360)
  const dragStep = current.kind === 'file' || current.kind === 'fileSecond'
  const formStep = current.kind === 'qr' || current.kind === 'titles'
  return <div className={`interface-tour${dragStep ? ' is-drag-step' : ''}${formStep ? ' is-form-step' : ''}`} data-pdm-training-tour>
    {!finished && <>
      <div className="interface-tour-shade" style={{ inset: '0 0 auto 0', height: rect.top }} />
      <div className="interface-tour-shade" style={{ left: 0, top: rect.top, width: rect.left, height: rect.bottom - rect.top }} />
      <div className="interface-tour-shade" style={{ right: 0, top: rect.top, width: innerWidth - rect.right, height: rect.bottom - rect.top }} />
      <div className="interface-tour-shade" style={{ inset: `${rect.bottom}px 0 0 0` }} />
      <div className="interface-tour-outline" style={{ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }} />
      {dragSourceRect && <div className="interface-tour-drag-source" aria-hidden="true" style={{ left: dragSourceRect.left, top: dragSourceRect.top, width: dragSourceRect.right - dragSourceRect.left, height: dragSourceRect.bottom - dragSourceRect.top }} />}
      {dragGuide && <svg className="interface-tour-drag-guide" aria-hidden="true" viewBox={`0 0 ${innerWidth} ${innerHeight}`}>
        <defs><marker id="training-arrow-head" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" /></marker></defs>
        <path d={`M ${dragGuide.fromX} ${dragGuide.fromY} C ${dragGuide.fromX + 80} ${dragGuide.fromY - 45}, ${dragGuide.toX - 100} ${dragGuide.toY - 45}, ${dragGuide.toX} ${dragGuide.toY}`} markerEnd="url(#training-arrow-head)" />
        <text x={dragGuide.toX - 8} y={dragGuide.toY - 18} textAnchor="end">Перетащите сюда</text>
      </svg>}
      {moveGuide && <div className="interface-tour-move-guide" aria-hidden="true" style={{ left: moveGuide.left + (moveGuide.right - moveGuide.left) / 2, top: moveGuide.top - 22 }}>↔ ↕</div>}
    </>}
    {panelVisible ? null : collapsed ? <button className="interface-tour-chip" onClick={() => setCollapsed(false)}>Шаг {step + 1} · Развернуть подсказку</button>
      : <section className="interface-tour-card" style={{ left, top, width }} aria-live="polite">
        <header><span>{finished ? 'Знакомство пройдено' : `Шаг ${step + 1} из ${lessons.length}`}</span><button title="Свернуть подсказку" aria-label="Свернуть подсказку" onClick={() => setCollapsed(true)}>−</button></header>
        {!finished && <div className="interface-tour-progress"><i style={{ width: `${(step + 1) / lessons.length * 100}%` }} /></div>}
        <h3>{finished ? 'Теперь вы знаете, как пользоваться PDM' : ready && (actionResult || current.doneText) ? 'Готово' : current.title}</h3>
        <p>{finished ? 'Вы прошли основной рабочий маршрут PDM и кратко познакомились со всеми разделами верхней панели и Сцены. Учебные данные будут удалены при выходе; рабочие материалы остались нетронутыми.' : ready && (actionResult || current.doneText) ? actionResult || current.doneText : current.text}</p>
        {!finished && <small>{ready ? current.doneText || actionResult ? '✓ Готово — прочитайте и нажмите «Далее»' : '✓ Готово — переходим дальше…' : 'Выполните действие в выделенной области'}</small>}
        <div>
          {!finished && <button disabled={step === 0 || ready} onClick={() => setStep(value => value - 1)}>Назад</button>}
          {!finished && ready && (current.doneText || actionResult) && <button className="interface-tour-next" onClick={continueAfterResult}>Далее</button>}
          {finished && <button className="interface-tour-next" onClick={() => notify(true, true)}>Перейти к работе</button>}
        </div>
        {!finished && <button className="interface-tour-later" onClick={() => notify(false, true)}>Продолжить позже</button>}
      </section>}
  </div>
}
