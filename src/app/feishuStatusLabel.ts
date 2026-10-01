import type { FeishuPhase } from '../../shared/ipc-contract'
import type { AppStrings } from './i18n'

/**
 * 飞书连接相位 → 可展示文案。
 *
 * 设置面板和标题栏都要显示同一个状态，**共用这一份**。各写一份的后果是
 * 日后改口径必然漂移：标题栏说「等待扫码」而面板说「扫码中」，用户
 * 会以为是两件事。
 */
export function feishuPhaseLabel(strings: AppStrings, phase: FeishuPhase): string {
  switch (phase) {
    case 'scanning':
      return strings.settings.feishuStatusScanning
    case 'connecting':
      return strings.settings.feishuStatusConnecting
    case 'connected':
      return strings.settings.feishuStatusConnected
    case 'error':
      return strings.settings.feishuStatusError
    default:
      return strings.settings.feishuStatusUnbound
  }
}

/**
 * 状态灯的颜色。
 *
 * 用主题的**语义状态色**（done / needs-you / error），不是自己拍的十六进制 ——
 * 设置面板里的灯本来就用这几个类，标题栏必须跟它一模一样，否则同一个状态
 * 在两处显示成两种颜色。尺寸由调用方各自决定，这里只管颜色。
 */
export function feishuPhaseDotClass(phase: FeishuPhase): string {
  switch (phase) {
    case 'connected':
      return 'bg-status-done'
    case 'scanning':
    case 'connecting':
      return 'animate-pulse bg-status-needs-you'
    case 'error':
      return 'bg-status-error'
    default:
      return 'bg-text-disabled'
  }
}
