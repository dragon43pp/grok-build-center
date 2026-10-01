import { useEffect, useState } from 'react'
import {
  FEISHU_IDLE_STATUS,
  type FeishuDomain,
  type FeishuStatus
} from '../../shared/ipc-contract'
import { useStrings } from './i18n'
import { feishuPhaseDotClass, feishuPhaseLabel } from './feishuStatusLabel'
import FeishuScanQr from './FeishuScanQr'

/**
 * 飞书设置面板。
 *
 * 结构上和 `RemoteSettingsSection` 一致：**只订阅、不乐观更新**。
 * 主进程每次状态变化都推一份完整快照过来，这里 `setStatus` 就完了 ——
 * 所有按钮的回调也直接把返回的快照塞回去，于是「界面和真实状态不一致」
 * 这类 bug 在结构上就不存在。
 *
 * 「最近事件」那一格是这个面板里最重要的东西：连接状态是 SDK 的一面之词，
 * 而事件到达时间不会骗人 —— 长连接假活（连上了但收不到任何东西）在这里
 * 一眼就能看出来。
 */
export default function FeishuSettingsSection() {
  const strings = useStrings()
  const [status, setStatus] = useState<FeishuStatus>(FEISHU_IDLE_STATUS)
  const [busy, setBusy] = useState(false)
  const [confirmingUnbind, setConfirmingUnbind] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualAppId, setManualAppId] = useState('')
  const [manualAppSecret, setManualAppSecret] = useState('')
  const [manualDomain, setManualDomain] = useState<FeishuDomain>('feishu')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void window.feishuApi.getStatus().then(setStatus)
    return window.feishuApi.onStatusChange(setStatus)
  }, [])

  // 只有等扫码的时候才需要走秒。依赖里刻意只放票上的两个标量：
  // 放整个 scan 对象的话，每一次广播都会重建定时器。
  const scanKey = status.scan?.sessionKey ?? null
  const scanExpiresAt = status.scan?.expiresAt ?? 0
  useEffect(() => {
    if (!scanKey) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [scanKey, scanExpiresAt])

  const run = (action: () => Promise<FeishuStatus>): void => {
    setBusy(true)
    void action()
      .then(setStatus)
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  const bound = status.bound
  const scanning = Boolean(status.scan)
  const secondsLeft = status.scan
    ? Math.max(0, Math.ceil((status.scan.expiresAt - now) / 1000))
    : 0

  const statusText = feishuPhaseLabel(strings, status.phase)

  const statusDotClass = `size-1.5 shrink-0 rounded-full ${feishuPhaseDotClass(
    status.phase
  )}`

  return (
    <div data-testid="settings-feishu">
      <div className="border-b border-border-faint py-3.5">
        <p className="font-pingfang text-[12px] font-medium text-text-secondary">
          {strings.settings.feishuHint}
        </p>
        <div
          data-testid="settings-feishu-metrics"
          className="mt-3 grid grid-cols-[minmax(0,1.35fr)_minmax(110px,0.85fr)_minmax(90px,0.6fr)] overflow-hidden rounded-xl border border-border-faint bg-content"
        >
          <div className="min-w-0 px-3 py-2.5">
            <p className="font-pingfang text-[10px] text-text-faint">
              {strings.settings.feishuStatusLabel}
            </p>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <span
                data-testid="settings-feishu-indicator"
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${statusDotClass}`}
              />
              <p
                data-testid="settings-feishu-status"
                data-feishu-phase={status.phase}
                className={`truncate font-pingfang text-[11px] font-medium ${
                  status.phase === 'error' ? 'text-status-error' : 'text-text-secondary'
                }`}
              >
                {statusText}
                {status.appIdMasked ? ` · ${status.appIdMasked}` : ''}
              </p>
            </div>
          </div>
          <div className="border-l border-border-faint px-3 py-2.5">
            <p className="font-pingfang text-[10px] text-text-faint">
              {strings.settings.feishuLastEventLabel}
            </p>
            <p
              data-testid="settings-feishu-last-event"
              className="mt-1 font-maple text-[11px] font-medium text-text-secondary tabular-nums"
            >
              {status.lastEventAt
                ? new Date(status.lastEventAt).toLocaleTimeString()
                : strings.settings.feishuNever}
            </p>
          </div>
          <div className="border-l border-border-faint px-3 py-2.5">
            <p className="font-pingfang text-[10px] text-text-faint">
              {strings.settings.feishuEventCountLabel}
            </p>
            <p
              data-testid="settings-feishu-event-count"
              className="mt-1 font-maple text-[11px] font-medium text-text-secondary tabular-nums"
            >
              {status.eventCount}
            </p>
          </div>
        </div>

        {status.error && (
          <p
            data-testid="settings-feishu-error"
            className="mt-2 font-pingfang text-[11px] text-status-error"
          >
            {status.error}
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {!bound && !scanning && (
            <button
              type="button"
              data-testid="settings-feishu-scan"
              disabled={busy}
              onClick={() => run(() => window.feishuApi.beginScan())}
              className="cursor-target rounded-lg bg-button-primary px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-button-primary-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              {strings.settings.feishuScan}
            </button>
          )}
          {scanning && (
            <button
              type="button"
              data-testid="settings-feishu-scan-cancel"
              disabled={busy}
              onClick={() => run(() => window.feishuApi.cancelScan())}
              className="cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {strings.settings.feishuScanCancel}
            </button>
          )}
          {bound && !scanning && (
            <button
              type="button"
              data-testid="settings-feishu-reconnect"
              disabled={busy}
              onClick={() => run(() => window.feishuApi.reconnect())}
              className="cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {strings.settings.feishuReconnect}
            </button>
          )}
          {bound && !scanning && (
            <button
              type="button"
              data-testid="settings-feishu-unbind"
              disabled={busy}
              onClick={() => setConfirmingUnbind(true)}
              className="cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {strings.settings.feishuUnbind}
            </button>
          )}
          {!bound && !scanning && (
            <button
              type="button"
              data-testid="settings-feishu-manual-toggle"
              onClick={() => setManualOpen((open) => !open)}
              className="cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"
            >
              {strings.settings.feishuManualToggle}
            </button>
          )}
        </div>
      </div>

      {status.scan && (
        <div className="border-b border-border-faint py-3.5">
          <p className="font-pingfang text-[12px] font-medium text-text-secondary">
            {strings.settings.feishuScanWaiting}
          </p>
          <p className="mt-0.5 font-pingfang text-[11px] text-text-faint">
            {strings.settings.feishuQrHint}
          </p>
          <div className="mt-2">
            <FeishuScanQr url={status.scan.verificationUri} />
          </div>
          <p
            data-testid="settings-feishu-scan-expires"
            className="mt-2 font-maple text-[11px] text-text-faint tabular-nums"
          >
            {strings.settings.feishuScanExpires(secondsLeft)}
          </p>
        </div>
      )}

      {bound && (
        <div className="border-b border-border-faint py-3.5 last:border-b-0">
          <p className="font-pingfang text-[12px] font-medium text-text-secondary">
            {strings.settings.feishuPairedLabel}
            <span
              data-testid="settings-feishu-paired-count"
              className="ml-1.5 font-maple text-[11px] text-text-muted tabular-nums"
            >
              {strings.settings.feishuPairedUnit(status.pairedUserCount)}
            </span>
          </p>
          <p className="mt-0.5 font-pingfang text-[11px] text-text-faint">
            {status.pairedUserCount === 0
              ? strings.settings.feishuPairedNone
              : status.boundAt
                ? strings.settings.feishuBoundAt(
                    new Date(status.boundAt).toLocaleString()
                  )
                : ''}
          </p>
        </div>
      )}

      {/*
        连接成功后的自动引导（多维表格 + 会话历史同步）。
        idle 不渲染 —— 没开始的事不占版面；running/done/failed 各有说法，
        失败时重点是把「缺权限」的直达授权链接顶到用户眼前。
      */}
      {bound && status.provision.state !== 'idle' && (
        <div
          data-testid="settings-feishu-provision"
          className="border-b border-border-faint py-3.5 last:border-b-0"
        >
          <div className="flex items-center gap-1.5">
            <span
              data-testid="settings-feishu-provision-dot"
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${
                status.provision.state === 'running'
                  ? 'animate-pulse bg-status-needs-you'
                  : status.provision.state === 'done'
                    ? 'bg-status-done'
                    : 'bg-status-error'
              }`}
            />
            <p className="font-pingfang text-[12px] font-medium text-text-secondary">
              {strings.settings.feishuProvisionLabel}
            </p>
          </div>

          {status.provision.state === 'running' && (
            <p
              data-testid="settings-feishu-provision-running"
              className="mt-1 font-pingfang text-[11px] text-text-faint"
            >
              {strings.settings.feishuProvisionRunning}
            </p>
          )}

          {status.provision.state === 'done' && (
            <>
              <p
                data-testid="settings-feishu-provision-done"
                className="mt-1 font-pingfang text-[11px] text-text-faint"
              >
                {strings.settings.feishuProvisionDone(
                  status.provision.synced ?? 0
                )}
              </p>
              {status.provision.bitableUrl && (
                <a
                  data-testid="settings-feishu-provision-open"
                  href={status.provision.bitableUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block cursor-target rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted transition-colors hover:bg-input-hover hover:text-text-secondary"
                >
                  {strings.settings.feishuProvisionOpen}
                </a>
              )}
              <p className="mt-1.5 font-pingfang text-[11px] text-text-faint">
                {strings.settings.feishuProvisionNext}
              </p>
            </>
          )}

          {status.provision.state === 'failed' && (
            <>
              <p
                data-testid="settings-feishu-provision-failed"
                className="mt-1 font-pingfang text-[11px] text-status-error"
              >
                {strings.settings.feishuProvisionFailed}
              </p>
              {status.provision.error && (
                <p className="mt-0.5 break-all font-pingfang text-[11px] text-text-faint">
                  {status.provision.error}
                </p>
              )}
              {status.provision.permissionUrl && (
                <>
                  <p className="mt-1.5 font-pingfang text-[11px] text-text-faint">
                    {strings.settings.feishuProvisionPermissionHint}
                  </p>
                  <a
                    data-testid="settings-feishu-provision-permission"
                    href={status.provision.permissionUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block cursor-target rounded-lg bg-button-primary px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-button-primary-fg transition-opacity"
                  >
                    {strings.settings.feishuProvisionPermission}
                  </a>
                </>
              )}
              {status.provision.welcomeError && (
                <p className="mt-1.5 font-pingfang text-[11px] text-text-faint">
                  {strings.settings.feishuProvisionWelcomeFailed}
                  {status.provision.welcomeError}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {manualOpen && !bound && (
        <div className="border-b border-border-faint py-3.5 last:border-b-0">
          <p className="font-pingfang text-[11px] text-text-faint">
            {strings.settings.feishuManualHint}
          </p>
          <label className="mt-2 block font-pingfang text-[11px] text-text-faint">
            {strings.settings.feishuAppId}
            <input
              data-testid="settings-feishu-app-id"
              value={manualAppId}
              onChange={(event) => setManualAppId(event.target.value)}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-primary outline-none focus:border-border-strong"
            />
          </label>
          <label className="mt-2 block font-pingfang text-[11px] text-text-faint">
            {strings.settings.feishuAppSecret}
            <input
              data-testid="settings-feishu-app-secret"
              type="password"
              value={manualAppSecret}
              onChange={(event) => setManualAppSecret(event.target.value)}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-maple text-[12px] text-text-primary outline-none focus:border-border-strong"
            />
          </label>
          <label className="mt-2 block font-pingfang text-[11px] text-text-faint">
            {strings.settings.feishuDomain}
            <select
              data-testid="settings-feishu-domain"
              value={manualDomain}
              onChange={(event) =>
                setManualDomain(event.target.value === 'lark' ? 'lark' : 'feishu')
              }
              className="mt-1 w-full rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[12px] text-text-primary outline-none focus:border-border-strong"
            >
              <option value="feishu">{strings.settings.feishuDomainFeishu}</option>
              <option value="lark">{strings.settings.feishuDomainLark}</option>
            </select>
          </label>
          <button
            type="button"
            data-testid="settings-feishu-bind"
            disabled={busy || !manualAppId.trim() || !manualAppSecret.trim()}
            onClick={() =>
              run(() =>
                window.feishuApi.bindManual({
                  appId: manualAppId,
                  appSecret: manualAppSecret,
                  domain: manualDomain
                })
              )
            }
            className="mt-2.5 cursor-target rounded-lg bg-button-primary px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-button-primary-fg transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {strings.settings.feishuBind}
          </button>
        </div>
      )}

      {confirmingUnbind && (
        <div
          data-testid="settings-feishu-unbind-confirm"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-backdrop-strong p-5"
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-[420px] rounded-2xl border border-border-default bg-surface p-4 shadow-2xl"
          >
            <p className="font-pingfang text-[12px] text-text-secondary">
              {strings.settings.feishuUnbindConfirm(status.appIdMasked ?? '')}
            </p>
            <div className="mt-4 flex justify-end gap-1.5">
              <button
                type="button"
                data-testid="settings-feishu-unbind-cancel"
                onClick={() => setConfirmingUnbind(false)}
                className="rounded-lg border border-border-default bg-input px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-text-muted"
              >
                {strings.common.cancel}
              </button>
              <button
                type="button"
                data-testid="settings-feishu-unbind-accept"
                onClick={() => {
                  setConfirmingUnbind(false)
                  run(() => window.feishuApi.unbind())
                }}
                className="rounded-lg bg-button-primary px-2.5 py-1.5 font-pingfang text-[11px] font-medium text-button-primary-fg"
              >
                {strings.common.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
