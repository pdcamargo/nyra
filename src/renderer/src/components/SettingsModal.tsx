import React, { useEffect, useCallback } from 'react'
import Modal from './Modal'
import McpSettings from './McpSettings'
import UpdateRow from './UpdateRow'
import { modelOptions } from '../lib/models'
import { useSettingsStore } from '../store/settings'
import { useHookEditorStore } from '../store/hookEditor'
import { DEFAULT_SETTINGS, type NyraSettings, type ThemePreference } from '../../../shared/types'

export default function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useSettingsStore()
  const update = settings.updateSettings
  const reset = settings.resetSettings

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Modal onClose={onClose} title="Settings" className="max-w-md p-5 max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-foreground">Settings</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground/80 transition-colors text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Essential */}
        <SectionLabel>Essential</SectionLabel>

        <SettingRow label="Theme">
          <SegmentedControl
            value={settings.theme}
            onChange={(v) => update({ theme: v as ThemePreference })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' }
            ]}
          />
        </SettingRow>

        {/* No version numbers: an alias means "the latest", so "Opus 4" was wrong
            the day Opus 5 shipped. A model set from the composer that is not one
            of these still shows here, rather than the row quietly reading
            Default while the session runs on something else. */}
        <SettingRow label="Model">
          <Select
            value={settings.model}
            onChange={(v) => update({ model: v })}
            options={modelOptions(settings.model)}
          />
        </SettingRow>

        <SettingRow label="Permissions">
          <button
            onClick={() => {
              onClose()
              window.dispatchEvent(new CustomEvent('nyra:open-permissions'))
            }}
            className="rounded-lg border border-border bg-muted/40 px-3 py-1 text-xs text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            Manage…
          </button>
        </SettingRow>

        <SettingRow label="Notifications">
          <Toggle
            checked={settings.notifications}
            onChange={(v) => update({ notifications: v })}
          />
        </SettingRow>

        <SettingRow label="Auto-compact">
          <Toggle
            checked={settings.autoCompact}
            onChange={(v) => update({ autoCompact: v })}
          />
        </SettingRow>

        <SettingRow label="Browser tools for Claude">
          <Toggle
            checked={settings.browserTools}
            onChange={(v) => update({ browserTools: v })}
          />
        </SettingRow>

        <SettingRow label="Browser preview over the chat">
          <Toggle checked={settings.browserPip} onChange={(v) => update({ browserPip: v })} />
        </SettingRow>

        <SettingRow label="Clean up worktrees">
          <Toggle
            checked={settings.worktreeAutoDelete}
            onChange={(v) => update({ worktreeAutoDelete: v })}
          />
        </SettingRow>

        {settings.worktreeAutoDelete && (
          <div className="mb-3 flex items-center justify-between gap-3">
            <label className="text-xs text-foreground/80">
              Keep
              <span className="text-muted-foreground/70"> — pinned and running chats are never removed</span>
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.worktreeLimit}
              onChange={(e) =>
                update({ worktreeLimit: Math.max(1, Number(e.target.value) || 1) })
              }
              className="w-16 rounded-lg border border-border bg-muted/40 px-2 py-1 text-xs text-foreground/80 font-mono outline-hidden focus:border-border-strong transition-colors"
            />
          </div>
        )}

        <div className="mb-4">
          <label className="block text-xs text-foreground/80 mb-1.5">System Prompt</label>
          <textarea
            value={settings.systemPrompt}
            onChange={(e) => update({ systemPrompt: e.target.value })}
            placeholder="Appended to Claude's system prompt..."
            rows={3}
            className="w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-foreground placeholder-muted-foreground/70 outline-hidden focus:border-border-strong transition-colors resize-none"
          />
        </div>

        {/* Divider */}
        <div className="border-t border-border/55 my-4" />

        {/* Advanced */}
        <SectionLabel>Advanced</SectionLabel>

        <div className="mb-3">
          <label className="block text-xs text-foreground/80 mb-1.5">Claude Binary</label>
          <input
            type="text"
            value={settings.claudeBinaryPath}
            onChange={(e) => update({ claudeBinaryPath: e.target.value })}
            className="w-full rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 font-mono outline-hidden focus:border-border-strong transition-colors"
          />
        </div>

        <SettingRow label="Font Size">
          <SegmentedControl
            value={settings.fontSize}
            onChange={(v) => update({ fontSize: v as 'small' | 'medium' | 'large' })}
            options={[
              { value: 'small', label: 'S' },
              { value: 'medium', label: 'M' },
              { value: 'large', label: 'L' }
            ]}
          />
        </SettingRow>

        <SettingRow label="Effort Level">
          <Select
            value={settings.effort}
            onChange={(v) => update({ effort: v as NyraSettings['effort'] })}
            options={[
              { value: '', label: 'Default' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]}
          />
        </SettingRow>

        {/* MCP moved here from the workspace panel: a server is set up once and
            then forgotten, which is what settings are for. */}
        <SectionLabel>MCP Servers</SectionLabel>
        <div className="mb-4">
          <McpSettings />
        </div>

        <SectionLabel>About</SectionLabel>
        <div className="mb-4">
          <UpdateRow />
        </div>

        {/* Footer */}
        <div className="border-t border-border/55 mt-4 pt-4 flex items-center justify-between">
          <button
            onClick={() => reset()}
            className="text-[11px] text-muted-foreground hover:text-foreground/80 transition-colors"
          >
            Reset to Defaults
          </button>
          <button
            onClick={onClose}
            className="rounded-lg bg-accent px-4 py-1.5 text-xs text-foreground/80 hover:bg-secondary transition-colors"
          >
            Done
          </button>
        </div>
      </Modal>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3">{children}</p>
  )
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between mb-3">
      <label className="text-xs text-foreground/80">{label}</label>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-info' : 'bg-accent'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}

function Select({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground/80 outline-hidden focus:border-border-strong transition-colors appearance-none cursor-pointer pr-6"
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23666' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center'
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} className="bg-popover text-foreground">
          {opt.label}
        </option>
      ))}
    </select>
  )
}

function SegmentedControl({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): React.JSX.Element {
  return (
    <div className="flex rounded-lg border border-border overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1 text-xs transition-colors ${
            value === opt.value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground/80'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
