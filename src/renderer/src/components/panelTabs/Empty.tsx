import React from 'react'

/** The panel's way of saying nothing is here. Shared, because several things in
 *  it have nothing to show at different moments. */
export default function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
      {children}
    </div>
  )
}
