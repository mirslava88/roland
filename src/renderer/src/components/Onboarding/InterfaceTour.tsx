import { useEffect, useRef, useState, type JSX } from 'react'
import { useAppStore } from '../../stores/useAppStore'

interface Lesson {
  title: string
  text: string
  selector: string
  kind: 'file' | 'fileSecond' | 'channel' | 'channelSecond' | 'take' | 'takeSecond' | 'slide' | 'click' | 'panel' | 'scene' | 'menu' | 'text' | 'publish' | 'draft' | 'refresh' | 'external' | 'chroma' | 'qr' | 'titles' | 'titlesPublish' | 'closedScene' | 'layout' | 'settings' | 'virtualCamera' | 'exit'
  panelSelector?: string
  panelHint?: string
  doneText?: string
  holdMs?: number
}

const lessons: Lesson[] = [
  { title: 'Перетяните первую презентацию', text: 'Возьмите мышкой «Открытие мероприятия» слева и перетяните её в первый пустой канал. Жёлтая стрелка показывает куда.', selector: '.pdm-main-workspace', kind: 'file' },
  { title: 'Добавьте ещё одну презентацию', text: 'В один проект можно заранее добавить много презентаций. Перетяните «Доклад спикера» во второй канал.', selector: '.pdm-main-workspace', kind: 'fileSecond', doneText: 'Обе презентации готовы к показу. Таким же способом можно заранее заполнить остальные каналы.', holdMs: 4000 },
  { title: 'Выберите первый канал', text: 'Один раз нажмите на первый канал. Зелёная рамка означает: канал выбран. Красная рамка означает: его уже видят зрители.', selector: '.pdm-channel-card', kind: 'channel' },
  { title: 'Покажите первую презентацию', text: 'Нажмите красную кнопку «В эфир», на дополнительном мониторе зрители увидят презентацию.', selector: '[data-toolbar-item="output"]', kind: 'take' },
  { title: 'Подготовьте следующую презентацию', text: 'Нажмите на второй канал. Он будет готов к показу, а зрители продолжат видеть первую презентацию.', selector: '.pdm-channel-card', kind: 'channelSecond' },
  { title: 'Бесшовное переключение между презентациями', text: 'Нажмите красную кнопку «В эфир» внутри второго канала. Вторая презентация сразу заменит первую — так материалы переключаются бесшовно.', selector: '[data-pdm-channel-take]', kind: 'takeSecond', doneText: 'Теперь зрители видят вторую презентацию. Первый канал остаётся готовым, и к нему можно быстро вернуться.', holdMs: 3500 },
  { title: 'Переключите слайд', text: 'Нажмите на второй слайд справа. У зрителей сразу откроется выбранная страница презентации.', selector: '.pdm-slide-navigator', kind: 'slide' },
  { title: 'Показ видео', text: 'Нажмите «Видео». Здесь можно выбрать ролик, запустить его, поставить на паузу, перемотать или включить повтор.', selector: '[data-toolbar-item="video"] button:first-child', kind: 'panel', panelSelector: '[data-pdm-training-panel="video"]' },
  { title: 'Фоновая музыка', text: 'Нажмите «Музыка». Здесь можно добавить музыку, настроить громкость и включить повтор.', selector: '[data-toolbar-item="music"] button:first-child', kind: 'panel', panelSelector: '[data-pdm-training-panel="music"]' },
  { title: 'Фоновое изображение', text: 'Нажмите «Фон», чтобы добавить изображение позади презентации.', selector: '[data-toolbar-item="backdrop"] button', kind: 'click', doneText: 'Фон включён. Повторное нажатие на кнопку выключит его.' },
  { title: 'Автоматическое переключение', text: 'Нажмите «Авто». Когда презентация закончится, программа сама перейдёт к следующему готовому каналу.', selector: '[data-toolbar-item="auto"] button', kind: 'click', doneText: 'Автоматическое переключение включено. Состояние всегда написано прямо на кнопке: «Вкл» или «Выкл».' },
  { title: 'Управление кликером', text: 'Нажмите «Кликер». Когда он включён, пульт переключает слайды, даже если PDM свёрнут или вы открыли другое окно. Когда выключен — пульт работает только в активном окне PDM.', selector: '[data-toolbar-item="clicker"] button', kind: 'click' },
  { title: 'Таймер доклада', text: 'Нажмите «Таймер доклада». Здесь задаются время выступления, оформление и звуковые предупреждения. В одном окне предпросмотра можно подготовить положение таймера для основного эфира или суфлёра и передать его на выбранный экран круглой стрелкой ↻.', selector: '[data-toolbar-item="timer"] button:first-child', kind: 'panel', panelSelector: '[data-pdm-training-panel="timer"]' },
  { title: 'Таймер мероприятия', text: 'Нажмите «Таймер+». Здесь можно настроить большой таймер для всего мероприятия.', selector: '[data-toolbar-item="eventTimer"] button:first-child', kind: 'panel', panelSelector: '[data-pdm-training-panel="event-timer"]' },
  { title: 'Настройка экранов', text: 'Нажмите «Экраны». Здесь можно назначить основной эфир, суфлёр, информационный экран, копию показа или отдельный таймер.', selector: '[data-toolbar-item="displays"] button', kind: 'panel', panelSelector: '[data-pdm-display-modal]' },
  { title: 'Сцена для эфира', text: 'Нажмите «Сцена». Здесь можно объединить презентацию, камеру, фон, изображения, видео, текст, QR-код, таймер и титры.', selector: '[data-toolbar-item="pip"]', kind: 'scene' },
  { title: 'Добавьте элемент в Сцену', text: 'Нажмите правой кнопкой мыши внутри большого окна предпросмотра. В открывшемся меню выберите, что добавить в Сцену.', selector: '[data-program-scene-preview]', kind: 'menu' },
  { title: 'Добавьте текст', text: 'В открытом меню выберите «Текст». Нажмите на появившуюся надпись и напечатайте свою. Клавиша Enter начнёт новую строку. Надпись можно двигать мышкой, а колёсиком менять её размер.', selector: '[data-program-scene-modal]', kind: 'text' },
  { title: 'Покажите Сцену', text: 'Нажмите общую красную кнопку «Показать в эфире». Все добавленные элементы одновременно появятся у зрителей.', selector: '[data-program-scene-picture-visible]', kind: 'publish' },
  { title: 'Измените текст', text: 'Покрутите колесо над текстом, чтобы изменить его размер, или переместите текст мышкой. Изменения сначала появятся только в предпросмотре.', selector: '[data-program-scene-preview]', kind: 'draft' },
  { title: 'Обновите изображение в эфире', text: 'Нажмите круглую стрелку ↻. После этого зрители увидят подготовленные изменения.', selector: '[data-program-scene-refresh]', kind: 'refresh' },
  { title: 'Добавьте камеру', text: 'Нажмите «Выберите внешний источник» и выберите камеру. Здесь также можно использовать плату видеозахвата, окно программы или экран.', selector: '[data-program-scene-select-external-source]', kind: 'external' },
  { title: 'Уберите зелёный фон', text: 'Нажмите правой кнопкой на изображение камеры, выберите «Хромакей» и включите его. Зелёный или синий фон камеры станет прозрачным.', selector: '[data-program-scene-participant-preview]', kind: 'chroma', doneText: 'Хромакей включён. Вместо удалённого фона можно показать картинку, видео или материал из канала.', holdMs: 3500 },
  { title: 'Добавьте QR-код', text: 'Нажмите правой кнопкой в предпросмотре, выберите «QR-код» и введите полный адрес, например https://example.ru. Затем перетяните появившийся QR-код в нужное место. Размер меняется колёсиком.', selector: '[data-program-scene-preview]', kind: 'qr', doneText: 'QR-код готов. В предпросмотре видно, где он появится у зрителей.', holdMs: 6000 },
  { title: 'Добавьте титры', text: 'Откройте вкладку «Титры», заполните ФИО выступающего и название мероприятия. Затем нажмите на предпросмотр титров слева — так вы подтвердите готовый результат.', selector: '[data-program-scene-modal] [data-scene-panel="titles"]', kind: 'titles', doneText: 'Титры готовы к показу. Проверьте их расположение и оформление в предпросмотре.', holdMs: 5000 },
  { title: 'Покажите титры', text: 'Нажмите красную кнопку «Показать все». Отдельными кнопками «Выступающий» и «Мероприятие» можно выводить каждый титр по отдельности.', selector: '[data-broadcast-titles-show-all]', kind: 'titlesPublish', doneText: 'Оба титра показаны поверх выбранной камеры. Настройки времени могут скрыть каждый из них автоматически.', holdMs: 3500 },
  { title: 'Закройте Сцену', text: 'Закройте окно крестиком. Подготовленная Сцена сохранится, и её можно будет открыть снова.', selector: '[data-program-scene-modal] > div:first-child button:last-child', kind: 'closedScene', doneText: 'Сцена сохранена. Открыть её снова можно той же кнопкой на панели.', holdMs: 4000 },
  { title: 'Выберите вид Сцены', text: 'Первая кнопка показывает участника, вторая — презентацию, третья — участника и презентацию вместе. Нажмите среднюю кнопку.', selector: '[data-toolbar-item="pipViews"] button:nth-child(2)', kind: 'layout' },
  { title: 'Выберите аудиовыход', text: 'Нажмите «Настройки». В разделе «Аудиовыход» выберите «Проектор / HDMI». Настройки закрывать не нужно — сразу перейдём к виртуальной камере.', selector: '[data-toolbar-item="settings"] button', kind: 'settings', panelSelector: '[data-pdm-training-panel="settings"]', panelHint: 'Выберите «Проектор / HDMI (учебный)» — затем перейдём к виртуальной камере' },
  { title: 'Виртуальная камера', text: 'Если настройки закрыты, откройте их. Перейдите во вкладку «Виртуальная камера» и включите её. После этого PDM можно выбрать как обычную камеру в программе видеосвязи.', selector: '[data-toolbar-item="settings"] button', kind: 'virtualCamera', panelSelector: '[data-pdm-training-panel="settings"]', panelHint: 'Жёлтой рамкой выделена вкладка «Виртуальная камера». Откройте её, нажмите «Включить камеру», затем закройте настройки крестиком', doneText: 'В программе видеосвязи выберите «PDM Virtual Camera». Функция доступна в Windows 11 и новее и передаёт только изображение — микрофон или звуковую карту выберите отдельно.' },
  { title: 'Настройте трансляцию', text: 'Нажмите «Стрим». Здесь выбираются площадка, качество изображения и звук. Трансляцию можно запустить и без дополнительного монитора.', selector: '[data-toolbar-item="stream"] button', kind: 'panel', panelSelector: '[data-pdm-training-panel="stream"]' },
  { title: 'Завершите показ', text: 'Нажмите «Выйти из эфира». Презентация и элементы Сцены исчезнут с экрана зрителей.', selector: '[data-toolbar-item="output"]', kind: 'exit' }
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
  const [requiredFieldRects, setRequiredFieldRects] = useState<Rect[]>([])
  const [actionButtonRect, setActionButtonRect] = useState<Rect | null>(null)
  const [rightClickGuideRect, setRightClickGuideRect] = useState<Rect | null>(null)
  const [virtualCameraStage, setVirtualCameraStage] = useState<'tab' | 'enable' | 'close'>('tab')
  const baseline = useRef('')
  const revision = useRef(0)
  const edited = useRef(false)
  const clicked = useRef(false)
  const panelOpened = useRef(false)
  const audioSelected = useRef(false)
  const virtualCameraEnabled = useRef(false)
  const qrDragStart = useRef<{ x: number; y: number } | null>(null)
  const qrMoved = useRef(false)
  const titlesConfirmed = useRef(false)
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
    baseline.current = ''; edited.current = false; clicked.current = false; panelOpened.current = false; audioSelected.current = false; virtualCameraEnabled.current = false; qrDragStart.current = null; qrMoved.current = false; titlesConfirmed.current = false; advancing.current = false; readyStep.current = -1
    revision.current = useAppStore.getState().programSnapshot?.revision ?? 0
    setReady(false); setPanelVisible(false); setActionResult(''); setActionButtonRect(null); setRightClickGuideRect(null); setVirtualCameraStage('tab')
    const input = (event: Event): void => { if ((event.target as Element).closest('[data-program-scene-inline-text]')) edited.current = true }
    const click = (event: MouseEvent): void => {
      if (advancing.current) return
      if (current.kind === 'click' && (event.target as Element).closest(current.selector)) clicked.current = true
      if (current.kind === 'layout' && (event.target as Element).closest(current.selector)) clicked.current = true
      if (current.kind === 'closedScene' && (event.target as Element).closest(current.selector)) clicked.current = true
      if (current.kind === 'settings' && (event.target as Element).closest('[data-pdm-audio-device="training-hdmi"]')) audioSelected.current = true
      if (current.kind === 'titles' && (event.target as Element).closest('[data-broadcast-titles-preview]')) titlesConfirmed.current = true
    }
    const pointerDown = (event: PointerEvent): void => {
      if (current.kind !== 'qr' || !(event.target as Element).closest('[data-scene-qr-object]')) return
      qrDragStart.current = { x: event.clientX, y: event.clientY }
    }
    const pointerMove = (event: PointerEvent): void => {
      const start = qrDragStart.current
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return
      qrMoved.current = true
    }
    const pointerEnd = (): void => { qrDragStart.current = null }
    document.addEventListener('input', input)
    document.addEventListener('click', click, true)
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('pointermove', pointerMove, true)
    document.addEventListener('pointerup', pointerEnd, true)
    document.addEventListener('pointercancel', pointerEnd, true)
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
      const slideThumbs = document.querySelectorAll<HTMLElement>('.pdm-slide-thumb')
      slideThumbs.forEach(thumb => {
        thumb.toggleAttribute('data-pdm-training-clear-slide-border', current.kind === 'slide')
        if (current.kind === 'slide') thumb.style.setProperty('border-color', 'transparent', 'important')
        else thumb.style.removeProperty('border-color')
      })
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
        const optionalStreamMissing = current.panelSelector === '[data-pdm-training-panel="stream"]' && !document.querySelector('[data-toolbar-item="stream"]')
        complete = optionalStreamMissing || (panelOpened.current && !panel)
        setPanelVisible(!!panel)
      }
      if (current.kind === 'settings') {
        if (panel) panelOpened.current = true
        if (document.querySelector('[data-pdm-audio-device="training-hdmi"][aria-pressed="true"]')) audioSelected.current = true
        complete = panelOpened.current && audioSelected.current
        setPanelVisible(!!panel)
      }
      if (current.kind === 'virtualCamera') {
        if (panel) panelOpened.current = true
        const virtualCameraSettings = document.querySelector<HTMLElement>('[data-pdm-virtual-camera-settings]')
        const virtualCameraIsEnabled = virtualCameraSettings?.textContent?.includes('Виртуальная камера включена') === true
        if (virtualCameraIsEnabled) {
          virtualCameraEnabled.current = true
        }
        const nextVirtualCameraStage = virtualCameraEnabled.current ? 'close' : virtualCameraSettings ? 'enable' : 'tab'
        setVirtualCameraStage(old => old === nextVirtualCameraStage ? old : nextVirtualCameraStage)
        complete = panelOpened.current && virtualCameraEnabled.current && !panel
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
        let validAddress = false
        try {
          const address = new URL(s.qrOverlay.url.trim())
          validAddress = (address.protocol === 'http:' || address.protocol === 'https:') && !!address.hostname
        } catch { /* wait for a complete address */ }
        complete = s.qrOverlay.sceneVisible !== false && validAddress && qrMoved.current
      }
      if (current.kind === 'titles') {
        const selectedSpeaker = s.broadcastTitles.speakers.find(speaker => speaker.id === s.broadcastTitles.selectedSpeakerId)
        complete = document.querySelector('[data-scene-panel="titles"]')?.getAttribute('aria-selected') === 'true' &&
          (selectedSpeaker?.name.trim().length ?? 0) >= 3 && s.broadcastTitles.eventInfo.trim().length >= 4 &&
          titlesConfirmed.current
      }
      if (current.kind === 'titlesPublish') complete =
        document.querySelector('[data-broadcast-titles-speaker-visible]')?.getAttribute('aria-pressed') === 'true' &&
        document.querySelector('[data-broadcast-titles-event-visible]')?.getAttribute('aria-pressed') === 'true'
      if (current.kind === 'closedScene') complete = clicked.current && !scene
      if (current.kind === 'layout') complete = clicked.current && s.programScene.viewMode === 'content'
      if (current.kind === 'exit') complete = !s.activeFile && !s.programScene.enabled
      if (complete && current.kind === 'click' && current.selector.includes('clicker')) {
        setActionResult(s.globalHookEnabled
          ? 'Кликер включён. Пульт будет переключать слайды, даже если PDM свёрнут или поверх открыто другое окно.'
          : 'Кликер выключен. Пульт будет переключать слайды только тогда, когда окно PDM активно.')
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
      if (current.kind === 'external') target = document.querySelector<HTMLElement>('[data-scene-external-source="device:training-camera"]') ?? document.querySelector<HTMLElement>('[data-scene-external-source-picker]') ?? target
      if (current.kind === 'chroma') {
        const chromaToggle = document.querySelector<HTMLElement>('[data-program-scene-chroma-toggle]')
        target = chromaToggle?.closest<HTMLElement>('label') ?? document.querySelector<HTMLElement>('[data-scene-object-action="chroma"]') ?? target
      }
      if (current.kind === 'text') target = document.querySelector<HTMLElement>('[data-scene-add="text"]') ?? text ?? target
      if (current.kind === 'qr') {
        const qrObject = document.querySelector<HTMLElement>('[data-scene-qr-object]')
        const qrInput = document.querySelector<HTMLElement>('[data-pdm-training-qr-url]')
        target = qrObject ?? qrInput ?? document.querySelector<HTMLElement>('[data-scene-add="qr"]') ?? target
      }
      if (current.kind === 'qr') {
        let qrAddressReady = false
        try {
          const address = new URL(s.qrOverlay.url.trim())
          qrAddressReady = (address.protocol === 'http:' || address.protocol === 'https:') && !!address.hostname
        } catch { /* keep the URL field highlighted */ }
        const qrUrlField = qrAddressReady ? null : document.querySelector<HTMLElement>('[data-pdm-training-qr-url]')
        const requiredFields = qrUrlField ? (() => {
          const fieldRect = qrUrlField.getBoundingClientRect()
          return [{
            left: Math.max(0, fieldRect.left - 4),
            top: Math.max(0, fieldRect.top - 4),
            right: Math.min(innerWidth, fieldRect.right + 4),
            bottom: Math.min(innerHeight, fieldRect.bottom + 4)
          }]
        })() : []
        setRequiredFieldRects(old => old.length === requiredFields.length && old.every((oldRect, index) => (
          Object.keys(oldRect).every(key => Math.abs(oldRect[key as keyof Rect] - requiredFields[index][key as keyof Rect]) < 1)
        )) ? old : requiredFields)
      } else if (current.kind === 'titles') {
        const titlesActive = document.querySelector('[data-scene-panel="titles"]')?.getAttribute('aria-selected') === 'true'
        const selectedSpeaker = s.broadcastTitles.speakers.find(speaker => speaker.id === s.broadcastTitles.selectedSpeakerId)
        const titleFieldsComplete = (selectedSpeaker?.name.trim().length ?? 0) >= 3 && s.broadcastTitles.eventInfo.trim().length >= 4
        const requiredFields = (titleFieldsComplete ? [] : [
          document.querySelector<HTMLElement>('[data-pdm-training-speaker-name]'),
          document.querySelector<HTMLElement>('[data-pdm-training-event-info]')
        ]).filter((field): field is HTMLElement => !!field).map((field) => {
          const fieldRect = field.getBoundingClientRect()
          return {
            left: Math.max(0, fieldRect.left - 4),
            top: Math.max(0, fieldRect.top - 4),
            right: Math.min(innerWidth, fieldRect.right + 4),
            bottom: Math.min(innerHeight, fieldRect.bottom + 4)
          }
        })
        setRequiredFieldRects(old => old.length === requiredFields.length && old.every((oldRect, index) => (
          Object.keys(oldRect).every(key => Math.abs(oldRect[key as keyof Rect] - requiredFields[index][key as keyof Rect]) < 1)
        )) ? old : requiredFields)
        if (titlesActive) {
          const speakerInput = document.querySelector<HTMLElement>('[data-pdm-training-speaker-name]')
          const eventInput = document.querySelector<HTMLElement>('[data-pdm-training-event-info]')
          if ((selectedSpeaker?.name.trim().length ?? 0) < 3) target = speakerInput ?? target
          else if (s.broadcastTitles.eventInfo.trim().length < 4) target = eventInput ?? target
          else target = document.querySelector<HTMLElement>('[data-broadcast-titles-preview]') ?? target
        }
      } else if (current.kind === 'settings') {
        const audioDevice = document.querySelector<HTMLElement>('[data-pdm-audio-device="training-hdmi"]')
        const requiredFields = audioDevice ? (() => {
          const deviceRect = audioDevice.getBoundingClientRect()
          return [{
            left: Math.max(0, deviceRect.left - 4),
            top: Math.max(0, deviceRect.top - 4),
            right: Math.min(innerWidth, deviceRect.right + 4),
            bottom: Math.min(innerHeight, deviceRect.bottom + 4)
          }]
        })() : []
        setRequiredFieldRects(old => old.length === requiredFields.length && old.every((oldRect, index) => (
          Object.keys(oldRect).every(key => Math.abs(oldRect[key as keyof Rect] - requiredFields[index][key as keyof Rect]) < 1)
        )) ? old : requiredFields)
      } else if (current.kind === 'virtualCamera') {
        const virtualCameraSettings = document.querySelector<HTMLElement>('[data-pdm-virtual-camera-settings]')
        const target = virtualCameraEnabled.current
          ? document.querySelector<HTMLElement>('[data-pdm-training-panel="settings"] [data-pdm-training-close]')
          : virtualCameraSettings
            ? document.querySelector<HTMLElement>('[data-pdm-virtual-camera-start]')
            : document.querySelector<HTMLElement>('[data-pdm-settings-tab="virtual-camera"]')
        const requiredFields = target ? (() => {
          const tabRect = target.getBoundingClientRect()
          return [{
            left: Math.max(0, tabRect.left - 4),
            top: Math.max(0, tabRect.top - 4),
            right: Math.min(innerWidth, tabRect.right + 4),
            bottom: Math.min(innerHeight, tabRect.bottom + 4)
          }]
        })() : []
        setRequiredFieldRects(old => old.length === requiredFields.length && old.every((oldRect, index) => (
          Object.keys(oldRect).every(key => Math.abs(oldRect[key as keyof Rect] - requiredFields[index][key as keyof Rect]) < 1)
        )) ? old : requiredFields)
      } else setRequiredFieldRects(old => old.length === 0 ? old : [])
      if ((current.kind === 'scene' || current.kind === 'menu' || current.kind === 'draft') && scene) target = scene
      const rightClickTarget = current.kind === 'menu' && !document.querySelector('[data-scene-add="text"]')
        ? document.querySelector<HTMLElement>('[data-program-scene-preview]')
        : current.kind === 'chroma' && !document.querySelector('[data-scene-object-action="chroma"]') && !document.querySelector('[data-program-scene-chroma-toggle]')
          ? document.querySelector<HTMLElement>('[data-program-scene-participant-preview]')
          : current.kind === 'qr' && !document.querySelector('[data-scene-add="qr"]') && !document.querySelector('[data-pdm-training-qr-url]') && !document.querySelector('[data-scene-qr-object]')
            ? document.querySelector<HTMLElement>('[data-program-scene-preview]')
            : null
      if (rightClickTarget) {
        const previewRect = rightClickTarget.getBoundingClientRect()
        const nextGuideRect = { left: previewRect.left, top: previewRect.top, right: previewRect.right, bottom: previewRect.bottom }
        setRightClickGuideRect(old => old && nextGuideRect && Object.keys(old).every(key => Math.abs(old[key as keyof Rect] - nextGuideRect[key as keyof Rect]) < 1) ? old : nextGuideRect)
      } else setRightClickGuideRect(old => old === null ? old : null)
      let actionButton: HTMLElement | null = null
      if (current.kind === 'settings' && !panel) {
        actionButton = target?.matches('button') ? target : target?.querySelector<HTMLElement>('button') ?? null
      } else if (current.kind !== 'settings' && current.kind !== 'virtualCamera') {
        if (current.kind === 'panel' && panel) {
          actionButton = panel.querySelector<HTMLElement>('[data-pdm-training-close]')
        } else if (current.kind === 'slide') {
          actionButton = document.querySelectorAll<HTMLElement>('.pdm-slide-thumb')[1] ?? null
        } else if (current.kind === 'channel' || current.kind === 'channelSecond') {
          actionButton = target
        } else if (current.kind === 'chroma' && target?.querySelector('[data-program-scene-chroma-toggle]')) {
          actionButton = target
        } else if (current.kind === 'qr' && target?.matches('[data-scene-qr-object]')) {
          actionButton = target
        } else if (target?.matches('button, [role="button"], [data-pdm-channel-take], [data-program-scene-picture-visible], [data-program-scene-refresh], [data-program-scene-select-external-source], [data-scene-add], [data-scene-panel], [data-scene-object-action], [data-scene-external-source], [data-broadcast-titles-preview], [data-broadcast-titles-show-all]')) {
          actionButton = target
        } else if (target?.matches('[data-toolbar-item]')) {
          actionButton = target.querySelector<HTMLElement>('button')
        }
      }
      if (actionButton) {
        const buttonRect = actionButton.getBoundingClientRect()
        const nextActionButtonRect = {
          left: Math.max(0, buttonRect.left - 4),
          top: Math.max(0, buttonRect.top - 4),
          right: Math.min(innerWidth, buttonRect.right + 4),
          bottom: Math.min(innerHeight, buttonRect.bottom + 4)
        }
        setActionButtonRect(old => old && Object.keys(old).every(key => Math.abs(old[key as keyof Rect] - nextActionButtonRect[key as keyof Rect]) < 1) ? old : nextActionButtonRect)
      } else setActionButtonRect(old => old === null ? old : null)
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
    return () => {
      clearInterval(timer)
      document.removeEventListener('input', input)
      document.removeEventListener('click', click, true)
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('pointermove', pointerMove, true)
      document.removeEventListener('pointerup', pointerEnd, true)
      document.removeEventListener('pointercancel', pointerEnd, true)
      document.querySelectorAll<HTMLElement>('[data-pdm-training-clear-slide-border]').forEach(thumb => {
        thumb.removeAttribute('data-pdm-training-clear-slide-border')
        thumb.style.removeProperty('border-color')
      })
    }
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

  const goBack = (): void => {
    if (step === 0) return
    const previousStep = step - 1
    window.parent.postMessage({ kind: 'pdm-training-progress', step: previousStep, completed: false, close: false }, '*')
    const url = new URL(window.location.href)
    url.searchParams.set('step', String(previousStep))
    window.location.replace(url.href)
  }

  const width = Math.min(340, innerWidth - 24)
  const defaultLeft = rect.right + width + 20 < innerWidth ? rect.right + 12 : rect.left > width + 20 ? rect.left - width - 12 : innerWidth - width - 16
  const dragStep = current.kind === 'file' || current.kind === 'fileSecond'
  const formStep = current.kind === 'qr' || current.kind === 'titles'
  const formPreviewTop = formStep
    ? document.querySelector<HTMLElement>('[data-program-scene-preview]')?.getBoundingClientRect().top
    : undefined
  const cardWidth = formStep ? Math.min(620, innerWidth - 32) : width
  const formCardMaxHeight = formPreviewTop === undefined ? undefined : Math.max(170, formPreviewTop - 28)
  const left = formStep ? 16 : defaultLeft
  const top = formStep ? 8 : rect.bottom + 335 < innerHeight ? rect.bottom + 12 : Math.max(14, innerHeight - 360)
  const virtualCameraTargetRect = requiredFieldRects[0]
  const virtualCameraCardHeight = 270
  const virtualCameraCardPosition = (() => {
    if (current.kind !== 'virtualCamera' || !virtualCameraTargetRect) return { left, top }
    const gap = 14
    const margin = 12
    const clampedTop = Math.max(margin, Math.min(innerHeight - virtualCameraCardHeight - margin, virtualCameraTargetRect.top))
    if (virtualCameraTargetRect.right + gap + cardWidth <= innerWidth - margin) {
      return { left: virtualCameraTargetRect.right + gap, top: clampedTop }
    }
    if (virtualCameraTargetRect.left - gap - cardWidth >= margin) {
      return { left: virtualCameraTargetRect.left - gap - cardWidth, top: clampedTop }
    }
    const centeredLeft = Math.max(margin, Math.min(innerWidth - cardWidth - margin, (virtualCameraTargetRect.left + virtualCameraTargetRect.right - cardWidth) / 2))
    if (virtualCameraTargetRect.bottom + gap + virtualCameraCardHeight <= innerHeight - margin) {
      return { left: centeredLeft, top: virtualCameraTargetRect.bottom + gap }
    }
    return { left: centeredLeft, top: Math.max(margin, virtualCameraTargetRect.top - virtualCameraCardHeight - gap) }
  })()
  const virtualCameraInstruction = virtualCameraStage === 'tab'
    ? 'Виртуальная камера передаёт итоговое изображение PDM в программу видеосвязи — как обычная камера. Нажмите вкладку «Виртуальная камера».'
    : virtualCameraStage === 'enable'
      ? 'Нажмите «Включить камеру».'
      : 'Виртуальная камера включена. Теперь закройте настройки крестиком.'
  const showPrimaryOutline = !actionButtonRect && requiredFieldRects.length === 0
  return <div className={`interface-tour${dragStep ? ' is-drag-step' : ''}${formStep ? ' is-form-step' : ''}${current.kind === 'slide' ? ' is-slide-step' : ''}${current.kind === 'qr' ? ' is-qr-step' : ''}${current.kind === 'titles' ? ' is-titles-step' : ''}`} data-pdm-training-tour data-pdm-training-ready={ready ? 'true' : 'false'}>
    {!finished && <>
      <div className="interface-tour-shade" style={{ inset: '0 0 auto 0', height: rect.top }} />
      <div className="interface-tour-shade" style={{ left: 0, top: rect.top, width: rect.left, height: rect.bottom - rect.top }} />
      <div className="interface-tour-shade" style={{ right: 0, top: rect.top, width: innerWidth - rect.right, height: rect.bottom - rect.top }} />
      <div className="interface-tour-shade" style={{ inset: `${rect.bottom}px 0 0 0` }} />
      {showPrimaryOutline && <div className="interface-tour-outline" style={{ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }} />}
      {requiredFieldRects.map((fieldRect, index) => <div
        key={index}
        className="interface-tour-required-field"
        data-pdm-training-required-field-outline
        style={{ left: fieldRect.left, top: fieldRect.top, width: fieldRect.right - fieldRect.left, height: fieldRect.bottom - fieldRect.top }}
      />)}
      {actionButtonRect && <div
        className="interface-tour-action-button"
        data-pdm-training-action-button-outline
        style={{ left: actionButtonRect.left, top: actionButtonRect.top, width: actionButtonRect.right - actionButtonRect.left, height: actionButtonRect.bottom - actionButtonRect.top }}
      />}
      {rightClickGuideRect && <div
        className={`interface-tour-right-click-guide${current.kind === 'chroma' || current.kind === 'qr' ? ' is-compact' : ''}`}
        data-pdm-training-right-click-guide
        style={{ left: (rightClickGuideRect.left + rightClickGuideRect.right) / 2, top: (rightClickGuideRect.top + rightClickGuideRect.bottom) / 2 }}
        aria-hidden="true"
      >
        <div className="interface-tour-mouse-picture"><i /><b /></div>
        <strong>{current.kind === 'chroma' ? 'Нажмите правую кнопку на камере' : current.kind === 'qr' ? 'Нажмите правую кнопку в Сцене' : 'Нажмите правую кнопку мыши'}</strong>
      </div>}
      {dragSourceRect && <div className="interface-tour-drag-source" aria-hidden="true" style={{ left: dragSourceRect.left, top: dragSourceRect.top, width: dragSourceRect.right - dragSourceRect.left, height: dragSourceRect.bottom - dragSourceRect.top }} />}
      {dragGuide && <svg className="interface-tour-drag-guide" aria-hidden="true" viewBox={`0 0 ${innerWidth} ${innerHeight}`}>
        <defs><marker id="training-arrow-head" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" /></marker></defs>
        <path d={`M ${dragGuide.fromX} ${dragGuide.fromY} C ${dragGuide.fromX + 80} ${dragGuide.fromY - 45}, ${dragGuide.toX - 100} ${dragGuide.toY - 45}, ${dragGuide.toX} ${dragGuide.toY}`} markerEnd="url(#training-arrow-head)" />
        <text x={dragGuide.toX - 8} y={dragGuide.toY - 18} textAnchor="end">Перетяните презентацию в канал</text>
      </svg>}
      {moveGuide && <div className="interface-tour-move-guide" aria-hidden="true" style={{ left: moveGuide.left + (moveGuide.right - moveGuide.left) / 2, top: moveGuide.top - 22 }}>↔ ↕</div>}
    </>}
    {panelVisible && current.kind !== 'virtualCamera' ? null : collapsed ? <button className="interface-tour-chip" onClick={() => setCollapsed(false)}>Шаг {step + 1} · Развернуть подсказку</button>
      : <section className="interface-tour-card" style={{ left: virtualCameraCardPosition.left, top: virtualCameraCardPosition.top, width: cardWidth, maxHeight: formCardMaxHeight }} aria-live="polite">
        <header><span>{finished ? 'Знакомство пройдено' : `Шаг ${step + 1} из ${lessons.length}`}</span><button title="Свернуть подсказку" aria-label="Свернуть подсказку" onClick={() => setCollapsed(true)}>−</button></header>
        {!finished && <div className="interface-tour-progress"><i style={{ width: `${(step + 1) / lessons.length * 100}%` }} /></div>}
        <h3>{finished ? 'Теперь вы знаете, как пользоваться PDM' : ready && (actionResult || current.doneText) ? 'Готово' : current.title}</h3>
        <p>{finished ? 'Теперь вы знаете, как пользоваться PDM: добавлять материалы, переключать презентации, собирать Сцену и управлять показом.' : ready && (actionResult || current.doneText) ? actionResult || current.doneText : current.kind === 'virtualCamera' ? virtualCameraInstruction : current.text}</p>
        {!finished && <small>{ready ? current.doneText || actionResult ? '✓ Готово — прочитайте и нажмите «Далее»' : '✓ Готово — переходим дальше…' : 'Выполните действие в выделенной области'}</small>}
        <div>
          {!finished && <button className="interface-tour-back" disabled={step === 0} onClick={goBack}>Назад</button>}
          {!finished && ready && (current.doneText || actionResult) && <button className="interface-tour-next" onClick={continueAfterResult}>Далее</button>}
          {finished && <button className="interface-tour-next" onClick={() => notify(true, true)}>Перейти к работе</button>}
        </div>
        {!finished && <button className="interface-tour-later" onClick={() => notify(false, true)}>Продолжить позже</button>}
      </section>}
  </div>
}
