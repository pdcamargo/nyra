Read docs/multi-project-spec.md first, for what just shipped and why.

This is Nyra, a macOS desktop client for Claude Code: Tauri 2 + Rust backend,
React 19 + TypeScript + Tailwind frontend. Multi-project and per-chat worktrees
just landed: projects in a left rail, running-agent spinners, a per-chat
Local/Worktree choice, a floating summary panel, Recents for chats with no
project. I built that into the existing styling on purpose so this pass would
have real screens to react to.

GOAL: modernise the UI. Adopt shadcn, adopt the graffiti theme in
docs/graffiti-theme.css, restructure the layout to look and behave like the Codex desktop app.
Reference screenshots attached: main layout, command palette, composer, pinned
summary.

DO THESE FIRST, THEY ARE PREREQUISITES:

- Tailwind v3 to v4. The graffiti theme is v4 syntax (`@import "tailwindcss"`,
  `@custom-variant`, `@theme inline`, `--spacing`). We are on 3.4.19 with
  `@tailwind base/components/utilities`, a `tailwind.config.js` and a
  `postcss.config.mjs`. The theme cannot drop in until that migration is done.
  Its own phase, green before anything visual.
- The theme's polarity is inverted from ours. Today dark is the default in
  `:root`, light overrides via `[data-theme="light"]`, and `App.tsx:48` writes
  `document.documentElement.dataset.theme`. Graffiti is light-by-default with a
  `.dark` class override. `useResolvedTheme` and `App.tsx` both move to class
  toggling. Light theme must keep working; it is a hard constraint.
- The retheme is 1,243 utility occurrences across 38 files. `bg-surface-2`,
  `text-fg-muted`, `border-line-soft`, `bg-overlay-3`, `bg-canvas` and the rest
  map onto graffiti's `card` / `muted-foreground` / `border` / `accent` /
  `background`. Write the mapping table first and apply it mechanically. Our
  current tokens encode a four-tier elevation system that graffiti flattens, so
  decide how that collapses once, centrally, not 38 times.
- Fonts get vendored, not fetched. The theme was published with a
  `next/font/google` snippet, which does not apply here: no Next.js, and no
  guaranteed network. Bundle Montserrat, Inter and Fira Code locally or the app
  flashes unstyled text offline.
- Pick one shadcn registry and stay on it. The questionnaire I want is under
  `/docs/components/base/`, which is the Base UI build, not Radix. Mixing them
  pulls in two primitive libraries with different APIs. Tell me which you picked
  and why.

THE WORK:

- Every `<select>` becomes a shadcn dropdown. Every context menu becomes a
  shadcn context menu. Anywhere a hand-rolled primitive has a shadcn
  equivalent, use the shadcn one.
- Every icon becomes `lucide-react`. There are 65 hand-inlined `<svg>` elements
  and most are already lucide glyphs someone copied by hand, so it is close to
  mechanical.
- Chat rows get a context menu. Delete is the only item for now.
- Content centered and width-limited, like Codex. When the right panel opens the
  centered column shifts left instead of staying centered, so the summary never
  sits on top of the text.
- Rewrite the composer to match Codex. Auto-approve / ask-for-approval at the
  footer-left, model and effort at the footer-right. The `+` opens attachments
  and commands: plan-mode toggle lives there, plus anything else that belongs.
- Command palette: chat search plus quick actions, as in the second screenshot.
  It replaces `SessionSearch` (261 lines) and `HistorySearch` (127 lines).
  Absorb them, do not leave three search surfaces.
- Settings and summary toggles move up into the title bar, Codex style. The
  window is already `titleBarStyle: "Overlay"` with `hiddenTitle: true` and a
  38px `.drag-region`, so buttons up there need `-webkit-app-region: no-drag`.
- Add a projects-panel toggle.
- Give the side panel a glass backdrop if you can get it. It needs real content
  behind it to blur and right now it sits over opaque surfaces.
- Retire compact mode. 19 references, and settings are mirrored into Rust, so it
  touches `shared/types.ts`, `src-tauri/src/settings.rs` and the settings modal.
- Move the search button somewhere better, or make it shortcut-only.
- Wire up shadcn's questionnaire so Claude can put one in front of me during
  plan mode or mid-chat.
- There are shadcn-flavoured AI chat kits worth a look: assistant-ui, Vercel's
  AI Elements, prompt-kit, shadcn-chatbot-kit. Evaluate before adopting. They
  assume the Vercel AI SDK's streaming model and Nyra streams over its own Tauri
  bridge, so the composer and message primitives may be liftable while the data
  layer is not. Report what you find rather than wiring one in blind.

CONSTRAINTS:

- The renderer talks to the backend only through `window.api`
  (`src/renderer/src/lib/tauri-api.ts`). New capability = new Tauri command +
  new bridge method. Never import `@tauri-apps/api` inside a component.
- Everything says Nyra now, identifiers included: `nyraSessionId` on the wire,
  `nyra:` DOM event names, the `nyra-sessions` / `nyra-settings` storage keys.
  `src/renderer/src/lib/legacy-storage.ts` carries an older install's data across
  on first launch, so don't reintroduce a raw rename without one.
- Must stay green: `npm test` (176), `npm run test:rust` (89),
  `npx tsc --noEmit -p tsconfig.web.json`, and
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- The test net is thin here. There are no component tests and no `window.api`
  mock beyond a stub in `src/__tests__/setup.ts`. Nothing will catch a visual
  regression, so keep phases small enough that I can look at each one.
- Minimum window is 900x600.
- Do not break what just shipped: the project tree and its spinner rules, the
  Local/Worktree control under the composer, the floating summary, Recents.

OUT OF SCOPE: behaviour changes. This is a visual and structural pass. If you
find a real bug, say so rather than fixing it inline.

Give me a phased plan where each phase leaves the app working and the tests
green, and flag anything here you think is a mistake.
