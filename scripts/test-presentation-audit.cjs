const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir } = require('node:os')
const Module = require('node:module')
const { transformSync } = require('esbuild')

const entry = resolve('src/main/presentation-audit.ts')
const code = transformSync(readFileSync(entry, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
const loaded = new Module(entry, module)
loaded.filename = entry
loaded.paths = Module._nodeModulePaths(resolve('.'))
loaded._compile(code, entry)

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function storedZip(parts) {
  const local = []
  const directory = []
  let offset = 0
  for (const [name, content] of parts) {
    const path = Buffer.from(name)
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)
    local.push(head, path, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(path.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, path)
    offset += head.length + path.length + data.length
  }
  const centralBytes = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(parts.length, 8)
  end.writeUInt16LE(parts.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

function syntheticDeck() {
  const ns = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const rels = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
  return storedZip([
    ['ppt/presentation.xml', `<p:presentation ${ns}><p:sldIdLst><p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', `<Relationships ${rels}><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="x/slide" Target="slides/slide2.xml"/></Relationships>`],
    ['ppt/slides/slide2.xml', `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:rPr><a:latin typeface="PDM-Missing-Font-For-Test"/></a:rPr><a:t>Test</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:timing><p:animEffect/></p:timing></p:sld>`],
    ['ppt/slides/_rels/slide2.xml.rels', `<Relationships ${rels}><Relationship Id="rV" Type="x/video" Target="../media/clip.mp4"/><Relationship Id="rM" Type="x/media" Target="../media/clip.mp4"/><Relationship Id="rA" Type="x/audio" Target="../media/sound.mp3"/></Relationships>`],
    ['ppt/slides/slide1.xml', `<p:sld ${ns}><p:cSld/></p:sld>`],
    ['ppt/slides/_rels/slide1.xml.rels', `<Relationships ${rels}><Relationship Id="rLink" Type="x/video" Target="https://example.invalid/video.mp4" TargetMode="External"/></Relationships>`],
    ['ppt/media/clip.mp4', Buffer.from([1])],
    ['ppt/media/sound.mp3', Buffer.from([2])]
  ])
}

async function main() {
  await assert.rejects(loaded.exports.auditPresentation('example.pdf'), /PPTX/)
  const directory = mkdtempSync(join(tmpdir(), 'pdm-pptx-audit-'))
  const synthetic = join(directory, 'synthetic.pptx')
  try {
    writeFileSync(synthetic, syntheticDeck())
    const report = await loaded.exports.auditPresentation(synthetic)
    assert.equal(report.slideCount, 2)
    assert.deepEqual(report.slides.map(slide => slide.number), [1, 2], 'Presentation order, not slide file name')
    assert.deepEqual([report.slides[0].videos, report.slides[0].audio, report.slides[0].animations], [1, 1, true])
    assert.equal(report.slides[1].linkedMedia, 1)
    if (report.fontsChecked) assert.deepEqual(report.slides[0].missingFonts, ['PDM-Missing-Font-For-Test'])
  } finally {
    unlinkSync(synthetic)
    rmdirSync(directory)
  }
  console.log('PASS: PPTX audit scans an embedded-media fixture without opening PowerPoint')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
