import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronDown, Copy, FileText, GitFork, GitMerge, Info, SquarePen, Trash2 } from 'lucide-react'
import { useSessionsStore, activeCwd, activeProjectCwd, createSiblingSession, openFolderAsProject, type Message, type TextMessage, type ToolCallMessage, type ImageAttachment, type FileAttachment, type TaskStatus, type Task, type AgentStatus, type QueuedMessage, newMessageId } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { spawnSettingsFor, type SpawnSettings } from '@shared/types'
import { materializeWorktree, restoreWorktree } from '../lib/worktrees'
import MarkdownRenderer from './MarkdownRenderer'
import ToolCallCard from './ToolCallCard'
import AskUserQuestionCard from './AskUserQuestionCard'
import PlanCard, { splitPlan, type PlanAnswer } from './PlanCard'
import { usePlanApprovalStore } from '../store/planApprovals'
import { useBackgroundAgentsStore } from '../store/backgroundAgents'
import {
  useSubagentTranscriptsStore,
  type SubagentWireEntry
} from '../store/subagentTranscripts'
import { outputFileFromReceipt } from '../lib/agentReport'
import { withAttachments } from '../lib/promptAttachments'
import { extractAskBlocks } from '../lib/askBlocks'
import { extractTaskBlocks } from '../lib/taskBlocks'
import { foldChecklistIntoTranscript, foldTasksAtTurnEnd } from '../lib/taskFold'
import { extractChangeBlocks } from '../lib/changeBlocks'
import { findCreatedPr, isPrCreatingCall } from '../lib/pullRequests'
import { backfillPrs, syncPrState, syncStalePrs } from '../lib/prSync'
import ChangesCard from './ChangesCard'
import { isMemoryWrite, memoryWriteFrom, type MemoryWrite } from '../lib/memoryWrites'
import MemoryChip from './MemoryChip'
import { formatMessageTime } from '../lib/messageTime'
import { extractPlan } from '../utils/permission'
import ToolCallGroup from './ToolCallGroup'
import PermissionDialog, { type PermissionRequest } from './PermissionDialog'
import ChatInput from './ChatInput'
import EditMessageBox from './EditMessageBox'
import TaskStrip from './TaskStrip'
import ZoomableImage from './ZoomableImage'
import ActivityStrip from './ActivityStrip'
import SessionRecap from './SessionRecap'
import { useChordLabel } from './ui/kbd'
import { COLUMN_OFFSET, OUTSIDE_SCROLLER, SUMMARY_OFFSET, SUMMARY_WIDTH, columnVars } from '../lib/chatColumn'
import StatsModal from './StatsModal'
import CopyBlocksModal from './CopyBlocksModal'
import ReleaseNotesModal from './ReleaseNotesModal'
import InSessionSearchBar from './InSessionSearchBar'
import SummaryPanel from './SummaryPanel'
import BrowserPip, { usePipVisible } from './browser/BrowserPip'
import { findMatches } from '../utils/inSessionSearch'
import { useHighlightMatches } from '../hooks/useHighlightMatches'
import { useWorkingWord } from '../hooks/useWorkingWord'
import { parseMcpFromInit } from '../utils/mcpParsing'
import { useRateLimitStore } from '../store/rateLimit'
import { useRunningStore, isSessionRunning } from '../store/running'
import { useUiStore } from '../store/ui'
import { useLoopsStore } from '../store/loops'
import { BUILT_IN_COMMANDS } from '../data/commands'
import { noteSlashCommands } from '../lib/slashCommands'
import { noteModelId, noteModelVersion } from '../store/modelVersions'
import { openFileInPanel } from '../lib/openFile'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const EMPTY_MESSAGES: Message[] = []
type ClaudeEventBase = { nyraSessionId?: string }

type ClaudeEvent = ClaudeEventBase & (
  | { type: 'tool_start'; tool_id: string; tool_name: string }
  | { type: 'tool_input'; tool_id: string; tool_name?: string; input: Record<string, unknown>; originalContent?: string | null }
  | { type: 'tool_result'; tool_id: string; content: string }
  | { type: 'tool_denied'; tool_id: string; tool_name: string; input: Record<string, unknown>; originalContent?: string | null }
  | { type: 'usage'; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
  | { type: 'result'; result: string; session_id: string; is_error: boolean }
  | { type: 'error'; result: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'stream_end' }
  | { type: 'system'; subtype: string; mcp_servers?: { name: string; status: string }[]; tools?: string[]; slash_commands?: string[]; model?: string }
  | {
      type: 'rate_limit'
      status: string
      resetsAt: number
      rateLimitType: string
      windows?: Record<string, { resetsAt: number; utilization: number }> | null
    }
  | { type: 'assistant_text'; text: string }
  | { type: 'goal_set'; condition: string }
  | { type: 'background_tasks'; tasks: { task_id: string; description: string; task_type?: string }[] }
  | { type: 'background_task_progress'; task_id: string; tool_use_id: string; activity: string; last_tool_name: string; subagent_type: string; duration_ms: number }
  | { type: 'subagent_stream'; tool_id: string; at: number; entries: SubagentWireEntry[] }
  | { type: 'subagent_model'; tool_id: string; model: string }
  | { type: 'subagent_reset'; tool_id: string }
  | { type: 'plan_ready'; tool_id: string; path: string; plan: string }
  | { type: 'session_reset'; reason: string }
  | { type: 'ai_title'; title: string }
  | { type: 'auth_required'; message: string }
)

/** Tool calls that are a card to answer, not a line in a trace. */
const STANDALONE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'TaskChecklist', 'GoalSet'])


/** What "auto-accept edits" actually waives — file writes, nothing else. */
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']

/**
 * Spawn settings for one conversation.
 *
 * Everything but auto-accept is global. That one is per session because it is
 * granted by approving a particular plan, and `autoApproveTools` is sent with
 * every query — so it takes effect on the next turn without respawning.
 */
function spawnSettingsForSession(sessionId: string): SpawnSettings {
  const base = spawnSettingsFor(useSettingsStore.getState())
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)

  // Plan mode, model and effort are per-conversation, falling back to the
  // defaults in Settings. They used to be global, so changing one in a chat
  // changed it in every chat, including ones already running.
  const resolved: SpawnSettings = {
    ...base,
    planMode: session?.planMode ?? base.planMode,
    model: session?.model ?? base.model,
    effort: session?.effort ?? base.effort
  }

  if (!session?.autoAcceptEdits) return resolved
  const merged = new Set([...resolved.autoApproveTools, ...EDIT_TOOLS])
  return { ...resolved, autoApproveTools: [...merged] }
}

// Panel state comes from the ui store rather than props: the title bar owns the
// toggles now, so threading them back down through App would be a detour.
export default function Chat(): React.JSX.Element {
  const running = useRunningStore((s) => s.running)
  const summaryOpen = useUiStore((s) => s.summaryOpen)
  const pipVisible = usePipVisible()
  const chatWidth = useSettingsStore((s) => s.chatWidth)
  const columnGeometry = useMemo(
    () => columnVars(summaryOpen || pipVisible, chatWidth),
    [summaryOpen, pipVisible, chatWidth]
  )
  const thinkingSince = useRunningStore((s) => s.thinkingSince)
  const [permissionQueue, setPermissionQueue] = useState<(PermissionRequest & { nyraSessionId?: string })[]>([])
  const messagesRef = useRef<HTMLDivElement>(null)
  const [showJumpBottom, setShowJumpBottom] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  const permCleanupRef = useRef<(() => void) | null>(null)
  // Tracks tool_start before tool_input arrives (contains name before input is parsed)
  /** Sessions whose prose has already been streamed this turn, so the final
   *  `result` does not repeat the last paragraph. */
  const streamedTextRef = useRef<Set<string>>(new Set())
  const pendingToolsRef = useRef<Map<string, string>>(new Map())
  /** Tool calls that are opening a PR, waiting on the result that names it.
   *  The call says "open a PR" and only the result says which one, so the
   *  two halves have to be tied together across events. */
  const prCallsRef = useRef<Set<string>>(new Set())
  const [isDragging, setIsDragging] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [copyBlocksOpen, setCopyBlocksOpen] = useState(false)
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const dragCounterRef = useRef(0)
  const sendMessageRef = useRef<((text: string, images?: ImageAttachment[], files?: FileAttachment[], targetSessionId?: string) => Promise<void>) | null>(null)
  // After 401, holds the prompt to re-send once /login succeeds, keyed by session id
  const pendingAuthRetryRef = useRef<Map<string, { text: string; images?: ImageAttachment[]; files?: FileAttachment[] }>>(new Map())
  // Extended thinking state: tracks when Claude is actively reasoning

  const skipPermissions = useSettingsStore((s) => s.skipPermissions)
  const planMode = useSettingsStore((s) => s.planMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [homedir, setHomedir] = useState('')

  useEffect(() => {
    window.api.system.homedir().then(setHomedir)
  }, [])

  useEffect(() => {
    const handler = (): void => setStatsOpen(true)
    window.addEventListener('nyra:open-stats', handler)
    return () => window.removeEventListener('nyra:open-stats', handler)
  }, [])

  useEffect(() => {
    const handler = (): void => setCopyBlocksOpen(true)
    window.addEventListener('nyra:open-copy', handler)
    return () => window.removeEventListener('nyra:open-copy', handler)
  }, [])

  useEffect(() => {
    const handler = (): void => setReleaseNotesOpen(true)
    window.addEventListener('nyra:open-release-notes', handler)
    return () => window.removeEventListener('nyra:open-release-notes', handler)
  }, [])

  useEffect(() => {
    const handler = (): void => {
      // After /login completes, re-send any prompts stashed by the auth_required handler
      const pending = pendingAuthRetryRef.current
      pendingAuthRetryRef.current = new Map()
      for (const [, payload] of pending) {
        sendMessageRef.current?.(payload.text, payload.images, payload.files)
      }
    }
    window.addEventListener('nyra:login-success', handler)
    return () => window.removeEventListener('nyra:login-success', handler)
  }, [])

  useEffect(() => {
    const handleStart = (e: Event): void => {
      const { prompt, intervalMs } = (e as CustomEvent).detail
      const sid = useSessionsStore.getState().activeSessionId
      if (!sid) return

      // Stop existing loop for this session
      useLoopsStore.getState().removeLoop(sid)

      // Info message
      const fmt = intervalMs < 60_000 ? `${intervalMs / 1000}s` : intervalMs < 3_600_000 ? `${intervalMs / 60_000}m` : `${intervalMs / 3_600_000}h`
      useSessionsStore.getState().addMessage(sid, {
        id: newMessageId(), role: 'assistant',
        text: `Loop started: **"${prompt}"** every ${fmt}. Type \`/loop stop\` to cancel.`
      })

      // Fire first iteration immediately
      sendMessageRef.current?.(prompt)

      const intervalId = setInterval(() => {
        if (isSessionRunning(sid)) {
          useLoopsStore.getState().skipLoop(sid)
          return
        }
        useLoopsStore.getState().tickLoop(sid)
        sendMessageRef.current?.(prompt)
      }, intervalMs)

      useLoopsStore.getState().addLoop({
        sessionId: sid, prompt, intervalMs, intervalId,
        runCount: 1, skippedCount: 0, startedAt: Date.now()
      })
    }

    const handleStop = (): void => {
      const sid = useSessionsStore.getState().activeSessionId
      if (!sid) return
      const loops = useLoopsStore.getState()
      if (loops.loops.has(sid)) {
        loops.removeLoop(sid)
        useSessionsStore.getState().addMessage(sid, {
          id: newMessageId(), role: 'assistant', text: 'Loop stopped.'
        })
      }
    }

    window.addEventListener('nyra:start-loop', handleStart)
    window.addEventListener('nyra:stop-loop', handleStop)
    return () => {
      window.removeEventListener('nyra:start-loop', handleStart)
      window.removeEventListener('nyra:stop-loop', handleStop)
    }
  }, [])

  // Clean up loops when sessions are deleted
  useEffect(() => {
    return useSessionsStore.subscribe((state, prev) => {
      const removed = prev.sessions.filter((s) => !state.sessions.find((ns) => ns.id === s.id))
      for (const s of removed) {
        useLoopsStore.getState().removeLoop(s.id)
      }
    })
  }, [])

  // Sync all settings to main process on mount and whenever any setting changes
  useEffect(() => {
    const sync = (): void => {
      const { updateSettings: _, resetSettings: __, ...data } = useSettingsStore.getState()
      window.api.settings.sync(data)
    }
    sync()
    const unsub = useSettingsStore.subscribe(sync)
    return unsub
  }, [])

  const activeSessionId = useSessionsStore((state) => state.activeSessionId)
  const activeSession = useSessionsStore((state) =>
    state.sessions.find((s) => s.id === state.activeSessionId) ?? null
  )
  const messages = activeSession?.messages ?? EMPTY_MESSAGES
  const cwd = useSessionsStore(activeCwd) || homedir
  const usage = activeSession?.usage ?? null

  const isLoading = activeSessionId ? running[activeSessionId] === true : false

  // Build virtual items: interleave date separators with messages, plus loading indicator
  type VirtualItem =
    | { kind: 'separator'; label: string }
    | { kind: 'message'; msg: Message; idx: number }
    | { kind: 'tool_group'; messages: ToolCallMessage[]; firstId: string }
    | { kind: 'memory'; writes: MemoryWrite[]; firstId: string }
    | { kind: 'loading' }

  const virtualItems = useMemo((): VirtualItem[] => {
    const items: VirtualItem[] = []
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx]
      if (msg.timestamp) {
        const msgDate = new Date(msg.timestamp)
        const prevMsg = idx > 0 ? messages[idx - 1] : null
        const prevDate = prevMsg?.timestamp ? new Date(prevMsg.timestamp) : null
        if (!prevDate || msgDate.toDateString() !== prevDate.toDateString()) {
          const today = new Date()
          const yesterday = new Date(today)
          yesterday.setDate(yesterday.getDate() - 1)
          let label: string
          if (msgDate.toDateString() === today.toDateString()) label = 'Today'
          else if (msgDate.toDateString() === yesterday.toDateString()) label = 'Yesterday'
          else label = msgDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
          items.push({ kind: 'separator', label })
        }
      }

      // Group consecutive tool_call messages
      if (msg.role === 'tool_call') {
        const tc = msg as ToolCallMessage
        // Writing a memory is one event even though it is two writes — the
        // memory, then its pointer line in MEMORY.md — so consecutive ones
        // collect into a single card rather than announcing the bookkeeping.
        const memory = isMemoryWrite(tc) ? memoryWriteFrom(tc) : null
        if (memory) {
          const last = items[items.length - 1]
          if (last?.kind === 'memory') last.writes.push(memory)
          else items.push({ kind: 'memory', writes: [memory], firstId: tc.id })
          continue
        }
        // Anything the user has to read or answer stands alone. Folded into a
        // run of tool calls it becomes "1 other tool" inside a collapsed strip,
        // which is exactly where the plan card went missing.
        if (tc.denied || STANDALONE_TOOLS.has(tc.tool_name)) {
          items.push({ kind: 'tool_group', messages: [tc], firstId: tc.id })
        } else {
          const last = items[items.length - 1]
          if (
            last?.kind === 'tool_group' &&
            !last.messages.some((m) => m.denied || STANDALONE_TOOLS.has(m.tool_name))
          ) {
            last.messages.push(tc)
          } else {
            items.push({ kind: 'tool_group', messages: [tc], firstId: tc.id })
          }
        }
      } else {
        items.push({ kind: 'message', msg, idx })
      }
    }
    if (isLoading) items.push({ kind: 'loading' })
    return items
  }, [messages, isLoading])

  // Virtualizer setup
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => messagesRef.current,
    estimateSize: () => 80,
    overscan: 5,
    getItemKey: (index) => {
      const item = virtualItems[index]
      // The virtualizer can ask about an index that no longer exists — during a
      // session switch it still holds the previous conversation's count for a
      // render. Reading `.kind` off nothing throws and takes the chat with it.
      if (!item) return `gone-${index}`
      if (item.kind === 'separator') return `sep-${index}`
      if (item.kind === 'loading') return 'loading'
      if (item.kind === 'tool_group') return `tg-${item.firstId}`
      if (item.kind === 'memory') return `mem-${item.firstId}`
      return item.msg.id
    },
  })

  /**
   * The plan waiting on an answer, if any.
   *
   * Pinned above the composer rather than left in the transcript: the card is
   * raised when the plan file is written, which is mid-turn, so anything Claude
   * says afterwards pushes it out of view — and the transcript now follows to the
   * bottom, so it scrolls straight past the one thing that wants you.
   */
  const pendingPlans = usePlanApprovalStore((s) => s.pending)
  const pendingPlan = useMemo(() => {
    if (!activeSessionId) return null
    const owed = Object.keys(pendingPlans).filter((id) => pendingPlans[id] === activeSessionId)
    if (owed.length === 0) return null
    // Newest wins: a revised plan supersedes the draft it replaced.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'tool_call' && owed.includes((m as ToolCallMessage).tool_id)) {
        return m as ToolCallMessage
      }
    }
    return null
  }, [pendingPlans, activeSessionId, messages])

  /**
   * The question waiting on an answer, if any.
   *
   * Fused into the composer rather than left in the transcript: you answer a
   * question by typing, and the box you type into is down there. Only the newest
   * one counts — an older question the turn moved past is a record, not a prompt.
   */
  const pendingQuestion = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'tool_call') continue
      const tc = m as ToolCallMessage
      if (tc.tool_name !== 'AskUserQuestion') continue
      return tc.result === undefined && tc.denied !== true ? tc : null
    }
    return null
  }, [messages])

  /**
   * Re-read the branch this chat is on.
   *
   * It used to be written once, when a worktree was created, and never again —
   * so a plain chat never had one at all, and a `git checkout` the agent ran was
   * invisible everywhere in the UI. Cheap enough to ask after every turn, which
   * catches a checkout however it happened: the agent, a terminal, a script.
   */
  const refreshBranch = useCallback((sid: string): void => {
    const session = useSessionsStore.getState().sessions.find((s) => s.id === sid)
    if (!session?.cwd) return
    void window.api.git
      .branch(session.cwd)
      .then((branch) => {
        const store = useSessionsStore.getState()
        const current = store.sessions.find((s) => s.id === sid)
        if (!current || current.branch === branch) return
        store.setGitInfo(sid, { isGitRepo: !!branch, branch })
      })
      .catch(() => {
        /* not a repo, or git is unavailable — leave what we had */
      })
  }, [])

  /** False once the user scrolls up — their position is theirs until they come back. */
  const stuckToBottomRef = useRef(true)

  /**
   * Start the list from nothing when the conversation changes.
   *
   * Measured heights are cached per item, and that cache outlived the session it
   * was measured in: switching chats left the scrollbar sized for the previous
   * transcript, items positioned at its offsets, and any row the virtualizer
   * still reported keeping the DOM node it had rendered there — one stray tool
   * call from a conversation you were not looking at, floating in a screen of
   * empty space. `measure()` drops the cache so the new list is measured as
   * itself.
   */
  useEffect(() => {
    if (activeSessionId) refreshBranch(activeSessionId)
  }, [activeSessionId, refreshBranch])

  useEffect(() => {
    stuckToBottomRef.current = true
    virtualizer.measure()
    if (virtualItems.length > 0) {
      virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end' })
    }
  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Follow the conversation unless the user has scrolled away from it.
   *
   * Two things used to go wrong. It only fired when the item *count* grew, so a
   * message that got longer — or a tool group that gained a tool — scrolled
   * nothing. And the list is virtualized with an 80px estimate, so scrolling to
   * a card that turns out to be 600px tall landed near its top and stopped: a
   * question card could arrive fully off-screen and look like nothing happened.
   *
   * Keying on the measured total height fixes both. Every re-measure re-asserts
   * the bottom, so the view settles there however wrong the estimate was.
   */
  const totalSize = virtualizer.getTotalSize()
  useEffect(() => {
    if (!stuckToBottomRef.current || virtualItems.length === 0) return
    virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end' })
  }, [virtualItems.length, totalSize]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Stay pinned when the viewport shrinks under you.
   *
   * The strips above the composer come and go — an agent starts, a checklist
   * appears — and each one takes height from the transcript. The content has not
   * changed, so nothing above re-scrolls, and `scrollTop` stays where it was:
   * the last line you were reading slides up behind the strip that just
   * appeared. Re-assert the bottom whenever the box itself resizes.
   */
  useEffect(() => {
    const el = messagesRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!stuckToBottomRef.current || virtualItems.length === 0) return
      virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end' })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [virtualItems.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track scroll position to show/hide "jump to bottom" button
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const onScroll = (): void => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowJumpBottom(distanceFromBottom > 300)
      // Read once here rather than at each new message: by then the scroll has
      // already been re-asserted and every position looks like the bottom.
      stuckToBottomRef.current = distanceFromBottom < 200
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // In-session search: toggle, close on session switch, highlight matches
  useEffect(() => {
    const toggle = (): void => setSearchOpen((o) => !o)
    window.addEventListener('nyra:toggle-insession-search', toggle)
    return () => window.removeEventListener('nyra:toggle-insession-search', toggle)
  }, [])

  useEffect(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setActiveMatchIndex(0)
  }, [activeSessionId])

  // Two things happen on opening a chat. The transcript is read back for PRs the
  // live path never saw — chats that predate it, and the restart-between-call-
  // and-result case — and then whatever is on the session has its colour
  // re-asked, because a PR merges on github.com without telling us. In that
  // order: a PR recovered a moment ago should get its state in the same pass
  // rather than waiting for the next time you open the chat. Both are cheap on
  // a chat with nothing to find, which matters because switching chats is
  // something you do dozens of times an hour.
  useEffect(() => {
    if (!activeSessionId) return
    backfillPrs(activeSessionId)
    syncStalePrs(activeSessionId)
  }, [activeSessionId])

  const searchMatches = useMemo(() => searchOpen ? findMatches(messages, searchQuery) : [], [searchOpen, messages, searchQuery])
  const searchMatchCount = searchMatches.length

  useEffect(() => {
    setActiveMatchIndex(0)
  }, [searchQuery])

  const handleSearchNext = useCallback(() => {
    if (searchMatchCount === 0) return
    setActiveMatchIndex((i) => (i + 1) % searchMatchCount)
  }, [searchMatchCount])

  const handleSearchPrev = useCallback(() => {
    if (searchMatchCount === 0) return
    setActiveMatchIndex((i) => (i - 1 + searchMatchCount) % searchMatchCount)
  }, [searchMatchCount])

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setActiveMatchIndex(0)
  }, [])

  useHighlightMatches(messagesRef, searchOpen ? searchQuery : '', activeMatchIndex)


  const subscribeToEvents = useCallback(() => {
    if (cleanupRef.current) cleanupRef.current()
    if (permCleanupRef.current) permCleanupRef.current()

    const cleanup = window.api.claude.onEvent((raw: unknown) => {
      const event = raw as ClaudeEvent
      const { addMessage, updateClaudeSessionId, updateToolResult, addTask, updateTask, setTasks, removeTask, setTaskId, addAgent, updateAgent, addUsage, setMcpServers } =
        useSessionsStore.getState()
      // Route events to the session identified by nyraSessionId tag
      const sid = event.nyraSessionId ?? useSessionsStore.getState().activeSessionId
      if (!sid) return

      if (event.type === 'ai_title') {
        useSessionsStore.getState().applyAiTitle(sid, event.title)
        return
      }

      if (event.type === 'system' && event.subtype === 'init') {
        if (event.mcp_servers) {
          setMcpServers(sid, parseMcpFromInit(event.mcp_servers, event.tools ?? []))
        }
        // What this CLI actually supports, rather than what we last wrote down.
        if (event.slash_commands) noteSlashCommands(event.slash_commands)
        // And what the alias we sent turned out to mean. Read back off the same
        // helper that produced the spawn, so the pair recorded is the request
        // that was actually made and the answer it actually got. Filed twice
        // over: against this chat, which is the only thing that can say what
        // the process now running is on, and against the alias, which is how
        // an unopened model gets a version number next to it in the picker.
        if (event.model) {
          const requested = spawnSettingsForSession(sid).model
          noteModelVersion(requested, event.model)
          useSessionsStore.getState().noteResolvedModel(sid, requested, event.model)
        }
        return
      }

      if (event.type === 'usage') {
        addUsage(sid, {
          inputTokens: event.input_tokens,
          outputTokens: event.output_tokens,
          cacheCreationTokens: event.cache_creation_input_tokens,
          cacheReadTokens: event.cache_read_input_tokens
        })

        // Auto-compaction check
        const { autoCompact, autoCompactThreshold } = useSettingsStore.getState()
        if (autoCompact) {
          const sess = useSessionsStore.getState().sessions.find((s) => s.id === sid)
          if (sess && sess.claudeSessionId && !sess.autoCompacted) {
            const total = sess.usage.inputTokens + sess.usage.outputTokens
            const pct = (total / 1_000_000) * 100
            if (pct >= autoCompactThreshold) {
              const isBusy = isSessionRunning(sid)
              if (isBusy) {
                useSessionsStore.getState().setPendingAutoCompact(sid, true)
              } else {
                useSessionsStore.getState().setAutoCompacted(sid, true)
                addMessage(sid, { id: newMessageId(), role: 'assistant', text: 'Context approaching limit — auto-compacting…' })
                setTimeout(() => sendMessageRef.current?.('/compact', undefined, undefined, sid), 150)
              }
            }
          }
        }
        return
      }

      if (event.type === 'rate_limit') {
        useRateLimitStore.getState().setWindow({
          status: event.status,
          resetsAt: event.resetsAt,
          rateLimitType: event.rateLimitType
        })
        // The utilisation for every window, when the CLI sends it — the
        // top-level fields above only describe the one that is limiting.
        if (event.windows) useRateLimitStore.getState().setUnified(event.windows)
        return
      }

      if (event.type === 'thinking') {
        if (useRunningStore.getState().thinkingSince[sid] === undefined) {
          useRunningStore.getState().startThinking(sid)
        }
      }

      // Clear thinking state when Claude starts doing something (tool use, result, etc.)
      if (event.type === 'tool_start' || event.type === 'result' || event.type === 'stream_end') {
        useRunningStore.getState().stopThinking(sid)
      }

      if (event.type === 'tool_start') {
        pendingToolsRef.current.set(event.tool_id, event.tool_name)
      }

      if (event.type === 'tool_input') {
        const tool_name = event.tool_name ?? pendingToolsRef.current.get(event.tool_id) ?? 'Unknown'
        pendingToolsRef.current.delete(event.tool_id)
        addMessage(sid, {
          id: event.tool_id,
          role: 'tool_call',
          tool_id: event.tool_id,
          tool_name,
          input: event.input,
          originalContent: event.originalContent
        })

        // A PR being opened. Noted on the way past because the result is the
        // only event that carries the number.
        if (isPrCreatingCall(tool_name, event.input)) {
          prCallsRef.current.add(event.tool_id)
        }

        // Intercept task tool events
        if (tool_name === 'TaskCreate') {
          const inp = event.input as Record<string, unknown>
          addTask(sid, {
            taskId: event.tool_id, // temporary, replaced when tool_result arrives
            subject: String(inp.subject ?? ''),
            description: String(inp.description ?? ''),
            activeForm: inp.activeForm ? String(inp.activeForm) : undefined,
            status: 'pending',
            createdByToolId: event.tool_id
          })
        }

        if (tool_name === 'TaskUpdate') {
          const inp = event.input as Record<string, unknown>
          const taskId = String(inp.taskId ?? '')
          if (inp.status === 'deleted') {
            removeTask(sid, taskId)
          } else {
            const updates: Record<string, unknown> = {}
            if (inp.status) updates.status = inp.status as TaskStatus
            if (inp.subject) updates.subject = String(inp.subject)
            if (inp.description) updates.description = String(inp.description)
            if (inp.activeForm) updates.activeForm = String(inp.activeForm)
            updateTask(sid, taskId, updates)
          }
        }

        // TodoWrite sends the entire list at once: { todos: [{ content, status, activeForm }] }
        if (tool_name === 'TodoWrite') {
          const inp = event.input as Record<string, unknown>
          const todos = inp.todos as Array<Record<string, unknown>> | undefined
          if (Array.isArray(todos)) {
            const tasks = todos.map((t, i) => ({
              taskId: `todo-${i}`,
              subject: String(t.content ?? t.subject ?? ''),
              description: '',
              activeForm: t.activeForm ? String(t.activeForm) : undefined,
              status: (t.status as TaskStatus) ?? 'pending',
              createdByToolId: event.tool_id
            }))
            setTasks(sid, tasks)
          }
        }

        // Sub-agent spawned via Task tool
        if (tool_name === 'Agent' || tool_name === 'Task') {
          const inp = event.input as Record<string, unknown>
          addAgent(sid, {
            toolId: event.tool_id,
            name: String(inp.description ?? 'Sub-agent'),
            subagentType: String(inp.subagent_type ?? 'general'),
            status: 'running',
            startedAt: Date.now()
          })
        }
      }

      if (event.type === 'tool_result') {
        updateToolResult(sid, event.tool_id, event.content)

        if (prCallsRef.current.delete(event.tool_id)) {
          const ref = findCreatedPr(event.content ?? '')
          if (ref) {
            useSessionsStore.getState().addPullRequest(sid, { ...ref, createdAt: Date.now() })
            // The state decides the chip's colour, and `gh` is the only thing
            // that knows it. Fire and forget: a chip with no state yet is a
            // neutral chip, not a broken one.
            void syncPrState(sid, ref.url)
          }
        }

        // Extract real task ID from result like "Task #3 created successfully"
        const taskMatch = event.content?.match(/Task #(\d+)/)
        if (taskMatch) {
          setTaskId(sid, event.tool_id, taskMatch[1])
        }

        // Update agent status on completion
        const session = useSessionsStore.getState().sessions.find((s) => s.id === sid)
        const agent = session?.agents?.find((a) => a.toolId === event.tool_id)
        if (agent) {
          const updates: Partial<{
            status: AgentStatus
            durationMs: number
            totalTokens: number
            outputFile: string
          }> = {
            status: 'done',
            durationMs: Date.now() - agent.startedAt
          }
          try {
            const parsed = JSON.parse(event.content)
            if (typeof parsed.totalTokens === 'number') updates.totalTokens = parsed.totalTokens
            if (typeof parsed.totalDurationMs === 'number') updates.durationMs = parsed.totalDurationMs
          } catch { /* result may not be JSON */ }
          // A backgrounded agent answers with a launch receipt naming the file it
          // streams to. Kept on the agent so a tab opened three turns later can
          // still read back what it did, long after the live stream is gone.
          const outputFile = outputFileFromReceipt(event.content)
          if (outputFile) updates.outputFile = outputFile
          updateAgent(sid, event.tool_id, updates)
        }
      }

      if (event.type === 'background_tasks') {
        useBackgroundAgentsStore.getState().setAgents(
          sid,
          event.tasks.map((t) => ({
            taskId: t.task_id,
            description: t.description,
            kind: t.task_type
          }))
        )
        // An agent that finishes after its turn ended is still this session's
        // work, so the Agent Tree should stop calling it done at two seconds.
        //
        // Matched on description because that is all the roster carries. Two
        // agents launched with the same description are indistinguishable here
        // and both stay running until both stop, which is the safe way round:
        // the alternative is calling a live agent dead.
        const outstanding = new Set(event.tasks.map((t) => t.description))
        const sess = useSessionsStore.getState().sessions.find((x) => x.id === sid)
        for (const agent of sess?.agents ?? []) {
          const stillOut = outstanding.has(agent.name)
          if (stillOut && agent.status !== 'running') updateAgent(sid, agent.toolId, { status: 'running' })
          if (!stillOut && agent.status === 'running') {
            updateAgent(sid, agent.toolId, { status: 'done', durationMs: Date.now() - agent.startedAt })
          }
        }
        return
      }

      // What the agent is actually saying, as it says it. Two sources feed this
      // — a foreground subagent's own messages, and Rust tailing the transcript
      // a background one writes — and neither is distinguishable here, which is
      // the point: the panel behaves the same whichever kind you opened.
      if (event.type === 'subagent_stream') {
        useSubagentTranscriptsStore.getState().append(sid, event.tool_id, event.entries)
        return
      }

      // A tail took over from the inline stream for this agent. Whichever got in
      // first, only one of them ends up having written anything.
      if (event.type === 'subagent_reset') {
        useSubagentTranscriptsStore.getState().reset(sid, event.tool_id)
        return
      }

      if (event.type === 'subagent_model') {
        useSubagentTranscriptsStore.getState().noteModel(sid, event.tool_id, event.model)
        // Also evidence about that family: a Task that ran on Haiku is the
        // CLI naming the current Haiku, and numbers the row for everyone.
        noteModelId(event.model)
        updateAgent(sid, event.tool_id, { model: event.model })
        return
      }

      if (event.type === 'background_task_progress') {
        useBackgroundAgentsStore.getState().noteProgress(sid, {
          taskId: event.task_id,
          activity: event.activity,
          kind: event.subagent_type,
          lastTool: event.last_tool_name
        })
        // The same line, against the agent in the tree. A backgrounded Task's
        // tool_result is a handle that returns in two seconds, so this is the
        // only thing that knows it is still going, and for how long.
        if (event.tool_use_id) {
          updateAgent(sid, event.tool_use_id, {
            status: 'running',
            activity: event.activity,
            ...(event.duration_ms > 0 ? { durationMs: event.duration_ms } : {})
          })
        }
        return
      }

      // The CLI acknowledging `/goal`. Its own line in the transcript rather
      // than prose, because it is the CLI speaking, not Claude.
      if (event.type === 'goal_set') {
        addMessage(sid, {
          id: `goal-${Date.now()}`,
          role: 'tool_call',
          tool_id: `goal-${Date.now()}`,
          tool_name: 'GoalSet',
          input: { condition: event.condition },
          result: ''
        })
        return
      }

      if (event.type === 'assistant_text') {
        // The checklist comes out first: a task block is the whole list restated,
        // so it replaces what is there rather than adding to it.
        const withoutTasks = extractTaskBlocks(event.text)
        if (withoutTasks.tasks) foldOrSetTasks(sid, withoutTasks.tasks)
        // Before the ask block, so a reply that both summarises and asks keeps
        // the summary attached to the prose rather than to the questionnaire.
        const withoutChanges = extractChangeBlocks(withoutTasks.text)
        const { text, questions } = extractAskBlocks(withoutChanges.text)
        if (text || withoutChanges.changes) {
          streamedTextRef.current.add(sid)
          addMessage(sid, {
            id: `${Date.now()}-${event.text.length}`,
            role: 'assistant',
            text,
            ...(withoutChanges.changes ? { changes: withoutChanges.changes } : {})
          })
        }
        if (questions.length > 0) {
          streamedTextRef.current.add(sid)
          addMessage(sid, {
            id: `${Date.now()}-ask`,
            role: 'tool_call',
            tool_id: `ask-${Date.now()}`,
            tool_name: 'AskUserQuestion',
            input: { questions }
          })
          useSessionsStore.getState().setNeedsAnswer(sid, true)
        }
        return
      }

      if (event.type === 'plan_ready') {
        // Headless Claude cannot call ExitPlanMode, so the plan arrives as a file
        // it just wrote. Shaped like the tool call it would have been, so one card
        // renders both — whichever way the plan reaches us.
        //
        // An arrival is a draft, not a request. The plan workflow builds a plan up
        // by re-editing one file, so the write that produces a plan is almost never
        // the write that finishes it; it lands in `drafting` and becomes an ask
        // only when the turn ends — see `stream_end`.
        //
        // Nothing here marks an earlier plan denied. The loop that used to do that
        // existed so two cards could not both claim to be waiting, which dedupe by
        // path now prevents — and "Kept planning" is a verdict the user gives, so
        // faking one left a column of rejections nobody ever made.
        const planStore = usePlanApprovalStore.getState()
        const sessions = useSessionsStore.getState()
        // Only a card still in play is refreshed. An answered plan at the same path
        // is a finished one, and a new plan written there deserves its own card
        // rather than quietly reopening a verdict.
        const live = (id: string): boolean =>
          planStore.drafting[id] === sid || planStore.pending[id] === sid
        const existing = (sessions.sessions.find((s) => s.id === sid)?.messages ?? []).find(
          (m): m is ToolCallMessage =>
            m.role === 'tool_call' &&
            (m as ToolCallMessage).tool_name === 'ExitPlanMode' &&
            (m as ToolCallMessage).input.path === event.path &&
            live((m as ToolCallMessage).tool_id)
        )
        if (existing) {
          sessions.updateToolInput(sid, existing.tool_id, { plan: event.plan, path: event.path })
          planStore.draft(existing.tool_id, sid)
          return
        }
        addMessage(sid, {
          id: event.tool_id,
          role: 'tool_call',
          tool_id: event.tool_id,
          tool_name: 'ExitPlanMode',
          input: { plan: event.plan, path: event.path }
        })
        planStore.draft(event.tool_id, sid)
        return
      }

      if (event.type === 'tool_denied') {
        addMessage(sid, {
          id: event.tool_id,
          role: 'tool_call',
          tool_id: event.tool_id,
          tool_name: event.tool_name,
          input: event.input,
          denied: true,
          originalContent: event.originalContent
        })
      }

      if (event.type === 'session_reset') {
        useBackgroundAgentsStore.getState().forget(sid)
        useSessionsStore.getState().setExecuting(sid, null)
        // The conversation is being restarted, so a plan waiting on an answer is
        // waiting on a session that no longer exists.
        usePlanApprovalStore.getState().clearSession(sid)
        // Main process dropped a stale --resume conversation; clear the local id so
        // the retry's fresh session_id can replace it on the upcoming 'result'.
        updateClaudeSessionId(sid, null)
        return
      }

      if (event.type === 'auth_required') {
        // Stash the last user message so we can re-send it after the user logs in
        const sess = useSessionsStore.getState().sessions.find((s) => s.id === sid)
        const lastUser = sess?.messages.slice().reverse().find((m) => m.role === 'user') as TextMessage | undefined
        if (lastUser?.text) {
          pendingAuthRetryRef.current.set(sid, {
            text: lastUser.text,
            images: lastUser.images,
            files: lastUser.files
          })
        }
        window.dispatchEvent(new CustomEvent('nyra:open-login'))
        return
      }

      if (event.type === 'result') {
        if (event.session_id) updateClaudeSessionId(sid, event.session_id)
        const role = event.is_error ? 'error' : 'assistant'
        // `result` repeats the reply Claude has already streamed, so it is only
        // worth showing when nothing was streamed — an error, or a turn whose
        // text never arrived block by block.
        const alreadySaid = streamedTextRef.current.delete(sid)
        if (event.result && (!alreadySaid || event.is_error)) {
          // Headless Claude has no AskUserQuestion, so a question it wants
          // answered arrives as a fenced block in the reply. Lift it out before
          // the text is shown, or the user reads the same question twice.
          const { text, questions } = extractAskBlocks(event.result)
          if (text) addMessage(sid, { id: newMessageId(), role, text })
          if (questions.length > 0 && !event.is_error) {
            addMessage(sid, {
              id: `${Date.now()}-ask`,
              role: 'tool_call',
              tool_id: `ask-${Date.now()}`,
              tool_name: 'AskUserQuestion',
              input: { questions }
            })
            useSessionsStore.getState().setNeedsAnswer(sid, true)
          }
        }
        useRunningStore.getState().endRun(sid)
        // One turn, counted where the CLI actually ends one. The recap needs
        // this because the transcript cannot supply it — see `Session.turns`.
        useSessionsStore.getState().noteTurn(sid)
        foldTasksAtTurnEnd(sid)
        refreshBranch(sid)
        setPermissionQueue((q) => q.filter((p) => p.nyraSessionId !== sid))

        // Send the next queued message, if any. One per turn, in order.
        const queued = useSessionsStore.getState().dequeueMessage(sid)
        if (queued && !event.is_error && sendMessageRef.current) {
          setTimeout(() => sendMessageRef.current?.(queued.text, queued.images, queued.files, sid), 100)
        }

        // Deferred auto-compaction (was busy when threshold was hit)
        const resultSess = useSessionsStore.getState().sessions.find((s) => s.id === sid)
        if (resultSess?.pendingAutoCompact && !event.is_error && sendMessageRef.current) {
          useSessionsStore.getState().setPendingAutoCompact(sid, false)
          useSessionsStore.getState().setAutoCompacted(sid, true)
          addMessage(sid, { id: newMessageId(), role: 'assistant', text: 'Context approaching limit — auto-compacting…' })
          setTimeout(() => sendMessageRef.current?.('/compact', undefined, undefined, sid), 150)
        }
      }

      if (event.type === 'error' && event.result) {
        addMessage(sid, { id: newMessageId(), role: 'error', text: event.result })
        useRunningStore.getState().endRun(sid)
        foldTasksAtTurnEnd(sid)
        setPermissionQueue((q) => q.filter((p) => p.nyraSessionId !== sid))
        // Mark any still-running agents as failed
        const errSession = useSessionsStore.getState().sessions.find((s) => s.id === sid)
        errSession?.agents?.filter((a) => a.status === 'running').forEach((a) => {
          updateAgent(sid, a.toolId, { status: 'failed' })
        })
      }

      if (event.type === 'stream_end') {
        const outstandingAtEnd =
          useBackgroundAgentsStore.getState().bySession[sid] ?? []
        // The child is gone, so anything it had running is gone with it.
        useBackgroundAgentsStore.getState().forget(sid)
        useSessionsStore.getState().setExecuting(sid, null)
        useRunningStore.getState().endRun(sid)
        foldTasksAtTurnEnd(sid)
        setPermissionQueue((q) => q.filter((p) => p.nyraSessionId !== sid))
        // A plan drafted during this turn becomes an ask now the turn is over:
        // ending the turn in plan mode is what handing control back looks like.
        // Unless the turn ended by asking something — a question is its own ask,
        // and a plan raised beside it would be a second one nobody invited.
        const endSession = useSessionsStore.getState().sessions.find((s) => s.id === sid)
        if (!endSession?.needsAnswer) usePlanApprovalStore.getState().promote(sid)
        // Anything still running when the child died did not finish — except a
        // background agent, which is exactly the thing that outlives its turn.
        // Read the roster before `forget` clears it, or every backgrounded agent
        // is marked failed the moment the turn it was spawned in ends.
        const stillOut = new Set(outstandingAtEnd.map((a) => a.description))
        endSession?.agents?.filter((a) => a.status === 'running').forEach((a) => {
          if (stillOut.has(a.name)) return
          updateAgent(sid, a.toolId, { status: 'failed' })
        })
      }
    })

    const permCleanup = window.api.claude.onPermission((raw: unknown) => {
      const perm = raw as PermissionRequest & { nyraSessionId?: string }
      const settings = useSettingsStore.getState()
      // Skip-all overrides everything
      if (settings.skipPermissions) {
        window.api.claude.respondPermission(true, perm.nyraSessionId)
        return
      }
      // Per-tool auto-approve
      if (settings.autoApproveTools.includes(perm.tool_name)) {
        window.api.claude.respondPermission(true, perm.nyraSessionId)
        return
      }
      // A plan is something you read, so it goes in the transcript as a card
      // rather than behind a modal that hides the conversation and then takes
      // the plan with it when you answer.
      if (perm.tool_name === 'ExitPlanMode') {
        usePlanApprovalStore.getState().add(perm.tool_id, perm.nyraSessionId)
        return
      }
      setPermissionQueue((q) => [...q, perm])
    })

    cleanupRef.current = cleanup
    permCleanupRef.current = permCleanup
  }, [])

  useEffect(() => {
    subscribeToEvents()
    return () => {
      cleanupRef.current?.()
      permCleanupRef.current?.()
    }
  }, [subscribeToEvents])


  const processAttachedFile = useCallback((_file: File) => {
    // Drag-and-drop on the chat area dispatches a custom event for ChatInput to handle
    window.dispatchEvent(new CustomEvent('nyra:drop-file', { detail: _file }))
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      await processAttachedFile(file)
    }
  }, [processAttachedFile])

  const handlePermissionRespond = useCallback((approved: boolean): void => {
    // No fallback to the head of the queue. The dialog only ever renders the
    // active session's prompt, so answering anything else means a keyboard
    // shortcut silently approving a tool call in a project you aren't looking at.
    const current = permissionQueue.find((p) => p.nyraSessionId === activeSessionId)
    const sid = current?.nyraSessionId
    setPermissionQueue((q) => {
      const idx = q.findIndex((p) => p.tool_id === current?.tool_id)
      if (idx < 0) return q
      return [...q.slice(0, idx), ...q.slice(idx + 1)]
    })
    // Safety net for denial: main sends stream_end which clears loading, but if
    // that event is delayed/dropped (e.g., the PTY race seen with plan-mode
    // ExitPlanMode rejection), clear loading here so the UI never gets stuck.
    if (!approved && sid) {
      useRunningStore.getState().endRun(sid)
    }
    window.api.claude.respondPermission(approved, sid)
  }, [permissionQueue, activeSessionId])

  const handlePermissionAllowAll = useCallback((): void => {
    const sid = activeSessionId
    const toAllow = permissionQueue.filter((p) => p.nyraSessionId === sid)
    setPermissionQueue((q) => q.filter((p) => p.nyraSessionId !== sid))
    for (const perm of toAllow) {
      window.api.claude.respondPermission(true, perm.nyraSessionId)
    }
  }, [permissionQueue, activeSessionId])

  const handleAllow = useCallback(() => handlePermissionRespond(true), [handlePermissionRespond])
  const handleDeny = useCallback(() => handlePermissionRespond(false), [handlePermissionRespond])

  const handleAlwaysAllow = useCallback((): void => {
    const current = permissionQueue.find((p) => p.nyraSessionId === activeSessionId)
    if (!current) return
    const { autoApproveTools } = useSettingsStore.getState()
    if (!autoApproveTools.includes(current.tool_name)) {
      updateSettings({ autoApproveTools: [...autoApproveTools, current.tool_name] })
    }
    handlePermissionRespond(true)
  }, [permissionQueue, activeSessionId, updateSettings, handlePermissionRespond])

  const sendMessage = useCallback(async (text: string, images?: ImageAttachment[], files?: FileAttachment[], targetSessionId?: string): Promise<void> => {
    // Background events (queued message after result, deferred auto-compact) pass
    // targetSessionId so they route to the session that produced the event, not
    // whichever session the user is currently viewing.
    const routedSid = targetSessionId ?? useSessionsStore.getState().activeSessionId
    const hasAttachments = (images?.length ?? 0) > 0 || (files?.length ?? 0) > 0
    if ((!text.trim() && !hasAttachments) || (routedSid && isSessionRunning(routedSid))) return

    let prompt = text.trim()

    // Claude CLI treats /foo as a skill invocation. If it's neither a real skill
    // nor a built-in CLI command, strip the leading / so it becomes a normal prompt
    // instead of an "Unknown skill" error.
    if (prompt.startsWith('/')) {
      const slashName = prompt.slice(1).split(/\s/)[0]
      const builtInNames = new Set(BUILT_IN_COMMANDS.map((c) => c.name.slice(1).split(/\s/)[0]))
      if (!builtInNames.has(slashName)) {
        // Skills resolve against the project root, not a worktree's directory.
        const skillCwd = activeProjectCwd(useSessionsStore.getState()) || homedir
        try {
          const skills = await window.api.skills.list(skillCwd)
          const allNames = [...skills.global, ...skills.project].map((s) => s.name)
          if (!allNames.includes(slashName)) {
            prompt = prompt.slice(1) // strip leading /
          }
        } catch {
          prompt = prompt.slice(1) // on error, be safe and strip
        }
      }
    }

    pendingToolsRef.current.clear()

    let sid = routedSid
    if (!sid) {
      sid = createSiblingSession()
    }

    useRunningStore.getState().startRun(sid!)
    // Whatever was asked, saying something is an answer to it.
    useSessionsStore.getState().setNeedsAnswer(sid!, false)

    const imgs = images ?? []
    const fls = files ?? []

    // Build the full prompt with attachment data for Claude CLI.
    prompt = withAttachments(prompt, imgs, fls)

    const userMessage: TextMessage = {
      id: newMessageId(),
      role: 'user',
      text: text.trim(),
      ...(imgs.length > 0 ? { images: imgs } : {}),
      ...(fls.length > 0 ? { files: fls.map(({ extractedText: _, ...f }) => f) } : {})
    }
    useSessionsStore.getState().addMessage(sid, userMessage)

    // A Worktree choice made in the composer becomes real here, not on click, so
    // chats that were never used leave nothing on disk.
    if (useSessionsStore.getState().sessions.find((s) => s.id === sid)?.pendingWorktree) {
      const created = await materializeWorktree(sid!)
      if (!created.ok) {
        useSessionsStore.getState().addMessage(sid!, {
          id: newMessageId(),
          role: 'error',
          text: `Could not create the worktree: ${created.error}`
        })
        useRunningStore.getState().endRun(sid!)
        return
      }
    }

    const session = useSessionsStore.getState().sessions.find((s) => s.id === sid)!

    try {
      await window.api.claude.query(
        prompt,
        session.cwd,
        session.claudeSessionId,
        sid,
        session.worktree?.name,
        spawnSettingsForSession(sid)
      )
    } catch (err) {
      useSessionsStore
        .getState()
        .addMessage(sid, { id: newMessageId(), role: 'error', text: String(err) })
      useRunningStore.getState().endRun(sid!)
    }
  }, [])

  sendMessageRef.current = sendMessage

  /**
   * Hand a queued message to the turn that is already running instead of waiting
   * for it to finish. The CLI reads stdin between steps, so the model picks it up
   * at its next one and changes course inside the same turn — one result, no
   * second run.
   *
   * Answers whether it landed. A turn that ended between the render and the click
   * has nothing to steer, and the caller leaves the message queued for the drain
   * rather than dropping it.
   */
  const steerMessage = useCallback(async (msg: QueuedMessage): Promise<boolean> => {
    const sid = useSessionsStore.getState().activeSessionId
    if (!sid) return false

    const text = msg.text.trim()
    const prompt = withAttachments(text, msg.images, msg.files)
    if (!prompt) return false

    let steered = false
    try {
      steered = await window.api.claude.steer(prompt, sid)
    } catch {
      return false
    }
    if (!steered) return false

    // Appended where it happened, between the tool calls it interrupted, because
    // that is where it will read back — the turn kept going around it.
    useSessionsStore.getState().addMessage(sid, {
      id: newMessageId(),
      role: 'user',
      text,
      ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
      ...(msg.files && msg.files.length > 0
        ? { files: msg.files.map(({ extractedText: _, ...f }) => f) }
        : {})
    })
    // Whatever was asked, saying something is an answer to it.
    useSessionsStore.getState().setNeedsAnswer(sid, false)
    return true
  }, [])

  const editAndResend = useCallback(async (messageId: string, newText: string): Promise<void> => {
    const sid = useSessionsStore.getState().activeSessionId
    if (!sid) return

    const session = useSessionsStore.getState().sessions.find((s) => s.id === sid)
    if (!session) return

    // Collect prior conversation context (messages before the edited one)
    const msgIndex = session.messages.findIndex((m) => m.id === messageId)
    const priorMessages = session.messages.slice(0, msgIndex)

    let contextPrefix = ''
    const contextParts: string[] = []
    for (const m of priorMessages) {
      if (m.role === 'user') {
        contextParts.push(`User: ${(m as TextMessage).text}`)
      } else if (m.role === 'assistant') {
        contextParts.push(`Assistant: ${(m as TextMessage).text}`)
      }
    }
    if (contextParts.length > 0) {
      contextPrefix = `[Previous conversation]\n${contextParts.join('\n')}\n\n`
    }

    // Preserve images from the original message
    const originalMsg = session.messages[msgIndex] as TextMessage
    const images = originalMsg.images ?? []

    // Truncate messages from the edited one onward
    useSessionsStore.getState().truncateAtMessage(sid, messageId)

    // Build prompt with context + edited text + images
    let prompt = contextPrefix + newText
    if (images.length > 0) {
      const imagePaths = images.map((img) => `[Image: ${img.path}]`).join('\n')
      prompt = `${prompt}\n\n${imagePaths}`
    }

    // Add user message and send
    useRunningStore.getState().startRun(sid)
    pendingToolsRef.current.clear()

    const userMessage: TextMessage = {
      id: newMessageId(),
      role: 'user',
      text: newText,
      ...(images.length > 0 ? { images } : {})
    }
    useSessionsStore.getState().addMessage(sid, userMessage)

    const updatedSession = useSessionsStore.getState().sessions.find((s) => s.id === sid)!
    try {
      // The worktree name has to match what `sendMessage` passes or the spawn
      // fingerprint flips and every edit-and-resend respawns the child.
      await window.api.claude.query(
        prompt,
        updatedSession.cwd,
        updatedSession.claudeSessionId,
        sid,
        updatedSession.worktree?.name,
        spawnSettingsForSession(sid)
      )
    } catch (err) {
      useSessionsStore.getState().addMessage(sid, { id: newMessageId(), role: 'error', text: String(err) })
      useRunningStore.getState().endRun(sid)
    }
  }, [])

  /**
   * Keep the checklist while there is work in it, then let it go.
   *
   * Pinned above the composer it was useful; pinned there forever, ticked, it is
   * just a box you cannot close. When the last item completes it drops into the
   * transcript as a record of what was done and the strip clears.
   *
   * On the *transition* into finished, not on every finished list — Claude
   * restates the whole block on each status change, so an all-done list arrives
   * more than once and each one would leave another copy behind.
   */
  const foldOrSetTasks = useCallback((sid: string, next: Task[]): void => {
    const store = useSessionsStore.getState()
    const before = store.sessions.find((s) => s.id === sid)?.tasks ?? []
    const finished = next.length > 0 && next.every((t) => t.status === 'completed')
    const wasFinished = before.length > 0 && before.every((t) => t.status === 'completed')

    if (finished && !wasFinished) {
      foldChecklistIntoTranscript(sid, next)
      return
    }
    store.setTasks(sid, next)
  }, [])


  /** Answer a question card: record it on the message, then say it. */
  const handleQuestionAnswer = useCallback((toolId: string, answer: string): void => {
    const sid = useSessionsStore.getState().activeSessionId
    if (!sid) return
    useSessionsStore.getState().updateToolResult(sid, toolId, answer)
    void sendMessageRef.current?.(answer, undefined, undefined, sid)
  }, [])

  /**
   * Answer a plan that came in as a file.
   *
   * Approving means leaving plan mode, because plan mode is what stops Claude
   * writing — and leaving it respawns the child, which is only survivable
   * because the spawn now carries `--resume`.
   */
  const handlePlanAnswer = useCallback(
    (toolId: string, verdict: PlanAnswer, planPath?: string, note?: string): void => {
      const sid = useSessionsStore.getState().activeSessionId
      usePlanApprovalStore.getState().resolve(toolId)
      if (!sid) return
      if (verdict === 'reject') {
        useSessionsStore.getState().markToolDenied(sid, toolId)
        // Plan mode stays on, so nothing respawns and Claude keeps the thread.
        if (note) void sendMessageRef.current?.(note, undefined, undefined, sid)
        return
      }
      // Leaving plan mode is what lets Claude write at all, so both yeses do it.
      // It changes the spawn fingerprint and respawns the child; `--resume`
      // is what keeps the conversation across that.
      useSessionsStore.getState().setSessionSettings(sid, { planMode: false })
      if (verdict === 'approve-auto') {
        useSessionsStore.getState().setAutoAcceptEdits(sid, true)
      }
      const store = useSessionsStore.getState()
      const planMessage = store.sessions
        .find((x) => x.id === sid)
        ?.messages.find((m) => m.role === 'tool_call' && (m as ToolCallMessage).tool_id === toolId)
      const title = planMessage
        ? splitPlan(extractPlan((planMessage as ToolCallMessage).input)).title
        : 'Carrying out the plan'
      store.setExecuting(sid, { title, startedAt: Date.now() })
      const where = planPath ? ` at ${planPath}` : ''
      void sendMessageRef.current?.(
        `Approved — implement the plan${where}.`,
        undefined,
        undefined,
        sid
      )
    },
    []
  )

  /** Abort the running turn. Also drops any permission prompts still queued for it. */
  const handleStopTurn = useCallback(() => {
    window.api.claude.abort(activeSessionId ?? undefined)
    if (activeSessionId) {
      useBackgroundAgentsStore.getState().forget(activeSessionId)
      useSessionsStore.getState().setExecuting(activeSessionId, null)
    }
    setPermissionQueue((q) => q.filter((p) => p.nyraSessionId !== activeSessionId))
  }, [activeSessionId])

  /**
   * The recap's one paid button: the CLI's own `/recap`, which reads the
   * conversation it is already holding and writes the prose summary. Nyra does
   * not attempt its own — the transcript is right there, and a second summariser
   * would only disagree with the first.
   */
  const handleRecapSummarise = useCallback(() => {
    if (!activeSessionId) return
    useSessionsStore.getState().dismissAway(activeSessionId)
    void sendMessage('/recap', undefined, undefined, activeSessionId)
  }, [activeSessionId, sendMessage])

  /** Scroll back to the first message you missed. */
  const handleRecapJump = useCallback(
    (messageId: string) => {
      const index = virtualItems.findIndex(
        (item) =>
          (item.kind === 'message' && item.msg.id === messageId) ||
          (item.kind === 'tool_group' && item.firstId === messageId) ||
          (item.kind === 'memory' && item.firstId === messageId)
      )
      if (index < 0) return
      stuckToBottomRef.current = false
      virtualizer.scrollToIndex(index, { align: 'start', behavior: 'smooth' })
    },
    [virtualItems, virtualizer]
  )

  /**
   * Fold the worktree's branch back into the main one.
   *
   * Passes the session's own cwd and lets the backend resolve the main working
   * tree from it — deriving that path here is what once made this merge the
   * branch into itself and report success.
   */
  const handleWorktreeMerge = useCallback(async (): Promise<void> => {
    const session = useSessionsStore.getState().sessions.find((x) => x.id === activeSessionId)
    const wt = session?.worktree
    if (!session || !wt) return
    const result = await window.api.git.worktreeMerge(session.cwd, wt.branch)
    const store = useSessionsStore.getState()
    store.addMessage(session.id, {
      id: newMessageId(),
      role: result.success ? 'assistant' : 'error',
      text: result.success
        ? `Merged **${wt.branch}** into **${result.into ?? 'the main branch'}**.`
        : `Merge failed: ${result.error}`
    })
  }, [activeSessionId])

  /** Remove the worktree and, with it, the chat that is the only handle on it. */
  const handleWorktreeRemove = useCallback(async (): Promise<void> => {
    const session = useSessionsStore.getState().sessions.find((x) => x.id === activeSessionId)
    const wt = session?.worktree
    if (!session || !wt) return
    const result = await window.api.git.worktreeRemove(session.cwd, wt.path)
    const store = useSessionsStore.getState()
    if (!result.success) {
      // Keep the session: it is the only handle left on a worktree that is
      // still on disk.
      store.addMessage(session.id, {
        id: newMessageId(),
        role: 'error',
        text: `Could not remove the worktree: ${result.error}`
      })
      return
    }
    store.deleteSession(session.id)
  }, [activeSessionId])

  const copyConversation = useCallback(() => {
    const parts: string[] = []
    for (const msg of messages) {
      if (msg.role === 'user') parts.push(`**User:** ${(msg as TextMessage).text}`)
      else if (msg.role === 'assistant') parts.push(`**Assistant:** ${(msg as TextMessage).text}`)
      else if (msg.role === 'tool_call') {
        const tc = msg as ToolCallMessage
        const inp = tc.input as Record<string, unknown>
        const summary = inp.command ?? inp.file_path ?? inp.pattern ?? ''
        parts.push(`> **Tool:** \`${tc.tool_name}\`${summary ? ` — ${summary}` : ''}`)
      }
    }
    navigator.clipboard.writeText(parts.join('\n\n'))
  }, [messages])

  // Reachable from the palette and from a binding, not only from the header
  // button, which is the point of it being a registered command.
  useEffect(() => {
    const handler = (): void => copyConversation()
    window.addEventListener('nyra:copy-conversation', handler)
    return () => window.removeEventListener('nyra:copy-conversation', handler)
  }, [copyConversation])

  const handleStartEdit = useCallback((id: string, text: string) => {
    setEditingMessageId(id)
    setEditText(text)
  }, [])

  const handleForkFromMessage = useCallback((messageId: string) => {
    const sid = useSessionsStore.getState().activeSessionId
    if (!sid) return
    const newId = useSessionsStore.getState().forkSession(sid, messageId)
    if (newId) {
      const forkInfo = useSessionsStore.getState().sessions.find((s) => s.id === newId)?.forkOf
      useSessionsStore.getState().addMessage(newId, {
        id: newMessageId(),
        role: 'assistant',
        text: `⑂ Forked from **"${forkInfo?.title ?? 'previous session'}"**. History copied up to this point.\n\nOriginal session is unchanged. The next message starts a fresh Claude session.`
      })
    }
  }, [])

  // Only show permission dialogs for the currently viewed session
  const currentPermission = permissionQueue.find((p) => p.nyraSessionId === activeSessionId) ?? null

  return (
    <div
      className="flex h-full flex-col relative"
      style={columnGeometry}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-info/50 bg-info/10 px-12 py-10">
            <FileText className="size-10 text-info" />
            <p className="text-sm font-medium text-info">Drop files here</p>
            <p className="text-[11px] text-info">Any file — images and documents are read here, the rest by path</p>
          </div>
        </div>
      )}

      {/* In-session search bar */}
      {searchOpen && (
        <InSessionSearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          matchCount={searchMatchCount}
          activeIndex={activeMatchIndex}
          onNext={handleSearchNext}
          onPrev={handleSearchPrev}
          onClose={handleSearchClose}
        />
      )}

      {/* Messages — virtualized */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      {/* The summary and the browser miniature share one right-aligned column,
          so the miniature sits below the summary when it is open and takes its
          place when it is not — no offset to compute, and nothing to keep in
          sync when the summary changes height. Both float over the messages, so
          glancing at either never reflows the conversation. */}
      <div
        className="pointer-events-none absolute top-3 z-30 flex max-h-[calc(100%-40px)] flex-col gap-2"
        style={{ ...OUTSIDE_SCROLLER, left: SUMMARY_OFFSET, width: SUMMARY_WIDTH }}
      >
        <SummaryPanel />
        <BrowserPip />
      </div>

      {/* The column is centred and width-limited, and stays put when the summary
          opens — the summary floats in the gutter rather than pushing the text.
          Only the workspace rail changes the column's position, by narrowing the
          area it centres in. The measure is deliberately short so there is a
          gutter for the summary to float in. */}
      <div
        ref={messagesRef}
        className="scroll-auto-hide relative flex-1 overflow-y-scroll pb-8 pt-4"
        // The conversation's own type, set once here rather than as a class of
        // hardcoded px. The composer reads the same three variables, so the two
        // cannot drift apart.
        style={{
          fontSize: 'var(--content-font-size, 15px)',
          fontFamily: 'var(--font-content)',
          fontWeight: 'var(--content-font-weight, 400)'
        }}
      >
       {/* The column centres in this container — the room the conversation
           actually has, between whichever rails are open — and gives ground to
           the right only where the floating summary would otherwise leave the
           window. chatColumn.ts has the arithmetic and the reasoning. */}
       <div
         className="relative"
         style={{
           ...columnGeometry,
           width: 'var(--col-w)',
           marginLeft: COLUMN_OFFSET
         } as React.CSSProperties}
       >
        {activeSession?.worktreeSnapshotted && !activeSession.worktree && (
          <RestoreWorktreeBanner sessionId={activeSession.id} />
        )}

        {/* Merge and Remove used to live in the header bar, which is gone. They
            belong here anyway: the banner is the only thing on screen that says
            this chat has a worktree, so it should also be what offers to finish
            with it. Hidden mid-turn — neither is safe while Claude is writing. */}
        {activeSession?.worktree && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-info/15 bg-info/6 px-3 py-2">
            <Info className="size-3.5 shrink-0 text-info" />
            <p className="min-w-0 flex-1 text-[11px] text-info">
              Worktree session — changes are isolated in{' '}
              <span className="font-mono font-medium">{activeSession.worktree.branch}</span>
            </p>
            {!isLoading && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleWorktreeMerge}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-success/20 px-2 py-0.5 text-[11px] text-success transition-colors hover:bg-success/10"
                    >
                      <GitMerge className="size-3" />
                      Merge
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Merge worktree branch into main</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleWorktreeRemove}
                      aria-label="Remove worktree and delete session"
                      className="shrink-0 rounded-md border border-danger/20 px-1.5 py-0.5 text-danger transition-colors hover:bg-danger/10 hover:text-danger/80"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Remove worktree and delete session</TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
        )}
        {messages.length === 0 && !isLoading && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-[32px] font-semibold tracking-tight text-foreground/[0.07]">Nyra</p>
            <p className="text-xs text-muted-foreground">Start typing or pick a skill from the sidebar</p>
          </div>
        )}

        {virtualItems.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const item = virtualItems[vItem.index]

              if (item.kind === 'separator') {
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vItem.start}px)` }}
                  >
                    <div className={`flex items-center gap-3 py-2`}>
                      <div className="flex-1 h-px bg-accent/50" />
                      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{item.label}</span>
                      <div className="flex-1 h-px bg-accent/50" />
                    </div>
                  </div>
                )
              }

              if (item.kind === 'loading') {
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vItem.start}px)` }}
                  >
                    {/* Not the transcript's usual py-2. Top-weighted on
                        purpose: the space belongs above the indicator, between
                        what is finished and what is still going, rather than
                        under it where the composer already provides some. */}
                    <div className="flex justify-start pt-5 pb-2">
                      <ThinkingIndicator
                        startTime={activeSessionId ? thinkingSince[activeSessionId] : undefined}
                      />
                    </div>
                  </div>
                )
              }

              if (item.kind === 'memory') {
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vItem.start}px)` }}
                  >
                    <MemoryChip writes={item.writes} />
                  </div>
                )
              }

              if (item.kind === 'tool_group') {
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vItem.start}px)` }}
                  >
                    <ToolCallGroup
                      messages={item.messages}
                      isLoading={isLoading}
                      onPlanAnswer={handlePlanAnswer}
                      onQuestionAnswer={handleQuestionAnswer}
                    />
                  </div>
                )
              }

              const msg = item.msg
              // A user message is the thing you scroll back to find, and at the
              // turn's own py-2 two of them in a row sat sixteen pixels apart in
              // a wall of assistant prose. Double the rhythm on both sides: it
              // is also what puts air under a question card, which otherwise
              // ended a hairline above the answer you gave it.
              const gap = msg.role === 'user' ? 'py-4' : 'py-2'

              if (editingMessageId === msg.id && msg.role === 'user') {
                const textMsg = msg as TextMessage
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vItem.start}px)` }}
                  >
                    <div data-message-id={msg.id} className={`flex justify-end ${gap}`}>
                      <div className="max-w-[75%] w-full">
                        <EditMessageBox
                          value={editText}
                          images={textMsg.images}
                          onChange={setEditText}
                          onCancel={() => { setEditingMessageId(null); setEditText('') }}
                          onSave={() => { const mid = editingMessageId!; const text = editText; setEditingMessageId(null); setEditText(''); editAndResend(mid, text) }}
                        />
                      </div>
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vItem.start}px)` }}
                >
                  <div data-message-id={msg.id} className={gap}>
                    <MessageRow
                      message={msg}
                      isLoading={isLoading}
                      onEdit={msg.role === 'user' && !isLoading ? handleStartEdit : undefined}
                      onFork={msg.role === 'user' && !isLoading ? handleForkFromMessage : undefined}
                      onPlanAnswer={handlePlanAnswer}
                      onQuestionAnswer={handleQuestionAnswer}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
       </div>
      </div>
      {/* Anchored to the message area, not the whole column, so it floats clear
          of the composer instead of on top of it — but centred on the column
          rather than on the panel. left-1/2 put it over the middle of the
          window while the composer under it was centred on the conversation,
          and a pill that does not line up with the box below it reads as a
          layout bug rather than a control. Same expression the composer uses,
          resolved against the same box. */}
      {showJumpBottom && (
        <button
          onClick={() => {
            stuckToBottomRef.current = true
            virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end', behavior: 'smooth' })
          }}
          style={
            {
              ...columnGeometry,
              ...OUTSIDE_SCROLLER,
              left: `calc(${COLUMN_OFFSET} + var(--col-w) / 2)`
            } as React.CSSProperties
          }
          className="absolute bottom-4 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-accent px-3 py-1.5 text-[11px] text-foreground/80 shadow-lg transition-all hover:bg-secondary hover:text-foreground"
        >
          <ChevronDown className="size-3" />
          Jump to bottom
        </button>
      )}
      </div>


      {/* Input */}
      {/* The composer lines up with the conversation, same geometry. */}
      <div
        style={
          {
            ...columnGeometry,
            ...OUTSIDE_SCROLLER,
            width: 'var(--col-w)',
            marginLeft: COLUMN_OFFSET
          } as React.CSSProperties
        }
      >
        <SessionRecap
          sessionId={activeSessionId}
          onSummarise={handleRecapSummarise}
          onJump={handleRecapJump}
        />
        <ActivityStrip sessionId={activeSessionId} onStop={handleStopTurn} />
        <TaskStrip />
        {/* The plan and the question are no longer siblings of the composer —
            they live inside it, so each reads as the top half of the control you
            answer it with rather than a card stacked above one. */}
        <ChatInput
          cwd={cwd}
          isLoading={isLoading}
          sendMessage={sendMessage}
          steerMessage={steerMessage}
          onStop={handleStopTurn}
          pendingPlan={pendingPlan}
          onPlanAnswer={handlePlanAnswer}
          liveQuestion={pendingQuestion}
          onQuestionAnswer={handleQuestionAnswer}
        />
      </div>

      {currentPermission && (
        <PermissionDialog
          permission={currentPermission}
          queueLength={permissionQueue.filter((p) => p.nyraSessionId === activeSessionId).length}
          onAllow={handleAllow}
          onDeny={handleDeny}
          onAllowAll={handlePermissionAllowAll}
          onAlwaysAllow={handleAlwaysAllow}
        />
      )}

      {statsOpen && <StatsModal onClose={() => setStatsOpen(false)} />}
      {copyBlocksOpen && <CopyBlocksModal onClose={() => setCopyBlocksOpen(false)} />}
      {releaseNotesOpen && <ReleaseNotesModal onClose={() => setReleaseNotesOpen(false)} />}
    </div>
  )
}

/**
 * Offered when a chat's managed worktree was pruned to stay under the cap.
 *
 * Codex shows the same affordance on reopening such a chat. It is the other half
 * of the snapshot: without a way back, automatic deletion is just data loss.
 */
function RestoreWorktreeBanner({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/6 px-3 py-2">
      <p className="flex-1 text-[11px] text-warning">
        {error ?? 'This chat\u2019s worktree was cleaned up. Its work was saved.'}
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          const result = await restoreWorktree(sessionId)
          if (!result.ok) setError(result.error)
          setBusy(false)
        }}
        className="rounded-sm border border-warning/30 px-2 py-0.5 text-[11px] font-medium text-warning/80 hover:bg-warning/10 transition-colors disabled:opacity-40"
      >
        {busy ? 'Restoring\u2026' : 'Restore worktree'}
      </button>
    </div>
  )
}


/**
 * The turn is running.
 *
 * Eyes, a verb, and the clock if we know when it started. The clock is the only
 * one of the three carrying information — the other two exist because a line
 * that only ticks a number reads as a stopwatch someone left on, and Nyra has
 * nothing truer to report between tool calls than "still going".
 *
 * `startTime` is absent when the reply began before this session was being
 * watched; the indicator then drops the counter rather than inventing a zero,
 * and everything else about it is the same.
 */
function ThinkingIndicator({ startTime }: { startTime?: number }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  const word = useWorkingWord()

  useEffect(() => {
    if (startTime === undefined) return
    setElapsed(Date.now() - startTime)
    const id = setInterval(() => setElapsed(Date.now() - startTime), 100)
    return () => clearInterval(id)
  }, [startTime])

  return (
    <span className="flex items-center gap-2 text-c-md">
      <span className="nyra-eyes" aria-hidden="true">
        <span className="nyra-eye" />
        <span className="nyra-eye" />
      </span>
      <span className="nyra-shimmer font-medium">{word}…</span>
      {startTime !== undefined && (
        <span className="font-mono text-c-sm text-muted-foreground">
          {(elapsed / 1000).toFixed(1)}s
        </span>
      )}
    </span>
  )
}

const MessageRow = React.memo(function MessageRow({ message, isLoading, onEdit, onFork, onPlanAnswer, onQuestionAnswer }: { message: Message; isLoading?: boolean; onEdit?: (id: string, text: string) => void; onFork?: (id: string) => void; onPlanAnswer?: (toolId: string, answer: PlanAnswer, planPath?: string, note?: string) => void; onQuestionAnswer?: (toolId: string, answer: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  if (message.role === 'tool_call') {
    const tc = message as ToolCallMessage
    if (tc.tool_name === 'AskUserQuestion') {
      return <AskUserQuestionCard message={tc} onAnswer={onQuestionAnswer} />
    }
    if (tc.tool_name === 'ExitPlanMode') {
      return <PlanCard message={tc} onAnswer={onPlanAnswer} />
    }
    return <ToolCallCard message={tc} isLoading={isLoading} />
  }

  if (message.role === 'user') {
    const textMsg = message as TextMessage
    return (
      <div className="flex flex-col items-end group/msg">
        <div className="relative max-w-[85%] rounded-lg bg-bubble px-4 py-2.5 text-bubble-foreground">
          {onEdit && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onEdit(textMsg.id, textMsg.text)}
                  className="absolute -left-8 top-2 rounded-md p-1 text-transparent transition-colors group-hover/msg:text-muted-foreground hover:text-foreground!"
                  aria-label="Edit message"
                >
                  <SquarePen className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Edit message</TooltipContent>
            </Tooltip>
          )}
          {onFork && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onFork(textMsg.id)}
                  className="absolute -left-14 top-2 rounded-md p-1 text-transparent transition-colors group-hover/msg:text-muted-foreground hover:text-foreground!"
                  aria-label="Fork from this message"
                >
                  <GitFork className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Fork from this message</TooltipContent>
            </Tooltip>
          )}
          <div className="nyra-on-bubble">
          {textMsg.images && textMsg.images.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {textMsg.images.map((img, i) => (
                <ZoomableImage
                  key={i}
                  src={img.dataUrl}
                  name={`Image ${i + 1}`}
                  className="h-20 rounded-lg object-cover max-w-[200px]"
                />
              ))}
            </div>
          )}
          {textMsg.files && textMsg.files.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-2">
              {/* Clickable, like the @-mention chips below it: a file you
                  attached is a file you may want to look at again, and the
                  panel is where every other path in the app opens. */}
              {textMsg.files.map((file) => (
                <button
                  key={file.id}
                  onClick={() => openFileInPanel(file.path)}
                  title={file.path}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2 py-0.5 text-c-sm transition-colors hover:bg-accent/60"
                >
                  <FileText className="size-2.5 opacity-60" />
                  {file.name}
                </button>
              ))}
            </div>
          )}
          {/* The same markdown the composer previewed while it was being
              written, chips and all — not the raw characters. */}
          <div className="wrap-break-word wrap-anywhere">
            <MarkdownRenderer prompt>{textMsg.text}</MarkdownRenderer>
          </div>
          </div>
        </div>
        {/* Outside the bubble, or the bubble reserves a line for a timestamp
            nobody is looking at and sits taller than its own text. */}
        {message.timestamp && (
          <div className="mt-1 text-c-xs text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100">
            {formatMessageTime(message.timestamp)}
          </div>
        )}
      </div>
    )
  }

  if (message.role === 'error') {
    return (
      <div className={`rounded-lg border border-danger/20 bg-danger/5 text-danger whitespace-pre-wrap px-4 py-3`}>
        {message.text}
      </div>
    )
  }

  const copyText = (): void => {
    const el = contentRef.current
    const plain = el?.innerText ?? message.text
    const html = el?.innerHTML ?? message.text
    navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([plain], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' })
      })
    ])
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Assistant replies are the page, not a card on it: flat prose filling the
  // column, the way Codex reads. The bubble only earns its keep on the user
  // side, where it marks the turn.
  return (
    <div className="group/msg relative text-foreground">
      <div ref={contentRef}>
        <MarkdownRenderer>{message.text}</MarkdownRenderer>
      </div>
      {/* Outside `contentRef` on purpose: Copy yields the reply's prose, and a
          table of line counts is not something you want in your clipboard. */}
      {message.changes && <ChangesCard block={message.changes} />}
      {/* Actions sit under the reply, not floating beside its first line — a long
          answer's controls belong where you finish reading it. */}
      <div className="mt-1 flex opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={copyText}
              className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-c-md transition-colors hover:bg-accent/50 ${
                copied ? 'text-success' : 'text-muted-foreground hover:text-foreground'
              }`}
              aria-label="Copy response"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </TooltipTrigger>
          <TooltipContent>Copy response</TooltipContent>
        </Tooltip>
        {message.timestamp && (
          <span className="flex items-center px-1.5 text-c-md text-muted-foreground">
            {formatMessageTime(message.timestamp)}
          </span>
        )}
      </div>
    </div>
  )
})
