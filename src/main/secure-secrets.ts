import { app, safeStorage } from 'electron'
import { readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'

const SECRET_FILE = 'qr-wifi-password.enc'
let secretWriteTail: Promise<unknown> = Promise.resolve()

function secretPath(): string {
  return join(app.getPath('userData'), SECRET_FILE)
}

export async function loadQrWifiPassword(): Promise<string> {
  await secretWriteTail
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(await readFile(secretPath())).slice(0, 256)
  } catch {
    return ''
  }
}

export function saveQrWifiPassword(value: unknown): Promise<boolean> {
  const password = typeof value === 'string' ? value.slice(0, 256) : ''
  const operation = secretWriteTail.then(() => writeQrWifiPassword(password))
  secretWriteTail = operation.catch(() => undefined)
  return operation
}

async function writeQrWifiPassword(password: string): Promise<boolean> {
  const target = secretPath()
  if (!password) {
    await rm(target, { force: true }).catch(() => undefined)
    return true
  }
  if (!safeStorage.isEncryptionAvailable()) return false
  const temporary = `${target}.tmp`
  try {
    await writeFile(temporary, safeStorage.encryptString(password))
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return true
}
