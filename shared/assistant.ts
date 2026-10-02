/**
 * AI 助手（会话历史智能查找）契约。
 *
 * GBC 自己不内置任何模型 —— 用户在设置里配一个 OpenAI 兼容端点
 * （baseURL + apiKey + model），主进程拿它做唯一一次 LLM 调用：
 * 把会话清单（元数据，不含正文）发给模型，让它挑出命中场次并给一句人话结论。
 *
 * 安全边界：
 * - apiKey 只存主进程侧 userData，永不回传渲染进程（GetConfig 返回 masked）。
 * - 会话正文（如果有）从不离开本机；发给模型的是标题/cwd/模型名等元数据。
 * - 主进程对会话数据永远只读：删除 = 移入系统回收站（可恢复）或本机视图隐藏，
 *   绝不写各 agent 的数据目录。
 */

export const AssistantInvokeChannel = {
  GetConfig: 'assistant:get-config',
  SaveConfig: 'assistant:save-config',
  TestConfig: 'assistant:test-config',
  Search: 'assistant:search'
} as const

export interface AssistantConfigInput {
  /** OpenAI 兼容端点根，如 `https://api.example.com/v1`。 */
  baseURL: string
  apiKey: string
  model: string
  enabled: boolean
}

export interface AssistantConfigStatus {
  baseURL: string
  model: string
  enabled: boolean
  /** 有没有配 key（true = 已配置）。明文永不回传。 */
  hasApiKey: boolean
  /** 回显用掩码，如 `sk-***abc1`。未配置时为 null。 */
  apiKeyMasked: string | null
}

export interface AssistantSearchRequest {
  query: string
  /**
   * 多轮对话：渲染进程带上最近几轮（最老在前）。主进程裁剪到 6 轮。
   * 只透传文本，不透传其它角色内容。
   */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface AssistantSearchResponse {
  ok: boolean
  /** 模型给的人话结论（已按配置语言回答，默认中文）。 */
  answer: string
  /** 命中场次，key = `${agent}:${id}`，与会话历史页行 key 同构。 */
  sessionKeys: string[]
  tookMs: number
  /** 失败时的机器可读码：not_configured / http_<status> / bad_response / timeout */
  errorCode?: string
  errorMessage?: string
}

export interface AssistantTestResult {
  ok: boolean
  /** 简短回显，如 `gpt-4o · 200 OK`。失败时是人话原因。 */
  message: string
}

export interface AssistantApi {
  getConfig: () => Promise<AssistantConfigStatus>
  /** 传 apiKey 为空字符串 = 不修改现有 key。 */
  saveConfig: (config: AssistantConfigInput) => Promise<AssistantConfigStatus>
  testConfig: () => Promise<AssistantTestResult>
  search: (request: AssistantSearchRequest) => Promise<AssistantSearchResponse>
}
