import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import { createRequire } from 'node:module'

const { editionInfo } = createRequire(import.meta.url)('./build/editions.cjs')
const edition = editionInfo()
const define = {
  __PDM_STREAM_ENABLED__: JSON.stringify(edition.stream),
  __PDM_DISPLAY_VERSION__: JSON.stringify(edition.displayVersion),
  __PDM_PRODUCT_NAME__: JSON.stringify(edition.productName)
}
const output = (part: string): string => resolve(__dirname, process.env.PDM_EDITION_BUILD === '1' ? `out/${edition.edition}/${part}` : `out/${part}`)

export default defineConfig({
  main: {
    define,
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: output('main'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    define,
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: output('preload'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          ...(edition.stream ? { streaming: resolve(__dirname, 'src/preload/streaming.ts') } : {})
        }
      }
    }
  },
  renderer: {
    define,
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: output('renderer'),
      rollupOptions: {
        input: {
          control: resolve(__dirname, 'src/renderer/index.html'),
          presentation: resolve(__dirname, 'src/renderer/presentation.html'),
          auxiliary: resolve(__dirname, 'src/renderer/auxiliary.html'),
          ...(edition.stream ? { streaming: resolve(__dirname, 'src/renderer/streaming.html') } : {})
        }
      }
    },
    plugins: [react()],
    css: {
      postcss: {
        plugins: [tailwindcss]
      }
    }
  }
})
