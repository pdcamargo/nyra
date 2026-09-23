import React, { useEffect, useRef, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import { TooltipProvider } from './components/ui/tooltip'
import Chat from './components/Chat'
import RightPanel from './components/RightPanel'
import ResizeHandle from './components/ResizeHandle'
import BottomDock from './components/BottomDock'
import CommandPalette from './components/CommandPalette'
import QuickOpen from './components/QuickOpen'
import ImageLightbox from './components/ImageLightbox'
import SettingsModal from './components/settings/SettingsModal'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useResolvedTheme } from './hooks/useResolvedTheme'
import { applyThemeClass } from './lib/theme'
import { appearanceOf, applyAppearance } from './lib/appearance'
import { applyZoom } from './lib/zoom'
import { useSettingsStore } from './store/settings'
import { useSessionsStore } from './store/sessions'
import { loadModelCatalog } from './store/modelVersions'
import { attachWorktreeSessions } from './store/attachWorktrees'
import { primeHomedir } from './lib/homedir'
import { migrateSessionsDb } from './lib/legacy-storage'
import { useWorkflowStore } from './store/workflow'
import { useProcessesStore, type BgProcess } from './store/processes'
import { applySessionPanels, useUiStore } from './store/ui'
import { dropBrowserHub, useBrowserStore } from './store/browser'
import { syncBrowserGone, syncSidecarTabs, useWorkspaceStore } from './store/workspace'
import { handleBinding } from './store/panelLayout'
import { usePanelSizesStore } from './store/panelSizes'
import { startAppControl } from './lib/appControl'
import { ViewErrorBoundary } from './components/ViewErrorBoundary'

// Lazy-load heavy components — modals with Monaco, WorkflowCanvas with React Flow
const WorkflowCanvas = React.lazy(() => import('./components/WorkflowCanvas'))
const MainViews = React.lazy(() => import('./components/views/MainViews'))
const SkillEditorModal = React.lazy(() => import('./components/SkillEditorModal'))
const HookEditorModal = React.lazy(() => import('./components/HookEditorModal'))
const WelcomeModal = React.lazy(() => import('./components/WelcomeModal'))
const LoginModal = React.lazy(() => import('./components/LoginModal'))

export default function App(): React.JSX.Element {
  // Both side panels live in the ui store now, next to bottomPanelOpen — the
  // summary toggle in the chat header needs to reach one of them from there.
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const projectsPanelOpen = useUiStore((s) => s.projectsPanelOpen)
  const isCanvasOpen = useWorkflowStore((s) => s.isCanvasOpen)
  const mainView = useUiStore((s) => s.mainView)
  const resolvedTheme = useResolvedTheme()
  const zoom = useSettingsStore((s) => s.zoom)
  const shellRef = useRef<HTMLDivElement>(null)
  useKeyboardShortcuts()

  // One look, at launch. Enough for a badge to be honest without the app
  // reaching out on a timer — and it stays a badge: nothing installs until the
  // About row is clicked.
  useEffect(() => {
    void window.api.updates
      .check()
      .then((result) => {
        if (result.available) useUiStore.getState().setUpdateAvailable(result.version)
      })
      .catch(() => {
        // Offline, or no release yet. A badge that cannot appear is the right
        // failure; the manual check in Settings says why.
      })
  }, [])

  // What this CLI build says the model aliases currently mean, so a model
  // nobody has run yet still carries a version on its label. Read once at
  // launch rather than on demand: it streams the binary on a cold cache, and
  // the answer cannot change while the app is open.
  useEffect(() => {
    void loadModelCatalog()
  }, [])

  // Alt-tab and minimise count as time away for the recap, the same as looking
  // at another chat. Focus rather than visibility alone: an alt-tabbed window
  // is still "visible" to the page, and nobody is reading it.
  useEffect(() => {
    const sync = (): void => {
      useSessionsStore.getState().setWindowAway(document.hidden || !document.hasFocus())
    }
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  // Claude asking this window to do something, or telling it a check it ran
  // found a new version. Subscribed here rather than in a panel for the same
  // reason the browser events are: the question can arrive whatever is mounted.
  useEffect(() => {
    const stopControl = startAppControl()
    const stopUpdates = window.api.updates.onAvailable(({ version }) => {
      useUiStore.getState().setUpdateAvailable(version)
    })
    return () => {
      stopControl()
      stopUpdates()
    }
  }, [])

  useEffect(() => {
    // Rehydrate first: the synchronous half of the projects backfill runs inside
    // the store's merge, and the git-dependent half has to follow it. The key
    // migration goes in front of it — rehydrating before the history has been
    // carried across would come up empty and then persist that emptiness.
    void migrateSessionsDb()
      .then(() => useSessionsStore.persist.rehydrate())
      .then(attachWorktreeSessions)
      .then(() => {
        // The workspace store keeps file tabs per chat and hydrates on its own,
        // so it can be holding rows for chats this one no longer has. Pruned
        // here rather than on write, because only now is the session list real.
        const ids = useSessionsStore.getState().sessions.map((x) => x.id)
        useWorkspaceStore.getState().prune(ids)
      })
    void primeHomedir()
  }, [])

  useEffect(() => {
    applyThemeClass(resolvedTheme)
  }, [resolvedTheme])

  // Fonts and type size, written to <html> whenever they change. Subscribed
  // rather than rendered: nothing in the tree needs to re-render for a font
  // swap, the variables do the work.
  useEffect(() => {
    const push = (): void => applyAppearance(appearanceOf(useSettingsStore.getState()))
    push()
    return useSettingsStore.subscribe(push)
  }, [])

  useEffect(() => {
    void applyZoom(zoom)
  }, [zoom])

  // Panels follow the conversation. Switching chats loads what that one was left
  // at; a chat that has never been told inherits the current state rather than
  // snapping to a fixed default.
  useEffect(() => {
    let current = useSessionsStore.getState().activeSessionId
    applySessionPanels(current)
    return useSessionsStore.subscribe((state) => {
      if (state.activeSessionId === current) return
      current = state.activeSessionId
      applySessionPanels(current)
    })
  }, [])

  // Subscribe to background-process updates from main
  useEffect(() => {
    const unsub = window.api.processes.onUpdate(({ nyraSessionId, processes }) => {
      useProcessesStore.getState().setForSession(nyraSessionId, processes as BgProcess[])
    })
    return unsub
  }, [])

  // Browser news from the sidecar. Routed here rather than in the panel because
  // a chat's browser keeps running while its panel is closed — that is the
  // whole point of it — so the tab list has to stay current with nothing
  // mounted to receive it.
  useEffect(() => {
    /**
     * What a page should believe its `devicePixelRatio` is.
     *
     * Pushed as config rather than passed per chat, because it is a property of
     * this screen and not of any conversation. A context takes it at creation,
     * and a context can be created by whoever gets there first — `tab.create`
     * and an agent's very first tool call both build one, neither of them
     * knowing anything about a display. It also has to survive the sidecar's
     * idle eviction, which rebuilds contexts from whichever call comes next.
     * Getting this wrong is silent: every page simply renders at 1x and the
     * panel looks soft with no setting to explain it.
     */
    const pushPixelRatio = (): void => {
      void window.api.browser.configure({
        deviceScaleFactor: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
      })
    }
    pushPixelRatio()

    return window.api.browser.onEvent((event) => {
      const store = useBrowserStore.getState()
      switch (event.event) {
        case 'tabs':
          syncSidecarTabs(event.params.chatId, event.params.tabs)
          break
        case 'browser':
          if (event.params.state === 'ready' && event.params.cdpUrl) {
            // A relaunched sidecar starts from its own defaults, and Rust's
            // handshake only restores the origins.
            pushPixelRatio()
            store.setEndpoint(event.params.cdpUrl)
          } else if (event.params.state === 'gone') {
            dropBrowserHub()
            syncBrowserGone()
          }
          break
        case 'install':
          store.setInstall(
            event.params.state === 'downloading'
              ? { percent: event.params.percent ?? 0, totalMb: event.params.totalMb ?? 0 }
              : null
          )
          break
        case 'driving':
          store.setDriving(event.params.chatId, event.params.tabId)
          break
        case 'cursor':
          store.setCursor(event.params.chatId, {
            tabId: event.params.tabId,
            down: event.params.down,
            x: event.params.x,
            y: event.params.y,
            at: Date.now()
          })
          break
        case 'evicted':
          // The context is gone but the chat is not; it starts again on the
          // next look.
          store.setPhase(event.params.chatId, 'off')
          syncSidecarTabs(event.params.chatId, [])
          break
        case 'exit':
          dropBrowserHub()
          syncBrowserGone()
          break
      }
    })
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
    <div ref={shellRef} className="flex h-full w-full flex-col overflow-hidden bg-background">
      <TitleBar />

      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Left Sidebar */}
      {projectsPanelOpen && (
        <>
          <Sidebar />
          <ResizeHandle
            side="left"
            label="Resize projects panel"
            {...handleBinding('sidebarWidth')}
            onSize={(px) => usePanelSizesStore.getState().setSize('sidebarWidth', px)}
            onReset={() => usePanelSizesStore.getState().resetSize('sidebarWidth')}
          />
        </>
      )}

      {/* Center: Chat/Workflow + Bottom Panel + Status bar */}
      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Flows still wins: it is a mode rather than a page, and the rail
              hides the nav while it is open. Otherwise the rail's nav picks
              what fills this, with the chat as the resting state. */}
          {isCanvasOpen ? (
            <ViewErrorBoundary label="Flows">
              <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground text-xs">Loading workflow canvas…</div>}>
                <WorkflowCanvas />
              </Suspense>
            </ViewErrorBoundary>
          ) : mainView !== 'chat' ? (
            <ViewErrorBoundary label={mainView}>
              <Suspense fallback={null}>
                <MainViews view={mainView} />
              </Suspense>
            </ViewErrorBoundary>
          ) : (
            <ViewErrorBoundary label="Chat">
              <Chat />
            </ViewErrorBoundary>
          )}
        </div>
        <BottomDock />
      </main>

      {/* Settings belongs to the app, not to one view. It used to live inside

          Chat, so opening it in Flow mode did nothing at all — Flow renders the

          canvas *instead of* Chat. */}

      {settingsOpen && <SettingsModal onClose={() => useUiStore.getState().setSettingsOpen(false)} />}


      {/* Right Panel */}
      {rightPanelOpen && (
        <>
          <ResizeHandle
            side="right"
            label="Resize workspace panel"
            {...handleBinding('rightPanelWidth')}
            onSize={(px) => {
              usePanelSizesStore.getState().setSize('rightPanelWidth', px)
              const sid = useSessionsStore.getState().activeSessionId
              if (sid) useSessionsStore.getState().setSessionPanels(sid, { rightWidth: px })
            }}
            onReset={() => usePanelSizesStore.getState().resetSize('rightPanelWidth')}
          />
          <RightPanel />
        </>
      )}
      </div>


      {/* Chats, past prompts and actions, behind one input */}
      <CommandPalette />
      <QuickOpen />
      <ImageLightbox />

      {/* Lazy-loaded modals */}
      <Suspense fallback={null}>
        <SkillEditorModal />
        <HookEditorModal />
        <WelcomeModal />
        <LoginModal />
      </Suspense>
    </div>
    </TooltipProvider>
  )
}
