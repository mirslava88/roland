# Compliance Summary — Presentation Display Manager

**Date:** 2026-06-24
**Application:** Presentation Display Manager 1.0.0 (proprietary, `UNLICENSED`, `private`)
**Framework:** Electron 42.5.0 (Chromium 148, Node 24) — latest stable, in support.

This folder holds the supply-chain / compliance artifacts a corporate security review
typically requests. All generated artifacts reflect the dependency tree as of the date above.

## Artifacts in this folder

| File | What it is |
|------|------------|
| `sbom.cdx.json` | Software Bill of Materials (CycloneDX JSON) — full direct + transitive dependency tree with versions and licenses. |
| `licenses.json` | Per-package license report (license-checker). |
| `network-behavior.md` | Documented outbound/inbound network behavior. |
| `compliance-summary.md` | This file. |

## 1. Vulnerabilities

**`npm audit`: 0 vulnerabilities.**

The three previously-present issues were all in **build-time dev tooling** (vite dev server,
postcss, @babel/core) — never shipped in the packaged application — and were resolved via
`npm audit fix` with in-range patch bumps (vite 6.4.3, postcss 8.5.15, @babel/core 7.29.7).
No breaking changes; the build was re-verified.

## 2. Licenses

All dependency licenses are **permissive** — **no GPL / AGPL / LGPL (copyleft)** present, so
there is no copyleft obligation for a proprietary distribution.

Breakdown (full tree): MIT ×318, ISC ×41, Apache-2.0 ×11, BSD-3-Clause ×10, BlueOak-1.0.0 ×8,
BSD-2-Clause ×6, plus single permissive entries (0BSD, WTFPL, Python-2.0, CC-BY-4.0,
MIT-OR-CC0). The application itself is declared `UNLICENSED` (proprietary, intentional).

## 3. Supply chain / protestware

Scanned clean: no known protestware/sabotage packages (node-ipc, peacenotwar, es5-ext, colors,
faker, event-source-polyfill, styled-components — none present), no political/ideological text
or geopolitical symbolism in dependency assets, and the only 3 install scripts (electron,
esbuild, fsevents) are standard upstream binary installers.

**Recommended ongoing control:** Socket.dev (GitHub app / CLI — has a dedicated protestware
alert category) and `osv-scanner` against the OpenSSF `ossf/malicious-packages` database, run
in CI so any future install of a flagged version is caught automatically.

## 4. Network behavior

The application makes **no outbound network connections** and is fully functional offline —
suitable for an air-gapped / egress-filtered environment. See `network-behavior.md`.

## 5. Application security posture (summary)

- **Packaging:** signed NSIS installer (currently a placeholder dev cert — to be replaced with
  the corporate code-signing certificate); installs to Program Files (perMachine).
- **Electron Fuses (hardened):** RunAsNode=off, EnableNodeOptionsEnvironmentVariable=off,
  EnableNodeCliInspectArguments=off, EnableCookieEncryption=on, OnlyLoadAppFromAsar=on,
  EnableEmbeddedAsarIntegrityValidation=on (anti-tamper).
- **Renderer:** sandbox=true, contextIsolation=true, nodeIntegration=false, webSecurity=true
  (local media served via the `pdm-media://` privileged protocol), strict CSP, global
  navigation/permission guards, scheme-allowlisted `openExternal`.
- **IPC / process:** `powershell.exe` spawned with `-NoProfile`; renderer-supplied paths
  validated (extension allow-list on external-open, traversal guard on rename).

## Outstanding (gated on the corporate code-signing certificate)

- Replace placeholder signing cert with the corporate-CA `.pfx`.
- Remove `-ExecutionPolicy Bypass` and sign the bundled `.ps1` scripts (run under AllSigned).
- Pre-compile the PowerShell `Add-Type` C#/COM helpers into a signed `.dll` (survives
  PowerShell Constrained Language Mode) — to be tested on the target WDAC/CLM environment.
