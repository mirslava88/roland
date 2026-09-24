import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const {
  directStreamDeckChannelLabel,
  directStreamDeckSpeakerLabel,
  executeDirectStreamDeckAction
} = await moduleFrom('src/renderer/src/components/StreamDeck/direct-stream-deck-logic.ts')
const {
  createDefaultDirectStreamDeckConfig,
  escapeDirectStreamDeckXml,
  normalizeDirectStreamDeckColor,
  normalizeDirectStreamDeckConfig,
  normalizeDirectStreamDeckKeyStates,
  splitDirectStreamDeckLabel
} = await moduleFrom('src/shared/direct-stream-deck.ts')
const { DEFAULT_QR_OVERLAY } = await moduleFrom('src/shared/qr-overlay.ts')

function harness(patch = {}) {
  const events = []
  const presentation = []
  const timer = []
  const music = []
  const selected = []
  const playback = []
  const qrPatches = []
  const published = []
  const state = {
    channels: {
      '1': { file: { type: 'presentation', path: 'one.pptx' } },
      '2': { file: { type: 'video', path: 'clip.mp4' } },
      '3': { file: null }
    },
    liveChannel: null,
    activeFile: null,
    qrOverlay: { ...DEFAULT_QR_OVERLAY },
    programSnapshot: null,
    timerRunning: false,
    setSelectedChannel: (id) => selected.push(id),
    setIsPlaying: (playing) => playback.push(['playing', playing]),
    setVideoPlayback: (path, value) => playback.push(['video', path, value]),
    setQrOverlay: (value) => { qrPatches.push(value); Object.assign(state.qrOverlay, value) },
    publishProgramSnapshot: (_channel, value) => published.push(value),
    ...patch
  }
  const environment = {
    getState: () => state,
    dispatch: (type, detail) => events.push([type, detail]),
    sendToPresentation: (type, detail) => presentation.push([type, detail]),
    sendTimerCommand: (command) => timer.push(command),
    musicGetState: async () => ({ playing: state.musicPlaying === true }),
    musicPlay: async () => { music.push('play') },
    musicPause: async () => { music.push('pause') },
    musicStop: async () => { music.push('stop') },
    musicPrevious: async () => { music.push('previous') },
    musicNext: async () => { music.push('next') },
    log: () => undefined
  }
  return { state, environment, events, presentation, timer, music, selected, playback, qrPatches, published }
}

assert.equal(directStreamDeckChannelLabel(0, 'Доклад', 'ignored.pptx'), '1 Доклад')
assert.equal(directStreamDeckChannelLabel(1, '', 'deck.final.pptx'), '2 deck.final')
assert.equal(directStreamDeckSpeakerLabel('titles-speaker', 'Иванов Иван'), 'Иванов Иван')
assert.equal(directStreamDeckSpeakerLabel('titles-all', ' Иванов Иван '), 'ТИТРЫ ВСЕ Иванов')

const defaults = createDefaultDirectStreamDeckConfig()
assert.equal(defaults.enabled, true, 'a fresh PDM profile must auto-connect an attached Stream Deck')
assert.equal(Object.keys(defaults.mappings).length, 32)
assert.deepEqual(defaults.mappings['0'], { kind: 'take-channel', channelId: '1' })
assert.equal(defaults.mappings['31'].kind, 'timer-reset')
const normalized = normalizeDirectStreamDeckConfig({
  enabled: true,
  serialNumber: '  serial  ',
  brightness: 999,
  mappings: {
    2: { kind: 'play-channel-video', channelId: 'x'.repeat(100) },
    5: { kind: 'titles-all', speakerId: 's'.repeat(100) },
    300: { kind: 'music-stop' },
    6: { kind: 'not-real' }
  }
})
assert.equal(normalized.enabled, true)
assert.equal(normalized.serialNumber, 'serial')
assert.equal(normalized.brightness, 100)
assert.equal(normalized.mappings['2'].channelId.length, 80)
assert.equal(normalized.mappings['5'].speakerId.length, 80)
assert.equal(normalized.mappings['300'], undefined)
assert.notEqual(normalized.mappings['6'].kind, 'not-real')
assert.equal(escapeDirectStreamDeckXml(`<key title="A&B">'`), '&lt;key title=&quot;A&amp;B&quot;&gt;&apos;')
assert.equal(normalizeDirectStreamDeckColor('#A0b1C2'), '#A0b1C2')
assert.equal(normalizeDirectStreamDeckColor('red'), '#17212b')
assert.deepEqual(splitDirectStreamDeckLabel('  ОЧЕНЬ   ДЛИННАЯ ПОДПИСЬ ДЛЯ КНОПКИ  '), [
  'ОЧЕНЬ', 'ДЛИННАЯ', 'ПОДПИСЬ…'
])
const safeKeys = normalizeDirectStreamDeckKeyStates([
  { index: -1, label: 'bad', color: '#ffffff' },
  { index: 1, label: 'x'.repeat(100), color: 'javascript:red', active: 1, disabled: true }
])
assert.equal(safeKeys.length, 1)
assert.equal(safeKeys[0].label.length, 60)
assert.equal(safeKeys[0].color, '#17212b')
assert.equal(safeKeys[0].active, false)
assert.equal(safeKeys[0].disabled, true)

{
  const h = harness()
  await executeDirectStreamDeckAction({ kind: 'take-channel', channelId: '1' }, 0, h.environment)
  assert.deepEqual(h.selected, ['1'])
  assert.deepEqual(h.events, [['take-channel', '1']])
  await executeDirectStreamDeckAction({ kind: 'take-channel', channelId: '3' }, 1, h.environment)
  assert.equal(h.events.length, 1, 'empty channels must never be taken')
}
{
  const h = harness()
  await executeDirectStreamDeckAction({ kind: 'play-channel-video', channelId: '2' }, 2, h.environment)
  assert.deepEqual(h.events, [['take-channel-video', '2']])
  h.state.liveChannel = '2'
  h.state.activeFile = { path: 'clip.mp4' }
  h.events.length = 0
  await executeDirectStreamDeckAction({ kind: 'play-channel-video', channelId: '2' }, 2, h.environment)
  assert.deepEqual(h.events, [])
  assert.deepEqual(h.presentation, [['play-pause', true]])
  assert.deepEqual(h.playback, [['playing', true], ['video', 'clip.mp4', { playing: true }]])
}
{
  const h = harness()
  await executeDirectStreamDeckAction({ kind: 'next-slide' }, 3, h.environment)
  await executeDirectStreamDeckAction({ kind: 'scene-participant' }, 4, h.environment)
  await executeDirectStreamDeckAction({ kind: 'titles-all', speakerId: 'speaker-2' }, 5, h.environment)
  assert.deepEqual(h.events, [
    ['pdm-direct-navigation', 'next'],
    ['pdm-program-scene-view-mode', 'participant'],
    ['pdm-broadcast-titles-command', { kind: 'titles-all', speakerId: 'speaker-2' }]
  ])
}
{
  const h = harness()
  await executeDirectStreamDeckAction({ kind: 'qr-toggle' }, 6, h.environment)
  assert.deepEqual(h.events, [['open-program-scene', { editor: 'qr' }]])
  assert.deepEqual(h.qrPatches, [])
  h.state.qrOverlay.url = 'https://example.test'
  h.state.qrOverlay.sceneVisible = false
  h.state.programSnapshot = { revision: 1 }
  await executeDirectStreamDeckAction({ kind: 'qr-toggle' }, 6, h.environment)
  assert.deepEqual(h.qrPatches, [{ enabled: true, sceneVisible: true }])
  assert.equal(h.published[0].qrOverlay.enabled, true, 'live snapshot must receive the same QR state')
  assert.equal(h.published[0].qrOverlay.sceneVisible, true, 'Stream Deck must restore a QR hidden from the scene')
  await executeDirectStreamDeckAction({ kind: 'qr-toggle' }, 6, h.environment)
  assert.deepEqual(h.qrPatches[1], { enabled: false }, 'hiding QR must not remove it from the prepared scene')
  assert.equal(h.published[1].qrOverlay.enabled, false)
  assert.equal(h.published[1].qrOverlay.sceneVisible, true)
}
{
  const h = harness()
  await executeDirectStreamDeckAction({ kind: 'timer-start-pause' }, 7, h.environment)
  h.state.timerRunning = true
  await executeDirectStreamDeckAction({ kind: 'timer-start-pause' }, 7, h.environment)
  await executeDirectStreamDeckAction({ kind: 'timer-plus-5' }, 8, h.environment)
  assert.deepEqual(h.timer, [
    { type: 'start' },
    { type: 'pause' },
    { type: 'add-minutes', minutes: 5 }
  ])
}
{
  const h = harness({ musicPlaying: false })
  await executeDirectStreamDeckAction({ kind: 'music-play-pause' }, 9, h.environment)
  h.state.musicPlaying = true
  await executeDirectStreamDeckAction({ kind: 'music-play-pause' }, 9, h.environment)
  await executeDirectStreamDeckAction({ kind: 'music-stop' }, 10, h.environment)
  assert.deepEqual(h.music, ['play', 'pause', 'stop'])
}

console.log('PASS: Stream Deck config, labels, channel/video TAKE, scene, titles, QR, timer and music commands')
