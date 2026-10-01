/**
 * 从一条历史会话「接着干」—— 各 CLI 的恢复命令。
 *
 * 为什么恢复不需要新的启动机制：它本质上就是**一个新会话**，只是
 *   args 里写着 resume、workspace 是那场会话原来的目录。
 * 所以调用方只需要把参数拼出来，剩下交给现有的 `launchCli` 走完整链路
 * （解析安装 → 注入 adapter 的 hook/env → 起 PTY → 建 terminal 条目）。
 * 这也是为什么这个文件放在 `shared/`：拼参数的是渲染进程。
 *
 * ⚠️ 只收录**在本机用 `--help` 实测过**的命令。没装、或者命令行为没验证过的
 * agent 一律不在这里出现，UI 会因此不给按钮 —— 猜一个参数让人点下去，
 * 结果是在错误目录里起了一个新会话、还消费了一次额度，比没有按钮糟得多。
 *
 * 实测来源（2026-09-30，本机）：
 *   grok   `-r, --resume [<SESSION_ID_OR_TITLE>]`  必须传 UUID：
 *          非 UUID 会**按标题匹配且限定当前目录**，重名时还会 ambiguous 直接失败。
 *   codex  `codex resume <id>`（子命令；不带 id 会出交互选择器，没法脚本化）
 *   claude `-r, --resume [value]`（value 即 session id）
 *
 * 暂缺（未实测，不要照抄别处的写法）：
 *   opencode / kimi / pi / antigravity —— 本机没装或探针失败，
 *   `antigravity` 还有一层：它 IDE 那侧的会话本来就不可恢复（见 readers/antigravity.ts）。
 *
 * 待办（都不影响现在能用）：
 *   - grok 的 `--restore-code` 会连仓库快照一起还原（远程会话要求配合 `--worktree`），
 *     以后可以做成一个「连代码一起还原」的选项。
 *   - `--fork-session` 已确认存在，可以做成「从这里分叉」的第二个入口。
 */
import type { AgentId, HistorySession } from './session-history'

export interface ResumeSpec {
  /** 启动扫描里该 CLI 的 definition.id（`CliScanReport.launchable[].definition.id`）。 */
  cliId: string
  /**
   * 拼恢复参数。传的是 session id 而不是标题，理由见文件头。
   * `model` 给定时追加 `--model <m>` —— 三个已收录 CLI 的 `--help` 都实测有
   * 这面旗（2026-10-01：grok `-m, --model`、codex `resume -m, --model`、
   * claude `--model`，claude 的别名 sonnet/opus/haiku 就写在帮助文本里）。
   */
  args: (sessionId: string, model?: string) => string[]
}

const withModel = (base: (sessionId: string) => string[], sessionId: string, model?: string): string[] => {
  const argv = base(sessionId)
  return model && model.trim() ? [...argv, '--model', model.trim()] : argv
}

const SPECS: Partial<Record<AgentId, ResumeSpec>> = {
  grok: {
    cliId: 'grok',
    args: (sessionId, model) =>
      withModel((id) => ['--resume', id], sessionId, model)
  },
  codex: {
    cliId: 'codex',
    args: (sessionId, model) =>
      withModel((id) => ['resume', id], sessionId, model)
  },
  claude: {
    cliId: 'claude',
    args: (sessionId, model) =>
      withModel((id) => ['--resume', id], sessionId, model)
  }
}

export type ResumeBlocker =
  /** 该 agent 没有实测过的恢复命令。 */
  | 'no-resume-command'
  /** 会话没有可用的 id。 */
  | 'no-session-id'
  /** 子代理会话：它属于另一场会话，单独恢复没有意义。 */
  | 'subagent'

export type ResumePlan =
  | { ok: true; cliId: string; args: string[] }
  | { ok: false; blocker: ResumeBlocker }

/**
 * 这场会话能不能恢复、参数是什么。只判断「会话本身」的条件；
 * 「这个 CLI 在这台机器上装了没」由调用方拿启动扫描的结果另行判断 ——
 * 那个会随机器变化，不该埋在纯函数里。
 * `model` 可选：指定时恢复命令带上 `--model`（见 ResumeSpec.args）。
 */
export function planResume(session: HistorySession, model?: string): ResumePlan {
  if (session.subagent) return { ok: false, blocker: 'subagent' }
  if (!session.id.trim()) return { ok: false, blocker: 'no-session-id' }
  const spec = SPECS[session.agent]
  if (!spec) return { ok: false, blocker: 'no-resume-command' }
  return { ok: true, cliId: spec.cliId, args: spec.args(session.id, model) }
}

/** 渲染进输入框时用的形式。参数里可能有空格，所以顺手加引号。 */
export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(' ')
}
