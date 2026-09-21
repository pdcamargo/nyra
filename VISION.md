# Nyra — Vision

Nyra is a desktop client for Claude Code. The CLI is the engine; Nyra is
everything a terminal cannot be — panels, canvases, diffs, a browser, and direct
manipulation of the things the CLI can only describe.

Two rules shape what lands on this list:

1. **Parity where the CLI leads.** Anything Claude Code ships that a GUI can
   host, Nyra should host — usually better, because it has somewhere to put it.
2. **Leverage where Nyra leads.** Nyra already has a hook editor, a skill
   editor, a flow canvas with cron/webhook/file triggers, and an MCP layer that
   lets Claude drive the app itself. Features that compound on those are worth
   more than features that merely catch up.

Items move from `## Roadmap` here into `SHIPPED.md` via `/ship-feature`.
`src/renderer/src/data/releaseNotes.ts` is the line-by-line user-facing record;
`SHIPPED.md` is the feature-level one.

## Roadmap

### Tier 1 — the parity holes worth closing first

- [ ] Checkpointing and rewind — snapshot files and conversation per turn, and restore to any point from the transcript, including back past a `/clear`, with "summarise up to here"
- [ ] Plugins and marketplaces — browse, install and update plugins from marketplaces; a fourth settings tab beside MCP, Skills and Hooks
- [ ] Fork a session — copy a chat's conversation into a sibling chat and keep working in both
- [ ] Usage attribution — break plan-limit consumption down by skill, subagent, plugin and MCP server, on top of the rate-limit tracking already there
- [ ] Scheduled chats — fire a prompt into a new chat on a cron, reusing the flow trigger runtime

### Tier 2 — clearly in reach

- [ ] Output styles — the built-in Concise style plus custom ones, picked per chat from the model settings
- [ ] The model settings the CLI grew — max effort level, ordered fallback models, which models the picker lists, and the default model for new chats
- [ ] Session recap — what happened in a chat while you were looking at another one
- [ ] Goal mode — keep a chat working across turns until a completion condition holds
- [ ] Cross-session messaging — let chats message each other by name, so a finding moves without being re-explained
- [ ] Custom themes — shippable colour palettes beyond light and dark
- [ ] Move a chat's working directory — change directory mid-conversation without rebuilding the prompt cache
- [ ] Channels and live event monitoring — push external events into a running chat so Claude can tail logs and react, reusing the webhook server

### Tier 3 — bigger bets

- [ ] Pop-out panes — tear a panel into its own window and dock it back later
- [ ] iOS Simulator pane — run and tap through an iOS app beside the conversation, the way the browser pane works
- [ ] Voice dictation — speak into the composer, with a transcript you can edit before sending
- [ ] Remote control and mobile — pick up a local chat from another device
- [ ] Computer use — drive native apps, not just the browser
- [ ] Shareable session output — publish what a chat produced as a live page that updates as the chat works

### From Codex

- [ ] Non-blocking inline questions — answer a clarifying question without stalling the turn
- [ ] Prune the chat rail — hide, archive and delete chats, and show which worktree each one owns
- [ ] Best-of-N attempts — run a task several ways in parallel worktrees and keep the diff you like
- [ ] Touch ID for tool approval — confirm a sensitive MCP or tool call with the fingerprint reader
