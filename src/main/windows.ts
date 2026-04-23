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
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  })

  win.removeMenu()

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

  // show: false — создаём скрытым. Иначе Windows DWM при показе fullscreen
  // окна может мгновенно promote его выше overlay screen-saver в z-order
  // (WM_CREATE + SW_SHOW синхронно), и его #000 background вспыхивает
  // через → вспышка при переходе на новый контент. Caller должен:
  // 1. createPresentationWindow (скрытым)
  // 2. re-assert overlay topmost
  // 3. presentationWindow.show()
  // Тогда первый paint окна happens уже ПОД overlay.
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: true,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    title: 'Presentation',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
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
    transparent: false,
    backgroundColor: '#000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Критично: при setOpacity(0) Chromium считает окно "скрытым" и троттлит
      // рендер (rAF не тикают, f.src не добирается до compositor). Следующий
      // showOverlay обновляет f.src ЧЕРЕЗ executeJavaScript + 2 rAF, но на
      // троттленном рендере эти 2 rAF откладываются на секунды, и setOpacity(1)
      // поднимает окно ДО того как новый кадр отрисуется → видно старый кадр
      // (слайд 1 с момента пиннинга) пока не придёт новый. Выключаем троттлинг:
      // renderer всегда активен, f.src обновляется моментально.
      backgroundThrottling: false
    }
  })

  // Highest standard z-order so PowerPoint slideshow can't pop above it.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)
  win.setIgnoreMouseEvents(true)

  // Solid black page; shown opaque instantly on show(), quick fade on hide.
  // Optional <img id="f"> holds a "freeze-frame" screenshot during seamless
  // channel switches — the audience keeps seeing the previous slide while
  // PowerPoint swaps behind it.
  const html = `<html><head><style>
    html, body { margin:0; height:100%; background:#000; overflow:hidden; }
    .overlay { position:fixed; inset:0; background:#000; opacity:1; }
    .overlay.hide { opacity:0; transition: opacity 0.15s ease-out; }
    #f { position:absolute; inset:0; width:100%; height:100%; object-fit:contain;
         display:none; user-select:none; -webkit-user-drag:none; }
  </style></head><body>
    <div class="overlay" id="o"><img id="f" /></div>
  </body></html>`

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  return win
}

export function createTimerOverlayWindow(display?: Display): BrowserWindow {
  const target = display || screen.getPrimaryDisplay()
  const { x, y, width, height } = target.bounds

  const winW = 280
  const winH = 80
  const win = new BrowserWindow({
    x: x + width - winW - 40,
    y: y + height - winH - 40,
    width: winW,
    height: winH,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    show: false,
    hasShadow: false,
    title: '',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  })

  win.removeMenu()
  win.setAlwaysOnTop(true, 'screen-saver')

  // Fix: Windows DWM draws a gray strip on deactivation of transparent frameless windows.
  // Resizing forces a clean redraw without the strip — so after deactivation,
  // toggle the window size by 1px to force a fresh render.
  const WM_NCACTIVATE = 0x0086
  win.hookWindowMessage(WM_NCACTIVATE, () => {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        const [w, h] = win.getSize()
        win.setSize(w + 1, h)
        win.setSize(w, h)
      }
    }, 50)
    return Buffer.alloc(0)
  })

  const html = `<html><head><title></title><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body {
      background: transparent;
      overflow: hidden;
      width: 100%;
      height: 100%;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
    }
    body.dragging { cursor: grabbing; }
    #timer-display {
      font-family: 'Consolas', 'Courier New', monospace;
      font-weight: bold;
      font-size: 48px;
      padding: 8px 24px;
      white-space: nowrap;
      text-align: center;
      text-shadow: 0 2px 8px rgba(0,0,0,0.8);
      display: none;
    }
    .timer-normal { color: #fff; background: rgba(0,0,0,0.5); border-radius: 10px; }
    .timer-warning { color: #facc15; background: rgba(60,20,0,0.6); border-radius: 10px; }
    .timer-overtime { color: #ef4444; background: rgba(60,0,0,0.6); border-radius: 10px; }
  </style></head><body>
    <div id="timer-display" class="timer-normal">--:--</div>
    <script>
      const display = document.getElementById('timer-display');
      let scale = 1;
      let isDragging = false;
      let lastX = 0, lastY = 0;

      // Drag via IPC
      document.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        lastX = e.screenX;
        lastY = e.screenY;
        document.body.classList.add('dragging');
      });
      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.screenX - lastX;
        const dy = e.screenY - lastY;
        lastX = e.screenX;
        lastY = e.screenY;
        window.api.moveTimerOverlay(dx, dy);
      });
      document.addEventListener('mouseup', () => {
        isDragging = false;
        document.body.classList.remove('dragging');
      });

      // Scroll to scale + resize window
      document.addEventListener('wheel', (e) => {
        e.preventDefault();
        scale = Math.max(0.5, Math.min(4, scale + (e.deltaY > 0 ? -0.1 : 0.1)));
        const w = Math.round(280 * scale);
        const h = Math.round(80 * scale);
        display.style.fontSize = Math.round(48 * scale) + 'px';
        display.style.padding = Math.round(8 * scale) + 'px ' + Math.round(24 * scale) + 'px';
        window.api.resizeTimerOverlay(w, h);
      }, { passive: false });

      function formatTime(totalSeconds) {
        const negative = totalSeconds < 0;
        const abs = Math.abs(totalSeconds);
        const h = Math.floor(abs / 3600);
        const m = Math.floor((abs % 3600) / 60);
        const s = abs % 60;
        const pad = n => n.toString().padStart(2, '0');
        const time = h > 0 ? pad(h)+':'+pad(m)+':'+pad(s) : pad(m)+':'+pad(s);
        return negative ? '-'+time : time;
      }

      window._updateTimer = function(data) {
        if (!data || (data.duration === 0 && data.remaining === 0)) {
          display.style.display = 'none';
          return;
        }
        display.style.display = 'block';
        display.textContent = formatTime(data.remaining);

        display.className = '';
        if (data.remaining < 0) {
          display.classList.add('timer-overtime');
        } else if (data.remaining <= 60 && data.running) {
          display.classList.add('timer-warning');
        } else {
          display.classList.add('timer-normal');
        }
      };

      window._playSound = function(type, filePath) {
        const url = 'file:///' + filePath.replace(/\\\\/g, '/');
        const audio = new Audio(url);
        audio.play().catch(() => {});
      };
    </script>
  </body></html>`

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  return win
}

export function createMusicPlayerWindow(display?: Display): BrowserWindow {
  const target = display || screen.getPrimaryDisplay()
  const { x, y } = target.bounds

  const win = new BrowserWindow({
    x: x + 10,
    y: y + 10,
    width: 1,
    height: 1,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    focusable: false,
    thickFrame: false,
    title: '',
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  })

  win.removeMenu()

  const html = `<html><head><title></title></head><body>
    <audio id="player"></audio>
    <script>
      const player = document.getElementById('player');
      let playlist = [];
      let currentIndex = 0;
      let loopTrack = false;
      let loopPlaylist = true;

      player.addEventListener('ended', () => {
        if (loopTrack) {
          player.currentTime = 0;
          player.play();
          return;
        }
        if (currentIndex < playlist.length - 1) {
          currentIndex++;
          loadAndPlay();
        } else if (loopPlaylist && playlist.length > 1) {
          currentIndex = 0;
          loadAndPlay();
        } else {
          window._sendState();
        }
      });

      player.addEventListener('timeupdate', () => {
        window._sendState();
      });

      player.addEventListener('play', () => window._sendState());
      player.addEventListener('pause', () => window._sendState());

      function loadAndPlay() {
        if (currentIndex < 0 || currentIndex >= playlist.length) return;
        const filePath = playlist[currentIndex];
        player.src = 'file:///' + filePath.replace(/\\\\/g, '/');
        player.play().catch(() => {});
        window._sendState();
      }

      window._setPlaylist = function(files, startIndex) {
        playlist = files;
        currentIndex = startIndex || 0;
        if (playlist.length > 0) loadAndPlay();
        else window._sendState();
      };

      window._play = function() {
        if (player.src && player.src !== location.href) player.play().catch(() => {});
        else if (playlist.length > 0) loadAndPlay();
      };

      window._pause = function() { player.pause(); };

      window._stop = function() {
        player.pause();
        player.currentTime = 0;
        player.src = '';
        window._sendState();
      };

      window._next = function() {
        if (playlist.length === 0) return;
        currentIndex = (currentIndex + 1) % playlist.length;
        loadAndPlay();
      };

      window._prev = function() {
        if (playlist.length === 0) return;
        if (player.currentTime > 3) {
          player.currentTime = 0;
          return;
        }
        currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
        loadAndPlay();
      };

      window._seek = function(t) { player.currentTime = t; window._sendState(); };

      window._setLoopTrack = function(v) { loopTrack = v; window._sendState(); };
      window._setLoopPlaylist = function(v) { loopPlaylist = v; window._sendState(); };

      window._setVolume = function(v) { player.volume = v; window._sendState(); };

      window._getState = function() {
        return {
          playing: !player.paused && !!player.src && player.src !== location.href,
          currentIndex: currentIndex,
          currentTime: player.currentTime || 0,
          duration: player.duration || 0,
          volume: player.volume,
          loopTrack: loopTrack,
          loopPlaylist: loopPlaylist,
          trackName: playlist[currentIndex] ? playlist[currentIndex].split(/[\\\\/]/).pop() : '',
          playlistLength: playlist.length
        };
      };

      window._sendState = function() {
        // State polled from main process
      };
    </script>
  </body></html>`

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  return win
}
