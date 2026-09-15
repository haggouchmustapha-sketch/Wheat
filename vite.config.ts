import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

/**
 * Which edition this build produces.
 *
 * Read once, here, and compiled into the main process, the preload and the
 * renderer as `__WHEAT_EDITION__`. A packaged Wheat therefore states its own
 * edition from its own bytes: no environment variable on a user's machine can
 * change what an installed build believes it is, which is the same rule the
 * update source and the renderer location already follow.
 *
 * `npm run build:standard` / `build:lightweight` set this; a bare `npm run
 * build` produces Standard, which is what Wheat has always been.
 */
const WHEAT_EDITIONS = ['standard', 'lightweight'] as const
const requestedEdition = (process.env.WHEAT_EDITION ?? 'standard').trim().toLowerCase()
if (!(WHEAT_EDITIONS as readonly string[]).includes(requestedEdition)) {
  throw new Error(
    `WHEAT_EDITION="${process.env.WHEAT_EDITION}" is not a Wheat edition. Valid editions are ${WHEAT_EDITIONS.join(', ')}.`,
  )
}
const editionDefine = { __WHEAT_EDITION__: JSON.stringify(requestedEdition) }

/**
 * Records the edition beside the build output.
 *
 * The compiled constant above is what the *application* obeys. This file is how
 * everything outside the application — the packaging step, the packaging tests,
 * a support request asking what is actually installed — can read the edition of
 * a build without parsing a bundle. It ships inside `dist-electron/`, which is
 * already packaged, so an installed Wheat carries the record too.
 */
function writeEditionStamp(): import('vite').Plugin {
  return {
    name: 'wheat-edition-stamp',
    apply: 'build',
    closeBundle() {
      const stamp = `${JSON.stringify({ edition: requestedEdition, builtAt: new Date().toISOString() }, null, 2)}\n`
      for (const directory of ['dist', 'dist-electron']) {
        const target = path.resolve(import.meta.dirname, directory)
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, 'wheat-edition.json'), stamp, 'utf8')
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: editionDefine,
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    writeEditionStamp(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          define: editionDefine,
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['@prisma/client', 'pdf-parse', 'sharp', 'tesseract.js'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          define: editionDefine,
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: '[name].cjs',
                chunkFileNames: '[name].cjs',
              },
            },
          },
        },
      },
    }),
  ],
})
