<div align="center">

# 🎬 Presentation Display Manager

### Бесшовное переключение презентаций, PDF, видео и изображений на втором экране
*Seamless switching of presentations, PDFs, videos & images on a secondary display*

<br/>

![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-3-06B6D4?logo=tailwindcss&logoColor=white)

![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Chromium](https://img.shields.io/badge/Chromium-148-4285F4?logo=googlechrome&logoColor=white)
![Node](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)

![License](https://img.shields.io/badge/license-Proprietary-red)
![npm audit](https://img.shields.io/badge/npm_audit-0_vulnerabilities-success?logo=npm)
![Security](https://img.shields.io/badge/security-hardened-success?logo=shieldsdotio)
![Offline](https://img.shields.io/badge/network-fully_offline-success)
![last commit](https://img.shields.io/github/last-commit/mirslava88/roland)

</div>

---

## 📖 О проекте

**Presentation Display Manager** — десктопное приложение для **Windows**, управляющее контентом на втором экране (проектор / монитор зала) с **бесшовными переходами без чёрных кадров и мерцания**.

Сделано для докладчиков, конференций, церквей и любых сцен, где переключение между **PowerPoint, PDF, видео и изображениями** должно быть мгновенным и чистым — оператор видит библиотеку и панель управления, зал видит только готовый контент.

## ✨ Возможности

- 🔄 **Бесшовные «takes»** — переходы PPTX ↔ PDF ↔ видео ↔ картинка без чёрных кадров: оверлей перекрывает композиторную гонку DWM, пока новый контент готовится «за кадром».
- 📊 **PowerPoint через COM** — нативное управление слайдшоу (next / prev / goto / close) через persistent PowerShell-демон с JSON-протоколом.
- 📄 **PDF** — нативный рендер `Windows.Data.Pdf` (WinRT) + pdf.js, попиксельно точный на любом размере.
- 🎥 **Видео**, 🖼️ **изображения**, 🎵 **аудио** на втором экране.
- ⏱️ **Таймер-оверлей** для докладчика (WPF-окно, перетаскивание + масштаб колесом, звуковые предупреждения).
- 🎵 **Музыкальный плеер** — фоновые плейлисты с loop/seek/volume.
- 🗂️ **Файловая библиотека** — просмотр дисков (вкл. сетевые), превью, drag-and-drop, переименование/перемещение/удаление.
- 🔊 Переключение **аудио-устройства**, скрытие **таскбара** на нужном экране, смена **разрешения** дисплея.

## 🛠️ Технологический стек

| Слой | Технологии |
|------|-----------|
| **Runtime** | Electron 42 (Chromium 148, Node 24) |
| **UI** | React 19 · TypeScript 5 · Tailwind CSS 3 |
| **Сборка** | electron-vite · Vite 6 · electron-builder 26 (NSIS) |
| **Состояние** | zustand |
| **PowerPoint** | PowerShell + COM Automation (persistent daemon) |
| **PDF** | pdfjs-dist · Windows.Data.Pdf (WinRT) |
| **Таймер** | WPF (PowerShell `Add-Type`) |

## 🔐 Безопасность — готово к корпоративному периметру

Приложение прошло **состязательный многоагентный security-аудит** и хардненинг:

- ✅ **Подписанный** NSIS-инсталлятор (Authenticode), установка в Program Files
- ✅ **Electron Fuses** закалены — `RunAsNode` / `NodeOptions` / `NodeCliInspect` отключены, cookie-шифрование включено
- ✅ `sandbox: true`, `webSecurity: true`, строгий **CSP**; локальное медиа отдаётся через кастомный привилегированный протокол **`pdm-media://`** вместо `file://`
- ✅ Глобальные nav/permission-guards, allowlist'ы путей и расширений, `-NoProfile` на всех PowerShell-вызовах
- ✅ **0 уязвимостей** (`npm audit`), все лицензии зависимостей пермиссивные (без GPL/AGPL)
- ✅ **Полностью офлайн** — ноль исходящих сетевых соединений (подходит для air-gapped-среды)
- 📋 Compliance-артефакты (CycloneDX SBOM, отчёт по лицензиям, описание сетевого поведения) — в [`compliance/`](compliance/)

## 🚀 Запуск и сборка

```bash
npm install

npm run dev          # режим разработки (hot-reload)
npm run build        # компиляция в out/

# подписанный установщик → dist/Presentation Display Manager Setup x.x.x.exe
powershell -File build\build-signed.ps1
```

> ⚠️ Если в окружении выставлена `ELECTRON_RUN_AS_NODE=1` — очисти её перед `npm run dev` (или запускай через `dev.cmd`), иначе Electron стартует как Node.
>
> 🔑 Для продакшен-подписи замени плейсхолдер-сертификат: укажи `CSC_LINK` на корпоративный `.pfx` и `CSC_KEY_PASSWORD` — остальной pipeline в `build-signed.ps1` уже готов.

## 📁 Структура проекта

```
src/
  main/        — главный процесс: окна, IPC, overlay, PowerPoint-демон, протокол pdm-media
  renderer/    — UI на React (control + presentation окна)
  preload/     — contextBridge API (изолированный мост renderer↔main)
scripts/       — PowerShell: COM-управление PP, рендер PDF, таймер, аудио, окна
build/         — afterPack (fuses) + двухфазная подписанная сборка
compliance/    — SBOM, лицензии, сетевое поведение
```

## 📜 Лицензия

Проприетарное ПО (`UNLICENSED`). Все права защищены. © Roland.

---

<details>
<summary><b>🇬🇧 English version</b></summary>

<br/>

**Presentation Display Manager** is a **Windows** desktop app that drives a secondary display (projector / hall monitor) with **seamless, flicker-free transitions**. Built for speakers, conferences and any stage where switching between **PowerPoint, PDF, video and images** must be instant and clean — the operator sees the library and controls, the audience sees only finished content.

### ✨ Features
- 🔄 **Seamless "takes"** — PPTX ↔ PDF ↔ video ↔ image transitions with no black frames (an overlay masks the DWM compositor race while the next content is prepared off-screen).
- 📊 **PowerPoint via COM** — native slideshow control (next / prev / goto / close) through a persistent PowerShell daemon with a JSON protocol.
- 📄 **PDF** — native `Windows.Data.Pdf` (WinRT) render + pdf.js, pixel-perfect at any size.
- 🎥 Video, 🖼️ images, 🎵 audio on the secondary display.
- ⏱️ **Timer overlay** for the speaker (WPF window, drag + scroll-to-scale, sound warnings).
- 🎵 **Music player** — background playlists with loop / seek / volume.
- 🗂️ **File library** — drive browsing (incl. network shares), previews, drag-and-drop, rename / move / delete.
- 🔊 Audio-device switching, per-display taskbar hiding, display-resolution control.

### 🛠️ Stack
Electron 42 (Chromium 148, Node 24) · React 19 · TypeScript · Tailwind · electron-vite / Vite 6 · electron-builder 26 (NSIS) · zustand · PowerShell + COM Automation · pdfjs-dist / Windows.Data.Pdf.

### 🔐 Security — corporate-perimeter ready
Passed an adversarial multi-agent security audit and hardening: Authenticode-signed NSIS installer; hardened Electron Fuses; `sandbox` + `webSecurity` on, strict CSP, local media served via a custom privileged `pdm-media://` protocol; navigation / permission guards and path allow-lists; `-NoProfile` on all PowerShell spawns; **0 npm vulnerabilities**, permissive-only dependency licenses; **fully offline** (no outbound connections). Compliance artifacts (CycloneDX SBOM, license report, network-behavior doc) live in [`compliance/`](compliance/).

### 🚀 Run & build
```bash
npm install
npm run dev          # development
npm run build        # compile to out/
powershell -File build\build-signed.ps1   # signed installer -> dist/
```
> If `ELECTRON_RUN_AS_NODE=1` is set in the environment, clear it before `npm run dev` (or use `dev.cmd`). For production signing, point `CSC_LINK` at the corporate `.pfx` and set `CSC_KEY_PASSWORD`.

### 📜 License
Proprietary (`UNLICENSED`). All rights reserved. © Roland.

</details>
