import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  extractLastClosedTurn,
  extractSinceCursor,
  parseOpenCodeMessages
} from '../electron/agents/adapters/opencode/OpenCodeMessages'
import { OpenCodeEventProjector } from '../electron/agents/adapters/opencode/OpenCodeEventProjector'
import { submitOpenCodePrompt } from '../electron/agents/adapters/opencode/OpenCodePrompt'
import {
  answerOpenCodeQuestion,
  listOpenCodeQuestions,
  rejectOpenCodeQuestion,
  respondOpenCodePermission,
  setOpenCodeAgent,
  setOpenCodeTitle
} from '../electron/agents/adapters/opencode/OpenCodeControl'
import {
  HostOpenCodeTransport,
  OpenCodeTransportError
} from '../electron/agents/adapters/opencode/OpenCodeTransport'
import type {
  AgentSessionPhase,
  AgentSessionRecord
} from '../electron/agents/AgentSessionRuntime'
import type { ObserverControl } from '../electron/agents/adapters/types'
import { BridgeServer } from '../electron/bridge/BridgeServer'
import { truncateDelta } from '../electron/bridge/delta'
import { parseOpenCodeModelsOutput } from '../electron/bridge/models'
import {
  OpenCodeControlPlane,
  type ControlPlaneDiscovery,
  type ControlPlaneRuntime
} from '../electron/bridge/OpenCodeControlPlane'
import { BridgeStateStore } from '../electron/bridge/state'
import { runGbcCli } from '../electron/cli/gbcCli'
import { parseGbcCli } from '../electron/cli/parseGbcCli'
import type { AgentSessionProjection } from '../shared/agent-events'
import type {
  BridgeLaunchRequest,
  CliInstallation,
  CliScanReport,
  LaunchableCli
} from '../shared/ipc-contract'
import {
  emptyUsage,
  type HistorySession
} from '../shared/session-history'
import { createInitialAgentProjection } from '../electron/agents/AgentEventReducer'
import { OPENCODE_CAPABILITIES } from '../electron/agents/adapters/opencode/types'

const hostInstall = (id: string): CliInstallation => ({
  id,
  definitionId: 'opencode',
  runtime: { kind: 'host', platform: 'windows' },
  resolvedExecutable: 'C:\\bin\\opencode.exe',
  detectedVia: 'path',
  verification: 'verified'
})

/** 非 opencode 的安装项：`session.resume` 要按 cliId 去扫描报告里找它们。 */
const hostInstallFor = (definitionId: string, id: string): CliInstallation => ({
  id,
  definitionId,
  runtime: { kind: 'host', platform: 'windows' },
  resolvedExecutable: `C:\\bin\\${definitionId}.exe`,
  detectedVia: 'path',
  verification: 'verified'
})

/** 一条磁盘上的历史会话，字段取默认值以便每个用例只声明它关心的那两三个。 */
const historySession = (
  overrides: Partial<HistorySession> & Pick<HistorySession, 'agent' | 'id'>
): HistorySession => ({
  title: 'a session',
  cwd: 'C:\\work',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  messageCount: 3,
  model: 'grok-4',
  usage: emptyUsage(),
  costUsd: 0,
  costSource: 'none',
  storage: 'file',
  path: 'C:\\sessions\\x.jsonl',
  archived: false,
  subagent: false,
  ...overrides
})

const wslInstall = (id: string, distro: string): CliInstallation => ({
  id,
  definitionId: 'opencode',
  runtime: { kind: 'wsl', distro },
  resolvedExecutable: '/home/u/.opencode/bin/opencode',
  detectedVia: 'path',
  verification: 'verified'
})

function projection(
  overrides: Partial<AgentSessionProjection> &
    Pick<AgentSessionProjection, 'sessionId' | 'terminalId' | 'installationId'>
): AgentSessionProjection {
  return {
    ...createInitialAgentProjection({
      sessionId: overrides.sessionId,
      terminalId: overrides.terminalId,
      installationId: overrides.installationId,
      adapterId: 'opencode',
      name: 'OpenCode',
      capabilities: OPENCODE_CAPABILITIES,
      lastActivityAt: 1
    }),
    ...overrides
  }
}

function record(
  overrides: Partial<AgentSessionRecord> &
    Pick<AgentSessionRecord, 'sessionId' | 'terminalId' | 'installationId'>
): AgentSessionRecord {
  const proj =
    overrides.projection ??
    projection({
      sessionId: overrides.sessionId,
      terminalId: overrides.terminalId,
      installationId: overrides.installationId
    })
  return {
    sessionId: overrides.sessionId,
    terminalId: overrides.terminalId,
    installationId: overrides.installationId,
    adapterId: 'opencode',
    name: 'OpenCode',
    workspace: 'C:\\work',
    runtime: { kind: 'host', platform: 'windows' },
    model: 'anthropic/claude-sonnet-4-5',
    agent: 'build',
    projection: proj,
    ...overrides
  }
}

class FakeRuntime implements ControlPlaneRuntime {
  records = new Map<string, AgentSessionRecord>()
  control: ObserverControl | undefined
  /**
   * 按会话给的控制器。缺省（null）时所有会话都返回 `control` —— 这是老用例的
   * 写法，它们只有 opencode 一种会话。要断言「哪些会话可控」就必须按会话给，
   * 否则一个全局 `control` 会让每一条看起来都能原生控制。
   */
  controlBySession: Map<string, ObserverControl> | null = null
  listeners = new Set<
    (item: AgentSessionRecord, phase: AgentSessionPhase) => void
  >()

  getRecord(sessionId: string): AgentSessionRecord | null {
    return this.records.get(sessionId) ?? null
  }

  listRecords(): AgentSessionRecord[] {
    return [...this.records.values()]
  }

  subscribe(
    listener: (item: AgentSessionRecord, phase: AgentSessionPhase) => void
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  observerControl(sessionId: string): ObserverControl | undefined {
    return this.controlBySession
      ? this.controlBySession.get(sessionId)
      : this.control
  }

  rename(sessionId: string, rawName: string): AgentSessionRecord | null {
    const item = this.records.get(sessionId)
    const name = rawName.trim().slice(0, 128)
    if (!item || !name) return null
    const next = {
      ...item,
      name,
      projection: { ...item.projection, name }
    }
    this.upsert(next)
    return next
  }

  setAgent(sessionId: string, agent: 'plan' | 'build'): void {
    const item = this.records.get(sessionId)
    if (!item) return
    this.upsert({ ...item, agent })
  }

  upsert(item: AgentSessionRecord, phase: AgentSessionPhase = 'updated'): void {
    this.records.set(item.sessionId, item)
    for (const listener of this.listeners) listener(item, phase)
  }

  async stop(sessionId: string): Promise<void> {
    const item = this.records.get(sessionId)
    if (!item) return
    this.records.delete(sessionId)
    for (const listener of this.listeners) listener(item, 'finalized')
  }
}

function scanOf(
  installations: CliInstallation[],
  extraClis: { id: string; installations: CliInstallation[] }[] = []
): CliScanReport {
  const cli = (
    id: string,
    displayName: string,
    items: CliInstallation[]
  ): LaunchableCli => ({
    definition: {
      id,
      adapterId: id,
      displayName,
      hint: '',
      iconId: id
    },
    installations: items
  })
  return {
    startedAt: 1,
    finishedAt: 2,
    launchable: [
      cli('opencode', 'OpenCode', installations),
      ...extraClis.map((entry) => cli(entry.id, entry.id, entry.installations))
    ],
    runtimeErrors: []
  }
}

function discovery(options: {
  installations: CliInstallation[]
  modelsStdout?: string
  timedOut?: boolean
  code?: number | null
  extraClis?: { id: string; installations: CliInstallation[] }[]
}): ControlPlaneDiscovery {
  return {
    async scan() {
      return scanOf(options.installations, options.extraClis)
    },
    async resolveInstallation(id) {
      return options.installations.find((item) => item.id === id) ?? null
    },
    async resolveWorkspace(_id, workspace) {
      return workspace
    },
    async runInstallationCommand() {
      return {
        stdout: options.modelsStdout ?? 'anthropic/claude-sonnet-4-5\n',
        stderr: '',
        timedOut: Boolean(options.timedOut),
        code: options.code ?? 0
      }
    }
  }
}

function planeHarness(options: {
  installations?: CliInstallation[]
  modelsStdout?: string
  runtime?: FakeRuntime
  windowError?: string
  /** 额外出现在扫描报告里的 CLI（`session.resume` 用）。 */
  extraClis?: { id: string; installations: CliInstallation[] }[]
  history?: HistorySession[]
  writeTerminal?: (terminalId: string, data: string) => boolean
  terminalReady?: (terminalId: string) => boolean
}) {
  const runtime = options.runtime ?? new FakeRuntime()
  const launched: BridgeLaunchRequest[] = []
  const dir = mkdtempSync(join(tmpdir(), 'gbc-bridge-'))
  const plane = new OpenCodeControlPlane({
    discovery: discovery({
      installations: options.installations ?? [hostInstall('opencode:win')],
      modelsStdout: options.modelsStdout,
      extraClis: options.extraClis
    }),
    runtime,
    state: new BridgeStateStore(join(dir, 'bridge-state.json')),
    requireForegroundWindow: () => {
      if (options.windowError) throw new Error(options.windowError)
    },
    ...(options.history ? { history: async () => options.history ?? [] } : {}),
    ...(options.writeTerminal ? { writeTerminal: options.writeTerminal } : {}),
    ...(options.terminalReady ? { terminalReady: options.terminalReady } : {}),
    launchVisible: async (request) => {
      launched.push(request)
      runtime.upsert(
        record({
          sessionId: 'sess-1',
          terminalId: request.terminalId,
          installationId: request.selection.installationId,
          name: request.name,
          workspace: request.workspace,
          model:
            request.selection.args[
              request.selection.args.indexOf('-m') + 1
            ],
          agent:
            request.selection.args[
              request.selection.args.indexOf('--agent') + 1
            ] === 'plan'
              ? 'plan'
              : 'build'
        })
      )
      return null
    }
  })
  return { plane, runtime, launched, dispose: () => plane.dispose() }
}

test.describe('OpenCode bridge P1', () => {
  test('parses the P1 CLI surface', () => {
    expect(parseGbcCli(['opencode', 'models', '--installation', 'oc:win'])).toEqual({
      kind: 'request',
      method: 'opencode.models',
      params: { installationId: 'oc:win' }
    })
    expect(
      parseGbcCli([
        'opencode',
        'create',
        '--workspace',
        'C:\\repo',
        '--model',
        'anthropic/claude-sonnet-4-5',
        '--agent',
        'plan',
        '--name',
        '补测试'
      ])
    ).toEqual({
      kind: 'request',
      method: 'opencode.create',
      params: {
        workspace: 'C:\\repo',
        model: 'anthropic/claude-sonnet-4-5',
        agent: 'plan',
        name: '补测试'
      }
    })
    expect(parseGbcCli(['sessions'])).toEqual({
      kind: 'request',
      method: 'sessions.list',
      params: {}
    })
    expect(parseGbcCli(['session', 'send', 'sess-1', 'keep', 'going'])).toEqual({
      kind: 'request',
      method: 'session.send',
      params: { sessionId: 'sess-1', text: 'keep going' }
    })
    expect(parseGbcCli(['session', 'watch', 'sess-1'])).toEqual({
      kind: 'request',
      method: 'session.watch',
      params: { sessionId: 'sess-1' },
      watch: true
    })
    expect(parseGbcCli(['session', 'close', 'sess-1'])).toEqual({
      kind: 'request',
      method: 'session.close',
      params: { sessionId: 'sess-1' }
    })
    expect(parseGbcCli(['session', 'delete', 'sess-1'])).toEqual({
      kind: 'request',
      method: 'session.close',
      params: { sessionId: 'sess-1' }
    })
    expect(parseGbcCli(['session', 'rename', 'sess-1', 'New', 'title'])).toEqual({
      kind: 'request',
      method: 'session.rename',
      params: { sessionId: 'sess-1', name: 'New title' }
    })
    expect(parseGbcCli(['session', 'mode', 'sess-1', 'plan'])).toEqual({
      kind: 'request',
      method: 'session.mode',
      params: { sessionId: 'sess-1', agent: 'plan' }
    })
    expect(
      parseGbcCli(['session', 'approve', 'sess-1', 'req-1', '--remember'])
    ).toEqual({
      kind: 'request',
      method: 'session.approve',
      params: { sessionId: 'sess-1', requestId: 'req-1', remember: true }
    })
    expect(parseGbcCli(['session', 'deny', 'sess-1', 'req-1'])).toEqual({
      kind: 'request',
      method: 'session.deny',
      params: { sessionId: 'sess-1', requestId: 'req-1' }
    })
    expect(parseGbcCli(['session', 'questions', 'sess-1'])).toEqual({
      kind: 'request',
      method: 'session.questions',
      params: { sessionId: 'sess-1' }
    })
    expect(
      parseGbcCli([
        'session',
        'answer',
        'sess-1',
        'req-1',
        '--json',
        '{"answers":[["a"]]}'
      ])
    ).toEqual({
      kind: 'request',
      method: 'session.answer',
      params: {
        sessionId: 'sess-1',
        requestId: 'req-1',
        json: '{"answers":[["a"]]}'
      }
    })
    expect(
      parseGbcCli(['session', 'reject-question', 'sess-1', 'req-1'])
    ).toEqual({
      kind: 'request',
      method: 'session.reject-question',
      params: { sessionId: 'sess-1', requestId: 'req-1' }
    })
    expect(
      parseGbcCli(['session', 'wait', 'sess-1', '--until', 'turn'])
    ).toEqual({
      kind: 'request',
      method: 'session.wait',
      params: { sessionId: 'sess-1', until: 'turn' }
    })
  })

  test('parses provider/model lines and treats empty output as success', () => {
    expect(
      parseOpenCodeModelsOutput(
        'Models\nanthropic/claude-sonnet-4-5\nopenai/gpt-4.1\nanthropic/claude-sonnet-4-5\n'
      )
    ).toEqual([
      {
        id: 'anthropic/claude-sonnet-4-5',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5'
      },
      { id: 'openai/gpt-4.1', provider: 'openai', model: 'gpt-4.1' }
    ])
    expect(parseOpenCodeModelsOutput('')).toEqual([])
  })

  test('models includes runtime and surfaces timeouts', async () => {
    const ok = planeHarness({})
    await expect(ok.plane.models({})).resolves.toMatchObject({
      installationId: 'opencode:win',
      runtime: { kind: 'host', platform: 'windows' },
      models: [{ id: 'anthropic/claude-sonnet-4-5' }]
    })
    ok.dispose()

    const timed = new OpenCodeControlPlane({
      discovery: discovery({
        installations: [hostInstall('opencode:win')],
        timedOut: true
      }),
      runtime: new FakeRuntime(),
      state: new BridgeStateStore(join(mkdtempSync(join(tmpdir(), 'gbc-bridge-')), 's.json')),
      requireForegroundWindow: () => {},
      launchVisible: async () => 'unused'
    })
    await expect(timed.models({})).rejects.toThrow(/timed out/)
    timed.dispose()
  })

  test('create synthesizes workspace, -m and --agent and opens a visible tab', async () => {
    const { plane, launched, dispose } = planeHarness({})
    const created = await plane.create({
      workspace: 'C:\\repo',
      model: 'anthropic/claude-sonnet-4-5',
      agent: 'plan',
      name: '补测试'
    })
    expect(launched).toHaveLength(1)
    expect(launched[0].selection.args).toEqual([
      'C:\\repo',
      '-m',
      'anthropic/claude-sonnet-4-5',
      '--agent',
      'plan'
    ])
    expect(created).toMatchObject({
      sessionId: 'sess-1',
      name: '补测试',
      model: 'anthropic/claude-sonnet-4-5',
      agent: 'plan',
      workspace: 'C:\\repo',
      installationId: 'opencode:win',
      runtime: { kind: 'host', platform: 'windows' }
    })
    expect(created.terminalId).toBe(launched[0].terminalId)
    dispose()
  })

  test('refuses to guess among Windows and WSL installations', async () => {
    const { plane, dispose } = planeHarness({
      installations: [
        hostInstall('opencode:win'),
        wslInstall('opencode:wsl', 'Ubuntu-22.04')
      ]
    })
    await expect(
      plane.create({
        workspace: 'C:\\repo',
        model: 'anthropic/claude-sonnet-4-5'
      })
    ).rejects.toThrow(/Multiple OpenCode installations/)
    dispose()
  })

  test('send accepts idle and rejects working / needs-you', async () => {
    const runtime = new FakeRuntime()
    const sent: Array<{ text: string; agent?: string }> = []
    runtime.control = {
      async submitPrompt(text, agent) {
        sent.push({ text, agent })
      },
      async snapshotMessages() {
        return []
      }
    }
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.send({ sessionId: 'sess-1', text: 'hello' })
    ).resolves.toEqual({ accepted: true, mode: 'control' })
    expect(sent).toEqual([{ text: 'hello', agent: undefined }])

    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        projection: projection({
          sessionId: 'sess-1',
          terminalId: 'term-1',
          installationId: 'opencode:win',
          status: 'working'
        })
      })
    )
    await expect(
      plane.send({ sessionId: 'sess-1', text: 'again' })
    ).rejects.toThrow(/working/)

    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        projection: projection({
          sessionId: 'sess-1',
          terminalId: 'term-1',
          installationId: 'opencode:win',
          status: 'needs-you'
        })
      })
    )
    await expect(
      plane.send({ sessionId: 'sess-1', text: 'again' })
    ).rejects.toThrow(/needs-you/)
    dispose()
  })

  test('watch stays silent on working and emits one snapshot turn', async () => {
    const runtime = new FakeRuntime()
    let snapshot: unknown[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const item = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win'
    })
    runtime.upsert(item)
    const { plane, dispose } = planeHarness({ runtime })
    const events: Array<{ type: string; text?: string; tools?: number }> = []
    const stop = plane.watch(
      'sess-1',
      (event) => {
        events.push({
          type: event.type,
          text: event.delta.text,
          tools: event.delta.tools.length
        })
      },
      () => {}
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'do it' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [
          { type: 'reasoning', text: 'secret-thought' },
          { type: 'text', id: 't1', text: 'I ran the suite.' },
          {
            type: 'tool',
            callID: 'c1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'npm test' },
              output: { stdout: 'ok' }
            }
          },
          {
            type: 'tool',
            callID: 'c2',
            tool: 'read',
            state: {
              status: 'completed',
              input: { path: 'a.ts' },
              output: { content: 'export {}' }
            }
          }
        ]
      }
    ]
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'working' }
    })
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'working', detail: 'thinking' }
    })
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'done', statusConfidence: 'high' }
    })
    await expect.poll(() => events.map((event) => event.type)).toEqual(['turn'])
    expect(events[0].text).toBe('I ran the suite.')
    expect(events[0].tools).toBe(2)
    expect(JSON.stringify(events)).not.toContain('secret-thought')
    const pulled = await plane.turn({ sessionId: 'sess-1' })
    expect(pulled.delta.text).toBe('I ran the suite.')
    expect(pulled.runtime).toEqual({ kind: 'host', platform: 'windows' })
    stop()
    dispose()
  })

  test('blocked permission and question fire once and keep prior assistant text', async () => {
    const runtime = new FakeRuntime()
    let snapshot: unknown[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const base = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win'
    })
    runtime.upsert(base)
    const { plane, dispose } = planeHarness({ runtime })
    const events: Array<{ type: string; kind?: string; requestId?: string; text?: string }> =
      []
    plane.watch(
      'sess-1',
      (event) => {
        events.push({
          type: event.type,
          kind: event.blocked?.kind,
          requestId: event.blocked?.requestId,
          text: event.delta.text
        })
      },
      () => {}
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'edit it' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', id: 't1', text: 'I will patch the file.' }]
      }
    ]
    const approvalId = 'opencode:native:approval:p1'
    runtime.upsert({
      ...base,
      projection: {
        ...base.projection,
        status: 'needs-you',
        pendingAttentionCount: 1,
        correlation: {
          ...base.projection.correlation,
          pendingApprovals: {
            [approvalId]: {
              category: 'file-change',
              summary: 'Edit file',
              turnId: 't'
            }
          }
        }
      }
    })
    runtime.upsert({
      ...base,
      projection: {
        ...base.projection,
        status: 'needs-you',
        pendingAttentionCount: 1,
        correlation: {
          ...base.projection.correlation,
          pendingApprovals: {
            [approvalId]: {
              category: 'file-change',
              summary: 'Edit file',
              turnId: 't'
            }
          }
        }
      }
    })
    await expect.poll(() => events.length).toBe(1)
    expect(events[0]).toMatchObject({
      type: 'blocked',
      kind: 'permission',
      requestId: approvalId,
      text: 'I will patch the file.'
    })

    const questionId = 'opencode:native:input:q1'
    runtime.upsert({
      ...base,
      projection: {
        ...base.projection,
        status: 'working',
        pendingAttentionCount: 0
      }
    })
    runtime.upsert({
      ...base,
      projection: {
        ...base.projection,
        status: 'needs-you',
        pendingAttentionCount: 1,
        correlation: {
          ...base.projection.correlation,
          pendingApprovals: {},
          pendingInputs: {
            [questionId]: { prompt: 'Which file?', turnId: 't' }
          }
        }
      }
    })
    await expect.poll(() => events.length).toBe(2)
    expect(events[1]).toMatchObject({
      type: 'blocked',
      kind: 'question',
      requestId: questionId
    })
    dispose()
  })

  test('rename updates the sidebar and OpenCode title, and keeps GBC name on title failure', async () => {
    const runtime = new FakeRuntime()
    const titles: string[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async setTitle(title) {
        titles.push(title)
      }
    }
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.rename', { sessionId: 'sess-1', name: '补测试' })
    ).resolves.toEqual({
      kind: 'json',
      value: { sessionId: 'sess-1', name: '补测试', titleUpdated: true }
    })
    expect(runtime.getRecord('sess-1')?.name).toBe('补测试')
    expect(titles).toEqual(['补测试'])

    runtime.control.setTitle = async () => {
      throw new Error('OpenCode HTTP 500')
    }
    await expect(
      plane.handle('session.rename', { sessionId: 'sess-1', name: 'Still GBC' })
    ).resolves.toEqual({
      kind: 'json',
      value: {
        sessionId: 'sess-1',
        name: 'Still GBC',
        titleUpdated: false,
        error: { message: 'OpenCode HTTP 500' }
      }
    })
    expect(runtime.getRecord('sess-1')?.name).toBe('Still GBC')
    dispose()
  })

  test('mode writes the OpenCode agent and refuses to keep only a GBC shadow', async () => {
    const runtime = new FakeRuntime()
    const seen: string[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async setAgent(agent) {
        seen.push(agent)
      }
    }
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        agent: 'build'
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.mode', { sessionId: 'sess-1', agent: 'plan' })
    ).resolves.toEqual({
      kind: 'json',
      value: { sessionId: 'sess-1', agent: 'plan' }
    })
    expect(seen).toEqual(['plan'])
    expect(runtime.getRecord('sess-1')?.agent).toBe('plan')

    runtime.control.setAgent = async () => {
      throw new Error('no agent write API')
    }
    await expect(
      plane.handle('session.mode', { sessionId: 'sess-1', agent: 'build' })
    ).rejects.toThrow(/no agent write API/)
    expect(runtime.getRecord('sess-1')?.agent).toBe('plan')
    dispose()
  })

  test('approve maps to once by default and always only when remember is explicit', async () => {
    const runtime = new FakeRuntime()
    const replies: Array<{ id: string; response: string }> = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async respondPermission(nativeId, response) {
        replies.push({ id: nativeId, response })
      }
    }
    const requestId = 'opencode:native-1:approval:perm-9'
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        projection: projection({
          sessionId: 'sess-1',
          terminalId: 'term-1',
          installationId: 'opencode:win',
          status: 'needs-you',
          pendingAttentionCount: 1,
          correlation: {
            ...projection({
              sessionId: 'sess-1',
              terminalId: 'term-1',
              installationId: 'opencode:win'
            }).correlation,
            pendingApprovals: {
              [requestId]: {
                category: 'file-change',
                summary: 'Edit file',
                turnId: 't'
              }
            }
          }
        })
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.approve', { sessionId: 'sess-1', requestId })
    ).resolves.toEqual({
      kind: 'json',
      value: {
        sessionId: 'sess-1',
        requestId,
        decision: 'approved',
        remember: false
      }
    })
    expect(replies).toEqual([{ id: 'perm-9', response: 'once' }])

    runtime.upsert({
      ...runtime.getRecord('sess-1')!,
      projection: {
        ...runtime.getRecord('sess-1')!.projection,
        correlation: {
          ...runtime.getRecord('sess-1')!.projection.correlation,
          pendingApprovals: {
            [requestId]: {
              category: 'file-change',
              summary: 'Edit file',
              turnId: 't'
            }
          }
        }
      }
    })
    await expect(
      plane.handle('session.approve', {
        sessionId: 'sess-1',
        requestId,
        remember: true
      })
    ).resolves.toMatchObject({
      kind: 'json',
      value: { decision: 'approved', remember: true }
    })
    expect(replies[1]).toEqual({ id: 'perm-9', response: 'always' })
    dispose()
  })

  test('deny replies reject and a later approve is idempotent once TUI already decided', async () => {
    const runtime = new FakeRuntime()
    const replies: string[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async respondPermission(_id, response) {
        replies.push(response)
      }
    }
    const requestId = 'opencode:native-1:approval:perm-9'
    const base = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win',
      projection: projection({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        status: 'needs-you',
        pendingAttentionCount: 1,
        correlation: {
          ...projection({
            sessionId: 'sess-1',
            terminalId: 'term-1',
            installationId: 'opencode:win'
          }).correlation,
          pendingApprovals: {
            [requestId]: {
              category: 'file-change',
              summary: 'Edit file',
              turnId: 't'
            }
          }
        }
      })
    })
    runtime.upsert(base)
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.deny', { sessionId: 'sess-1', requestId })
    ).resolves.toMatchObject({
      kind: 'json',
      value: { decision: 'denied', remember: false }
    })
    expect(replies).toEqual(['reject'])

    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    await expect(
      plane.handle('session.approve', { sessionId: 'sess-1', requestId })
    ).resolves.toEqual({
      kind: 'json',
      value: {
        sessionId: 'sess-1',
        requestId,
        decision: 'approved',
        already: true,
        remember: false
      }
    })
    expect(replies).toEqual(['reject'])
    dispose()
  })

  test('questions list and answer/reject forward the official payload', async () => {
    const runtime = new FakeRuntime()
    const answers: unknown[] = []
    const rejected: string[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return []
      },
      async listQuestions() {
        return [
          {
            id: 'q1',
            sessionID: 'native-1',
            questions: [
              {
                header: 'Which file?',
                question: 'Pick a file',
                options: [{ label: 'a.ts' }]
              }
            ]
          }
        ]
      },
      async answerQuestion(nativeId, payload) {
        answers.push({ nativeId, payload })
      },
      async rejectQuestion(nativeId) {
        rejected.push(nativeId)
      }
    }
    const requestId = 'opencode:native-1:input:q1'
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        projection: projection({
          sessionId: 'sess-1',
          terminalId: 'term-1',
          installationId: 'opencode:win',
          status: 'needs-you',
          pendingAttentionCount: 1,
          correlation: {
            ...projection({
              sessionId: 'sess-1',
              terminalId: 'term-1',
              installationId: 'opencode:win'
            }).correlation,
            pendingInputs: {
              [requestId]: { prompt: 'Which file?', turnId: 't' }
            }
          }
        })
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(
      plane.handle('session.questions', { sessionId: 'sess-1' })
    ).resolves.toEqual({
      kind: 'json',
      value: {
        sessionId: 'sess-1',
        questions: [
          expect.objectContaining({
            requestId,
            summary: 'Which file?'
          })
        ]
      }
    })
    await expect(
      plane.handle('session.answer', {
        sessionId: 'sess-1',
        requestId,
        json: '{"answers":[["a.ts"]]}'
      })
    ).resolves.toMatchObject({
      kind: 'json',
      value: { sessionId: 'sess-1', requestId, answered: true }
    })
    expect(answers).toEqual([
      { nativeId: 'q1', payload: { answers: [['a.ts']] } }
    ])
    await expect(
      plane.handle('session.reject-question', { sessionId: 'sess-1', requestId })
    ).resolves.toMatchObject({
      kind: 'json',
      value: { rejected: true }
    })
    expect(rejected).toEqual(['q1'])
    dispose()
  })

  test('wait returns the first matching watch event then completes', async () => {
    const runtime = new FakeRuntime()
    let snapshot: unknown[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const item = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win'
    })
    runtime.upsert(item)
    const { plane, dispose } = planeHarness({ runtime })
    const waiting = plane.handle('session.wait', {
      sessionId: 'sess-1',
      until: 'turn'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'go' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', id: 't1', text: 'done' }]
      }
    ]
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'working' }
    })
    runtime.upsert({
      ...item,
      projection: {
        ...item.projection,
        status: 'done',
        statusConfidence: 'high'
      }
    })
    await expect(waiting).resolves.toEqual({
      kind: 'json',
      value: expect.objectContaining({
        type: 'turn',
        sessionId: 'sess-1',
        delta: expect.objectContaining({ text: 'done' })
      })
    })
    dispose()
  })

  test('wait does not treat an idle empty snapshot as a turn', async () => {
    const runtime = new FakeRuntime()
    let snapshot: unknown[] = []
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const item = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win',
      projection: projection({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        status: 'working'
      })
    })
    runtime.upsert(item)
    const { plane, dispose } = planeHarness({ runtime })
    const waiting = plane.handle('session.wait', {
      sessionId: 'sess-1',
      until: 'turn'
    })
    runtime.upsert({
      ...item,
      projection: {
        ...item.projection,
        status: 'idle',
        statusConfidence: 'high'
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'go' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', id: 't1', text: 'pong' }]
      }
    ]
    runtime.upsert({
      ...item,
      projection: { ...item.projection, status: 'working' }
    })
    runtime.upsert({
      ...item,
      projection: {
        ...item.projection,
        status: 'done',
        statusConfidence: 'high'
      }
    })
    await expect(waiting).resolves.toEqual({
      kind: 'json',
      value: expect.objectContaining({
        type: 'turn',
        delta: expect.objectContaining({ text: 'pong' })
      })
    })
    dispose()
  })

  test('wait still sees a turn that finished while the subscriber was priming', async () => {
    const runtime = new FakeRuntime()
    const snapshot = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'go' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', id: 't1', text: 'pong' }]
      }
    ]
    runtime.control = {
      async submitPrompt() {},
      async snapshotMessages() {
        return snapshot
      }
    }
    const item = record({
      sessionId: 'sess-1',
      terminalId: 'term-1',
      installationId: 'opencode:win',
      projection: projection({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win',
        status: 'working'
      })
    })
    runtime.upsert(item)
    const { plane, dispose } = planeHarness({ runtime })
    const waiting = plane.handle('session.wait', {
      sessionId: 'sess-1',
      until: 'turn'
    })
    runtime.upsert({
      ...item,
      projection: {
        ...item.projection,
        status: 'idle',
        statusConfidence: 'high'
      }
    })
    await expect(waiting).resolves.toEqual({
      kind: 'json',
      value: expect.objectContaining({
        type: 'turn',
        delta: expect.objectContaining({ text: 'pong' })
      })
    })
    dispose()
  })

  test('CLI prints JSON and fails closed without GBC or token', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const missing = await runGbcCli(['sessions'], {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      socketPath: join(tmpdir(), `gbc-missing-${Date.now()}.sock`),
      userDataDir: mkdtempSync(join(tmpdir(), 'gbc-empty-'))
    })
    expect(missing).toBe(2)
    expect(stderr.join('')).toMatch(/Grok Build Center is not running/)

    const dir = mkdtempSync(join(tmpdir(), 'gbc-token-'))
    writeFileSync(join(dir, 'bridge.token'), `${'ab'.repeat(32)}\n`)
    const { plane, runtime } = planeHarness({})
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    const server = new BridgeServer({
      userDataDir: dir,
      plane,
      socketPath:
        process.platform === 'win32'
          ? `\\\\.\\pipe\\gbc-bridge-test-${Date.now()}`
          : join(dir, 'bridge.sock')
    })
    const socketPath = await server.start()
    stdout.length = 0
    stderr.length = 0
    const denied = await runGbcCli(['sessions'], {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      socketPath,
      token: '00'.repeat(32),
      userDataDir: dir
    })
    expect(denied).toBe(2)
    expect(stdout.join('')).toMatch(/unauthorized|Invalid bridge token/)

    stdout.length = 0
    const renamed = await runGbcCli(['session', 'rename', 'sess-1', 'x'], {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
      socketPath,
      userDataDir: dir
    })
    expect(renamed).toBe(0)
    expect(stdout.join('')).toMatch(/"name": "x"/)
    await server.stop()
    plane.dispose()
  })

  test('message snapshot prefers last closed turn and ignores reasoning', () => {
    const messages = parseOpenCodeMessages([
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'hi' }]
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [
          { type: 'reasoning', text: 'hidden' },
          { type: 'text', id: 'p1', text: 'hello' },
          {
            type: 'tool',
            callID: 'c1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: 'a' }
          }
        ]
      }
    ])
    const delta = extractLastClosedTurn(messages)
    expect(delta.text).toBe('hello')
    expect(delta.tools).toEqual([
      { name: 'bash', callId: 'c1', input: { command: 'ls' }, output: 'a' }
    ])
    expect(JSON.stringify(delta)).not.toContain('hidden')
    const first = extractSinceCursor(messages, undefined)
    const again = extractSinceCursor(messages, first.cursor)
    expect(again.delta.text).toBe('')
    expect(again.delta.tools).toEqual([])
  })

  test('truncates oversized deltas and keeps a request id out of band', () => {
    const huge = 'x'.repeat(80 * 1024)
    const delta = truncateDelta({
      text: huge,
      tools: Array.from({ length: 80 }, (_, index) => ({
        name: 'bash',
        callId: `c${index}`,
        input: { blob: 'y'.repeat(40 * 1024) }
      }))
    })
    expect(delta.truncated).toBe(true)
    expect(delta.tools.length).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(JSON.stringify(delta), 'utf8')).toBeLessThanOrEqual(
      256 * 1024
    )
  })

  test('projector locks writes to the current root native session', () => {
    const projector = new OpenCodeEventProjector()
    projector.project({
      type: 'session-created',
      nativeType: 'session.created',
      info: { id: 'root-1' }
    })
    projector.project({
      type: 'session-created',
      nativeType: 'session.created',
      info: { id: 'child-1', parentId: 'root-1' }
    })
    expect(projector.currentRootSessionId()).toBe('root-1')
    projector.project({
      type: 'session-created',
      nativeType: 'session.created',
      info: { id: 'root-2' }
    })
    expect(projector.currentRootSessionId()).toBe('root-2')
  })

  test('submit prefers TUI append/submit so the visible pane updates', async () => {
    const seen: string[] = []
    const transport = {
      async request(method: 'GET' | 'POST' | 'PATCH', path: string) {
        seen.push(`${method} ${path}`)
        return null
      }
    }
    await submitOpenCodePrompt(transport, async () => 'native-1', 'hello')
    expect(seen).toEqual([
      'POST /tui/clear-prompt',
      'POST /tui/append-prompt',
      'POST /tui/submit-prompt'
    ])
  })

  test('submit falls back to session prompt when TUI routes are missing', async () => {
    const seen: string[] = []
    const transport = {
      async request(method: 'GET' | 'POST' | 'PATCH', path: string) {
        seen.push(`${method} ${path}`)
        if (path.startsWith('/tui/')) {
          throw new OpenCodeTransportError('http-status', 'missing', 404)
        }
        return null
      }
    }
    await submitOpenCodePrompt(transport, async () => 'native-1', 'hello', 'plan')
    expect(seen).toEqual([
      'POST /tui/clear-prompt',
      'POST /session/native-1/prompt_async'
    ])
  })

  test('host transport POST/GET talk to the TUI loopback server', async () => {
    const seen: Array<{ method?: string; url?: string; body: string }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8')
        })
        if (req.url === '/session/abc/prompt_async') {
          res.statusCode = 204
          res.end()
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify([{ info: { id: 'm1', role: 'assistant' }, parts: [] }]))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    const transport = new HostOpenCodeTransport(`http://127.0.0.1:${port}`)
    await expect(
      transport.request('POST', '/session/abc/prompt_async', {
        parts: [{ type: 'text', text: 'hi' }]
      })
    ).resolves.toBeNull()
    await expect(transport.request('GET', '/session/abc/message')).resolves.toEqual([
      { info: { id: 'm1', role: 'assistant' }, parts: [] }
    ])
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/session/abc/prompt_async'
    })
    expect(seen[0].body).toContain('hi')
    await transport.dispose()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })

  test('New Session UI was not given model or plan/build pickers', () => {
    const source = readFileSync(
      join(__dirname, '../src/app/NewSessionFlow.tsx'),
      'utf8'
    )
    expect(source).not.toMatch(/plan\s*\|\s*build|model picker|--agent|provider\/model/)
    expect(source).toContain('onLaunchCli')
  })

  test('close stops an OpenCode session and drops it from the list', async () => {
    const runtime = new FakeRuntime()
    runtime.upsert(
      record({
        sessionId: 'sess-1',
        terminalId: 'term-1',
        installationId: 'opencode:win'
      })
    )
    const { plane, dispose } = planeHarness({ runtime })
    await expect(plane.close({ sessionId: 'sess-1' })).resolves.toEqual({
      sessionId: 'sess-1',
      closed: true
    })
    await expect(plane.sessions()).resolves.toEqual([])
    await expect(plane.close({ sessionId: 'sess-1' })).rejects.toThrow(
      /not found/
    )
    dispose()
  })

  test('sessions 列出全部 adapter，并用 controllable 区分能不能原生控制', async () => {
    const runtime = new FakeRuntime()
    // 只有 oc-1 有控制面：这正是 `controllable` 要表达的东西。
    runtime.controlBySession = new Map([
      [
        'oc-1',
        {
          async submitPrompt() {},
          async snapshotMessages() {
            return []
          }
        } as unknown as ObserverControl
      ]
    ])
    runtime.upsert(
      record({
        sessionId: 'oc-1',
        terminalId: 't1',
        installationId: 'opencode:win'
      })
    )
    runtime.upsert({
      ...record({
        sessionId: 'codex-1',
        terminalId: 't2',
        installationId: 'codex:win'
      }),
      adapterId: 'codex'
    })
    const { plane, dispose } = planeHarness({ runtime })
    // 曾经这里只列 opencode。放宽是有意的：从飞书要看得到「那场 grok 卡在等你」，
    // 所以改成全列 + `controllable` 标出能力差异，而不是干脆不列。
    await expect(plane.sessions()).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'oc-1',
        installationId: 'opencode:win',
        adapterId: 'opencode',
        controllable: true,
        runtime: { kind: 'host', platform: 'windows' }
      }),
      expect.objectContaining({
        sessionId: 'codex-1',
        adapterId: 'codex',
        controllable: false
      })
    ])
    dispose()
  })

  test('sessions.history 只给顶层会话，并标出不能恢复的原因', async () => {
    const { plane, dispose } = planeHarness({
      // 时间各不相同，免得排序落到 localeCompare 上（那样断言就只是碰运气）
      history: [
        historySession({
          agent: 'grok',
          id: 'g-live',
          title: '在跑的',
          updatedAt: '2026-09-05T00:00:00.000Z'
        }),
        // 没记工作目录：桥这边必须判死（App 里还能让人自己挑目录，桥没有这个人）
        historySession({
          agent: 'grok',
          id: 'g-nocwd',
          title: '没目录的',
          cwd: '',
          updatedAt: '2026-09-04T00:00:00.000Z'
        }),
        // 没实测过恢复命令的 CLI
        historySession({
          agent: 'kimi',
          id: 'k-1',
          title: 'kimi 的',
          updatedAt: '2026-09-03T00:00:00.000Z'
        }),
        historySession({
          agent: 'grok',
          id: 'g-sub',
          title: '子代理',
          subagent: true,
          updatedAt: '2026-09-02T00:00:00.000Z'
        }),
        historySession({
          agent: 'codex',
          id: 'c-arch',
          title: '归档的',
          archived: true,
          updatedAt: '2026-09-01T00:00:00.000Z'
        }),
        historySession({
          agent: 'codex',
          id: 'c-1',
          title: 'codex 的',
          updatedAt: '2026-08-31T00:00:00.000Z'
        })
      ]
    })

    // 子代理与归档默认不列（口径与 App 内会话历史页一致），最新的排最前。
    // 「没目录的」仍然会列出来 —— 它是顶层会话，只是 `resumable=false`。
    const listed = await plane.history({})
    expect(listed.map((item) => item.sessionId)).toEqual(['g-live', 'g-nocwd', 'k-1', 'c-1'])
    expect(listed.filter((item) => item.resumable).map((item) => item.sessionId)).toEqual([
      'g-live',
      'c-1'
    ])
    expect(listed.find((item) => item.sessionId === 'k-1')).toMatchObject({
      resumable: false,
      blockedCode: 'no-resume-command'
    })
    expect(listed.find((item) => item.sessionId === 'g-live')).toMatchObject({
      resumable: true,
      updatedAt: '2026-09-05T00:00:00.000Z',
      workspace: 'C:\\work'
    })
    expect(listed.find((item) => item.sessionId === 'g-live')?.blockedCode).toBeUndefined()

    const withHidden = await plane.history({ includeHidden: true })
    expect(withHidden.map((item) => item.sessionId)).toHaveLength(6)

    const noWorkspace = await plane.history({ query: '没目录' })
    expect(noWorkspace).toEqual([
      expect.objectContaining({
        sessionId: 'g-nocwd',
        workspace: '',
        resumable: false,
        blockedCode: 'no-workspace',
        // 文案必须说清「去 App 里恢复」，否则用户只会看到一个没有出路的拒绝
        blockedReason: expect.stringContaining('App')
      })
    ])

    // 目录也参与搜索：想续的往往是「那个在某项目里跑的会话」，项目名有时只在 cwd 里。
    // 命中的是 g-live / k-1 / c-1 三场（g-nocwd 没目录，另外两场被默认过滤掉）。
    await expect(plane.history({ query: 'c:\\work' })).resolves.toHaveLength(3)
    await expect(plane.history({ agent: 'codex' })).resolves.toHaveLength(1)
    await expect(plane.history({ limit: 2 })).resolves.toHaveLength(2)
    // 打错的 agent 要立刻报错，不能安静地返回空列表（会被读成「本机没装这个 CLI」）
    await expect(plane.history({ agent: 'gork' })).rejects.toThrow(/agent must be one of/)
    dispose()
  })

  test('session.resume --dry-run 只算参数、不起任何进程', async () => {
    const { plane, launched, dispose } = planeHarness({
      installations: [hostInstall('opencode:win')],
      extraClis: [{ id: 'grok', installations: [hostInstallFor('grok', 'grok:win')] }],
      history: [
        historySession({ agent: 'grok', id: '01a0ce08-1111-2222-3333-444455556666' })
      ]
    })
    await expect(
      plane.resume({ sessionId: '01a0ce08-1111-2222-3333-444455556666', dryRun: true })
    ).resolves.toEqual({
      historySessionId: '01a0ce08-1111-2222-3333-444455556666',
      agent: 'grok',
      workspace: 'C:\\work',
      installationId: 'grok:win',
      args: ['--resume', '01a0ce08-1111-2222-3333-444455556666'],
      dryRun: true,
      terminalId: null,
      sessionId: null
    })
    // 这是本机做只读验证的抓手：dry-run 必须一个进程都不起
    expect(launched).toHaveLength(0)
    dispose()
  })

  test('session.resume 起终端、带上 adapterId，并把新 sessionId 还回去', async () => {
    const { plane, launched, dispose } = planeHarness({
      extraClis: [{ id: 'claude', installations: [hostInstallFor('claude', 'claude:win')] }],
      history: [historySession({ agent: 'claude', id: 'claude-sess-9', title: '旧对话' })]
    })
    const result = await plane.resume({ sessionId: 'claude-sess-9' })
    expect(result).toMatchObject({
      historySessionId: 'claude-sess-9',
      agent: 'claude',
      installationId: 'claude:win',
      args: ['--resume', 'claude-sess-9'],
      dryRun: false
    })
    expect(result.terminalId).toBeTruthy()
    // 新终端必须在 runtime 里登记上，否则调用方没法对它 watch/send
    expect(result.sessionId).toBe('sess-1')
    expect(launched).toHaveLength(1)
    expect(launched[0].adapterId).toBe('claude')
    expect(launched[0].name).toBe('旧对话')
    expect(launched[0].selection).toEqual({
      installationId: 'claude:win',
      workspace: 'C:\\work',
      args: ['--resume', 'claude-sess-9']
    })
    dispose()
  })

  test('session.resume 拒绝恢复不了的会话，而不是静默落到别的目录', async () => {
    const { plane, launched, dispose } = planeHarness({
      extraClis: [{ id: 'grok', installations: [hostInstallFor('grok', 'grok:win')] }],
      history: [
        historySession({ agent: 'grok', id: 'g-nocwd', cwd: '' }),
        historySession({ agent: 'kimi', id: 'k-1' })
      ]
    })
    // 空 cwd 是这里最要命的一条：resolveWorkspace('') 的语义是 Home，
    // 放过去就是在 Home 里静默起一个会话。
    await expect(plane.resume({ sessionId: 'g-nocwd' })).rejects.toThrow(/工作目录/)
    await expect(plane.resume({ sessionId: 'k-1' })).rejects.toThrow(/没实测过/)
    await expect(plane.resume({ sessionId: 'nope' })).rejects.toThrow(/not found/)
    expect(launched).toHaveLength(0)
    dispose()
  })

  test('session.send 对没有控制面的会话退化成往 PTY 写一行', async () => {
    const writes: { terminalId: string; data: string }[] = []
    const runtime = new FakeRuntime()
    runtime.upsert({
      ...record({ sessionId: 'grok-1', terminalId: 't9', installationId: 'grok:win' }),
      adapterId: 'grok',
      projection: {
        ...record({ sessionId: 'grok-1', terminalId: 't9', installationId: 'grok:win' })
          .projection,
        status: 'done'
      }
    })
    const { plane, dispose } = planeHarness({
      runtime,
      writeTerminal: (terminalId, data) => {
        writes.push({ terminalId, data })
        return true
      }
    })

    // 多行必须折成一行：TUI 的输入框是单行提交的，第一个换行会把半句话发出去
    await expect(
      plane.send({ sessionId: 'grok-1', text: '第一行\n第二行\r\n第三行' })
    ).resolves.toEqual({ accepted: true, mode: 'terminal' })
    expect(writes).toEqual([{ terminalId: 't9', data: '第一行 第二行 第三行\r' }])
    dispose()
  })

  test('session.send 的两条通道共用同一个状态闸门', async () => {
    const writes: string[] = []
    const runtime = new FakeRuntime()
    for (const status of ['working', 'needs-you'] as const) {
      const base = record({
        sessionId: `grok-${status}`,
        terminalId: `t-${status}`,
        installationId: 'grok:win'
      })
      runtime.upsert({
        ...base,
        adapterId: 'grok',
        projection: { ...base.projection, status }
      })
    }
    const { plane, dispose } = planeHarness({
      runtime,
      writeTerminal: (_terminalId, data) => {
        writes.push(data)
        return true
      }
    })
    // working：打字会塞进正在跑的那一轮。
    // needs-you：TUI 显示的是确认框，它要的是 y/n，不是一句话。
    await expect(plane.send({ sessionId: 'grok-working', text: 'hi' })).rejects.toThrow(
      /Cannot send while session is working/
    )
    await expect(plane.send({ sessionId: 'grok-needs-you', text: 'hi' })).rejects.toThrow(
      /Cannot send while session is needs-you/
    )
    expect(writes).toEqual([])
    dispose()
  })

  test('session.send 在终端已经没了时如实报错', async () => {
    const runtime = new FakeRuntime()
    const base = record({ sessionId: 'grok-1', terminalId: 't9', installationId: 'grok:win' })
    runtime.upsert({
      ...base,
      adapterId: 'grok',
      projection: { ...base.projection, status: 'idle' }
    })
    const { plane, dispose } = planeHarness({
      runtime,
      // PTYManager.write 找不到 pty 时是静默 return 的，所以这里必须由实现方
      // 断言存活 —— 返回 false 就是「没写进去」，不能当成功。
      writeTerminal: () => false
    })
    await expect(plane.send({ sessionId: 'grok-1', text: 'hi' })).rejects.toThrow(
      /no longer running/
    )
    dispose()
  })

  test('session.send 在没接终端通道的构建里报 uncontrolled', async () => {
    const runtime = new FakeRuntime()
    const base = record({ sessionId: 'grok-1', terminalId: 't9', installationId: 'grok:win' })
    runtime.upsert({
      ...base,
      adapterId: 'grok',
      projection: { ...base.projection, status: 'idle' }
    })
    const { plane, dispose } = planeHarness({ runtime })
    await expect(plane.send({ sessionId: 'grok-1', text: 'hi' })).rejects.toThrow(
      /cannot write to its terminal/
    )
    dispose()
  })

  test('session.send 不往「还没输出过任何东西」的终端打字', async () => {
    const writes: string[] = []
    const runtime = new FakeRuntime()
    const base = record({ sessionId: 'grok-1', terminalId: 't9', installationId: 'grok:win' })
    runtime.upsert({
      ...base,
      adapterId: 'grok',
      // 刚 spawn 出来的终端就是这个样子：状态已经是 idle，但 CLI 界面还没画出来
      projection: { ...base.projection, status: 'idle' }
    })
    const { plane, dispose } = planeHarness({
      runtime,
      writeTerminal: (_terminalId, data) => {
        writes.push(data)
        return true
      },
      terminalReady: () => false
    })
    // 界面都没画出来就打字是没有意义的：里面那程序还没起来。
    // （注意别把这条当成「吞字」的解药 —— 那次吞字至今没复现，见协议注释。）
    await expect(plane.send({ sessionId: 'grok-1', text: 'hi' })).rejects.toThrow(
      /has not produced any output yet/
    )
    expect(writes).toEqual([])
    // 会话列表里也要能看出来，否则调用方无从判断该不该等
    await expect(plane.sessions()).resolves.toEqual([
      expect.objectContaining({ sessionId: 'grok-1', ready: false, controllable: false })
    ])
    dispose()
  })

  test('terminalReady 缺省时不假装知道，照常放行', async () => {
    const writes: string[] = []
    const runtime = new FakeRuntime()
    const base = record({ sessionId: 'grok-1', terminalId: 't9', installationId: 'grok:win' })
    runtime.upsert({
      ...base,
      adapterId: 'grok',
      projection: { ...base.projection, status: 'idle' }
    })
    const { plane, dispose } = planeHarness({
      runtime,
      writeTerminal: (_terminalId, data) => {
        writes.push(data)
        return true
      }
    })
    await expect(plane.send({ sessionId: 'grok-1', text: 'hi' })).resolves.toEqual({
      accepted: true,
      mode: 'terminal'
    })
    expect(writes).toEqual(['hi\r'])
    await expect(plane.sessions()).resolves.toEqual([
      expect.objectContaining({ sessionId: 'grok-1', ready: true })
    ])
    dispose()
  })

  test('session.close / rename 对没有控制面的会话照样有效', async () => {
    const runtime = new FakeRuntime()
    runtime.upsert({
      ...record({ sessionId: 'grok-1', terminalId: 't9', installationId: 'grok:win' }),
      adapterId: 'grok'
    })
    const { plane, dispose } = planeHarness({ runtime })

    // 从飞书看见一场 grok 卡住了、想关掉它 —— 这条路径不需要任何私有控制面，
    // 所以不该因为 adapter 不是 opencode 就拒绝（那等于能看见、关不掉）。
    const renamed = await plane.rename({ sessionId: 'grok-1', name: '飞书改的名' })
    expect(renamed).toMatchObject({ sessionId: 'grok-1', name: '飞书改的名' })
    // OpenCode 那份标题改不了：只报告，不算失败
    expect(renamed.titleUpdated).toBe(false)
    expect(renamed.error?.message).toBeTruthy()

    await expect(plane.close({ sessionId: 'grok-1' })).resolves.toEqual({
      sessionId: 'grok-1',
      closed: true
    })
    await expect(plane.sessions()).resolves.toEqual([])
    await expect(plane.close({ sessionId: 'grok-1' })).rejects.toThrow(/not found/)
    dispose()
  })

  test('title, permission and question helpers hit official OpenCode write paths', async () => {
    const seen: Array<{ method: string; path: string; body?: unknown }> = []
    const transport = {
      async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
        seen.push({ method, path, body })
        if (path === '/session/native-1') return { id: 'native-1', agent: 'plan' }
        if (path === '/question') {
          return [{ id: 'q1', sessionID: 'native-1', questions: [{ header: 'Pick' }] }]
        }
        return null
      }
    }
    await setOpenCodeTitle(transport, async () => 'native-1', '补测试')
    await respondOpenCodePermission(transport, async () => 'native-1', 'perm-9', 'once')
    await setOpenCodeAgent(transport, async () => 'native-1', 'plan')
    await expect(listOpenCodeQuestions(transport, async () => 'native-1')).resolves.toEqual([
      { id: 'q1', sessionID: 'native-1', questions: [{ header: 'Pick' }] }
    ])
    await answerOpenCodeQuestion(transport, async () => 'native-1', 'q1', {
      answers: [['a']]
    })
    await rejectOpenCodeQuestion(transport, async () => 'native-1', 'q1')
    expect(seen).toEqual(
      expect.arrayContaining([
        {
          method: 'PATCH',
          path: '/session/native-1',
          body: { title: '补测试' }
        },
        {
          method: 'POST',
          path: '/session/native-1/permissions/perm-9',
          body: { response: 'once' }
        },
        {
          method: 'POST',
          path: '/question/q1/reply',
          body: { answers: [['a']] }
        },
        {
          method: 'POST',
          path: '/question/q1/reject',
          body: undefined
        }
      ])
    )
    expect(
      seen.some(
        (item) =>
          item.path.includes('/agent') || item.path === '/tui/execute-command'
      )
    ).toBe(true)
  })

  test('question helpers skip SPA HTML and use /question routes', async () => {
    const seen: string[] = []
    const transport = {
      async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
        seen.push(`${method} ${path}`)
        if (path.startsWith('/session/')) {
          throw new OpenCodeTransportError(
            'not-api',
            'OpenCode returned HTML instead of an API payload',
            404
          )
        }
        if (path === '/question') {
          return [
            {
              id: 'q1',
              sessionID: 'native-1',
              questions: [{ header: 'fruit', question: 'Which fruit?' }]
            }
          ]
        }
        return body ?? true
      }
    }
    await expect(
      listOpenCodeQuestions(transport, async () => 'native-1')
    ).resolves.toEqual([
      {
        id: 'q1',
        sessionID: 'native-1',
        questions: [{ header: 'fruit', question: 'Which fruit?' }]
      }
    ])
    await answerOpenCodeQuestion(transport, async () => 'native-1', 'q1', {
      answers: [['apple']]
    })
    expect(seen).toContain('GET /question')
    expect(seen).toContain('POST /question/q1/reply')
    expect(seen).not.toContain('POST /session/native-1/question/q1/reply')
  })
})
