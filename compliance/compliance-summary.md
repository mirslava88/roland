# Compliance Summary — Presentation Display Manager

**Date:** 2026-09-01

**Application:** Presentation Display Manager 1.1.4 (`private`, MIT)

**Runtime:** Electron 44.1.0 (Chromium 152, Node.js 24)

This folder contains the supply-chain and security artifacts for the dependency
tree used to build release 1.1.4.

## Artifacts

| File | Purpose |
|---|---|
| `sbom.cdx.json` | CycloneDX 1.6 SBOM for the complete npm dependency tree. |
| `licenses.json` | Per-package license report with project-relative paths only. |
| `npm-audit.json` | Raw npm audit result for the locked dependency tree. |
| `network-behavior.md` | Packaged application's inbound/outbound network behavior. |
| `compliance-summary.md` | This summary. |

Runtime attribution and license locations are documented in
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). The notice file and
the applicable runtime license texts are included in the packaged application.

## Vulnerabilities

`npm audit` reports **0 known vulnerabilities**: 0 critical, 0 high, 0
moderate, 0 low, and 0 informational findings.

The audit covers 504 resolved dependency entries (production, development,
optional, and peer dependencies) from the current lock file. Build-time and
runtime dependencies are both represented in the SBOM.

## Licenses

The full installed tree contains 354 package entries:

- MIT: 273
- ISC: 37
- Apache-2.0: 11
- BSD-3-Clause: 10
- BlueOak-1.0.0: 8
- BSD-2-Clause: 6
- MPL-2.0: 2
- Other permissive licenses: 7

The two MPL-2.0 entries are Lightning CSS build-time packages; they are not
bundled as application runtime modules. No GPL, AGPL, or LGPL package was found
in the generated report.

## Security posture

- Windows release target: x64 NSIS, per-machine installation.
- CI release installer: **unsigned**. Windows SmartScreen may show “Unknown
  Publisher”. No certificate or private key is stored in the repository.
- Electron fuses are explicitly audited: RunAsNode, Node options, and Node CLI
  inspection and the unavailable browser-specific V8 snapshot are disabled;
  cookie encryption, ASAR integrity, ASAR-only loading, local file privileges,
  and WASM trap handlers are enabled.
- Renderer windows use sandboxing, context isolation, disabled Node integration,
  web security, CSP, navigation guards, and a narrow typed preload API.
- PDF.js workers and PDFium WASM are bundled locally; PowerPoint and Office
  automation use local Windows processes and COM.
- Application diagnostics are written locally and are excluded from Git.

## Remaining deployment hardening

- Sign the Windows installer and executable with the organization's production
  code-signing certificate.
- Sign bundled PowerShell scripts if the target environment enforces AllSigned.
- Re-run `npm audit`, regenerate the SBOM/license report, and repeat the packaged
  Windows smoke test for every public release.
