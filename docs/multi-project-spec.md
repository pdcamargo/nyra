# Multi-project + worktrees — requirements

Working spec for the next phase. Written from the user's constraints and Codex
desktop reference screenshots. The visual redesign is a **separate, later** pass;
this describes behaviour and structure, not styling.

## 1. Projects in the left sidebar

- A `Projects` section occupies the left rail.
- Each project is a row with a folder icon: closed when collapsed, open when
  expanded. Rows are individually collapsible.
- Expanding a project lists its conversations indented beneath it, by title.
- Long conversation lists truncate behind a `Show more` affordance.
- Hovering a project row reveals two actions on the right: an overflow `…` menu
  and a **new chat** (compose) icon.
- The project context menu shows the project name, its path, and an `Edit…` entry.

### Creating a project

- "Add project" opens the native folder picker — the same flow first-run
  onboarding uses today (`window.api.dialog.pickFolder`).
- **The first-run "pick a working folder" step is removed.** Choosing a single
  global working directory is meaningless once projects exist. The
  `defaultCwd` setting and its onboarding step go with it.

## 2. Running indicator

One rule, applied per project:

- Project has at least one running agent **and is collapsed** → spinner on the
  project row.
- Project is **expanded** → the spinner moves to the specific conversation row(s)
  that are running; the project row no longer shows one.

Open question: when a project is expanded but its running conversation is hidden
behind `Show more`, the spinner is invisible. Fall back to showing it on the
project row in that case.

## 3. Conversation inspector (right side, floating)

A floating panel to the right of the conversation, showing that conversation's
environment. Required content:

- **Branch / worktree** the agent is working in.
- **Change counts** for that branch — insertions and deletions
  (`git diff --shortstat` against the base). Polled while the conversation is
  open; refreshed on return rather than polled in the background.
- **Attachments** — everything attached to this conversation, listed.

Present in the Codex reference but not explicitly requested; treat as optional:
commit / push, create pull request, subagent roll-up, background terminal.

This sits **alongside** the existing right panel, not replacing it. Codex calls it
the **Pinned Summary**, with its own toggle in the conversation header, separate
from the side-panel toggle. The side panel is about the workspace; the summary is
about the conversation. Both can be open at once.

## 4. Worktrees

- The footer `+ worktree` button is removed. Worktrees are per chat, per project.
- Worktrees are **not** created for every chat. See the model below.

### How Codex does it (researched, adopt this)

Codex does not create worktrees lazily on first write — nobody does, because it
isn't safely possible (§7). Instead it makes isolation **a per-chat choice made up
front**, which solves the same problem:

- The new-chat view offers **Local** or **Worktree**. Local runs in the project's
  main checkout; Worktree runs in an isolated one. No unwanted worktrees, because
  you only get one when you ask for it.
- Managed worktrees live centrally in `$CODEX_HOME/worktrees` (configurable), not
  beside the project.
- They are created **detached-HEAD by default rather than as named branches**,
  deliberately, to avoid cluttering the branch namespace.
- A worktree is initialised from the HEAD of the selected branch **including any
  uncommitted changes** — this is how they dodge the stale-work problem in §7.
- Two kinds exist: *managed* worktrees, disposable and tied to a single chat; and
  *permanent* worktrees, long-lived and shared by several chats, created from the
  project's `…` menu.
- Cleanup: a default cap of 15 managed worktrees, auto-deleted when the chat is
  archived or the cap is hit, with a snapshot kept. Pinned, in-progress and
  permanent worktrees are never auto-deleted.

**Branch naming — decision:** keep **named branches** rather than Codex's
detached HEAD. Named branches are what make Nyra's existing Merge action
meaningful, and merging is how work gets out of a worktree here. The cost is one
branch per worktree chat; revisit if that gets noisy.

Adopting this for Nyra means:

- New chat offers Local vs Worktree.
- Managed worktrees live under `~/.nyra/worktrees/`, replacing the current
  `<project>/../.nyra-worktree-<branch>` location, which pollutes the parent dir.
- Carry uncommitted changes into a new worktree so the agent sees current work.
- Cap managed worktrees, clean up on session delete, never touch one that is
  running.

## 5. Footer

- Remove the "new session" button. New chats start from the project row's hover
  action instead.

## 6. Recents — conversations with no project

- A `Recents` section below `Projects` holds conversations not attached to any
  project.
- Rows have no folder icon; the section offers a `+` to start one.
- These spawn Claude in the home directory (`~`).
- Note: skills, memory, MCP and hooks all resolve relative to cwd, so a Recents
  conversation sees the global (`~/.claude`) scope only.

## 7. Known constraints

**Worktree creation cannot be deferred to "the first time the agent writes."**
A Claude process is spawned with a fixed working directory and cannot be moved
afterwards, and it runs under `--permission-mode bypassPermissions`, so by the
time a write tool is observed the write has already landed in the main tree.
Codex does not attempt this either; it asks up front instead (§4).

**Uncommitted changes do not follow a worktree by default.** `git worktree add`
branches from HEAD, so work in progress in the main checkout is invisible to the
agent — it would be reading an older version of files you are actively editing.
Codex solves this by seeding the worktree with the uncommitted changes. Do the
same.

## Sources

- <https://learn.chatgpt.com/docs/environments/git-worktrees>
- <https://learn.chatgpt.com/docs/environments/local-environment>
- <https://codex.danielvaughan.com/2026/04/11/codex-app-worktree-lifecycle-local-environments/>
