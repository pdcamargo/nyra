import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultTheme } from '@nyra/design'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { DesignPicker, shortRoot, tildePath } from '@renderer/components/design/DesignPicker'
import { formatRemaining, OpeningCard, remainingSeconds, UpgradeBanner } from '@renderer/components/design/DesignNotices'
import SystemTab, { skillFolder, systemTabLabel, type SystemNames } from '@renderer/components/design/SystemTab'
import PanelTabStrip from '@renderer/components/panelTabs/PanelTabStrip'
import { tabKey, type DesignPanelTab } from '@renderer/store/panelTabs'
import type { DesignComment } from '@renderer/lib/designComments'
import DesignCanvas from '@renderer/components/design/DesignCanvas'
import type { DesignEntry, SystemEntry } from '@renderer/lib/api-types'
import { setPlatformForTest } from '@renderer/lib/platform'
import { primeHomedir } from '@renderer/lib/homedir'

/** Every icon control here has a real tooltip, and Radix needs the provider App
 *  mounts at the root. */
const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> => rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

afterEach(() => setPlatformForTest(null))

const system = (over: Partial<SystemEntry> = {}): SystemEntry => ({
  id: 's_1',
  name: 'Closeup',
  root: '/Users/me/dev/ts/closeup/design',
  project: '/Users/me/dev/ts/closeup',
  updatedAt: '',
  previousRoots: [],
  projectSkill: false,
  ...over
})

const draft = (id: string, name: string): DesignEntry =>
  ({ id, name, path: `/Users/me/.nyra/designs/files/${id}.nyui.json` }) as DesignEntry

describe('paths in the system header', () => {
  it('says the home directory as ~', () => {
    setPlatformForTest('mac')
    expect(tildePath('/Users/me/dev/ts/closeup/design', '/Users/me')).toBe('~/dev/ts/closeup/design')
    expect(tildePath('/Users/me', '/Users/me')).toBe('~')
    // A sibling that only shares the prefix is not under home.
    expect(tildePath('/Users/meg/x', '/Users/me')).toBe('/Users/meg/x')
    // Home not known yet: the path as it is.
    expect(tildePath('/Users/me/x', '')).toBe('/Users/me/x')
  })

  it('keeps a Windows path in its own separator', () => {
    setPlatformForTest('windows')
    expect(tildePath('C:\\Users\\me\\dev\\closeup', 'C:\\Users\\me')).toBe('~\\dev\\closeup')
  })

  it('names a repo system by its project and a Nyra one by its folder', () => {
    setPlatformForTest('mac')
    expect(shortRoot(system(), '/Users/me')).toBe('closeup/design')
    expect(shortRoot(system({ root: '/Users/me/dev/ts/closeup' }), '/Users/me')).toBe('closeup')
    expect(shortRoot(system({ root: '/Users/me/.nyra/designs/systems/closeup-s_1' }), '/Users/me')).toBe(
      '~/.nyra/designs/systems/closeup-s_1'
    )
  })
})

describe('DesignPicker', () => {
  const open = async (props: Partial<React.ComponentProps<typeof DesignPicker>> = {}): Promise<{ onDraft: ReturnType<typeof vi.fn> }> => {
    setPlatformForTest('mac')
    const onDraft = vi.fn()
    render(
      <DesignPicker
        label="Closeup"
        size="title"
        systems={[system()]}
        drafts={[draft('d_1', 'Export dialog'), draft('d_2', 'Onboarding sketch')]}
        current="s_1"
        onSystem={vi.fn()}
        onDraft={onDraft}
        {...props}
      />
    )
    await userEvent.click(screen.getByLabelText('Pick a design or design system'))
    return { onDraft }
  }

  it('lists systems and drafts with a second line each', async () => {
    await open({ componentCounts: { s_1: 32 } })
    expect(await screen.findByPlaceholderText('Find a system or design')).toBeInTheDocument()
    expect(screen.getByText('Design system')).toBeInTheDocument()
    expect(screen.getByText('Drafts in this project')).toBeInTheDocument()
    expect(screen.getByText(/closeup\/design · 32 components/)).toBeInTheDocument()
    expect(screen.getAllByText('Single file · built-in theme')).toHaveLength(2)
  })

  it('leaves the count out when the system is not loaded', async () => {
    await open()
    expect(await screen.findByText('closeup/design')).toBeInTheDocument()
    expect(screen.queryByText(/· \d+ component/)).not.toBeInTheDocument()
  })

  it('filters as you type, and Enter opens the first match', async () => {
    const { onDraft } = await open()
    const input = await screen.findByPlaceholderText('Find a system or design')
    await userEvent.type(input, 'onboard')
    expect(screen.queryByText('Export dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Closeup', { selector: 'span.font-\\[550\\]' })).not.toBeInTheDocument()
    expect(screen.getByText('Onboarding sketch')).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(onDraft).toHaveBeenCalledWith('d_2')
  })

  it('says when nothing matches', async () => {
    await open()
    await userEvent.type(await screen.findByPlaceholderText('Find a system or design'), 'zzz')
    expect(screen.getByText('Nothing matches “zzz”.')).toBeInTheDocument()
  })
})

describe('the system tab label', () => {
  const names: SystemNames = { systems: { s_1: 'Closeup' }, files: { s_1: { 'screens/editor-shell.nyui.json': 'Editor shell' } } }

  it('is the system on the overview and the file on the canvas', () => {
    expect(systemTabLabel({ systemId: 's_1', view: 'overview' }, names)).toBe('Closeup · system')
    expect(systemTabLabel({ systemId: 's_1' }, names)).toBe('Closeup · system')
    expect(systemTabLabel({ systemId: 's_1', view: 'canvas', file: 'screens/editor-shell.nyui.json' }, names)).toBe(
      'Editor shell'
    )
  })

  it('falls back without asking anyone', () => {
    const none: SystemNames = { systems: {}, files: {} }
    expect(systemTabLabel({ systemId: 's_2', view: 'overview' }, none)).toBe('Design system')
    expect(systemTabLabel({ systemId: 's_2', view: 'canvas', file: 'components/button.nyui.json' }, none)).toBe('button')
  })

  it('names the repo skill folder the way Rust does', () => {
    expect(skillFolder('Closeup')).toBe('closeup-design-system')
    expect(skillFolder('  My  Design—System! ')).toBe('my-design-system-design-system')
    expect(skillFolder('—')).toBe('system-design-system')
  })
})

describe('opening a large design', () => {
  it('estimates the time left only once there is a rate', () => {
    expect(remainingSeconds({ at: 0, loaded: 0 }, { at: 100, loaded: 1_000 }, 10_000)).toBeNull()
    expect(remainingSeconds({ at: 0, loaded: 0 }, { at: 1000, loaded: 0 }, 10_000)).toBeNull()
    // 4 MB a second, 8 MB to go.
    expect(remainingSeconds({ at: 0, loaded: 0 }, { at: 1000, loaded: 4e6 }, 12e6)).toBeCloseTo(2)
  })

  it('says it the way the card does', () => {
    expect(formatRemaining(2.2)).toBe('about 2 s')
    expect(formatRemaining(0.2)).toBe('about 1 s')
    expect(formatRemaining(180)).toBe('about 3 min')
  })

  it('shows the read and the steps', () => {
    render(<OpeningCard fileName="editor-shell.nyui.json" phase={{ phase: 'reading', loaded: 12.4 * 1024 * 1024, total: 40 * 1024 * 1024 }} onCancel={vi.fn()} />)
    expect(screen.getByText('Opening editor-shell.nyui.json')).toBeInTheDocument()
    expect(screen.getByText(/^Reading 12\.4 MB of 40 MB$/)).toBeInTheDocument()
    expect(screen.getByLabelText('Stop opening')).toBeInTheDocument()
    // One reading is not a rate.
    expect(screen.queryByText(/^about/)).not.toBeInTheDocument()
  })
})

describe('the older-format banner', () => {
  it('offers both choices', async () => {
    const onUpgrade = vi.fn()
    const onDismiss = vi.fn()
    render(<UpgradeBanner busy={false} error={null} label="Upgrade system" onUpgrade={onUpgrade} onDismiss={onDismiss} />)
    expect(screen.getByText('Older format.')).toHaveClass('font-semibold')
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade system' }))
    expect(onDismiss).toHaveBeenCalled()
    expect(onUpgrade).toHaveBeenCalled()
  })
})

describe('the canvas zoom control', () => {
  it('is a floating pill with real tooltips and no keyboard hint', async () => {
    render(<DesignCanvas artboards={[]} theme={defaultTheme} selected={[]} onSelect={vi.fn()} />)
    expect(screen.getByText('100%')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('125%')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fit' })).toBeInTheDocument()
    expect(screen.queryByText(/scroll to/)).not.toBeInTheDocument()
  })
})

describe('the estimate on the opening card', () => {
  it('appears once the read has a rate', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const MB = 1024 * 1024
    const { rerender } = render(
      <OpeningCard fileName="big.nyui.json" phase={{ phase: 'reading', loaded: 1 * MB, total: 13 * MB }} onCancel={vi.fn()} />
    )
    now = 1000
    rerender(
      <TooltipProvider>
        <OpeningCard fileName="big.nyui.json" phase={{ phase: 'reading', loaded: 5 * MB, total: 13 * MB }} onCancel={vi.fn()} />
      </TooltipProvider>
    )
    // 4 MB a second, 8 MB to go.
    expect(await screen.findByText('about 2 s')).toBeInTheDocument()
    vi.restoreAllMocks()
  })
})

describe('the system header', () => {
  afterEach(() => vi.restoreAllMocks())
  const home = { root: '/home/test/dev/ts/closeup/design', project: '/home/test/dev/ts/closeup' }
  const comment = (id: string, status: 'open' | 'resolved'): DesignComment =>
    ({ id, n: 1, text: '', status, createdAt: '', file: '', rel: 'screens/a.nyui.json', artboardId: 'a', artboardName: 'A' }) as DesignComment

  it('counts open comments, keeps the mode switch, and names the tab', async () => {
    setPlatformForTest('mac')
    await primeHomedir()
    vi.spyOn(window.api.designSystem, 'list').mockResolvedValue([system(home)])
    const listComments = vi
      .spyOn(window.api.comments, 'list')
      .mockResolvedValue({ ok: true, comments: [comment('c1', 'open'), comment('c2', 'open'), comment('c3', 'resolved')] })

    const tab: DesignPanelTab = { kind: 'design', id: 't1', designId: null, artboardId: null, systemId: 's_1', view: 'overview' }
    render(
      <>
        <PanelTabStrip
          tabs={[tab]}
          activeKey={tabKey(tab)}
          browserTabs={[]}
          browserPhase="off"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onPin={vi.fn()}
          onReorder={vi.fn()}
          onNew={vi.fn()}
        />
        <SystemTab sessionId="chat-1" tab={tab} />
      </>
    )

    expect(await screen.findByRole('button', { name: 'Comments: 2 open' })).toBeInTheDocument()
    expect(listComments).toHaveBeenCalledWith('sys:s_1')
    expect(await screen.findByText('Closeup · system')).toBeInTheDocument()
    expect(screen.getByText('~/dev/ts/closeup/design', { selector: 'span' })).toHaveAttribute('title', home.root)

    // No tokens loaded: light is on, and dark is there but says why it is not.
    const modes = screen.getByRole('tablist', { name: 'Mode' })
    const tabs = within(modes).getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-disabled', 'true')
  })

  it('hides the comments button when nothing is open', async () => {
    vi.spyOn(window.api.designSystem, 'list').mockResolvedValue([system()])
    const tab: DesignPanelTab = { kind: 'design', id: 't2', designId: null, artboardId: null, systemId: 's_1', view: 'overview' }
    render(<SystemTab sessionId="chat-1" tab={tab} />)
    expect(await screen.findByLabelText('Design system options')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Comments/ })).not.toBeInTheDocument()
  })
})
