/**
 * 设置 → AI 助手：会话历史「AI 查找」的模型配置。
 *
 * 三件套（baseURL / apiKey / model）+ 启用开关 + 测试连接。
 * 密钥只存主进程 userData；回显是掩码，留空保存 = 保留原密钥。
 */
import { useEffect, useState } from 'react'
import { Loader2, PlugZap, Save } from 'lucide-react'
import { useStrings } from './i18n'

interface ConfigStatus {
  baseURL: string
  model: string
  enabled: boolean
  hasApiKey: boolean
  apiKeyMasked: string | null
}

export default function AssistantSettingsSection(): React.JSX.Element {
  const strings = useStrings()
  const t = strings.settings
  const [status, setStatus] = useState<ConfigStatus | null>(null)
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const [testBusy, setTestBusy] = useState(false)
  const [testOk, setTestOk] = useState(false)

  useEffect(() => {
    let alive = true
    void window.assistantApi.getConfig().then((config) => {
      if (!alive) return
      setStatus(config)
      setBaseURL(config.baseURL)
      setModel(config.model)
      setEnabled(config.enabled)
    })
    return () => {
      alive = false
    }
  }, [])

  const save = (): void => {
    if (busy) return
    setBusy(true)
    setSaved(false)
    void window.assistantApi
      .saveConfig({ baseURL, apiKey, model, enabled })
      .then((next) => {
        setStatus(next)
        setApiKey('')
        setSaved(true)
        window.setTimeout(() => setSaved(false), 2000)
      })
      .finally(() => setBusy(false))
  }

  const runTest = (): void => {
    if (testBusy) return
    setTestBusy(true)
    setTestMessage(null)
    // 先落一次盘再测，保证测的就是表单里的值（密钥留空 = 保留旧的）。
    void window.assistantApi
      .saveConfig({ baseURL, apiKey, model, enabled })
      .then((next) => {
        setStatus(next)
        setApiKey('')
        return window.assistantApi.testConfig()
      })
      .then((result) => {
        setTestOk(result.ok)
        setTestMessage(result.message)
      })
      .finally(() => setTestBusy(false))
  }

  const inputClass =
    'h-[30px] w-full rounded-lg border border-border-default bg-input px-2.5 font-maple text-[11px] text-text-secondary outline-none transition-colors placeholder:text-text-faint focus:border-input-focus focus:bg-input-hover'

  return (
    <div data-testid="settings-assistant" className="flex flex-col gap-4 border-b border-border-faint py-3.5">
      <p className="max-w-[720px] font-pingfang text-[11px] leading-5 text-text-faint">
        {t.assistantHint}
      </p>

      <label className="flex flex-col gap-1.5">
        <span className="font-pingfang text-[11px] font-medium text-text-secondary">
          {t.assistantBaseURL}
        </span>
        <input
          type="text"
          data-testid="settings-assistant-baseurl"
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
          placeholder="https://api.example.com/v1"
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-pingfang text-[11px] font-medium text-text-secondary">
          {t.assistantApiKey}
          {status?.hasApiKey && (
            <span className="ml-2 font-maple text-[10px] font-normal text-text-faint">
              {status.apiKeyMasked}
            </span>
          )}
        </span>
        <input
          type="password"
          data-testid="settings-assistant-apikey"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={t.assistantApiKeyKeep}
          autoComplete="off"
          className={inputClass}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-pingfang text-[11px] font-medium text-text-secondary">
          {t.assistantModel}
        </span>
        <input
          type="text"
          data-testid="settings-assistant-model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="gpt-4o / deepseek-chat / …"
          className={inputClass}
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-target items-center gap-1.5 font-pingfang text-[11px] text-text-secondary select-none">
          <input
            type="checkbox"
            data-testid="settings-assistant-enabled"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-3 accent-[var(--gbc-brand,#FF6B4A)]"
          />
          {t.assistantEnabled}
        </label>

        <button
          type="button"
          data-testid="settings-assistant-save"
          disabled={busy}
          onClick={save}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-border-default bg-input px-2.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" strokeWidth={1.75} />
          ) : (
            <Save className="size-3" strokeWidth={1.75} />
          )}
          {saved ? t.assistantSaved : t.assistantSave}
        </button>

        <button
          type="button"
          data-testid="settings-assistant-test"
          disabled={testBusy}
          onClick={runTest}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-border-default bg-input px-2.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {testBusy ? (
            <Loader2 className="size-3 animate-spin" strokeWidth={1.75} />
          ) : (
            <PlugZap className="size-3" strokeWidth={1.75} />
          )}
          {testBusy ? t.assistantTesting : t.assistantTest}
        </button>

        {testMessage && (
          <span
            data-testid="settings-assistant-test-result"
            className={`font-maple text-[10px] ${testOk ? 'text-status-done' : 'text-status-error'}`}
          >
            {testMessage}
          </span>
        )}
      </div>
    </div>
  )
}
