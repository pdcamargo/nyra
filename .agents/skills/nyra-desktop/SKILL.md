---
name: nyra-desktop
description: Operate another app on this computer, like opening, clicking, typing or reading something in Mail, Finder, Notes or Calendar. Use when the desktop_* tools are available and the user asks you to do something in an app outside Nyra.
---

# Operating other apps

The `desktop_*` tools read another app's window as text and act on it. They
move things on a screen the user is looking at, and the user can move them back
while you work. Treat every snapshot as a photo that goes stale.

## Try a cheaper route first

Clicking through a UI is slow and breaks easily. Before you snapshot anything,
check whether the app can be driven directly:

**macOS**
- `osascript` (AppleScript or `-l JavaScript`) for scriptable apps: Finder,
  Mail, Notes, Calendar, Reminders, Music, Safari, Keynote, Numbers, Pages.
  `osascript -e 'tell application "Notes" to make new note with properties {body:"…"}'`
  does in one call what takes ten clicks. The first time, macOS asks the user
  to allow Nyra to control that app. Say so before you run it.
- `shortcuts run "<name>"` for anything the user has built a Shortcut for.
  `shortcuts list` shows them.
- `open -a <App> <file>`, `open <url>`, `defaults read/write` for preferences.

**Windows**
- PowerShell, `Start-Process`, and COM automation for Office
  (`New-Object -ComObject Excel.Application`).

**Both:** if the app has its own MCP server or CLI, use that. For a web page,
use Nyra's own browser tools, not a browser app.

Use the desktop tools when none of that works, or when the user wants to watch
it happen.

## The loop

1. `desktop_apps` lists what is running, each app's windows, and whether this
   chat may use it. The first time you touch an app, the user is asked. If
   they say no, stop. Don't look for another way in.
2. `desktop_snapshot app:"Mail"` returns the focused window as a tree:

   ```
   Mail — "Inbox" · snapshot 3
   [e41] toolbar
     [e42] button "Get Mail"
     [e43] button "Delete" ⚠ irreversible
   [e44] text field "Search"
   [e45] list "Messages"
     [e46] row "Anna — Lunch on Friday?"
   … 212 more under e45 — desktop_snapshot root:"e45" to see them
   ```

   `window:` takes a number or part of a title from `desktop_apps`.
   `window:"menu"` reads the app's menu bar, which is often the most reliable
   way to find a command. `root:` expands a part that was cut off.
3. `desktop_act` with a ref:
   - `press` clicks a button, menu item, link or checkbox.
   - `focus` moves focus to a field.
   - `type` inserts text at the field's cursor.
   - `set_value` replaces a field's whole value.
   - `keys` sends a shortcut such as `cmd+s` or `return`. `mod` means cmd on
     macOS and ctrl on Windows.
4. **Take a new snapshot** after anything that changes the window, and before
   the next action. Refs keep counting up. A ref from an older snapshot still
   works while its element is where it was. Once it has moved you'll be told to
   snapshot again, so do that. Don't guess.

## When to take a screenshot

`desktop_screenshot app:"Preview"` returns the window as an image you can look
at. Snapshots are cheaper and give you refs, so start with one. Take a
screenshot when the snapshot doesn't tell you enough:

- the app draws its own UI and the tree is empty or just `group`s: canvases,
  games, most design tools, some Electron apps
- the question is visual: layout, colour, whether something rendered, what an
  image or chart shows
- you need to check that the window looks the way the user described

`x`/`y` in place of a ref is a real click at a pixel in the window's **latest
screenshot**, so take one first and read the point off it. It moves the user's
pointer, so use it only when the tree has nothing usable. The first screenshot
needs Screen Recording. If it's missing, the user is shown a button.

To show the user a screenshot in the conversation, use the path in the result
with Nyra's image convention. The miniature over the chat already shows the
last window you looked at, so do this only when they ask.

## What needs the user

**Sending, deleting, buying and submitting always go through the user.** The
snapshot marks those elements `⚠ irreversible`, and pressing one fails until
you pass `confirmed: true`. The same goes for Return and Delete in a window
that has such a button. Before you pass it, say exactly what will happen ("This
sends the email to Anna and Bob"), ask, and wait for a yes in this conversation.
A yes to an earlier step is not a yes to this one. Never pass `confirmed` to
get past the refusal.

## When something is refused

| It says | Do this |
|---|---|
| **off limits** | Password managers, Keychain, System Settings, terminals and Nyra itself can't be touched, and the user cannot allow them. Don't try the shell, a script or `osascript` instead. Say what you needed, and let the user do it. |
| **the user said no** | Stop using that app in this chat. |
| **password field** | You never type into or read a password field. Ask the user to fill it in. |
| **needs Accessibility / Screen Recording** | The user has been shown a button to grant it. Tell them, then wait until they say it's done. Screen Recording only counts after Nyra is quit and reopened. If Nyra is already ticked in the list and it still fails, the tick is left over from an older build: they remove it with − and add it again. |
| **using the keyboard or mouse** | The user is working. Wait, then try once more, or tell them what you were about to do. |
| **stopped desktop control (Esc)** | The user pressed Esc. Touch nothing more this turn, and say where you stopped. |
| **secure keyboard entry is on** | macOS is dropping keystrokes, because a password field or a terminal's Secure Keyboard Entry is active somewhere. Ask the user to close it. |
| **runs as administrator** (Windows) | Nyra can't drive an elevated window. Ask the user. |

## Saying what you did

The user is watching the other app, not your tool calls. After acting, say in
one line what you did and where: "I typed the address into Mail's To field and
left the message unsent." If the window didn't end up as expected, say that
too.

---

*Nyra installs this skill and keeps it current. Edit it and it becomes yours,
and Nyra stops touching it. Delete it and it stays deleted. The Skills tab in the
sidebar offers to put it back.*
