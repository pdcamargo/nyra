---
name: nyra-app
description: Explain or operate Nyra's panels, views, settings, and data locations. Use for Nyra product questions and, when Nyra app tools are available, requests to operate the app.
---

# Nyra, from the inside

Nyra is a desktop app for Claude Code. When `nyra_ui`, `nyra_flow`, and
`nyra_update` are available, the chat is running inside Nyra; start with
`nyra_ui` using `action: "state"`, because it tells you what is already open.
Running a toggle blind closes as often as it opens. When those tools are not
available, treat this skill as product reference and do not claim to operate the
running app.

## What the parts are called

Use these names when you talk to the user; they are what the app calls them.

| Name | What it is |
|---|---|
| **Projects panel** | The left rail: projects and their chats. |
| **Side panel** | The right panel. Holds a tab strip — browser tabs, file tabs, the Changes tab. |
| **Changes tab** | A live diff of the working tree for this chat's directory. What the `nyra-changes` card at the end of a reply links into. |
| **Pinned Summary** | The strip over the transcript: what this conversation is doing — its directory, its model, running subagents, open browser tabs. Not a summary of the text. |
| **Terminal** | The bottom dock. A real shell, plus a Processes tab for background jobs. |
| **Flows** | A *view*, not a tab — it replaces the chat pane. See `write-a-flow`. |

Both the side panel and the Pinned Summary can be open at once; they answer
different questions.

## Driving it

`nyra_ui action: "commands"` is the live list — roughly forty, the same ones in
the command palette. Do not memorise ids from here; ask, because a user can
rebind and a release can add. Pass `on: true` / `on: false` for anything the
list shows with a `state` field.

Two things the list will not offer you, and it is worth knowing why rather than
retrying:

- **Aborting the turn, and plan mode.** Both destroy the reply in progress —
  plan mode is part of how the underlying process is launched, so changing it
  restarts that process mid-sentence.
- **New chat, clearing a chat, opening the palette, signing in.** These move the
  user somewhere they did not ask to go, or throw away their transcript.

Theme is `app.theme.light`, `app.theme.dark`, `app.theme.system`.

## On disk

| Path | What |
|---|---|
| `~/.nyra/workflows/<id>.json` | Flows, one file per flow. The filename is the id. |
| `~/.nyra/workflow-executions/` | Run records. |
| `~/.nyra/worktrees/` | Managed git worktrees for chats that asked for one. |
| `~/.claude/skills/` | Skills, including the ones Nyra ships and keeps current. |

**Chats and settings are not in `~/.nyra`.** They live in the webview's own
storage, so there is no file to read them out of — ask `nyra_ui` instead.

One consequence worth remembering: `~/.nyra/workflows/` is shared by every Nyra
on the machine, including a development build running beside the installed one.
A flow written from one shows up in the other.

## Updates

`nyra_update` checks. It never installs — installing restarts Nyra, which would
cut off the reply you are writing. Report what you found and offer
`[update and restart](nyra://update)`, which renders as a button the user
presses.

## What is not yours to change

Model, effort and plan mode are part of how this session was launched; changing
one restarts the process you are running in. Hooks, permissions and MCP servers
are real configuration with real blast radius — describe what you would change
and let the user do it in Settings. The user's terminal is theirs: run commands
with Bash, not by typing into the pane they are watching.

---

*Nyra installs this skill and keeps it current. Edit it and it becomes yours —
Nyra stops touching it. Delete it and it stays deleted; the Skills tab in the
sidebar offers to put it back.*
