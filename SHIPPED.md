# Shipped

Feature-level archive of what Nyra has built, backfilled from
`src/renderer/src/data/releaseNotes.ts` (which stays the line-by-line,
user-facing record). `/ship-feature` appends here as items leave `VISION.md`.

Versions in parentheses are where the work landed.

## Core Roadmap (shipped)

- Chats with Claude Code — streaming turns, message queueing, forking, rename, stash, and auto-compaction as the context fills (v0.0.1)
- Steer a running turn — push a queued message into the turn already in flight instead of waiting it out (v0.0.10)
- Plan mode as a first-class surface — a plan card that waits until the plan is finished to ask, updates in place when edited, and opens in the side panel to read (v0.0.9)
- Questions answered in the composer — Claude's questions arrive where you already type; pick an option or write your own, and answering them one at a time keeps the earlier answers (v0.0.9, v0.2.3)
- AI-titled chats — a new chat takes the title Claude gives it, and stays renamed if you override it (v0.0.6)
- Rich sent messages — lists, quotes, tables, code blocks and emphasis render the way the composer previewed them (v0.0.5)
- @-mentions and attachments as chips — they survive sending, and clicking one opens the file in the side panel (v0.0.5)
- Edit a sent message in the composer's own editor, with the same preview and chips (v0.0.5)
- Pull request chips — a chat shows the PRs it opened with live GitHub status, and recovers ones the live detector missed (v0.2.1, v0.2.2)
- Port chips — a chat lists the ports its dev servers are listening on; click one to open it (v0.2.1)
- Voice dictation — speak into the composer, with a transcript you can edit before sending; transcribed entirely on this Mac (v0.3.0)
- A running indicator that names what Claude is doing — a shimmering line with cat eyes and a verb (v0.2.3)
- Continuous spell-check in the composer, underlining typos as you type (v0.2.3)

## Parity with the Claude Code CLI (shipped)

- Git worktrees for isolated parallel sessions (v0.0.1)
- Slash commands — permissions, stats, context, copy, loop and login, with an in-app sign-in (v0.0.1)
- Live MCP server status and rate-limit countdown (v0.0.1)
- Per-chat model, effort and plan mode, instead of one global setting (v0.0.3)
- A hook editor, a skill editor and an MCP settings panel — GUI surfaces the CLI has no equivalent for (v0.0.1)
- Subagents you can watch — click one to follow its work in a tab of its own (v0.0.10)
- In-session transcript search (v0.0.3)
- Rebindable keyboard shortcuts, every one listed and searchable (v0.0.3)
- Skills, Commands and Memory as full pages instead of cramped rail lists, with your own custom slash commands scanned from disk (v0.2.3)
- Usage in the rail footer, with real quota numbers (v0.2.3)

## Side panel and files (shipped)

- One tab strip for files and browser pages, mixed in any order, reorderable by drag, restored on reopen (v0.0.4)
- Read a file beside the conversation with syntax highlighting; it follows edits made outside Nyra (v0.0.4)
- A file tree that respects `.gitignore`, with a filter box that searches the whole repo (v0.0.4)
- Breadcrumbs that list the files beside the current one, so you can switch without the tree (v0.0.4)
- Right-click a file to open it in your editor, reveal it in Finder, copy its path, or add it to the chat (v0.0.4)
- File paths in the conversation open in the panel instead of a modal (v0.0.4)

## Changes and diffs (shipped)

- A Changes tab — every changed file with its diff in place, opened from the summary or Cmd Shift D (v0.0.6)
- Compare against the working tree, your base branch, or the commit a summary named (v0.0.6)
- Untracked files counted too, not just ones git already knew about (v0.0.6)
- Split or unified, wrapped lines, ignored whitespace — remembered between sessions (v0.0.6)
- Diffs follow your theme instead of always being dark (v0.0.6)
- Claude can summarise what it changed; click a file to open its diff (v0.0.6)

## Browser (shipped)

- A browser panel driven over CDP, at full frame rate and sharp on Retina (v0.0.11)
- Device mode — pick a preset, type a size, rotate, or zoom to fit; Claude can set it too, marked as its doing (v0.0.11)
- The page reflows live as you resize the panel (v0.0.11)
- The agent's cursor stays on screen the whole time Claude is driving the tab (v0.0.11)

## Flows (shipped)

- A canvas for wiring Claude runs, shell steps, conditions, loops, parallel branches and human review (v0.0.1)
- Triggers — run on a schedule, a file change, or a webhook (v0.0.1)
- Flows as a view, not a tab, with flows listed under their project in the rail (v0.0.7)
- Top-to-bottom layout with loops drawn as a box, and a travelling pulse showing which edge the run is on (v0.0.7)
- Variable highlighting, autocomplete, and unresolved references flagged before you run (v0.0.7)
- Conditions checked as you type — a broken one used to just be false, silently (v0.0.7)
- A run panel that summarises where the run is, with each step opening for its output (v0.0.7)
- Resizable details, inputs, variables, history, metrics and triggers panels on Cmd 1–6 (v0.0.7)
- Script node timeouts up to an hour, set in the inspector, with the process actually killed on timeout (v0.1.0, v0.2.1)

## Designs (shipped)

- Ask Claude to design a screen and it shows you a picture before building it (v0.2.0)
- Designs open in a canvas tab of their own and stay live as Claude revises them (v0.2.0)
- Click a design mentioned in chat to open it; naming a screen jumps straight to it (v0.2.0)
- Right-click a screen to copy it as a PNG or reference it in the composer (v0.2.0)

## App control for Claude (shipped)

- Claude can open a panel or run any Cmd+K command itself (v0.1.0)
- Claude can write a flow and open it on the canvas, validated before saving, with every problem listed at once (v0.1.0)
- Claude can resize a side panel, or reset it (v0.2.0)
- Claude can check for an update and offer you a link, without installing it mid-conversation (v0.1.0)

## Settings, shortcuts and appearance (shipped)

- Settings as vertical tabs, with permissions and shortcuts alongside (v0.0.3)
- Appearance — system fonts, text size, zoom and chat width, with interface and conversation sizes set separately (v0.0.3)
- Light, dark and system themes, with code blocks and diffs following along (v0.0.1)
- Dark mode lifts cards and popovers by shade instead of by a border (v0.1.0)
- Panel layout and size remembered per chat (v0.0.3)
- Real tooltips on icon buttons across the app, each showing its shortcut (v0.0.6)
- A contrast pass across the app — washed-out timestamps, paths and "+N more" labels made legible again (v0.2.3)
- Light mode with real panel shadows and surfaces, instead of flat white (v0.2.3)
- The conversation column recenters as panels open and close (v0.2.3)

## Platform and reliability (shipped)

- Per-instance scratch dirs, so a dev restart no longer breaks attachments in the installed app (v0.0.8)
- The debug log is readable only by you (v0.0.8)
- Screenshot a dev build, read its console, and run JS in it from outside (v0.0.8)
- Script nodes find npm, node and gh when Nyra is started from Finder (v0.1.0)
- Image compression before send (v0.0.1)
- macOS permission grants survive an app update, instead of resetting with every rebuild (v0.2.3)
