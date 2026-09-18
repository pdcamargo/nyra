import React from 'react'
import { useSettingsStore } from '../../store/settings'
import { SectionLabel, SectionNote, Toggle } from './primitives'

const MANAGEABLE_TOOLS: { name: string; description: string }[] = [
  { name: 'Bash', description: 'Run shell commands' },
  { name: 'Edit', description: 'Modify existing files' },
  { name: 'Write', description: 'Create or overwrite files' },
  { name: 'ExitPlanMode', description: 'Exit plan mode and execute' }
]

export default function PermissionsTab(): React.JSX.Element {
  const skipPermissions = useSettingsStore((s) => s.skipPermissions)
  const autoApproveTools = useSettingsStore((s) => s.autoApproveTools)
  const update = useSettingsStore((s) => s.updateSettings)

  const toggleTool = (name: string): void => {
    const set = new Set(autoApproveTools)
    if (set.has(name)) set.delete(name)
    else set.add(name)
    update({ autoApproveTools: Array.from(set) })
  }

  return (
    <>
      <SectionLabel>Tool permissions</SectionLabel>
      <SectionNote>
        Choose which tools auto-approve without asking. You can also click{' '}
        <span className="text-foreground/80">Always allow</span> on any prompt to add it here.
      </SectionNote>

      <div className="rounded-lg border border-border bg-muted/40 p-3 mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-foreground font-medium">Skip all prompts</p>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              Auto-approve every tool. Overrides the per-tool toggles below.
            </p>
          </div>
          <Toggle checked={skipPermissions} onChange={(v) => update({ skipPermissions: v })} />
        </div>
      </div>

      <SectionLabel>Per tool</SectionLabel>

      <div className={skipPermissions ? 'pointer-events-none opacity-40' : ''}>
        {MANAGEABLE_TOOLS.map((tool) => (
          <div
            key={tool.name}
            className="flex items-center justify-between gap-3 border-b border-separator py-2.5 transition-colors last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-xs text-foreground font-mono">{tool.name}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{tool.description}</p>
            </div>
            <Toggle
              checked={autoApproveTools.includes(tool.name)}
              onChange={() => toggleTool(tool.name)}
            />
          </div>
        ))}
      </div>

      <div className="border-t border-border/55 mt-4 pt-4">
        <button
          onClick={() => update({ autoApproveTools: [] })}
          disabled={autoApproveTools.length === 0}
          className="text-[11px] text-muted-foreground hover:text-foreground/80 transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground"
        >
          Reset all to Ask
        </button>
      </div>
    </>
  )
}
