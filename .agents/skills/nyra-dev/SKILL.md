---
name: nyra-dev
description: Inspect a running dev-mode Nyra from outside it — screenshot its window, read its renderer console, evaluate JS in it. Use when verifying a UI change in the real app ("does this look right?", "screenshot the dev app", "why is the panel blank"), when something only reproduces in the running app, or when a change needs checking against the actual window rather than tests. Requires `npm run dev` to be running.
---

# Inspecting a running Nyra

Nyra is developed inside Nyra, so there are usually two instances up: the
installed app hosting the conversation, and a dev one under `npm run dev`. This
talks to the dev one.

It goes at the real `WKWebView`, not a browser tab. Loading the renderer at
`localhost:1420` in Chromium is not equivalent — there is no Tauri IPC there, so
`window.api` is missing and nothing the bug involves actually runs.

## Commands

```bash
node scripts/nyra-dev.mjs instances                  # what is running, and on which port
node scripts/nyra-dev.mjs shot                       # PNG of the window; prints the path
node scripts/nyra-dev.mjs eval 'document.title'      # evaluate in the renderer
node scripts/nyra-dev.mjs log -n 200                 # tail that instance's debug log
```

Targets the dev instance by default. `--port N` or `--profile release` to aim
elsewhere — useful for asking whether the shipped build really looks like this,
though a release build needs relaunching with `NYRA_DEVTOOLS=1` first.

## Showing a screenshot

`shot` prints a path, which is what Nyra already renders inline:

```
![the composer after the change](/var/folders/…/nyra-devshots-8412/1758…-a3f2.png)
```

You cannot see what that renders, so if it matters whether the capture came out
right, read the file back.

**What the image does not contain.** It is WebKit's own software re-render — that
is why it needs no Screen Recording permission and works while the window is
behind others — and a software re-render cannot capture hardware-accelerated
layers. WebGL, `<video>` and the browser panel's screencast canvas come back
blank. Window chrome is outside the image entirely, so the traffic lights being
absent is not a bug. Everything drawn as DOM is there.

## Evaluating

Synchronous: the expression's value is JSON-encoded and handed back.

```bash
node scripts/nyra-dev.mjs eval 'document.querySelectorAll("[data-testid]").length'
node scripts/nyra-dev.mjs eval 'getComputedStyle(document.querySelector(".composer")).height'
```

`await` does not work — the call returns before a promise settles, and you get
told so rather than getting `{}`. Stash the result on a global inside `.then()`
and read it back in a second call.

## Reading the console

`devlog.ts` tees the renderer's console into the same file the backend logs to,
so the two interleave in causal order. `--grep renderer` for just the renderer's
half; `--grep renderer:error` for the failures.

Note that `tauri dev` truncates the log on every Rust hot-restart, so a rebuild
resets what is there.

## If it says nothing is running

Then nothing is — start it with `npm run dev` and try again. An instance listed
as `legacy` was built before this existed and has to be restarted on a current
build.

`npm run dev` is deliberately passive: it skips the workflow trigger runtime and
the managed-skills sync, because both act on state shared with the installed app
and would otherwise fire every trigger twice. Use `npm run dev:active` when
triggers or managed skills are themselves what you are working on.
