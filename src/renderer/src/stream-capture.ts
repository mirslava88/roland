import type { StreamCaptureSettings } from '../../shared/streaming'
import workletUrl from './stream-audio-worklet.js?url&no-inline'

declare global {
  interface Window {
    streamCapture: {
      onCommand(listener: (id: number, command: string, data: unknown) => void): void
      reply(id: number, value: unknown, error?: string): void
      chunk(bytes: ArrayBuffer, capturedAt: number): Promise<boolean>
      fail(message: string): void
    }
  }
}
let generation = 0
let tracks: MediaStreamTrack[] = []
let context: AudioContext | null = null
let processor: AudioWorkletNode | null = null
async function stop(): Promise<void> {
  generation++
  if (processor) { processor.port.onmessage = null; processor.port.close(); processor.disconnect(); processor = null }
  for (const track of tracks) track.stop()
  tracks = []
  const old = context; context = null
  if (old) await old.close().catch(() => {})
}
async function start(settings: StreamCaptureSettings): Promise<void> {
  await stop()
  const token = generation
  const fail = (message: string): void => {
    if (token !== generation) return
    window.streamCapture.fail(message); void stop()
  }
  const keep = (stream: MediaStream): MediaStream => {
    if (token !== generation) { stream.getTracks().forEach(t => t.stop()); throw Error('Запуск отменён.') }
    tracks.push(...stream.getTracks())
    stream.getTracks().forEach(t => t.addEventListener('ended', () => fail('Аудиоустройство отключено. Запустите стрим повторно.')))
    return stream
  }
  try {
    const audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    context = audioContext
    const bus = audioContext.createGain()
    const silence = audioContext.createConstantSource()
    silence.offset.value = 0; silence.connect(bus); silence.start()
    const mix = (stream: MediaStream): void => {
      const gain = audioContext.createGain(); gain.gain.value = settings.audio === 'both' ? 0.7 : 1
      audioContext.createMediaStreamSource(stream).connect(gain).connect(bus)
    }
    if (settings.audio === 'system' || settings.audio === 'both') {
      // Electron loopback is requested together with a video track. Stop that
      // track immediately: video is captured natively by the encoding process.
      const desktop = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1, width: 16, height: 16 }, audio: true })
      desktop.getVideoTracks().forEach(t => t.stop())
      if (!desktop.getAudioTracks().length) throw Error('Системный звук недоступен. Выберите микрофон или режим без звука.')
      mix(keep(new MediaStream(desktop.getAudioTracks())))
    }
    if (settings.audio === 'microphone' || settings.audio === 'both') {
      mix(keep(await navigator.mediaDevices.getUserMedia({ video: false, audio: {
        deviceId: settings.microphoneId ? { exact: settings.microphoneId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      } })))
    }
    await audioContext.audioWorklet.addModule(workletUrl)
    if (token !== generation) throw Error('Запуск отменён.')
    const node = new AudioWorkletNode(audioContext, 'pdm-stream-pcm', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
    processor = node
    bus.connect(node).connect(audioContext.destination) // worklet output is silence; never play loopback into itself
    await audioContext.resume()
    node.onprocessorerror = () => fail('Ошибка захвата звука.')
    node.port.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer; capturedAt: number; time: number }>) => {
      if (token !== generation) return
      void window.streamCapture.chunk(event.data.bytes, event.data.capturedAt).then(ok => {
        if (token !== generation) return
        if (!ok) fail('Передача звука в кодер прервана.')
        else node.port.postMessage('ready')
      }).catch(() => fail('Передача звука в кодер прервана.'))
    }
  } catch (error) { if (token === generation) await stop(); throw error }
}
window.streamCapture.onCommand((id, command, data) => {
  void (async () => {
    try {
      let result: unknown = true
      if (command === 'start') await start(data as StreamCaptureSettings)
      else if (command === 'resume') processor?.port.postMessage('ready')
      else if (command === 'stop') await stop()
      else if (command === 'devices') {
        const permission = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        try { result = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
          .map(d => ({ id: d.deviceId, label: d.label || 'Аудиовход' })) }
        finally { permission.getTracks().forEach(t => t.stop()) }
      }
      window.streamCapture.reply(id, result)
    } catch (error) { window.streamCapture.reply(id, null, error instanceof Error ? error.message : 'Ошибка захвата') }
  })()
})
