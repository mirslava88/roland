import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

const MAX_LOG_BYTES = 8 * 1024 * 1024
let logDirectory = ''
let logPath = ''
let initialized = false

// A detached/dev Electron process can outlive the terminal that launched it.
// Windows then closes the inherited stdout pipe; any later console.log emits
// EPIPE. Without an error listener Node treats that stream error as uncaught
// and shows "A JavaScript error occurred in the main process". Diagnostics
// are best-effort and must never be able to terminate the application.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', () => { /* the persistent file log remains available */ })
}

function ensurePaths(): void {
  if (logPath) return
  logDirectory = join(app.getPath('userData'), 'logs')
  logPath = join(logDirectory, 'pdm-diagnostic.log')
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(logPath) || statSync(logPath).size < MAX_LOG_BYTES) return
    const previous = join(logDirectory, 'pdm-diagnostic.previous.log')
    if (existsSync(previous)) {
      // renameSync with overwrite is not portable on Windows; using a dated
      // archive avoids deleting a user's previous diagnostic log.
      const dated = join(logDirectory, `pdm-diagnostic-${Date.now()}.log`)
      renameSync(logPath, dated)
    } else {
      renameSync(logPath, previous)
    }
  } catch { /* logging must never break the application */ }
}

export function initDiagnosticLog(): string {
  ensurePaths()
  if (initialized) return logPath
  try {
    mkdirSync(logDirectory, { recursive: true })
    rotateIfNeeded()
  } catch { /* handled by best-effort appends below */ }
  initialized = true
  diagnosticLog('session', '============================================================')
  diagnosticLog('session', `start=${new Date().toISOString()} app=${app.getVersion()} packaged=${app.isPackaged}`)
  diagnosticLog('session', `platform=${process.platform} arch=${process.arch} os=${process.getSystemVersion()} electron=${process.versions.electron} node=${process.versions.node}`)
  diagnosticLog('session', `execPath=${process.execPath}`)
  return logPath
}

export function getDiagnosticLogDirectory(): string {
  ensurePaths()
  try { mkdirSync(logDirectory, { recursive: true }) } catch {}
  return logDirectory
}

export function getDiagnosticLogPath(): string {
  ensurePaths()
  return logPath
}

export function diagnosticLog(scope: string, message: string): void {
  ensurePaths()
  const line = `[${new Date().toISOString()}] [${scope}] ${message}`
  try {
    if (process.stdout?.writable && !process.stdout.destroyed) console.log(line)
  } catch { /* closed console pipe; continue with the persistent file */ }
  try {
    mkdirSync(logDirectory, { recursive: true })
    appendFileSync(logPath, line + '\n', { encoding: 'utf8' })
  } catch { /* never throw from diagnostics */ }
}

export function formatDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & {
      code?: unknown
      signal?: unknown
      killed?: unknown
      cmd?: unknown
      stdout?: unknown
      stderr?: unknown
    }
    return [
      error.stack || error.message,
      extra.code !== undefined ? `code=${String(extra.code)}` : '',
      extra.signal !== undefined ? `signal=${String(extra.signal)}` : '',
      extra.killed !== undefined ? `killed=${String(extra.killed)}` : '',
      extra.cmd !== undefined ? `cmd=${String(extra.cmd)}` : '',
      extra.stdout ? `stdout=${String(extra.stdout).trim()}` : '',
      extra.stderr ? `stderr=${String(extra.stderr).trim()}` : ''
    ].filter(Boolean).join(' | ')
  }
  try { return JSON.stringify(error) } catch { return String(error) }
}

export function compactLogText(value: unknown, maxLength = 4000): string {
  const text = String(value ?? '').trim().replace(/\r?\n/g, ' ↵ ')
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…[truncated]`
}
