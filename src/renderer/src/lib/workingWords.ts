/**
 * The verb on the running indicator.
 *
 * A fixed "Thinking" is a label; it says the same thing at second two and at
 * second two hundred, so after a while it stops being read at all. A verb that
 * changes says the clock is still moving even when the elapsed counter is the
 * only other thing on the line — which is the whole job of the indicator, since
 * Nyra cannot show what the model is actually doing between tool calls.
 *
 * They are gerunds and most of them are nonsense on purpose. An honest-sounding
 * vocabulary ("Analysing", "Retrieving") would be a claim about work that is not
 * being reported to us, and a wrong claim is worse than a silly one.
 */
export const WORKING_WORDS = [
  'Accomplishing',
  'Actioning',
  'Baking',
  'Brewing',
  'Calculating',
  'Cerebrating',
  'Churning',
  'Coalescing',
  'Cogitating',
  'Computing',
  'Concocting',
  'Conjuring',
  'Considering',
  'Cooking',
  'Crafting',
  'Crunching',
  'Deliberating',
  'Determining',
  'Discombobulating',
  'Effecting',
  'Finagling',
  'Forging',
  'Generating',
  'Hatching',
  'Herding',
  'Hustling',
  'Ideating',
  'Inferring',
  'Manifesting',
  'Marinating',
  'Moseying',
  'Mulling',
  'Musing',
  'Mustering',
  'Noodling',
  'Percolating',
  'Pondering',
  'Processing',
  'Puttering',
  'Puzzling',
  'Reticulating',
  'Ruminating',
  'Schlepping',
  'Shucking',
  'Simmering',
  'Smooshing',
  'Spelunking',
  'Spinning',
  'Stewing',
  'Synthesising',
  'Thinking',
  'Transmuting',
  'Unfurling',
  'Vibing',
  'Wibbling',
  'Working',
  'Wrangling'
] as const

export type WorkingWord = (typeof WORKING_WORDS)[number]

/**
 * A word that is not the one already on screen.
 *
 * Drawing uniformly from the whole list means roughly one swap in fifty-eight
 * lands on the word that is already there, and a tick where nothing changes
 * reads as the indicator having frozen — the exact thing it exists to rule out.
 * Excluding the current word costs a filter and removes that case entirely.
 */
export function nextWorkingWord(previous?: string, rand: () => number = Math.random): WorkingWord {
  const pool: readonly WorkingWord[] = previous
    ? WORKING_WORDS.filter((w) => w !== previous)
    : WORKING_WORDS
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)))
  return pool[index]
}
