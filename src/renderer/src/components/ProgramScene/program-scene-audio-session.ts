import {
  normalizeProgramSceneAudio, resolveProgramSceneAudioDevice,
  type ProgramSceneAudioConfig, type ProgramSceneAudioStatus
} from '../../../../shared/program-scene-audio'

type AudioOutput = Pick<HTMLAudioElement, 'srcObject' | 'muted' | 'play' | 'pause'>
type Devices = Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>

/** Owns only PiP audio. Layout/slide changes never reopen the camera or this input. */
export class ProgramSceneAudioSession {
  private generation = 0
  private key = ''
  private desired: ProgramSceneAudioConfig | null = null
  private release: (() => void) | null = null
  private liveDeviceId: string | null = null

  constructor(
    private devices: Devices,
    private createOutput: () => AudioOutput,
    private status: (value: ProgramSceneAudioStatus) => void
  ) {}

  async set(value: ProgramSceneAudioConfig | null, retry = false): Promise<void> {
    const config = value ? normalizeProgramSceneAudio(value) : null
    const desired = config?.enabled ? config : null
    const key = desired ? JSON.stringify(desired) : ''
    if (!retry && this.key === key) return
    this.key = key
    this.desired = desired
    const generation = ++this.generation
    this.release?.()
    this.release = null
    this.liveDeviceId = null
    if (!desired) { this.status({ phase: 'idle', message: '' }); return }
    if (!desired.deviceId) {
      this.status({ phase: 'error', message: 'Выберите аудиовход камеры.' })
      return
    }
    this.status({ phase: 'starting', message: 'Подключение звука…' })
    let stream: MediaStream | null = null
    let output: AudioOutput | null = null
    const dispose = (): void => {
      if (output) { output.muted = true; output.pause(); output.srcObject = null }
      stream?.getTracks().forEach((track) => {
        track.onended = null; track.onmute = null; track.onunmute = null; track.stop()
      })
    }
    try {
      const devices = await this.devices.enumerateDevices()
      if (generation !== this.generation) return
      const deviceId = resolveProgramSceneAudioDevice(desired, devices)
      if (!deviceId) throw new Error('missing-input')
      stream = await this.devices.getUserMedia({ video: false, audio: {
        deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false
      } })
      if (generation !== this.generation) { dispose(); return }
      const track = stream.getAudioTracks()[0]
      if (!track || track.readyState !== 'live') throw new Error('missing-input')
      output = this.createOutput()
      output.muted = false
      output.srcObject = stream
      this.release = dispose
      this.liveDeviceId = deviceId
      track.onended = () => {
        if (generation !== this.generation) return
        ++this.generation
        dispose(); this.release = null
        this.liveDeviceId = null
        this.status({ phase: 'error', message: 'Аудиовход отключён. Проверьте подключение камеры.' })
      }
      track.onmute = () => {
        if (generation === this.generation) this.status({ phase: 'error', message: 'Аудиовход временно не передаёт звук.' })
      }
      track.onunmute = () => {
        if (generation === this.generation) this.status({ phase: 'live', message: 'Звук камеры в эфире' })
      }
      await output.play()
      if (generation !== this.generation) { dispose(); return }
      this.status(track.muted
        ? { phase: 'error', message: 'Аудиовход временно не передаёт звук.' }
        : { phase: 'live', message: 'Звук камеры в эфире' })
    } catch (error) {
      dispose()
      if (generation !== this.generation) return
      this.release = null
      this.liveDeviceId = null
      const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
      this.status({ phase: 'error', message: name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Доступ к микрофону запрещён. Проверьте разрешения Windows.'
        : 'Не удалось включить аудиовход. Проверьте подключение и доступ других программ.' })
    }
  }

  retry(): Promise<void> { return this.set(this.desired, true) }
  async devicesChanged(): Promise<void> {
    const generation = this.generation
    if (!this.desired) return
    try {
      const devices = await this.devices.enumerateDevices()
      if (generation !== this.generation) return
      if (this.liveDeviceId && resolveProgramSceneAudioDevice(this.desired, devices) === this.liveDeviceId) return
    } catch { /* report an actionable error through the normal reconnect path */ }
    if (generation === this.generation) await this.retry()
  }
  stop(): void { void this.set(null, true) }
}
