const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')

const source = readFileSync('src/main/windows.ts', 'utf8')
const match = source.match(/export function createMusicPlayerWindow[\s\S]*?<script>([\s\S]*?)<\/script>/)
assert.ok(match, 'Hidden music player script must exist')

function fakePlayer() {
  const listeners = new Map()
  return {
    src: '', paused: true, currentTime: 0, duration: 30, volume: 1, loop: false,
    addEventListener(name, handler) { listeners.set(name, handler) },
    play() { this.paused = false; listeners.get('play')?.(); return Promise.resolve() },
    pause() { this.paused = true; listeners.get('pause')?.() },
    removeAttribute(name) { if (name === 'src') this.src = '' },
    load() {},
    fire(name) { listeners.get(name)?.() }
  }
}
const player = fakePlayer()
const channelPlayer = fakePlayer()
const window = {}
vm.runInNewContext(match[1], { window, document: { getElementById: (id) => id === 'channel-player' ? channelPlayer : player }, location: { href: 'test:' }, encodeURIComponent, Number, Math })
const ended = () => player.fire('ended')

window._setPlaylist(['first.mp3', 'second.mp3', 'third.mp3'], 0, true)
window._setNextActions({ 'first.mp3': { kind: 'music', path: 'third.mp3' } })
ended()
assert.equal(window._getState().currentIndex, 2, 'Explicit next track overrides playlist order')
assert.equal(window._getState().playing, true)
assert.equal(window._getState().loadedPath, 'third.mp3')

player.currentTime = 12
const sourceBefore = player.src
window._reorderPlaylist(['third.mp3', 'first.mp3', 'second.mp3'])
assert.equal(window._getState().currentIndex, 0, 'Reorder preserves the playing track')
assert.equal(player.src, sourceBefore, 'Reorder must not reload audio')
assert.equal(player.currentTime, 12, 'Reorder must not seek audio')

window._setLoopTrack(true)
window._setStopAfterTrack(true)
assert.equal(window._getState().loopTrack, false)
assert.equal(window._getState().loopPlaylist, false)
ended()
assert.equal(window._getState().playing, false, 'One-track mode stops instead of advancing')
assert.equal(player.src, '')
assert.equal(window._getState().loadedPath, null)

window._setStopAfterTrack(false)
window._setPlaylist(['first.mp3', 'second.mp3'], 0, true)
window._setNextActions({ 'first.mp3': { kind: 'channel', channelId: 'channel-1' } })
ended()
const state = window._getState()
assert.equal(state.playing, false)
assert.equal(state.pendingChannel, 'channel-1')
assert.equal(window._consumeChannelTransition(state.transitionSerial), 'channel-1')
assert.equal(window._consumeChannelTransition(state.transitionSerial), null, 'Transition is consumed once')

window._setPlaylist(['first.mp3', 'second.mp3'], 0, true)
window._setNextActions({ 'first.mp3': { kind: 'stop' } })
ended()
assert.equal(window._getState().playing, false, 'Per-track stop overrides playlist loop')
window._setPlaylist(['first.mp3'], 0, true)
window._setPlaylist([], 0, false)
assert.equal(window._getState().playing, false, 'Selecting an empty folder stops the previous track')
assert.equal(window._getState().loadedPath, null)
window._setPlaylist(['first.mp3', 'second.mp3'], 1, true)
window._setLoopTrack(true)
const beforeChannel = window._getState()
const session = window._channelLoadAndPlay('channel-song.mp3')
assert.equal(player.paused, true)
assert.equal(window._getState().currentIndex, beforeChannel.currentIndex)
assert.equal(window._getState().loopTrack, beforeChannel.loopTrack)
assert.equal(window._getState().playlistLength, beforeChannel.playlistLength)
channelPlayer.fire('ended')
assert.equal(window._channelGetState().endedSession, session)
window._channelSetLoop(true)
assert.equal(window._channelGetState().endedSession, 0)
window._channelStop()
assert.equal(window._channelGetState().path, 'channel-song.mp3')
window._channelUnload()
assert.equal(window._channelGetState().path, null)
assert.equal(window._getState().playlistLength, 2)
console.log('PASS: hidden music player stop, next track, reorder and one-shot channel transition')
