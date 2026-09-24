/** Encode previews without synchronous canvas serialization on the UI thread. */
export function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality?: number
): Promise<string> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas encoding returned no image'))
        return
      }
      resolve(blob)
    }, type, quality)
  }).then((blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Canvas image read failed'))
    reader.onabort = () => reject(new Error('Canvas image read aborted'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Canvas image is not a data URL'))
    }
    reader.readAsDataURL(blob)
  }))
}
