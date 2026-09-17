import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronDown, Copy, FileText, GitBranch, GitFork, GitMerge, Info, Search, SquarePen, Trash2, TriangleAlert } from 'lucide-react'
import { useSessionsStore, activeCwd, activeProjectCwd, createSiblingSession, openFolderAsProject, type Message, type TextMessage, type ToolCallMessage, type ImageAttachment, type FileAttachment, type TaskStatus, type AgentStatus } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { spawnSettingsFor } from '@shared/types'
import { materializeWorktree, restoreWorktree } from '../lib/worktrees'
import MarkdownRenderer from './MarkdownRenderer'
import ToolCallCard from './ToolCallCard'
import AskUserQuestionCard from './AskUserQuestionCard'
import PlanCard from './PlanCard'
import { usePlanApprovalStore } from '../store/planApprovals'
import { extractAskBlocks } from '../lib/askBlocks'
import ToolCallGroup from './ToolCallGroup'
import PermissionDialog, { type PermissionRequest } from './PermissionDialog'
import ChatInput from './ChatInput'
import TaskStrip from './TaskStrip'
import SettingsModal from './SettingsModal'
import PermissionsModal from './PermissionsModal'
import StatsModal from './StatsModal'
import CopyBlocksModal from './CopyBlocksModal'
import ReleaseNotesModal from './ReleaseNotesModal'
import InSessionSearchBar from './InSessionSearchBar'
import TasksChip from './TasksChip'
import SummaryPanel from './SummaryPanel'
import { findMatches } from '../utils/inSessionSearch'
import { useHighlightMatches } from '../hooks/useHighlightMatches'
import { parseMcpFromInit } from '../utils/mcpParsing'
import { useRateLimitStore } from '../store/rateLimit'
import { useRunningStore, isSessionRunning } from '../store/running'
import { useUiStore } from '../store/ui'
import { useLoopsStore } from '../store/loops'
import { BUILT_IN_COMMANDS } from '../data/commands'

const EMPTY_MESSAGES: Message[] = []
const BOUNCE_DOTS = [0, 1, 2]
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
  | { type: 'system'; subtype: string; mcp_servers?: { name: string; status: string }[]; tools?: string[] }
  | { type: 'rate_limit'; status: string; resetsAt: number; rateLimitType: string }
  | { type: 'plan_ready'; tool_id: string; path: string; plan: string }
  | { type: 'session_reset'; reason: string }
  | { type: 'auth_required'; message: string }
)

/**
 * The conversation column's geometry, shared by the message list and composer.
 *
 * It is centred on the *window*, not on the container it sits in, so it holds
 * still when a rail opens instead of jumping. Two constraints bound it: it never
 * slides under the floating summary, and it never touches the left rail. Between
 * those it tracks the window centre, which is what makes it drift left as the
 * window narrows rather than vanishing behind the panel.
 *
 * Sliding clears the summary on a wide window. On a narrower one the column
 * gives up some width too, but only down to --col-min; past that it stops
 * shrinking and lets the summary float on top, because a 34rem measure that
 * stays visible beats a 12rem one that technically never overlaps.
 *
 * --rail is the one part of the window geometry CSS cannot work out for itself.
 */
const COLUMN_OFFSET =
  'clamp(var(--gap),' +
  ' calc(50vw - var(--col-w) / 2 - var(--rail)),' +
  ' calc(100% - var(--gutter) - var(--col-w)))'

function columnVars(railOpen: boolean, summaryOpen: boolean): React.CSSProperties {
  return {
    // 10% off the 46rem this started at — a shorter measure to read against.
    '--col-max': '41.4rem',
    '--col-min': '34rem',
    '--rail': railOpen ? '16rem' : '0rem',
    '--gutter': summaryOpen ? '20rem' : '0rem',
    '--gap': '1.5rem',
    '--col-w':
      'min(var(--col-max), 100%, max(var(--col-min), calc(100% - var(--gap) - var(--gutter))))'
  } as React.CSSProperties
}

// Panel state comes from the ui store rather than props: the title bar owns the
// toggles now, so threading them back down through App would be a detour.
export default function Chat(): React.JSX.Element {
  const running = useRunningStore((s) => s.running)
  const summaryOpen = useUiStore((s) => s.summaryOpen)
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const projectsPanelOpen = useUiStore((s) => s.projectsPanelOpen)
  const columnGeometry = useMemo(
    () => columnVars(projectsPanelOpen, summaryOpen),
    [projectsPanelOpen, summaryOpen]
  )
  const onToggleRightPanel = useUiStore((s) => s.toggleRightPanel)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const thinkingSince = useRunningStore((s) => s.thinkingSince)
  const [permissionQueue, setPermissionQueue] = useState<(PermissionRequest & { nyraSessionId?: string })[]>([])
  const messagesRef = useRef<HTMLDivElement>(null)
  const [showJumpBottom, setShowJumpBottom] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  const permCleanupRef = useRef<(() => void) | null>(null)
  // Tracks tool_start before tool_input arrives (contains name before input is parsed)
  const pendingToolsRef = useRef<Map<string, string>>(new Map())
  const [isDragging, setIsDragging] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [copyBlocksOpen, setCopyBlocksOpen] = useState(false)
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
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
  const effort = useSettingsStore((s) => s.effort)
  const model = useSettingsStore((s) => s.model)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const fontSize = useSettingsStore((s) => s.fontSize)
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
    const handler = (): void => setPermissionsOpen(true)
    window.addEventListener('nyra:open-permissions', handler)
    return () => window.removeEventListener('nyra:open-permissions', handler)
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
        id: Date.now().toString(), role: 'assistant',
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
          id: Date.now().toString(), role: 'assistant', text: 'Loop stopped.'
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
  const claudeSessionId = activeSession?.claudeSessionId ?? null
  const usage = activeSession?.usage ?? null

  const isLoading = activeSessionId ? running[activeSessionId] === true : false
  const CONTEXT_LIMIT = 1_000_000
  const usagePct = usage ? Math.min(((usage.inputTokens + usage.outputTokens) / CONTEXT_LIMIT) * 100, 100) : 0

  // Build virtual items: interleave date separators with messages, plus loading indicator
  type VirtualItem =
    | { kind: 'separator'; label: string }
    | { kind: 'message'; msg: Message; idx: number }
    | { kind: 'tool_group'; messages: ToolCallMessage[]; firstId: string }
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
        // Denied calls and AskUserQuestion get their own group for visibility
        if (tc.denied || tc.tool_name === 'AskUserQuestion') {
          items.push({ kind: 'tool_group', messages: [tc], firstId: tc.id })
        } else {
          const last = items[items.length - 1]
          if (
            last?.kind === 'tool_group' &&
            !last.messages.some((m) => m.denied || m.tool_name === 'AskUserQuestion')
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
      if (item.kind === 'separator') return `sep-${index}`
      if (item.kind === 'loading') return 'loading'
      if (item.kind === 'tool_group') return `tg-${item.firstId}`
      return item.msg.id
    },
  })

  // Scroll to bottom on session switch
  useEffect(() => {
    if (virtualItems.length > 0) {
      virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end' })
    }
  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll when new messages arrive (only if near bottom)
  const prevCountRef = useRef(virtualItems.length)
  useEffect(() => {
    if (virtualItems.length > prevCountRef.current) {
      const el = messagesRef.current
      if (el) {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distanceFromBottom < 200) {
          virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end', behavior: 'smooth' })
        }
      }
    }
    prevCountRef.current = virtualItems.length
  }, [virtualItems.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track scroll position to show/hide "jump to bottom" button
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const onScroll = (): void => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowJumpBottom(distanceFromBottom > 300)
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

  const handlePickFolder = async (): Promise<void> => {
    const folder = await window.api.dialog.pickFolder()
    // Picking a folder adds it to the rail rather than opening a one-off chat in
    // it — otherwise the chat would have nowhere to live but Recents.
    if (folder) openFolderAsProject(folder)
  }

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

      if (event.type === 'system' && event.subtype === 'init') {
        if (event.mcp_servers) {
          setMcpServers(sid, parseMcpFromInit(event.mcp_servers, event.tools ?? []))
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
                addMessage(sid, { id: Date.now().toString(), role: 'assistant', text: 'Context approaching limit — auto-compacting…' })
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

        // Extract real task ID from result like "Task #3 created successfully"
        const taskMatch = event.content?.match(/Task #(\d+)/)
        if (taskMatch) {
          setTaskId(sid, event.tool_id, taskMatch[1])
        }

        // Update agent status on completion
        const session = useSessionsStore.getState().sessions.find((s) => s.id === sid)
        const agent = session?.agents?.find((a) => a.toolId === event.tool_id)
        if (agent) {
          const updates: Partial<{ status: AgentStatus; durationMs: number; totalTokens: number }> = {
            status: 'done',
            durationMs: Date.now() - agent.startedAt
          }
          try {
            const parsed = JSON.parse(event.content)
            if (typeof parsed.totalTokens === 'number') updates.totalTokens = parsed.totalTokens
            if (typeof parsed.totalDurationMs === 'number') updates.durationMs = parsed.totalDurationMs
          } catch { /* result may not be JSON */ }
          updateAgent(sid, event.tool_id, updates)
        }
      }

      if (event.type === 'plan_ready') {
        // Headless Claude cannot call ExitPlanMode, so the plan arrives as a file
        // it just wrote. Shaped like the tool call it would have been, so one card
        // renders both — whichever way the plan reaches us.
        addMessage(sid, {
          id: event.tool_id,
          role: 'tool_call',
          tool_id: event.tool_id,
          tool_name: 'ExitPlanMode',
          input: { plan: event.plan, path: event.path }
        })
        // A revised plan supersedes the draft above it. Marking the old card
        // "kept planning" is what actually happened — planning carried on — and
        // stops two cards both claiming to be waiting on an answer.
        const planStore = usePlanApprovalStore.getState()
        for (const [priorToolId, priorSid] of Object.entries(planStore.pending)) {
          if (priorSid !== sid || priorToolId === event.tool_id) continue
          useSessionsStore.getState().markToolDenied(sid, priorToolId)
          planStore.resolve(priorToolId)
        }
        planStore.add(event.tool_id, sid)
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
        if (event.result) {
          // Headless Claude has no AskUserQuestion, so a question it wants
          // answered arrives as a fenced block in the reply. Lift it out before
          // the text is shown, or the user reads the same question twice.
          const { text, questions } = extractAskBlocks(event.result)
          if (text) addMessage(sid, { id: Date.now().toString(), role, text })
          if (questions.length > 0 && !event.is_error) {
            addMessage(sid, {
              id: `${Date.now()}-ask`,
              role: 'tool_call',
              tool_id: `ask-${Date.now()}`,
              tool_name: 'AskUserQuestion',
              input: { questions }
            })
          }
        }
        useRunningStore.getState().endRun(sid)
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
          addMessage(sid, { id: Date.now().toString(), role: 'assistant', text: 'Context approaching limit — auto-compacting…' })
          setTimeout(() => sendMessageRef.current?.('/compact', undefined, undefined, sid), 150)
        }
      }

      if (event.type === 'error' && event.result) {
        addMessage(sid, { id: Date.now().toString(), role: 'error', text: event.result })
        useRunningStore.getState().endRun(sid)
        setPermissionQueue((q) => q.filter((p) => p.nyraSessionId !== sid))
        // Mark any still-running agents as failed
        const errSession = useSessionsStore.getState().sessions.find((s) => s.id === sid)
        errSession?.agents?.filter((a) => a.status === 'running').forEach((a) => {
          updateAgent(sid, a.toolId, { status: 'failed' })
        })
      }

      if (event.type === 'stream_end') {
        useRunningStore.getState().endRun(sid)
        setPermissionQueue((q) => q.filter((p) => p.nyraSessionId !== sid))
        // Mark any still-running agents as failed
        const endSession = useSessionsStore.getState().sessions.find((s) => s.id === sid)
        endSession?.agents?.filter((a) => a.status === 'running').forEach((a) => {
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

    const imgs = images ?? []
    const fls = files ?? []

    // Build the full prompt with attachment data for Claude CLI
    const sep = (): string => (prompt ? '\n\n' : '')
    if (imgs.length > 0) {
      const imagePaths = imgs.map((img) => `[Image: ${img.path}]`).join('\n')
      prompt = `${prompt}${sep()}${imagePaths}`
    }
    if (fls.length > 0) {
      const imageFiles = fls.filter((f) => f.category === 'image')
      if (imageFiles.length > 0) {
        const imgPaths = imageFiles.map((f) => `[Image: ${f.path}]`).join('\n')
        prompt = `${prompt}${sep()}${imgPaths}`
      }
      const fileParts = fls
        .filter((f) => f.category !== 'image' && f.extractedText)
        .map((f) => `<attached_file name="${f.name}">\n${f.extractedText}\n</attached_file>`)
      if (fileParts.length > 0) {
        prompt = `${prompt}${sep()}${fileParts.join('\n\n')}`
      }
    }

    const userMessage: TextMessage = {
      id: Date.now().toString(),
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
          id: Date.now().toString(),
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
        spawnSettingsFor(useSettingsStore.getState())
      )
    } catch (err) {
      useSessionsStore
        .getState()
        .addMessage(sid, { id: Date.now().toString(), role: 'error', text: String(err) })
      useRunningStore.getState().endRun(sid!)
    }
  }, [])

  sendMessageRef.current = sendMessage

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
      id: Date.now().toString(),
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
        spawnSettingsFor(useSettingsStore.getState())
      )
    } catch (err) {
      useSessionsStore.getState().addMessage(sid, { id: Date.now().toString(), role: 'error', text: String(err) })
      useRunningStore.getState().endRun(sid)
    }
  }, [])

  /**
   * Answer a plan that came in as a file.
   *
   * Approving means leaving plan mode, because plan mode is what stops Claude
   * writing — and leaving it respawns the child, which is only survivable
   * because the spawn now carries `--resume`.
   */
  const handlePlanAnswer = useCallback(
    (toolId: string, approved: boolean, planPath?: string, note?: string): void => {
      const sid = useSessionsStore.getState().activeSessionId
      usePlanApprovalStore.getState().resolve(toolId)
      if (!sid) return
      if (!approved) {
        useSessionsStore.getState().markToolDenied(sid, toolId)
        // Plan mode stays on, so nothing respawns and Claude keeps the thread.
        if (note) void sendMessageRef.current?.(note, undefined, undefined, sid)
        return
      }
      useSettingsStore.getState().updateSettings({ planMode: false })
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
    setPermissionQueue((q) => q.filter((p) => p.nyraSessionId !== activeSessionId))
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
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [messages])

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
        id: Date.now().toString(),
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
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-info/50 bg-info/10 px-12 py-10">
            <FileText className="size-10 text-info" />
            <p className="text-sm font-medium text-info">Drop files here</p>
            <p className="text-[11px] text-info/50">Images, PDFs, documents, code files, and more</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/55 px-4 py-2">
        {/* CWD pill */}
        <button
          onClick={handlePickFolder}
          className="flex items-center gap-2 rounded-md border border-border/55 bg-muted/40 hover:bg-accent/50 px-2.5 py-1 transition-colors min-w-0 max-w-[420px]"
          title="Click to change project folder"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full shrink-0 ${isLoading ? 'bg-warning animate-pulse' : 'bg-success/70'}`}
          />
          <span className="text-[11px] text-foreground/80 font-mono truncate">
            {homedir && cwd.startsWith(homedir) ? '~' + cwd.slice(homedir.length) : cwd}
          </span>
          {activeSession?.branch && (
            <>
              <span className="h-3 w-px bg-border shrink-0" />
              <span className={`flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 ${
                activeSession.worktree
                  ? 'bg-success/15 text-success/70'
                  : 'bg-info/10 text-info/70'
              }`}>
                <GitBranch className="size-2.5" />
                {activeSession.branch}
              </span>
            </>
          )}
          {activeSession?.worktree && (
            <span className="text-[9px] font-semibold text-info/60 bg-info/10 px-1.5 py-0.5 rounded-sm shrink-0">
              worktree
            </span>
          )}
        </button>

        {/* Right zone: status chips, model pill, mode group, divider, utility group */}
        <div className="flex items-center gap-2 shrink-0">
          {activeSession?.worktree && !isLoading && (
            <>
              <button
                onClick={async () => {
                  const wt = activeSession.worktree!
                  // Pass the session's own cwd — the backend resolves the main
                  // working tree from it. Deriving that path here is what made
                  // this button merge the branch into itself and report success.
                  const result = await window.api.git.worktreeMerge(activeSession.cwd, wt.branch)
                  const store = useSessionsStore.getState()
                  if (result.success) {
                    store.addMessage(activeSession.id, { id: Date.now().toString(), role: 'assistant', text: `Merged **${wt.branch}** into **${result.into ?? 'the main branch'}**.` })
                  } else {
                    store.addMessage(activeSession.id, { id: Date.now().toString(), role: 'error', text: `Merge failed: ${result.error}` })
                  }
                }}
                className="flex items-center gap-1 rounded-md border border-success/20 px-2 py-0.5 text-[11px] text-success/70 hover:bg-success/10 transition-colors"
                title="Merge worktree branch into main"
              >
                <GitMerge className="size-3" />
                Merge
              </button>
              <button
                onClick={async () => {
                  const wt = activeSession.worktree!
                  const result = await window.api.git.worktreeRemove(activeSession.cwd, wt.path)
                  const store = useSessionsStore.getState()
                  if (!result.success) {
                    // Keep the session: it is the only handle left on a worktree
                    // that is still on disk.
                    store.addMessage(activeSession.id, { id: Date.now().toString(), role: 'error', text: `Could not remove the worktree: ${result.error}` })
                    return
                  }
                  store.deleteSession(activeSession.id)
                }}
                className="rounded-md border border-danger/20 px-1.5 py-0.5 text-danger/50 hover:text-danger/80 hover:bg-danger/10 transition-colors"
                title="Remove worktree and delete session"
              >
                <Trash2 className="size-3" />
              </button>
            </>
          )}
          {usagePct >= 70 && (() => {
            const total = usage!.inputTokens + usage!.outputTokens
            const fmt = (n: number): string => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
            const isRed = usagePct >= 90
            return (
              <button
                onClick={() => { if (!rightPanelOpen) onToggleRightPanel() }}
                title={`Context usage: ${Math.round(usagePct)}%`}
                className={`rounded-md border px-2 py-0.5 text-[11px] font-mono transition-colors flex items-center gap-1 ${
                  isRed
                    ? 'border-danger/40 bg-danger/10 text-danger animate-pulse'
                    : 'border-warning/40 bg-warning/10 text-warning'
                }`}
              >
                <TriangleAlert className="size-3" />
                {fmt(total)}/{fmt(CONTEXT_LIMIT)}
              </button>
            )
          })()}

          <button
            onClick={() => setSearchOpen((o) => !o)}
            disabled={messages.length === 0}
            title="Find in conversation (⌘F)"
            className={`rounded-md px-2 py-0.5 transition-colors ${
              messages.length === 0
                ? 'text-muted-foreground/40 cursor-not-allowed'
                : searchOpen ? 'text-foreground/80' : 'text-muted-foreground/70 hover:text-foreground/80'
            }`}
          >
            <Search className="size-3.5" />
          </button>
          <button
            onClick={copyConversation}
            disabled={messages.length === 0}
            title="Copy conversation as markdown"
            className={`rounded-md px-2 py-0.5 transition-colors ${
              messages.length === 0
                ? 'text-muted-foreground/40 cursor-not-allowed'
                : copied ? 'text-success' : 'text-muted-foreground/70 hover:text-foreground/80'
            }`}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </div>
      </div>



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
      {/* Conversation summary — floats over the messages so glancing at it never
          reflows the conversation. */}
      <SummaryPanel />

      {/* The column is centred and width-limited, and stays put when the summary
          opens — the summary floats in the gutter rather than pushing the text.
          Only the workspace rail changes the column's position, by narrowing the
          area it centres in. The measure is deliberately short so there is a
          gutter for the summary to float in. */}
      <div
        ref={messagesRef}
        className={`relative flex-1 overflow-y-auto pb-8 pt-4 ${
          fontSize === 'small' ? 'text-[13px]' : fontSize === 'large' ? 'text-[17px]' : 'text-[15px]'
        }`}
      >
       {/* The column is centred on the *window*, not on this container — so it
           holds still when a rail opens instead of jumping. Two constraints
           bound it: it never slides under the floating summary, and it never
           touches the left rail. Between those it just tracks the window
           centre, which is what makes it drift left as the window narrows
           rather than disappearing behind the panel.

           --rail is what sits to the left of this scroller, the only part of
           the window geometry CSS cannot work out for itself. */}
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

        {activeSession?.worktree && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-info/15 bg-info/6 px-3 py-2">
            <Info className="size-3.5 text-info/50 shrink-0" />
            <p className="text-[11px] text-info/50">
              Worktree session — changes are isolated in <span className="font-mono font-medium">{activeSession.worktree.branch}</span>
            </p>
          </div>
        )}
        {messages.length === 0 && !isLoading && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-[32px] font-semibold tracking-tight text-foreground/[0.07]">Nyra</p>
            <p className="text-xs text-muted-foreground/70">Start typing or pick a skill from the sidebar</p>
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
                      <span className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{item.label}</span>
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
                    <div className={`flex justify-start py-2`}>
                      {activeSessionId && thinkingSince[activeSessionId] !== undefined ? (
                        <ThinkingIndicator startTime={thinkingSince[activeSessionId]} />
                      ) : (
                        <div className={`rounded-2xl border border-border-strong bg-accent/50 px-4 py-3`}>
                          <div className="flex gap-1">
                            {BOUNCE_DOTS.map((i) => (
                              <span key={i} className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
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
                    <ToolCallGroup messages={item.messages} isLoading={isLoading} />
                  </div>
                )
              }

              const msg = item.msg
              const gap = 'py-2'

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
                        {textMsg.images && textMsg.images.length > 0 && (
                          <div className="flex gap-2 flex-wrap mb-2 justify-end">
                            {textMsg.images.map((img, i) => (
                              <img key={i} src={img.dataUrl} alt="" className="h-20 rounded-lg object-cover max-w-[200px]" />
                            ))}
                          </div>
                        )}
                        <textarea
                          autoFocus
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          className="w-full resize-none rounded-2xl bg-info px-4 py-3 text-info-foreground outline-hidden text-sm leading-relaxed"
                          rows={Math.max(2, editText.split('\n').length)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') { setEditingMessageId(null); setEditText('') }
                          }}
                        />
                        <div className="flex justify-end gap-2 mt-2">
                          <button onClick={() => { setEditingMessageId(null); setEditText('') }} className="rounded-lg px-3 py-1 text-xs text-foreground/80 hover:text-foreground transition-colors">Cancel</button>
                          <button
                            disabled={!editText.trim()}
                            onClick={() => { const mid = editingMessageId!; const text = editText; setEditingMessageId(null); setEditText(''); editAndResend(mid, text) }}
                            className="rounded-lg bg-info px-3 py-1 text-xs font-medium text-info-foreground hover:bg-info disabled:opacity-25 transition-colors"
                          >Save</button>
                        </div>
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
          of the composer instead of on top of it. */}
      {showJumpBottom && (
        <button
          onClick={() => virtualizer.scrollToIndex(virtualItems.length - 1, { align: 'end', behavior: 'smooth' })}
          className="absolute left-1/2 -translate-x-1/2 bottom-4 z-10 rounded-full bg-accent border border-border-strong px-3 py-1.5 text-[11px] text-foreground/80 hover:text-foreground hover:bg-secondary transition-all shadow-lg flex items-center gap-1.5"
        >
          <ChevronDown className="size-3" />
          Jump to bottom
        </button>
      )}
      </div>


      {/* Input */}
      {/* The composer lines up with the conversation, same geometry. */}
      <div style={{ ...columnGeometry, width: 'var(--col-w)', marginLeft: COLUMN_OFFSET } as React.CSSProperties}>
        <TaskStrip />
        <ChatInput
          cwd={cwd}
          isLoading={isLoading}
          sendMessage={sendMessage}
          onStop={handleStopTurn}
        />
      </div>

      {/* Status line */}
      <div className="flex items-center justify-center gap-3 px-4 py-1 text-[10px] font-mono text-muted-foreground/70 border-t border-border/55">
        <span className="text-muted-foreground">{model || 'opus'}</span>
        {effort && <span className="text-info/50">{effort}</span>}
        {usage && (() => {
          const total = usage.inputTokens + usage.outputTokens
          const fmt = (n: number): string => n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
          return <span>{fmt(total)} tokens · {Math.round(usagePct)}%</span>
        })()}
        <TasksChip />
        <RateLimitPill />
        {claudeSessionId && (
          <span className="text-muted-foreground/70">{claudeSessionId.slice(0, 8)}</span>
        )}
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

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {permissionsOpen && <PermissionsModal onClose={() => setPermissionsOpen(false)} />}
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
      <p className="flex-1 text-[11px] text-warning/70">
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

function RateLimitPill(): React.JSX.Element | null {
  const fiveHour = useRateLimitStore((s) => s.windows['five_hour'])
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!fiveHour) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [fiveHour])

  if (!fiveHour) return null

  const isThrottled = fiveHour.status !== 'allowed'
  const resetsInMs = fiveHour.resetsAt * 1000 - now
  const resetsInSec = Math.max(0, Math.ceil(resetsInMs / 1_000))
  const hours = Math.floor(resetsInSec / 3600)
  const mins = Math.floor((resetsInSec % 3600) / 60)
  const secs = resetsInSec % 60
  const resetStr = hours > 0 ? `${hours}h ${mins}m` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  if (isThrottled) {
    return <span className="text-danger/80 animate-pulse">5h: LIMIT · resets {resetStr}</span>
  }

  // Show reset countdown when we have a valid resetsAt (always useful for 5h window)
  if (resetsInMs > 0) {
    // Color based on how close to reset (closer = more used)
    const totalWindowMs = 5 * 60 * 60 * 1000
    const elapsed = totalWindowMs - resetsInMs
    const pct = Math.min((elapsed / totalWindowMs) * 100, 100)
    const color = pct > 90 ? 'text-danger/80' : pct > 70 ? 'text-warning/70' : 'text-info/50'
    return <span className={color}>5h: resets {resetStr}</span>
  }

  return null
}

function ThinkingIndicator({ startTime }: { startTime: number }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startTime), 100)
    return () => clearInterval(id)
  }, [startTime])

  const secs = (elapsed / 1000).toFixed(1)

  return (
    <div className={`rounded-2xl border border-info/15 bg-info/5 px-4 py-3`}>
      <div className="flex items-center gap-2">
        <div className="flex items-end gap-[3px]">
          {[10, 14, 8, 12].map((h, i) => (
            <span
              key={i}
              className="w-[2px] rounded-xs bg-info animate-pulse"
              style={{ height: `${h}px`, animationDelay: `${i * 200}ms`, animationDuration: `${800 + i * 150}ms` }}
            />
          ))}
        </div>
        <span className="text-xs font-medium text-info font-mono">Thinking</span>
        <span className="text-[11px] text-info/40 font-mono">{secs}s</span>
      </div>
    </div>
  )
}

const MessageRow = React.memo(function MessageRow({ message, isLoading, onEdit, onFork, onPlanAnswer }: { message: Message; isLoading?: boolean; onEdit?: (id: string, text: string) => void; onFork?: (id: string) => void; onPlanAnswer?: (toolId: string, approved: boolean, planPath?: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  if (message.role === 'tool_call') {
    const tc = message as ToolCallMessage
    if (tc.tool_name === 'AskUserQuestion') {
      return <AskUserQuestionCard message={tc} />
    }
    if (tc.tool_name === 'ExitPlanMode') {
      return <PlanCard message={tc} onAnswer={onPlanAnswer} />
    }
    return <ToolCallCard message={tc} isLoading={isLoading} />
  }

  if (message.role === 'user') {
    const textMsg = message as TextMessage
    return (
      <div className="flex justify-end group/msg">
        <div className="relative max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground">
          {onEdit && (
            <button
              onClick={() => onEdit(textMsg.id, textMsg.text)}
              className="absolute -left-8 top-2 rounded-md p-1 text-transparent transition-colors group-hover/msg:text-muted-foreground hover:text-foreground!"
              title="Edit message"
            >
              <SquarePen className="size-3.5" />
            </button>
          )}
          {onFork && (
            <button
              onClick={() => onFork(textMsg.id)}
              className="absolute -left-14 top-2 rounded-md p-1 text-transparent transition-colors group-hover/msg:text-muted-foreground hover:text-foreground!"
              title="Fork from this message"
            >
              <GitFork className="size-3.5" />
            </button>
          )}
          {textMsg.images && textMsg.images.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {textMsg.images.map((img, i) => (
                <img
                  key={i}
                  src={img.dataUrl}
                  alt=""
                  className="h-20 rounded-lg object-cover max-w-[200px]"
                />
              ))}
            </div>
          )}
          {textMsg.files && textMsg.files.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-2">
              {textMsg.files.map((file) => (
                <span key={file.id} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2 py-0.5 text-[11px]">
                  <FileText className="size-2.5 opacity-60" />
                  {file.name}
                </span>
              ))}
            </div>
          )}
          <div className="whitespace-pre-wrap wrap-break-word wrap-anywhere">{textMsg.text}</div>
        </div>
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
      {/* Actions sit under the reply, not floating beside its first line — a long
          answer's controls belong where you finish reading it. */}
      <div className="mt-1 flex opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
        <button
          onClick={copyText}
          title="Copy response"
          className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent/50 ${
            copied ? 'text-success' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
})
