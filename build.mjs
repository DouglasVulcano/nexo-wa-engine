import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

// Standalone bundle: Baileys and every dependency inlined into one ESM file, so the
// app can fork it from any path (app resources or a downloaded copy) with no
// node_modules next to it. Optional/native extras Baileys can lazy-load stay
// external and are never installed (no thumbnails, no link previews).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(readFileSync('src/protocol.ts', 'utf8'))?.[1])

mkdirSync('dist', { recursive: true })
await build({
  entryPoints: ['src/entry.ts'],
  outfile: 'dist/wa-baileys.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  legalComments: 'linked',
  external: ['sharp', 'jimp', 'link-preview-js', 'audio-decode', 'bufferutil', 'utf-8-validate', 'pino-pretty'],
  define: { __ENGINE_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  logLevel: 'info'
})

writeFileSync(
  'dist/manifest.json',
  JSON.stringify(
    { engine: 'wa-baileys', version: pkg.version, protocol, baileys: pkg.dependencies.baileys, entry: 'wa-baileys.mjs' },
    null,
    2
  )
)
