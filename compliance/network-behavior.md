# Network Behavior — Presentation Display Manager

**Date:** 2026-06-24
**Scope:** outbound/inbound network behavior of the packaged application (not dev tooling).

## Summary

**The application makes no outbound network connections by design. It is fully functional offline.**

There is no telemetry, no analytics, no auto-update, and no remote content loading. All
processing (presentation rendering, PDF/PPTX handling, audio/video playback, PowerPoint COM
automation) happens locally on the host.

## Evidence (source analysis)

A repo-wide scan of the application source (`src/`) for outbound network primitives
(`fetch`, `XMLHttpRequest`, `WebSocket`, `axios`, `net.request`, `navigator.sendBeacon`,
`autoUpdater`, `electron-updater`, `http(s)://` endpoints) returned **no outbound calls**:

- The only `net.fetch` call (`src/main/index.ts`) is the handler for the custom
  `pdm-media://` protocol. It fetches **local** files via the `file://` scheme
  (`net.fetch(pathToFileURL(localPath))`) — i.e. a disk read, not a network request.
- `pdf.js` worker is **bundled locally** (`out/renderer/assets/pdf.worker-*.mjs`) — no CDN.
- No auto-updater is configured (no `electron-updater` / `autoUpdater` usage, no `publish`
  config in electron-builder).
- No analytics/telemetry SDKs are present in the dependency tree.

## Renderer / engine

- Renderers run with `webSecurity: true`, `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, and a strict CSP (`default-src 'self'; script-src 'self'`).
- A global navigation guard denies any top-level navigation away from the app origin
  (`will-navigate` / `will-redirect`), and `setWindowOpenHandler` only forwards
  `http/https/mailto` links to the OS browser on explicit user action.
- Electron does not bundle Chrome's telemetry, component-updater, or safe-browsing services,
  so there is no default background outbound traffic from the framework.

## Local-only subsystems

- **PowerPoint control:** spawns `powershell.exe` running local `.ps1` scripts that drive
  PowerPoint via COM automation. No network.
- **PDF render:** native Windows.Data.Pdf (WinRT) via local PowerShell. No network.
- **Media (images/video/audio):** served from local disk via the `pdm-media://` protocol.
- **IPC:** in-process Electron IPC only.

## Inbound

- None in the packaged build. (The `http://localhost:5173` dev server is **electron-vite HMR,
  development only** — it is not present in the packaged application.)

## Conclusion for perimeter review

The application can be run with **no network access** and remains fully functional. It is
suitable for an air-gapped or strictly egress-filtered environment. No firewall allow-rules
are required for the application itself.
