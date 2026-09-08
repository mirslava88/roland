// At most one 20 ms PCM block can be in transit. No backlog when IPC is slow.
class StreamPcm extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ready = false
    this.offset = 0
    this.samples = new Float32Array(960 * 2)
    this.port.onmessage = () => { this.ready = true }
  }
  process(inputs) {
    const input = inputs[0]
    if (!input?.length) return true
    for (let i = 0; i < input[0].length; i++) {
      this.samples[this.offset++] = input[0][i]
      this.samples[this.offset++] = (input[1] || input[0])[i]
      if (this.offset === this.samples.length) {
        if (this.ready) {
          this.ready = false
          this.port.postMessage({ bytes: this.samples.buffer, capturedAt: Date.now(), time: currentTime + i / sampleRate }, [this.samples.buffer])
          this.samples = new Float32Array(960 * 2)
        }
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('pdm-stream-pcm', StreamPcm)
