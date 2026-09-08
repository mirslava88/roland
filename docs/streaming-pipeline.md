# PDM streaming: architecture and verification

## Reference designs

- [OBS backend design](https://docs.obsproject.com/backend-design): raw frames with timestamps, a bounded video queue, one encoder feeding outputs.
- [OBS RTMP output](https://github.com/obsproject/obs-studio/blob/master/plugins/obs-outputs/rtmp-stream.c): separate sending, queue-age checks, frame dropping and reconnect handling.
- [vMix streaming quality](https://www.vmix.com/help21/StreamingQuality.html): configurable network buffering, H.264/AAC and keyframe interval. vMix is closed source; these findings concern its documented behavior, not an inspection of its implementation.

## Current PDM path

Windows GDI capture of the selected physical screen → scale preserving aspect ratio → H.264 encoder → FLV packets → independent copy-only RTMP/RTMPS senders.

The capture rectangle is computed in main with Electron's DPI-aware conversion, not provided by the renderer. Display removal, reassignment, rotation or scale changes stop capture. This captures the actual program screen including native Office windows, timers and overlays.

Audio uses Electron loopback and/or the selected microphone. An AudioWorklet supplies stereo 48 kHz PCM in 20 ms blocks. Only one block may be in flight; missing blocks are filled with silence to preserve the timeline. Capture age comes from the worklet's wall clock, not a one-time conversion from AudioContext time. The video track temporarily needed for Electron's loopback permission is stopped immediately.

There is no MediaRecorder, VP8/WebM intermediate or second video encode. There is also no reassignment of old compressed video timestamps to current wall time. Native video timestamps retain gaps when capture skips a frame. Audio sample counts define the PCM timeline.

Intel QSV explicitly uses `forced_idr=1` in addition to time-based `force_key_frames`. Without it, forced I pictures are not necessarily IDR pictures, so the stream can lack independent decoder entry points when capture drops frames. Regression tests inspect actual H.264 NAL units and start a new decoder from each two-second segment; a continuously running decoder alone does not test late joining.

Each sender has an application queue bounded by both 1.2 seconds of media and 2 MiB. Overflow discards unsent video through the next H.264 keyframe, and the corresponding audio, without closing the connection. Connection setup has a separate 15-second deadline: applying the media queue deadline to RTMP/TLS setup caused endless reconnects on otherwise valid slower connections. Sender FFmpeg input buffers are monitored separately using mux progress; persistent lag or stalled sending reconnects that destination with fresh codec headers. A pipe write is not treated as proof of transmission. A connected TCP peer that never completes RTMP must not appear live or block other destinations.

Transport statistics describe PDM's encoding/sending stages, not a service's player buffer or confirmation that viewers can see the broadcast. Persistent encoder lag or unavailable audio stops streaming with an error instead of accumulating old content. Actual throughput depends on hardware and load.

## Tests

Run `npm run build` first. All tests publish only to loopback; display tests require a free secondary monitor and use isolated profiles.

- `npm run test:streaming`: two destinations, initial connection failure, recovery, stalled RTMP handshake, independent output, honest connection state, child-process cleanup. Also tests a valid server with a 2.2-second setup delay: stale frames are discarded, but connection setup completes once and decoded video resumes without growing backlog.
- This command also verifies genuine two-second IDR intervals with skipped capture frames and independently decodes each segment for software H.264 and Intel QSV (when available).
- `npm run test:streaming:capture`: native 1080p capture, QSV where available, silent/system audio, actual decoded test-tone amplitude, no nonmonotonic timestamps, receiver reconnect, display-routing guard and capture cleanup.
- `npm run test:streaming:latency`: draws a machine-readable clock on the output display, decodes it from received H.264 frames and measures frame age. Also checks encoded media clock against elapsed real time. Counting FFmpeg frames alone does not establish latency.

For a longer run in PowerShell:

```powershell
$env:PDM_LATENCY_SECONDS = '180'
$env:PDM_LATENCY_RECONNECT = '1'
npm run test:streaming:latency
```

Measured on the development laptop on 2026-09-07, with 1080p, a 30 fps capture setting and Intel QSV: the three-minute run including receiver disconnection/reconnection decoded 4,299 clock frames; p95 image age was 210 ms. This is a local capture-to-decoder measurement, not a Telegram end-to-end measurement and not a guarantee of 30 actual frames/s on every computer.
