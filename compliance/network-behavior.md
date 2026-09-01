# Network Behavior — Presentation Display Manager

**Date:** 2026-09-01

**Scope:** packaged application 1.1.4 (development tooling is excluded)

## Summary

The packaged application makes no outbound network connections by design and
remains functional without network access. It contains no telemetry, analytics,
auto-updater, or remote-content integration.

## Source and package review

- The application does not call `http`, `https`, Electron `net.request`,
  `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or an update service.
- The renderer's `fetch` call loads the locally bundled PDFium WASM asset.
- The custom `pdm-media://` protocol reads approved local files through local
  filesystem streams; it does not make a network request.
- PDF.js worker code and PDFium WASM are included in the application package.
- PowerPoint, PDF, image, audio, video, capture, and Office-document processing
  are local to the Windows host.

## Renderer controls

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `webSecurity: true`
- Content Security Policy and top-level navigation guards
- External `http`, `https`, or `mailto` links open only through the operating
  system after an explicit user action

## Inbound traffic

The packaged application does not listen on a TCP or UDP port. The localhost
development server used by electron-vite exists only during development and is
not part of the packaged release.

## Perimeter conclusion

No firewall allow-rule is required for PDM itself. The application is suitable
for offline or egress-filtered deployment. Windows, Microsoft Office, and other
software installed on the same computer may have their own independent network
behavior outside PDM's control.
