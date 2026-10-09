import React from 'react'

/**
 * A literal key, for a hint about a key that is not a registered command — the
 * arrows in a list, ⌥ held to compare. Registered commands use `Kbd` with their
 * id instead, so a rebinding shows up.
 */
export function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-at-4 border border-border px-1 font-mono text-[10px] leading-none text-muted-foreground">
      {children}
    </kbd>
  )
}
