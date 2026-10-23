import React from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  ListChecks,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Shield,
  ShieldCheck,
  Slash,
  Square,
  TriangleAlert,
  ArrowRightLeft
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Slider } from './ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useSettingsStore } from '../store/settings'
import { useChatSettings } from '../hooks/useChatSettings'
import { BUILT_IN_COMMANDS } from '../data/commands'
import DictationButton from './DictationButton'
import { ComposerPrPills } from './PullRequestChips'
import { ComposerPortPills } from './PortChips'
import { ComposerMonitorPills } from './MonitorChips'
import { chatModelLabel, modelChoices, selectedChoice } from '../lib/models'
import { useModelVersions } from '../store/modelVersions'
import { runCommand } from '../commands/registry'
import { CommandKbd } from './ui/kbd'
import { useSessionsStore, activeSession as activeSessionSelector, configDirForSession } from '../store/sessions'
import { codexModel, useCodexModelsFor, type CodexModel } from '../store/codexModels'
import { useCapabilities } from '../hooks/useCapabilities'
import { planHandoff } from '../lib/handoff'
import { PROVIDER_LABEL } from '../lib/providers'
import type { Effort } from '@shared/types'
import { contextFill } from '../lib/contextFill'

type EffortStop = { value: string; label: string }

/** Claude's scale, whatever the model. Its default is `high`, stored as ''. */
const CLAUDE_EFFORTS: EffortStop[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  ...Object.fromEntries(CLAUDE_EFFORTS.map((e) => [e.value, e.label])),
  ultra: 'Ultra'
}

/** A Codex model's own scale, as `model/list` reports it. */
function codexEfforts(model: CodexModel | undefined): EffortStop[] {
  const values = model?.efforts.length ? model.efforts : ['low', 'medium', 'high']
  return values.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value }))
}

/**
 * Footer-left: attachments, plan mode, the slash commands, and the two things
 * the conversation's own header used to carry, behind one `+`.
 *
 * Find and Copy arrive as commands rather than props: both are already in the
 * registry with a chord apiece, so the menu runs them by id and shows the live
 * keycap instead of threading two callbacks down from Chat.
 */
function AddMenu({
  onPickFiles,
  onInsert
}: {
  onPickFiles: () => void
  onInsert: (command: string) => void
}): React.JSX.Element {
  const { planMode, update } = useChatSettings()
  const caps = useCapabilities()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Add"
        /* -ml-1.5 is the button's own optical inset: its box starts at the
           composer's padding, but the glyph inside starts six pixels further in
           again, so the + sat a visible step right of the text above it. The
           box keeps its hit area and hover; only where it is drawn changes. */
        className="-ml-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-foreground/[0.07] hover:text-foreground aria-expanded:bg-foreground/[0.10] aria-expanded:text-foreground"
      >
        <Plus className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        <DropdownMenuItem onSelect={onPickFiles}>
          <Paperclip />
          Attach files…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* A plain item rather than a checkbox one. The checkbox variant keeps
            pr-8 free for an absolutely-positioned tick, which pushed this row's
            keycap 24px left of every other row's and put a step in the column.
            The state is carried by the icon instead — lit when plan mode is on
            — and the composer's own pill says so too, next to this button. */}
        {caps.planMode && (
          <>
            <DropdownMenuItem onSelect={() => update({ planMode: !planMode })}>
              <ListChecks className={planMode ? 'text-info' : undefined} />
              Plan mode
              <CommandKbd id="chat.planMode" className="ml-auto" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {/* Claude's commands; a chat on another CLI has none of them to run. */}
        {caps.cliCommands && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Slash />
              Commands
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
              {BUILT_IN_COMMANDS.map((cmd) => (
                <DropdownMenuItem key={cmd.name} onSelect={() => onInsert(cmd.name)}>
                  <span className="font-mono">{cmd.name}</span>
                  <span className="ml-auto truncate pl-3 text-muted-foreground">
                    {cmd.description}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => runCommand('search.inSession')}>
          <Search />
          Find in conversation
          <CommandKbd id="search.inSession" className="ml-auto" />
        </DropdownMenuItem>
        {/* Every other pair of neighbours in this menu has a rule between them;
            these two were the only ones sharing a group, which read as an
            oversight rather than as a grouping. */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => runCommand('session.copy')}>
          <ClipboardCopy />
          Copy as markdown
          <CommandKbd id="session.copy" className="ml-auto" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * How full the context is, once that starts to matter.
 *
 * Silent below 70%, because until then it is a number nobody needs and the
 * strip has better uses for the room. It read from the conversation's header
 * before that bar was removed; it reads the session directly now, which is one
 * fewer prop threaded through two components for a chip that shows up twice a
 * week. The Usage menu in the rail carries the same figure in full.
 */
function ContextWarning(): React.JSX.Element | null {
  const session = useSessionsStore(activeSessionSelector)
  const fill = contextFill(session)
  if (!fill) return null

  const { tokens: total, window, pct } = fill
  if (pct < 70) return null

  const fmt = (n: number): string => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n))
  const critical = pct >= 90

  return (
    <Tooltip>
      <TooltipTrigger
        className={`mr-1 flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] ${
          critical
            ? 'border-danger/40 bg-danger/10 text-danger'
            : 'border-warning/40 bg-warning/10 text-warning'
        }`}
      >
        <TriangleAlert className="size-3" />
        {fmt(total)}/{fmt(window)}
      </TooltipTrigger>
      <TooltipContent>{`Context ${Math.round(pct)}% full`}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A chat about to move to another CLI, said before the message that moves it.
 *
 * What the new CLI has not seen goes with that message, and it costs tokens,
 * so the cost is on the pill and what will happen is in its tooltip: the prose
 * as it is, or a summary the CLI handing over writes first.
 */
function HandoffNotice(): React.JSX.Element | null {
  const session = useSessionsStore(activeSessionSelector)
  const plan = React.useMemo(
    () => (session ? planHandoff(session) : null),
    // What the plan reads; a new draft or a usage update is not a reason to redo it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.messages, session?.provider, session?.providerSeenThrough, session?.providerSessionIds]
  )
  if (!session || !plan || plan.kind === 'none' || !plan.from) return null

  const to = PROVIDER_LABEL[session.provider]
  const from = PROVIDER_LABEL[plan.from]
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
  const detail =
    plan.kind === 'summary'
      ? `${to} hasn't seen the last ${plan.missed} messages — about ${fmt(plan.tokens)} tokens as text. ${from} summarises them first, and ${to} gets the summary and the last exchange with your next message.`
      : `${to} hasn't seen the last ${plan.missed} messages. They go with your next message as they are — about ${fmt(plan.tokens)} tokens.`

  return (
    <Tooltip>
      <TooltipTrigger className="mr-1 flex shrink-0 items-center gap-1 rounded-md border border-info/40 bg-info/10 px-2 py-0.5 font-mono text-[11px] text-info">
        <ArrowRightLeft className="size-3" />
        {plan.kind === 'summary' ? `${from} summary` : `~${fmt(plan.tokens)}`}
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{detail}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Footer-left, next to `+`: who approves tool calls.
 *
 * Wide enough to carry a line of explanation under each label, because the
 * difference between the two is consequential and the labels alone do not say
 * what it is.
 */
function ApprovalMenu({ tight }: { tight: boolean }): React.JSX.Element {
  const skipPermissions = useSettingsStore((s) => s.skipPermissions)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const Icon = skipPermissions ? ShieldCheck : Shield
  const label = skipPermissions ? 'Approve for me' : 'Ask for approval'

  const options = [
    {
      value: 'ask' as const,
      icon: Shield,
      label: 'Ask for approval',
      blurb: 'Every tool call waits for you to allow it'
    },
    {
      value: 'auto' as const,
      icon: ShieldCheck,
      label: 'Approve for me',
      blurb: 'Tools run without prompting, including edits and commands'
    }
  ]

  return (
    <DropdownMenu>
      {/* Icon-only below `tight`, and an icon-only control gets a real tooltip —
          this trigger had none at all, because it always carried its own label. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label={label}
            className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground aria-expanded:bg-foreground/[0.10] aria-expanded:text-foreground ${
              tight ? 'w-7 justify-center' : 'px-2'
            }`}
          >
            <Icon className="size-3.5 shrink-0" />
            {!tight && label}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" className="w-96">
        <DropdownMenuLabel>How should tool calls be approved?</DropdownMenuLabel>
        {options.map((opt) => {
          const active = (skipPermissions ? 'auto' : 'ask') === opt.value
          return (
            <DropdownMenuItem
              key={opt.value}
              onSelect={() => updateSettings({ skipPermissions: opt.value === 'auto' })}
              className="items-start gap-2.5 py-2"
            >
              <opt.icon className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-foreground">{opt.label}</span>
                <span className="block text-muted-foreground">{opt.blurb}</span>
              </span>
              {active && <Check className="mt-0.5 size-3.5 shrink-0" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Shown only while plan mode is on, so the state is never silent. */
function PlanModePill({ tight }: { tight: boolean }): React.JSX.Element | null {
  const { planMode, update } = useChatSettings()
  const caps = useCapabilities()
  if (!planMode || !caps.planMode) return null
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={() => update({ planMode: false })}
        aria-label="Plan mode on"
        className={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-info/10 text-xs text-info transition-colors hover:bg-info/20 ${
          tight ? 'w-7 justify-center' : 'px-2'
        }`}
      >
        <ListChecks className="size-3.5 shrink-0" />
        {!tight && 'Plan mode on'}
      </TooltipTrigger>
      <TooltipContent>Turn plan mode off</TooltipContent>
    </Tooltip>
  )
}

function ModelSection({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{children}</p>
}

function ModelRow({
  label,
  blurb,
  active,
  onClick
}: {
  label: string
  blurb: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-foreground/[0.07]"
    >
      {/* A name now rather than an identifier — "Opus 5.5", not `opus` — so it
          is set proportional like one. */}
      <span className="shrink-0 text-foreground">{label}</span>
      <span className="min-w-0 truncate text-muted-foreground" title={blurb}>
        {blurb}
      </span>
      {active && <Check className="ml-auto size-3.5 shrink-0 text-foreground" />}
    </button>
  )
}

/**
 * Footer-right: model and effort behind one trigger, two pages deep.
 *
 * The composer pill reads "<model> <effort>". Opening it lands on the effort
 * page: the current effort over the current model, centred, with a slider under
 * them and no scale labels — the slider's value *is* the heading, which is what
 * makes moving it feel like it is setting the thing you are reading.
 *
 * That heading is itself a button. Clicking it goes to the model list, which is
 * a plain checklist. So both live behind one trigger without a submenu.
 */
function ModelEffort(): React.JSX.Element {
  const { provider, model, effort, update } = useChatSettings()
  const versions = useModelVersions()
  const running = useSessionsStore((s) => activeSessionSelector(s)?.resolvedModel)
  // The models of this chat's workspace's Codex account.
  const configDir = useSessionsStore((s) => configDirForSession(s, s.activeSessionId))
  const codex = useCodexModelsFor(configDir)
  const [page, setPage] = React.useState<'effort' | 'model'>('effort')
  const [custom, setCustom] = React.useState('')

  // Codex only starts when something needs its list: the picker opening, or a
  // chat already on it that wants its model's name on the pill.
  React.useEffect(() => {
    if (provider === 'codex') codex.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is new each render and idempotent
  }, [provider, configDir])

  const onCodex = provider === 'codex'
  const runningCodex = onCodex ? codexModel(codex.models, model) : undefined

  // The number on the pill is the one the CLI reported, so it reads "Opus 5.5"
  // today and whatever is true after the next release without an edit here.
  //
  // An empty stored value is still "CLI default", but it is no longer treated
  // as a synonym for `opus`: they resolve to different models. This read
  // `model || 'opus'` while the session it described was running on the older
  // one, which is the whole reason any of this is on screen.
  const shownModel = onCodex
    ? (runningCodex?.displayName ?? (model || 'Codex'))
    : chatModelLabel(model, running, versions)
  const choices = modelChoices(versions)
  const selected = onCodex ? null : selectedChoice(model, choices, versions)

  // Each CLI's own scale. Its default is stored as '', so a chat left alone
  // follows whatever the CLI decides the default is.
  const efforts = onCodex ? codexEfforts(runningCodex) : CLAUDE_EFFORTS
  const defaultEffort = onCodex ? (runningCodex?.defaultEffort ?? 'medium') : 'high'
  const shownEffort = effort || defaultEffort
  const effortIndex = Math.max(0, efforts.findIndex((e) => e.value === shownEffort))
  const isDefault = !model && !effort

  const setEffort = (index: number): void => {
    const next = efforts[Math.min(efforts.length - 1, Math.max(0, index))].value
    update({ effort: (next === defaultEffort ? '' : next) as Effort })
  }

  // An effort the new model has no stop for goes back to that model's default.
  const keptEffort = (stops: EffortStop[]): Effort => (stops.some((e) => e.value === effort) ? effort : '')

  const pickClaude = (value: string): void => {
    update({ provider: 'claude', model: value, effort: keptEffort(CLAUDE_EFFORTS) })
    setPage('effort')
  }
  // Headed by CLI only once there is a second one to tell apart.
  const sections = codex.status === 'ready' || codex.status === 'loading'

  const pickCodex = (m: CodexModel): void => {
    update({ provider: 'codex', model: m.id, effort: keptEffort(codexEfforts(m)) })
    setPage('effort')
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) codex.load()
        else setPage('effort')
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger
            aria-label="Model and effort"
            className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors hover:bg-foreground/[0.07] aria-expanded:bg-accent"
          >
            <span className="font-medium text-foreground">{shownModel}</span>
            <span className="text-muted-foreground">{efforts[effortIndex].label}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Model and effort</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" side="top" className="w-72 p-2">
        {page === 'effort' ? (
          <>
            {/* A three-column grid so the heading sits on the centre line while
                still shrink-wrapping its own text, without a fake left spacer. */}
            <div className="grid grid-cols-[1fr_auto_1fr] items-center">
              <span />
              <div className="flex min-w-0 justify-center">
                <button
                  onClick={() => setPage('model')}
                  className="min-w-0 rounded-md px-2 py-0.5 text-center transition-colors hover:bg-foreground/[0.07]"
                >
                  <span className="flex items-center justify-center gap-0.5 text-sm font-medium text-info">
                    {efforts[effortIndex].label}
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{shownModel}</span>
                </button>
              </div>
              <Tooltip>
                <TooltipTrigger
                  onClick={() => update({ model: '', effort: '' })}
                  disabled={isDefault}
                  aria-label="Reset to default"
                  className="size-6 justify-self-end rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground disabled:opacity-30"
                >
                  <RotateCcw className="size-4" />
                </TooltipTrigger>
                <TooltipContent>Reset to default</TooltipContent>
              </Tooltip>
            </div>

            {/* Restyled through the data-slot hooks rather than by editing the
                generated component, so `shadcn add` stays safe to rerun. Two
                things needed fixing: the default track is 1px of --muted on a
                --popover ground, invisible here; and the range's own `h-full`
                sits behind a `data-horizontal:` variant the primitive never sets
                on that element, so the fill rendered 0px tall and simply did not
                appear. */}
            <div className="relative mt-2 px-1 pb-0.5">
              <Slider
                className="[&_[data-slot=slider-range]]:h-full [&_[data-slot=slider-range]]:bg-info [&_[data-slot=slider-thumb]]:size-7 [&_[data-slot=slider-thumb]]:rounded-full [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-track]]:h-5 [&_[data-slot=slider-track]]:rounded-full [&_[data-slot=slider-track]]:bg-accent"
                value={[effortIndex]}
                min={0}
                max={efforts.length - 1}
                step={1}
                onValueChange={([v]) => setEffort(v)}
                aria-label="Reasoning effort"
              />
              {/* A tick per stop, so the scale reads as discrete rather than continuous. */}
              <div className="pointer-events-none absolute inset-x-1 top-1/2 flex -translate-y-1/2 justify-between px-3">
                {efforts.map((e) => (
                  <span key={e.value} className="size-1 rounded-full bg-background/50" />
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1 pb-1">
              <button
                onClick={() => setPage('effort')}
                aria-label="Back to effort"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-xs text-muted-foreground">Select model</span>
            </div>
            {/* The account's own list once a chat has reported it — every
                Opus it is offered, not only whichever one `opus` resolves to.
                Scrolls, because that list runs to a dozen rows. */}
            <div className="max-h-72 overflow-y-auto">
              {sections && <ModelSection>Claude</ModelSection>}
              {choices.map((c) => (
                // The value, not ''. Picking opus used to store "no --model",
                // which hands the choice to the CLI's own default — a pinned
                // older Opus — so the one row that claimed to select the latest
                // was the only one that could not.
                <ModelRow
                  key={c.value}
                  label={c.label}
                  blurb={c.blurb}
                  active={selected === c.value}
                  onClick={() => pickClaude(c.value)}
                />
              ))}
              {codex.status === 'loading' && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Asking Codex for its models…</p>
              )}
              {codex.status === 'ready' && codex.models.length > 0 && (
                <>
                  <ModelSection>Codex</ModelSection>
                  {codex.models.map((m) => (
                    <ModelRow
                      key={m.id}
                      label={m.displayName ?? m.id}
                      blurb={m.description ?? ''}
                      active={onCodex && runningCodex?.id === m.id}
                      onClick={() => pickCodex(m)}
                    />
                  ))}
                </>
              )}
            </div>
            {/* Anything else the CLI will take: another alias, or a pinned full
                name like claude-fable-5-1 when "latest" is not what you want. */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const value = custom.trim()
                if (!value) return
                update({ model: value })
                setCustom('')
                setPage('effort')
              }}
              className="mt-1 border-t border-border/55 pt-2"
            >
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Or type a model name…"
                spellCheck={false}
                className="h-7 w-full rounded-md border border-input bg-input/20 px-2 font-mono text-xs outline-none transition-colors placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30"
              />
            </form>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Below this, the bar has no room for a second pill.
 *
 * Measured rather than assumed: the chat column is as narrow as the right panel
 * leaves it, and at 334 px a second PR pill pushed the send button off the end
 * of the bar entirely. The fixed controls — add, approval, model, send — come to
 * about 220 px, so this is roughly "one pill's worth of slack left over".
 */
const COMPACT_BELOW = 520

/**
 * Below this, the labels go too.
 *
 * With the side panel open the bar gets narrow enough that "Approve for me"
 * wrapped onto two lines and "Plan mode on" onto three, which grew the composer
 * downward and shoved the send button into an ellipse. Dropping the two text
 * labels to their icons buys about 150 px and is reversible by widening; the
 * tooltips say what they were.
 */
const LABELS_BELOW = 400

export default function ComposerBar({
  isLoading,
  canSend,
  onPickFiles,
  onInsert,
  onSend,
  onStop
}: {
  isLoading: boolean
  canSend: boolean
  onPickFiles: () => void
  onInsert: (command: string) => void
  onSend: () => void
  onStop?: () => void
}): React.JSX.Element {
  const barRef = React.useRef<HTMLDivElement>(null)
  // The measured width rather than a boolean, now that two thresholds read it.
  const [width, setWidth] = React.useState(Number.POSITIVE_INFINITY)
  const compact = width < COMPACT_BELOW
  const tight = width < LABELS_BELOW

  React.useEffect(() => {
    const el = barRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={barRef} className="composer-strip flex items-center gap-1">
      <AddMenu onPickFiles={onPickFiles} onInsert={onInsert} />
      <DictationButton tight={tight} />
      <ApprovalMenu tight={tight} />
      <PlanModePill tight={tight} />
      {/* What this conversation has out in the world: the PRs it opened, and
          the ports it is serving. Left of the spacer with the rest of the
          turn's state, rather than right, so they never crowd the send button
          or shuffle the model pill around as they appear. */}
      <ComposerPrPills compact={compact} />
      <ComposerPortPills compact={compact} />
      <ComposerMonitorPills compact={compact} />
      <div className="flex-1" />
      <HandoffNotice />
      <ContextWarning />
      <ModelEffort />
      {isLoading && onStop ? (
        <Tooltip>
          <TooltipTrigger
            onClick={onStop}
            aria-label="Stop"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85"
          >
            {/* The button is already the circle — a CircleStop inside it reads as a
                record dot. Just the square. */}
            <Square className="size-2.5 fill-current" />
          </TooltipTrigger>
          <TooltipContent>Stop</TooltipContent>
        </Tooltip>
      ) : (
        <button
          onClick={onSend}
          disabled={!canSend}
          aria-label={isLoading ? 'Queue message' : 'Send message'}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 disabled:opacity-25"
        >
          <ArrowUp className="size-4" />
        </button>
      )}
    </div>
  )
}
