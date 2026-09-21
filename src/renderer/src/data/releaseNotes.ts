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
      'Ask Claude to design a screen and it shows you a picture before building it',
      'Designs open in a canvas tab of their own, and stay live as Claude revises them',
      'Click a design mentioned in chat to open it; naming a screen jumps straight to it',
      'Right-click a screen on the design canvas to copy it as a PNG or reference it in the composer',
      'Rename or remove a design from the list without touching its file',
      'Claude can resize a side panel, or reset it'
    ]
  },
  {
    version: '0.1.0',
    date: '2026-09-21',
    notes: [
      'Dark mode is darker, and cards and popovers lift off the page by shade instead of by a border',
      'Corners are three times rounder',
      'Ask Claude to open a panel or run a Cmd+K command, and it does it itself',
      'Claude can write a flow and open it on the canvas, instead of handing you JSON to import',
      'Nyra checks a flow Claude writes before saving it, and lists every problem at once',
      'Claude can check for an update and offer you a link to install it',
      'Asking Claude to open the terminal opens it, instead of closing it when it was already open',
      'A flow that fails at the last node no longer marks every node before it as failed',
      'A failed node shows how long it ran before it gave up',
      'Script nodes find npm, node and gh when you start Nyra from Finder',
      'Set a longer timeout on a script node, up to an hour, for a step like a build'
    ]
  },
  {
    version: '0.0.11',
    date: '2026-09-21',
    notes: [
      'A new device mode: pick a preset, type a size, rotate, or zoom to fit',
      "Claude can change the browser panel's device size, marked as its doing",
      'The browser panel is no longer blurry on Retina displays',
      'The page in the browser panel reflows live as you resize it',
      'The browser panel streams at full frame rate instead of a throttled one',
      "The agent's cursor now stays on screen the whole time Claude is driving the tab",
      'Right-click a flow row to open its context menu (used to fall through to the OS)'
    ]
  },
  {
    version: '0.0.10',
    date: '2026-09-20',
    notes: [
      'Click a subagent to watch it work, in a tab of its own',
      "Steer a queued message into the turn that's already running"
    ]
  },
  {
    version: '0.0.9',
    date: '2026-09-20',
    notes: [
      'The plan card waits until the plan is finished before asking for approval',
      'A plan still being written shows as one line in the transcript',
      'Editing a plan updates its card instead of adding another',
      'Nyra no longer marks a plan "Kept planning" when you never turned one down',
      'Click a plan to read it in the side panel',
      'Type in the composer to keep planning, or press Approve',
      "Claude's questions appear in the composer, and you answer by typing",
      '"Something else" is gone; type your own answer instead',
      'Pick an option or type your own, and whichever came last wins'
    ]
  },
  {
    version: '0.0.8',
    date: '2026-09-19',
    notes: [
      'The debug log is readable only by you now',
      'Attaching a file no longer breaks after another Nyra quits',
      'Screenshot a dev build, read its console, and run JS in it from outside'
    ]
  },
  {
    version: '0.0.7',
    date: '2026-09-19',
    notes: [
      'Flows is a view now, not a tab — switch with the Chat/Flow toggle or Cmd Shift W',
      'The rail lists flows under their project, with a + on each to make one there',
      'Right-click a flow to duplicate it, move it between projects, or delete it',
      'Flows run top to bottom, with loops drawn as a box around what they repeat',
      'A travelling pulse shows which edge the run is on',
      'Prompts and conditions highlight the variables they reference, and autocomplete them',
      'A reference that names nothing gets flagged before you run it',
      'Conditions are checked as you type — a broken one used to just be false, silently',
      'Shell commands in a script node are highlighted too',
      'The run panel summarises where the run is, and each step opens for its output',
      'Stop actually stops the run',
      'Flow details, inputs, variables, history, metrics and triggers are resizable panels',
      'Cmd 1 through Cmd 6 open them',
      'Claude can write a flow for you — Nyra installs the skill and keeps it current'
    ]
  },
  {
    version: '0.0.6',
    date: '2026-09-18',
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
    version: '0.0.1',
    date: '2026-09-17',
    notes: [
      'First release. Chats with Claude Code: streaming turns, message queueing, forking, rename, stash, and auto-compaction as the context fills',
      'A side panel for files, the browser, memory and your subagents, and a bottom panel sharing terminal tabs with background processes',
      'Flows — a canvas for wiring Claude runs, shell steps, conditions, loops, parallel branches and human review into something you run on a schedule, a file change, or a webhook',
      'Git worktrees for isolated parallel sessions',
      'Slash commands for permissions, stats, context, copy, loop and login, with an in-app sign-in',
      'Light, dark and system themes, with code blocks and diffs following along',
      'Live MCP server status, rate-limit countdown, and image compression before send'
    ]
  }
]
