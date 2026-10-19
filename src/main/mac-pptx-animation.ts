import { execFile } from 'child_process'
import { stat } from 'fs/promises'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface MacPptxAnimationInfo {
  hasAnimations: boolean
  clickBuildsBySlide: Record<number, number>
  blankBeforeBuildBySlide: Record<number, boolean>
  slideAspectRatio?: number
  safeToPreplay?: boolean
}

const inspectionCache = new Map<string, { signature: string; result: Promise<MacPptxAnimationInfo> }>()

function inspectSlide(xml: string): { clickBuilds: number; blankBeforeBuild: boolean } {
  const timing = xml.match(/<p:timing\b[\s\S]*?<\/p:timing>/)?.[0] || ''
  const clickEffects = [...timing.matchAll(/<p:cTn\b[^>]*\bnodeType="clickEffect"[^>]*>/g)]
    .map((match) => match[0])
  if (clickEffects.length === 0) return { clickBuilds: 0, blankBeforeBuild: false }

  // A slide consisting solely of click-to-appear shapes has an empty first
  // frame. A PDF export instead contains every shape in its final state.
  const shapeTree = xml.match(/<p:spTree\b[\s\S]*?<\/p:spTree>/)?.[0] || ''
  const shapes = [...shapeTree.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
  const shapeIds = shapes.map((match) => match[0].match(/<p:cNvPr\b[^>]*\bid="(\d+)"/)?.[1])
    .filter((id): id is string => !!id)
  const animatedIds = new Set([...timing.matchAll(/<p:spTgt\b[^>]*\bspid="(\d+)"/g)]
    .map((match) => match[1]))
  const hasOtherVisuals = /<p:(?:pic|graphicFrame|cxnSp)\b/.test(shapeTree)
  const allClickEffectsEnter = clickEffects.every((tag) => /\bpresetClass="entr"/.test(tag))
  return {
    clickBuilds: clickEffects.length,
    blankBeforeBuild: shapeIds.length > 0 && !hasOtherVisuals &&
      allClickEffectsEnter && shapeIds.every((id) => animatedIds.has(id))
  }
}

async function inspect(filePath: string): Promise<MacPptxAnimationInfo> {
  const { stdout: listing } = await execFileAsync('/usr/bin/unzip', ['-Z1', filePath], {
    maxBuffer: 16 * 1024 * 1024
  })
  const slideNumbers = [...listing.matchAll(/^ppt\/slides\/slide(\d+)\.xml$/gm)]
    .map((match) => Number(match[1])).sort((a, b) => a - b)
  const clickBuildsBySlide: Record<number, number> = {}
  const blankBeforeBuildBySlide: Record<number, boolean> = {}
  let safeToPreplay = !/^ppt\/media\/.*\.(?:mp[234]|m4[av]|mov|wav|aiff?|wm[av]|avi|mkv|ogg|webm)$/im.test(listing)
  const { stdout: presentation } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, 'ppt/presentation.xml'], {
    maxBuffer: 4 * 1024 * 1024
  })
  const slideSize = presentation.match(/<p:sldSz\b[^>]*>/)?.[0] || ''
  const cx = Number(slideSize.match(/\bcx="(\d+)"/)?.[1])
  const cy = Number(slideSize.match(/\bcy="(\d+)"/)?.[1])
  for (const slideNumber of slideNumbers) {
    const { stdout: xml } = await execFileAsync('/usr/bin/unzip', [
      '-p', filePath, `ppt/slides/slide${slideNumber}.xml`
    ], { maxBuffer: 32 * 1024 * 1024 })
    const slide = inspectSlide(xml)
    if (/\badvTm=|<p:(?:audio|video|sndAc)\b|<(?:a|p14):(?:snd|audioCd|wavAudioFile|audioFile|videoFile|media)\b/.test(xml)) safeToPreplay = false
    if (slideNumber === 1 && /<p:timing\b/.test(xml) && (
      slide.clickBuilds === 0 || /\bnodeType="(?:withEffect|afterEffect|interactiveSeq)"/.test(xml)
    )) safeToPreplay = false
    clickBuildsBySlide[slideNumber] = slide.clickBuilds
    blankBeforeBuildBySlide[slideNumber] = slide.blankBeforeBuild
  }
  return {
    hasAnimations: Object.values(clickBuildsBySlide).some((count) => count > 0),
    clickBuildsBySlide,
    blankBeforeBuildBySlide,
    slideAspectRatio: cx > 0 && cy > 0 ? cx / cy : undefined,
    safeToPreplay
  }
}

export async function inspectMacPptxAnimations(filePath: string): Promise<MacPptxAnimationInfo> {
  const file = await stat(filePath)
  const signature = `${file.size}:${file.mtimeMs}`
  const cached = inspectionCache.get(filePath)
  if (cached?.signature === signature) return cached.result
  const result = inspect(filePath)
  inspectionCache.set(filePath, { signature, result })
  try { return await result }
  catch (error) {
    if (inspectionCache.get(filePath)?.result === result) inspectionCache.delete(filePath)
    throw error
  }
}
