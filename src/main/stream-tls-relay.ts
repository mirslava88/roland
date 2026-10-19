import { createServer, isIP, type Server, type Socket } from 'net'
import { connect, type ConnectionOptions, type TLSSocket } from 'tls'

// The bundled macOS FFmpeg uses SecureTransport. Some RTMPS servers close
// that connection during media writes. Keep RTMP framing in FFmpeg and let
// Node's TLS implementation handle encryption and certificate/hostname checks.
// Only the local FFmpeg hop uses plain RTMP, bound exclusively to loopback.
export class StreamTlsRelay {
  private server: Server | null = null
  private local: Socket | null = null
  private remote: TLSSocket | null = null
  private timer?: NodeJS.Timeout
  private closed = false

  constructor(private onError: (message: string) => void) {}

  async open(address: string): Promise<{ url: string; tcUrl: string }> {
    const target = new URL(address)
    if (target.protocol !== 'rtmps:') throw new Error('Нужен защищённый адрес RTMPS.')
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const port = Number(target.port) || 443
    const slash = target.pathname.lastIndexOf('/')
    const tcUrl = `${target.protocol}//${target.host}${target.pathname.slice(0, slash)}`
    const server = createServer((local) => {
      if (this.closed || this.local) { local.destroy(); return }
      this.local = local
      // One sender per relay; stop accepting before opening the remote hop.
      server.close()
      local.pause(); local.setNoDelay(true)
      const options: ConnectionOptions = { host, port, rejectUnauthorized: true,
        ...(isIP(host) ? {} : { servername: host }) }
      const remote = connect(options)
      this.remote = remote
      remote.setNoDelay(true)
      this.timer = setTimeout(() => this.fail('Сервер не ответил вовремя. Проверьте соединение и доступность площадки.'), 10_000)
      remote.once('secureConnect', () => {
        clearTimeout(this.timer)
        if (this.closed) return
        local.pipe(remote); remote.pipe(local)
      })
      remote.on('error', (error: NodeJS.ErrnoException) => this.fail(streamTlsErrorMessage(error.code)))
      remote.on('close', () => this.fail('Соединение с сервером прервано.'))
      local.on('error', () => this.close())
      local.on('close', () => this.close())
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => { this.close(); reject(new Error('Не удалось подготовить защищённую отправку.')) })
      server.listen(0, '127.0.0.1', resolve)
    })
    const bound = server.address()
    if (this.closed || !bound || typeof bound === 'string') throw new Error('Защищённая отправка остановлена.')
    // Preserve the original tcUrl for servers which validate the RTMP app.
    return { url: `rtmp://127.0.0.1:${bound.port}${target.pathname}${target.search}`, tcUrl }
  }

  private fail(message: string): void {
    if (this.closed) return
    this.close()
    this.onError(message)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.server?.close()
    this.local?.destroy(); this.remote?.destroy()
    this.server = null; this.local = null; this.remote = null
  }
}

// Never pass TLS exception text through: it may include connection details.
export function streamTlsErrorMessage(code?: string): string {
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) {
    return 'Не удалось проверить сертификат сервера. Проверьте дату компьютера и сетевые настройки.'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Не удалось найти сервер по указанному адресу.'
  if (code === 'ECONNREFUSED') return 'Сервер отклонил подключение. Проверьте адрес и порт.'
  if (code === 'ETIMEDOUT') return 'Сервер не ответил вовремя. Проверьте соединение и доступность площадки.'
  if (code?.startsWith('ERR_SSL') || code?.startsWith('ERR_TLS')) return 'Не удалось установить защищённое подключение к серверу.'
  return 'Соединение с сервером прервано.'
}
