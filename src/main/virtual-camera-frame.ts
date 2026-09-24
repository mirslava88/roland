import type { NativeImage } from 'electron'

export const VIRTUAL_CAMERA_WIDTH = 1920 as const
export const VIRTUAL_CAMERA_HEIGHT = 1080 as const
export const VIRTUAL_CAMERA_FRAME_BYTES = VIRTUAL_CAMERA_WIDTH * VIRTUAL_CAMERA_HEIGHT * 4

export interface ContainRect {
  x: number
  y: number
  width: number
  height: number
}

export function calculateContainRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth = VIRTUAL_CAMERA_WIDTH,
  targetHeight = VIRTUAL_CAMERA_HEIGHT
): ContainRect {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('Некорректный размер кадра виртуальной камеры.')
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = Math.max(1, Math.min(targetWidth, Math.round(sourceWidth * scale)))
  const height = Math.max(1, Math.min(targetHeight, Math.round(sourceHeight * scale)))
  return {
    x: Math.floor((targetWidth - width) / 2),
    y: Math.floor((targetHeight - height) / 2),
    width,
    height
  }
}

const opaqueBlackFrame = (() => {
  const frame = Buffer.alloc(VIRTUAL_CAMERA_FRAME_BYTES)
  for (let offset = 3; offset < frame.length; offset += 4) frame[offset] = 255
  return frame
})()

export function fitNativeImageToVirtualCameraFrame(image: NativeImage): Buffer {
  if (image.isEmpty()) throw new Error('Пустой кадр программного выхода.')
  const source = image.getSize()
  const rect = calculateContainRect(source.width, source.height)
  const resized = source.width === rect.width && source.height === rect.height
    ? image
    : image.resize({ width: rect.width, height: rect.height, quality: 'best' })
  const bitmap = resized.toBitmap()
  const expectedBytes = rect.width * rect.height * 4
  if (bitmap.length !== expectedBytes) {
    throw new Error(`Неожиданный размер кадра: ${bitmap.length} вместо ${expectedBytes}.`)
  }
  const output = Buffer.from(opaqueBlackFrame)
  const sourceStride = rect.width * 4
  const targetStride = VIRTUAL_CAMERA_WIDTH * 4
  for (let row = 0; row < rect.height; row++) {
    bitmap.copy(output, ((rect.y + row) * targetStride) + (rect.x * 4), row * sourceStride, (row + 1) * sourceStride)
  }
  return output
}
