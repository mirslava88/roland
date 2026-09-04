import QRCodeStyling from 'qr-code-styling'
import { qrDataFromConfig, type QrOverlayConfig } from '../../../../shared/qr-overlay'

async function fileToDataUrl(path: string): Promise<string> {
  const data = await window.api.readFile(path)
  const ext = path.split('.').pop()?.toLowerCase()
  const mime = ext === 'svg' ? 'image/svg+xml'
    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp'
        : ext === 'bmp' ? 'image/bmp'
          : 'image/png'
  const blob = new Blob([data], { type: mime })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать логотип'))
    reader.readAsDataURL(blob)
  })
}

export async function renderQrImage(config: QrOverlayConfig): Promise<string> {
  if (config.contentType === 'file') {
    if (!config.imagePath) throw new Error('Выберите файл QR-кода')
    return await fileToDataUrl(config.imagePath)
  }

  let logo: string | undefined
  if (config.logoPath) {
    logo = await fileToDataUrl(config.logoPath)
  }
  const qr = new QRCodeStyling({
    type: 'svg',
    width: 1024,
    height: 1024,
    data: qrDataFromConfig(config),
    margin: 44,
    qrOptions: { errorCorrectionLevel: 'H' },
    dotsOptions: {
      color: config.color,
      type: config.moduleStyle
    },
    cornersSquareOptions: {
      color: config.color,
      type: config.cornerStyle === 'rounded' ? 'extra-rounded' : 'square'
    },
    cornersDotOptions: {
      color: config.color,
      type: config.cornerStyle === 'rounded' ? 'dot' : 'square'
    },
    backgroundOptions: { color: '#ffffff' },
    // The logo is inserted into the completed SVG below. This avoids a race
    // inside qr-code-styling where a local image can finish loading only after
    // getRawData() has already serialized the QR without it.
  })
  const blob = await qr.getRawData('svg')
  if (!blob) throw new Error('Не удалось создать QR-код')
  let svg = await (blob as Blob).text()
  if (logo) {
    const safeLogo = logo.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    const radius = config.cornerStyle === 'rounded' ? 34 : 0
    const logoLayer = `<g id="pdm-qr-logo"><rect x="350" y="350" width="324" height="324" rx="${radius}" fill="#ffffff"/><image x="382" y="382" width="260" height="260" preserveAspectRatio="xMidYMid meet" href="${safeLogo}"/></g>`
    svg = svg.replace(/<\/svg>\s*$/, `${logoLayer}</svg>`)
  }
  const outputBlob = new Blob([svg], { type: 'image/svg+xml' })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('Не удалось подготовить QR-код'))
    reader.readAsDataURL(outputBlob)
  })
}
