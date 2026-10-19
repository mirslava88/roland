// Loopback only: transport integrity, certificate/hostname validation and cleanup.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:tls'
import { connect } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const directory = process.env.PDM_TLS_TEST_CHILD
if (!directory) {
  const root = mkdtempSync(join(tmpdir(), 'pdm-tls-test-'))
  try {
    writeFileSync(join(root, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-config', join(root, 'openssl.cnf'), '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'pipe' })
    for (const trusted of [false, true]) {
      const env = { ...process.env, PDM_TLS_TEST_CHILD: root, PDM_TLS_TEST_TRUSTED: String(trusted) }
      if (trusted) env.NODE_EXTRA_CA_CERTS = join(root, 'cert.pem')
      else delete env.NODE_EXTRA_CA_CERTS
      const child = spawn(process.execPath, [process.argv[1]], { env, stdio: 'inherit' })
      const [code] = await once(child, 'exit')
      assert.equal(code, 0, 'TLS transport test process failed')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
} else {
  const compiled = await build({ entryPoints: ['src/main/stream-tls-relay.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const { StreamTlsRelay, streamTlsErrorMessage } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
  assert.match(streamTlsErrorMessage('ERR_TLS_CERT_ALTNAME_INVALID'), /сертификат/)
  const server = createServer({ cert: readFileSync(join(directory, 'cert.pem')), key: readFileSync(join(directory, 'key.pem')) }, socket => socket.pipe(socket))
  server.on('tlsClientError', () => {})
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const relays = [], clients = []
  const limit = setTimeout(() => { console.error('TLS regression timed out'); process.exit(1) }, 15_000)
  try {
    const errors = []
    const relay = new StreamTlsRelay(error => errors.push(error)); relays.push(relay)
    const transport = await relay.open(`rtmps://localhost:${port}/live/PRIVATE_TEST_KEY`)
    assert.equal(new URL(transport.url).hostname, '127.0.0.1')
    assert.equal(transport.tcUrl, `rtmps://localhost:${port}/live`)
    const local = connect({ host: '127.0.0.1', port: Number(new URL(transport.url).port) }); clients.push(local)
    local.on('error', () => {})
    const closed = once(local, 'close')
    if (process.env.PDM_TLS_TEST_TRUSTED === 'true') {
      const payload = Buffer.alloc(1024 * 1024, 0x6d), received = []
      let length = 0
      local.on('data', chunk => { received.push(chunk); length += chunk.length })
      await once(local, 'connect')
      local.write(payload)
      for (let i = 0; i < 100 && length < payload.length; i++) await delay(30)
      assert.deepEqual(Buffer.concat(received), payload, 'TLS relay must preserve every media byte')
      assert.deepEqual(errors, [])
      relay.close(); await closed

      // The CA is trusted but the certificate covers localhost, not this IP.
      const mismatch = []
      const wrongHost = new StreamTlsRelay(error => mismatch.push(error)); relays.push(wrongHost)
      const wrong = await wrongHost.open(`rtmps://127.0.0.1:${port}/live/PRIVATE_TEST_KEY`)
      const rejected = connect({ host: '127.0.0.1', port: Number(new URL(wrong.url).port) }); clients.push(rejected)
      rejected.on('error', () => {})
      await once(rejected, 'close')
      assert.equal(mismatch.length, 1)
      assert.match(mismatch[0], /сертификат/)
      assert.ok(!mismatch[0].includes('PRIVATE_TEST_KEY'))
      console.log('PASS: verified TLS, byte-preserving forwarding, hostname rejection and socket cleanup')
    } else {
      await closed
      assert.equal(errors.length, 1)
      assert.match(errors[0], /сертификат/)
      assert.ok(!errors[0].includes('PRIVATE_TEST_KEY'))
      console.log('PASS: untrusted certificate rejected; no stream credentials in errors')
    }
  } finally {
    clearTimeout(limit)
    for (const relay of relays) relay.close()
    for (const client of clients) client.destroy()
    server.close()
  }
}
