import { cn } from "cn"

/*
 * loading.dev's "loading" spinner, without the package: eight 2×2 dot clusters
 * on a ring, each fading a step behind the last. Listed clockwise from 3 o'clock;
 * the index is the step, which `.nyra-dot-spinner-segment` turns into a delay.
 */
const SEGMENTS: readonly [number, number][] = [
  [12, 6],
  [10, 10],
  [6, 12],
  [2, 10],
  [0, 6],
  [2, 2],
  [6, 0],
  [10, 2],
]

const CLUSTER = "M0 0h1v1H0zM2 0h1v1H2zM0 2h1v1H0zM2 2h1v1H2z"

function DotSpinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      data-slot="dot-spinner"
      aria-hidden="true"
      viewBox="0 0 15 15"
      fill="currentColor"
      className={cn("size-3 shrink-0", className)}
      {...props}
    >
      {SEGMENTS.map(([x, y], step) => (
        <path
          key={step}
          className="nyra-dot-spinner-segment"
          d={CLUSTER}
          transform={`translate(${x} ${y})`}
          style={{ "--step": step } as React.CSSProperties}
        />
      ))}
    </svg>
  )
}

export { DotSpinner }
