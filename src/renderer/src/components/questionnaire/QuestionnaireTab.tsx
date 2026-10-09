import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDot,
  FileText,
  LayoutGrid,
  MessageCircleQuestion,
  PanelRightOpen,
  PenLine,
  Sparkles,
  Square,
  SquareCheck,
  X
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import ScaledArtboard from '../design/ScaledArtboard'
import NamedIcon from '../design/NamedIcon'
import type { QuestionnairePanelTab } from '../../store/panelTabs'
import { useSessionsStore } from '../../store/sessions'
import {
  formatAnswers,
  isAnswered,
  isHex,
  progressOf,
  questionsOf,
  sectionsOf,
  sentLabel,
  type Answer,
  type AnswerFile,
  type OptionPreview,
  type Question,
  type QuestionOption,
  type Questionnaire
} from '../../lib/questionnaire'
import { sendToChat } from '../../lib/messageContext'
import { cachedImage, loadImage } from '../../lib/imageCache'
import { basename } from '../../lib/paths'
import { loadDesign, type DesignLoad } from '../../lib/designLoad'
import { openDesignInPanel, splitDesignRef } from '../../lib/openFile'
import { DESIGN_PRIMARY } from '../design/designAccent'

/** How long typing settles before it is saved. Short: a closed tab must keep it. */
const SAVE_MS = 300
/** Below this the section rail folds into a picker. */
const NARROW = 560

/**
 * Claude's questions, answered at your own pace.
 *
 * Every change is saved to the questionnaire's file as it happens, so closing
 * the tab, quitting Nyra or asking Claude to open it again all come back to
 * the same answers. Nothing is sent until Send — and Send works with anything
 * from none to all of them answered: what is left, Claude decides.
 */
export default function QuestionnaireTab({ tab }: { tab: QuestionnairePanelTab }): React.ReactElement {
  const [q, setQ] = useState<Questionnaire | null | undefined>(undefined)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [section, setSection] = useState(0)
  const [sent, setSent] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const box = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const load = useCallback(async () => {
    const next = await window.api.questionnaire.get(tab.questionnaireId)
    setQ(next)
    // A round Claude adds while you are mid-answer arrives here; what you
    // have typed but not yet saved is kept rather than overwritten.
    if (next && !dirty.current) setAnswers(next.answers ?? {})
  }, [tab.questionnaireId])

  useEffect(() => {
    void load()
    return window.api.questionnaire.onChanged(({ id }) => {
      if (id === tab.questionnaireId) void load()
    })
  }, [load, tab.questionnaireId])

  useEffect(() => {
    const node = box.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(node)
    return () => ro.disconnect()
  }, [q === undefined])

  const save = useCallback(
    (next: Record<string, Answer>) => {
      dirty.current = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void window.api.questionnaire.setAnswers(tab.questionnaireId, next).finally(() => {
          dirty.current = false
        })
      }, SAVE_MS)
    },
    [tab.questionnaireId]
  )

  // Leaving with a save pending flushes it: closing the tab must not lose the
  // last keystroke.
  useEffect(
    () => () => {
      if (saveTimer.current && dirty.current) {
        clearTimeout(saveTimer.current)
        void window.api.questionnaire.setAnswers(tab.questionnaireId, latest.current)
      }
    },
    [tab.questionnaireId]
  )
  const latest = useRef(answers)
  latest.current = answers

  const setAnswer = useCallback(
    (id: string, a: Answer | null) => {
      setAnswers((prev) => {
        const next = { ...prev }
        if (a === null) delete next[id]
        else next[id] = a
        save(next)
        return next
      })
    },
    [save]
  )

  const questions = useMemo(() => (q ? questionsOf(q) : []), [q])
  const sections = useMemo(() => sectionsOf(questions), [questions])
  const current = sections[Math.min(section, Math.max(0, sections.length - 1))]
  const live: Questionnaire | null = q ? { ...q, answers } : null
  const { answered, total } = live ? progressOf(live) : { answered: 0, total: 0 }

  // Opened on a question — the first of a round Claude just added — rather
  // than on page one of everything asked before. Once per request: the
  // questionnaire reloads on every save, and that must not pull you back.
  const handled = useRef<number | null>(null)
  useEffect(() => {
    const focus = tab.focus
    if (!focus || handled.current === focus.at || sections.length === 0) return
    const at = sections.findIndex((s) => s.questions.some((x) => x.id === focus.question))
    if (at < 0) return
    handled.current = focus.at
    setSection(at)
    setFlash(focus.question)
  }, [tab.focus, sections])
  useEffect(() => {
    if (!flash) return
    const frame = requestAnimationFrame(() =>
      scroller.current
        ?.querySelector(`[data-question="${CSS.escape(flash)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    )
    const done = setTimeout(() => setFlash(null), 1800)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(done)
    }
  }, [flash])

  const send = useCallback(async () => {
    if (!live) return
    // Save first, so what Claude reads with `answers` matches what was sent.
    if (saveTimer.current) clearTimeout(saveTimer.current)
    await window.api.questionnaire.setAnswers(live.id, answers)
    dirty.current = false
    const sessions = useSessionsStore.getState()
    // Back to the chat that asked; if that chat is gone, to the one on screen.
    const target = sessions.sessions.some((s) => s.id === live.chatId) ? live.chatId : sessions.activeSessionId
    if (!target) return
    sendToChat({
      sessionId: target,
      text: '',
      context: [{ kind: 'questionnaire', label: sentLabel(live), body: formatAnswers(live), ref: { questionnaireId: live.id } }]
    })
    await window.api.questionnaire.markSent(live.id, answered)
    setSent(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  }, [answered, answers, live])

  if (q === undefined) return <div className="p-6 text-xs text-muted-foreground">Loading…</div>
  if (q === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-xs">
        <MessageCircleQuestion className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">These questions are gone</p>
        <p className="max-w-xs text-muted-foreground">Ask Claude to ask again.</p>
      </div>
    )
  }

  const narrow = width > 0 && width < NARROW
  const pct = total ? Math.round((answered / total) * 100) : 0
  const sentBefore = sent ?? (q.sent?.length ? 'earlier' : null)
  const sendLabel = answered === 0 ? 'Let Claude decide' : `Send ${answered} answer${answered === 1 ? '' : 's'}`
  const sendButton = (
    <Button size="sm" className={`h-7 rounded-at-8 px-3 text-[12.5px] font-[550] ${DESIGN_PRIMARY}`} onClick={() => void send()}>
      {sendLabel}
    </Button>
  )

  return (
    <div ref={box} className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-[15px] font-semibold">{q.title || 'Questions from Claude'}</h2>
          <p className="truncate text-[12.5px] text-muted-foreground">
            {total} question{total === 1 ? '' : 's'} from Claude · saved as you go · anything you skip, Claude decides
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[12.5px] font-[550] tabular-nums">
            {answered} of {total}
          </span>
          <span className="h-1 w-24 overflow-hidden rounded-full bg-border">
            <span className="block h-full rounded-full bg-design-accent" style={{ width: `${pct}%` }} />
          </span>
        </div>
        {sendButton}
      </header>
      {sentBefore && (
        <p className="shrink-0 border-b bg-success/10 px-4 py-1.5 text-[12.5px]">
          <Check className="mr-1 inline size-3 text-success" />
          Sent {sentBefore === 'earlier' ? 'before' : `at ${sentBefore}`}. Change anything and send again; Claude gets the latest.
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        {!narrow && sections.length > 1 && (
          <nav className="flex w-[184px] shrink-0 flex-col gap-px overflow-y-auto border-r bg-sidebar p-3">
            {sections.map((s, i) => {
              const done = s.questions.filter((x) => isAnswered(answers[x.id])).length
              const state = i === section ? 'now' : done === s.questions.length ? 'done' : 'todo'
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setSection(i)}
                  className={cn(
                    'flex items-center gap-2 rounded-at-4 px-2 py-1 text-left text-[12.5px]',
                    state === 'now'
                      ? 'bg-design-accent/10 font-[550] text-design-accent'
                      : cn('hover:bg-foreground/5', state === 'done' ? 'text-muted-foreground' : 'text-foreground')
                  )}
                >
                  {state === 'done' ? (
                    <CircleCheck className="size-[13px] shrink-0 text-success" />
                  ) : state === 'now' ? (
                    <CircleDot className="size-[13px] shrink-0 text-design-accent" />
                  ) : (
                    <Circle className="size-[13px] shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="text-[11.5px] font-medium text-muted-foreground tabular-nums">
                    {done}/{s.questions.length}
                  </span>
                </button>
              )
            })}
            <p className="mt-4 text-[11.5px] leading-snug font-medium text-muted-foreground">
              Close this any time. The chip in the chat brings it back, answers and all.
            </p>
          </nav>
        )}
        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex w-full max-w-3xl flex-col gap-4 p-5">
            {sections.length > 1 && (
              <div className="flex items-center justify-between">
                {narrow ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="flex items-center gap-1 text-[18px] font-semibold">
                        {current?.name}
                        <ChevronDown className="size-4 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {sections.map((s, i) => (
                        <DropdownMenuItem key={s.name} onSelect={() => setSection(i)}>
                          {s.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <h3 className="text-[18px] font-semibold">{current?.name}</h3>
                )}
                <span className="text-[12.5px] text-muted-foreground">
                  {current?.questions.filter((x) => isAnswered(answers[x.id])).length} of {current?.questions.length} answered
                </span>
              </div>
            )}
            {current?.questions.map((question) => (
              <QuestionCard
                key={question.id}
                questionnaireId={q.id}
                question={question}
                answer={answers[question.id]}
                flash={flash === question.id}
                onAnswer={(a) => setAnswer(question.id, a)}
              />
            ))}
            {sections.length > 1 && (
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={section === 0}
                  className="h-7 rounded-at-8 px-2 text-[12.5px] font-[550] text-muted-foreground"
                  onClick={() => setSection((n) => n - 1)}
                >
                  ← {sections[section - 1]?.name ?? ''}
                </Button>
                {section < sections.length - 1 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-at-8 border-border-strong px-3 text-[12.5px] font-[550]"
                    onClick={() => setSection((n) => n + 1)}
                  >
                    {sections[section + 1]?.name} →
                  </Button>
                ) : (
                  sendButton
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function QuestionCard({
  questionnaireId,
  question,
  answer,
  flash,
  onAnswer
}: {
  questionnaireId: string
  question: Question
  answer: Answer | undefined
  flash: boolean
  onAnswer: (a: Answer | null) => void
}): React.ReactElement {
  const free = question.kind === 'text' || question.kind === 'files'
  const [ownWords, setOwnWords] = useState(answer?.kind === 'typed' && !free)
  const deciding = answer?.kind === 'decide'
  const exploring = answer?.kind === 'explore'
  const answered = isAnswered(answer)
  // Files are what you have, not a choice: nothing to hand back.
  const handBack = question.kind === 'files' ? false : (question.handBack ?? true)
  const withPreviews = (question.options ?? []).some((o) => o.preview)
  // A preview card has no room for a reason; it goes under the row of them.
  const caption =
    question.kind === 'scale' || question.kind === 'color'
      ? undefined
      : withPreviews
        ? (question.why ?? question.options?.find((o) => o.suggested && o.why)?.why)
        : question.options?.some((o) => o.suggested && o.why)
          ? undefined
          : question.why
  return (
    <section
      data-question={question.id}
      className={cn(
        'flex flex-col gap-3 rounded-at-12 border bg-background p-4 transition-[border-color,box-shadow] focus-within:border-design-accent',
        flash && 'border-design-accent ring-4 ring-design-accent/15'
      )}
    >
      <div className="flex flex-col gap-1">
        {(question.chip || question.kind === 'multi') && (
          <div className="flex items-center gap-2">
            {question.chip && (
              <span className="rounded-at-4 bg-muted px-2 py-px text-[11.5px] font-medium tracking-[0.5px] text-muted-foreground uppercase">
                {question.chip}
              </span>
            )}
            {question.kind === 'multi' && <span className="text-[11.5px] font-medium text-muted-foreground">Pick any</span>}
          </div>
        )}
        <h4 className="text-[15px] font-semibold">{question.question}</h4>
      </div>

      {exploring ? (
        <div className="flex items-center gap-3 rounded-at-8 border border-dashed border-design-accent/40 bg-design-accent/10 p-3 text-[12.5px]">
          <LayoutGrid className="size-4 shrink-0 text-design-accent" />
          <span>Claude will draw a few directions, then ask you to pick between them.</span>
        </div>
      ) : (
        <div className={cn(deciding && 'pointer-events-none opacity-45')}>
          {question.kind === 'files' ? (
            <FilesInput questionnaireId={questionnaireId} question={question} answer={answer} onAnswer={onAnswer} />
          ) : question.kind === 'text' || ownWords ? (
            <textarea
              value={answer?.kind === 'typed' ? answer.text : ''}
              onChange={(e) => onAnswer(e.target.value ? { kind: 'typed', text: e.target.value } : null)}
              placeholder={question.kind === 'text' ? (question.placeholder ?? 'Your answer') : 'In your own words'}
              rows={question.kind === 'text' ? 4 : 3}
              className="w-full resize-y rounded-at-8 border bg-background px-2 py-2 text-[12.5px] leading-[1.5] outline-none focus:border-design-accent focus:ring-1 focus:ring-design-accent"
            />
          ) : question.kind === 'scale' ? (
            <ScaleInput question={question} answer={answer} onAnswer={onAnswer} />
          ) : question.kind === 'color' ? (
            <ColorInput question={question} answer={answer} onAnswer={onAnswer} />
          ) : (
            <Choices question={question} answer={answer} onAnswer={onAnswer} />
          )}
        </div>
      )}
      {caption && <p className="text-[11.5px] font-medium text-muted-foreground">{caption}</p>}

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
        {handBack !== false && (
          <HandBack
            on={deciding}
            icon={Sparkles}
            label={deciding ? 'Claude decides' : 'Decide for me'}
            onClick={() => onAnswer(deciding ? null : { kind: 'decide' })}
          />
        )}
        {handBack === true && (
          <HandBack
            on={exploring}
            icon={LayoutGrid}
            label={exploring ? 'Claude drafts options' : 'Explore options'}
            onClick={() => onAnswer(exploring ? null : { kind: 'explore' })}
          />
        )}
        {!free && (
          <HandBack
            on={ownWords}
            icon={PenLine}
            label="In my own words"
            onClick={() => {
              setOwnWords((v) => !v)
              if (ownWords && answer?.kind === 'typed') onAnswer(null)
            }}
          />
        )}
        <span className="flex-1" />
        {answered && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Check className="size-3 text-success" />
            Saved
          </span>
        )}
      </footer>
    </section>
  )
}

function HandBack({
  on,
  icon: Icon,
  label,
  onClick
}: {
  on: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-full px-2 py-px',
        on ? 'bg-design-accent/10 text-design-accent' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="size-3" />
      {label}
    </button>
  )
}

/** "✦ Suggested · why", on one line: the reason never wraps into a column. */
function Suggested({ why }: { why?: string }): React.ReactElement {
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11.5px] font-medium">
      <Sparkles className="size-[11px] shrink-0 text-design-accent" />
      <span className="shrink-0 text-design-accent">Suggested</span>
      {why && (
        <span className="min-w-0 truncate text-muted-foreground" title={why}>
          · {why}
        </span>
      )}
    </span>
  )
}

function Choices({
  question,
  answer,
  onAnswer
}: {
  question: Question
  answer: Answer | undefined
  onAnswer: (a: Answer | null) => void
}): React.ReactElement {
  const options = question.options ?? []
  const picked = answer?.kind === 'picked' ? answer.labels : []
  const multi = question.kind === 'multi'
  const toggle = (label: string): void => {
    const next = multi ? (picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label]) : picked[0] === label ? [] : [label]
    onAnswer(next.length ? { kind: 'picked', labels: next } : null)
  }
  const withPreviews = options.some((o) => o.preview)
  const drawings = options.some((o) => o.preview && 'artboard' in o.preview)
  // Short labels with no previews and no descriptions read best as chips.
  const chips = multi && !withPreviews && options.every((o) => !o.description && !o.icon && o.label.length <= 24)
  // A palette question also takes a colour of your own.
  const palettes = !multi && withPreviews && options.every((o) => o.preview && ('palette' in o.preview || 'swatch' in o.preview))
  // A few short options sit side by side; anything longer stacks.
  const inRow =
    !withPreviews &&
    options.length <= 4 &&
    options.every((o) => o.label.length <= 24 && (o.description?.length ?? 0) <= 48 && !o.detail && !o.icon)

  if (chips) {
    return (
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = picked.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(o.label)}
              className={cn(
                'flex items-center gap-1 rounded-full border py-1 pr-3 pl-2 text-[12.5px]',
                on ? 'border-design-accent bg-design-accent/10' : 'bg-background hover:bg-muted/60'
              )}
            >
              {on ? <SquareCheck className="size-[13px] text-design-accent" /> : <Square className="size-[13px] text-muted-foreground" />}
              {o.label}
              {o.suggested && <Sparkles className="size-[11px] text-design-accent" />}
            </button>
          )
        })}
      </div>
    )
  }

  if (withPreviews) {
    return (
      <div
        className={cn(drawings ? 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2' : 'flex flex-wrap gap-2')}
        role={multi ? 'group' : 'radiogroup'}
      >
        {options.map((o) => (
          <PreviewOption key={o.label} option={o} on={picked.includes(o.label)} multi={multi} onClick={() => toggle(o.label)} />
        ))}
        {palettes && (
          <CustomColor
            value={answer?.kind === 'value' && typeof answer.value === 'string' ? answer.value : null}
            onPick={(hex) => onAnswer(hex ? { kind: 'value', value: hex } : null)}
          />
        )}
      </div>
    )
  }

  return (
    <div className={cn('flex gap-2', inRow ? 'flex-row' : 'flex-col')} role={multi ? 'group' : 'radiogroup'}>
      {options.map((o) => (
        <ListOption key={o.label} option={o} on={picked.includes(o.label)} multi={multi} grow={inRow} onClick={() => toggle(o.label)} />
      ))}
    </div>
  )
}

function Mark({ multi, on, className }: { multi: boolean; on: boolean; className?: string }): React.ReactElement {
  const Icon = multi ? (on ? SquareCheck : Square) : on ? CircleDot : Circle
  return <Icon className={cn('size-3.5 shrink-0', on ? 'text-design-accent' : 'text-muted-foreground', className)} />
}

/** An option you choose by looking: a palette, a radius, a type size, a drawing. */
function PreviewOption({
  option,
  on,
  multi,
  onClick
}: {
  option: QuestionOption
  on: boolean
  multi: boolean
  onClick: () => void
}): React.ReactElement {
  const drawing = option.preview && 'artboard' in option.preview ? option.preview.artboard : null
  return (
    <div className="relative flex min-w-[120px] flex-1 basis-0">
      <button
        type="button"
        role={multi ? 'checkbox' : 'radio'}
        aria-checked={on}
        onClick={onClick}
        className={cn(
          'flex w-full flex-col gap-2 rounded-at-8 border p-3 text-left',
          on ? 'border-design-accent bg-design-accent/10' : 'bg-background hover:bg-muted/40'
        )}
      >
        {option.preview && <Preview preview={option.preview} />}
        <span className="flex items-center gap-2">
          <Mark multi={multi} on={on} />
          <span className="text-[12.5px] font-[550]">{option.label}</span>
        </span>
        {option.description && <span className="text-[11.5px] font-medium text-muted-foreground">{option.description}</span>}
        {option.suggested && <Suggested />}
      </button>
      {drawing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Open on the canvas"
              onClick={() => void openDesignInPanel(drawing)}
              className="absolute top-4 right-4 rounded-at-4 border bg-background p-1 text-muted-foreground shadow-panel hover:text-foreground"
            >
              <PanelRightOpen className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Open on the canvas</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** An option you choose by reading: a label, a line about it, a path. */
function ListOption({
  option,
  on,
  multi,
  grow,
  onClick
}: {
  option: QuestionOption
  on: boolean
  multi: boolean
  grow: boolean
  onClick: () => void
}): React.ReactElement {
  // An option with its own icon is a place or a thing, and gets more room.
  const roomy = Boolean(option.icon)
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={on}
      onClick={onClick}
      className={cn(
        'flex items-start rounded-at-8 border text-left',
        roomy ? 'gap-3 p-4' : 'gap-2 p-3',
        grow && 'min-w-0 flex-1 basis-0',
        on ? 'border-design-accent bg-design-accent/10' : 'bg-background hover:bg-muted/40'
      )}
    >
      <Mark multi={multi} on={on} className={roomy ? 'mt-0.5 size-[15px]' : 'mt-px'} />
      {option.icon && <NamedIcon name={option.icon} className="mt-0.5 size-[15px] shrink-0 text-muted-foreground" />}
      <span className="flex min-w-0 flex-col gap-px">
        <span className={cn('font-[550]', roomy ? 'text-[14px]' : 'text-[12.5px]')}>{option.label}</span>
        {option.description && <span className="text-[11.5px] font-medium text-muted-foreground">{option.description}</span>}
        {option.detail && <code className="truncate font-mono text-[11.5px] text-muted-foreground">{option.detail}</code>}
        {option.suggested && (
          <span className="mt-px">
            <Suggested why={option.why} />
          </span>
        )}
      </span>
    </button>
  )
}

/** A colour of your own, beside the palettes Claude offered. */
function CustomColor({ value, onPick }: { value: string | null; onPick: (hex: string | null) => void }): React.ReactElement {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => setDraft(value ?? ''), [value])
  const well = useRef<HTMLInputElement | null>(null)
  const on = value !== null
  return (
    <div
      className={cn(
        'flex min-w-[120px] flex-1 basis-0 flex-col gap-2 rounded-at-8 border border-dashed p-3',
        on ? 'border-design-accent bg-design-accent/10' : 'border-border-strong bg-background'
      )}
    >
      <span className="flex h-7 items-center gap-2 rounded-at-4 border bg-background px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Pick a colour"
              onClick={() => well.current?.click()}
              className="size-3.5 shrink-0 rounded-full border border-border-strong"
              style={value ? { background: value } : undefined}
            />
          </TooltipTrigger>
          <TooltipContent>Pick a colour</TooltipContent>
        </Tooltip>
        <input
          ref={well}
          type="color"
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          value={value && value.length === 7 ? value : '#888888'}
          onChange={(e) => onPick(e.target.value.toUpperCase())}
        />
        <input
          value={draft}
          placeholder="#"
          aria-label="Hex colour"
          onChange={(e) => {
            setDraft(e.target.value)
            if (isHex(e.target.value)) onPick(e.target.value.toUpperCase())
            else if (!e.target.value) onPick(null)
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] outline-none placeholder:text-muted-foreground"
        />
      </span>
      <span className="flex items-center gap-2">
        <Mark multi={false} on={on} />
        <span className="text-[12.5px] font-[550]">Custom</span>
      </span>
      <span className="text-[11.5px] font-medium text-muted-foreground">Paste a hex or pick</span>
    </div>
  )
}

/** An option drawn from data: a palette is its colours, a radius is a shape at it. */
function Preview({ preview }: { preview: OptionPreview }): React.ReactElement | null {
  if ('artboard' in preview && typeof preview.artboard === 'string') return <ArtboardThumb at={preview.artboard} />
  if ('palette' in preview && Array.isArray(preview.palette)) {
    return (
      <span className="flex h-7 overflow-hidden rounded-at-4">
        {preview.palette.filter(isHex).map((c, i) => (
          <span key={i} className="flex-1" style={{ background: c }} />
        ))}
      </span>
    )
  }
  if ('swatch' in preview && typeof preview.swatch === 'string' && isHex(preview.swatch)) {
    return <span className="h-7 rounded-at-4 ring-1 ring-border ring-inset" style={{ background: preview.swatch }} />
  }
  if ('radius' in preview && typeof preview.radius === 'number') {
    return (
      <span className="flex h-16 items-center justify-center rounded-at-4 bg-muted">
        <span className="h-10 w-[72px] bg-gradient-to-br from-design-accent/40 to-design-accent" style={{ borderRadius: preview.radius }} />
      </span>
    )
  }
  if ('density' in preview) {
    const gap = preview.density === 'compact' ? 4 : preview.density === 'spacious' ? 20 : 12
    return (
      <span className="flex h-16 flex-col justify-center overflow-hidden rounded-at-4 border bg-background px-2" style={{ gap }}>
        {/* Three rows: four at the spacious gap would not fit the box. */}
        {[70, 55, 62].map((w) => (
          <span key={w} className="h-1.5 shrink-0 rounded-at-4 bg-muted-foreground/30" style={{ width: `${w}%` }} />
        ))}
      </span>
    )
  }
  if ('type' in preview && preview.type && typeof preview.type.size === 'number') {
    // Drawn at its size up to what the box can hold; a display size gets one
    // line rather than being cut in half.
    const size = Math.min(preview.type.size, 34)
    const oneLine = size > 20
    return (
      <span className="block h-16 overflow-hidden rounded-at-4 border bg-background p-2">
        <span
          className={cn('block', oneLine ? 'truncate' : 'line-clamp-2')}
          style={{ fontSize: size, lineHeight: 1.35, fontWeight: preview.type.weight, fontFamily: preview.type.family }}
        >
          {preview.type.sample ?? 'The quick brown fox jumps over the lazy dog'}
        </span>
      </span>
    )
  }
  return null
}

/** Loads are shared for a moment, so several drawings from one file read it once. */
const drawingLoads = new Map<string, { at: number; load: Promise<DesignLoad> }>()

function loadDrawing(path: string): Promise<DesignLoad> {
  const hit = drawingLoads.get(path)
  if (hit && Date.now() - hit.at < 10_000) return hit.load
  const load = loadDesign(path)
  drawingLoads.set(path, { at: Date.now(), load })
  return load
}

/** A direction Claude drew, live and shrunk to fit its card. */
function ArtboardThumb({ at }: { at: string }): React.ReactElement {
  const { path, artboard } = splitDesignRef(at)
  const [loaded, setLoaded] = useState<DesignLoad | null>(null)
  const [width, setWidth] = useState(0)
  const frame = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    let live = true
    void loadDrawing(path).then((r) => live && setLoaded(r))
    return () => {
      live = false
    }
  }, [path])
  useEffect(() => {
    const node = frame.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(node)
    return () => ro.disconnect()
  }, [])
  const board =
    loaded?.kind === 'ok' ? (artboard ? loaded.doc.artboards.find((a) => a.id === artboard) : loaded.doc.artboards[0]) : undefined
  return (
    <span ref={frame} className="flex min-h-24 items-center justify-center overflow-hidden rounded-at-4 border bg-muted">
      {loaded === null ? (
        <span className="text-[11.5px] font-medium text-muted-foreground">Drawing…</span>
      ) : board && loaded.kind === 'ok' && width > 0 ? (
        <ScaledArtboard artboard={board} theme={loaded.theme} maxWidth={width} maxHeight={200} />
      ) : (
        <span className="p-3 text-[11.5px] font-medium text-muted-foreground">This drawing could not be loaded</span>
      )}
    </span>
  )
}

/**
 * Buttons, a field, a tile and a chip, all at one radius: how round a control
 * reads is about its height, so a single shape cannot show it.
 */
function RadiusPreview({ radius }: { radius: number }): React.ReactElement {
  const r = Math.max(0, radius)
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-at-8 bg-muted p-3">
      <span className="bg-design-accent px-3 py-1 text-[12.5px] font-[550] text-design-accent-foreground" style={{ borderRadius: r }}>
        Export
      </span>
      <span className="w-[120px] border border-border-strong bg-background px-2 py-1 text-[12.5px] text-muted-foreground" style={{ borderRadius: r }}>
        1080p
      </span>
      <span className="h-10 w-[72px] bg-gradient-to-br from-design-accent/40 to-design-accent" style={{ borderRadius: r }} />
      <span className="bg-border px-2 py-px text-[11.5px] font-medium" style={{ borderRadius: r }}>
        Track 2
      </span>
    </div>
  )
}

function ScaleInput({
  question,
  answer,
  onAnswer
}: {
  question: Question
  answer: Answer | undefined
  onAnswer: (a: Answer | null) => void
}): React.ReactElement {
  const s = question.scale ?? { min: 0, max: 100 }
  const span = s.max - s.min || 1
  const value = answer?.kind === 'value' && typeof answer.value === 'number' ? answer.value : (s.suggested ?? Math.round((s.min + s.max) / 2))
  const pct = ((value - s.min) / span) * 100
  const unit = s.unit ? ` ${s.unit}` : ''
  const radius = s.unit === 'px' && /round|radius|corner|shape/i.test(`${question.question} ${question.chip ?? ''} ${question.section ?? ''}`)
  const step = s.step ?? 1
  const ticks = s.unit ? [0, 1, 2, 3, 4].map((i) => Math.round((s.min + (span * i) / 4) / step) * step) : []
  const nearest = ticks.length ? ticks.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a)) : null
  const suggest =
    s.suggested !== undefined ? (
      <button type="button" className="min-w-0 hover:opacity-80" onClick={() => onAnswer({ kind: 'value', value: s.suggested! })}>
        <Suggested why={s.why ?? `${s.suggested}${unit}`} />
      </button>
    ) : null
  return (
    <div className="flex flex-col gap-2">
      {s.gradient && isHex(s.gradient[0]) && isHex(s.gradient[1]) && (
        <span className="h-5 rounded-at-4" style={{ background: `linear-gradient(to right, ${s.gradient[0]}, ${s.gradient[1]})` }} />
      )}
      <input
        type="range"
        min={s.min}
        max={s.max}
        step={step}
        value={value}
        onChange={(e) => onAnswer({ kind: 'value', value: Number(e.target.value) })}
        className="nyra-range w-full"
        style={{ '--fill': `${pct}%` } as React.CSSProperties}
        aria-label={question.question}
        aria-valuetext={`${value}${unit}`}
      />
      {ticks.length > 0 ? (
        <div className="flex justify-between text-[11.5px] font-medium text-muted-foreground tabular-nums">
          {ticks.map((t, i) => (
            <span key={i} className={cn(t === nearest && 'text-design-accent')}>
              {t === nearest ? `${value}${unit}` : t}
              {i === 0 && s.minLabel ? ` · ${s.minLabel}` : ''}
              {i === ticks.length - 1 && s.maxLabel ? ` · ${s.maxLabel}` : ''}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 text-[11.5px] font-medium text-muted-foreground">
          <span className="shrink-0">{s.minLabel ?? s.min}</span>
          {suggest}
          <span className="shrink-0">{s.maxLabel ?? s.max}</span>
        </div>
      )}
      {ticks.length > 0 && s.suggested !== undefined && s.why && <div className="flex">{suggest}</div>}
      {radius && <RadiusPreview radius={value} />}
    </div>
  )
}

function ColorInput({
  question,
  answer,
  onAnswer
}: {
  question: Question
  answer: Answer | undefined
  onAnswer: (a: Answer | null) => void
}): React.ReactElement {
  const value = answer?.kind === 'value' && typeof answer.value === 'string' ? answer.value : ''
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const swatch = isHex(draft) ? draft : (question.suggested ?? '#888888')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={isHex(swatch) && swatch.length === 7 ? swatch : '#888888'}
          onChange={(e) => onAnswer({ kind: 'value', value: e.target.value.toUpperCase() })}
          className="size-7 cursor-pointer rounded-at-4 border bg-transparent"
          aria-label="Pick a colour"
        />
        <input
          value={draft}
          placeholder={question.suggested ?? '#6E56CF'}
          onChange={(e) => {
            setDraft(e.target.value)
            if (isHex(e.target.value)) onAnswer({ kind: 'value', value: e.target.value.toUpperCase() })
            else if (!e.target.value) onAnswer(null)
          }}
          className="h-7 w-28 rounded-at-4 border bg-background px-2 font-mono text-[12.5px] outline-none focus:border-design-accent"
          aria-label="Hex colour"
        />
      </div>
      {question.suggested && isHex(question.suggested) && (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 self-start"
          onClick={() => onAnswer({ kind: 'value', value: question.suggested! })}
        >
          <span className="size-3 shrink-0 rounded-at-3 border" style={{ background: question.suggested }} />
          <Suggested why={question.why ? `${question.suggested} · ${question.why}` : question.suggested} />
        </button>
      )}
    </div>
  )
}

/** Image files a thumbnail can show; anything else gets an icon and its name. */
const RASTER = /\.(png|jpe?g|gif|webp)$/i

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  // In slices: one `fromCharCode` call over megabytes overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

/**
 * Files for an answer: picked, dropped or pasted. Each is copied beside the
 * questionnaire as it is added, so the answer keeps working after the
 * original moves, and Claude reads the copy.
 */
function FilesInput({
  questionnaireId,
  question,
  answer,
  onAnswer
}: {
  questionnaireId: string
  question: Question
  answer: Answer | undefined
  onAnswer: (a: Answer | null) => void
}): React.ReactElement {
  const files = answer?.kind === 'files' ? answer.files : []
  // Two drops in quick succession must both land: each add appends to what
  // the last one left, not to the render it started from.
  const latest = useRef(files)
  latest.current = files
  const [busy, setBusy] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [over, setOver] = useState(false)

  const add = async (task: () => Promise<{ files: AnswerFile[]; errors: string[] }>): Promise<void> => {
    setBusy((n) => n + 1)
    try {
      const out = await task()
      if (out.files.length) {
        const next = [...latest.current, ...out.files]
        latest.current = next
        onAnswer({ kind: 'files', files: next })
      }
      setErrors(out.errors)
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)])
    } finally {
      setBusy((n) => n - 1)
    }
  }

  const addBlobs = (blobs: File[]): void => {
    for (const f of blobs) {
      const name = f.name || `pasted-${Date.now()}.${(f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`
      void add(async () => window.api.questionnaire.addFileBytes(questionnaireId, name, toBase64(await f.arrayBuffer())))
    }
  }

  const pick = async (): Promise<void> => {
    const paths = await window.api.dialog.pickFiles()
    if (paths?.length) await add(() => window.api.questionnaire.addFiles(questionnaireId, paths))
  }

  const remove = (file: AnswerFile): void => {
    const next = latest.current.filter((f) => f.path !== file.path)
    latest.current = next
    onAnswer(next.length ? { kind: 'files', files: next } : null)
    void window.api.questionnaire.removeFile(questionnaireId, file.path)
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        tabIndex={0}
        role="group"
        aria-label={question.question}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.stopPropagation()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          addBlobs(Array.from(e.dataTransfer.files))
        }}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files)
          if (!pasted.length) return
          e.preventDefault()
          addBlobs(pasted)
        }}
        className={cn(
          'flex flex-col items-center gap-1 rounded-at-8 border border-dashed px-3 py-4 text-center text-[12.5px] outline-none focus-visible:border-design-accent',
          over ? 'border-design-accent bg-design-accent/10' : 'border-border-strong bg-background'
        )}
      >
        <span>
          Drop files here, paste an image, or{' '}
          <button type="button" onClick={() => void pick()} className="font-[550] text-design-accent hover:underline">
            choose files
          </button>
        </span>
        {question.placeholder && <span className="text-[11.5px] font-medium text-muted-foreground">{question.placeholder}</span>}
      </div>
      {(files.length > 0 || busy > 0) && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {files.map((f) => (
            <li key={f.path} className="group relative flex flex-col gap-1">
              <FileThumb file={f} />
              <span className="truncate text-[11.5px] font-medium text-muted-foreground" title={f.name}>
                {f.name}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => remove(f)}
                    className="absolute top-1 right-1 rounded-full bg-background/90 p-0.5 opacity-0 shadow-panel group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove</TooltipContent>
              </Tooltip>
            </li>
          ))}
          {busy > 0 && (
            <li className="flex aspect-[4/3] items-center justify-center rounded-at-8 border text-[11.5px] font-medium text-muted-foreground">
              Adding…
            </li>
          )}
        </ul>
      )}
      {errors.map((e) => (
        <p key={e} className="text-[11.5px] text-danger">
          {e}
        </p>
      ))}
    </div>
  )
}

function FileThumb({ file }: { file: AnswerFile }): React.ReactElement {
  const [src, setSrc] = useState<string | null>(() => {
    const hit = cachedImage(file.path)
    return hit?.status === 'ready' ? hit.dataUrl : null
  })
  useEffect(() => {
    let live = true
    if (RASTER.test(file.path)) {
      void loadImage(file.path).then((e) => live && e.status === 'ready' && setSrc(e.dataUrl))
    } else if (/\.svg$/i.test(file.path)) {
      // Drawn by an <img>, which runs nothing inside the SVG.
      void window.api.fs.readFile(file.path).then((r) => {
        if (live && r.content) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.content)}`)
      })
    }
    return () => {
      live = false
    }
  }, [file.path])
  const ext = basename(file.path).split('.').pop()?.toUpperCase() ?? ''
  return (
    <span className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-at-8 border bg-muted">
      {src ? (
        <img src={src} alt="" className="max-h-full max-w-full object-contain p-1.5" />
      ) : (
        <span className="flex flex-col items-center gap-1 text-[10px] font-medium text-muted-foreground">
          <FileText className="size-5" />
          {ext}
        </span>
      )}
    </span>
  )
}
