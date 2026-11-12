import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import ffmpeg from 'ffmpeg-static'

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/main/recording-editor-engine.ts', import.meta.url))], bundle: true,
  platform: 'node', format: 'esm', write: false })
const { probeRecording, previewFrame, timelineThumbnails, timelineWaveform, timelineWaveformRange,
  editArguments, editTimelineArguments, startEdit } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const { extractClips, deleteClips, insertClips, sourceAt, timelineDuration } = await import('../src/shared/recording-timeline.ts')
const { visibleWaveformTiles, visibleFrameTiles, visibleRulerTicks, frameDisplayForTime, fallbackWaveformForTile,
  timelineEdgeScrollDelta, timelineScrollForAnchor, timelineTimeAtX } = await import('../src/shared/recording-waveform.ts')
const { recordingShortcut } = await import('../src/shared/recording-shortcuts.ts')
const directory = await mkdtemp(join(tmpdir(), 'pdm-edit-test-'))
const sink = process.platform === 'win32' ? 'NUL' : '/dev/null'

try {
  const initial = [{ start: 0, end: 8 }]
  assert.deepEqual(extractClips(initial, 2, 5), [{ start: 2, end: 5 }])
  assert.deepEqual(deleteClips(initial, 2, 5), [{ start: 0, end: 2 }, { start: 5, end: 8 }])
  const rearranged = insertClips(deleteClips(initial, 2, 5), 5, [{ start: 2, end: 5 }])
  assert.deepEqual(rearranged, [{ start: 0, end: 2 }, { start: 5, end: 8 }, { start: 2, end: 5 }])
  assert.equal(timelineDuration(rearranged), 8)
  assert.deepEqual(sourceAt(rearranged, 2.4), { clipIndex: 1, sourceTime: 5.4, timelineStart: 2 })
  console.log('PASS: cut, paste and edited timeline position are consistent')
  const broad = visibleWaveformTiles([{ start: 0, end: 8 }], { start: 0, end: 8, width: 960 })
  const close = visibleWaveformTiles([{ start: 0, end: 8 }], { start: 1, end: 1.5, width: 960 })
  assert.ok(broad.length && close.length)
  assert.ok(close[0].request.end - close[0].request.start < broad[0].request.end - broad[0].request.start / 8)
  assert.ok(close[0].request.width >= 16 && close[0].request.width <= 2048)
  const reorderedTiles = visibleWaveformTiles([{ start: 0, end: 1 }, { start: 3, end: 5 }],
    { start: 0.8, end: 1.2, width: 960 })
  assert.ok(reorderedTiles.some(tile => tile.request.start >= 3 && tile.timelineStart >= 1))
  const fineTiles = visibleWaveformTiles([{ start: 0, end: 1 }], { start: 0.49, end: 0.492, width: 960 })
  assert.ok(fineTiles.length && fineTiles.every(tile => tile.request.end - tile.request.start >= 0.0005))
  const movedFrames = visibleFrameTiles([{ start: 0, end: 1 }, { start: 3, end: 5 }],
    { start: 1.2, end: 1.4, width: 960 })
  assert.ok(movedFrames.length && movedFrames.every(tile => tile.sourceTime >= 3.2 && tile.sourceTime < 3.4))
  const heldFrame = visibleFrameTiles([{ start: 0, end: 8 }],
    { start: 1.201, end: 1.215, width: 960 }, 25)
  assert.equal(heldFrame.length, 1)
  assert.equal(heldFrame[0].frameIndex, 30)
  assert.ok(heldFrame[0].timelineEnd - heldFrame[0].timelineStart > 0.039)
  const closeTicks = visibleRulerTicks({ start: 3.49, end: 3.502, width: 960 })
  assert.ok(closeTicks.length >= 4 && closeTicks.length < 20)
  assert.ok(closeTicks.every(tick => tick.label.includes('.')))
  assert.equal(new Set(closeTicks.map(tick => tick.label)).size, closeTicks.length)
  assert.deepEqual(frameDisplayForTime(1.5, 25, 8, { '1.500': 'exact' }, ['overview']),
    { image: 'exact', exact: true })
  assert.deepEqual(frameDisplayForTime(1.5, 25, 8, { '1.480': 'near' }, ['overview']),
    { image: 'near', exact: false })
  assert.deepEqual(frameDisplayForTime(1.5, 25, 8, {}, ['overview']),
    { image: 'overview', exact: false })
  assert.ok(timelineEdgeScrollDelta(1030, 100, 1000, 16) > 0)
  assert.ok(timelineEdgeScrollDelta(70, 100, 1000, 16) < 0)
  assert.equal(timelineEdgeScrollDelta(500, 100, 1000, 16), 0)
  for (const x of [120, 480, 840]) {
    const time = timelineTimeAtX(6850, 147530, x, 147.53)
    const nextLeft = timelineScrollForAnchor(time, 147.53, 365000, 960, x)
    assert.ok(Math.abs(timelineTimeAtX(nextLeft, 365000, x, 147.53) - time) < 0.000001)
  }
  assert.equal(timelineScrollForAnchor(0, 147.53, 365000, 960, 480), 0)
  const duplicateTiles = visibleWaveformTiles([{ start: 2, end: 2.2 }, { start: 2, end: 2.2 }],
    { start: 0, end: 0.4, width: 960 })
  assert.ok(duplicateTiles.some(tile => tile.timelineStart >= 0.2 && tile.request.start >= 2))
  const fallbackTile = { timelineStart: 10, timelineEnd: 10.5, request: { start: 2, end: 2.5, width: 480 } }
  assert.deepEqual(fallbackWaveformForTile(fallbackTile, [
    { start: 0, end: 4, width: 400, image: 'broad' },
    { start: 1.5, end: 3, width: 300, image: 'closer' }
  ]), { image: 'closer', imageWidth: 300, imageX: 100, imageVisibleWidth: 100,
    timelineStart: 10, timelineEnd: 10.5 })
  assert.deepEqual(fallbackWaveformForTile(fallbackTile, [
    { start: 2.2, end: 2.4, width: 200, image: 'partial' }
  ]), { image: 'partial', imageWidth: 200, imageX: 0, imageVisibleWidth: 200,
    timelineStart: 10.2, timelineEnd: 10.4 })
  console.log('PASS: zoom requests finer, correctly mapped waveform windows')
  const shortcut = (code, key, extras = {}) => recordingShortcut({ code, key, ctrlKey: true,
    metaKey: false, shiftKey: false, altKey: false, ...extras })
  for (const [code, english, russian, expected] of [
    ['KeyZ', 'z', 'я', 'undo'], ['KeyC', 'c', 'с', 'copy'], ['KeyV', 'v', 'м', 'paste'],
    ['KeyX', 'x', 'ч', 'cut'], ['KeyA', 'a', 'ф', 'select-all'], ['KeyS', 's', 'ы', 'save'],
    ['KeyY', 'y', 'н', 'redo']
  ]) {
    assert.equal(shortcut(code, english), expected)
    assert.equal(shortcut(code, russian), expected)
    assert.equal(shortcut('', russian), expected)
  }
  assert.equal(shortcut('KeyZ', 'я', { shiftKey: true }), 'redo')
  assert.equal(shortcut('KeyZ', 'я', { altKey: true }), null)
  console.log('PASS: montage shortcuts are independent of keyboard layout')

  const sourcePath = join(directory, 'source.mp4')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3',
    '-af', 'afade=t=in:st=1:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', sourcePath], { timeout: 30000 })
  const source = await probeRecording(ffmpeg, sourcePath)
  assert.equal(source.format, 'mp4')
  assert.equal(source.hasAudio, true)
  assert.equal(source.frameRate, 25)
  assert.ok(source.duration >= 2.9 && source.duration <= 3.1)
  assert.match(await previewFrame(ffmpeg, source, 1), /^data:image\/jpeg;base64,.{100}/)
  const thumbnails = await timelineThumbnails(ffmpeg, source)
  assert.equal(thumbnails.length, 12)
  assert.ok(thumbnails.every(frame => frame.startsWith('data:image/jpeg;base64,')))
  assert.notEqual(thumbnails[0], thumbnails[11], 'filmstrip must show different moments')
  const waveform = await timelineWaveform(ffmpeg, source)
  assert.ok(waveform?.startsWith('data:image/png;base64,'))
  const png = Buffer.from(waveform.slice('data:image/png;base64,'.length), 'base64')
  assert.equal(png.readUInt32BE(16), 1200)
  assert.equal(png.readUInt32BE(20), 96)
  console.log('PASS: filmstrip and full audio waveform are generated')
  const quiet = await timelineWaveformRange(ffmpeg, source, 0, 0.5, 512)
  const loud = await timelineWaveformRange(ffmpeg, source, 2, 2.5, 512)
  assert.ok(quiet?.startsWith('data:image/svg+xml;base64,') && loud?.startsWith('data:image/svg+xml;base64,'))
  assert.notEqual(quiet, loud, 'zoomed waveform reused a stretched image')
  const zoomSvg = Buffer.from(loud.slice('data:image/svg+xml;base64,'.length), 'base64').toString()
  assert.match(zoomSvg, /width="512"/)
  assert.ok((zoomSvg.match(/M\d+ /g) || []).length >= 512)
  const fine = await timelineWaveformRange(ffmpeg, source, 2, 2.1, 512)
  assert.ok(fine?.startsWith('data:image/svg+xml;base64,'))
  assert.notEqual(fine, loud, 'fine zoom reused a broad peak waveform')
  const microscopic = await timelineWaveformRange(ffmpeg, source, 2, 2.003, 512)
  assert.ok(microscopic?.startsWith('data:image/svg+xml;base64,'))
  assert.match(Buffer.from(microscopic.slice('data:image/svg+xml;base64,'.length), 'base64').toString(), /width="512"/)
  assert.match(Buffer.from(microscopic.slice('data:image/svg+xml;base64,'.length), 'base64').toString(), /preserveAspectRatio="none"/)
  console.log('PASS: zoomed waveform resolves distinct audio windows at full pixel width')
  const shortAudioPath = join(directory, 'short-audio.mp4')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-t', '4',
    '-i', 'testsrc2=size=160x90:rate=25', '-f', 'lavfi', '-t', '1',
    '-i', 'sine=frequency=440:sample_rate=48000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-y', shortAudioPath], { timeout: 30000 })
  const shortAudio = await probeRecording(ffmpeg, shortAudioPath)
  assert.equal(shortAudio.hasAudio, true)
  for (const [from, to] of [[2, 3], [2.1, 2.2]]) {
    const empty = await timelineWaveformRange(ffmpeg, shortAudio, from, to, 480)
    assert.ok(empty?.startsWith('data:image/svg+xml;base64,'))
    assert.match(Buffer.from(empty.slice('data:image/svg+xml;base64,'.length), 'base64').toString(), /M0 24H480 M0 72H480/)
  }
  console.log('PASS: missing audio packets render silence without erasing other waveform windows')

  for (const [format, extension] of [['quality-mp4', 'mp4'], ['lossless-mkv', 'mkv']]) {
    const clip = join(directory, `clip.${extension}`)
    const result = startEdit(ffmpeg, editArguments(source, 0.6, 2.2, format, 'both', clip), 1.6, () => {})
    await result.done
    const info = await probeRecording(ffmpeg, clip)
    assert.equal(info.hasAudio, true)
    assert.ok(info.duration > 1.45 && info.duration < 1.75, `${format}: wrong duration ${info.duration}`)
    assert.ok((await stat(clip)).size > 1000)
    execFileSync(ffmpeg, ['-v', 'error', '-i', clip, '-f', 'null', sink], { timeout: 30000 })
    console.log(`PASS: ${format} fragment has readable video and audio`)
  }

  const montage = [{ start: 2.1, end: 2.7 }, { start: 0.4, end: 1.1 }, { start: 1.4, end: 2.2 }]
  const montagePath = join(directory, 'montage.mp4')
  await startEdit(ffmpeg, editTimelineArguments(source, montage, 'quality-mp4', 'both', montagePath),
    timelineDuration(montage), () => {}).done
  const montageInfo = await probeRecording(ffmpeg, montagePath)
  assert.ok(montageInfo.duration > 1.95 && montageInfo.duration < 2.2, `montage: wrong duration ${montageInfo.duration}`)
  assert.equal(montageInfo.hasAudio, true)
  execFileSync(ffmpeg, ['-v', 'error', '-i', montagePath, '-f', 'null', sink], { timeout: 30000 })
  console.log('PASS: reordered video and audio fragments export and decode')
  const silentSourcePath = join(directory, 'silent-source.mp4')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', sourcePath,
    '-map', '0:v:0', '-c:v', 'copy', '-y', silentSourcePath], { timeout: 30000 })
  const silentSource = await probeRecording(ffmpeg, silentSourcePath)
  assert.equal(silentSource.hasAudio, false)
  const silentMontage = join(directory, 'silent-montage.mp4')
  await startEdit(ffmpeg, editTimelineArguments(silentSource, montage, 'quality-mp4', 'both', silentMontage),
    timelineDuration(montage), () => {}).done
  assert.equal((await probeRecording(ffmpeg, silentMontage)).hasAudio, false)
  execFileSync(ffmpeg, ['-v', 'error', '-i', silentMontage, '-f', 'null', sink], { timeout: 30000 })
  console.log('PASS: montage without audio exports and decodes')

  const losslessSourcePath = join(directory, 'lossless-source.mkv')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-c:v', 'libx264rgb',
    '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'bgr0', '-c:a', 'pcm_f32le', '-y', losslessSourcePath], { timeout: 30000 })
  const losslessSource = await probeRecording(ffmpeg, losslessSourcePath)
  assert.equal(losslessSource.format, 'mkv')
  const losslessClip = join(directory, 'lossless-clip.mkv')
  await startEdit(ffmpeg, editArguments(losslessSource, 0.6, 2.2, 'lossless-mkv', 'both', losslessClip), 1.6, () => {}).done
  const rgbFrame = (path, seek) => execFileSync(ffmpeg, ['-v', 'error', ...(seek ? ['-ss', seek] : []),
    '-i', path, '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
  assert.deepEqual(rgbFrame(losslessClip), rgbFrame(losslessSourcePath, '0.600'), 'MKV edit changed RGB pixels')
  console.log('PASS: MKV fragment preserves decoded RGB pixels')

  const losslessMontage = join(directory, 'lossless-montage.mkv')
  await startEdit(ffmpeg, editTimelineArguments(losslessSource, [{ start: 1.6, end: 2.2 }, { start: 0.4, end: 1 }],
    'lossless-mkv', 'both', losslessMontage), 1.2, () => {}).done
  assert.deepEqual(rgbFrame(losslessMontage), rgbFrame(losslessSourcePath, '1.600'), 'MKV montage changed RGB pixels')
  assert.equal((await probeRecording(ffmpeg, losslessMontage)).hasAudio, true)
  console.log('PASS: reordered MKV montage preserves RGB pixels')

  const videoPath = join(directory, 'video.mp4')
  const audioPath = join(directory, 'audio.wav')
  await startEdit(ffmpeg, editArguments(source, 0.6, 2.2, 'quality-mp4', 'video', videoPath), 1.6, () => {}).done
  await startEdit(ffmpeg, editArguments(source, 0.6, 2.2, 'quality-mp4', 'audio', audioPath), 1.6, () => {}).done
  const videoInfo = spawnSync(ffmpeg, ['-hide_banner', '-i', videoPath], { encoding: 'utf8' }).stderr
  const audioInfo = spawnSync(ffmpeg, ['-hide_banner', '-i', audioPath], { encoding: 'utf8' }).stderr
  assert.match(videoInfo, /Video:/)
  assert.doesNotMatch(videoInfo, /Audio:/)
  assert.match(audioInfo, /Audio: pcm_f32le/)
  assert.doesNotMatch(audioInfo, /Video:/)
  assert.ok((await stat(audioPath)).size > 1000)
  console.log('PASS: separate video and WAV tracks decode independently')

  const montageAudio = join(directory, 'montage-audio.wav')
  await startEdit(ffmpeg, editTimelineArguments(source, montage, 'quality-mp4', 'audio', montageAudio),
    timelineDuration(montage), () => {}).done
  assert.match(spawnSync(ffmpeg, ['-hide_banner', '-i', montageAudio], { encoding: 'utf8' }).stderr, /Audio: pcm_f32le/)
  console.log('PASS: reordered audio track exports to WAV')
} finally {
  await rm(directory, { recursive: true, force: true })
}
