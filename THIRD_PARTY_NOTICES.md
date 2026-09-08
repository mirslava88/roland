# Third-Party Notices

Presentation Display Manager includes third-party open-source software.

## FFmpeg (separate streaming executable)

Only the Stream edition bundles FFmpeg; the standard edition excludes it.
The streaming module launches FFmpeg as a separate process. The Windows binary
provided by ffmpeg-static 5.3.0 is FFmpeg 6.1.1, Gyan essentials build, under GPL v3.
Its complete license and build information are shipped in `resources/ffmpeg/`
as `ffmpeg.exe.LICENSE` and `ffmpeg.exe.README`. The ffmpeg-static package license
is shipped there as `LICENSE`. The application does not link to libav libraries.

Binary distributor and corresponding source/build references:
https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
https://www.gyan.dev/ffmpeg/builds/
https://github.com/FFmpeg/FFmpeg/commit/e38092ef93

When redistributing binaries, retain these notices, the bundled license texts,
and satisfy the corresponding-source requirements of the executable's license.

## @hyzyla/pdfium 2.1.13

TypeScript/JavaScript wrapper for PDFium, distributed under the MIT License.
The complete license is included with the installed application at
`resources/licenses/hyzyla-pdfium-LICENSE.md`.

Source: https://github.com/hyzyla/pdfium

## PDF.js 6.3.289

PDF parsing and rendering components from Mozilla PDF.js, distributed under
the Apache License 2.0. The complete license is included at
`resources/licenses/pdfjs-dist-LICENSE.txt`.

Source: https://github.com/mozilla/pdf.js

## React 19.2.8, React DOM 19.2.8 and Scheduler 0.27.0

User-interface runtime components from the React project, distributed under
the MIT License. The complete license texts are included at
`resources/licenses/react-LICENSE.txt`,
`resources/licenses/react-dom-LICENSE.txt`, and
`resources/licenses/scheduler-LICENSE.txt`.

Source: https://github.com/facebook/react

## Zustand 5.0.15

Application state management library, distributed under the MIT License. The
complete license is included at `resources/licenses/zustand-LICENSE.txt`.

Source: https://github.com/pmndrs/zustand

## qr-code-styling 1.9.2 and qrcode-generator 1.5.2

QR-code generation and styling components, distributed under the MIT License.
The complete qr-code-styling license is included at
`resources/licenses/qr-code-styling-LICENSE.txt`.

Sources: https://github.com/kozakdenys/qr-code-styling and
https://github.com/kazuhikoarase/qrcode-generator

## Electron 44.1.1 and Chromium

The desktop runtime is distributed under the MIT License and includes Chromium
and other third-party components under their respective licenses. The complete
notices are included in the installed application as `LICENSE.electron.txt`
and `LICENSES.chromium.html`.

Source: https://github.com/electron/electron

## PDFium WebAssembly

The PDF rendering module is based on Chromium PDFium. PDFium and its bundled
third-party components are distributed under BSD-style and Apache 2.0 terms.
The complete PDFium attribution and license texts are included in the installed
application's `LICENSES.chromium.html` file under the `PDFium` section.

Source: https://github.com/chromium/pdfium

No endorsement by the third-party authors or contributors is implied.
