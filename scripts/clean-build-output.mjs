import { rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const root = resolve(process.cwd())
const targets = ['out']

if (process.argv.includes('--package')) {
  targets.push(
    'dist/win-unpacked',
    'dist/mac',
    'dist/mac-arm64',
    'dist/linux-unpacked'
  )
}

for (const target of targets) {
  const absoluteTarget = resolve(root, target)
  if (!absoluteTarget.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to clean outside the project: ${absoluteTarget}`)
  }
  rmSync(absoluteTarget, { recursive: true, force: true })
}
