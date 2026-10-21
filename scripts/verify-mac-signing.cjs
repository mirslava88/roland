const assert = require('node:assert/strict')
const { openSync, readSync, closeSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

function signatureInfo(output, file) {
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(output)?.[1]
  assert.ok(team && !/^Signature=adhoc$/m.test(output),
    `Mac release requires a certificate with a Team ID: ${file}. Ad-hoc signing is incompatible with enabled library validation.`)
  assert.match(output, /^CodeDirectory .*flags=.*\bruntime\b/m, `Hardened runtime is missing: ${file}`)
  return { team }
}

function sameSigningTeam(root, child, file) {
  assert.equal(child.team, root.team, `Signing Team ID differs from the application: ${file}`)
}

function verifyMacSigning(app) {
  function inspect(file) {
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, `Cannot inspect signature: ${file}\n${result.stderr}`)
    return signatureInfo(result.stderr, file)
  }
  const root = inspect(app)
  let binaries = 0
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(file); continue }
      if (!entry.isFile()) continue
      const header = Buffer.alloc(4), fd = openSync(file, 'r')
      try { readSync(fd, header, 0, 4, 0) } finally { closeSync(fd) }
      if (!['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) continue
      sameSigningTeam(root, inspect(file), file)
      binaries++
    }
  }
  walk(join(app, 'Contents'))
  assert.ok(binaries > 1, 'No nested Mach-O code found')
  const result = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  assert.equal(result.status, 0, `Invalid Mac bundle signature: ${result.stderr}`)
  return { team: root.team, binaries, signatureVerified: true }
}

module.exports = { signatureInfo, sameSigningTeam, verifyMacSigning }
