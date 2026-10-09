import { create } from 'zustand'
import type { KeepAwakeStatus } from '../lib/tauri-api'

/**
 * Whether Rust is holding the computer awake, and for what. Rust owns the
 * count — see `keep_awake.rs` for why it is not computed from the renderer's
 * own running state. Fed in `App`, so it stays current whatever is on screen.
 */
export const IDLE: KeepAwakeStatus = {
  holding: false,
  busy: false,
  onBattery: false,
  chats: 0,
  monitors: 0,
  tasks: 0,
  flows: 0,
  since: null
}

export const useKeepAwakeStore = create<{
  status: KeepAwakeStatus
  set: (status: KeepAwakeStatus) => void
}>((set) => ({
  status: IDLE,
  set: (status) => set({ status })
}))
