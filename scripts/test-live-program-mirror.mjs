import assert from 'node:assert/strict'
import { resolve } from 'node:path'

// Manual hardware regression check. It replaces the first channel with the
// repository test PDF and changes the live output/QR state; use a test profile.
const port = Number(process.argv[2] || 9222)
const pdfPath = resolve('testprez.pdf')
const layerPath = resolve('build/icon.png')
const videoPath = resolve('sample-5s.mp4')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(label, check, timeout = 30_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const result = await check()
    if (result) return result
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

class Cdp {
  constructor(target) {
    this.socket = new WebSocket(target.webSocketDebuggerUrl)
    this.pending = new Map()
    this.nextId = 1
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  async connect() {
    await new Promise((done, fail) => {
      this.socket.addEventListener('open', done, { once: true })
      this.socket.addEventListener('error', fail, { once: true })
    })
  }

  async evaluate(expression) {
    const id = this.nextId++
    const result = await new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail })
      this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        expression, awaitPromise: true, returnByValue: true, userGesture: true
      } }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'CDP evaluate failed')
    return result.result?.value
  }

  close() { this.socket.close() }
}

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json`)
  assert.equal(response.ok, true)
  return response.json()
}

const pages = await targets()
const controlTarget = pages.find((page) => page.type === 'page' && /\/index\.html$/.test(page.url))
const mirrorTarget = pages.find((page) => page.type === 'page' && /role=mirror/.test(page.url))
assert.ok(controlTarget, 'PDM control window is unavailable')
assert.ok(mirrorTarget, 'No live-copy display is configured')
const control = new Cdp(controlTarget)
const mirror = new Cdp(mirrorTarget)
await Promise.all([control.connect(), mirror.connect()])

try {
  await control.evaluate(`(() => {
    const liveButton = document.querySelector('[data-program-scene-picture-visible]')
    if (liveButton && /Выйти/.test(liveButton.textContent || '')) liveButton.click()
    document.querySelector('[data-program-scene-close]')?.click()
    return true
  })()`)
  await sleep(500)
  await control.evaluate(`(() => {
    document.querySelectorAll('[data-pdm-training-close]').forEach((button) => button.click())
    const channel = document.querySelector('[data-pdm-channel-id]')
    if (!channel) return false
    const transfer = new DataTransfer()
    transfer.setData('application/json', JSON.stringify({
      id: 'program-mirror-regression-pdf', name: 'Mirror regression PDF',
      path: ${JSON.stringify(pdfPath)}, type: 'pdf', extension: '.pdf',
      size: 0, isImage: false, isAudio: false
    }))
    channel.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    return true
  })()`)
  const channelId = await waitFor('PDF channel', () => control.evaluate(`(() => {
    const channel = document.querySelector('[data-pdm-channel-id]')
    return channel?.textContent?.includes('Mirror regression PDF')
      ? channel.getAttribute('data-pdm-channel-id') : null
  })()`))
  await waitFor('PDF ready for TAKE', () => control.evaluate(`(() => {
    const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
    const button = channel?.querySelector('[data-pdm-channel-take]')
    return Boolean(channel?.classList.contains('is-live') ||
      (button && !button.disabled && channel.getAttribute('aria-busy') !== 'true'))
  })()`), 60_000)
  await control.evaluate(`(() => {
    const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
    if (!channel?.classList.contains('is-live')) channel?.querySelector('[data-pdm-channel-take]')?.click()
    return true
  })()`)
  await waitFor('PDF on air', () => control.evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"].is-live`)}))`), 60_000)
  await waitFor('direct PDF on mirror', () => mirror.evaluate(`Boolean(Array.from(document.images).find((image) => image.className.includes('object-contain') && image.naturalWidth))`), 60_000)

  const openQrMenu = () => control.evaluate(`(() => {
    const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
    channel?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }))
    return Boolean(channel)
  })()`)
  assert.equal(await openQrMenu(), true, 'Channel context menu is unavailable')
  await waitFor('QR menu item', () => control.evaluate(`Boolean(document.querySelector('[data-channel-toggle-qr]'))`))
  const qrWasVisible = await control.evaluate(`/Скрыть/.test(document.querySelector('[data-channel-toggle-qr]')?.textContent || '')`)
  if (!qrWasVisible) await control.evaluate(`document.querySelector('[data-channel-toggle-qr]')?.click(); true`)
  else await control.evaluate(`document.body.click(); true`)
  const needQrData = await control.evaluate(`Boolean(document.querySelector('[data-program-scene-modal]'))`)
  if (needQrData) {
    await waitFor('QR settings', () => control.evaluate(`Boolean(document.querySelector('[data-pdm-training-qr-url]'))`))
    await control.evaluate(`(() => {
      const input = document.querySelector('[data-pdm-training-qr-url]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, 'https://example.org/pdm-mirror-test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await control.evaluate(`document.querySelector('[data-program-scene-close]')?.click(); true`)
    assert.equal(await openQrMenu(), true)
    await waitFor('QR menu item after setup', () => control.evaluate(`Boolean(document.querySelector('[data-channel-toggle-qr]'))`))
    await control.evaluate(`document.querySelector('[data-channel-toggle-qr]')?.click(); true`)
  }
  await waitFor('QR on direct mirror', () => mirror.evaluate(`Boolean(document.querySelector('[data-scene-qr-object] img')?.naturalWidth)`), 30_000)

  await control.evaluate(`document.querySelector('[data-toolbar-item="pip"] button')?.click(); true`)
  await waitFor('Scene dialog', () => control.evaluate(`Boolean(document.querySelector('[data-program-scene-modal]'))`))
  await control.evaluate(`(() => {
    const button = document.querySelector('[data-program-scene-picture-visible]')
    if (button && /Показать/.test(button.textContent || '')) button.click()
    return true
  })()`)
  await waitFor('Scene on air', () => control.evaluate(`(() => {
    const button = document.querySelector('[data-program-scene-picture-visible]')
    return Boolean(button && !button.disabled && /Выйти/.test(button.textContent || ''))
  })()`), 60_000)
  const sceneResult = await waitFor('composited PDF and QR on mirror', () => mirror.evaluate(`(() => {
    const frame = Array.from(document.images).find((image) =>
      image.src.startsWith('data:image/jpeg') && image.className.includes('object-contain'))
    const qr = document.querySelector('[data-scene-qr-object] img')
    if (!frame?.naturalWidth || !qr?.naturalWidth) return null
    const canvas = document.createElement('canvas')
    canvas.width = 12; canvas.height = 8
    const context = canvas.getContext('2d')
    context.drawImage(frame, 0, 0, 12, 8)
    const pixels = context.getImageData(0, 0, 12, 8).data
    let bright = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 90) bright++
    }
    return { frameWidth: frame.naturalWidth, frameHeight: frame.naturalHeight,
      qrWidth: qr.naturalWidth, bright }
  })()`), 60_000)
  assert.ok(sceneResult.bright > 10, `Scene mirror frame is blank: ${JSON.stringify(sceneResult)}`)
  await control.evaluate(`(async () => {
    const displays = await window.api.getDisplays()
    const source = displays.find((display) => !display.isPrimary)
    window.api.sendToAuxiliary('mirror', 'mirror-state', {
      sourceDisplayId: source?.id ?? null,
      contentType: 'pdf', active: true,
      sceneRendererCapture: true, sceneRendererPath: ${JSON.stringify(pdfPath)},
      directContent: null,
      sceneUpperMediaLayers: [{
        id: 'mirror-regression-upper-image', kind: 'image',
        path: ${JSON.stringify(layerPath)}, name: 'Regression layer',
        xPercent: 50, yPercent: 50, widthPercent: 25, aspectRatio: 1,
        aboveContent: true, visible: true, loop: false, muted: false,
        opacity: 1, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0,
        locked: false, playing: false, currentTime: 0, duration: 0,
        playbackStartedAt: null, controlRevision: 0, restartRevision: 0
      }, {
        id: 'mirror-regression-upper-video', kind: 'video',
        path: ${JSON.stringify(videoPath)}, name: 'Regression video',
        xPercent: 75, yPercent: 50, widthPercent: 20, aspectRatio: 16 / 9,
        aboveContent: true, visible: true, loop: true, muted: false,
        opacity: 1, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0,
        locked: false, playing: true, currentTime: 0, duration: 5,
        playbackStartedAt: Date.now() - 1000, controlRevision: 0, restartRevision: 0
      }]
    })
    return true
  })()`)
  await waitFor('upper image layer on PDF mirror', () => mirror.evaluate(`(() =>
    Boolean(Array.from(document.images).find((image) => image.src.includes('icon.png') && image.naturalWidth))
  )()`), 20_000)
  await waitFor('muted upper video layer on PDF mirror', () => mirror.evaluate(`(() => {
    const video = Array.from(document.querySelectorAll('video')).find((entry) => entry.src.includes('sample-5s.mp4'))
    return Boolean(video?.muted && video.videoWidth > 0 && video.currentTime > 0.2)
  })()`), 20_000)
  await control.evaluate(`document.querySelector('[data-program-scene-picture-visible]')?.click(); true`)
  await control.evaluate(`document.querySelector('[data-program-scene-close]')?.click(); true`)
  await waitFor('PDF ready after Scene exit', () => control.evaluate(`(() => {
    const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
    const button = channel?.querySelector('[data-pdm-channel-take]')
    return Boolean(button && !button.disabled && channel.getAttribute('aria-busy') !== 'true')
  })()`), 60_000)
  await control.evaluate(`document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"] [data-pdm-channel-take]`)})?.click(); true`)
  await waitFor('direct PDF restored after Scene exit', () => mirror.evaluate(`(() => {
    return Boolean(Array.from(document.images).find((image) => image.className.includes('object-contain') && image.naturalWidth) &&
      document.querySelector('[data-scene-qr-object] img')?.naturalWidth &&
      !Array.from(document.images).some((image) => image.src.startsWith('data:image/jpeg') && image.className.includes('object-contain')))
  })()`), 60_000)
  console.log(`PASS: direct PDF + QR, Scene PDF + QR + upper image/video layers in live copy; ${JSON.stringify(sceneResult)}`)
} finally {
  control.close()
  mirror.close()
}
