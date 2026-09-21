/**
 * The renderer's half of the app-control bridge.
 *
 * Rust serves the MCP tools, but most of what they promise lives here: the
 * panels, the theme, the command registry, which flow is on screen. So Rust
 * asks — `nyra:app-request` with an op name and a JSON payload — and this
 * answers on `app_control_response`.
 *
 * Deliberately a table of named ops rather than anything that evaluates what it
 * is sent. The debug-only `/dev/eval` route exists for the other thing, and the
 * reason it is debug-only is the reason this is not shaped like it.
 *
 * Every op goes through the same store actions a click would. Nothing here
 * synthesises an event, moves a cursor, or writes state behind the store's
 * back — the model asks, the store changes, and React finds out the way it
 * always does.
 */

import { agentCommands, runCommand } from '../commands/registry'
import { useUiStore } from '../store/ui'
import {
  PANEL_DEFAULTS,
  PANEL_MINS,
  usePanelSizesStore,
  type PanelKey
} from '../store/panelSizes'
import { useSettingsStore } from '../store/settings'
import { useWorkflowStore } from '../store/workflow'
import { useSessionsStore } from '../store/sessions'
import { useWorkspaceStore, workspaceFor } from '../store/workspace'
import { openFileInPanel } from './openFile'
import { resolveTheme } from './theme'
import { renderDesign } from './designRender'

type Op = (args: Record<string, unknown>) => unknown | Promise<unknown>

/**
 * What is on screen right now.
 *
 * Kept small and catalogue-free on purpose: this is the call the model is told
 * to make before acting, so it has to be cheap enough that making it every time
 * is not a cost worth avoiding. The command list is a separate op.
 */
function state(): Record<string, unknown> {
  const ui = useUiStore.getState()
  const settings = useSettingsStore.getState()
  const workflow = useWorkflowStore.getState()
  const sessions = useSessionsStore.getState()
  const sessionId = sessions.activeSessionId

  return {
    panels: {
      projects: ui.projectsPanelOpen,
      sidePanel: ui.rightPanelOpen,
      terminal: ui.bottomPanelOpen,
      summary: ui.summaryOpen
    },
    view: workflow.isCanvasOpen ? 'flows' : 'chat',
    theme: { preference: settings.theme, showing: resolveTheme(settings.theme) },
    updateAvailable: ui.updateAvailable,
    flow: workflow.currentWorkflow
      ? { id: workflow.currentWorkflow.id, name: workflow.currentWorkflow.name }
      : null,
    sidePanelTabs:
      sessionId === null
        ? []
        : workspaceFor(useWorkspaceStore.getState(), sessionId).tabs.map((tab) => ({
            kind: tab.kind,
            title: tab.kind === 'file' ? tab.path : tab.kind
          }))
  }
}

const OPS: Record<string, Op> = {
  state,

  commands: () => agentCommands(),

  run: (args) =>
    runCommand(String(args.command ?? ''), {
      // `undefined` means "flip it", which is not the same as `false`.
      on: typeof args.on === 'boolean' ? args.on : undefined,
      agent: true
    }),

  open_file: async (args) => {
    const path = String(args.path ?? '')
    if (!path) throw new Error('open_file needs a path')
    await openFileInPanel(path)
    return { ok: true }
  },

  /**
   * Put a flow on screen.
   *
   * The same two steps the sidebar takes (`Sidebar.tsx`): load it, then set it.
   * Opening the canvas first is what makes this work from a chat, where the
   * Flows view is not mounted at all.
   */
  open_flow: async (args) => {
    const id = String(args.id ?? '')
    const definition = await window.api.workflow.load(id)
    if (!definition) throw new Error(`no flow with id ${id}`)
    useWorkflowStore.getState().openCanvas()
    useWorkflowStore.getState().setCurrentWorkflow(definition)
    return { ok: true, id }
  },

  /**
   * The rails, as sizes rather than as booleans.
   *
   * `state` answers which panels are open; this answers how big. Kept apart
   * because `state` is the cheap call the model is told to make before acting,
   * and sizes are only interesting when it is about to change one.
   */
  layout() {
    const sizes = usePanelSizesStore.getState()
    const ui = useUiStore.getState()
    return {
      ok: true,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panels: {
        sidebarWidth: { px: sizes.sidebarWidth, min: PANEL_MINS.sidebarWidth, open: ui.projectsPanelOpen },
        rightPanelWidth: { px: sizes.rightPanelWidth, min: PANEL_MINS.rightPanelWidth, open: ui.rightPanelOpen },
        bottomPanelHeight: { px: sizes.bottomPanelHeight, min: PANEL_MINS.bottomPanelHeight, open: ui.bottomPanelOpen }
      },
      defaults: PANEL_DEFAULTS
    }
  },

  /**
   * Resize a rail.
   *
   * Goes through the same store a drag does, and the same clamp — the model
   * gets no privilege the pointer does not have, so it cannot leave the chat
   * narrower than a person could drag it to. `reset` puts one back to default.
   */
  resize({ panel, px, reset }) {
    const key = typeof panel === 'string' ? (panel as PanelKey) : null
    if (key === null || !(key in PANEL_DEFAULTS)) {
      throw new Error(
        `resize needs a panel: ${Object.keys(PANEL_DEFAULTS).join(', ')}`
      )
    }
    const sizes = usePanelSizesStore.getState()
    if (reset === true) {
      sizes.resetSize(key)
      return { ok: true, panel: key, px: usePanelSizesStore.getState()[key] }
    }
    if (typeof px !== 'number' || !Number.isFinite(px)) {
      throw new Error('resize needs px, or reset: true')
    }
    // The floor a drag enforces. Above it the layout's own clamp decides what
    // actually fits, exactly as it does for a pointer.
    sizes.setSize(key, Math.max(PANEL_MINS[key], Math.round(px)))
    return { ok: true, panel: key, px: usePanelSizesStore.getState()[key] }
  },

  /**
   * Which project the active session is in.
   *
   * Exists so `nyra_design` can default its `project` argument instead of
   * asking the model for something the app already knows. A tool that makes
   * you supply a fact it could have looked up costs a round trip on every
   * call, which is exactly what a cold session showed.
   */
  'design.project'() {
    const sessions = useSessionsStore.getState()
    const active = sessions.sessions.find((s) => s.id === sessions.activeSessionId)
    return { ok: true, project: active?.cwd ?? null }
  },

  /**
   * Render a design to PNGs.
   *
   * The only op that does real work rather than moving the UI, and the reason
   * `ask_renderer` grew a per-op timeout: the first render in a session pays
   * for launching a headless Chromium.
   */
  async 'design.render'({ path, artboard, scale }) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error("design.render needs a 'path'")
    }
    const result = await renderDesign(
      path,
      typeof artboard === 'string' ? artboard : undefined,
      typeof scale === 'number' ? scale : 2
    )
    return { ok: true, ...result }
  }
}

/**
 * Answer one question.
 *
 * Exported for the tests, which is the whole reason the dispatch is separate
 * from the subscription — a failure here should be reproducible without a Tauri
 * event loop.
 */
export async function handleAppRequest(op: string, args: unknown): Promise<unknown> {
  const handler = OPS[op]
  if (!handler) throw new Error(`unknown op '${op}'`)
  return await handler((args ?? {}) as Record<string, unknown>)
}

/**
 * Listen for as long as the app is running.
 *
 * An error comes back as `{ ok: false, error }` rather than being thrown away:
 * Rust is waiting with a timeout, and letting it wait out three seconds for
 * something that already failed turns a clear message into a vague one.
 */
export function startAppControl(): () => void {
  return window.api.appControl.onRequest(({ requestId, op, args }) => {
    void (async () => {
      try {
        window.api.appControl.respond(requestId, await handleAppRequest(op, args))
      } catch (err) {
        window.api.appControl.respond(requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })()
  })
}
