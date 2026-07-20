import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const frontendRoot = resolve(__dirname, '..')
const tauriDir = resolve(frontendRoot, 'src-tauri')
const iconsDir = resolve(tauriDir, 'icons')
const icoPath = resolve(iconsDir, 'icon.ico')
const svgPath = resolve(tauriDir, 'app-icon.svg')

if (existsSync(icoPath)) {
  process.stdout.write(`[ensure-tauri-icons] OK: ${icoPath}\n`)
  process.exit(0)
}

process.stdout.write(`[ensure-tauri-icons] icon missing, generating into ${iconsDir}\n`)

// Use tauri CLI via npm exec (works with local @tauri-apps/cli)
const r = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['exec', 'tauri', '--', 'icon', svgPath, '--output', iconsDir],
  {
    cwd: frontendRoot,
    stdio: 'inherit',
    env: process.env,
  },
)

if (r.status !== 0) process.exit(r.status ?? 1)

if (!existsSync(icoPath)) {
  process.stderr.write(
    `[ensure-tauri-icons] ERROR: expected ${icoPath} to be generated, but it was not found.\n`,
  )
  process.exit(1)
}

process.stdout.write(`[ensure-tauri-icons] Generated: ${icoPath}\n`)










