import { app } from 'electron'
import type { WebPreferences } from 'electron'

export function macReleaseWebPreferences(): Pick<WebPreferences, 'devTools'> {
  return process.platform === 'darwin' && app.isPackaged ? { devTools: false } : {}
}

export function hardenMacReleaseRuntime(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  // The Node inspector is disabled by the packaged fuse. Chromium debugging
  // has separate switches, which must be removed before browser startup too.
  for (const flag of ['remote-debugging-port', 'remote-debugging-pipe',
    'remote-debugging-address', 'remote-allow-origins']) {
    app.commandLine.removeSwitch(flag)
  }
  app.enableSandbox()
}
