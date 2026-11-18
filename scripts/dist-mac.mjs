import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('DMG packaging and code signing require macOS on an Apple Silicon host.')
  process.exit(1)
}
const require = createRequire(import.meta.url)
const args = ['--mac', '--arm64', '--publish', 'never']
if (process.env.PULSE_MAC_SIGN !== '1') args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false', '-c.mac.notarize=false')
else args.push('-c.forceCodeSigning=true')
const result = spawnSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), ...args], { stdio: 'inherit' })
process.exit(result.status ?? 1)
