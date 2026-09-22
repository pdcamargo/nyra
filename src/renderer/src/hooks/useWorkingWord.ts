import { useEffect, useState } from 'react'
import { nextWorkingWord, type WorkingWord } from '../lib/workingWords'

/**
 * Slow enough to be read, fast enough that a short turn still sees it change.
 *
 * Deliberately not a multiple of the shimmer's 2.4s pan or the eyes' 10s loop:
 * three animations on one line that share a period start landing on the same
 * beat, and the whole indicator turns into a single blink.
 */
const ROTATE_MS = 3100

/** The running indicator's verb, swapped every few seconds while it is mounted. */
export function useWorkingWord(intervalMs: number = ROTATE_MS): WorkingWord {
  const [word, setWord] = useState<WorkingWord>(() => nextWorkingWord())

  useEffect(() => {
    const id = setInterval(() => setWord((prev) => nextWorkingWord(prev)), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return word
}
