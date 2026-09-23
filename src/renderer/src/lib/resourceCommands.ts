import { newMessageId, useSessionsStore } from '../store/sessions'
import { useResourceDockStore, type ResourceDockKind } from '../store/resourceDock'

/** Open a live composer resource. Status keeps a small history link; MCP does not. */
export function showResource(sessionId: string, kind: ResourceDockKind): void {
  useResourceDockStore.getState().open(sessionId, kind)
  if (kind === 'mcp') return
  useSessionsStore.getState().addMessage(sessionId, {
    id: newMessageId(),
    role: 'assistant',
    text: '[Session status](nyra://status)'
  })
}
