import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  BridgeRequest,
  BridgeSocketMessage,
  BridgeWatchEvent
} from '../../shared/bridge-protocol'
import { BridgeError } from '../bridge/errors'
import { bridgeSocketPath, readBridgeTokenFile } from '../bridge/paths'
import {
  cliUsage,
  extractGbcCliArgv,
  isGbcCliInvocation,
  parseGbcCli
} from './parseGbcCli'

export { extractGbcCliArgv, isGbcCliInvocation, parseGbcCli, cliUsage }

export interface GbcCliIo {
  stdout: { write(chunk: string): void }
  stderr: { write(chunk: string): void }
  connect?: (path: string) => Promise<Socket>
  token?: string
  socketPath?: string
  userDataDir?: string
}

const GBC_NOT_RUNNING =
  'Grok Build Center is not running. Open Grok Build Center first, then retry this command.'

function defaultUserDataCandidates(): string[] {
  if (process.env.GBC_USER_DATA_DIR) return [process.env.GBC_USER_DATA_DIR]
  if (process.env.HRACK_USER_DATA_DIR) return [process.env.HRACK_USER_DATA_DIR]
  const appData =
    process.env.APPDATA ||
    process.env.XDG_CONFIG_HOME ||
    join(homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config')
  return [join(appData, 'Grok Build Center Dev'), join(appData, 'Grok Build Center')]
}

async function resolveToken(io: GbcCliIo): Promise<string> {
  if (io.token) return io.token
  if (process.env.GBC_BRIDGE_TOKEN) return process.env.GBC_BRIDGE_TOKEN
  const dirs = io.userDataDir ? [io.userDataDir] : defaultUserDataCandidates()
  for (const dir of dirs) {
    const token = await readBridgeTokenFile(dir)
    if (token) return token
  }
  throw BridgeError.disconnected(GBC_NOT_RUNNING)
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const onError = (error: Error): void => {
      socket.off('connect', onConnect)
      reject(error)
    }
    const onConnect = (): void => {
      socket.off('error', onError)
      resolve(socket)
    }
    socket.once('error', onError)
    socket.once('connect', onConnect)
  })
}

async function openBridge(io: GbcCliIo): Promise<{ socket: Socket; token: string }> {
  const token = await resolveToken(io)
  const path = io.socketPath ?? process.env.GBC_BRIDGE_SOCKET ?? bridgeSocketPath()
  try {
    const socket = await (io.connect ? io.connect(path) : connectSocket(path))
    socket.setEncoding('utf8')
    return { socket, token }
  } catch {
    throw BridgeError.disconnected(GBC_NOT_RUNNING)
  }
}

function readMessages(
  socket: Socket
): AsyncGenerator<BridgeSocketMessage> {
  let buffer = ''
  const queue: BridgeSocketMessage[] = []
  let notify: (() => void) | null = null
  let done = false
  let failure: Error | null = null

  const push = (message: BridgeSocketMessage): void => {
    queue.push(message)
    notify?.()
  }

  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          push(JSON.parse(line) as BridgeSocketMessage)
        } catch {
          failure = new BridgeError('invalid', 'Invalid response from Grok Build Center')
          notify?.()
          return
        }
      }
      newline = buffer.indexOf('\n')
    }
  })
  socket.on('close', () => {
    done = true
    notify?.()
  })
  socket.on('error', (error) => {
    failure = error
    done = true
    notify?.()
  })

  return (async function* () {
    while (true) {
      if (failure) throw failure
      if (queue.length > 0) {
        yield queue.shift() as BridgeSocketMessage
        continue
      }
      if (done) return
      await new Promise<void>((resolve) => {
        notify = resolve
      })
      notify = null
    }
  })()
}

function printJson(io: GbcCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export async function runGbcCli(
  argv: readonly string[],
  io: GbcCliIo
): Promise<number> {
  const extracted =
    extractGbcCliArgv(argv) ?? extractGbcCliArgv(['node', ...argv])
  if (!extracted) {
    io.stderr.write(`${cliUsage()}\n`)
    return 1
  }
  let parsed
  try {
    parsed = parseGbcCli(extracted)
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (parsed.kind === 'help') {
    io.stdout.write(`${cliUsage()}\n`)
    return 0
  }

  let socket: Socket
  let token: string
  try {
    const opened = await openBridge(io)
    socket = opened.socket
    token = opened.token
  } catch (error) {
    const bridged =
      error instanceof BridgeError
        ? error
        : BridgeError.disconnected(GBC_NOT_RUNNING)
    io.stderr.write(`${bridged.message}\n`)
    return bridged.exitCode
  }

  const request: BridgeRequest = {
    id: `cli-${Date.now()}`,
    token,
    method: parsed.method,
    params: parsed.params
  }
  socket.write(`${JSON.stringify(request)}\n`)

  const interrupt = (): void => {
    socket.destroy()
    io.stderr.write('\n')
    process.exitCode = 130
  }
  if (parsed.watch) {
    process.once('SIGINT', interrupt)
  }

  try {
    const messages = readMessages(socket)
    let watching = Boolean(parsed.watch)
    for await (const message of messages) {
      if (message.kind === 'result') {
        if (!message.ok) {
          printJson(io, { error: message.error })
          socket.destroy()
          return message.error.code === 'unauthorized' ? 2 : 1
        }
        if (!watching) {
          printJson(io, message.result)
          socket.end()
          return process.exitCode === 130 ? 130 : 0
        }
        continue
      }
      if (message.kind === 'event') {
        io.stdout.write(`${JSON.stringify(message.event)}\n`)
        if ((message.event as BridgeWatchEvent).type === 'exited') {
          socket.end()
          return process.exitCode === 130 ? 130 : 0
        }
      }
    }
    if (watching) return process.exitCode === 130 ? 130 : 0
    io.stderr.write('Grok Build Center closed the bridge connection\n')
    return 2
  } catch (error) {
    if (process.exitCode === 130) return 130
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    socket.destroy()
    return 1
  } finally {
    if (parsed.watch) process.off('SIGINT', interrupt)
  }
}
