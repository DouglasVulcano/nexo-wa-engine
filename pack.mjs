import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Release asset: dist/wa-baileys-<version>.tgz with the bundle, its manifest and the
// license texts at the archive root. Deterministic (fixed mtime/owner, sorted entries,
// no gzip timestamp) so the same sources give the same SHA-256. Run `npm run build`
// first (the `pack` script does). Prints size and SHA-256 for src/shared/wa-engine.ts.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Third-party notices: name, version, license and license text of every production
// dependency that ends up inlined in the bundle (MIT/BSD/ISC require the notice).
function thirdPartyNotices() {
  let listing
  try {
    listing = execSync('npm ls --omit=dev --all --parseable', { encoding: 'utf8', shell: true })
  } catch (e) {
    listing = e.stdout ?? '' // exits 1 for the optional peers that are deliberately not installed
  }
  const dirs = listing
    .split(/\r?\n/)
    .filter((d) => d && existsSync(join(d, 'package.json')) && d.includes('node_modules'))
  const seen = new Set()
  const parts = ['Third-party components bundled in wa-baileys.mjs\n']
  for (const dir of dirs) {
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const id = `${p.name}@${p.version}`
    if (seen.has(id)) continue
    seen.add(id)
    const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f))
    const text = file ? readFileSync(join(dir, file), 'utf8').trim() : '(no license file in the package)'
    const license = typeof p.license === 'string' ? p.license : JSON.stringify(p.license ?? 'unknown')
    parts.push(`\n==== ${id} (${license}) ====\n${text}\n`)
  }
  return parts.join('')
}
writeFileSync(new URL('./dist/THIRD_PARTY_LICENSES.txt', import.meta.url), thirdPartyNotices())

const FILES = [
  ['LICENSE', 'LICENSE'],
  ['README.md', 'README.md'],
  ['dist/THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_LICENSES.txt'],
  ['dist/manifest.json', 'manifest.json'],
  ['dist/wa-baileys.mjs', 'wa-baileys.mjs'],
  ['dist/wa-baileys.mjs.LEGAL.txt', 'wa-baileys.mjs.LEGAL.txt']
].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function header(name, size) {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write(octal(0o644, 8), 100, 'ascii')
  h.write(octal(0, 8), 108, 'ascii') // uid
  h.write(octal(0, 8), 116, 'ascii') // gid
  h.write(octal(size, 12), 124, 'ascii')
  h.write(octal(0, 12), 136, 'ascii') // mtime
  h.write('        ', 148, 'ascii') // checksum placeholder (8 spaces)
  h.write('0', 156, 'ascii') // regular file
  h.write('ustar\0', 257, 'ascii')
  h.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of h) sum += byte
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return h
}

const blocks = []
for (const [src, name] of FILES) {
  const data = readFileSync(new URL(src, import.meta.url))
  if (name.length > 100) throw new Error(`name too long: ${name}`)
  blocks.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
}
blocks.push(Buffer.alloc(1024)) // end of archive

const tgz = gzipSync(Buffer.concat(blocks), { level: 9 })
const out = new URL(`./dist/wa-baileys-${pkg.version}.tgz`, import.meta.url)
writeFileSync(out, tgz)
console.log(`wrote dist/wa-baileys-${pkg.version}.tgz`)
console.log(`size   ${tgz.length}`)
console.log(`sha256 ${createHash('sha256').update(tgz).digest('hex')}`)
