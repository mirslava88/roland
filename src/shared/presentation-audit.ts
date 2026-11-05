export interface PresentationAuditSlide {
  number: number
  videos: number
  audio: number
  linkedMedia: number
  animations: boolean
  missingFonts: string[]
}

export interface PresentationAuditReport {
  slideCount: number
  slides: PresentationAuditSlide[]
  missingFonts: string[]
  fontsChecked: boolean
  warnings: string[]
}

export type PresentationAuditResult =
  | { success: true; report: PresentationAuditReport }
  | { success: false; error: string }
