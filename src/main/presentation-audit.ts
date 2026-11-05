import { stat } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { DOMParser } from '@xmldom/xmldom'
import type { PresentationAuditReport, PresentationAuditSlide } from '../shared/presentation-audit'

type ZipEntry = {
  path: string
  type: string
  vars?: { uncompressedSize?: number }
  stream: () => Readable
}
const unzipper = require('unzipper') as { Open: { file: (path: string) => Promise<{ files: ZipEntry[] }> } }
const execFileAsync = promisify(execFile)
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const MAX_XML_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_XML_BYTES = 128 * 1024 * 1024
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.wmv', '.m4v', '.mpeg', '.mpg', '.webm', '.mkv'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.wma', '.m4a', '.aac', '.ogg', '.flac', '.mid', '.midi'])
const ANIMATION_ELEMENTS = ['anim', 'animClr', 'animEffect', 'animMotion', 'animRot', 'animScale', 'set']

function xml(text: string): Document {
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw new Error('Повреждена структура XML в PPTX.')
  return document
}

function elements(root: Document | Element, namespace: string, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS(namespace, name)) as Element[]
}

function normalPath(base: string, target: string): string {
  return target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(base, target))
}

async function readXml(entry: ZipEntry | undefined, budget: { bytes: number }): Promise<Document | null> {
  if (!entry) return null
  if ((entry.vars?.uncompressedSize ?? 0) > MAX_XML_BYTES) throw new Error('Слишком большой XML-файл в PPTX.')
  const stream = entry.stream()
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_XML_BYTES || budget.bytes + bytes > MAX_TOTAL_XML_BYTES) {
      stream.destroy()
      throw new Error('Презентация превышает безопасный предел проверки.')
    }
    chunks.push(buffer)
  }
  budget.bytes += bytes
  return xml(Buffer.concat(chunks).toString('utf8'))
}

type Relationship = { target: string; kind: string; external: boolean }
function relationships(document: Document | null): Map<string, Relationship> {
  const result = new Map<string, Relationship>()
  if (!document) return result
  for (const element of elements(document, PKG, 'Relationship')) {
    const id = element.getAttribute('Id')
    const target = element.getAttribute('Target')
    if (id && target) result.set(id, {
      target,
      kind: (element.getAttribute('Type') || '').split('/').pop() || '',
      external: element.getAttribute('TargetMode')?.toLowerCase() === 'external'
    })
  }
  return result
}

function fontNames(document: Document): Set<string> {
  const result = new Set<string>()
  for (const name of ['latin', 'ea', 'cs', 'sym']) {
    for (const element of elements(document, A, name)) {
      const family = element.getAttribute('typeface')?.trim()
      if (family && !family.startsWith('+')) result.add(family)
    }
  }
  return result
}

function embeddedFontNames(document: Document | null): Set<string> {
  const result = new Set<string>()
  if (!document) return result
  for (const element of elements(document, P, 'embeddedFont')) {
    for (const font of elements(element, P, 'font')) {
      const family = font.getAttribute('typeface')?.trim()
      if (family) result.add(family.toLocaleLowerCase())
    }
  }
  return result
}

async function installedFonts(): Promise<Set<string> | null> {
  try {
    if (process.platform === 'win32') {
      const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $f=[System.Drawing.Text.InstalledFontCollection]::new(); $j=ConvertTo-Json -Compress -InputObject @($f.Families | ForEach-Object Name); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))"
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
      const names = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8')) as string[]
      return new Set(names.map((name) => name.toLocaleLowerCase()))
    }
    if (process.platform === 'darwin') {
      const script = 'ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))'
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })
      const names = JSON.parse(stdout.trim()) as string[]
      return new Set(names.map((name) => name.toLocaleLowerCase()))
    }
    const { stdout } = await execFileAsync('fc-list', ['-f', '%{family}\n'], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })
    return new Set(stdout.split(/[,\n]/).map((name) => name.trim().toLocaleLowerCase()).filter(Boolean))
  } catch {
    return null
  }
}

let fontListPromise: Promise<Set<string> | null> | null = null
const inflight = new Map<string, Promise<PresentationAuditReport>>()
const reports = new Map<string, PresentationAuditReport>()

export async function auditPresentation(filePath: string, force = false): Promise<PresentationAuditReport> {
  if (typeof filePath !== 'string' || filePath.length > 4096 || filePath.includes('\0') || extname(filePath).toLowerCase() !== '.pptx') {
    throw new Error('Проверка доступна для презентаций PPTX.')
  }
  const file = await stat(filePath)
  if (!file.isFile() || file.size > 1024 * 1024 * 1024) throw new Error('Файл PPTX недоступен или слишком велик для проверки.')
  const key = `${filePath}\0${file.size}\0${file.mtimeMs}`
  if (!force && reports.has(key)) return reports.get(key)!
  if (inflight.has(key)) return inflight.get(key)!
  if (force) fontListPromise = null
  const job = (async (): Promise<PresentationAuditReport> => {
    const archive = await unzipper.Open.file(filePath)
    if (archive.files.length > 50_000) throw new Error('Слишком много элементов в PPTX.')
    const entries = new Map(archive.files.filter((entry) => entry.type !== 'Directory').map((entry) => [entry.path.replace(/\\/g, '/'), entry]))
    const budget = { bytes: 0 }
    const presentation = await readXml(entries.get('ppt/presentation.xml'), budget)
    if (!presentation) throw new Error('В PPTX не найдена структура презентации.')
    const presentationRels = relationships(await readXml(entries.get('ppt/_rels/presentation.xml.rels'), budget))
    const slidePaths = elements(presentation, P, 'sldId').map((slide) => {
      const id = slide.getAttributeNS(R, 'id')
      const rel = id ? presentationRels.get(id) : undefined
      return rel && !rel.external ? normalPath('ppt', rel.target) : null
    }).filter((path): path is string => Boolean(path))
    if (!slidePaths.length) throw new Error('Не удалось определить порядок слайдов в PPTX.')
    if (slidePaths.length > 5000) throw new Error('Слишком много слайдов для проверки.')
    const embedded = embeddedFontNames(presentation)
    fontListPromise ??= installedFonts()
    const available = await fontListPromise
    const warnings: string[] = []
    if (!available) warnings.push('Список установленных шрифтов получить не удалось; наличие шрифтов не проверено.')
    const slides: PresentationAuditSlide[] = []
    for (const [index, slidePath] of slidePaths.entries()) {
      if (index > 0 && index % 16 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      const slide = await readXml(entries.get(slidePath), budget)
      if (!slide) throw new Error(`Не найден слайд ${index + 1} в PPTX.`)
      const relsPath = posix.join(posix.dirname(slidePath), '_rels', `${posix.basename(slidePath)}.rels`)
      const rels = relationships(await readXml(entries.get(relsPath), budget))
      const videos = new Set<string>()
      const audio = new Set<string>()
      const linkedMedia = new Set<string>()
      const missingMedia = new Set<string>()
      for (const rel of rels.values()) {
        const extension = extname(rel.target.split(/[?#]/, 1)[0]).toLowerCase()
        const video = rel.kind === 'video' || (rel.kind === 'media' && VIDEO_EXT.has(extension))
        const sound = rel.kind === 'audio' || (rel.kind === 'media' && AUDIO_EXT.has(extension))
        if (!video && !sound) continue
        if (rel.external) linkedMedia.add(rel.target)
        else {
          const mediaPath = normalPath(posix.dirname(slidePath), rel.target)
          if (!entries.has(mediaPath)) {
            missingMedia.add(mediaPath)
          } else if (video) videos.add(mediaPath)
          else audio.add(mediaPath)
        }
      }
      if (missingMedia.size) warnings.push(`Слайд ${index + 1}: встроенный медиафайл отсутствует внутри PPTX.`)
      const animations = ANIMATION_ELEMENTS.some((name) => elements(slide, P, name).length > 0)
      const missingFonts = available
        ? [...fontNames(slide)].filter((name) => !available.has(name.toLocaleLowerCase()) && !embedded.has(name.toLocaleLowerCase()))
          .sort((a, b) => a.localeCompare(b, 'ru'))
        : []
      slides.push({ number: index + 1, videos: videos.size, audio: audio.size, linkedMedia: linkedMedia.size, animations, missingFonts })
    }
    const missingFonts = [...new Set(slides.flatMap((slide) => slide.missingFonts))].sort((a, b) => a.localeCompare(b, 'ru'))
    return { slideCount: slides.length, slides, missingFonts, fontsChecked: available !== null, warnings }
  })()
  inflight.set(key, job)
  try {
    const report = await job
    reports.set(key, report)
    return report
  } finally {
    inflight.delete(key)
  }
}
