import React from 'react'
import {
  Cpu,
  Info,
  Keyboard,
  Palette,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Wrench
} from 'lucide-react'
import Modal from '../Modal'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { useUiStore, type SettingsTab } from '../../store/ui'
import GeneralTab from './GeneralTab'
import AppearanceTab from './AppearanceTab'
import ModelTab from './ModelTab'
import PermissionsTab from './PermissionsTab'
import McpTab from './McpTab'
import ShortcutsTab from './ShortcutsTab'
import AdvancedTab from './AdvancedTab'
import AboutTab from './AboutTab'

/**
 * Settings, as a vertical-tab window.
 *
 * It was one flat `max-w-md` column with uppercase captions for sections, and it
 * had already outgrown that — you scrolled past the model to reach the Claude
 * binary. The panes are separate components rather than sections of one file so
 * that adding to a pane cannot conflict with adding to another, and because
 * Radix unmounts an inactive `TabsContent`: MCP no longer calls the backend on
 * open, only when you go looking for it.
 */
const TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] =
  [
    { id: 'general', label: 'General', icon: SlidersHorizontal },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'model', label: 'Model', icon: Cpu },
    { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { id: 'mcp', label: 'MCP', icon: Plug },
    { id: 'advanced', label: 'Advanced', icon: Wrench },
    { id: 'about', label: 'About', icon: Info }
  ]

const PANES: Record<SettingsTab, React.ComponentType> = {
  general: GeneralTab,
  appearance: AppearanceTab,
  model: ModelTab,
  permissions: PermissionsTab,
  shortcuts: ShortcutsTab,
  mcp: McpTab,
  advanced: AdvancedTab,
  about: AboutTab
}

export default function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const tab = useUiStore((s) => s.settingsTab)
  const setTab = useUiStore((s) => s.setSettingsTab)

  return (
    <Modal
      onClose={onClose}
      title="Settings"
      description="Application preferences"
      className="flex h-[600px] max-w-3xl flex-col overflow-hidden p-0"
    >
      <Tabs
        orientation="vertical"
        value={tab}
        onValueChange={(next) => setTab(next as SettingsTab)}
        className="min-h-0 flex-1 gap-0"
      >
        {/* The nav is pinned: the shell clips, and only the pane scrolls.
            `h-full` rather than the variant's own `h-fit`, which sized the rail
            to its buttons and left the divider stopping halfway down the dialog.
            Darker than the pane it sits beside, so the two read as separate
            surfaces rather than one box with a line drawn in it. */}
        <TabsList
          variant="line"
          className="w-44 shrink-0 gap-0 overflow-y-auto rounded-none border-r border-border/55 bg-background p-2"
        >
          {/* A hairline between each entry. The subtle token, not the one the
              panes use: the nav sits on --background, and against that the pane
              value reads as a stripe rather than a division. The trigger already
              carries a transparent 1px border, so this is a colour change rather
              than a layout one — nothing shifts when the last one drops it. */}
          {TABS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger
              key={id}
              value={id}
              className="h-8 flex-none rounded-none border-b-separator-subtle px-2 last:border-b-transparent"
            >
              <Icon />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto bg-popover px-5 py-4">
            {TABS.map(({ id }) => {
              const Pane = PANES[id]
              return (
                <TabsContent key={id} value={id} className="h-full">
                  <Pane />
                </TabsContent>
              )
            })}
          </div>
          <footer className="flex shrink-0 items-center justify-end border-t border-border/55 px-5 py-3">
            <button
              onClick={onClose}
              className="rounded-lg bg-accent px-4 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-secondary"
            >
              Done
            </button>
          </footer>
        </div>
      </Tabs>
    </Modal>
  )
}
