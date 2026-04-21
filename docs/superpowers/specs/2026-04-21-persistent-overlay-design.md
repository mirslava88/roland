# Persistent Overlay, Hide-on-Navigate

**Дата:** 2026-04-21
**Автор:** mirslava (через Claude)
**Статус:** черновик, одобрен пользователем

## Проблема

PPTX→PPTX переключение в PDM даёт визуальное мерцание на внешнем дисплее. Корень — DWM-гонка между двумя TOPMOST-окнами на одном композиторе: Electron overlay (HWND_TOPMOST) и PowerPoint slideshow (HWND_TOPMOST). В момент `hideOverlay` оверлей пропадает на одном кадре, PP-слайдшоу активируется на другом — это два независимых пайплайна композитинга, их нельзя синхронизировать на уровне 16.67мс frame tick.

Мы прошли 10+ итераций точечных фиксов (z-order retries, pixel-perfect snapshot через PrintWindow, ShowType=Window, parallel runspace poller) — все провалились. Phase 4.5 systematic-debugging запрещает fix #11 без смены архитектуры.

## Инсайт

Мерцание возникает ТОЛЬКО когда оверлей скрывается поверх активного PP-окна. Значит решение: **не скрывать оверлей вообще в момент file-switch**. Скрывать его только когда PP сам начинает играть slide-transition анимацию — тогда 16мс DWM-гонка попадает внутрь 200–500мс анимации PP и становится визуально неразличимой.

Ключевое уточнение от пользователя: PP-фичи (анимации, переходы, видео) нужны только на **next/prev/goto ВНУТРИ файла**, не на переключении файлов. Это снимает архитектурное препятствие: можно держать оверлей всегда сверху на файл-свитче, показывая snapshot target-слайда; PP работает невидимый под ним; live PP виден только когда пользователь жмёт навигацию.

## Что меняем

### Новая модель состояний оверлея

Переменная в `useAppStore` или в ref внутри `PreviewPanel`:

```
type OverlayState =
  | { kind: 'hidden' }                           // оверлей скрыт, PP виден
  | { kind: 'pinned-pptx', pptxPath: string }   // оверлей висит с snapshot'ом PP, PP под ним работает
```

Старая модель была бинарной (показан/скрыт с короткими окнами «показан»). Новая — tri-state, где `pinned-pptx` — долгое устойчивое состояние.

### Изменения в `PreviewPanel.tsx`

**`handleTake` PPTX→PPTX ветка (line ~241–260):**

```diff
  if (!isSameFilePptx) {
    const snapPath = await window.api.snapshotSlideshow()
    if (snapPath) {
      await window.api.swapOverlayImage(snapPath)
    }
-   await new Promise((r) => setTimeout(r, 250))
-   await window.api.hideOverlay()
+   // Оверлей НЕ скрываем — остаётся висеть со snapshot'ом target-слайда.
+   // PP-слайдшоу работает под ним невидимо. Скроем его когда юзер
+   // нажмёт next/prev/goto (см. App.tsx / ControlBar.tsx).
+   setOverlayState({ kind: 'pinned-pptx', pptxPath: channel.file.path })
  }
```

**`handleClear` PPTX ветка (line ~124):** Оверлей остаётся в `pinned-pptx` до перехода на другой тип контента. При полном clear'е (если файл был PPTX и мы закрываем всё) → `hideOverlay` как сейчас.

**Non-PPTX ветки (PDF, video, image, backdrop):** Работают как сейчас — `hideOverlay` после загрузки контента. Дополнительно перед этим сбрасываем `overlayState → hidden`.

**Same-file PPTX (`isSameFilePptx = true`):** Оверлей никогда не показывается (как сейчас). Если оверлей был в `pinned-pptx` с предыдущим target-слайдом — обновить snapshot через `snapshotSlideshow + swapOverlayImage`, остаться в `pinned-pptx`. Это даёт pixel-perfect переход при goto на том же файле из превью.

### Изменения в навигации (App.tsx, ControlBar.tsx, SlideNavigator.tsx)

Общий паттерн для PPTX-навигации (next/prev/goto):

```diff
- window.api.powerpointCommand('next')
+ if (overlayState.kind === 'pinned-pptx') {
+   window.api.hideOverlay()           // fire-and-forget, не await
+   setOverlayState({ kind: 'hidden' })
+ }
+ window.api.powerpointCommand('next')
```

`hideOverlay` запускаем **параллельно** с `powerpointCommand` (без await). В момент когда PP начинает играть transition, оверлей уходит — гонка попадает внутрь анимации. Если у слайда нет transition — мелькание 16мс в контексте «я жму кнопку, что-то меняется» воспринимается как часть пользовательского действия, не как баг.

Четыре call-site: `App.tsx:84` (F-клавиши), `ControlBar.tsx:48` (кнопки next/prev), `ControlBar.tsx:93` (goto по номеру), `SlideNavigator.tsx:110` (клик по превью слайду).

**Решение:** общий helper `navigatePptx(command: 'next'|'prev'|'goto', arg?: number)` в `useAppStore` (рядом с `overlayState`). Выполняет: читает `overlayState`, если `pinned-pptx` — вызывает `hideOverlay()` + ставит `hidden`, затем `powerpointCommand(command, arg)`. Все четыре call-site вызывают этот helper вместо прямого `window.api.powerpointCommand`. Optimistic UI update и `pendingNavCount` reconciliation из `App.tsx:77–95` остаются в соответствующих call-site'ах (они специфичны для F-клавиш), helper занимается только overlay + ipc.

### Где хранить `overlayState`

Вариант А: в `useAppStore` (Zustand) — глобально, доступно из App.tsx/ControlBar/SlideNavigator без prop drilling.
Вариант Б: в React ref внутри `PreviewPanel` + broadcast через custom event.

**Выбор:** А — состояние логически глобальное, Zustand уже используется для всего остального (channels, activeFile, liveChannel). Добавить `overlayState: OverlayState` и `setOverlayState(s)`.

### Edge cases

1. **PPTX → PDF/video/backdrop:** оверлей в `pinned-pptx`, новый handleTake скрывает его как часть non-PPTX пути → `hideOverlay` + `setOverlayState({ kind: 'hidden' })`. Без race — PP уже закрывается (`powerpointCommand('close')`), верхним слоем становится Electron presentation window с новым контентом.

2. **PPTX → PPTX одинаковый файл:** `snapshotSlideshow` + `swapOverlayImage`, `pinned-pptx` обновляется с тем же pptxPath (или остаётся). Оверлей не мигает.

3. **PPTX → PPTX разный файл:** как описано выше — PP tearDown + startup скрыт оверлеем, в конце `swapOverlayImage` с новым snapshot'ом, остаёмся в `pinned-pptx` с новым pptxPath.

4. **Clear-all с PPTX:** `handleClear` → `powerpointCommand('close')` + `hideOverlay` + `setOverlayState({ kind: 'hidden' })`.

5. **Navigate при оверлее в `hidden`:** защитный `if (overlayState.kind === 'pinned-pptx')` — не вызываем `hideOverlay` впустую.

6. **Первый показ PPTX из пустого состояния:** prevActiveFile=null → `isPptxToPptx=false` → **не** берём freezeFrame. Текущий код показывает overlay с black freeze (`showOverlay(undefined, undefined)`). После `snapshotSlideshow + swapOverlayImage` остаёмся в `pinned-pptx`. ✓ Та же модель.

7. **Rapid navigate (burst F-клавиш):** в `App.tsx` уже есть `pendingNavCount` reconciliation. `hideOverlay` вызываем только если `overlayState === 'pinned-pptx'` — второй и далее клики просто вызывают `powerpointCommand` напрямую. ✓ без изменений.

## Почему это безопаснее чем текущие попытки

- **Архитектурное изменение, не фикс.** Удаляет гонку целиком вместо попыток её выиграть.
- **Опирается на уже работающие части.** `PrintWindow` snapshot даёт pixel-perfect кадр. `swapOverlayImage` уже атомарно обновляет Electron overlay. Обе функции проверены в текущей сессии.
- **Нет новых PS P/Invoke / runspace / Win32 хаков.** Только TypeScript-сторона.
- **Обратно-совместимо.** Если флаг `pinned-pptx` не взводить, поведение идентично текущему → можно откатить одним коммитом.
- **Откровенно использует PP-фичи для маскировки.** Transition-анимация PP становится союзником: её существование гарантирует, что DWM-гонка на hide не видна.

## Объём работы

- `useAppStore.ts`: +2 поля, +1 setter. ~10 строк.
- `PreviewPanel.tsx`: diff показан выше, правки в handleTake (PPTX→PPTX, same-file, non-PPTX), handleClear. ~20 строк.
- `App.tsx`, `ControlBar.tsx`, `SlideNavigator.tsx`: добавить `hideOverlay()` + `setOverlayState('hidden')` перед каждым `powerpointCommand(nav)`. ~15 строк суммарно или ~8 через shared helper.

**Итого:** ~40–50 строк, изменения только на renderer-стороне (TS). 1–2 часа работы + тестирование.

## Критерии успеха

1. **PPTX→PPTX разный файл:** нет видимого мерцания при клике «В эфир». Пользователь видит pixel-perfect переход (snapshot старого слайда → snapshot нового слайда, оверлей не исчезает между).
2. **PPTX→PPTX тот же файл:** нет мерцания на goto (как сейчас).
3. **PPTX next/prev/goto:** может быть лёгкое мелькание 16мс, но визуально неотличимо от слайд-transition'а PP. Для слайдов с transition — полностью невидимо.
4. **PPTX → PDF/video/image:** работает как сейчас, без регрессии.
5. **Тест длиной 10 переключений A→B→A→B→...:** ноль видимых мерцаний на file-switch'ах.

## Что НЕ решаем в этой спеке

- Остаются ли мерцания на самой навигации next/prev без transition в слайде — если замечены, решать отдельным спек'ом (возможные пути: DWM redirect surface, Windows.Graphics.Capture live video feed).
- Чистка unused Speaker-mode retry-кода в daemon'е (`Set-NotTopmost`/`Hide-NotTopmost`) — отдельный housekeeping-таск, не блокер для этого спека.

## Открытые вопросы

Нет. Если обнаружатся при написании плана — подниму в плане.
