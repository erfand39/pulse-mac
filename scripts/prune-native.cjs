const { join, basename } = require('node:path')
const { promises: fs } = require('node:fs')

module.exports = async ({ appOutDir, packager }) => {
  const root = join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents/Resources/app.asar.unpacked/node_modules')
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory() || basename(entry.parentPath) !== 'prebuilds' || entry.name === 'darwin-arm64') continue
    await fs.rm(join(entry.parentPath, entry.name), { recursive: true, force: true })
  }
}
