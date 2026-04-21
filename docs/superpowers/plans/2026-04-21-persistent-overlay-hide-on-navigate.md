# Persistent Overlay, Hide-on-Navigate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить PPTX→PPTX мерцание, удерживая Electron overlay постоянно сверху между переключениями файлов и скрывая его только в момент пользовательской навигации (next/prev/goto), где DWM-гонка маскируется slide-transition анимацией PowerPoint.

**Architecture:** Overlay state становится tri-state (`hidden` | `pinned-pptx`). На PPTX→PPTX file-switch оверлей остаётся в `pinned-pptx` со snapshot'ом target-слайда — PP работает под ним невидимо. На next/prev/goto вызываем `hideOverlay()` параллельно с `powerpointCommand`, чтобы 16мс DWM-гонка попала внутрь 200–500мс PP-анимации перехода. Весь новый код — в renderer-стороне (TypeScript), никаких изменений в PS-daemon'е, main process или Win32 слое.

**Tech Stack:** React 19, Zustand 5, TypeScript 5.7, Electron 35 (renderer). Без тестового фреймворка — валидация через TS-компиляцию (`npm run build`) + ручной smoke-test (`npm run dev`).

**Спека:** [docs/superpowers/specs/2026-04-21-persistent-overlay-design.md](../specs/2026-04-21-persistent-overlay-design.md)

---

## File Structure

Изменения точечные, без создания новых файлов:

- **Modify** `src/renderer/src/stores/useAppStore.ts` — добавить `OverlayState` тип, поле `overlayState`, setter `setOverlayState`, action `navigatePptx`
- **Modify** `src/renderer/src/components/Preview/PreviewPanel.tsx` — удалить финальный `hideOverlay`+`250ms` в PPTX→PPTX ветке `handleTake`; добавить snapshot refresh на same-file PPTX если уже pinned; `setOverlayState('hidden')` после каждого `hideOverlay` в остальных ветках
- **Modify** `src/renderer/src/App.tsx` — заменить прямой `window.api.powerpointCommand` в `navigateSlide` на `store.navigatePptx`
- **Modify** `src/renderer/src/components/Controls/ControlBar.tsx` — заменить прямой `window.api.powerpointCommand` в `navigatePptx` (локальной функции) и `handleGoToSlide` на `store.navigatePptx`
- **Modify** `src/renderer/src/components/SlideNavigator/SlideNavigator.tsx` — заменить прямой `window.api.powerpointCommand` в `handleClick` на `store.navigatePptx`

---

## Task 1: Add overlay state and navigatePptx helper to useAppStore

**Files:**
- Modify: `src/renderer/src/stores/useAppStore.ts`

- [ ] **Step 1: Add OverlayState type above AppState interface**

В `src/renderer/src/stores/useAppStore.ts` сразу после `export type ContentType = ...` (line 3) добавить:

```typescript
export type OverlayState =
  | { kind: 'hidden' }
  | { kind: 'pinned-pptx'; pptxPath: string }
```

- [ ] **Step 2: Add overlayState field and actions to AppState interface**

В интерфейсе `AppState` (после `globalHookEnabled: boolean` на line 65) добавить:

```typescript
  overlayState: OverlayState
  setOverlayState: (state: OverlayState) => void
  navigatePptx: (command: 'next' | 'prev' | 'goto', arg?: number) => Promise<{ success: boolean; output?: string; error?: string }>
```

- [ ] **Step 3: Add initial value in store body**

В теле `create<AppState>` (после `globalHookEnabled: true,` на line 160) добавить:

```typescript
  overlayState: { kind: 'hidden' } as OverlayState,
```

- [ ] **Step 4: Add setOverlayState action**

Рядом с другими setter'ами (после `setGlobalHookEnabled:` на line 332) добавить:

```typescript
  setOverlayState: (state) => set({ overlayState: state }),
```

- [ ] **Step 5: Add navigatePptx action**

Сразу после `setOverlayState` добавить:

```typescript
  // Navigate active PPTX. If overlay is pinned (persistent after file-switch),
  // hide it in parallel with the PP command so the DWM race falls inside
  // PP's own slide-transition animation — visually indistinguishable from
  // the transition itself.
  navigatePptx: async (command, arg) => {
    const { overlayState } = get()
    if (overlayState.kind === 'pinned-pptx') {
      // fire-and-forget — do not await; let hide race happen concurrently
      window.api.hideOverlay()
      set({ overlayState: { kind: 'hidden' } })
    }
    if (command === 'goto' && typeof arg === 'number') {
      return window.api.powerpointCommand('goto', arg)
    }
    return window.api.powerpointCommand(command)
  },
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds with no TS errors (only Task 1 changes, helper not yet called anywhere).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/stores/useAppStore.ts
git commit -m "feat: overlay state + navigatePptx helper in store"
```

---

## Task 2: Pin overlay after PPTX→PPTX file switch (remove final hideOverlay)

**Files:**
- Modify: `src/renderer/src/components/Preview/PreviewPanel.tsx` (PPTX branch of `handleTake`, around line 241–260)

- [ ] **Step 1: Import setOverlayState from store**

В начале `PreviewPanel.tsx` найти деструктуризацию `useAppStore` в компоненте. Найти строку примерно такого вида:

```typescript
const {
  channels,
  channelIds,
  ...
  setLiveChannel,
  setChannelFile,
  setActiveFile,
  setTotalSlides,
  setChannelTotalSlides,
  setCurrentSlide,
  setPresentationWindowOpen,
  ...
  liveChannel,
  isPresentationWindowOpen,
  ...
} = useAppStore()
```

Добавить `setOverlayState` в список деструктуризации.

Если точное имя/расположение отличается — добавить прямо в существующую деструктуризацию `useAppStore()` в компоненте `PreviewPanel`. Если компонент не использует деструктуризацию, использовать `useAppStore.getState().setOverlayState(...)` в call-site'ах.

- [ ] **Step 2: Modify PPTX→PPTX block in handleTake**

В `handleTake`, в ветке `if (channel.file.type === 'presentation')`, найти блок около line 241–260:

```typescript
if (!isSameFilePptx) {
  // Hybrid: захватываем живой slideshow PP через PrintWindow...
  log('snapshotSlideshow: BEGIN')
  const snapPath = await window.api.snapshotSlideshow()
  log(`snapshotSlideshow: END path=${snapPath ? 'ok' : 'null'}`)
  if (snapPath) {
    await window.api.swapOverlayImage(snapPath)
    log('swap overlay → live PP snapshot')
  }
  log('pre-fade wait 250ms')
  await new Promise((r) => setTimeout(r, 250))
  log('hideOverlay: BEGIN')
  await window.api.hideOverlay()
  log('hideOverlay: END (overlay window hidden)')
}
```

Заменить на:

```typescript
if (!isSameFilePptx) {
  // Persistent overlay: снимок живого slideshow PP через PrintWindow.
  // Подменяем последний кадр оверлея на этот снимок, НО оверлей НЕ скрываем.
  // Он остаётся висеть pixel-perfect поверх живого PP. PP работает под ним
  // невидимо. Оверлей скроется только когда юзер нажмёт next/prev/goto —
  // в этот момент PP начнёт проигрывать свой slide-transition, и DWM-гонка
  // на hide попадёт внутрь анимации (200–500мс) → визуально неразличима.
  log('snapshotSlideshow: BEGIN')
  const snapPath = await window.api.snapshotSlideshow()
  log(`snapshotSlideshow: END path=${snapPath ? 'ok' : 'null'}`)
  if (snapPath) {
    await window.api.swapOverlayImage(snapPath)
    log('swap overlay → live PP snapshot (overlay remains pinned)')
  }
  setOverlayState({ kind: 'pinned-pptx', pptxPath: channel.file.path })
  log('overlay pinned for pptxPath')
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Preview/PreviewPanel.tsx
git commit -m "feat: pin overlay after PPTX→PPTX switch instead of hiding"
```

---

## Task 3: Refresh overlay snapshot on same-file PPTX goto (если уже pinned)

**Files:**
- Modify: `src/renderer/src/components/Preview/PreviewPanel.tsx` (around line 196–201)

Это нужно чтобы при переключении channel'а на ТОТ ЖЕ PPTX (но другой слайд) оверлей обновился на новый слайд, а не остался с устаревшим кадром.

- [ ] **Step 1: Extend the isSameFilePptx branch**

Найти блок около line 196–201:

```typescript
if (!isSameFilePptx) {
  await window.api.showOverlay(undefined, freezeFrame || undefined)
  log('overlay opaque (showOverlay returned)')
} else {
  log('same-file PPTX: skipping overlay (PP GotoSlide is instant)')
}
```

Оставить эту часть как есть — оверлей НЕ показываем при same-file. Но нужно обновить snapshot ПОСЛЕ того, как PP выполнит GotoSlide. Найти в PPTX ветке место сразу после `launchPowerPoint` и после блока c `result.output` parse (около line 231–240, заканчивается на `} catch { /* ignore */ } }`).

Прямо перед `if (!isSameFilePptx) { ... snapshotSlideshow ... }` (line 241) добавить новый блок:

```typescript
// Same-file goto: если оверлей уже в pinned-pptx (висит с предыдущего
// переключения), обновить его snapshot на новый слайд. PP уже выполнил
// GotoSlide внутри launchPowerPoint (daemon handles same-file как goto
// без teardown). Без этого оверлей оставался бы со старым кадром.
if (isSameFilePptx) {
  const cur = useAppStore.getState().overlayState
  if (cur.kind === 'pinned-pptx') {
    log('same-file PPTX + pinned overlay: refreshing snapshot')
    const snapPath = await window.api.snapshotSlideshow()
    if (snapPath) {
      await window.api.swapOverlayImage(snapPath)
      setOverlayState({ kind: 'pinned-pptx', pptxPath: channel.file.path })
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Preview/PreviewPanel.tsx
git commit -m "feat: refresh pinned overlay snapshot on same-file PPTX goto"
```

---

## Task 4: Reset overlay state in handleClear after hideOverlay

**Files:**
- Modify: `src/renderer/src/components/Preview/PreviewPanel.tsx` (line ~123–125)

- [ ] **Step 1: Update handleClear**

Найти блок около line 123–125 в `handleClear`:

```typescript
      if (needsCover) {
        await window.api.hideOverlay()
      }
```

Заменить на:

```typescript
      if (needsCover) {
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
      }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Preview/PreviewPanel.tsx
git commit -m "feat: reset overlay state to hidden in handleClear"
```

---

## Task 5: Reset overlay state in handleTake non-PPTX paths

Non-PPTX ветки `handleTake` (audio, Word/Excel, PDF/video/image) тоже прячут оверлей — после каждого `hideOverlay` нужно сбросить состояние в `hidden`.

**Files:**
- Modify: `src/renderer/src/components/Preview/PreviewPanel.tsx` (lines ~318, ~354, ~390)

- [ ] **Step 1: Audio branch — line ~318**

Найти в `handleTake`:

```typescript
      await window.api.musicPlay()
      await window.api.hideOverlay()
      return
    }
```

Заменить на:

```typescript
      await window.api.musicPlay()
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      return
    }
```

- [ ] **Step 2: Word/Excel (other non-image) branch — line ~354**

Найти:

```typescript
      await window.api.restoreExternalFile(channel.file.path, external?.bounds)
      await window.api.hideOverlay()
      return
    }
```

Заменить на:

```typescript
      await window.api.restoreExternalFile(channel.file.path, external?.bounds)
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      return
    }
```

- [ ] **Step 3: PDF/Video/Image branch — line ~390 (последний hideOverlay в функции)**

Найти:

```typescript
    await contentReady
    await window.api.hideOverlay()
  }
```

Заменить на:

```typescript
    await contentReady
    await window.api.hideOverlay()
    setOverlayState({ kind: 'hidden' })
  }
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Preview/PreviewPanel.tsx
git commit -m "feat: reset overlay state to hidden after non-PPTX takes"
```

---

## Task 6: Wire App.tsx F-key navigation to store.navigatePptx

**Files:**
- Modify: `src/renderer/src/App.tsx` (lines 64–95)

- [ ] **Step 1: Replace direct powerpointCommand with store.navigatePptx**

Найти блок на line 64–95:

```typescript
    const navigateSlide = async (direction: 'next' | 'prev'): Promise<void> => {
      const { activeFile, currentSlide, totalSlides } = useAppStore.getState()
      if (!activeFile) return

      if (activeFile.type === 'presentation') {
        const state = useAppStore.getState()
        const ch = state.liveChannel ? state[`channel${state.liveChannel}` as const] : null
        const total = totalSlides || ch?.totalSlides || 0
        if (direction === 'next' && total > 0 && currentSlide >= total) return
        if (direction === 'prev' && currentSlide <= 1) return

        const optimistic = direction === 'next' ? currentSlide + 1 : currentSlide - 1
        useAppStore.getState().setCurrentSlide(optimistic)

        pendingNavCount++
        window.api.powerpointCommand(direction === 'next' ? 'next' : 'prev').then((result) => {
          pendingNavCount--
          if (pendingNavCount > 0) return
          if (result.success && result.output) {
            try {
              const data = JSON.parse(result.output)
              if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
                useAppStore.getState().setCurrentSlide(data.CurrentSlide)
              }
            } catch { /* ignore */ }
          }
        }).catch(() => { pendingNavCount-- })
      } else if (activeFile.type === 'pdf') {
```

Заменить только строку с `window.api.powerpointCommand(...)`:

```typescript
        pendingNavCount++
        useAppStore.getState().navigatePptx(direction).then((result) => {
          pendingNavCount--
          if (pendingNavCount > 0) return
          if (result.success && result.output) {
            try {
              const data = JSON.parse(result.output)
              if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
                useAppStore.getState().setCurrentSlide(data.CurrentSlide)
              }
            } catch { /* ignore */ }
          }
        }).catch(() => { pendingNavCount-- })
```

Ключевое: `window.api.powerpointCommand(direction === 'next' ? 'next' : 'prev')` → `useAppStore.getState().navigatePptx(direction)`. Всё остальное (optimistic update, pendingNavCount, reconciliation) остаётся как есть.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: App.tsx F-key nav uses store.navigatePptx"
```

---

## Task 7: Wire ControlBar.tsx buttons and goto to store.navigatePptx

**Files:**
- Modify: `src/renderer/src/components/Controls/ControlBar.tsx` (lines 44–60, 90–110)

- [ ] **Step 1: Add navigatePptx to store destructure**

На line 5–12 найти деструктуризацию:

```typescript
  const {
    activeFile,
    isPlaying,
    setIsPlaying,
    currentSlide,
    totalSlides,
    setCurrentSlide,
  } = useAppStore()
```

Добавить `navigatePptx`:

```typescript
  const {
    activeFile,
    isPlaying,
    setIsPlaying,
    currentSlide,
    totalSlides,
    setCurrentSlide,
    navigatePptx,
  } = useAppStore()
```

- [ ] **Step 2: Replace direct powerpointCommand in local navigatePptx helper**

Найти локальную функцию `navigatePptx` (renderer-side, line 44–60). Здесь конфликт имён — локальная функция теряется, так как одноимённая из store теперь в scope. Переименовать локальную функцию в `handlePptxNav`:

```typescript
  const handlePptxNav = (direction: 'next' | 'prev'): void => {
    const optimistic = direction === 'next' ? currentSlide + 1 : currentSlide - 1
    setCurrentSlide(optimistic)
    pendingNavCount.current++
    navigatePptx(direction).then((result) => {
      pendingNavCount.current--
      if (pendingNavCount.current > 0) return
      if (result.success && result.output) {
        try {
          const data = JSON.parse(result.output)
          if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
            useAppStore.getState().setCurrentSlide(data.CurrentSlide)
          }
        } catch { /* ignore */ }
      }
    }).catch(() => { pendingNavCount.current-- })
  }
```

Ключевые изменения: имя `navigatePptx` → `handlePptxNav`, внутри вызов `window.api.powerpointCommand(direction)` → `navigatePptx(direction)` (это store action).

- [ ] **Step 3: Update call sites of renamed helper**

Найти `handlePrev` (line 62–72) и `handleNext` (line 74–84). В них заменить `navigatePptx('prev')` / `navigatePptx('next')` на `handlePptxNav('prev')` / `handlePptxNav('next')`:

```typescript
  const handlePrev = (): void => {
    if (currentSlide <= 1) return

    if (activeFile.type === 'presentation') {
      handlePptxNav('prev')
    } else if (activeFile.type === 'pdf') {
      const newSlide = currentSlide - 1
      setCurrentSlide(newSlide)
      window.api.sendToPresentation('navigate-slide', newSlide)
    }
  }

  const handleNext = (): void => {
    if (totalSlides > 0 && currentSlide >= totalSlides) return

    if (activeFile.type === 'presentation') {
      handlePptxNav('next')
    } else if (activeFile.type === 'pdf') {
      const newSlide = currentSlide + 1
      setCurrentSlide(newSlide)
      window.api.sendToPresentation('navigate-slide', newSlide)
    }
  }
```

- [ ] **Step 4: Replace direct powerpointCommand in handleGoToSlide**

Найти `handleGoToSlide` (line 86–110):

```typescript
  const handleGoToSlide = (): void => {
    const num = parseInt(goToSlide)
    if (num < 1 || (totalSlides > 0 && num > totalSlides)) return

    if (activeFile.type === 'presentation') {
      setCurrentSlide(num)
      pendingNavCount.current++
      window.api.powerpointCommand('goto', num).then((result) => {
        pendingNavCount.current--
        if (pendingNavCount.current > 0) return
        if (result.success && result.output) {
          try {
            const data = JSON.parse(result.output)
            if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
              useAppStore.getState().setCurrentSlide(data.CurrentSlide)
            }
          } catch { /* ignore */ }
        }
      }).catch(() => { pendingNavCount.current-- })
    } else if (activeFile.type === 'pdf') {
      setCurrentSlide(num)
      window.api.sendToPresentation('navigate-slide', num)
    }
    setGoToSlide('')
  }
```

Заменить только вызов `window.api.powerpointCommand('goto', num)` на `navigatePptx('goto', num)`:

```typescript
      window.api.powerpointCommand('goto', num).then(...)
```
→
```typescript
      navigatePptx('goto', num).then(...)
```

Всё остальное остаётся как есть.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Controls/ControlBar.tsx
git commit -m "feat: ControlBar uses store.navigatePptx for PPTX nav + goto"
```

---

## Task 8: Wire SlideNavigator.tsx thumbnail click to store.navigatePptx

**Files:**
- Modify: `src/renderer/src/components/SlideNavigator/SlideNavigator.tsx` (line 107–114)

- [ ] **Step 1: Read current destructure in SlideNavigator**

Посмотреть верх файла (около line 1–30) где `useAppStore()` деструктурируется. Добавить `navigatePptx` в список (если используется) или использовать `useAppStore.getState().navigatePptx(...)` прямо в `handleClick` (если компонент не деструктурирует store).

- [ ] **Step 2: Replace direct powerpointCommand in handleClick**

Найти `handleClick` (line 107–114):

```typescript
  const handleClick = (index: number): void => {
    setCurrentSlide(index)
    if (activeFile?.type === 'presentation') {
      window.api.powerpointCommand('goto', index)
    } else if (activeFile?.type === 'pdf') {
      window.api.sendToPresentation('navigate-slide', index)
    }
  }
```

Заменить `window.api.powerpointCommand('goto', index)` на store action. Вариант с прямым обращением к store (не требует изменения деструктуризации):

```typescript
  const handleClick = (index: number): void => {
    setCurrentSlide(index)
    if (activeFile?.type === 'presentation') {
      useAppStore.getState().navigatePptx('goto', index)
    } else if (activeFile?.type === 'pdf') {
      window.api.sendToPresentation('navigate-slide', index)
    }
  }
```

Убедиться что `useAppStore` уже импортирован в верхней части файла (если нет — добавить `import { useAppStore } from '../../stores/useAppStore'`).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SlideNavigator/SlideNavigator.tsx
git commit -m "feat: SlideNavigator goto uses store.navigatePptx"
```

---

## Task 9: Manual smoke test — validate end-to-end

Автотестов нет (Electron UI + multi-process compositor — некорректно тестировать unit-тестами). Валидация — глазами на внешнем дисплее.

**Files:**
- Нет изменений.

- [ ] **Step 1: Build + launch dev**

Убить старые Electron-процессы:

```bash
powershell -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
```

Запустить dev:

```bash
npm run dev
```

- [ ] **Step 2: Подготовить 2 разных PPTX-файла**

Убедиться что в папке есть минимум 2 разных .pptx файла (например, `file-A.pptx` и `file-B.pptx`, желательно с разными слайдами и хотя бы одним slide transition).

- [ ] **Step 3: Смотреть логи `[TAKE ...]` в DevTools Console**

Открыть DevTools в renderer-окне (Ctrl+Shift+I) → Console. Все шаги handleTake логируются с префиксом `[TAKE <ms>ms]`.

- [ ] **Step 4: Тест 1 — PPTX→PPTX file switch (главный сценарий)**

1. Положить file-A в channel A, file-B в channel B
2. Нажать «В эфир» на A — PowerPoint запускается, PP-слайдшоу на внешнем дисплее
3. В логах должно быть: `overlay pinned for pptxPath` вместо `hideOverlay: BEGIN/END`
4. Нажать «В эфир» на B — PP рестартует с file-B
5. **Критерий:** визуально на внешнем дисплее — плавный переход без мерцания. Старый слайд A → новый слайд B через snapshot в оверлее. Ни одного чёрного/белого кадра.
6. В логах: `swap overlay → live PP snapshot (overlay remains pinned)`, `overlay pinned for pptxPath` (новый путь).

- [ ] **Step 5: Тест 2 — PPTX next/prev with transition**

Взять PPTX с fade/push slide transition между слайдами.

1. file-A в эфире, на слайде 1
2. Нажать F-key next (или кнопку → в ControlBar, или кликнуть по thumbnail слайда 2)
3. **Критерий:** оверлей скрывается, PP играет transition-анимацию. Мерцание должно попасть внутрь анимации — визуально неотличимо от обычного PP-перехода.

- [ ] **Step 6: Тест 3 — PPTX goto по номеру слайда**

1. file-A в эфире, в ControlBar ввести номер слайда в поле goto (не текущий), нажать Enter
2. **Критерий:** оверлей скрывается одновременно с переходом PP. Поведение аналогично next/prev.

- [ ] **Step 7: Тест 4 — same-file PPTX goto через channel (refresh snapshot)**

Один и тот же PPTX в двух разных channel'ах с разным `channel.slide`.

1. «В эфир» на channel A (slide 1) — PP запущен, оверлей pinned
2. «В эфир» на channel B (тот же файл, slide 5) — PP делает GotoSlide 5 без teardown, оверлей **должен обновиться** на слайд 5
3. **Критерий:** в логах `same-file PPTX + pinned overlay: refreshing snapshot`. Визуально — смена кадра без мерцания.

- [ ] **Step 8: Тест 5 — PPTX → PDF (reset overlay state)**

1. PPTX в эфире (pinned)
2. «В эфир» на PDF-канале
3. **Критерий:** оверлей скрывается (PDF отображается в Electron presentation window), в логах PP закрывается (`powerpoint-command close`), state сбрасывается в hidden.
4. После этого вернуться на PPTX — первый take PPTX из PDF-состояния должен работать как «первый запуск»: оверлей появляется с freeze-кадром PDF, launchPowerPoint, snapshot, pin.

- [ ] **Step 9: Тест 6 — clear channel (PPTX в эфире, нажать X)**

1. PPTX в эфире
2. В PreviewPanel нажать кнопку очистки канала
3. **Критерий:** PP закрывается, оверлей убирается, overlayState=hidden.

- [ ] **Step 10: Тест 7 — rapid burst next/prev**

1. PPTX в эфире
2. Быстро нажать F-key next 5 раз подряд (за <500мс)
3. **Критерий:** UI показывает прогресс слайдов через optimistic update, PP реально догоняет. Оверлей скрывается ТОЛЬКО первый раз (остальные клики вызывают store.navigatePptx когда overlayState уже `hidden` — no-op hide). Никаких лишних flicker'ов.

- [ ] **Step 11: Если все тесты прошли — merge-ready**

Нет итогового commit'а — работа уже закоммичена по задачам. В случае обнаружения регрессий вернуться к соответствующей задаче и откатить/поправить.

- [ ] **Step 12: Если тест 2 (навигация внутри файла) всё ещё показывает видимое мерцание на слайдах БЕЗ transition**

Это ожидаемый residual, описан в спеке в разделе «Что НЕ решаем». Создать новый спек для этого отдельно. Текущий спек закрыт успешно при прохождении Тестов 1, 3, 4, 5, 6, 7.

---

## Self-Review Pass

**Spec coverage:**
- ✅ `OverlayState` тип + `overlayState` field — Task 1
- ✅ `setOverlayState` setter — Task 1
- ✅ `navigatePptx` helper в store — Task 1
- ✅ PPTX→PPTX: убрать `hideOverlay` + 250мс, пометить `pinned-pptx` — Task 2
- ✅ Same-file PPTX: refresh snapshot — Task 3
- ✅ `handleClear` → hidden — Task 4
- ✅ Non-PPTX takes → hidden — Task 5
- ✅ App.tsx F-keys → store.navigatePptx — Task 6
- ✅ ControlBar buttons + goto → store.navigatePptx — Task 7
- ✅ SlideNavigator thumbnail click → store.navigatePptx — Task 8
- ✅ Manual smoke tests 1–7 — Task 9

**Type consistency:**
- `OverlayState` kind literals: `'hidden'` / `'pinned-pptx'` — одинаковые во всех Task'ах ✓
- Store action name: `navigatePptx` — одинаковое в Task 1, 6, 7, 8 ✓
- `setOverlayState({ kind: 'hidden' })` shape — одинаковый в Task 1, 4, 5 ✓
- `setOverlayState({ kind: 'pinned-pptx', pptxPath })` — одинаковый в Task 2, 3 ✓

**Placeholder scan:**
- Нет TBD/TODO/"implement later" ✓
- Нет "add appropriate validation" / "handle edge cases" без кода ✓
- Нет "similar to Task N" ссылок — каждый Task показывает полный код ✓
- Нет ссылок на неопределённые функции — всё что используется (`setOverlayState`, `navigatePptx`, `useAppStore.getState()`) определено в Task 1 или уже существует ✓

**Scope check:** Один focused feature, ~40–50 строк кода, 8 code-tasks + 1 validation task. Не декомпозируется дальше — каждый task logically atomic.
