/// <reference types="vite/client" />

import type * as ApiTypes from './lib/api-types'
import type { NyraApi } from './lib/tauri-api'

declare global {
  /**
   * Derived from the bridge itself, so the declared surface can't drift from
   * what `initTauriApi()` actually installs.
   */
  interface Window {
    api: NyraApi
  }

  // Components have referenced these as globals since the Electron build; the
  // definitions now live in `lib/api-types` next to the bridge that returns them.
  type SkillInfo = ApiTypes.SkillInfo
  type AgentInfo = ApiTypes.AgentInfo
  type MemorySource = ApiTypes.MemorySource
  type MemoryType = ApiTypes.MemoryType
  type MemoryFile = ApiTypes.MemoryFile
  type BgProcessRow = ApiTypes.BgProcessRow
  type McpEntry = ApiTypes.McpEntry
}

export {}
