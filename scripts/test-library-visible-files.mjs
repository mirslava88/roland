import assert from 'node:assert/strict'
import { visibleLibraryFiles } from '../src/renderer/src/library-visible-files.ts'

const files = [
  { name: '~$01 - Добро пожаловать в PowerPoint!.pptx', type: 'presentation' },
  { name: '~backup.pdf', type: 'pdf' },
  { name: '01 - Добро пожаловать в PowerPoint!.pptx', type: 'presentation' },
  { name: 'Обзор ~ 2026.pdf', type: 'pdf' }
]

assert.deepEqual(visibleLibraryFiles(files).map((file) => file.name), [
  '01 - Добро пожаловать в PowerPoint!.pptx',
  'Обзор ~ 2026.pdf'
])
assert.equal(files.length, 4, 'Filtering must not delete or mutate folder data')
console.log('PASS: tilde-prefixed Office files are hidden without affecting real media')
