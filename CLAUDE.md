# Nyra

A Tauri desktop client for Claude Code. React + TypeScript renderer, Rust backend,
a Node sidecar for the browser.

## Tooltips and shortcuts

**An icon-only control gets a real tooltip, never the native `title` attribute.**
`title` renders as an OS tooltip: it looks nothing like the app, waits about a
second, cannot be styled, and has nowhere to put a keycap. Use the component:

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <button type="button" onClick={…} aria-label="Stop">
      <Square className="size-3.5" />
    </button>
  </TooltipTrigger>
  <TooltipContent>Stop</TooltipContent>
</Tooltip>
```

Use `asChild` so the trigger *is* your button — without it Radix renders its own,
and your classes and `type` are dropped. `App.tsx` mounts one `TooltipProvider` at
the root at 400 ms; don't add nested providers, and don't make `Tooltip`
self-provide, or that delay is silently overridden. A test that renders a slice of
the tree has to wrap it in a `TooltipProvider` itself.

For a control with a registered command, reach for `IconButton` instead — it takes
a `command` and appends the live keycap, so the hint stays right after a
rebinding:

```tsx
<IconButton label="Refresh changes" command="panel.right.changes.refresh" onClick={…}>
  <RotateCw className="size-3" />
</IconButton>
```

**The one place `title` is still correct** is revealing text that is visually
truncated — a full path under an ellipsised filename, a URL under a tab label.
That is disclosure, not an action. It also tends to appear in long or virtualised
lists, where a Radix `Tooltip` per row means per-row state and context for
something the user hovers once in a hundred rows. Leave those as `title`.

The test: *is this a control, or a truncated string?* Control → `Tooltip`.
Truncated string → `title`.

### Registry

Anything a user would reach for repeatedly belongs in
`src/renderer/src/commands/registry.ts`, even unbound. Registering it costs one
entry and buys the command palette, a rebindable key, and a keycap in its tooltip.
`defaultChord: null` is fine and common — it means "discoverable and bindable, but
we are not spending a chord on it".

Not everything qualifies. A destructive one-off inside a modal ("Remove matcher
group") is reached in context, and a palette full of them makes the palette worse.
Register what someone does *often*, not everything that can be clicked.

Never hardcode a keycap string. Read it with `useChordLabel(id)` or `<CommandKbd
id=… />` — hardcoded glyphs are wrong off macOS and wrong the moment anyone
rebinds.

## Contrast

**Never put an alpha on a token that is already muted.** `text-muted-foreground/40`
composites to about 1.7:1 on white — it reads as damage, not as hierarchy. The
ramp is tuned to clear AA on both surfaces; if you need a second tier, reach for a
different token, not for a fraction of this one.

`src/__tests__/styles/contrast.test.ts` fails the build on
`text-{muted-foreground,info,danger,success,warning,merged}/<80` and on
`text-foreground/<80`. Fills are exempt and stay expressive — `bg-info/10` behind
a chip is fine, a 6px status dot at `bg-success/40` is not, because that dot is
the only thing reporting the result.

The same mistake in a selected state is worse: the title bar marked its active
toggle with `bg-accent` over `bg-sidebar`, four thousandths of a lightness step
apart, so nothing said which panel was open. A selected control needs a fill *and*
a foreground step.

### Elevation

The vendored `--shadow-*` ladder is entirely `hsl(0 0% 0% / 0.00)` — `shadow-md`
and `shadow-xl` paint nothing at some thirty call sites, and what actually
separated a floating surface was `ring-1 ring-foreground/10`. Use `shadow-panel`
(`--panel-shadow`, per-theme) for things that genuinely float: the composer, the
pinned summary, the browser miniature. Don't switch the ladder on to fix one
surface — it restyles every popover in the app as a side effect.

## Conventions taught to the model

The headless CLI has no `TodoWrite`, `AskUserQuestion` or `ExitPlanMode`, so Nyra
teaches fenced blocks in their place and parses them out of the reply. They live
in `claude.rs` (`ASK_CONVENTION`, `TASKS_CONVENTION`, `CHANGES_CONVENTION`,
`IMAGE_CONVENTION`) with a parser each in `src/renderer/src/lib/`.

If you add one: teach it in `claude.rs`, parse it in `lib/`, strip it in
`Chat.tsx`, and add the fence to the shared-conventions assertion in the
`compose_system_prompt` tests. A convention that tells the model to run a command
must be checked against a real repo — `CHANGES_CONVENTION` originally said
`git diff --numstat`, which cannot see a file git has never been told about, so a
turn that added files summarised none of them.

## macOS permissions

**Never read another app's preference domain or container from a shell here.**
Every command run inside Nyra inherits Nyra's TCC identity, so `defaults read
<someone else's domain>`, `~/Library/Containers/*` and `~/Library/Application
Support/<other app>` each raise a *"Nyra would like to access data from other
apps"* dialog with Nyra's name on it. A single `for d in $(defaults domains)`
sweep is one dialog per domain — hundreds of them, in a row, over the window
someone is trying to work in. Our own domain, `~/.nyra`, `~/.claude` and the
repo are fine; nothing else is.

The reason those grants only have to be given once is `~/.nyra/signing-identity`
and `scripts/build-app.mjs`. Ad-hoc signing — what `signingIdentity: "-"` used
to do — leaves a designated requirement of `cdhash H"…"`, and macOS keys every
privacy grant to that requirement. A rebuild is a new cdhash, so every grant
dies with the build that asked for it and the next launch asks again. Signed
with a certificate the requirement names the certificate instead, which survives
rebuilds, updater installs and certificate renewal. `tauri dev` does not run the
bundler, so a dev build is still ad-hoc and still re-asks.

## Verifying

- `npm test` (vitest), `npm run check` (tsc + cargo check), `cargo test --manifest-path src-tauri/Cargo.toml`.
- `npm run dev` runs Tauri. Dev and the installed app have **separate** WebKit
  stores (`~/Library/WebKit/nyra` vs `com.nyra.app`): the dev binary is
  unbundled, so WebKit keys it on the executable name rather than the
  identifier. Dev cannot reach real chat data. Quit it properly anyway, or
  terminals, Claude processes and the sidecar are left running.
- Never reuse a dev server that is already running; a stale module graph has
  read as a real regression before.
- `npm run dev` is **passive**: it skips the workflow trigger runtime and the
  managed-skills sync, because both act on state shared with the installed app
  and would otherwise fire every trigger twice. `npm run dev:active` when those
  are the thing being worked on.

### Seeing into a running instance

A change with a rendered surface gets looked at, not described. `node
scripts/nyra-dev.mjs shot` prints a PNG path for the dev window — the real
WKWebView, not the renderer in a browser tab, where there is no Tauri IPC and
nothing works. Also `eval`, `log`, and `instances`. The `nyra-dev` skill has the
detail, including what a software snapshot cannot capture.

Anything running two instances contends over is a bug waiting to happen: the
scratch dirs under `$TMPDIR` are `{name}-{pid}` for exactly that reason, after a
shared `nyra-files` meant a dev restart broke attachments in the installed app.
Give anything new the same treatment.
