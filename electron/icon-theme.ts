export function centerIconBasename(
  platform: NodeJS.Platform,
  shouldUseDarkColors: boolean
): 'gbc' | 'gbc-white' | 'gbcTemplate' {
  if (platform === 'darwin') return 'gbcTemplate'
  return shouldUseDarkColors ? 'gbc-white' : 'gbc'
}

/** Packaged Windows taskbar uses the exe/shortcut ICO unless we point AppUserModel at this file. */
export function centerWindowsIconFile(): 'gbc-app.ico' {
  return 'gbc-app.ico'
}
