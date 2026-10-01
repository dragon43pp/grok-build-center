export type ParsedGbcCli =
  | { kind: 'help' }
  | {
      kind: 'request'
      method: string
      params: Record<string, unknown>
      watch?: boolean
    }

const CLI_HEADS = new Set([
  'opencode',
  'sessions',
  'session',
  'help',
  '-h',
  '--help',
  '--gbc-cli'
])

export function extractGbcCliArgv(argv: readonly string[]): string[] | null {
  const gbcFlag = argv.indexOf('--gbc-cli')
  if (gbcFlag >= 0) return argv.slice(gbcFlag + 1).map(String)
  for (let index = 0; index < argv.length; index++) {
    if (CLI_HEADS.has(argv[index])) return argv.slice(index).map(String)
  }
  return null
}

export function isGbcCliInvocation(argv: readonly string[]): boolean {
  const extracted = extractGbcCliArgv(argv)
  return extracted !== null && extracted[0] !== undefined
}

function takeFlag(
  args: string[],
  names: readonly string[]
): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    for (const name of names) {
      if (value === name) {
        const next = args[index + 1]
        args.splice(index, next === undefined ? 1 : 2)
        return next
      }
      if (value.startsWith(`${name}=`)) {
        args.splice(index, 1)
        return value.slice(name.length + 1)
      }
    }
  }
  return undefined
}

function usage(): string {
  return [
    'Usage:',
    '  gbc opencode models [--installation <id>]',
    '  gbc opencode create --workspace <path> --model <provider/model>',
    '                       [--agent plan|build] [--name <title>]',
    '                       [--installation <id>]',
    '  gbc sessions',
    '  gbc sessions history [--agent <grok|codex|claude|...>] [--query <text>]',
    '                        [--limit <n>] [--include-hidden] [--refresh]',
    '  gbc session resume <sessionId> [--agent <id>] [--dry-run]',
    '  gbc session send <sessionId> <text>',
    '  gbc session turn <sessionId>',
    '  gbc session watch <sessionId>',
    '  gbc session close <sessionId>',
    '  gbc session rename <sessionId> <name>',
    '  gbc session mode <sessionId> plan|build',
    '  gbc session approve <sessionId> <requestId> [--remember]',
    '  gbc session deny <sessionId> <requestId>',
    '  gbc session questions <sessionId>',
    '  gbc session answer <sessionId> <requestId> --json <payload>',
    '  gbc session reject-question <sessionId> <requestId>',
    '  gbc session wait <sessionId> --until blocked|turn|exited'
  ].join('\n')
}

function takeBoolFlag(args: string[], names: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (names.includes(value)) {
      args.splice(index, 1)
      return true
    }
  }
  return false
}

export function parseGbcCli(argv: readonly string[]): ParsedGbcCli {
  const args = [...argv]
  if (args[0] === '--gbc-cli') args.shift()
  const head = args.shift()
  if (!head || head === 'help' || head === '-h' || head === '--help') {
    return { kind: 'help' }
  }

  if (head === 'opencode') {
    const command = args.shift()
    if (command === 'models') {
      const installation = takeFlag(args, ['--installation', '-i'])
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'opencode.models',
        params: installation ? { installationId: installation } : {}
      }
    }
    if (command === 'create') {
      const workspace = takeFlag(args, ['--workspace', '-w'])
      const model = takeFlag(args, ['--model', '-m'])
      const agent = takeFlag(args, ['--agent'])
      const name = takeFlag(args, ['--name'])
      const installation = takeFlag(args, ['--installation', '-i'])
      if (!workspace) throw new Error('create requires --workspace')
      if (!model) throw new Error('create requires --model')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'opencode.create',
        params: {
          workspace,
          model,
          ...(agent ? { agent } : {}),
          ...(name ? { name } : {}),
          ...(installation ? { installationId: installation } : {})
        }
      }
    }
    if (!command || command === 'help') return { kind: 'help' }
    throw new Error(`Unknown opencode command: ${command}\n${usage()}`)
  }

  if (head === 'sessions') {
    // 不带子命令 = 列现在开着的会话（老行为）。带 history = 列磁盘上的历史会话。
    if (args.length === 0) {
      return { kind: 'request', method: 'sessions.list', params: {} }
    }
    const command = args.shift()
    if (command !== 'history') {
      throw new Error(`Unknown sessions command: ${command}\n${usage()}`)
    }
    const agent = takeFlag(args, ['--agent'])
    const query = takeFlag(args, ['--query', '-q'])
    const limit = takeFlag(args, ['--limit', '-n'])
    const includeHidden = takeBoolFlag(args, ['--include-hidden'])
    const refresh = takeBoolFlag(args, ['--refresh'])
    if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
    return {
      kind: 'request',
      method: 'sessions.history',
      params: {
        ...(agent ? { agent } : {}),
        ...(query ? { query } : {}),
        ...(limit ? { limit } : {}),
        ...(includeHidden ? { includeHidden: true } : {}),
        ...(refresh ? { refresh: true } : {})
      }
    }
  }

  if (head === 'session') {
    const command = args.shift()
    if (!command || command === 'help') return { kind: 'help' }
    const sessionId = args.shift()
    if (!sessionId) throw new Error(`session ${command} requires <sessionId>`)
    if (command === 'resume') {
      const agent = takeFlag(args, ['--agent'])
      const dryRun = takeBoolFlag(args, ['--dry-run'])
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.resume',
        params: {
          sessionId,
          ...(agent ? { agent } : {}),
          ...(dryRun ? { dryRun: true } : {})
        }
      }
    }
    if (command === 'send') {
      const text = args.join(' ').trim()
      if (!text) throw new Error('session send requires <text>')
      return {
        kind: 'request',
        method: 'session.send',
        params: { sessionId, text }
      }
    }
    if (command === 'turn') {
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.turn',
        params: { sessionId }
      }
    }
    if (command === 'watch') {
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.watch',
        params: { sessionId },
        watch: true
      }
    }
    if (command === 'close' || command === 'stop' || command === 'delete') {
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.close',
        params: { sessionId }
      }
    }
    if (command === 'rename') {
      const name = args.join(' ').trim()
      if (!name) throw new Error('session rename requires <name>')
      return {
        kind: 'request',
        method: 'session.rename',
        params: { sessionId, name }
      }
    }
    if (command === 'mode') {
      const agent = args.shift()
      if (!agent) throw new Error('session mode requires plan or build')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.mode',
        params: { sessionId, agent }
      }
    }
    if (command === 'approve') {
      const requestId = args.shift()
      if (!requestId) throw new Error('session approve requires <requestId>')
      const remember = takeBoolFlag(args, ['--remember'])
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.approve',
        params: {
          sessionId,
          requestId,
          ...(remember ? { remember: true } : {})
        }
      }
    }
    if (command === 'deny') {
      const requestId = args.shift()
      if (!requestId) throw new Error('session deny requires <requestId>')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.deny',
        params: { sessionId, requestId }
      }
    }
    if (command === 'questions') {
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.questions',
        params: { sessionId }
      }
    }
    if (command === 'answer') {
      const requestId = args.shift()
      if (!requestId) throw new Error('session answer requires <requestId>')
      const json = takeFlag(args, ['--json'])
      if (!json) throw new Error('session answer requires --json')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.answer',
        params: { sessionId, requestId, json }
      }
    }
    if (command === 'reject-question') {
      const requestId = args.shift()
      if (!requestId) throw new Error('session reject-question requires <requestId>')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.reject-question',
        params: { sessionId, requestId }
      }
    }
    if (command === 'wait') {
      const until = takeFlag(args, ['--until'])
      if (!until) throw new Error('session wait requires --until')
      if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`)
      return {
        kind: 'request',
        method: 'session.wait',
        params: { sessionId, until }
      }
    }
    throw new Error(`Unknown session command: ${command}\n${usage()}`)
  }

  throw new Error(`Unknown command: ${head}\n${usage()}`)
}

export function cliUsage(): string {
  return usage()
}
