export type QrContentType = 'url' | 'wifi' | 'file'
export type QrWifiSecurity = 'WPA' | 'WEP' | 'nopass'
export type QrModuleStyle = 'square' | 'dots' | 'rounded'
export type QrCornerStyle = 'sharp' | 'rounded'

export interface QrOverlayConfig {
  enabled: boolean
  contentType: QrContentType
  url: string
  wifiSsid: string
  wifiPassword: string
  wifiSecurity: QrWifiSecurity
  wifiHidden: boolean
  imagePath: string | null
  moduleStyle: QrModuleStyle
  cornerStyle: QrCornerStyle
  color: string
  logoPath: string | null
  sizePercent: number
  xPercent: number
  yPercent: number
}

export interface QrOverlayOutput {
  visible: boolean
  displayId: number | null
  config: QrOverlayConfig
}

export const DEFAULT_QR_OVERLAY: QrOverlayConfig = {
  enabled: false,
  contentType: 'url',
  url: 'https://',
  wifiSsid: '',
  wifiPassword: '',
  wifiSecurity: 'WPA',
  wifiHidden: false,
  imagePath: null,
  moduleStyle: 'square',
  cornerStyle: 'sharp',
  color: '#000000',
  logoPath: null,
  sizePercent: 24,
  xPercent: 84,
  yPercent: 80
}

export function escapeWifiQrValue(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1')
}

export function qrDataFromConfig(config: QrOverlayConfig): string {
  if (config.contentType === 'file') return ''
  if (config.contentType === 'url') return config.url.trim()
  const security = config.wifiSecurity
  const password = security === 'nopass' ? '' : `P:${escapeWifiQrValue(config.wifiPassword)};`
  const hidden = config.wifiHidden ? 'H:true;' : ''
  return `WIFI:T:${security};S:${escapeWifiQrValue(config.wifiSsid)};${password}${hidden};`
}

export function hasQrData(config: QrOverlayConfig): boolean {
  if (config.contentType === 'file') return Boolean(config.imagePath)
  return config.contentType === 'url'
    ? config.url.trim().length > 0 && config.url.trim() !== 'https://'
    : config.wifiSsid.trim().length > 0
}

export function normalizeQrOverlay(value: unknown): QrOverlayConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)
    ? raw.color
    : DEFAULT_QR_OVERLAY.color
  const number = (entry: unknown, fallback: number, min: number, max: number): number => (
    typeof entry === 'number' && Number.isFinite(entry)
      ? Math.max(min, Math.min(max, entry))
      : fallback
  )
  return {
    enabled: raw.enabled === true,
    contentType: raw.contentType === 'wifi' || raw.contentType === 'file' ? raw.contentType : 'url',
    url: typeof raw.url === 'string' ? raw.url.slice(0, 4096) : DEFAULT_QR_OVERLAY.url,
    wifiSsid: typeof raw.wifiSsid === 'string' ? raw.wifiSsid.slice(0, 256) : '',
    wifiPassword: typeof raw.wifiPassword === 'string' ? raw.wifiPassword.slice(0, 256) : '',
    wifiSecurity: raw.wifiSecurity === 'WEP' || raw.wifiSecurity === 'nopass' ? raw.wifiSecurity : 'WPA',
    wifiHidden: raw.wifiHidden === true,
    imagePath: typeof raw.imagePath === 'string' && raw.imagePath.length > 0 && raw.imagePath.length < 32768
      ? raw.imagePath
      : null,
    moduleStyle: ['square', 'dots', 'rounded'].includes(String(raw.moduleStyle))
      ? raw.moduleStyle as QrModuleStyle
      : DEFAULT_QR_OVERLAY.moduleStyle,
    cornerStyle: raw.cornerStyle === 'rounded' ? 'rounded' : 'sharp',
    color,
    logoPath: typeof raw.logoPath === 'string' && raw.logoPath.length > 0 && raw.logoPath.length < 32768
      ? raw.logoPath
      : null,
    sizePercent: number(raw.sizePercent, DEFAULT_QR_OVERLAY.sizePercent, 10, 100),
    xPercent: number(raw.xPercent, DEFAULT_QR_OVERLAY.xPercent, 0, 100),
    yPercent: number(raw.yPercent, DEFAULT_QR_OVERLAY.yPercent, 0, 100)
  }
}
