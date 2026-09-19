---
name: write-a-flow
description: Nyra flows — what they are, and how to author one as importable JSON. Use when the user asks to build, create, or change a flow ("make me a flow that does X", "add a loop to this flow", "turn this into a pipeline"), and when they ask what Flows is or what it is for ("what is Nyra Flows?", "what does the Flows tab do?", "when would I use a flow instead of a chat?").
argument-hint: <what the flow should do>
---

# Nyra flows

## What a flow is

A chat is one conversation steered turn by turn. **A flow is a graph drawn once
and then fired.** Each node is its own headless Claude run with fresh context,
and the edges decide what runs next. Output travels down the wire as
`{{prev.output}}`.

It earns its keep when the same sequence gets typed into chat repeatedly — draw
it once, run it, walk away. Three things a chat cannot do:

- **Run without you.** Cron schedules, file watchers, and webhooks fire a flow
  with the app closed.
- **Fan out and rejoin.** `parallel` splits to several branches, `join` waits
  for all of them and concatenates.
- **Repeat until done.** `loop` re-runs a body while a condition holds.

Not everything should be a flow. One-off work, or anything needing judgement
between steps, belongs in a chat. A flow is for a sequence already known in
advance.

If asked *what Flows is*, answer from this section and stop — the rest of this
file is the authoring reference and is only needed when writing one.

## Writing one

A flow is a graph Nyra runs headlessly. Write the JSON, save it to a file, and
tell the user to open **Flows → Import flow…** in the ⋯ menu.

## Before writing

Ask only if the answer changes the graph. Otherwise assume:

- One `prompt` node per step that needs judgement. Two prompts beat one prompt
  doing two jobs, because each gets its own context.
- A `script` node for anything deterministic (`npm test`, `git diff`). Do not
  ask Claude to run a command a shell can run.
- `haiku` for gathering, `sonnet` for judgement, `opus` only when asked.

## The file

```json
{
  "id": "pr-review",
  "name": "PR Review Pipeline",
  "description": "Explore diff, analyse changes, fix issues if found",
  "nodes": [
    {
      "id": "explore",
      "label": "Explore Diff",
      "position": { "x": -100, "y": 0 },
      "data": { "type": "prompt", "prompt": "List every changed file…", "model": "haiku" }
    },
    {
      "id": "analyze",
      "label": "Analyze Changes",
      "position": { "x": -100, "y": 116 },
      "data": {
        "type": "prompt",
        "prompt": "Review these changes:\n\n{{prev.output}}",
        "systemPrompt": "You are a senior code reviewer.",
        "model": "sonnet",
        "allowedTools": ["Read", "Grep", "Glob"],
        "setVars": [{ "name": "review", "extractor": "raw" }]
      }
    }
  ],
  "edges": [{ "id": "e1", "source": "explore", "target": "analyze" }],
  "createdAt": 0,
  "updatedAt": 0
}
```

`id` must be unique and filename-safe. `createdAt`/`updatedAt` are epoch ms; 0
is fine, the app rewrites them on save.

## Node types

| `data.type` | Fields | Notes |
|---|---|---|
| `prompt` | `prompt`, `systemPrompt?`, `model?`, `allowedTools?`, `setVars?` | A real Claude turn |
| `script` | `command` | `sh -c`, output is stdout |
| `subworkflow` | `workflowId`, `inputMapping?`, `captureVars?` | Calls another flow |
| `condition` | `expression` | JS over `output`, `vars`, `iteration`. Two outputs: `yes`, `no` |
| `parallel` | — | Fans out to every outgoing edge |
| `join` | `separator?` | Waits for all incoming, concatenates |
| `loop` | `condition`, `maxIterations` | Two outputs: `body`, `exit` |
| `humanReview` | `message?` | Pauses until the user approves |

Branching edges carry the handle: `"sourceHandle": "yes"`, `"no"`, `"body"`,
`"exit"`. Every other edge omits it.

## Passing things between nodes

Every node is its own Claude turn with fresh context, so a node cannot see what
any other node said. Three things cross that gap:

- `{{prev.output}}` — the whole output of the node immediately before. One step
  only.
- `{{input.key}}` — what the user typed when they ran the flow.
- `{{vars.name}}` — output an earlier node **saved**, readable from anywhere
  after it.

A variable is the escape hatch for when `prev.output` is not enough: when a
later node needs something from several steps back, or needs one value out of a
paragraph. Save one with `setVars` on the node that produces it, and pick how to
pull the value out:

- `raw` — the whole output
- `json:path.to.field`
- `regex:pattern` — first capture group
- `lines:3-7`

`regex` is what makes a number usable in a condition: a node that answers
"I'd score this 7 because…" gives `vars.score` the digit alone, so a loop can
test `vars.score < 8`.

Reading a name nothing saved yields an empty string — no error — so a typo
produces a run that looks like it worked. Only save what a later node reads.

## Rules the engine enforces

Breaking these produces a flow that looks right and behaves wrong.

**A loop body is a single chain.** The engine follows one edge out of each body
node and ignores the rest. `parallel` and `join` fail inside a body — if a body
needs a fan-out, put it in its own flow and call it with a `subworkflow` node,
which gets its own join state per iteration.

**A loop needs no return edge.** Wire `loop --body--> first`, chain the body,
and stop. The engine returns to the loop when the chain runs out. Wire
`loop --exit--> next` for what happens after.

**A `condition` with no `no` edge just stops** on a false result. That is often
what you want; say so rather than leaving it implicit.

## Layout

Give every node a `position`. Nyra reads flows top to bottom: rows 116px apart,
columns 230px, each row centred on `x: -100` for a 200px node. Getting this
roughly right is enough — the user can run **Arrange nodes** from the ⋯ menu.

## Finish by

Writing the file, then saying in one line what the flow does, which nodes are
real Claude turns, and that it is imported through Flows → ⋯ → Import flow…

---

*Nyra installs this skill and keeps it current. Edit it and it becomes yours —
Nyra stops touching it. Delete it and it stays deleted; the Skills tab in the
sidebar offers to put it back.*
