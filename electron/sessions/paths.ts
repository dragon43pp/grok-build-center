/**
 * Where each CLI keeps its history on this machine.
 *
 * Every agent gets its own env override because people move these directories
 * (this machine has `~/.grok` and `~/.codex` as symlinks onto another drive),
 * and because a reader that cannot be pointed at a fixture is not testable.
 *
 * Precedence is always: explicit ReaderContext root > documented env var >
 * default. Nothing here touches the filesystem except Pi, which reads its own
 * `settings.json` the same way Pi itself does.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJson, resolveDir } from './fsUtil'

const home = homedir()

/** `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/` */
export function grokHome(): string {
  return resolveDir(process.env.GROK_HOME, join(home, '.grok'))
}

/** `$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl` */
export function claudeConfigDir(): string {
  return resolveDir(process.env.CLAUDE_CONFIG_DIR, join(home, '.claude'))
}

/** `$CODEX_HOME/state_<N>.sqlite` and `$CODEX_HOME/sessions/<Y>/<M>/<D>/` */
export function codexHome(): string {
  return resolveDir(process.env.CODEX_HOME, join(home, '.codex'))
}

/**
 * opencode follows the XDG spec for its data directory, not for its config:
 * `$XDG_DATA_HOME/opencode/opencode.db`, defaulting to `~/.local/share/...`
 * even on Windows.
 */
export function opencodeDataDir(): string {
  const xdg = resolveDir(process.env.XDG_DATA_HOME, join(home, '.local', 'share'))
  return resolveDir(process.env.OPENCODE_DATA_DIR, join(xdg, 'opencode'))
}

// ⚠️ 注释里不能出现 `*/`：`sessions/wd_*/session_*/` 会提前关掉块注释，
// 后半截变成代码（TS2304 "Cannot find name 'session_'"）。用空格断开。
/** `$KIMI_CODE_HOME/sessions/wd_* / session_* /` */
export function kimiCodeHome(): string {
  return resolveDir(process.env.KIMI_CODE_HOME, join(home, '.kimi-code'))
}

/** Pi's own directory: `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`. */
export function piAgentDir(): string {
  return resolveDir(process.env.PI_CODING_AGENT_DIR, join(home, '.pi', 'agent'))
}

/**
 * Pi resolves its session root in three steps, and so do we, in the same order:
 *   1. `$PI_CODING_AGENT_SESSION_DIR`
 *   2. `sessionDir` in `<agent dir>/settings.json`
 *   3. `<agent dir>/sessions`
 *
 * Getting this wrong means silently showing zero sessions, so it is worth the
 * extra file read.
 */
export async function piSessionDir(): Promise<string> {
  const explicit = process.env.PI_CODING_AGENT_SESSION_DIR
  if (explicit && explicit.trim()) return resolveDir(explicit, '')

  const agentDir = piAgentDir()
  const settings = await readJson<{ sessionDir?: unknown }>(
    join(agentDir, 'settings.json')
  )
  const configured = settings?.sessionDir
  if (typeof configured === 'string' && configured.trim()) {
    return resolveDir(configured, join(agentDir, 'sessions'))
  }
  return join(agentDir, 'sessions')
}

/**
 * WorkBuddy 的本机数据目录：`~/.workbuddy/`，会话索引在 `workbuddy.db`。
 * 和 CLI 一样吃环境变量覆盖，判卷好指 fixture。
 */
export function workbuddyHome(): string {
  return resolveDir(process.env.WORKBUDDY_HOME, join(home, '.workbuddy'))
}

/** `~/.gemini/` — the parent of both Antigravity stores. */
function geminiDir(): string {
  return resolveDir(process.env.GEMINI_HOME, join(home, '.gemini'))
}

/**
 * `~/.gemini/antigravity-cli/` — the `agy` CLI. This is the store whose
 * sessions can be resumed from a terminal with `agy --conversation <uuid>`.
 */
export function antigravityCliHome(): string {
  return resolveDir(process.env.ANTIGRAVITY_CLI_HOME, join(geminiDir(), 'antigravity-cli'))
}

/**
 * `~/.gemini/antigravity/` — the IDE's own conversations. Same `brain/<uuid>/`
 * layout, but there is no CLI session to resume, so the UI has to tell the two
 * apart. Also the only Antigravity store present on this machine.
 */
export function antigravityIdeHome(): string {
  return resolveDir(process.env.ANTIGRAVITY_IDE_HOME, join(geminiDir(), 'antigravity'))
}

/** Both Antigravity stores, CLI first because it wins on a duplicate id. */
export function antigravityHomes(): string[] {
  return [antigravityCliHome(), antigravityIdeHome()]
}
