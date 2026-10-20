export type MacPrivacyPermission = 'screen' | 'accessibility'

export interface MacPermissionStatus {
  screen: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
  accessibility: boolean
}

export interface MacPresentationSupport {
  installed: boolean
  error?: string
}

export interface MacSetupApi {
  permissions(): Promise<MacPermissionStatus>
  openPrivacy(permission: MacPrivacyPermission): Promise<void>
  presentationSupport(): Promise<MacPresentationSupport>
  openKeynoteDownload(): Promise<void>
  showApplication(): Promise<void>
  restart(): Promise<void>
}

export const MAC_KEYNOTE_REQUIRED_MESSAGE = 'Для открытия PPTX в PDM на Mac установите Keynote и запустите его один раз. В этой версии показ презентаций выполняет Keynote; одного Microsoft PowerPoint недостаточно.'
