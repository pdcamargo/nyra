export type ReleaseNote = {
  version: string
  date: string
  notes: string[]
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: 'next',
    date: '',
    notes: [
      'A new chat takes the title Claude gives it, instead of keeping the first line you typed',
      'Rename a chat yourself and it stays renamed',
      "A Changes tab in the side panel: every changed file, with its diff in place",
      'Open it from the Changes row in the summary, or with Cmd Shift D',
      'Compare against the working tree, your base branch, or the commit a summary named',
      'New files are counted too, not just ones git already knew about',
      'Pick split or unified, wrap long lines, or ignore whitespace — and it remembers',
      'Diffs follow your theme instead of always being dark',
      'Claude can summarise what it changed in the chat; click a file to open its diff',
      'Picking a file in the tree scrolls the list to it',
      'Icon buttons across the app have proper tooltips now, with their shortcut'
    ]
  },
  {
    version: '0.0.5',
    date: '2026-09-18',
    notes: [
      'Messages you send render the way the composer previewed them: lists, quotes, tables, code blocks and emphasis',
      '@-mentions stay chips after you send; clicking one opens the file in the side panel',
      'Attachments in a message show their filename instead of a temp path',
      'Slash commands and ultrathink keep their colour once sent',
      'Click a file you attached to open it in the side panel',
      "Editing a message uses the composer's editor, with the same live preview and chips",
      'Enter saves an edit; Shift+Enter breaks the line'
    ]
  },
  {
    version: '0.0.4',
    date: '2026-09-18',
    notes: [
      'The side panel holds files as well as pages, mixed in any order',
      "Read a file from the chat's folder beside the conversation, with syntax highlighting",
      'The file tree respects .gitignore, and a filter box searches the whole repo',
      'Clicking a breadcrumb lists the files beside it, so you can switch without the tree',
      'Right-click a file to open it in an editor you have installed, reveal it in Finder, copy its path, or add it to the chat',
      'Edit a file outside Nyra and the preview follows',
      'File paths in the conversation open in the panel instead of a modal',
      'Cmd T opens a browser tab, Cmd P a file tab; both are rebindable in Settings',
      'Drag a tab to reorder it',
      'Opening the panel no longer starts a browser; it waits until you ask for one',
      'File tabs come back when you reopen Nyra'
    ]
  },
  {
    version: '0.0.3',
    date: '2026-09-18',
    notes: [
      'Fixed a browser process that kept running after quitting, pinning a CPU core',
      'Settings redesigned as vertical tabs, with permissions and shortcuts alongside',
      'Every keyboard shortcut is listed, searchable and reassignable',
      'Appearance settings — system fonts, text size, zoom and chat width',
      'Interface and conversation text sizes are set separately',
      'Plan mode, model and effort are per chat instead of global',
      'Panel layout and size are remembered per chat',
      'Enter always sends; Shift+Enter breaks the line or continues a list',
      'Pasted images and files become a chip straight away',
      'Fixed messages drawing on top of each other during long plans',
      'Scrollbars are visible again, and wide tables show that they scroll'
    ]
  },
  {
    version: '0.0.2',
    date: '2026-09-17',
    notes: []
  },
  {
    version: '0.27.3',
    date: '2026-06-25',
    notes: [
      'Faster startup and lighter memory — smaller initial load, and sessions now persist reliably without hitting browser storage limits'
    ]
  },
  {
    version: '0.27.2',
    date: '2026-06-01',
    notes: [
      'Favorite sessions — star sessions into a Favorites section above Recent, drag to reorder'
    ]
  },
  {
    version: '0.27.1',
    date: '2026-06-01',
    notes: [
      'Fix: queued messages now stay with their original session if you switch sessions before the previous turn finishes',
      'Fix: PDF uploads (attach button and drag-and-drop) now work in the packaged app'
    ]
  },
  {
    version: '0.27.0',
    date: '2026-05-08',
    notes: [
      'AskUserQuestion now renders as a readable card with the question and option labels instead of "[object Object]"'
    ]
  },
  {
    version: '0.26.0',
    date: '2026-05-03',
    notes: [
      '/login works in-app — opens a modal with an embedded terminal running claude /login; auth failures mid-turn auto-prompt and re-send the failed message after sign-in',
      'Redesigned chat header — three zones (CWD pill, model+effort popover, mode badges + utility group) with clearer active states and a consistent icon order'
    ]
  },
  {
    version: '0.25.0',
    date: '2026-05-01',
    notes: [
      '/tasks panel — track background bash processes Claude spawns; Kill button, live output tail, status-bar chip',
      'Unified bottom panel — Terminal tabs and Processes share one tab bar; Cmd+J opens Terminal, /tasks opens Processes',
      'Persistent Claude per session — backgrounded processes now actually outlive a turn (sleep 60 sleeps for 60s)'
    ]
  },
  {
    version: '0.24.1',
    date: '2026-04-30',
    notes: [
      'Fix: send image-only messages without requiring text',
      'Fix: long URLs now wrap inside the user message bubble instead of overflowing',
      'Fix: built-in slash commands like /login, /model, /config keep their leading slash'
    ]
  },
  {
    version: '0.24.0',
    date: '2026-04-29',
    notes: [
      'Available Agents in right panel — see your subagents with personality icons, click to @-mention or jump to edit'
    ]
  },
  {
    version: '0.23.0',
    date: '2026-04-28',
    notes: [
      'Memory tab — view/edit auto-memories and CLAUDE.md files from the right panel'
    ]
  },
  {
    version: '0.22.0',
    date: '2026-04-27',
    notes: [
      'Light theme — pick Light, Dark, or System in Settings. Code blocks and diffs follow the theme.'
    ]
  },
  // The 'next' entry accumulates notes from ship-feature during the current dev cycle.
  // On release (npm version), scripts/add-release-note.js renames it to the actual
  // version + date, and prepends a fresh empty 'next' entry. The modal filters this
  // entry out so users only see released versions.
  {
    version: '0.21.0',
    date: '2026-04-26',
    notes: [
      'Release notes show full version history — rebuilt v0.16–v0.19 entries and fixed the release script so each version archives correctly going forward',
      '/permissions dialog — per-tool auto-approve toggles and an "Always allow" button on prompts so you stop seeing the same one twice'
    ]
  },
  {
    version: '0.20.0',
    date: '2026-04-25',
    notes: [
      'Tool trace polish — compact MCP names, no more text overlap on long tool names',
      'Permission dialog polish — Enter/Esc/⌘⏎ shortcuts, plan markdown preview, viewport-sized diff'
    ]
  },
  {
    version: '0.19.0',
    date: '2026-04-25',
    notes: [
      'Workflow marketplace — browse, install, and share workflows from the nyra-flows-marketplace repo'
    ]
  },
  {
    version: '0.18.0',
    date: '2026-04-24',
    notes: [
      'Workflows Phase 3 — sub-workflows, multi-project run targets, metrics dashboard, and cron/file-watcher/webhook triggers',
      'Auto-recover when Claude CLI can\'t resume a stale conversation — retry transparently without --resume'
    ]
  },
  {
    version: '0.17.0',
    date: '2026-04-21',
    notes: [
      'Workflows Phase 2 — parallel fork/join, loops, human review, variables, per-node allowed tools, execution history, import/export'
    ]
  },
  {
    version: '0.16.0',
    date: '2026-04-12',
    notes: [
      'Visual Agent Workflows — React Flow canvas for orchestrating Claude agents',
      '/release-notes modal with version history',
      'Live-ticking rate limit countdown (every second)'
    ]
  },
  {
    version: '0.14.0',
    date: '2026-04-11',
    notes: [
      'Image compression before sending to reduce token usage',
      'Agent definitions in @-mention autocomplete',
      'Fix infinite re-render loop and dev mode black screen',
      'Named subagents in @-mention autocomplete',
      'Fix PDF drag-and-drop crash and image file picker'
    ]
  },
  {
    version: '0.13.0',
    date: '2026-04-11',
    notes: [
      'Redesign tool call cards as compact trace lines with grouping',
      'Windows support link in README (shoutout to yexi-fun)'
    ]
  },
  {
    version: '0.12.0',
    date: '2026-04-11',
    notes: [
      'Session forking with /fork command and message fork icon'
    ]
  },
  {
    version: '0.11.0',
    date: '2026-04-11',
    notes: [
      'Auto-compaction when context approaches token limit',
      '/loop recurring tasks — cron-like scheduled prompts'
    ]
  },
  {
    version: '0.10.0',
    date: '2026-04-11',
    notes: [
      '/context optimization tips',
      '/copy code block picker modal',
      'Message stash (Ctrl+S) — save and restore draft input'
    ]
  },
  {
    version: '0.9.0',
    date: '2026-04-11',
    notes: [
      '/rename sessions — inline rename in sidebar + slash command'
    ]
  },
  {
    version: '0.8.0',
    date: '2026-04-11',
    notes: [
      '/compact context compression',
      '/stats session statistics modal',
      'Rate limit display in status bar and right panel'
    ]
  },
  {
    version: '0.7.0',
    date: '2026-04-10',
    notes: [
      'GitHub Releases in release scripts',
      '/fast command in slash autocomplete'
    ]
  },
  {
    version: '0.6.0',
    date: '2026-04-10',
    notes: [
      'Onboarding wizard with CLI detection and getting-started tips'
    ]
  },
  {
    version: '0.5.0',
    date: '2026-04-10',
    notes: [
      'Git worktrees UI for isolated parallel sessions'
    ]
  },
  {
    version: '0.4.0',
    date: '2026-04-09',
    notes: [
      'Message queuing — type next message while Claude responds',
      'Live MCP panel with server status and tools',
      'Vitest test suite'
    ]
  }
]
