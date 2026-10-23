UNDER CONSTRUCTION

## Features

### Chats

- Each chat runs on the Claude Code CLI or the Codex CLI. Picking a model from the other one moves the chat there, carrying a summary of the conversation and the last exchange verbatim.
- Replies stream as they're written. Messages typed during a turn queue up; you can edit one before it sends, or push it into the running turn.
- Edit and Regenerate keep the previous version, and can restore the files that turn changed. Fork a chat in place or into a new git worktree.
- Model, effort and plan mode are set per chat. Plans arrive as a card you approve or keep refining.
- Claude's questions are answered in the composer. It can also ask without stopping, and pick up your answer mid-turn.
- Side questions (`/btw`) ask about a chat without changing it. Comments on selected text go out with your next message.
- A timeline of your prompts to jump between, and a recap of what ran while you were in another chat.
- Voice dictation, transcribed on-device.

### Agents and background work

- Subagents get a line in the chat and a tab where you can watch them work.
- Claude and Codex can start each other as agents with a chosen model and effort. Their approval prompts come to you.
- Background commands, monitors and listening ports appear above the composer. Click a port to open it.
- The Pinned Summary lists a chat's pull requests with live GitHub status, its changed files, subagents, flows, and anything it published on claude.ai.

### Side panel

- Files, browser pages, diffs and subagents share one reorderable tab strip.
- A file tree that respects `.gitignore`, fuzzy Quick Open, and previews that render markdown and images and follow edits made outside Nyra.
- A Changes tab diffs every changed file, untracked ones included, against the working tree, your base branch or a given commit.
- A browser driven over CDP, with device presets that set the pixel ratio, mobile flag and touch. Claude can drive it too.
- Terminal tabs in a bottom panel.

### Flows

- A canvas for wiring prompt steps (Claude or Codex), shell scripts, conditions, loops, parallel branches and human review.
- Triggers on a cron schedule, a file change or a webhook.
- `/flow` starts one from a chat. A flow can pause at a chat step and continue with whatever the conversation settled on.
- Variable references are autocompleted and checked before a run. Each step's output is kept in the run history.

### Designs

- Claude draws a screen as a design document before building it, on a canvas that updates while it edits.
- Design systems: tokens, components, patterns and screens in one folder, browsable as an overview. Claude gathers requirements through a form with live previews.
- Pin comments to elements; Claude replies on the pin.
- Copy a screen as PNG, or export a design as a PDF with one page per artboard.

### Claude operating Nyra and your computer

- Over MCP, Claude can open panels, run any command-palette command, write and run flows, and check for updates.
- Opt-in computer use lets it read, click and type in other apps. It asks before touching each app, never touches password managers, Keychain, System Settings, terminals or Nyra, and waits for your yes before sending, deleting or buying anything. Esc stops it.

### Claude Code configuration

- Pages for skills, commands, memory, hooks, MCP servers (status and tools) and plugins, with editors for skills and hooks.
- Slash-command autocomplete built from what the running CLI reports.
- Usage and rate limits for Claude and Codex.
- Workspaces, each signed in to its own Claude and Codex accounts, so work and personal chats run side by side.

### Appearance and input

- Built-in themes (Cyberpunk, Nord, Solarized, Rosé Pine, Tokyo Night) and a theme editor that recolours the live window. Themes are files in `~/.nyra/themes`.
- Fonts, text size, zoom, chat width and corner radius.
- A command palette, with every shortcut listed and rebindable.

### Platforms

- macOS and Windows. On Windows, projects inside WSL run Claude, git and the terminal in their own distro.
- Updates can download in the background and install when you quit. An optional setting keeps the computer awake while a chat is working.
