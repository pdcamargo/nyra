import React, { useCallback, useEffect, useState } from 'react'
import {
  Bell,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  CornerDownRight,
  ExternalLink,
  Mic,
  MousePointerClick,
  ScreenShare
} from 'lucide-react'
import { useSettingsStore } from '../../store/settings'
import { useKeepAwakeStore } from '../../store/keepAwake'
import { awakeReasons, heldFor } from '../../lib/keepAwake'
import { platform } from '../../lib/platform'
import type { SystemAccess, SystemAccessKind } from '../../lib/tauri-api'
import { SectionLabel, SectionNote, Toggle } from './primitives'

/**
 * Settings → System: what Nyra does to the machine, and what the machine lets
 * Nyra do. Apart from Permissions, which is about what Claude may do.
 */
export default function SystemTab(): React.JSX.Element {
  return (
    <>
      <KeepAwake />
      <Access />
    </>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  indent
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  indent?: boolean
}): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between gap-4 py-2.5 ${indent ? 'pl-6' : ''}`}>
      <div className="min-w-0">
        <p className="text-xs text-foreground">{label}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}

/** Re-render on a slow clock, for "for 14 min". */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(id)
  }, [everyMs])
  return now
}

function KeepAwake(): React.JSX.Element {
  const enabled = useSettingsStore((s) => s.keepAwake)
  const display = useSettingsStore((s) => s.keepAwakeDisplay)
  const onlyOnAc = useSettingsStore((s) => s.keepAwakeOnlyOnAc)
  const update = useSettingsStore((s) => s.updateSettings)
  const status = useKeepAwakeStore((s) => s.status)
  const now = useNow(30_000)
  const machine = platform().machineNoun

  let line: React.ReactNode
  if (status.holding) {
    line = (
      <>
        <span className="flex-1">
          Holding your {machine} awake — <span className="font-semibold">{awakeReasons(status)}</span>
        </span>
        <span className="shrink-0 text-muted-foreground">{heldFor(status.since, now)}</span>
      </>
    )
  } else if (status.busy && status.onBattery && onlyOnAc) {
    line = <span className="flex-1">On battery, so your {machine} sleeps normally until it is plugged in.</span>
  } else if (status.busy) {
    line = <span className="flex-1">The system did not let Nyra keep your {machine} awake.</span>
  } else {
    line = <span className="flex-1">Nothing is running. Your {machine} sleeps on its usual schedule.</span>
  }

  return (
    <>
      <SectionLabel>Keep awake</SectionLabel>
      <ToggleRow
        label={`Keep this ${machine} awake while Claude works`}
        hint="While a chat is replying, or a monitor or background task Claude started is still running. Off as soon as nothing is."
        checked={enabled}
        onChange={(v) => update({ keepAwake: v })}
      />
      {enabled && (
        <>
          <div
            className={`mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-[11px] text-foreground ${
              status.holding ? 'bg-success/10' : 'bg-muted/60'
            }`}
            data-testid="keep-awake-status"
          >
            <span
              className={`size-2 shrink-0 rounded-full ${status.holding ? 'bg-success' : 'bg-muted-foreground'}`}
            />
            {line}
          </div>
          <ToggleRow
            indent
            label="Keep the display on too"
            hint="Off lets the screen sleep and lock while the work carries on."
            checked={display}
            onChange={(v) => update({ keepAwakeDisplay: v })}
          />
          <ToggleRow
            indent
            label="Only when plugged in"
            hint={`On battery, your ${machine} sleeps normally.`}
            checked={onlyOnAc}
            onChange={(v) => update({ keepAwakeOnlyOnAc: v })}
          />
          <SectionNote>
            Closing the lid still sleeps a laptop unless it is on power with an external display. Nyra
            never changes your system power settings.
          </SectionNote>
        </>
      )}
    </>
  )
}

/** Each grant in the app's words: what it lets Claude or Nyra do, and for which feature. */
const COPY: Record<
  SystemAccessKind,
  { icon: React.ComponentType<{ className?: string }>; title: string; purpose: () => string; feature: string }
> = {
  controlInput: {
    icon: MousePointerClick,
    title: 'Operate other apps',
    purpose: () => 'Lets Claude read and click the controls of an app you allowed.',
    feature: 'Desktop control'
  },
  captureScreen: {
    icon: ScreenShare,
    title: 'See other apps’ windows',
    purpose: () => 'Lets Claude take a screenshot of the app it is working in.',
    feature: 'Desktop control'
  },
  desktop: {
    icon: MousePointerClick,
    title: 'Operate and see other apps',
    purpose: () =>
      `${platform().osName} does not gate this. Nyra still asks you before Claude touches each app.`,
    feature: 'Desktop control'
  },
  microphone: {
    icon: Mic,
    title: 'Hear you',
    purpose: () => `Audio for dictation. Transcribed on this ${platform().machineNoun}, never uploaded.`,
    feature: 'Dictation'
  },
  notifications: {
    icon: Bell,
    title: 'Notify you',
    purpose: () =>
      'Tells you when a reply finishes or Claude needs an answer while Nyra is in the background.',
    feature: 'Reply alerts'
  }
}

const STATE: Record<
  SystemAccess['state'],
  { icon: React.ComponentType<{ className?: string }>; label: string; tone: string }
> = {
  allowed: { icon: CircleCheck, label: 'Allowed', tone: 'text-success' },
  denied: { icon: CircleX, label: 'Not allowed', tone: 'text-danger' },
  unasked: { icon: CircleDashed, label: 'Not asked yet', tone: 'text-muted-foreground' },
  notRequired: { icon: CircleMinus, label: 'Not required', tone: 'text-muted-foreground' },
  unavailable: { icon: CircleMinus, label: 'Installed app only', tone: 'text-muted-foreground' }
}

function Access(): React.JSX.Element {
  const [rows, setRows] = useState<SystemAccess[] | null>(null)

  const refresh = useCallback(() => {
    void window.api.systemAccess.list().then(setRows)
  }, [])

  // Granting happens in another app, so check again whenever the window comes back.
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const fix = (kind: SystemAccessKind): void => {
    void window.api.systemAccess.fix(kind).then(refresh, refresh)
  }

  return (
    <>
      <SectionLabel>Access</SectionLabel>
      <SectionNote>
        What {platform().osName} lets Nyra do. Nothing is asked for until a feature needs it, and you
        can turn each off in the system’s own settings.
      </SectionNote>
      {rows?.map((row) => <AccessRow key={row.kind} row={row} onFix={() => fix(row.kind)} />)}
    </>
  )
}

function AccessRow({ row, onFix }: { row: SystemAccess; onFix: () => void }): React.JSX.Element {
  const copy = COPY[row.kind]
  const state = STATE[row.state]
  const Icon = copy.icon
  const StateIcon = state.icon
  return (
    <div className="flex items-start gap-3 border-b border-separator py-3 last:border-b-0" data-testid={`access-${row.kind}`}>
      <div className="flex size-[30px] shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-[15px] text-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{copy.title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{copy.purpose()}</p>
        <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <CornerDownRight className="size-3" />
          {copy.feature}
          <span aria-hidden>·</span>
          {row.osName}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className={`flex items-center gap-1 text-[11px] ${state.tone}`}>
          <StateIcon className="size-3" />
          {state.label}
        </span>
        {row.action &&
          (row.asks ? (
            <button
              type="button"
              onClick={onFix}
              className="rounded-md bg-info px-2 py-0.5 text-xs text-info-foreground transition-colors hover:bg-info/90"
            >
              {row.action}
            </button>
          ) : (
            <button
              type="button"
              onClick={onFix}
              className="flex items-center gap-1 rounded-md border border-input px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-input/40"
            >
              {row.action}
              <ExternalLink className="size-3 text-muted-foreground" />
            </button>
          ))}
      </div>
    </div>
  )
}
