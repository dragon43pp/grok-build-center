const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const REQUIRED_TRAY_ASSETS = [
  'gbc-16.png',
  'gbc-32.png',
  'gbc-256.png',
  'gbc-white-16.png',
  'gbc-white-32.png',
  'gbc-white-256.png',
  'gbcTemplate-16.png',
  'gbcTemplate-32.png',
  'gbc.ico',
  'gbc-white.ico',
  'gbc-app-16.png',
  'gbc-app-32.png',
  'gbc-app.ico'
]

function packagedResourcesDir(context) {
  if (context.electronPlatformName !== 'darwin') {
    return join(context.appOutDir, 'resources')
  }
  const appBundle = readdirSync(context.appOutDir).find((name) =>
    name.endsWith('.app')
  )
  if (!appBundle) throw new Error('Packaged macOS app bundle was not found')
  return join(context.appOutDir, appBundle, 'Contents', 'Resources')
}

exports.default = async function assertPackagedTrayAssets(context) {
  const trayDir = join(packagedResourcesDir(context), 'tray')
  const missing = REQUIRED_TRAY_ASSETS.filter(
    (filename) => !existsSync(join(trayDir, filename))
  )
  if (missing.length > 0) {
    throw new Error(`Packaged tray assets are missing: ${missing.join(', ')}`)
  }
}
