// FLV framing only. No codec decoding, timestamp rewriting or unbounded buffers.
export interface FlvPacket {
  bytes: Buffer
  timestamp: number
  type: number
  keyframe: boolean
  configuration: boolean
}
export const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0])
export class FlvParser {
  private buffer = Buffer.alloc(0)
  private header = false
  constructor(private receive: (packet: FlvPacket) => void) {}
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.header) {
      if (this.buffer.length < 13) return
      if (this.buffer.toString('ascii', 0, 3) !== 'FLV' || this.buffer.readUInt32BE(5) !== 9) throw Error('Invalid FLV header')
      this.buffer = this.buffer.subarray(13); this.header = true
    }
    while (this.buffer.length >= 11) {
      const size = this.buffer.readUIntBE(1, 3)
      if (size > 4 * 1024 * 1024) throw Error('FLV packet exceeds limit')
      const length = size + 15
      if (this.buffer.length < length) return
      const bytes = Buffer.from(this.buffer.subarray(0, length))
      this.buffer = this.buffer.subarray(length)
      const type = bytes[0]
      const configuration = size >= 2 && (type === 8 || type === 9) && bytes[12] === 0
      this.receive({ bytes, type, configuration,
        timestamp: bytes.readUIntBE(4, 3) + bytes[7] * 0x1000000,
        keyframe: type === 9 && size >= 2 && bytes[11] >>> 4 === 1 && bytes[12] === 1 })
    }
  }
}
export function rebaseFlvPacket(packet: FlvPacket, origin: number): Buffer {
  const bytes = Buffer.from(packet.bytes)
  const timestamp = packet.configuration || packet.type === 18 ? 0 : Math.max(0, packet.timestamp - origin) >>> 0
  bytes.writeUIntBE(timestamp & 0xffffff, 4, 3); bytes[7] = timestamp >>> 24
  return bytes
}
