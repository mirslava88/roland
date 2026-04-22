# Бесшовный take PPTX↔PDF — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить чёрную вспышку при take-переключении канала PPTX → PDF (и симметрично PPTX → любой не-PPTX), используя тот же оверлейный механизм с freeze-frame что работает в PDF → PPTX.

**Architecture:** Одна точечная правка в `handleTake` в PreviewPanel. Два отдельных условия для `captureDisplay` (один для PPTX→PPTX-diff, другой для prev ∈ {pdf,video,image,audio}) сливаются в одно унифицированное: `if (!isSameFilePptx && prevActiveFile) captureDisplay()`. Источник prev-контента больше не важен — DWM-composite всегда содержит то что видит зритель.

**Tech Stack:** TypeScript, React, Electron, `desktopCapturer.getSources` (для `captureDisplay`).

**Spec:** [docs/superpowers/specs/2026-04-22-pptx-pdf-seamless-take-design.md](../specs/2026-04-22-pptx-pdf-seamless-take-design.md)

**Testing:** В проекте нет unit-test infrastructure, change чисто визуальный (DWM compositor flicker). Валидация — ручной прогон 5 сценариев из секции «Тест-план» спеки.

---

## Task 1: Унифицировать условие freezeFrame в handleTake

**Files:**
- Modify: `src/renderer/src/components/Preview/PreviewPanel.tsx:159-195`

- [ ] **Step 1: Открыть файл и прочитать блок строк 143–205 в функции `handleTake`**

Убедиться что видишь следующую структуру (сначала блок PPTX→PPTX-diff, потом блок не-PPTX с prevIsPresentationWindowContent):

```ts
let freezeFrame: string | null = null
if (isPptxToPptx && !isSameFilePptx) {
  const { selectedDisplayId } = freshState
  try {
    freezeFrame = await window.api.captureDisplay(selectedDisplayId ?? undefined)
    log(`pptx→pptx freezeFrame: captureDisplay returned ${freezeFrame ? 'image' : 'null'}`)
  } catch { /* fall back to black overlay */ }
}

const prevIsPresentationWindowContent =
  prevActiveFile &&
  (prevActiveFile.type === 'pdf' ||
    prevActiveFile.type === 'video' ||
    (prevActiveFile.type === 'other' && (prevActiveFile.isImage || prevActiveFile.isAudio)))
if (!isPptxToPptx && prevIsPresentationWindowContent && !freezeFrame) {
  const { selectedDisplayId } = freshState
  try {
    freezeFrame = await window.api.captureDisplay(selectedDisplayId ?? undefined)
    log(`non-pptx freezeFrame: captureDisplay returned ${freezeFrame ? 'image' : 'null'}`)
  } catch { /* fall back to black overlay */ }
}
```

- [ ] **Step 2: Заменить оба блока на один унифицированный**

Используй Edit, заменив весь этот кусок (с сохранением вышестоящих и нижестоящих комментариев про seamless flicker — один блок комментов идёт ПОД `isSameFilePptx` и ДО первого `let freezeFrame`, и этот коммент надо сократить/адаптировать) на:

```ts
// Если есть предыдущий контент на экране — снимаем DWM composite и
// используем как freeze-frame. Источник (PP DirectX slideshow, Electron
// canvas, img) не важен — мы захватываем что видит зритель. Пропускаем
// только same-file PPTX (там overlay вообще не поднимается, PP GotoSlide
// отрабатывает мгновенно), и случай первого take (prev=null).
let freezeFrame: string | null = null
if (!isSameFilePptx && prevActiveFile) {
  const { selectedDisplayId } = freshState
  try {
    freezeFrame = await window.api.captureDisplay(selectedDisplayId ?? undefined)
    log(`freezeFrame: captureDisplay returned ${freezeFrame ? 'image' : 'null'}`)
  } catch { /* fall back to black overlay */ }
}
```

Конкретный Edit:

`old_string`:
```ts
    // PPTX→PPTX (different file): capture current display so the overlay
    // appears holding the EXACT pixels that were on screen a moment ago —
    // no visible content cut when the overlay fades in. The pre-rendered
    // PNG path (pptxSlidesMap) used to cover this case, but PP's own
    // Slide.Export renders through a different pipeline (GDI+) than the
    // live slideshow (DirectWrite), so during the 150ms hide-fade the
    // AA/hinting shift produced a faint but visible flicker. Matching the
    // PDF→PDF pattern: two real screen captures cross-fading have nothing
    // to misalign. pptxSlidesMap is still generated in the background and
    // used for the preview panel — just not wired into the overlay.
    let freezeFrame: string | null = null
    if (isPptxToPptx && !isSameFilePptx) {
      const { selectedDisplayId } = freshState
      try {
        freezeFrame = await window.api.captureDisplay(selectedDisplayId ?? undefined)
        log(`pptx→pptx freezeFrame: captureDisplay returned ${freezeFrame ? 'image' : 'null'}`)
      } catch { /* fall back to black overlay */ }
    }

    // Non-PPTX transitions where prev content was rendered in the Electron
    // presentation window (PDF / video / image). Capture the current display
    // so the overlay shows a still of the old content instead of a black
    // rectangle — matches the seamless PPTX→PPTX look. Skipped when prev is
    // PPTX (overlay covers PP teardown; black is fine there) or when there
    // is no prev content at all (black is the correct starting state).
    const prevIsPresentationWindowContent =
      prevActiveFile &&
      (prevActiveFile.type === 'pdf' ||
        prevActiveFile.type === 'video' ||
        (prevActiveFile.type === 'other' && (prevActiveFile.isImage || prevActiveFile.isAudio)))
    if (!isPptxToPptx && prevIsPresentationWindowContent && !freezeFrame) {
      const { selectedDisplayId } = freshState
      try {
        freezeFrame = await window.api.captureDisplay(selectedDisplayId ?? undefined)
        log(`non-pptx freezeFrame: captureDisplay returned ${freezeFrame ? 'image' : 'null'}`)
      } catch { /* fall back to black overlay */ }
    }
```

`new_string`:
```ts
    // Если есть предыдущий контент на экране — снимаем DWM composite и
    // используем как freeze-frame. Источник (PP DirectX slideshow, Electron
    // canvas, img) не важен — мы захватываем то что видит зритель. Скипаем
    // только same-file PPTX (там overlay не поднимается, PP GotoSlide отрабатывает
    // мгновенно) и первый take (prev=null). Раньше было два отдельных условия
    // для PPTX→PPTX-diff и prev ∈ {pdf,video,image,audio}, а PPTX→не-PPTX
    // падал между ними в null → оверлей появлялся чёрным поверх живого PP.
    let freezeFrame: string | null = null
    if (!isSameFilePptx && prevActiveFile) {
      const { selectedDisplayId } = freshState
      try {
        freezeFrame = await window.api.captureDisplay(selectedDisplayId ?? undefined)
        log(`freezeFrame: captureDisplay returned ${freezeFrame ? 'image' : 'null'}`)
      } catch { /* fall back to black overlay */ }
    }
```

- [ ] **Step 3: Проверить typecheck через electron-vite build**

Run: `npm run build`

Expected: Успешная сборка без TS-ошибок. `vite build` проходит для main, preload, renderer. Ошибок `TS2304 Cannot find name 'prevIsPresentationWindowContent'` быть не должно (переменная удалена вместе с её использованием).

Если ошибка — `prevIsPresentationWindowContent` где-то ещё используется. Проверить grep-ом: `prevIsPresentationWindowContent`.

- [ ] **Step 4: Ручная проверка сценариев**

Запустить dev-build: `npm run dev`

Прогнать 5 сценариев из спеки. Перед каждым — убедиться что есть второй монитор (куда идёт presentation window / PP slideshow) и заметно контрастные слайды (тёмный PP-слайд и белый PDF чтобы вспышка бросалась в глаза).

**Сценарий 1 — главный фикс:**
- Канал A = PPTX, Канал B = PDF
- Take A → дождаться пока PP откроется, overlay станет pinned
- Take B → ожидание: НЕТ чёрной вспышки между PP и PDF. Должен быть: PP-кадр → PDF (один переход).

**Сценарий 2 — после PPTX-навигации:**
- То же что 1
- После Take A нажать «Next» или «▶» на ControlBar → overlay скрывается (видно живой PP)
- Take B → ожидание: НЕТ чёрной вспышки.

**Сценарий 3 — регрессия PDF→PPTX:**
- Канал A = PDF, Канал B = PPTX
- Take A → Take B → ожидание: бесшовный переход как было.

**Сценарий 4 — регрессия same-file PPTX:**
- Канал A = PPTX file1, Канал B = PPTX file1 (тот же файл разные каналы)
- Take A → Take B → ожидание: переключение слайда мгновенное, overlay НЕ появляется.

**Сценарий 5 — регрессия PPTX→PPTX разные файлы:**
- Канал A = PPTX file1, Канал B = PPTX file2
- Take A → Take B → ожидание: бесшовный переход через pinned overlay.

Если хоть один сценарий провалился — вернуться к Task 1 Step 2, не переходить к коммиту.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Preview/PreviewPanel.tsx
git commit -m "$(cat <<'EOF'
fix: seamless PPTX↔PDF take via unified captureDisplay

Объединяем две ветки freezeFrame-захвата (PPTX→PPTX-diff и prev ∈
{pdf,video,image,audio}) в одно условие: любой prev-контент кроме
same-file PPTX → captureDisplay. PPTX→не-PPTX больше не падает
между веток с null, оверлей поднимается с PP-кадром pixel-match.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

- Spec coverage: единственное изменение из спеки («Код» в секции «Решение») покрыто Task 1 Step 2. Тест-план покрыт Step 4. Edge-cases в коде реализуются автоматически условием `!isSameFilePptx && prevActiveFile` (same-file → skip, первый take → prev=null → skip).
- Placeholders: нет.
- Type consistency: переменная `prevIsPresentationWindowContent` удаляется, используется только в удалённом блоке — verified grep-ом в Step 3.
