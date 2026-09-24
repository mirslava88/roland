import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// The root tsconfig contains references only. Check both actual projects;
// electron-vite transpilation alone does not validate their types.
for (const project of ['tsconfig.node.json', 'tsconfig.web.json']) {
  console.log(`TypeScript: ${project}`)
  const result = spawnSync(process.execPath, [
    resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false', '-p', project
  ], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
