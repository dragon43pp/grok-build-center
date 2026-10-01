import { getStrings, type AppStrings } from './i18n'
import { useSettingsStore } from '../state/settingsStore'

/** SPEC-S §3.3 running-session six-state UI contract. */
export const sessionStatuses = [
  'working',
  'needs-you',
  'done',
  'error',
  'idle',
  'exited'
] as const

export type SessionStatus = (typeof sessionStatuses)[number]

/** Shared by Sidebar, Home and the floating window.
 *
 *  DESIGN-SPEC §4.1：灯 10px（size-2.5），needs-you 时 12px（size-3）+ 珊瑚光晕
 *  + 2s 呼吸。working 灯也轻呼吸（表示在跑）。其余实心圆点不动画。 */
export const statusDot: Record<SessionStatus, string> = {
  working: 'size-2.5 bg-status-working-dot animate-pulse',
  'needs-you':
    'size-3 bg-status-needs-you-dot ring-2 ring-status-needs-you/45 shadow-[0_0_12px_2px_rgb(255_107_74/0.45)] animate-pulse',
  done: 'size-2.5 bg-status-done-dot',
  error: 'size-2.5 bg-status-error-dot',
  idle: 'size-2.5 bg-status-idle-dot',
  exited: 'size-2.5 border border-status-exited bg-transparent'
}

export const statusTone: Record<SessionStatus, string> = {
  working: 'text-status-working',
  'needs-you': 'text-status-needs-you',
  done: 'text-status-done',
  error: 'text-status-error',
  idle: 'text-status-idle',
  exited: 'text-status-exited'
}

const statusStringKey: Record<
  SessionStatus,
  keyof AppStrings['sessionStatus']
> = {
  working: 'working',
  'needs-you': 'needsYou',
  done: 'done',
  error: 'error',
  idle: 'idle',
  exited: 'exited'
}

/** 语言感知标签：组件渲染时读取当前持久化语言（组件本身订阅 language 触发重渲染）。 */
export function statusLabel(status: SessionStatus): string {
  const group = getStrings(useSettingsStore.getState().language).sessionStatus
  // statusStringKey 保证命中纯字符串键（exitedDetail 为函数，不在映射内）。
  return group[statusStringKey[status]] as string
}