# Network Behavior — PDM standard and Stream

**Date:** 2026-09-08. **Scope:** current 1.1.5 / 1.1.5-stream source and packaging configuration.
This note supersedes the 1.1.4 offline-only description for Stream. It is not a packet-capture audit.

## Local presentation features (both editions)

Local presentation, PDF, Office, camera, timer and QR processing work offline.
There is no telemetry, automatic update client or automatic stream start.
Bundled PDF workers/WASM and the `pdm-media://` filesystem protocol load local assets.
External web/mail links are handed to the OS only after user action. Windows,
Office and other applications can have independent network activity.

## Standard edition

The standard build removes the streaming controller, IPC API, worker and FFmpeg
resource. Local display operation does not require an outbound firewall rule.

## Stream edition — explicit operator actions

- Address checks open TCP/TLS connections to the selected destinations without
  sending video, audio or the stream key. They cannot verify stream credentials.
- Starting a stream sends the selected display and audio to operator-configured
  RTMP/RTMPS endpoints through separate FFmpeg processes. DNS lookup, outbound TCP
  and (for RTMPS) TLS are required. RTMP without TLS is unencrypted in transit.
- Each destination may reconnect while streaming remains active. Closing the
  settings panel does not stop it; Stop or application shutdown terminates sending.
- RTMPS validates certificates; errors are reported without displaying private URLs
  or keys. Saved keys use Electron safeStorage in the Stream user profile and are
  excluded from `.pdmconfig` exports and diagnostic messages.
- The entire selected display and, if enabled, system audio are captured, including
  unrelated windows and notifications. Choose a dedicated output screen.

No public listening port is opened by the packaged application. Development and
RTMP test scripts can listen on localhost; they are not shipped as application features.

## Renderer protection

Sandboxing, context isolation, disabled Node integration, web security, CSP and
navigation guards remain enabled in both editions. Electron fuse verification is
part of packaging. Internet access is required only when the operator uses a
network-dependent action, not for ordinary local presentation output.
