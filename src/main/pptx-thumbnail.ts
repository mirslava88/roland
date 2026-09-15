import { nativeImage } from 'electron'
import { readFile } from 'fs/promises'

export async function resizePptxThumbnail(path: string): Promise<Buffer> {
  const image = nativeImage.createFromBuffer(await readFile(path))
  if (image.isEmpty()) throw new Error('Invalid PowerPoint slide image')
  const size = image.getSize()
  const factor = Math.min(320 / size.width, 240 / size.height, 1)
  return image.resize({
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
    quality: 'best'
  }).toPNG()
}
