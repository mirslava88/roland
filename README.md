<div align="center">

<img src="build/icon.png" width="128" alt="Presentation Display Manager icon" />

# Presentation Display Manager

**Управление презентациями и медиаконтентом на втором экране без суеты в эфире**

Оператор видит библиотеку, каналы и управление — зрители видят только готовый контент.

[![Скачать для Windows](https://img.shields.io/badge/Скачать_для_Windows-.exe-16a34a?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/mirslava88/roland/releases/latest)

[![Latest release](https://img.shields.io/github/v/release/mirslava88/roland?label=версия&logo=github)](https://github.com/mirslava88/roland/releases/latest)
[![Build Windows](https://github.com/mirslava88/roland/actions/workflows/build-windows.yml/badge.svg)](https://github.com/mirslava88/roland/actions/workflows/build-windows.yml)
[![Downloads](https://img.shields.io/github/downloads/mirslava88/roland/total?label=загрузки&logo=github)](https://github.com/mirslava88/roland/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb.svg)](LICENSE)

![Electron](https://img.shields.io/badge/Electron-43.2.0-47848f?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111827)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-7-646cff?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06b6d4?logo=tailwindcss&logoColor=white)

</div>

---

## Что это

Presentation Display Manager — Windows-приложение для конференций, докладов, трансляций и мероприятий с двумя экранами. Главное окно остаётся у оператора, а PowerPoint, PDF, видео, изображения, камеры, платы видеозахвата, окна программ и таймер выводятся на выбранный проектор или дополнительный монитор.

```text
Файлы и внешние источники → каналы 1 / 2 / 3 / 4 → «В эфир» → внешний дисплей
           операторское окно                               экран зрителей
```

Приложение рассчитано на быстрые переключения: следующий материал можно подготовить в отдельном канале, не меняя текущую картинку в эфире.

## Основные возможности

- **Каналы 1 / 2 / 3 / 4 и дополнительные страницы** — заранее разложите контент и отправляйте нужный канал в эфир одним нажатием.
- **Бесшовное переключение эфира** — PDF, PowerPoint, видео и внешние источники сменяют друг друга без чёрного кадра, рабочего стола и мерцания; предыдущий кадр остаётся видимым до полной готовности следующего.
- **PowerPoint** — превью всех слайдов, переход к нужному слайду, next/prev и нативное слайд-шоу через Microsoft PowerPoint. При выходе Roland закрывает только созданный им экземпляр PowerPoint, а уже открытое пользовательское окно возвращает в исходное состояние.
- **PDF и офисные документы** — быстрый показ тяжёлых PDF, прогрессивная загрузка миниатюр и кэширование кадров; комбинированный рендер через Windows.Data.Pdf, PDFium и резервный pdf.js автоматически обходит проблемные страницы. Также доступен предпросмотр Word и Excel через установленный Microsoft Office.
- **Видео без потери позиции** — play/pause, seek, громкость и продолжение с сохранённого момента после переключения между каналами в текущей сессии.
- **Камеры и платы видеозахвата** — добавление веб-камер, USB-камер и HDMI/USB-плат для показа камеры, Apple TV и других внешних источников. Для устройств видеозахвата можно отдельно выбрать связанный аудиовход.
- **Окна программ и экраны** — автоматический список открытых окон, показ браузера, Word, Excel, Проводника, командной строки или целого экрана. Свёрнутое окно можно добавить по значку приложения: оно развернётся только после нажатия **«В эфир»**.
- **Курсор при показе окна** — когда оператор работает в PDM, курсор не попадает в миниатюру и эфир захваченного окна; при переходе в демонстрируемую программу используется привычный системный курсор Windows. Звук выбранной программы не захватывается.
- **Изображения и подложка** — фон показывается только после явного выбора и не переносится в следующую сессию.
- **Таймер поверх эфира** — перетаскивание, масштабирование, прозрачность текста, звуковые сигналы и отдельные цвета для основного времени, последней минуты и перелимита.
- **Музыкальный плеер** — плейлист, громкость, переход между треками и режимы повтора.
- **Управление дисплеями** — выбор внешнего экрана, режима Windows, разрешения и частоты обновления.
- **Масштаб Windows** — эфирное окно учитывает координаты и DPI выбранного дисплея, включая распространённый масштаб 150%.
- **Аудиовыход** — выбор устройства с корректным отображением русских названий.
- **Кликер** — глобальное управление слайдами стрелками и Page Up/Page Down.
- **Диагностика** — постоянный журнал с данными о дисплеях, PowerPoint, экспорте превью и воспроизведении медиа.

## Поддерживаемые форматы

| Тип | Форматы |
|---|---|
| Презентации | `.pptx`, `.ppt` |
| Документы | `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.txt`, `.rtf`, `.odt`, `.ods` |
| Видео | `.mp4`, `.mov`, `.avi`, `.webm`, `.mkv` |
| Изображения | `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.webp`, `.tiff`, `.tif`, `.svg` |
| Аудио | `.mp3`, `.wav`, `.ogg`, `.aac`, `.m4a`, `.flac`, `.wma` |
| Внешние источники | камеры и USB/HDMI-платы видеозахвата, окна программ, экраны |

> Фактическое воспроизведение конкретного видео- или аудиокодека зависит от поддержки Chromium и Windows, а не только от расширения файла.

## Установка

1. Скачайте актуальный `.exe` на странице [Releases](https://github.com/mirslava88/roland/releases/latest).
2. Запустите `Presentation Display Manager Setup x.x.x.exe`.
3. Выберите папку установки и завершите установку.
4. Подключите второй монитор или проектор и включите в Windows режим **«Расширить»**.
5. В приложении откройте настройки дисплеев и выберите экран для эфира.

CI-сборки публикуются без коммерческой цифровой подписи. Поэтому Windows SmartScreen может показать предупреждение «Неизвестный издатель»: нажмите **«Подробнее» → «Выполнить в любом случае»**, если установщик скачан из официального раздела Releases этого репозитория.

### Системные требования

- Windows 10/11 x64;
- второй дисплей или проектор для полноценного эфирного режима;
- Microsoft PowerPoint desktop для показа PPT/PPTX и создания превью слайдов;
- Microsoft Word/Excel desktop для предпросмотра соответствующих документов.

PDF, изображения, видео, музыка и таймер не требуют установленного PowerPoint.

## Как работать

1. Выберите папку с материалами в левой панели либо добавьте камеру, плату видеозахвата, окно программы или экран в разделе **«Внешние источники»**.
2. Перетащите материал или внешний источник в канал 1, 2, 3 или 4. Кнопка `+` добавляет ещё одну страницу из четырёх каналов.
3. При необходимости заранее выберите слайд или поставьте видео на нужную позицию.
4. Нажмите **«В эфир»** или дважды щёлкните по каналу. Свёрнутое окно программы развернётся только на этом шаге.
5. Кнопка **«Выйти из эфира»** закрывает текущий материал. Если в этой сессии выбрана подложка, появится она; иначе внешний экран станет чёрным.

Для PPTX и PDF доступны стрелки и прямой ввод номера слайда. Позиции слайдов сохраняются отдельно для каждого файла. При переключении с поставленного на паузу видео на другой канал его позиция сохраняется до закрытия приложения.

## Таймер

Таймер открывается поверх контента на внешнем дисплее и не мешает управлению презентацией. Доступны:

- длительность и быстрые поправки `±1`, `±5`, `±10` минут;
- перетаскивание мышью и масштабирование колёсиком до 8×;
- прозрачность текста;
- **цвет основного таймера**;
- **цвет за одну минуту до окончания**;
- **цвет перелимита времени**;
- отдельные звуковые сигналы на отметках 1:00 и 0:00.

Положение, масштаб и оформление сохраняются. Текущее время и выбранные звуки начинаются заново при каждом запуске.

## Диагностика

Если на конкретном компьютере не создаются превью PPTX, появляется чёрный экран или некорректно определяется монитор:

1. Запустите приложение и воспроизведите проблему.
2. Откройте **Настройки → Диагностика**.
3. Нажмите **«Открыть папку логов»**.
4. Передайте файл `pdm-diagnostic.log` разработчику.

Лог содержит версии приложения, Windows, Electron и Office, параметры экранов и DPI, этапы запуска PowerPoint, экспорт превью и ошибки медиапротокола. При достижении 8 МБ он автоматически ротируется; предыдущая версия сохраняется рядом.

## Разработка и сборка

Понадобятся Node.js 22.13+ (или 24+) и Windows PowerShell.

```powershell
npm ci

npm run dev          # режим разработки с hot reload
npm run build        # сборка main/preload/renderer в out/
npm run package:win  # Windows NSIS installer в dist/
```

Подписанная локальная сборка поддерживается отдельным сценарием и требует собственного `.pfx`-сертификата:

```powershell
powershell -ExecutionPolicy Bypass -File .\build\build-signed.ps1
```

Для автоматической сборки используется [GitHub Actions](.github/workflows/build-windows.yml). Ручной запуск создаёт artifact, а push тега `v*` дополнительно публикует GitHub Release.

## Технологии

| Слой | Реализация |
|---|---|
| Версия приложения | 1.1.4 |
| Desktop runtime | Electron 43.2.0 |
| Интерфейс | React 19.2.8, TypeScript 7.0.2, Tailwind CSS 4.3.3 |
| Состояние | Zustand 5.0.14 |
| Сборка | electron-vite 5.0.0, Vite 7.3.6, PostCSS 8.5.25, electron-builder 26.15.3, NSIS |
| PowerPoint | PowerShell, COM Automation, постоянный JSON-демон с восстановлением состояния Office |
| PDF | PDFium WASM (@hyzyla/pdfium 2.1.13), pdfjs-dist 6.2.108 и Windows.Data.Pdf |
| Внешние источники | Electron Desktop Capture, MediaDevices, постоянные видеопотоки и нативное перечисление окон Windows |
| Таймер | WPF-оверлей через PowerShell |

Архитектура бесшовного эфира и обязательные правила против регрессий описаны в [`docs/SEAMLESS_SWITCHING.md`](docs/SEAMLESS_SWITCHING.md).

## Безопасность и приватность

- renderer работает с `sandbox`, `contextIsolation`, `webSecurity` и Content Security Policy;
- локальные файлы передаются через ограниченный протокол `pdm-media://`, а не открываются напрямую через `file://`;
- переходы, разрешения и допустимые пути проверяются в main process;
- Electron Fuses отключают `RunAsNode`, `NODE_OPTIONS` и CLI Inspector; шифрование cookies, проверка целостности ASAR и загрузка приложения только из ASAR включены;
- приложение не требует учётной записи и работает офлайн;
- CI не хранит сертификаты подписи в репозитории.

Технические материалы находятся в папке [`compliance/`](compliance/), а уведомления о лицензиях встроенных компонентов — в [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Структура проекта

```text
src/
  main/       окна, IPC, диагностика, PowerPoint-демон, захват окон, pdm-media
  preload/    изолированный API между renderer и main process
  renderer/   React-интерфейс оператора и эфирного окна
scripts/      PowerShell: Office COM, таймер, аудио и дисплеи
build/        иконка, NSIS-настройки, Electron Fuses и подпись
compliance/   документы по безопасности и сетевому поведению
docs/         архитектурные заметки и правила против регрессий
```

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE): его можно свободно использовать, изменять и распространять с сохранением текста лицензии.

---

<details>
<summary><strong>English summary</strong></summary>

### Presentation Display Manager

Presentation Display Manager is a Windows desktop application for driving a projector or secondary display during conferences, talks, streams, and live events. The operator keeps the library, channel grid, and playback controls on the primary monitor while the audience sees only the selected content.

Key features include numbered multi-page channels (1/2/3/4, 5/6/7/8, …), seamless flicker-free switching between PDF, PowerPoint, video and live sources, native PowerPoint control and slide previews, fast rendering and progressive thumbnails for complex PDFs, Office document previews, cameras and USB/HDMI capture devices, program-window and screen capture, video playback with in-session position restore, images, background music, configurable display and audio output, a draggable timer with normal/warning/overtime colors, and built-in diagnostic logging. Minimized program windows are restored only when taken on air, and the operator cursor is kept out of captured-window previews while PDM has focus. Program-window audio is not captured.

Download the latest Windows installer from [GitHub Releases](https://github.com/mirslava88/roland/releases/latest). Microsoft PowerPoint is required for PPT/PPTX playback and preview generation. The application itself works offline and is released under the [MIT License](LICENSE).

```powershell
npm ci
npm run dev
npm run build
npm run package:win
```

</details>
