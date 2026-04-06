import { BrowserWindow, Display, shell, screen } from 'electron'
import { join } from 'path'

export function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#11111b',
    title: 'Presentation Display Manager',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function createPresentationWindow(display: Display): BrowserWindow {
  const { x, y, width, height } = display.bounds

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: true,
    frame: false,
    backgroundColor: '#000000',
    title: 'Presentation',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setMenuBarVisibility(false)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/presentation.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/presentation.html'))
  }

  return win
}

export function createOverlayWindow(display?: Display): BrowserWindow {
  const target = display || screen.getPrimaryDisplay()
  const { x, y, width, height } = target.bounds

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setMenuBarVisibility(false)
  win.setIgnoreMouseEvents(true)

  const html = `<html><head><style>
    body { margin:0; background:transparent; }
    .overlay {
      position:fixed; inset:0; background:#000;
      opacity:0; transition: opacity 0.4s ease-in-out;
    }
    .overlay.show { opacity:1; }
    .overlay.hide { opacity:0; }
  </style></head><body>
    <div class="overlay" id="o"></div>
    <script>
      window.addEventListener('message', e => {
        const el = document.getElementById('o');
        if (e.data === 'fade-in') { el.classList.remove('hide'); el.classList.add('show'); }
        if (e.data === 'fade-out') { el.classList.remove('show'); el.classList.add('hide'); }
      });
    </script>
  </body></html>`

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  return win
}
