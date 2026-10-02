/**
 * 会话历史的管理操作（本机视图层）。
 *
 * 「隐藏」= GBC 视图里的墓碑，绝不写各 agent 自己的数据目录 ——
 * 历史扫描永远只读，这条纪律不因管理功能破例。
 * 「移入回收站」走主进程 shell.trashItem，系统级可恢复。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SessionOpsState {
  /** key = `${agent}:${id}`。墓碑只影响会话历史页的展示。 */
  hiddenKeys: string[]
  hide: (keys: readonly string[]) => void
  unhide: (keys: readonly string[]) => void
  clearHidden: () => void
}

export const useSessionOpsStore = create<SessionOpsState>()(
  persist(
    (set) => ({
      hiddenKeys: [],
      hide: (keys) =>
        set((state) => ({
          hiddenKeys: [...new Set([...state.hiddenKeys, ...keys])]
        })),
      unhide: (keys) =>
        set((state) => ({
          hiddenKeys: state.hiddenKeys.filter((key) => !keys.includes(key))
        })),
      clearHidden: () => set({ hiddenKeys: [] })
    }),
    { name: 'gbc-session-tombstones' }
  )
)
