import React from 'react'
import { useSettingsStore } from '../../store/settings'
import { MAX_DIM_OPACITY, MIN_DIM_OPACITY, type SidebarStyle } from '../../../../shared/types'
import { Slider } from '../ui/slider'
import { SectionLabel, SectionNote, SettingRow, Toggle } from './primitives'

const STYLES: { value: SidebarStyle; label: string; hint: string }[] = [
  { value: 'headings', label: 'Headings', hint: 'A rule between projects' },
  { value: 'cards', label: 'Cards', hint: 'An open project is boxed' },
  { value: 'spine', label: 'Spine', hint: 'A tile and a line in its colour' }
]

/** A chat title, a project name, a project's mark: the thumbnails' parts. */
const Line = ({ w, strong = false }: { w: string; strong?: boolean }): React.JSX.Element => (
  <span
    className={`block h-[3px] shrink-0 rounded-full ${strong ? 'bg-muted-foreground/70' : 'bg-muted-foreground/30'}`}
    style={{ width: w }}
  />
)
const Mark = ({ tint }: { tint: string }): React.JSX.Element => (
  <span className="size-[7px] shrink-0 rounded-at-2 border" style={{ borderColor: `var(--tint-${tint})` }} />
)
const Row = ({ children, inset = 0 }: { children: React.ReactNode; inset?: number }): React.JSX.Element => (
  <span className="flex items-center gap-1" style={{ paddingLeft: inset }}>
    {children}
  </span>
)

/** Each style, drawn small enough to choose between at a glance. */
function Thumb({ style }: { style: SidebarStyle }): React.JSX.Element {
  if (style === 'headings') {
    return (
      <>
        <Row><Line w="34%" strong /></Row>
        <Row inset={7}><Line w="70%" /></Row>
        <Row inset={7}><Line w="54%" /></Row>
        <span className="block h-px bg-border" />
        <Row><Line w="26%" strong /></Row>
        <span className="block h-px bg-border" />
        <Row><Line w="40%" strong /></Row>
      </>
    )
  }
  if (style === 'cards') {
    return (
      <>
        <span className="flex flex-col gap-1 rounded-at-4 border border-border bg-project-card p-1">
          <Row><Mark tint="blue" /><Line w="34%" strong /></Row>
          <Row inset={11}><Line w="66%" /></Row>
          <Row inset={11}><Line w="50%" /></Row>
        </span>
        <Row inset={4}><Mark tint="green" /><Line w="28%" /></Row>
        <Row inset={4}><Mark tint="violet" /><Line w="38%" /></Row>
      </>
    )
  }
  return (
    <>
      <Row><Mark tint="blue" /><Line w="34%" strong /></Row>
      <span className="flex gap-1.5 pl-[3px]">
        <span className="w-px shrink-0 bg-[var(--tint-blue)]" />
        <span className="flex flex-1 flex-col gap-1">
          <Line w="72%" />
          <Line w="56%" />
          <Line w="64%" />
        </span>
      </span>
      <Row><Mark tint="green" /><Line w="28%" /></Row>
      <Row><Mark tint="amber" /><Line w="38%" /></Row>
    </>
  )
}

export default function SidebarSection(): React.JSX.Element {
  const sidebarStyle = useSettingsStore((s) => s.sidebarStyle)
  const needsYouTray = useSettingsStore((s) => s.needsYouTray)
  const dimOtherProjects = useSettingsStore((s) => s.dimOtherProjects)
  const dimOpacity = useSettingsStore((s) => s.dimOpacity)
  const update = useSettingsStore((s) => s.updateSettings)

  return (
    <>
      <SectionLabel>Sidebar</SectionLabel>
      <SectionNote>How projects and their chats are told apart in the left rail.</SectionNote>

      <div className="grid grid-cols-3 gap-2 pb-2.5" role="radiogroup" aria-label="Project style">
        {STYLES.map((s) => {
          const selected = s.value === sidebarStyle
          return (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => update({ sidebarStyle: s.value })}
              className="group flex flex-col gap-1.5 text-left"
            >
              {/* A selected card takes a fill and a ring, and its label a step
                  in weight and colour: a ring alone at this size is a smudge. */}
              <span
                className={`flex h-[76px] flex-col gap-1 overflow-hidden rounded-lg border bg-sidebar p-2 transition-colors ${
                  selected ? 'border-info ring-1 ring-info' : 'border-border group-hover:border-border-strong'
                }`}
              >
                <Thumb style={s.value} />
              </span>
              <span className="flex flex-col">
                <span className={`text-xs ${selected ? 'font-medium text-foreground' : 'text-foreground/80'}`}>
                  {s.label}
                </span>
                <span className="text-[11px] text-muted-foreground">{s.hint}</span>
              </span>
            </button>
          )
        })}
      </div>

      <SettingRow label="Needs you tray" hint="waiting chats from every project, above Pinned">
        <Toggle checked={needsYouTray} onChange={(v) => update({ needsYouTray: v })} />
      </SettingRow>
      <SettingRow label="Dim other projects" hint="while a chat is open">
        <Toggle checked={dimOtherProjects} onChange={(v) => update({ dimOtherProjects: v })} />
      </SettingRow>
      {dimOtherProjects && (
        <SettingRow label="Faded to" hint="how visible the other projects stay">
          <div className="flex w-[200px] items-center gap-2">
            <Slider
              className="grow [&_[data-slot=slider-range]]:bg-info [&_[data-slot=slider-track]]:bg-border-strong"
              aria-label="How visible other projects stay"
              min={MIN_DIM_OPACITY * 100}
              max={MAX_DIM_OPACITY * 100}
              step={5}
              value={[Math.round(dimOpacity * 100)]}
              onValueChange={([v]) => update({ dimOpacity: v / 100 })}
            />
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-foreground/80">
              {Math.round(dimOpacity * 100)}%
            </span>
          </div>
        </SettingRow>
      )}
    </>
  )
}
