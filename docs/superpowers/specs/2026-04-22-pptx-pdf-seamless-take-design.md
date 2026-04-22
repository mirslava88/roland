# Бесшовный take PPTX↔PDF — design

## Проблема

При take-переключении канала PPTX→PDF (и симметрично PPTX→не-PPTX) виден чёрный flash между PP-слайдом и PDF.

Корень — в [PreviewPanel.tsx `handleTake`](../../../src/renderer/src/components/Preview/PreviewPanel.tsx): захват кадра через `captureDisplay` делается только для двух веток: `isPptxToPptx && !isSameFilePptx` и `prevIsPresentationWindowContent` (pdf/video/image/audio). Когда prev = `presentation` и next ≠ `presentation`, обе ветки пропускаются, `freezeFrame=null`.

Далее `showOverlay(undefined, null)` загружает пустой `<img>` (через `f.src=''`, `display:none`) и поднимает окно overlay в opaque-состояние над чёрным body-фоном → экран показывает чёрный прямоугольник поверх живого PP. За 100–300мс до `hideOverlay` зритель видит: PP → чёрный → PDF.

Обратное направление (PDF→PPTX) уже работает: prev=pdf попадает в `prevIsPresentationWindowContent`, captureDisplay снимает PDF-канвас, overlay фейдит из PDF-кадра на PP-снимок через swap. Этим направлением задан эталон «бесшовного» перехода.

## Scope

Только поток «канал→канал» через `handleTake` в PreviewPanel (пользовательский сценарий A из брейнсторма). Выход из эфира (`handleClear` / кнопка «Выйти из эфира») и прочие точки входа — out of scope.

## Решение

Унифицировать условие захвата: если prev-контент есть и это не same-file PPTX, безусловно делать `captureDisplay`. Источник кадра больше не важен — DWM-composite уже содержит то что видит зритель (PP DirectX surface / Electron canvas / img / pinned overlay).

### Код

В `handleTake` заменить два условных блока захвата (строки ~169–195) на один:

```ts
let freezeFrame: string | null = null
if (!isSameFilePptx && prevActiveFile) {
  const { selectedDisplayId } = freshState
  try {
    freezeFrame = await window.api.captureDisplay(selectedDisplayId ?? undefined)
  } catch { /* fall back to black overlay */ }
}
```

Остальной flow не меняется:
- `showOverlay(undefined, freezeFrame)` поднимает overlay с кадром.
- PPTX→не-PPTX: `powerpointCommand('close')` под overlay, открытие/использование Electron-окна, `load-content`, await `content-ready`, `hideOverlay`.
- X→PPTX: `launchPowerPoint` → `snapshotSlideshow` → `swapOverlayImage` → overlay pinned.
- Same-file PPTX→PPTX: overlay пропускается целиком (сохраняется).

## Почему работает

Раскадровка PPTX→PDF после фикса:

1. Экран: PP live slideshow.
2. `captureDisplay` → PNG = PP-кадр из DWM-композита.
3. `showOverlay(freezeFrame)`: overlay `setOpacity(0)` → async JS декодирует картинку → `setOpacity(1)`. Новый opaque-кадр pixel-match с предыдущим, перехода не видно.
4. `powerpointCommand('close')` работает под оверлеем — PP исчезает незаметно.
5. Electron-окно открывается/переиспользуется под оверлеем, `load-content` грузит PDF.
6. PdfViewer эмитит `content-ready` после двух rAF (см. [PdfViewer.tsx:88-93](../../../src/renderer/src/components/PresentationView/PdfViewer.tsx#L88-L93)).
7. `hideOverlay` → `setOpacity(0)` → один DWM-кадр, overlay исчезает, под ним уже готовый PDF.

Направление PDF→PPTX продолжает идти тем же кодпатчем, поведение не регрессирует.

## Edge-cases

- **prevActiveFile=null** (первый take) — захват не делаем, overlay чёрный. Корректно: нет исходного кадра.
- **isSameFilePptx** — сохраняем пропуск overlay, захват тоже не нужен.
- **overlayState=pinned-pptx на входе** — захват снимет существующий pinned-кадр (overlay сверху в DWM). `showOverlay` подгрузит pixel-identical кадр. Визуально неотличимо.
- **PPTX→video/image** — получают захват бонусом. Не scope, но не регрессия.
- **PPTX→audio/other(Word)** — идут в свои ветки, `hideOverlay` без ожидания `content-ready`. Существующий недостаток, не трогаем.
- **captureDisplay latency 50–150мс** — до `showOverlay`, юзер видит только задержку появления overlay после клика. Приемлемо.

## Тест-план (ручной)

1. A=PPTX, B=PDF. Take A → дождаться pinned. Take B → НЕ должно быть чёрной вспышки.
2. То же, но после take A нажать Next (overlay скрывается) → Take B → НЕ должно быть вспышки.
3. A=PDF, B=PPTX. Take A → Take B → бесшовно (регрессия-чек).
4. A=PPTX file1, B=PPTX file1 (same file разные каналы) → overlay не появляется (регрессия-чек).
5. A=PPTX file1, B=PPTX file2 → бесшовно через pinned (регрессия-чек).

## Риски

- `captureDisplay` иногда возвращает `null` (desktopCapturer race) — fallback на чёрный overlay, как сейчас. Частота низкая, degradation graceful.
- Лишний захват для сценариев X→PPTX где он и так делался — никакой дополнительной работы (код идентичен, просто условие шире не трогает существующую ветку).
