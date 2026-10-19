import { app, desktopCapturer, systemPreferences } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { extname, join } from 'path'
import { Worker } from 'worker_threads'
import { scriptPath } from './paths'
import { diagnosticLog } from './diagnostic-log'
import { macNativeOffice } from './mac-native-office'

const execute = promisify(execFile)
export interface MacDocumentCrop { x: number; y: number; width: number; height: number }
interface Bounds { x: number; y: number; width: number; height: number }
interface DocumentState {
  family: 'word' | 'excel'
  marker: string
  owned: boolean
  windowId?: number
  pid?: number
  originalCaption: string
  originalBounds: number[]
}
interface PreparedDocument {
  error?: string
  owned: boolean
  originalCaption: string
  originalBounds: number[]
  title: string
  windowBounds: number[]
  contentBounds: number[]
}

const documents = new Map<string, DocumentState>()
function officeError(error: unknown): string {
  const value = String(error)
  if (/Office did not open|SIGTERM|timed out|killed|ETIMEDOUT/i.test(value)) {
    return 'Word/Excel не открыл документ. Завершите вход в Microsoft или закройте служебный диалог Office и повторите отправку в эфир.'
  }
  if (/-1743|not authorized to send Apple events/i.test(value)) {
    return 'Разрешите PDM управлять Word/Excel: Настройки системы → Конфиденциальность и безопасность → Автоматизация.'
  }
  if (/unique document area/i.test(value)) return 'Office не передал область документа. Закройте его служебные диалоги и повторите отправку в эфир.'
  if (/Failed to get sources/i.test(value)) return 'Для живого документа включите запись экрана для PDM в настройках конфиденциальности macOS.'
  return value.replace(/^Error: /, '')
}
function familyFor(path: string): DocumentState['family'] {
  const extension = extname(path).toLowerCase()
  if (['.doc', '.docx', '.rtf', '.odt', '.txt'].includes(extension)) return 'word'
  if (['.xls', '.xlsx', '.ods'].includes(extension)) return 'excel'
  throw new Error('На Mac вывод внешнего документа поддерживается для Word и Excel.')
}

async function command(args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('/usr/bin/osascript', [scriptPath('office-control.scpt'), ...args], {
      timeout: 35000, encoding: 'utf8', maxBuffer: 1024 * 1024
    })
    return stdout.trim()
  } catch (error) {
    const killed = (error as { killed?: boolean }).killed
    throw new Error(officeError(killed ? 'timed out' : error))
  }
}

function documentGeometry(family: DocumentState['family'], marker: string): Promise<{
  windowBounds: number[]; contentBounds: number[]
}> {
  const nativeModule = app.isPackaged
    ? join(process.resourcesPath, 'mac-office-accessibility.node')
    : join(__dirname, '../../build/mac-office-accessibility.node')
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('worker_threads')
      try {
        const native=require(workerData.module);let value;
        for(let attempt=0;;attempt++) {
          try { value=native.prepareDocumentWindow(workerData.bundle,workerData.marker);break }
          catch(error) {
            if(attempt>=6||!String(error).includes('unique document area'))throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
          }
        }
        parentPort.postMessage(value)
      } catch (error) { parentPort.postMessage({ error: String(error) }) }
    `, { eval: true, workerData: { module: nativeModule,
      bundle: family === 'word' ? 'com.microsoft.Word' : 'com.microsoft.Excel', marker } })
    let settled = false
    const finish = (error?: Error, result?: { windowBounds: number[]; contentBounds: number[] }): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const timeout = setTimeout(() => finish(new Error('Office не ответил на запрос области документа.')), 6000)
    worker.on('message', (result) => result.error ? finish(new Error(result.error)) : finish(undefined, result))
    worker.on('error', (error) => finish(error))
    worker.on('exit', (code) => { if (!settled) finish(new Error(`Office geometry worker exited: ${code}`)) })
  })
}

export const macOffice = {
  async prepare(path: string, bounds: Bounds): Promise<{
    success: boolean; error?: string; captureSourceId?: string; captureCrop?: MacDocumentCrop
  }> {
    try {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        throw new Error('Включите доступ PDM в macOS: Конфиденциальность и безопасность → Универсальный доступ. Он нужен для вывода документа без панелей Word/Excel.')
      }
      const existing = documents.get(path)
      const family = existing?.family ?? familyFor(path)
      const marker = existing?.marker ?? `PDM ${randomUUID()}`
      const prepared = JSON.parse(await command(['prepare', family, path, marker,
        ...[bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height].map((n) => String(Math.round(n)))
      ])) as PreparedDocument
      if (!existing) documents.set(path, {
        family, marker, owned: prepared.owned === true,
        originalCaption: prepared.originalCaption, originalBounds: prepared.originalBounds
      })
      if (prepared.error) throw new Error(prepared.error)
      const geometry = await documentGeometry(family, marker)
      const [wx, wy, ww, wh] = geometry.windowBounds
      const [cx, cy, cw, ch] = geometry.contentBounds
      if (![wx, wy, ww, wh, cx, cy, cw, ch].every(Number.isFinite) || ww <= 0 || wh <= 0 || cw <= 0 || ch <= 0) {
        throw new Error('Office не передал размеры области документа.')
      }
      const crop = { x: Math.max(0, (cx - wx) / ww), y: Math.max(0, (cy - wy) / wh),
        width: Math.min(1, cw / ww), height: Math.min(1, ch / wh) }
      if (crop.x + crop.width > 1.01 || crop.y + crop.height > 1.01) throw new Error('Область документа выходит за границы окна Office.')
      let sourceId: string | undefined
      for (let attempt = 0; attempt < 10; attempt++) {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
        const matches = sources.filter((source) => source.name.startsWith(marker))
        if (matches.length === 1) { sourceId = matches[0].id; break }
        if (matches.length > 1) throw new Error('Office создал несколько окон с одним идентификатором документа.')
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      if (!sourceId) throw new Error('Окно документа недоступно для захвата. Проверьте доступ PDM к записи экрана.')
      documents.get(path)!.windowId = Number(sourceId.split(':')[1])
      diagnosticLog('office', `Mac document prepared family=${family} source=${sourceId} crop=${JSON.stringify(crop)}`)
      return { success: true, captureSourceId: sourceId, captureCrop: crop }
    } catch (error) {
      diagnosticLog('office', `Mac document preparation failed: ${String(error)}`)
      return { success: false, error: officeError(error) }
    }
  },

  async navigate(path: string, direction: 'next' | 'prev' | 'home'): Promise<{ success: boolean; error?: string }> {
    const state = documents.get(path)
    if (!state) return { success: false, error: 'Документ сейчас не находится в эфире.' }
    try {
      await command([direction, state.family, path])
      return { success: true }
    } catch (error) { return { success: false, error: officeError(error) } }
  },

  async sheets(path: string): Promise<{ sheets: string[]; activeSheet: string }> {
    const state = documents.get(path)
    if (state?.family !== 'excel') return { sheets: [], activeSheet: '' }
    return JSON.parse(await command(['sheets', 'excel', path]))
  },

  async selectSheet(path: string, name: string): Promise<{ success: boolean; error?: string }> {
    const state = documents.get(path)
    if (state?.family !== 'excel') return { success: false, error: 'Таблица сейчас не находится в эфире.' }
    try {
      await command(['select-sheet', 'excel', path, name])
      return { success: true }
    } catch (error) { return { success: false, error: officeError(error) } }
  },

  async release(path?: string): Promise<{ success: boolean; error?: string; windowGone?: boolean }> {
    const paths = path ? [path] : [...documents.keys()]
    let firstError: string | undefined
    for (const filePath of paths) {
      const state = documents.get(filePath)
      if (!state) continue
      const bundle = state.family === 'word' ? 'com.microsoft.Word' : 'com.microsoft.Excel'
      try {
        // Minimize before Office restores the old caption/bounds, then verify
        // the same native window again. Word can retain an orphan editor even
        // after its document object has reported that it closed successfully.
        const before = await macNativeOffice<{windowId:number;pid:number;windowGone:boolean}>(
          'releaseDocumentWindow', [bundle, state.marker, state.windowId || 0, state.pid || 0])
        if (before.windowId) { state.windowId = before.windowId; state.pid = before.pid }
        const result = await command(['release', state.family, filePath, String(state.owned), state.originalCaption,
          ...state.originalBounds.map(String)])
        const after = await macNativeOffice<{windowGone:boolean}>('releaseDocumentWindow',
          [bundle, state.marker, state.windowId || 0, state.pid || 0])
        if (result === 'closed' && after.windowGone) documents.delete(filePath)
      } catch (error) {
        if (!firstError) firstError = officeError(error)
      }
    }
    if (!path) {
      try {
        // Also retire windows left by an earlier app session. Only exact PDM
        // UUID titles from Word/Excel qualify; unrelated documents are untouched.
        const orphaned = await macNativeOffice<{bundle:string;marker:string;windowId:number;pid:number}[]>('managedOfficeWindows', [])
        for (const window of orphaned) await macNativeOffice('releaseDocumentWindow',
          [window.bundle, window.marker, window.windowId, window.pid])
      } catch (error) { if (!firstError) firstError = officeError(error) }
    }
    return firstError ? { success: false, error: firstError } : { success: true, windowGone: true }
  }
}
