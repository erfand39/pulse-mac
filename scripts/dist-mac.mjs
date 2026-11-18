import builder from 'electron-builder'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('DMG packaging and code signing require macOS on an Apple Silicon host.')
  process.exit(1)
}

const { Arch, Platform, build } = builder
const config = process.env.PULSE_MAC_SIGN === '1'
  ? { forceCodeSigning: true }
  : { mac: { identity: '-', hardenedRuntime: false, notarize: false } }
await build({
  targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
  publish: 'never',
  config
})
