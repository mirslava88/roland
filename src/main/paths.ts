import { app } from 'electron'
import { join } from 'path'

export function scriptPath(name: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'scripts', name)
  }
  return join(__dirname, '../../scripts', name)
}
