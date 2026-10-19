import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { editionInfo } = createRequire(import.meta.url)('../build/editions.cjs')

export function macReleasePlan(refType, refName, requested = 'all') {
  if (refType === 'tag') {
    const edition = refName.endsWith('-stream') ? 'stream' : 'standard'
    const expected = `macos-v${editionInfo(edition).version}`
    if (refName !== expected) throw new Error(`Expected Mac tag ${expected}`)
    return { editions: [edition], tag: expected }
  }
  if (!['all', 'standard', 'stream'].includes(requested)) throw new Error('Invalid Mac edition')
  return { editions: requested === 'all' ? ['standard', 'stream'] : [requested], tag: null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const plan = macReleasePlan(process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME || '', process.env.REQUESTED_EDITION || 'all')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `editions=${JSON.stringify(plan.editions)}\n`)
  console.log(JSON.stringify(plan))
}
