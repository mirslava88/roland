import { BrowserWindow, type NativeImage } from 'electron'
import {
  getStreamDeckModelName,
  listStreamDecks,
  openStreamDeck,
  type StreamDeck,
  type StreamDeckButtonControlDefinitionLcdFeedback
} from '@elgato-stream-deck/node'
import {
  escapeDirectStreamDeckXml,
  normalizeDirectStreamDeckConfig,
  normalizeDirectStreamDeckColor,
  normalizeDirectStreamDeckKeyStates,
  splitDirectStreamDeckLabel,
  type DirectStreamDeckCommand,
  type DirectStreamDeckConfig,
  type DirectStreamDeckDeviceInfo,
  type DirectStreamDeckKeyState,
  type DirectStreamDeckStatus
} from '../shared/direct-stream-deck'
import { diagnosticLog, formatDiagnosticError } from './diagnostic-log'

type StatusListener = (status: DirectStreamDeckStatus) => void
type CommandListener = (command: DirectStreamDeckCommand) => void

const DISCONNECTED_STATUS: DirectStreamDeckStatus = {
  enabled: false,
  connecting: false,
  connected: false,
  deviceName: null,
  serialNumber: null,
  keyCount: 0,
  columns: 0,
  rows: 0,
  error: null
}

export class DirectStreamDeckManager {
  private device: StreamDeck | null = null
  private config: DirectStreamDeckConfig = normalizeDirectStreamDeckConfig(null)
  private status: DirectStreamDeckStatus = { ...DISCONNECTED_STATUS }
  private keyStates: DirectStreamDeckKeyState[] = []
  private keySignatures = new Map<number, string>()
  private operation: Promise<void> = Promise.resolve()
  private reconnectTimer: NodeJS.Timeout | null = null
  private rendererWindow: BrowserWindow | null = null
  private closing = false

  constructor(
    private readonly onStatus: StatusListener,
    private readonly onCommand: CommandListener
  ) {}

  getStatus(): DirectStreamDeckStatus {
    return { ...this.status }
  }

  async listDevices(): Promise<DirectStreamDeckDeviceInfo[]> {
    const devices = await listStreamDecks()
    return devices.map((device) => ({
      model: String(device.model),
      path: device.path,
      serialNumber: device.serialNumber ?? null,
      name: getStreamDeckModelName(device.model)
    }))
  }

  configure(value: unknown): DirectStreamDeckStatus {
    const next = normalizeDirectStreamDeckConfig(value)
    const deviceChanged = next.serialNumber !== this.config.serialNumber
    const brightnessChanged = next.brightness !== this.config.brightness
    this.config = next
    this.publishStatus({ enabled: next.enabled, error: next.enabled ? this.status.error : null })
    if (!next.enabled) {
      void this.disconnect(false)
      return this.getStatus()
    }
    if (!this.device || deviceChanged) {
      void this.connect()
    } else {
      if (brightnessChanged) void this.device.setBrightness(next.brightness).catch((error) => this.handleError(error))
      void this.renderKeys(this.keyStates, true)
    }
    return this.getStatus()
  }

  async connect(): Promise<DirectStreamDeckStatus> {
    if (this.closing || !this.config.enabled) return this.getStatus()
    if (this.status.connecting) return this.getStatus()
    this.clearReconnectTimer()
    await this.disconnectDevice(false)
    this.publishStatus({
      enabled: true,
      connecting: true,
      connected: false,
      error: null
    })
    try {
      const devices = await listStreamDecks()
      const selected = this.config.serialNumber
        ? devices.find((device) => device.serialNumber === this.config.serialNumber)
        : devices[0]
      if (!selected) throw new Error('Stream Deck не найден. Проверьте USB-подключение.')
      const device = await openStreamDeck(selected.path, { resetToLogoOnClose: true })
      if (this.closing || !this.config.enabled) {
        await device.close()
        return this.getStatus()
      }
      this.device = device
      const buttons = device.CONTROLS.filter((control) => control.type === 'button')
      const serialNumber = selected.serialNumber ?? await device.getSerialNumber().catch(() => null)
      device.on('down', (control) => {
        if (control.type !== 'button') return
        const action = this.config.mappings[String(control.index)]
        if (!action || action.kind === 'none') return
        diagnosticLog('stream-deck', `key down index=${control.index} action=${action.kind}`)
        this.onCommand({ keyIndex: control.index, action })
      })
      device.on('error', (error) => this.handleError(error))
      await device.setBrightness(this.config.brightness)
      this.keySignatures.clear()
      this.publishStatus({
        enabled: true,
        connecting: false,
        connected: true,
        deviceName: device.PRODUCT_NAME,
        serialNumber,
        keyCount: buttons.length,
        columns: buttons.length ? Math.max(...buttons.map((button) => button.column)) + 1 : 0,
        rows: buttons.length ? Math.max(...buttons.map((button) => button.row)) + 1 : 0,
        error: null
      })
      diagnosticLog('stream-deck', `connected model=${device.PRODUCT_NAME} serial=${serialNumber || '-'} keys=${buttons.length}`)
      await this.renderKeys(this.keyStates, true)
    } catch (error) {
      const raw = formatDiagnosticError(error)
      const friendly = /not found|не найден/i.test(raw)
        ? 'Stream Deck не найден. Проверьте USB-подключение.'
        : 'Не удалось открыть Stream Deck. Закройте программу Elgato Stream Deck и нажмите «Подключить».'
      diagnosticLog('stream-deck', `connect failed ${raw}`)
      this.publishStatus({
        enabled: this.config.enabled,
        connecting: false,
        connected: false,
        deviceName: null,
        serialNumber: null,
        keyCount: 0,
        columns: 0,
        rows: 0,
        error: friendly
      })
      this.scheduleReconnect()
    }
    return this.getStatus()
  }

  async disconnect(disable = true): Promise<DirectStreamDeckStatus> {
    if (disable) this.config = { ...this.config, enabled: false }
    this.clearReconnectTimer()
    await this.disconnectDevice(true)
    return this.getStatus()
  }

  async shutdown(): Promise<void> {
    this.closing = true
    this.clearReconnectTimer()
    await this.disconnectDevice(false)
    if (this.rendererWindow && !this.rendererWindow.isDestroyed()) this.rendererWindow.destroy()
    this.rendererWindow = null
  }

  updateKeys(states: DirectStreamDeckKeyState[]): void {
    this.keyStates = normalizeDirectStreamDeckKeyStates(states)
    void this.renderKeys(this.keyStates)
  }

  private async renderKeys(states: DirectStreamDeckKeyState[], force = false): Promise<void> {
    const device = this.device
    if (!device || !this.status.connected) return
    const byIndex = new Map(states.map((state) => [state.index, state]))
    const lcdButtons = device.CONTROLS.filter((control): control is StreamDeckButtonControlDefinitionLcdFeedback => (
      control.type === 'button' && control.feedbackType === 'lcd'
    ))
    this.operation = this.operation.then(async () => {
      if (device !== this.device) return
      const panel = await this.renderPanel(lcdButtons, byIndex)
      const panelSize = panel.getSize()
      const columns = Math.max(1, ...lcdButtons.map((button) => button.column + 1))
      const rows = Math.max(1, ...lcdButtons.map((button) => button.row + 1))
      const sourceWidth = panelSize.width / columns
      const sourceHeight = panelSize.height / rows
      for (const button of lcdButtons) {
        const state = byIndex.get(button.index) ?? {
          index: button.index,
          label: '',
          color: '#10151a',
          disabled: true
        }
        const signature = JSON.stringify(state)
        if (!force && this.keySignatures.get(button.index) === signature) continue
        const cell = panel.crop({
          x: Math.round(button.column * sourceWidth),
          y: Math.round(button.row * sourceHeight),
          width: Math.max(1, Math.round(sourceWidth)),
          height: Math.max(1, Math.round(sourceHeight))
        }).resize({
          width: button.pixelSize.width,
          height: button.pixelSize.height,
          quality: 'best'
        })
        const bitmap = cell.toBitmap()
        const expectedLength = button.pixelSize.width * button.pixelSize.height * 4
        if (bitmap.length !== expectedLength) {
          throw new Error(`Stream Deck key renderer produced ${bitmap.length} bytes; expected ${expectedLength}`)
        }
        await device.fillKeyBuffer(button.index, bitmap, { format: 'bgra' })
        this.keySignatures.set(button.index, signature)
      }
    }).catch((error) => this.handleError(error))
    await this.operation
  }

  private async renderPanel(
    buttons: StreamDeckButtonControlDefinitionLcdFeedback[],
    states: Map<number, DirectStreamDeckKeyState>
  ): Promise<NativeImage> {
    const columns = Math.max(1, ...buttons.map((button) => button.column + 1))
    const rows = Math.max(1, ...buttons.map((button) => button.row + 1))
    const cellWidth = Math.max(1, ...buttons.map((button) => button.pixelSize.width))
    const cellHeight = Math.max(1, ...buttons.map((button) => button.pixelSize.height))
    const panelWidth = columns * cellWidth
    const panelHeight = rows * cellHeight
    const rendererCreated = !this.rendererWindow || this.rendererWindow.isDestroyed()
    if (rendererCreated) {
      this.rendererWindow = new BrowserWindow({
        show: false,
        width: panelWidth,
        height: panelHeight,
        useContentSize: true,
        webPreferences: {
          offscreen: true,
          backgroundThrottling: false,
          contextIsolation: true,
          sandbox: true
        }
      })
    } else {
      this.rendererWindow.setContentSize(panelWidth, panelHeight)
    }
    const byPosition = new Map(buttons.map((button) => [`${button.row}:${button.column}`, button]))
    const cells: string[] = []
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const button = byPosition.get(`${row}:${column}`)
        const state = button ? states.get(button.index) : undefined
        const color = state?.disabled ? '#20262d' : normalizeDirectStreamDeckColor(state?.color || '#10151a')
        const border = state?.active ? '#ffffff' : '#3a4a56'
        const textColor = state?.disabled ? '#77818a' : '#ffffff'
        const lines = splitDirectStreamDeckLabel(state?.label || '')
        const fontSize = lines.length >= 3 ? 15 : lines.length === 2 ? 17 : 19
        cells.push(`<div class="key" style="background:${color};border-color:${border};border-width:${state?.active ? 5 : 2}px;color:${textColor};font-size:${fontSize}px">${lines.map(escapeDirectStreamDeckXml).join('<br>')}</div>`)
      }
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;width:${panelWidth}px;height:${panelHeight}px;overflow:hidden;background:#000}
      body{display:grid;grid-template-columns:repeat(${columns},${cellWidth}px);grid-template-rows:repeat(${rows},${cellHeight}px)}
      .key{width:${cellWidth}px;height:${cellHeight}px;border-style:solid;border-radius:10px;display:flex;align-items:center;justify-content:center;padding:6px;text-align:center;font-family:"Segoe UI",Arial,sans-serif;font-weight:700;line-height:1.18;overflow:hidden}
    </style></head><body>${cells.join('')}</body></html>`
    if (rendererCreated) {
      await this.rendererWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    } else {
      await this.rendererWindow.webContents.executeJavaScript(
        `document.open();document.write(${JSON.stringify(html)});document.close();`,
        true
      )
    }
    await this.rendererWindow.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true
    )
    const image = await this.rendererWindow.webContents.capturePage()
    if (image.isEmpty()) throw new Error('Stream Deck panel renderer returned an empty image')
    return image
  }

  private async disconnectDevice(publish: boolean): Promise<void> {
    const device = this.device
    this.device = null
    this.keySignatures.clear()
    if (device) {
      try { await device.close() } catch (error) {
        diagnosticLog('stream-deck', `close failed ${formatDiagnosticError(error)}`)
      }
    }
    if (publish) {
      this.publishStatus({
        ...DISCONNECTED_STATUS,
        enabled: this.config.enabled
      })
    }
  }

  private handleError(error: unknown): void {
    if (this.closing) return
    diagnosticLog('stream-deck', `device error ${formatDiagnosticError(error)}`)
    const failedDevice = this.device
    this.device = null
    if (failedDevice) void failedDevice.close().catch(() => undefined)
    this.keySignatures.clear()
    this.publishStatus({
      enabled: this.config.enabled,
      connecting: false,
      connected: false,
      error: 'Связь со Stream Deck потеряна. PDM попробует подключиться снова.'
    })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closing || !this.config.enabled || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, 5000)
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private publishStatus(update: Partial<DirectStreamDeckStatus>): void {
    this.status = { ...this.status, ...update }
    this.onStatus(this.getStatus())
  }
}
