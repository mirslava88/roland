// Measures age of a clock encoded IN the image, not FFmpeg's frame counter.
// Isolated profile and loopback receivers only. Requires an unused output display.
const { app, BrowserWindow, screen } = require('electron')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { once } = require('node:events')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const assert = require('node:assert/strict')
const { StreamingManager } = require('../src/main/streaming.ts')
const root = join(__dirname, '../..')
app.setPath('userData', join(root, 'tmp', 'streaming-latency-profile'))
app.setAppPath(root)
let manager, control, picture, receiver
const seconds = Number(process.env.PDM_LATENCY_SECONDS) || 65
const cleanup = () => { manager?.stop(); receiver?.kill(); picture?.destroy(); control?.destroy() }
const deadline = setTimeout(() => { console.error('FAIL: latency timeout'); cleanup(); app.exit(1) }, (seconds + 35) * 1000)
app.whenReady().then(async () => {
  try {
    const primary = screen.getPrimaryDisplay()
    const target = screen.getAllDisplays().find(d => d.id !== primary.id)
    assert.ok(target, 'Connect an unused secondary display for local latency measurement')
    control = new BrowserWindow({ show: false, x: primary.bounds.x, y: primary.bounds.y, width: 300, height: 200,
      webPreferences: { preload: join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true } })
    await control.loadURL('data:text/html,<title>PDM local latency test</title>')
    manager = new StreamingManager(() => control, () => target.id)
    picture = new BrowserWindow({ ...target.bounds, show: false, frame: false, skipTaskbar: true,
      webPreferences: { sandbox: true, backgroundThrottling: false } })
    // First 32 vertical cells contain Date.now() in 10 ms units modulo 2^32.
    // Black/white markers verify mapping to the correct display and prevent false readings.
    await picture.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;overflow:hidden"><canvas id="c"></canvas><script>
      const c=document.getElementById('c'), g=c.getContext('2d');
      function draw(){ if(c.width!==innerWidth)c.width=innerWidth; if(c.height!==innerHeight)c.height=innerHeight; const t=Math.floor(Date.now()/10)>>>0;
        for(let i=0;i<34;i++){g.fillStyle=(i===33||(i<32&&((t>>>(31-i))&1)))?'white':'black';
          g.fillRect(i*c.width/34,0,Math.ceil(c.width/34),c.height);}
        g.fillStyle='#284784'; g.fillRect(0,c.height*0.6,c.width,c.height*0.4);
        g.fillStyle='white'; g.font='36px sans-serif'; g.fillText('PDM LOCAL LATENCY TEST — '+new Date().toISOString(),40,c.height*0.8);
        requestAnimationFrame(draw); } draw();
      </script>`))
    picture.setBounds(target.bounds); picture.setAlwaysOnTop(true, 'screen-saver'); picture.showInactive()
    const portServer = createServer(); portServer.listen(0,'127.0.0.1'); await once(portServer,'listening')
    const port = portServer.address().port; await new Promise(r=>portServer.close(r))
    let pending=Buffer.alloc(0), errors='', samples=[], count=0, unique=new Set()
    const receive = () => {
    pending = Buffer.alloc(0)
    receiver = spawn(join(root,'node_modules/ffmpeg-static/ffmpeg.exe'), ['-hide_banner','-loglevel','error',
      '-probesize','65536','-analyzeduration','100000','-fflags','nobuffer','-flags','low_delay',
      '-listen','1','-i',`rtmp://127.0.0.1:${port}/live/test`,
      '-an','-vf','crop=iw:ih/3:0:0,scale=34:1:flags=neighbor','-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo','pipe:1'],
      { windowsHide:true, stdio:['ignore','pipe','pipe'] })
    receiver.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-2000)})
    receiver.stdout.on('data', b=>{
      pending=Buffer.concat([pending,b]);
      while(pending.length>=34){const f=pending.subarray(0,34); pending=pending.subarray(34);
        if(f[32]>60||f[33]<190)continue;
        let clock=0; for(let i=0;i<32;i++)clock=clock*2+(f[i]>128?1:0);
        const age=(((Math.floor(Date.now()/10)>>>0)-clock+2**32)%2**32)*10;
        if(age<300000){samples.push(age); count++; unique.add(clock)}
      }
    })
    }
    receive()
    await delay(400)
    const settings={resolution:1080,fps:30,bitrateKbps:6000,encoder:process.env.PDM_LATENCY_ENCODER||'auto',
      audio:process.env.PDM_LATENCY_AUDIO||'system',microphoneId:'',destinations:[{id:'local',name:'Local',enabled:true,server:`rtmp://127.0.0.1:${port}/live`,key:'test'}]}
    await control.webContents.executeJavaScript(`window.api.streaming.start(${JSON.stringify(settings)},${target.id})`)
    const all=[]
    for(let elapsed=0;elapsed<seconds;elapsed+=5){await delay(5000);
      const state=await control.webContents.executeJavaScript('window.api.streaming.status()');
      if(state.phase==='error')throw Error(state.error);
      // A player schedules by PTS, unlike a raw decoder. Check that encoded
      // media time neither runs ahead of wall time nor falls behind it.
      const clockDrift=manager.engine.firstVideoAt ? require('node:perf_hooks').performance.now()-manager.engine.firstVideoAt
        -(manager.engine.lastVideoTime-manager.engine.firstVideoTime) : 0;
      assert.ok(Math.abs(clockDrift)<1500, `Encoded clock drift ${Math.round(clockDrift)} ms would delay timed playback`);
      const sorted=samples.sort((a,b)=>a-b); all.push(...samples);
      console.log(JSON.stringify({seconds:elapsed+5,frames:count,unique:unique.size,median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1),encoder:state.encoder}));
      samples=[];count=0;unique.clear();
      if (process.env.PDM_LATENCY_RECONNECT === '1' && elapsed === 25) {
        const closed = once(receiver, 'exit'); receiver.kill(); await closed
        await delay(3000); receive()
        console.log('Simulated receiver disconnection; measuring freshness after reconnect')
      }
    }
    assert.ok(all.length>seconds*15,`Too few decoded watermark frames: ${all.length}. ${errors}`)
    all.sort((a,b)=>a-b)
    const p95=all[Math.floor(all.length*.95)]
    assert.ok(p95<1500,`Local capture → decoded RTMP p95 delay ${p95} ms exceeds 1500 ms`)
    console.log(`PASS: measured ${all.length} image timestamps; p95=${p95} ms`)
    clearTimeout(deadline);cleanup();app.exit(0)
  } catch(e){console.error('FAIL:',e.message);clearTimeout(deadline);cleanup();app.exit(1)}
})
