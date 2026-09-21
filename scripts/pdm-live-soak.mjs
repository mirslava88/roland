import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '')
    if (key) values[key] = argv[index + 1]
  }
  return values
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed')
    }
    return result.result?.value
  }

  close() {
    this.socket?.close()
  }
}

async function waitForTarget(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const preferred = targets.find((target) =>
        target.type === 'page' &&
        (target.title === 'Presentation Display Manager' || /\/index\.html(?:$|[?#])/.test(target.url))
      )
      if (preferred?.webSocketDebuggerUrl) return preferred
    } catch {
      // Application is still starting.
    }
    await sleep(500)
  }
  throw new Error(`PDM control page did not appear on port ${port}`)
}

function fileEntry(filePath, type) {
  const extension = path.extname(filePath).toLowerCase()
  return {
    id: `soak-${path.basename(filePath)}-${Date.now()}`,
    name: path.basename(filePath, extension),
    path: filePath,
    type,
    extension,
    size: fs.statSync(filePath).size,
    isImage: false,
    isAudio: false
  }
}

async function waitUntil(label, callback, timeoutMs = 180_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await callback()) return
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const port = Number(args.port || 9222)
  const durationMinutes = Math.max(1, Number(args.minutes || 20))
  const files = [
    fileEntry(path.resolve(args.pptxA), 'presentation'),
    fileEntry(path.resolve(args.pptxB), 'presentation'),
    fileEntry(path.resolve(args.pdf), 'pdf')
  ]
  const outputDirectory = path.resolve(args.output)
  fs.mkdirSync(outputDirectory, { recursive: true })
  const eventLogPath = path.join(outputDirectory, 'automation-events.jsonl')
  const logEvent = (event, detail = {}) => {
    const record = { timestamp: new Date().toISOString(), event, ...detail }
    fs.appendFileSync(eventLogPath, `${JSON.stringify(record)}\n`)
    process.stdout.write(`${record.timestamp} ${event} ${JSON.stringify(detail)}\n`)
  }

  const target = await waitForTarget(port)
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  await client.send('Runtime.enable')
  logEvent('connected', { target: target.title })

  try {
    if (args.action === 'close') {
      await client.evaluate('window.close(); true')
      logEvent('close-requested')
      return
    }

    if (args.action === 'clear-channels') {
      const cleared = await client.evaluate(`(() => {
        let count = 0
        for (const channel of document.querySelectorAll('[data-pdm-channel-id]')) {
          const buttons = [...channel.querySelectorAll('.pdm-channel-header button')]
          const clearButton = buttons.find((button) => button.textContent.trim().length > 0 && !button.disabled)
          if (!clearButton) continue
          clearButton.click()
          count += 1
        }
        return count
      })()`)
      logEvent('channels-cleared', { cleared })
      await sleep(3000)
      return
    }

    await client.evaluate(`(() => {
      document.querySelectorAll('[data-pdm-training-close]').forEach((button) => button.click())
      return true
    })()`)

    for (let index = 0; index < files.length; index += 1) {
      const channelId = String(index + 1)
      const entry = files[index]
      const dropped = await client.evaluate(`(() => {
        const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
        if (!channel) return false
        const transfer = new DataTransfer()
        transfer.setData('application/json', ${JSON.stringify(JSON.stringify(entry))})
        channel.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
        channel.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
        return true
      })()`)
      if (!dropped) throw new Error(`Channel ${channelId} was not found`)
      logEvent('file-dropped', { channelId, kind: entry.type, file: path.basename(entry.path) })
      await sleep(600)
    }

    for (const channelId of ['1', '2', '3']) {
      await waitUntil(`channel ${channelId} readiness`, async () => client.evaluate(`(() => {
        const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
        const take = channel?.querySelector('[data-pdm-channel-take]')
        return Boolean(channel && take && !take.disabled && channel.getAttribute('aria-busy') !== 'true')
      })()`), channelId === '3' ? 120_000 : 420_000)
      logEvent('channel-ready', { channelId })
    }

    const startedAt = Date.now()
    const deadline = startedAt + durationMinutes * 60_000
    let cycle = 0
    while (Date.now() < deadline) {
      cycle += 1
      const channelId = String(((cycle - 1) % 3) + 1)
      const took = await client.evaluate(`(() => {
        const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
        const take = channel?.querySelector('[data-pdm-channel-take]')
        if (!take || take.disabled) return false
        take.click()
        return true
      })()`)
      logEvent('take-requested', { cycle, channelId, accepted: took })

      await waitUntil(`channel ${channelId} live`, async () => client.evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"].is-live`)}))`), 45_000, 500)
      logEvent('channel-live', { cycle, channelId })
      await sleep(1200)

      for (let navigation = 0; navigation < 4; navigation += 1) {
        await client.evaluate(`window.dispatchEvent(new CustomEvent('pdm-direct-navigation', { detail: 'next' })); true`)
        await sleep(550)
      }
      await client.evaluate(`window.dispatchEvent(new CustomEvent('pdm-direct-navigation', { detail: 'prev' })); true`)
      await sleep(700)

      if (cycle % 4 === 0) {
        const opened = await client.evaluate(`(() => {
          const button = document.querySelector('[data-toolbar-item="pip"] button, [data-toolbar-item="pip"]')
          if (!button) return false
          button.click()
          return true
        })()`)
        if (opened) {
          await sleep(1400)
          await client.evaluate(`document.querySelector('[data-program-scene-close]')?.click(); true`)
          logEvent('scene-open-close', { cycle })
          await sleep(600)
        }
      }

      if (cycle % 6 === 0) {
        const opened = await client.evaluate(`(() => {
          const button = document.querySelector('[data-toolbar-item="timer"] button:first-child')
          if (!button) return false
          button.click()
          return true
        })()`)
        if (opened) {
          await sleep(1200)
          await client.evaluate(`document.querySelector('[data-pdm-training-close]')?.click(); true`)
          logEvent('timer-open-close', { cycle })
          await sleep(500)
        }
      }

      if (cycle % 9 === 0) {
        const exited = await client.evaluate(`(() => {
          const button = document.querySelector('[data-toolbar-item="output"] button')
          if (!button) return false
          button.click()
          return true
        })()`)
        logEvent('output-toggle', { cycle, accepted: exited })
        await sleep(2500)
      }
    }

    const finalExit = await client.evaluate(`(() => {
      const button = document.querySelector('[data-toolbar-item="output"] button')
      const text = button?.textContent || ''
      if (!button || !/exit|stop|выйти/i.test(text)) return false
      button.click()
      return true
    })()`)
    logEvent('cooldown-started', { finalExit })
    await sleep(35_000)
    logEvent('completed', { cycles: cycle, durationMinutes })
  } finally {
    client.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
