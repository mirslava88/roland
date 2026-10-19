import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.platform === 'darwin') {
  for (const name of ['mac-pdf-pages', 'mac-keynote-backdrop', 'mac-audio-control', 'mac-display-control', 'mac-doc-preview', 'mac-stream-capture']) {
    const source = resolve(`scripts/${name}.swift`)
    const target = resolve(`build/${name}`)
    let current = false
    try {
      current = statSync(target).mtimeMs >= Math.max(statSync(source).mtimeMs, statSync(new URL(import.meta.url)).mtimeMs)
    } catch { /* build missing */ }
    if (current) continue
    mkdirSync(resolve('build'), { recursive: true })
    const moduleCache = resolve('build/.swift-module-cache')
    mkdirSync(moduleCache, { recursive: true })
    const env = { ...process.env, SWIFT_MODULECACHE_PATH: moduleCache, CLANG_MODULE_CACHE_PATH: moduleCache }
    const pieces = []
    for (const arch of ['x86_64', 'arm64']) {
      const output = `${target}-${arch}`
      const result = spawnSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macosx11.0`, source, '-o', output], {
        stdio: 'inherit', env
      })
      if (result.error) throw result.error
      if (result.status !== 0) process.exit(result.status || 1)
      pieces.push(output)
    }
    const merged = spawnSync('xcrun', ['lipo', '-create', ...pieces, '-output', target], { stdio: 'inherit' })
    if (merged.error) throw merged.error
    if (merged.status !== 0) process.exit(merged.status || 1)
  }
  const displaySource = resolve('scripts/mac-render-display.mm')
  const displayTarget = resolve('build/mac-render-display')
  let displayCurrent = false
  try { displayCurrent = statSync(displayTarget).mtimeMs >= Math.max(statSync(displaySource).mtimeMs, statSync(new URL(import.meta.url)).mtimeMs) }
  catch { /* helper missing */ }
  if (!displayCurrent) {
    const result = spawnSync('xcrun', ['clang++', '-O2', '-std=c++17', '-fobjc-arc',
      '-arch', 'x86_64', '-arch', 'arm64', '-mmacosx-version-min=11.0', '-framework', 'Foundation', '-framework', 'CoreGraphics',
      displaySource, '-o', displayTarget], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status || 1)
  }
  const nativeSource = resolve('scripts/mac-office-accessibility.mm')
  const nativeTarget = resolve('build/mac-office-accessibility.node')
  let nativeCurrent = false
  try {
    nativeCurrent = statSync(nativeTarget).mtimeMs >= Math.max(statSync(nativeSource).mtimeMs, statSync(resolve("scripts/mac-keynote-bridge.h")).mtimeMs, statSync(resolve('scripts/mac-keynote-identity.h')).mtimeMs, statSync(new URL(import.meta.url)).mtimeMs)
  } catch { /* build missing */ }
  if (!nativeCurrent) {
    const result = spawnSync('xcrun', ['clang++', '-O2', '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
      '-arch', 'x86_64', '-arch', 'arm64', '-mmacosx-version-min=11.0',
      '-I', resolve('node_modules/node-api-headers/include'), '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScriptingBridge',
      nativeSource, '-o', nativeTarget], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status || 1)
  }
}
