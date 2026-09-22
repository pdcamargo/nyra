import { attachmentMarker, removeAttachmentRef } from '../lib/composerDecorations'
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useSessionsStore, type ImageAttachment, type FileAttachment, type TextMessage, type QueuedMessage, createSiblingSession, newMessageId } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import SlashAutocomplete, { useSlashItems, type AutocompleteItem } from './SlashAutocomplete'
import AtMentionAutocomplete, { useAtMentionItems, type MentionItem } from './AtMentionAutocomplete'
import ComposerBar from './ComposerBar'
import NewChatEnvironment from './NewChatEnvironment'
import AttachmentStrip, { type PendingAttachment } from './AttachmentStrip'
import MarkdownEditor, { type MarkdownEditorHandle } from './MarkdownEditor'
import { BUILT_IN_COMMANDS } from '../data/commands'
import {
  newlineInList,
  insertLink,
  toggleHeading,
  toggleInlineMarker,
  type Edit
} from '../lib/markdownEditing'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { CornerDownLeft, Navigation, Trash2 } from 'lucide-react'
import { useDictationStore } from '../store/dictation'
import { useLoopsStore } from '../store/loops'
import { compressImage } from '../utils/imageCompression'
import type { Agent, ToolCallMessage } from '../store/sessions'
import QuestionDock from './QuestionDock'
import PlanCard, { type PlanAnswer } from './PlanCard'
import { useQuestionAnswerStore } from '../store/questionAnswer'
import { composerIntent } from '../lib/composerIntent'
import { queuePreview, type QueuedImage } from '../lib/queuePreview'
import { cachedImage, loadImage } from '../lib/imageCache'

const EMPTY_AGENTS: Agent[] = []
const EMPTY_QUEUE: QueuedMessage[] = []
/** Commands the composer runs itself rather than passing to Claude as text. */
const KNOWN_COMMAND_NAMES = new Set(BUILT_IN_COMMANDS.map((c) => c.name.slice(1).split(' ')[0]))

const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

type ChatInputProps = {
  cwd: string
  isLoading: boolean
  /** The plan waiting on a verdict, fused into the top of the composer. */
  pendingPlan?: ToolCallMessage | null
  onPlanAnswer?: (toolId: string, answer: PlanAnswer, planPath?: string, note?: string) => void
  /** The question waiting on an answer, fused into the top of the composer. */
  liveQuestion?: ToolCallMessage | null
  onQuestionAnswer?: (toolId: string, answer: string) => void
  sendMessage: (text: string, images?: ImageAttachment[], files?: FileAttachment[]) => Promise<void>
  /**
   * Send a queued message into the turn that is already running. Resolves false
   * when there was no live turn to send it into, so the row stays queued.
   */
  steerMessage?: (msg: QueuedMessage) => Promise<boolean>
  /** Abort the running turn. Owned by Chat, which also has a permission queue to clear. */
  onStop?: () => void
}

export default function ChatInput({
  cwd,
  isLoading,
  sendMessage,
  steerMessage,
  onStop,
  pendingPlan = null,
  onPlanAnswer,
  liveQuestion = null,
  onQuestionAnswer
}: ChatInputProps): React.JSX.Element {
  const question = liveQuestion
  useEffect(() => {
    if (question) useQuestionAnswerStore.getState().open(question.tool_id)
  }, [question])
  const [input, setInput] = useState('')
  const pendingPrefill = useUiStore((s) => s.pendingInputPrefill)
  const consumePrefill = useUiStore((s) => s.consumeInputPrefill)

  // The composer holds the free text for the question on screen, so stepping
  // between questions swaps what is in it: Previous brings your own words back
  // instead of losing them, and Next arrives on an empty box.
  //
  // Guarded on the tool id as well as the page, because arriving at a *new*
  // question must not wipe something that was already typed before it appeared.
  const questionPage = useQuestionAnswerStore((s) => s.page)
  const questionToolId = useQuestionAnswerStore((s) => s.toolId)
  const lastQuestionPage = useRef<{ toolId: string | null; page: number }>({
    toolId: null,
    page: 0
  })
  useEffect(() => {
    const previous = lastQuestionPage.current
    lastQuestionPage.current = { toolId: questionToolId, page: questionPage }
    if (!questionToolId) return
    if (previous.toolId !== questionToolId || previous.page === questionPage) return
    setInput(useQuestionAnswerStore.getState().typed[questionPage] ?? '')
  }, [questionPage, questionToolId])

  useEffect(() => {
    if (!pendingPrefill) return
    setInput((prev) => {
      const sep = prev.length === 0 || prev.endsWith(' ') || prev.endsWith('\n') ? '' : ' '
      return prev + sep + pendingPrefill
    })
    consumePrefill()
    // Two frames: one for the controlled value to reach the editor, one for the
    // caret to land at the end of it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const editor = editorRef.current
        if (!editor) return
        editor.focus()
        const end = Number.MAX_SAFE_INTEGER
        editor.setSelectionRange(end, end)
      })
    )
  }, [pendingPrefill, consumePrefill])
  /** Drop a slash command into the field rather than firing it blind — most take an argument. */
  const insertCommand = useCallback((command: string): void => {
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ` : '') + command + ' ')
    requestAnimationFrame(() => editorRef.current?.focus())
  }, [])

  const [stagedImages, setStagedImages] = useState<ImageAttachment[]>([])
  const [stagedFiles, setStagedFiles] = useState<FileAttachment[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  // Attachments still being read. Reading a few MB is slow enough that without a
  // tile it looks like nothing happened, and the obvious response is to attach again.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [acSelectedIndex, setAcSelectedIndex] = useState(0)
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  // Named for what it is now, but shaped like a textarea on purpose — see
  // MarkdownEditorHandle. Everything below reads offsets off it as before.
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const [mentionAnchorLeft, setMentionAnchorLeft] = useState(0)
  const stashRef = useRef<string>('')
  const [hasStash, setHasStash] = useState(false)

  // Collect all past user prompts across sessions
  const sessions = useSessionsStore((s) => s.sessions)

  // Focus textarea on session switch
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const dictationPhase = useDictationStore((s) => s.phase)
  const dictationInterim = useDictationStore((s) => s.interim)
  const dictationError = useDictationStore((s) => s.error)
  useEffect(() => {
    editorRef.current?.focus()
  }, [activeSessionId])

  // Consume pending actions from Sidebar (skills run / command insert)
  const pendingAction = useSessionsStore((state) => state.pendingAction)
  useEffect(() => {
    if (!pendingAction) return
    useSessionsStore.getState().clearPendingAction()
    if (pendingAction.type === 'send') {
      sendMessage(pendingAction.text)
    } else {
      setInput(pendingAction.text)
      editorRef.current?.focus()
    }
  }, [pendingAction, sendMessage])

  // Slash autocomplete
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1) : null
  const acItems = useSlashItems(slashQuery ?? '', cwd)
  const autocompleteVisible = slashQuery !== null && !isLoading && acItems.length > 0

  useEffect(() => {
    setAcSelectedIndex(0)
  }, [slashQuery])

  // @-mention autocomplete: detect @query at cursor position
  const [mentionQuery, mentionStart] = useMemo((): [string | null, number] => {
    const textarea = editorRef.current
    if (!textarea || autocompleteVisible) return [null, -1]
    const cursor = textarea.selectionStart ?? input.length
    // Walk backward from cursor to find unescaped @
    const before = input.slice(0, cursor)
    const atIdx = before.lastIndexOf('@')
    if (atIdx < 0) return [null, -1]
    // @ must be at start or preceded by whitespace
    if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return [null, -1]
    const query = before.slice(atIdx + 1)
    // No spaces in the query (simple heuristic)
    if (/\s/.test(query)) return [null, -1]
    return [query, atIdx]
  }, [input, autocompleteVisible])

  const fsMentionItems = useAtMentionItems(mentionQuery, cwd)
  const sessionAgents = useSessionsStore((s) => {
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId)
    return session?.agents ?? EMPTY_AGENTS
  })

  // Load agent definitions from .claude/agents/ directories
  const [agentDefs, setAgentDefs] = useState<{ name: string; description: string }[]>([])
  useEffect(() => {
    window.api.agents.list(cwd).then((result: { global: { name: string; description: string }[]; project: { name: string; description: string }[] }) => {
      const all = [...result.project, ...result.global]
      // Deduplicate by name (project overrides global)
      const seen = new Set<string>()
      const deduped = all.filter((a) => { if (seen.has(a.name)) return false; seen.add(a.name); return true })
      setAgentDefs(deduped)
    })
  }, [cwd])

  const mentionItems = useMemo((): MentionItem[] => {
    const q = mentionQuery?.toLowerCase() ?? ''

    // Running/completed agents from this session
    const liveAgentItems: MentionItem[] = sessionAgents
      .filter((a) => a.name && a.name.toLowerCase().includes(q))
      .map((a) => ({
        path: `agent:${a.name}`,
        label: a.name,
        type: 'agent' as const,
        meta: a.status
      }))

    // Agent definitions from .claude/agents/
    const liveNames = new Set(sessionAgents.map((a) => a.name))
    const defAgentItems: MentionItem[] = agentDefs
      .filter((a) => !liveNames.has(a.name) && a.name.toLowerCase().includes(q))
      .map((a) => ({
        path: `agent:${a.name}`,
        label: a.name,
        type: 'agent' as const,
        meta: 'agent'
      }))

    return [...liveAgentItems, ...defAgentItems, ...fsMentionItems]
  }, [mentionQuery, sessionAgents, agentDefs, fsMentionItems])
  const mentionVisible = mentionQuery !== null && mentionQuery.length > 0 && !isLoading && mentionItems.length > 0
  // The popup used to anchor at 0 because nothing ever set this. The editor can
  // say where the caret actually is, so it now opens under the @ you typed.
  useEffect(() => {
    if (!mentionVisible) return
    setMentionAnchorLeft(editorRef.current?.caretLeft() ?? 0)
  }, [mentionVisible])

  useEffect(() => {
    setMentionSelectedIndex(0)
  }, [mentionQuery])

  const executeCommand = useCallback((name: string): void => {
    setInput('')
    const store = useSessionsStore.getState()
    let sid = store.activeSessionId
    if (!sid) {
      sid = createSiblingSession()
    }
    const session = useSessionsStore.getState().sessions.find((s) => s.id === sid)!
    const addInfo = (text: string): void => {
      useSessionsStore.getState().addMessage(sid!, {
        id: newMessageId(),
        role: 'assistant',
        text
      })
    }

    switch (name) {
      case 'clear':
        useSessionsStore.getState().clearMessages(sid)
        break
      case 'restart':
        window.api.claude.abort(sid)
        useSessionsStore.getState().restartSession(sid)
        addInfo('Session restarted. MCP servers will reconnect on the next message.')
        break
      case 'help':
        addInfo(
          `**Available commands:**\n\n` +
          `| Command | Description |\n|---|---|\n` +
          `| /clear | Clear conversation history |\n` +
          `| /status | Show session status |\n` +
          `| /cost | Show token usage |\n` +
          `| /help | Show this help |\n` +
          `| /compact | Compact conversation context |\n` +
          `| /restart | Restart Claude session (reconnects MCP servers) |\n` +
          `| /init | Initialize project with CLAUDE.md |\n` +
          `| /review | Review recent changes |\n` +
          `| /pr-review | Review a pull request |\n` +
          `| /doctor | Check Claude Code health |\n` +
          `| /memory | Edit CLAUDE.md memory |\n\n` +
          `Skills are also available — type \`/\` to see them.`
        )
        break
      case 'status':
        addInfo(
          `**Session status**\n\n` +
          `- **CWD:** \`${session.cwd}\`\n` +
          `- **Session ID:** \`${session.claudeSessionId ?? 'not started'}\`\n` +
          `- **Messages:** ${session.messages.length}\n` +
          `- **Created:** ${new Date(session.createdAt).toLocaleString()}`
        )
        break
      case 'cost':
        addInfo(`**Token usage** — Cost tracking is not yet available in Nyra. Use \`/stats\` for a detailed overview.`)
        break
      case 'stats':
        window.dispatchEvent(new CustomEvent('nyra:open-stats'))
        break
      case 'compact':
        if (!session.claudeSessionId) {
          addInfo('No active session to compact. Send a message first.')
          break
        }
        addInfo('Compacting context…')
        sendMessage('/compact')
        break
      case 'context':
        if (!session.claudeSessionId) {
          addInfo('No active session. Send a message first.')
          break
        }
        sendMessage('/context')
        break
      case 'copy':
        window.dispatchEvent(new CustomEvent('nyra:open-copy'))
        break
      case 'release-notes':
        window.dispatchEvent(new CustomEvent('nyra:open-release-notes'))
        break
      case 'permissions':
        useUiStore.getState().openSettings('permissions')
        break
      case 'loop stop':
        window.dispatchEvent(new CustomEvent('nyra:stop-loop'))
        break
      case 'tasks':
        useUiStore.getState().focusProcessesTab()
        break
      case 'login':
      case 'logout':
        // Open the in-app login flow (spawns `claude /login` in a side PTY).
        // Forwarding `/login` to Claude returns "/login isn't available in this environment".
        window.dispatchEvent(new CustomEvent('nyra:open-login'))
        break
      case 'fork': {
        const store = useSessionsStore.getState()
        const currentSid = store.activeSessionId
        if (!currentSid) {
          addInfo('No active session to fork.')
          break
        }
        const newId = store.forkSession(currentSid)
        if (newId) {
          const forkInfo = useSessionsStore.getState().sessions.find((s) => s.id === newId)?.forkOf
          useSessionsStore.getState().addMessage(newId, {
            id: newMessageId(),
            role: 'assistant',
            text: `⑂ Forked from **"${forkInfo?.title ?? 'previous session'}"**. History copied up to this point.\n\nOriginal session is unchanged. The next message starts a fresh Claude session.`
          })
        }
        break
      }
      default:
        // Built-in commands without a Nyra-native handler are forwarded to Claude.
        // Prepend the slash so /login, /model, /config, etc. land as real CLI commands
        // rather than being stripped by the prompt sender.
        sendMessage('/' + name)
        break
    }
  }, [sendMessage])

  const handleMentionSelect = useCallback((item: MentionItem): void => {
    if (mentionStart < 0) return
    const textarea = editorRef.current
    const cursor = textarea?.selectionStart ?? input.length
    const before = input.slice(0, mentionStart)
    const after = input.slice(cursor)
    const newInput = `${before}@${item.path} ${after}`
    setInput(newInput)
    // Place cursor after the inserted mention
    const newCursor = mentionStart + 1 + item.path.length + 1
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(newCursor, newCursor)
    })
  }, [input, mentionStart])

  /**
   * Picking from the dropdown writes the command into the composer rather than
   * running it. Running on selection meant a command fired the instant you
   * arrowed onto it, with no chance to add arguments or change your mind —
   * Enter runs it, the same as any other message.
   */
  const handleAutocompleteSelect = useCallback((item: AutocompleteItem): void => {
    setInput('/' + item.name + ' ')
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      const end = Number.MAX_SAFE_INTEGER
      editor.setSelectionRange(end, end)
    })
  }, [])

  // Read queued message for current session
  // Selected as raw fields and assembled here: a selector that builds the array
  // itself hands back a new reference every render and never settles.
  const queuedList = useSessionsStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.queuedMessages
  )
  const legacyQueued = useSessionsStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.queuedMessage
  )
  const queuedMessages = useMemo(
    () => queuedList ?? (legacyQueued ? [legacyQueued] : EMPTY_QUEUE),
    [queuedList, legacyQueued]
  )

  const activeLoop = useLoopsStore((s) => activeSessionId ? s.loops.get(activeSessionId) ?? null : null)

  // Send handler: if loading, queue the message; otherwise send immediately
  const handleSend = useCallback(async (): Promise<void> => {
    const qs = useQuestionAnswerStore.getState()
    const intent = composerIntent({
      text: input,
      question,
      plan: pendingPlan,
      picks: qs.picks,
      typed: qs.typed,
      page: qs.page
    })
    if (intent.kind === 'none') return
    if (intent.kind === 'next-question') {
      // The box then shows whatever the next question was last answered with,
      // which is usually nothing.
      setInput(qs.advance(intent.page, input))
      return
    }
    if (intent.kind === 'answer') {
      setInput('')
      qs.clear()
      onQuestionAnswer?.(intent.toolId, intent.answer)
      return
    }
    if (intent.kind === 'keep-planning') {
      setInput('')
      onPlanAnswer?.(intent.toolId, 'reject', intent.path, intent.note)
      return
    }
    const text = input
    const images = [...stagedImages]
    const files = [...stagedFiles]

    if (!text.trim() && images.length === 0 && files.length === 0) return

    // Intercept /loop <interval> <prompt>
    const loopMatch = text.trim().match(/^\/loop\s+(\d+(?:\.\d+)?)(s|m|h)\s+(.+)$/i)
    if (loopMatch) {
      const value = parseFloat(loopMatch[1])
      const unit = loopMatch[2].toLowerCase()
      const loopPrompt = loopMatch[3].trim()
      const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
      const intervalMs = Math.round(value * multiplier)
      setInput('')
      window.dispatchEvent(new CustomEvent('nyra:start-loop', { detail: { prompt: loopPrompt, intervalMs } }))
      return
    }

    // Intercept /loop stop
    if (text.trim().toLowerCase() === '/loop stop') {
      setInput('')
      window.dispatchEvent(new CustomEvent('nyra:stop-loop'))
      return
    }

    // Intercept /tasks — opens bottom panel and focuses Processes tab
    if (text.trim().toLowerCase() === '/tasks') {
      setInput('')
      useUiStore.getState().focusProcessesTab()
      return
    }

    // A bare slash command runs the command. Until now only the dropdown could
    // run one, so sending `/context` by hand just posted the literal text.
    const bareCommand = /^\/([a-z][\w-]*)$/i.exec(text.trim())
    if (bareCommand && KNOWN_COMMAND_NAMES.has(bareCommand[1].toLowerCase())) {
      executeCommand(bareCommand[1].toLowerCase())
      return
    }

    // Intercept /rename <title> before sending to CLI
    if (text.trim().startsWith('/rename ')) {
      const newTitle = text.trim().slice('/rename '.length).trim()
      if (newTitle) {
        const sid = useSessionsStore.getState().activeSessionId
        if (sid) useSessionsStore.getState().renameSession(sid, newTitle)
      }
      setInput('')
      return
    }

    setInput('')
    setStagedImages([])
    setStagedFiles([])

    if (isLoading) {
      const sid = useSessionsStore.getState().activeSessionId
      if (sid) {
        const queued: QueuedMessage = {
          text: text.trim(),
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {})
        }
        useSessionsStore.getState().enqueueMessage(sid, queued)
      }
      return
    }

    await sendMessage(text.trim(), images.length > 0 ? images : undefined, files.length > 0 ? files : undefined)
  }, [
    input,
    stagedImages,
    stagedFiles,
    sendMessage,
    isLoading,
    executeCommand,
    question,
    pendingPlan,
    onQuestionAnswer,
    onPlanAnswer
  ])


  const handleStash = useCallback((): void => {
    if (hasStash) {
      setInput(stashRef.current)
      stashRef.current = ''
      setHasStash(false)
      requestAnimationFrame(() => editorRef.current?.focus())
    } else {
      if (!input.trim()) return
      stashRef.current = input
      setHasStash(true)
      setInput('')
    }
  }, [hasStash, input])

  /** Apply a pure edit to the field and restore the caret it asked for. */
  const applyEdit = useCallback((edit: Edit): void => {
    setInput(edit.text)
    requestAnimationFrame(() => {
      const ta = editorRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(edit.selectionStart, edit.selectionEnd)
    })
  }, [])

  const handleKeyDown = (e: KeyboardEvent): void => {
    const sel = (): [number, number] => [
      editorRef.current?.selectionStart ?? input.length,
      editorRef.current?.selectionEnd ?? input.length
    ]

    // Markdown shortcuts. Cmd on macOS, Ctrl elsewhere; Alt+digit for headings
    // because Cmd+digit is taken by the OS.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      const marker =
        e.key === 'b' ? 'bold' : e.key === 'i' ? 'italic' : e.key === 'e' ? 'code' : null
      if (marker) {
        e.preventDefault()
        applyEdit(toggleInlineMarker(input, ...sel(), marker))
        return
      }
      if (e.key === 'u') {
        e.preventDefault()
        applyEdit(insertLink(input, ...sel()))
        return
      }
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && /^[1-6]$/.test(e.key)) {
      e.preventDefault()
      applyEdit(toggleHeading(input, ...sel(), Number(e.key)))
      return
    }

    // Ctrl+S to stash/restore draft
    if (e.key === 's' && e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault()
      handleStash()
      return
    }

    if (autocompleteVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcSelectedIndex((i) => (i + 1) % acItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcSelectedIndex((i) => (i - 1 + acItems.length) % acItems.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        handleAutocompleteSelect(acItems[acSelectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setInput('')
        return
      }
    }
    if (mentionVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionSelectedIndex((i) => (i + 1) % mentionItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionSelectedIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        handleMentionSelect(mentionItems[mentionSelectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // Remove the @ trigger to dismiss
        const before = input.slice(0, mentionStart)
        const cursor = editorRef.current?.selectionStart ?? input.length
        const after = input.slice(cursor)
        setInput(before + after)
        return
      }
    }
    // Shift+Enter breaks the line, and inside a list starts the next item.
    // Pressing it on an empty item drops the marker and leaves the list.
    //
    // It has to be claimed explicitly: left alone it falls through to
    // CodeMirror's defaultKeymap, which inserts a plain newline and knows
    // nothing about the list you were in.
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      applyEdit(newlineInList(input, ...sel()))
      return
    }

    // Enter always sends. An open autocomplete takes it first, above.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Image processing
  /**
   * Drop a reference to an attachment where the caret is.
   *
   * The point is to write "on this screen [shot.png] the sidebar…" and have
   * Claude read the path in that sentence, rather than appending every
   * attachment after the message and leaving you to explain in prose which one
   * you meant. The marker is the form the CLI already expects, so nothing needs
   * translating on the way out.
   */
  const insertAttachmentRef = useCallback((kind: 'Image' | 'File', target: string): void => {
    const marker = attachmentMarker(kind, target)
    setInput((prev) => {
      const editor = editorRef.current
      const at = editor ? editor.selectionStart : prev.length
      const before = prev.slice(0, at)
      const after = prev.slice(at)
      const lead = before && !/\s$/.test(before) ? ' ' : ''
      const trail = after && !/^\s/.test(after) ? ' ' : ''
      const next = `${before}${lead}${marker}${trail}${after}`
      const caret = before.length + lead.length + marker.length + trail.length
      requestAnimationFrame(() => {
        editorRef.current?.setSelectionRange(caret, caret)
        editorRef.current?.focus()
      })
      return next
    })
  }, [])

  const processImageFile = useCallback(async (file: File): Promise<void> => {
    if (!SUPPORTED_TYPES.includes(file.type)) return
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(file)
    })
    const rawBase64 = dataUrl.split(',')[1]
    const compressed = await compressImage(rawBase64, file.type)
    const path = await window.api.claude.saveImage(compressed.base64, compressed.mediaType)
    const finalDataUrl = `data:${compressed.mediaType};base64,${compressed.base64}`
    setStagedImages((prev) => [...prev, { path, mediaType: compressed.mediaType, dataUrl: finalDataUrl }])
    insertAttachmentRef('Image', path)
  }, [insertAttachmentRef])

  // File processing
  const processAttachedFile = useCallback(async (file: File) => {
    setFileError(null)
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setPendingAttachments((prev) => [...prev, { id: pendingId, name: file.name }])
    const done = (): void =>
      setPendingAttachments((prev) => prev.filter((p) => p.id !== pendingId))
    try {
      if (SUPPORTED_TYPES.includes(file.type)) {
        await processImageFile(file)
        return
      }
      // A dropped File carries no filesystem path, so stage the bytes to a temp
      // file first and hand the backend that path to extract from.
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunkSize = 8192
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
      }
      const base64 = btoa(binary)
      const filePath = await window.api.claude.saveTempFile(base64, file.name)
      if (!filePath) {
        setFileError('Could not read file path')
        return
      }
      const result = await window.api.claude.processFile(filePath)
      if (result.error) {
        setFileError(result.error)
        setTimeout(() => setFileError(null), 5000)
        return
      }
      if (result.category === 'image') {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.readAsDataURL(file)
        })
        const rawBase64 = dataUrl.split(',')[1]
        const compressed = await compressImage(rawBase64, file.type)
        const path = await window.api.claude.saveImage(compressed.base64, compressed.mediaType)
        const finalDataUrl = `data:${compressed.mediaType};base64,${compressed.base64}`
        setStagedImages((prev) => [...prev, { path, mediaType: compressed.mediaType, dataUrl: finalDataUrl }])
        insertAttachmentRef('Image', path)
      } else {
        // The backend names it after the temp file the bytes were staged to, which
        // is a timestamped id. Keep what the user dropped.
        setStagedFiles((prev) => [...prev, { ...(result as FileAttachment), name: file.name }])
        // The name, not the temp path: the file's contents still travel as their
        // own block, and this is the pointer that says where it belongs.
        insertAttachmentRef('File', file.name)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to attach file'
      setFileError(message)
      setTimeout(() => setFileError(null), 5000)
    } finally {
      done()
    }
  }, [processImageFile, insertAttachmentRef])

  const pickFiles = useCallback(async () => {
    setFileError(null)
    const paths = await window.api.dialog.pickFiles()
    if (!paths) return
    const staged = paths.map((filePath) => ({
      id: `pending-${filePath}`,
      name: filePath.split('/').pop() ?? filePath
    }))
    setPendingAttachments((prev) => [...prev, ...staged])
    for (const filePath of paths) {
      const clearOne = (): void =>
        setPendingAttachments((prev) => prev.filter((p) => p.id !== `pending-${filePath}`))
      try {
        const result = await window.api.claude.processFile(filePath)
        if (result.error) {
          setFileError(result.error)
          setTimeout(() => setFileError(null), 5000)
          continue
        }
        if (result.category === 'image' && result.base64 && result.mediaType) {
          const compressed = await compressImage(result.base64, result.mediaType)
          const savedPath = await window.api.claude.saveImage(compressed.base64, compressed.mediaType)
          const dataUrl = `data:${compressed.mediaType};base64,${compressed.base64}`
          setStagedImages((prev) => [...prev, { path: savedPath, mediaType: compressed.mediaType, dataUrl }])
        } else {
          setStagedFiles((prev) => [
            ...prev,
            { ...(result as FileAttachment), name: filePath.split('/').pop() ?? filePath }
          ])
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to attach file'
        setFileError(message)
        setTimeout(() => setFileError(null), 5000)
      } finally {
        clearOne()
      }
    }
  }, [])

  // Taking it off the strip takes its chip with it. They were independent, so
  // removing an attachment left a marker in the draft pointing at a file that
  // was no longer going to be sent.
  const removeImage = useCallback(
    (index: number) => {
      // Read the list, then set both. Reaching for the item inside the updater
      // would make the updater impure, and React invokes those twice in
      // development — which would strip a second marker when the same file is
      // referenced twice in one draft.
      const gone = stagedImages[index]
      if (gone) setInput((text) => removeAttachmentRef(text, 'Image', gone.path))
      setStagedImages((prev) => prev.filter((_, i) => i !== index))
    },
    [stagedImages]
  )

  const removeFile = useCallback(
    (id: string) => {
      const gone = stagedFiles.find((f) => f.id === id)
      if (gone) setInput((text) => removeAttachmentRef(text, 'File', gone.name))
      setStagedFiles((prev) => prev.filter((f) => f.id !== id))
    },
    [stagedFiles]
  )

  // Handle files dropped on chat area (dispatched from parent)
  useEffect(() => {
    const handler = (e: Event): void => {
      const file = (e as CustomEvent).detail as File
      processAttachedFile(file)
    }
    window.addEventListener('nyra:drop-file', handler)
    return () => window.removeEventListener('nyra:drop-file', handler)
  }, [processAttachedFile])

  /**
   * Paste an attachment, of any kind.
   *
   * It used to take images only — the clipboard was filtered to
   * `SUPPORTED_TYPES` — so a PDF copied in Finder pasted as nothing, or as
   * whatever text representation it happened to carry. `processAttachedFile`
   * has always handled every type the picker and drag-drop accept; paste simply
   * never reached it.
   *
   * Copied *text* is left alone even when it looks like a path. Pasting a path
   * into a message is a thing people do on purpose, and silently turning it into
   * an attachment would take the words out of what they were writing.
   *
   * Handed to the editor as a prop rather than bound to `contentDOM` here: the
   * EditorView used to be rebuilt whenever the placeholder changed, which is
   * every time a turn starts or ends, and the listener stayed attached to the
   * detached node — so pasting an image stopped working after the first turn.
   *
   * Synchronous on purpose. `defaultPrevented` has to be true by the time this
   * returns, or CodeMirror pastes the clipboard's text form underneath us.
   */
  const handlePaste = useCallback(
    (e: ClipboardEvent): void => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file != null)
      if (files.length === 0) return
      e.preventDefault()
      void (async () => {
        for (const file of files) await processAttachedFile(file)
      })()
    },
    [processAttachedFile]
  )

  return (
    <div className="relative py-3">
      {autocompleteVisible && (
        <SlashAutocomplete
          items={acItems}
          selectedIndex={acSelectedIndex}
          onSelect={handleAutocompleteSelect}
          onHover={setAcSelectedIndex}
        />
      )}
      {mentionVisible && (
        <AtMentionAutocomplete
          items={mentionItems}
          selectedIndex={mentionSelectedIndex}
          onSelect={handleMentionSelect}
          onHover={setMentionSelectedIndex}
          anchorLeft={mentionAnchorLeft}
        />
      )}
      {hasStash && (
        <div className="mb-2 rounded-lg border border-info/20 bg-info/10 px-3 py-2 text-[12px] text-info/80 flex items-center justify-between">
          <span>
            <span className="font-medium">Draft stashed</span>
            <span className="text-info ml-1">— Ctrl+S to restore</span>
          </span>
          <button
            onClick={() => { stashRef.current = ''; setHasStash(false) }}
            className="text-info hover:underline ml-2 shrink-0"
          >
            ×
          </button>
        </div>
      )}
      {activeLoop && (
        <div className="mb-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-[12px] text-success/80 flex items-center justify-between">
          <span className="truncate">
            <span className="font-medium">Loop active:</span>{' '}
            {activeLoop.prompt.slice(0, 40)}{activeLoop.prompt.length > 40 ? '…' : ''}{' '}
            <span className="text-success">
              every {activeLoop.intervalMs < 60_000 ? `${activeLoop.intervalMs / 1000}s` : activeLoop.intervalMs < 3_600_000 ? `${activeLoop.intervalMs / 60_000}m` : `${activeLoop.intervalMs / 3_600_000}h`}
              {' '}— run #{activeLoop.runCount}
              {activeLoop.skippedCount > 0 && ` (${activeLoop.skippedCount} skipped)`}
            </span>
          </span>
          <button
            onClick={() => { if (activeSessionId) useLoopsStore.getState().removeLoop(activeSessionId) }}
            className="ml-2 shrink-0 text-[11px] font-medium text-success transition-colors hover:underline"
          >
            Stop
          </button>
        </div>
      )}
      {/* A refused microphone or a broken download has to say so. Without
          this the button simply goes back to idle and the feature looks like
          it silently did nothing. */}
      {dictationError && (
        <div className="mb-2 flex items-center justify-between rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          <span className="truncate">Dictation: {dictationError}</span>
          <button
            onClick={() => useDictationStore.getState().setError(null)}
            aria-label="Dismiss"
            className="ml-2 rounded px-1 text-danger transition-colors hover:bg-danger/10"
          >
            ×
          </button>
        </div>
      )}
      {queuedMessages.length > 0 && (
        // Docked to the top of the composer rather than floating above it as a
        // warning banner: these are the next things you will send, not problems.
        <div className="-mb-2 rounded-t-lg border border-b-0 border-border bg-background pb-4 pt-1 text-xs dark:border-muted dark:bg-muted">
          {queuedMessages.map((queued, i) => (
            <div key={i} className="group/q flex items-center gap-2 px-3 py-1.5">
              <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
              <QueuedPreview queued={queued} />
              {/* Only while a turn is live: with nothing running there is nothing
                  to steer, and the queue outlives the turn when a result errors. */}
              {isLoading && steerMessage && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={async () => {
                        const sid = useSessionsStore.getState().activeSessionId
                        if (!sid) return
                        // Dropped from the queue only once it is in, so a turn
                        // that ended first leaves the message where it was.
                        if (await steerMessage(queued)) {
                          useSessionsStore.getState().removeQueuedMessage(sid, i)
                        }
                      }}
                      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                    >
                      <Navigation className="size-3" />
                      Steer
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Send this into the running turn</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => {
                      const sid = useSessionsStore.getState().activeSessionId
                      if (sid) useSessionsStore.getState().removeQueuedMessage(sid, i)
                    }}
                    aria-label="Remove from queue"
                    className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-colors group-hover/q:opacity-100 hover:bg-accent/50 hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove from queue</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
      {fileError && (
        <div className="mb-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[12px] text-danger flex items-center justify-between">
          <span>{fileError}</span>
          <button onClick={() => setFileError(null)} className="ml-2 rounded px-1 text-danger transition-colors hover:bg-danger/10">×</button>
        </div>
      )}
      {/* Inside the composer's own padded box rather than a sibling of it, so the
          two cannot drift apart when that padding changes. */}
      {activeSessionId && <NewChatEnvironment sessionId={activeSessionId} />}

      {/* Codex-shaped: the field on its own line, then a footer carrying what you
          set per turn — approvals on the left, model and effort on the right,
          attachments and commands behind the `+`. */}
      {/* Square across the top while the queue tray is docked above it: the tray
          has no bottom border and sits in this box's first 8px, so a rounded top
          edge here would curve away from the tray's straight one and read as two
          misaligned boxes rather than one. `rounded-b-lg` rather than adding
          `rounded-t-none`, so the corners are stated once either way. */}
      <div
        className={`composer-box ${queuedMessages.length > 0 ? 'rounded-b-lg' : 'rounded-lg'} border border-border bg-background shadow-panel transition-colors focus-within:border-border-strong dark:border-muted dark:bg-muted`}
      >
        {/* Inside the box, not docked above it: one border, and `focus-within`
            lights the question and the field together as the single control they
            are. A question outranks a plan — the two cannot both be live, but if
            they ever were, the question is the one that stops the turn. */}
        {question ? (
          <QuestionDock
            message={question}
            text={input}
            onSubmit={(answer) => {
              setInput('')
              useQuestionAnswerStore.getState().clear()
              onQuestionAnswer?.(question.tool_id, answer)
            }}
          />
        ) : (
          pendingPlan && <PlanCard message={pendingPlan} onAnswer={onPlanAnswer} pinned />
        )}
        <AttachmentStrip
          images={stagedImages}
          files={stagedFiles}
          pending={pendingAttachments}
          onRemoveImage={removeImage}
          onRemoveFile={removeFile}
        />
        <MarkdownEditor
          ref={editorRef}
          value={input}
          onChange={(v) => {
            setInput(v)
            // Typing answers *this* question in your own words, so it clears
            // that question's ticks and no others. The store no-ops once there
            // is nothing to record and nothing to clear.
            const qs = useQuestionAnswerStore.getState()
            if (qs.toolId) qs.setTyped(qs.page, v)
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            question
              ? 'I want something else…'
              : pendingPlan
                ? 'Keep planning — what should change?'
                : isLoading
                  ? 'Type to queue next message…'
                  : 'Message Claude…'
          }
          // What dictation has heard so far, drawn after the caret at
          // placeholder weight. It is a decoration, not document text: it
          // cannot be edited or sent, and the finished transcript replaces it
          // through the ordinary prefill path once the model has seen the
          // whole recording.
          ghost={
            dictationPhase === 'recording' || dictationPhase === 'transcribing'
              ? dictationInterim
              : ''
          }
          ghostSettling={dictationPhase === 'transcribing'}
        />
        <ComposerBar
          isLoading={isLoading}
          canSend={!!input.trim() || stagedImages.length > 0 || stagedFiles.length > 0}
          onPickFiles={pickFiles}
          onInsert={insertCommand}
          onSend={handleSend}
          onStop={onStop}
        />
      </div>
    </div>
  )
}

/** How many thumbnails a one-line row can carry before it stops being a row. */
const QUEUE_THUMBS = 3

/**
 * A queued message's own row: its pictures, then whatever text is left.
 *
 * See `queuePreview` for why the text alone was not enough.
 */
function QueuedPreview({ queued }: { queued: QueuedMessage }): React.JSX.Element {
  const { text, images } = useMemo(() => queuePreview(queued), [queued])
  const shown = images.slice(0, QUEUE_THUMBS)
  const rest = images.length - shown.length

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {shown.map((image, i) => (
        <QueuedThumb key={image.dataUrl ?? image.path ?? i} image={image} />
      ))}
      {rest > 0 && <span className="shrink-0 text-c-xs text-muted-foreground">+{rest}</span>}
      {queued.files?.map((file) => (
        <span
          key={file.id}
          title={file.path}
          className="shrink-0 rounded-sm bg-accent px-1.5 py-px text-c-xs text-muted-foreground"
        >
          {file.name}
        </span>
      ))}
      {/* Only where there is something left to say. An image on its own is a
          queued message with no text, and an empty span should not take a gap. */}
      {text && <span className="min-w-0 flex-1 truncate text-foreground/80">{text}</span>}
    </span>
  )
}

/** One thumbnail. A staged attachment is already decoded; a path written into
 *  the message has to be read, through the same cache the transcript uses. */
function QueuedThumb({ image }: { image: QueuedImage }): React.JSX.Element | null {
  const [entry, setEntry] = useState(() =>
    image.dataUrl ? { status: 'ready' as const, dataUrl: image.dataUrl } : image.path ? cachedImage(image.path) : undefined
  )

  useEffect(() => {
    if (image.dataUrl || !image.path || entry) return
    let live = true
    void loadImage(image.path).then((next) => {
      if (live) setEntry(next)
    })
    return () => {
      live = false
    }
  }, [image.dataUrl, image.path, entry])

  if (entry?.status !== 'ready') return null
  return (
    <img
      src={entry.dataUrl}
      alt=""
      title={image.path}
      className="size-5 shrink-0 rounded-sm object-cover ring-1 ring-border/60"
    />
  )
}
