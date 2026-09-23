import { describe, expect, it, beforeEach } from 'vitest'
import {
  COMMANDS,
  COMMANDS_BY_ID,
  agentCommands,
  runCommand,
  type CommandId
} from '@renderer/commands/registry'
import { useUiStore } from '@renderer/store/ui'
import { useWorkflowStore } from '@renderer/store/workflow'
import { useSettingsStore } from '@renderer/store/settings'

/**
 * The registry became callable by something other than a hand. These tests are
 * about that difference: a keystroke that lands on an inert command is a shrug,
 * and an agent that does the same reports a success it did not have.
 */
describe('command registry', () => {
  describe('the denylist', () => {
    // Pinned by id on purpose. Both of these destroy the turn that asked for
    // them, and the failure mode is silent — a rename that quietly drops the
    // denial would not break anything else in the suite.
    it.each([
      ['session.abort', 'cancels the running turn'],
      ['chat.planMode', 'is in the spawn fingerprint, so it respawns the child'],
      ['composer.dictate', 'switches on the microphone']
    ])('%s is closed to agents because it %s', (id) => {
      const command = COMMANDS_BY_ID.get(id as CommandId)
      expect(command, `${id} has been renamed or removed`).toBeDefined()
      expect(command!.agent).toBe(false)
      expect(command!.agentReason).toBeTruthy()
    })

    it('refuses a denied command and says why', () => {
      const outcome = runCommand('session.abort', { agent: true })
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.error).toMatch(/stopping itself/i)
    })

    it('still runs it for a person at the keyboard', () => {
      // No `agent` flag — the denials are about callers who are not one.
      expect(runCommand('chat.planMode').ok).toBe(true)
    })

    it('keeps every denied command out of the catalog', () => {
      const listed = new Set(agentCommands().map((c) => c.id))
      for (const command of COMMANDS) {
        if (command.agent === false) expect(listed.has(command.id)).toBe(false)
      }
    })
  })

  describe('what is runnable', () => {
    it('lists nothing an agent cannot actually run', () => {
      for (const info of agentCommands()) {
        const command = COMMANDS_BY_ID.get(info.id)!
        expect(command.readOnly, `${info.id} is readOnly`).toBeUndefined()
        expect(typeof command.run, `${info.id} has no run`).toBe('function')
      }
    })

    it('refuses the reference-only composer entries rather than pretending', () => {
      const outcome = runCommand('composer.bold', { agent: true })
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.error).toMatch(/reference only/i)
    })

    it('suggests near misses for an unknown id', () => {
      const outcome = runCommand('theme', { agent: true })
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.error).toMatch(/app\.theme\.light/)
    })

    it('finds the command whose label — not id — carries the word', () => {
      // The realistic wrong guess. `panel.bottom` is called "Toggle terminal",
      // so an id search alone answers "unknown" and stops there.
      const outcome = runCommand('panel.terminal', { agent: true })
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.error).toMatch(/panel\.bottom/)
    })
  })

  describe('setState — open means open', () => {
    // The whole reason setState exists: a toggle run twice with the same intent
    // ends where it started, which is the bug an agent hits and a hand does not.
    const togglers = COMMANDS.filter((c) => c.setState && c.isOn)

    it('covers every panel toggle', () => {
      expect(togglers.map((c) => c.id).sort()).toEqual([
        'file.wrap',
        'panel.bottom',
        'panel.canvas',
        'panel.left',
        'panel.right',
        'panel.right.tree',
        'panel.summary'
      ])
    })

    it.each(togglers.map((c) => [c.id]))('%s is idempotent', (id) => {
      for (const on of [true, false]) {
        runCommand(id, { on, agent: true })
        const first = COMMANDS_BY_ID.get(id as CommandId)!.isOn!()
        runCommand(id, { on, agent: true })
        expect(COMMANDS_BY_ID.get(id as CommandId)!.isOn!()).toBe(first)
      }
    })

    it('still flips when no intent is given', () => {
      useUiStore.getState().setBottomPanelOpen(false)
      runCommand('panel.bottom', { agent: true })
      expect(useUiStore.getState().bottomPanelOpen).toBe(true)
      runCommand('panel.bottom', { agent: true })
      expect(useUiStore.getState().bottomPanelOpen).toBe(false)
    })

    it('reports the resulting state so the caller can narrate it', () => {
      const outcome = runCommand('panel.summary', { on: true, agent: true })
      expect(outcome).toMatchObject({ ok: true, id: 'panel.summary', state: true })
    })
  })

  describe('availability', () => {
    beforeEach(() => {
      useWorkflowStore.setState({ isCanvasOpen: false, currentWorkflow: null })
    })

    it('refuses a flow command with the Flows view shut, instead of no-opping', () => {
      // These forward a window event nothing hears unless WorkflowCanvas is
      // mounted, so without this they return success and do nothing.
      const outcome = runCommand('flow.run', { agent: true })
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.error).toMatch(/panel\.canvas/)
    })

    it('marks them unavailable in the catalog but still lists them', () => {
      const info = agentCommands().find((c) => c.id === 'flow.run')
      expect(info).toBeDefined()
      expect(info!.available).toBe(false)
    })

    it('allows them once the canvas holds a flow', () => {
      useWorkflowStore.setState({
        isCanvasOpen: true,
        currentWorkflow: { id: 'wf-1', name: 'x', nodes: [], edges: [], createdAt: 0, updatedAt: 0 }
      })
      expect(runCommand('flow.run', { agent: true }).ok).toBe(true)
    })
  })

  describe('theme', () => {
    it.each([
      ['app.theme.light', 'light'],
      ['app.theme.dark', 'dark'],
      ['app.theme.system', 'system']
    ])('%s sets the preference', (id, expected) => {
      expect(runCommand(id, { agent: true }).ok).toBe(true)
      expect(useSettingsStore.getState().theme).toBe(expected)
    })
  })
})

describe('chords', () => {
  const chordOf = (id: string): string | null =>
    COMMANDS.find((c) => c.id === id)?.defaultChord ?? null

  // ⌘P is the chord every editor spends on a quick-open. It used to append a
  // blank file tab, which is the one thing a quick-open makes unnecessary.
  it('gives mod+p to the file picker, not to a new blank tab', () => {
    expect(chordOf('file.quickOpen')).toBe('mod+p')
    expect(chordOf('panel.right.file')).toBe('mod+shift+o')
  })

  it('binds no chord to two commands at once', () => {
    const taken = new Map<string, string[]>()
    for (const command of COMMANDS) {
      if (!command.defaultChord) continue
      // Composer entries are reference-only — they describe what the editor
      // already does, so they legitimately share chords with nothing here.
      if (command.readOnly) continue
      const holders = taken.get(command.defaultChord) ?? []
      holders.push(command.id)
      taken.set(command.defaultChord, holders)
    }
    const clashes = [...taken.entries()].filter(([, ids]) => ids.length > 1)
    expect(clashes).toEqual([])
  })
})
