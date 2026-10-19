import assert from 'node:assert/strict'
import { fittedSlidePixels, planPresentationCapture, hasNativeSlideResolution } from '../src/shared/presentation-output.ts'

const display = (id, width, height, scaleFactor = 1, workHeight = height) => ({ id,
  bounds: { x: id === 1 ? 0 : -width, y: 0, width, height },
  workArea: { x: id === 1 ? 0 : -width, y: 25, width, height: workHeight }, scaleFactor, displayFrequency: 60 })
const laptop = display(1, 1440, 900, 2, 818)
const hd = display(2, 1920, 1080, 1, 1055)
const uhd = display(3, 3840, 2160, 1, 2135)
const retina4k = display(4, 2304, 1440, 2, 1358)
retina4k.bounds.x = 1440
retina4k.workArea.x = 1440

assert.deepEqual(fittedSlidePixels({ width: 3440, height: 1440 }, 16 / 9), { width: 2560, height: 1440 })
assert.deepEqual(fittedSlidePixels({ width: 7680, height: 4320 }, 16 / 9), { width: 7680, height: 4320 })
assert.deepEqual(fittedSlidePixels({ width: 3840, height: 2160 }, 4 / 3), { width: 2880, height: 2160 })
assert.deepEqual(fittedSlidePixels({ width: 2160, height: 3840 }, 16 / 9), { width: 2160, height: 1215 })
assert.throws(() => fittedSlidePixels({ width: 0, height: 1080 }, 16 / 9))

const hdPlan = planPresentationCapture(hd, [laptop, hd], 16 / 9)
assert.equal(hdPlan.host.id, laptop.id)
assert.equal(hdPlan.windowWidth, 960)
assert.equal(hdPlan.windowHeight, 540)
assert.equal(hdPlan.parkedX, 1439, 'parking depends on the host desktop, not the smaller capture window')
assert.equal(hdPlan.parkedY, laptop.workArea.y, 'the full source height must remain aligned with its rendering display')
assert.deepEqual(hdPlan.profile, { width: 1920, height: 1080, displayId: 2, frameRate: 60 })

const uhdPlan = planPresentationCapture(uhd, [laptop, uhd, retina4k], 16 / 9)
assert.equal(uhdPlan.host.id, retina4k.id, 'choose a host with enough real backing pixels')
assert.equal(uhdPlan.windowWidth, 1920)
assert.equal(uhdPlan.windowHeight, 1080)
assert.deepEqual(planPresentationCapture(display(5, 1920, 1080, 2), [retina4k], 16 / 9).profile,
  { width: 3840, height: 2160, displayId: 5, frameRate: 60 }, 'account for output Retina scaling')

// Do not call an undersized capture native just because its requested profile
// says 4K. A host limited by macOS must remain detectable by the live receiver.
assert.equal(planPresentationCapture(uhd, [laptop, uhd], 16 / 9).host.id, uhd.id)
const parkedLeft = planPresentationCapture(uhd, [laptop, uhd], 16 / 9)
assert.equal(parkedLeft.parkedX + parkedLeft.windowWidth, uhd.bounds.x + 1,
  'a source on the left display must extend outward, never across the operator desktop')
assert.equal(hasNativeSlideResolution({ width: 3796, height: 2135 }, uhdPlan.profile), false)
assert.equal(hasNativeSlideResolution({ width: 2880, height: 1620 }, uhdPlan.profile), false)
assert.equal(hasNativeSlideResolution({ width: 3840, height: 2160 }, uhdPlan.profile), true)
assert.equal(hasNativeSlideResolution({ width: 3838, height: 2160 }, uhdPlan.profile), true)
assert.equal(hasNativeSlideResolution({ width: 3830, height: 2160 }, uhdPlan.profile), false)
console.log('Presentation output: Retina, ultrawide, portrait, 4K/8K and actual-source checks passed')
