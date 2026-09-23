import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SessionRecap from '../../renderer/src/components/SessionRecap'
import { TooltipProvider } from '../../renderer/src/components/ui/tooltip'
import { useSessionsStore, type Message, type Session } from '../../renderer/src/store/sessions'
import { useSettingsStore } from '../../renderer/src/store/settings'

const T0 = 1_700_000_000_000

function seed(partial: Partial<Session>): Session {
  const s: Session = {
    id: 's1',
    claudeSessionId: null,
    title: 'Test',
    cwd: '/tmp',
    createdAt: T0,
    messages: [],
    tasks: [],
    agents: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ...partial
  }
  useSessionsStore.setState({ sessions: [s], activeSessionId: 's1' })
  return s
}

const msg = (id: string, ts: number, extra: Partial<Message> = {}): Message =>
  ({ id, role: 'assistant', text: 'ok', timestamp: ts, ...extra }) as Message

function draw(props: Partial<React.ComponentProps<typeof SessionRecap>> = {}) {
  return render(
    <TooltipProvider>
      <SessionRecap
        sessionId="s1"
        onSummarise={props.onSummarise ?? vi.fn()}
        onJump={props.onJump ?? vi.fn()}
        isOnScreen={props.isOnScreen ?? (() => false)}
      />
    </TooltipProvider>
  )
}

describe('SessionRecap', () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null })
    useSettingsStore.setState({ awayRecap: true })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(T0 + 12 * 60_000)
  })

  it('draws nothing when there is no away window', () => {
    seed({ messages: [msg('a', T0)] })
    const { container } = draw()
    expect(container).toBeEmptyDOMElement()
  })

  it('says how long and how many turns', () => {
    seed({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 4,
      messages: [msg('a', T0 + 10)],
      tasks: [
        { taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }
      ]
    })
    draw()
    expect(screen.getByText(/12 min · 4 turns/)).toBeInTheDocument()
  })

  it('prices the paid button on the button itself', () => {
    seed({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 1,
      messages: [msg('a', T0 + 10)],
      tasks: [
        { taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }
      ]
    })
    draw()
    const paid = screen.getByRole('button', { name: /Ask Claude to summarise/ })
    expect(paid).toHaveTextContent('1 turn')
    // The free half must not claim a price anywhere else on the card.
    expect(screen.queryByText(/costs a turn/)).toBeNull()
  })

  it('lists the biggest files and counts the rest', () => {
    seed({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 1,
      messages: [
        msg('a', T0 + 10, {
          changes: {
            base: 'abc1234',
            files: [
              { path: 'a.ts', insertions: 100, deletions: 1 },
              { path: 'b.ts', insertions: 50, deletions: 0 },
              { path: 'c.ts', insertions: 20, deletions: 0 },
              { path: 'd.ts', insertions: 5, deletions: 0 },
              { path: 'e.ts', insertions: 1, deletions: 0 }
            ]
          }
        })
      ]
    })
    draw()
    expect(screen.getByText('5 files changed')).toBeInTheDocument()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.queryByText('e.ts')).toBeNull()
    expect(screen.getByText('and 2 more')).toBeInTheDocument()
  })

  it('dismissing clears the window so it does not come back', async () => {
    const user = userEvent.setup()
    seed({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 1,
      messages: [msg('a', T0 + 10)],
      tasks: [
        { taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }
      ]
    })
    draw()
    await user.click(screen.getByLabelText('Dismiss recap'))
    expect(useSessionsStore.getState().sessions[0].away).toBeNull()
  })

  it('jumps to the first message you missed', async () => {
    const user = userEvent.setup()
    const onJump = vi.fn()
    seed({
      away: { since: T0 + 5, turnsAtLeave: 0 },
      turns: 1,
      messages: [msg('seen', T0), msg('missed', T0 + 10)],
      tasks: [
        { taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }
      ]
    })
    draw({ onJump })
    await user.click(screen.getByText('Jump to where you left off'))
    expect(onJump).toHaveBeenCalledWith('missed')
  })

  it('offers no jump when the first missed message is already in view', () => {
    seed({
      away: { since: T0 + 5, turnsAtLeave: 0 },
      turns: 1,
      messages: [msg('seen', T0), msg('missed', T0 + 10)],
      tasks: [
        { taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }
      ]
    })
    draw({ isOnScreen: (id) => id === 'missed' })
    expect(screen.queryByText('Jump to where you left off')).toBeNull()
  })

  it('draws nothing when the recap is switched off in Settings', () => {
    useSettingsStore.setState({ awayRecap: false })
    seed({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 1,
      messages: [msg('a', T0 + 10)],
      tasks: [
        { taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' }
      ]
    })
    const { container } = draw()
    expect(container).toBeEmptyDOMElement()
  })

  it('reports a partly-done checklist as partly done', () => {
    seed({
      away: { since: T0, turnsAtLeave: 0 },
      turns: 1,
      messages: [msg('a', T0 + 10)],
      tasks: [
        { taskId: '1', subject: 'x', description: '', status: 'completed', createdByToolId: 't' },
        { taskId: '2', subject: 'y', description: '', status: 'pending', createdByToolId: 't' }
      ]
    })
    draw()
    expect(screen.getByText(/Checklist left partly done — 1 of 2 tasks done/)).toBeInTheDocument()
  })
})
