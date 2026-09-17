import { app, BrowserWindow } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The dev server is a development-only capability. A packaged PDM must never
 * inherit an ELECTRON_RENDERER_URL supplied by a launcher or another process.
 */
export function getTrustedRendererDevUrl(): string | null {
  if (app.isPackaged) return null
  const raw = process.env['ELECTRON_RENDERER_URL']?.trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      return null
    }
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

export function rendererPageUrl(page: 'index.html' | 'presentation.html' | 'auxiliary.html' | 'streaming.html'): string {
  const devUrl = getTrustedRendererDevUrl()
  if (devUrl) {
    if (page === 'index.html') return devUrl
    return new URL(page, `${devUrl}/`).href
  }
  return pathToFileURL(join(__dirname, '../renderer', page)).href
}

export function matchesRendererPage(
  actualUrl: string,
  page: 'index.html' | 'presentation.html' | 'auxiliary.html' | 'streaming.html'
): boolean {
  try {
    const actual = new URL(actualUrl)
    const expected = new URL(rendererPageUrl(page))
    return actual.origin === expected.origin && actual.pathname === expected.pathname
  } catch {
    return false
  }
}

export function isTrustedWindowMainFrame(
  event: IpcMainEvent | IpcMainInvokeEvent,
  win: BrowserWindow | null | undefined,
  page: 'index.html' | 'presentation.html' | 'auxiliary.html' | 'streaming.html'
): boolean {
  return !!win && !win.isDestroyed() && !event.sender.isDestroyed() &&
    event.sender === win.webContents && event.senderFrame === event.sender.mainFrame &&
    matchesRendererPage(event.senderFrame.url, page)
}

export function isTrustedWebContentsPage(
  contents: WebContents | null,
  page: 'index.html' | 'presentation.html' | 'auxiliary.html' | 'streaming.html'
): boolean {
  return !!contents && !contents.isDestroyed() && matchesRendererPage(contents.getURL(), page)
}
