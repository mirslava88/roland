import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Menu } from 'electron'
import { createControlWindow, createPresentationWindow, createOverlayWindow } from './windows'
import { registerIpcHandlers } from './ipc-handlers'

Menu.setApplicationMenu(null)

let controlWindow: BrowserWindow | null = null
let presentationWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null

function createWindows(): void {
  controlWindow = createControlWindow()
  registerIpcHandlers(controlWindow, () => presentationWindow)

  controlWindow.on('closed', () => {
    controlWindow = null
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
    }
    presentationWindow = null
  })

  ipcMain.handle('open-presentation-window', async (_event, displayId?: number) => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.focus()
      return
    }

    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay

    presentationWindow = createPresentationWindow(targetDisplay!)

    // Wait for the renderer to fully load and React to mount
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000) // fallback timeout
      ipcMain.once('presentation-ready', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    presentationWindow.on('closed', () => {
      presentationWindow = null
      controlWindow?.webContents.send('presentation-window-closed')
    })
  })

  ipcMain.handle('close-presentation-window', () => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
      presentationWindow = null
    }
  })

  ipcMain.handle('show-overlay', async (_event, displayId?: number) => {
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    const externalDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    const targetDisplay = displayId
      ? displays.find((d) => d.id === displayId) || externalDisplay || primaryDisplay
      : externalDisplay || primaryDisplay

    if (!overlayWindow || overlayWindow.isDestroyed()) {
      overlayWindow = createOverlayWindow(targetDisplay!)
    }
    overlayWindow.setBounds(targetDisplay!.bounds)
    overlayWindow.show()
    overlayWindow.webContents.executeJavaScript(
      "document.getElementById('o').classList.remove('hide');document.getElementById('o').classList.add('show');"
    )
    // Wait for fade-in to complete
    await new Promise((r) => setTimeout(r, 450))
  })

  ipcMain.handle('hide-overlay', async () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.executeJavaScript(
        "document.getElementById('o').classList.remove('show');document.getElementById('o').classList.add('hide');"
      )
      // Wait for fade-out, then hide window
      await new Promise((r) => setTimeout(r, 450))
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide()
      }
    }
  })

  ipcMain.handle('get-displays', () => {
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    return displays.map((d) => ({
      id: d.id,
      label: `${d.size.width}x${d.size.height}`,
      isPrimary: d.id === primary.id,
      bounds: d.bounds
    }))
  })

  const sendDisplays = (): void => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      const displays = screen.getAllDisplays()
      const primary = screen.getPrimaryDisplay()
      controlWindow.webContents.send('displays-changed', displays.map((d) => ({
        id: d.id,
        label: `${d.size.width}x${d.size.height}`,
        isPrimary: d.id === primary.id,
        bounds: d.bounds
      })))
    }
  }

  screen.on('display-added', sendDisplays)
  screen.on('display-removed', sendDisplays)

  ipcMain.on('send-to-presentation', (_event, channel: string, ...args: unknown[]) => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.webContents.send(channel, ...args)
    }
  })

  ipcMain.on('send-to-control', (_event, channel: string, ...args: unknown[]) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send(channel, ...args)
    }
  })

  let globalHookEnabled = false

  ipcMain.handle('toggle-global-hook', (_event, enable: boolean) => {
    if (enable && !globalHookEnabled) {
      globalShortcut.register('PageDown', () => {
        controlWindow?.webContents.send('global-key', 'next')
      })
      globalShortcut.register('PageUp', () => {
        controlWindow?.webContents.send('global-key', 'prev')
      })
      globalShortcut.register('Right', () => {
        controlWindow?.webContents.send('global-key', 'next')
      })
      globalShortcut.register('Left', () => {
        controlWindow?.webContents.send('global-key', 'prev')
      })
      globalHookEnabled = true
    } else if (!enable && globalHookEnabled) {
      globalShortcut.unregister('PageDown')
      globalShortcut.unregister('PageUp')
      globalShortcut.unregister('Right')
      globalShortcut.unregister('Left')
      globalHookEnabled = false
    }
    return globalHookEnabled
  })
}

app.whenReady().then(() => {
  createWindows()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindows()
    }
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
