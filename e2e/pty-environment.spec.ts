import { homedir } from 'node:os'
import { expect, test } from '@playwright/test'
import { ptyEnvironment, resolvePtyCwd } from '../electron/pty/PTYManager'

test.describe('PTY environment', () => {
  test('replaces a dumb terminal capability without changing renderer theme settings', () => {
    expect(
      ptyEnvironment({
        TERM: 'dumb',
        GBC_CODEX_HOOK_DROP: 'C:\\gbc\\drop'
      })
    ).toMatchObject({
      TERM: 'xterm-256color',
      GBC_CODEX_HOOK_DROP: 'C:\\gbc\\drop'
    })
  })

  test('preserves an explicit usable terminal capability', () => {
    expect(ptyEnvironment({ TERM: 'screen-256color' }).TERM).toBe(
      'screen-256color'
    )
  })

  test('starts ordinary terminals in the user home when no cwd is given', () => {
    expect(resolvePtyCwd({})).toBe(homedir())
    expect(resolvePtyCwd({ cwd: '   ' })).toBe(homedir())
    expect(resolvePtyCwd({ cwd: '', terminal: { cwd: '' } })).toBe(homedir())
    expect(resolvePtyCwd({ cwd: 'C:\\repo' })).toBe('C:\\repo')
    expect(resolvePtyCwd({ terminal: { cwd: 'C:\\repo' } })).toBe('C:\\repo')
  })

  test('does not hand a Linux workspace to Windows CreateProcess', () => {
    test.skip(process.platform !== 'win32')
    expect(
      resolvePtyCwd({
        terminal: { cwd: '/home/jesse/project' }
      })
    ).toBe(homedir())
    expect(
      resolvePtyCwd({
        cwd: '/mnt/c/Users/Jesse/Documents/gbc',
        terminal: { cwd: '/home/jesse/project' }
      })
    ).toBe(homedir())
    expect(
      resolvePtyCwd({
        cwd: 'C:\\Users\\Jesse\\Documents\\gbc',
        terminal: { cwd: '/home/jesse/project' }
      })
    ).toBe('C:\\Users\\Jesse\\Documents\\gbc')
  })
})
