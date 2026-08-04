/**
 * The one animated thing in this package.
 *
 * A pure function of a tick rather than an object that owns a timer, because
 * the timer belongs to whoever is waiting — it is the caller that knows when the
 * work started and when it stopped, and a component holding an interval is a
 * component a test has to wait for. Feeding it a counter keeps every assertion
 * about it synchronous.
 */

/**
 * Braille dots, which are one column wide and animate by rotation rather than
 * by changing width — so the row they sit on never reflows under them.
 */
export const SPINNER_FRAMES: readonly string[] = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
];

/** How often a caller should advance the tick for the rotation to read well. */
export const SPINNER_INTERVAL_MS = 80;

/** The frame for a tick. Any integer, including a negative one. */
export function spinnerFrame(tick: number): string {
  const count = SPINNER_FRAMES.length;
  const at = ((Math.trunc(tick) % count) + count) % count;
  return SPINNER_FRAMES[at] ?? SPINNER_FRAMES[0] ?? '';
}
