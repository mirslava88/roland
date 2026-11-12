import assert from 'node:assert/strict'
const {
  DEFAULT_SPEAKER_SLIDE_LAYOUT,
  normalizeSpeakerSlideLayout,
  resizeSpeakerSlide,
  scaleSpeakerCaptions,
  selectSpeakerCaptions,
  sameSpeakerSlideLayout,
  speakerCaptionPlacement,
  speakerSlideRect
} = await import('../src/shared/speaker-layout.ts')

const initial = normalizeSpeakerSlideLayout(DEFAULT_SPEAKER_SLIDE_LAYOUT)
assert.deepEqual(initial, DEFAULT_SPEAKER_SLIDE_LAYOUT)

const expanded = resizeSpeakerSlide(initial, 'current', 8, -20)
assert.equal(expanded.currentWidth, 64, 'current slide must stop before the next slide')
assert.equal(expanded.currentHeight, 80)
assert.equal(expanded.nextWidth, initial.nextWidth, 'resizing the current slide must preserve the next one')

const largerNext = resizeSpeakerSlide(initial, 'next', -12, 10)
assert.equal(largerNext.nextWidth, 32, 'next slide must stop before the current slide')
assert.equal(largerNext.nextHeight, 86)
assert.equal(largerNext.currentWidth, initial.currentWidth)

for (const isPdf of [false, true]) {
  const current = speakerSlideRect(largerNext, 'current', isPdf)
  const next = speakerSlideRect(largerNext, 'next', isPdf)
  assert.ok(current.left + current.width <= next.left, 'slides must not overlap')
  assert.ok(current.top + current.height <= (isPdf ? 98 : 78), 'slide must stay clear of the notes area')
  assert.ok(next.top + next.height <= (isPdf ? 98 : 78))
}

const noNotes = normalizeSpeakerSlideLayout({ ...initial, showNotes: false })
assert.equal(speakerSlideRect(noNotes, 'current', false).height, 96)
assert.equal(speakerSlideRect(initial, 'current', false).height, 76)
assert.equal(sameSpeakerSlideLayout(noNotes, initial), false)
assert.equal(sameSpeakerSlideLayout(normalizeSpeakerSlideLayout(initial), initial), true)
assert.equal(sameSpeakerSlideLayout({ ...initial, showBackdrop: false }, initial), false)
assert.equal(sameSpeakerSlideLayout({ ...initial, showTitle: false }, initial), false)
assert.equal(normalizeSpeakerSlideLayout({ ...initial, showTitle: false }).showTitle, false)
assert.deepEqual(speakerCaptionPlacement(initial, 'current', false), { x: 2.45, y: 2.7, scale: 1 })
assert.deepEqual(speakerCaptionPlacement(initial, 'next', false), { x: 68.45, y: 2.7, scale: 1 })
assert.deepEqual(speakerCaptionPlacement(initial, 'title', false), { x: 68, y: 60.76, scale: 1 })
const movedCaption = normalizeSpeakerSlideLayout({
  ...initial,
  captions: { ...initial.captions, next: { x: 42, y: 12, scale: 1.5 } }
})
assert.deepEqual(speakerCaptionPlacement(movedCaption, 'next', false), { x: 42, y: 12, scale: 1.5 })
assert.equal(sameSpeakerSlideLayout(movedCaption, initial), false)
assert.equal(sameSpeakerSlideLayout(normalizeSpeakerSlideLayout(movedCaption), movedCaption), true)
const differentScales = normalizeSpeakerSlideLayout({
  ...initial,
  captions: {
    current: { x: 30, y: 20, scale: 1.8 },
    next: { x: 90, y: 20, scale: 1.6 },
    title: null
  }
})
const equalized = scaleSpeakerCaptions(differentScales, [
  { caption: 'current', widthAtScaleOne: 12, heightAtScaleOne: 3 },
  { caption: 'next', widthAtScaleOne: 12, heightAtScaleOne: 3 }
], 190, false)
assert.equal(equalized.captions.current.scale, 1.9)
assert.equal(equalized.captions.next.scale, 1.9)
assert.equal(equalized.captions.next.x, 77.2, 'the second caption must remain on screen after group scaling')
assert.equal(differentScales.captions.next.scale, 1.6, 'scaling must leave the saved layout untouched')
assert.deepEqual(selectSpeakerCaptions(['current'], 'title', true), ['current', 'title'])
assert.deepEqual(selectSpeakerCaptions(['current', 'title'], 'next', true), ['current', 'title', 'next'])
assert.deepEqual(selectSpeakerCaptions(['current', 'title', 'next'], 'title', true), ['current', 'next'])
const scaledAll = scaleSpeakerCaptions(differentScales, [
  { caption: 'current', widthAtScaleOne: 12, heightAtScaleOne: 3 },
  { caption: 'next', widthAtScaleOne: 12, heightAtScaleOne: 3 },
  { caption: 'title', widthAtScaleOne: 30, heightAtScaleOne: 5 }
], 175, false)
assert.equal(scaledAll.captions.current.scale, 1.75)
assert.equal(scaledAll.captions.next.scale, 1.75)
assert.equal(scaledAll.captions.title.scale, 1.75)

const restored = normalizeSpeakerSlideLayout({
  currentWidth: Number.POSITIVE_INFINITY,
  currentHeight: -40,
  nextWidth: 900,
  nextHeight: Number.NaN
})
assert.deepEqual(restored, { currentWidth: 62, currentHeight: 30, nextWidth: 32, nextHeight: 76, showNotes: true, showBackdrop: true, showTitle: true, captions: { current: null, next: null, title: null } })
assert.deepEqual(normalizeSpeakerSlideLayout({ previousWidth: 22, previousHeight: 60 }), {
  currentWidth: 62, currentHeight: 100, nextWidth: 22, nextHeight: 60, showNotes: true, showBackdrop: true, showTitle: true,
  captions: { current: null, next: null, title: null }
}, 'the briefly used previous-slide layout must migrate to the corrected next slide')
console.log('Speaker slide layout: resizing, captions, bounds, and saved settings passed')
