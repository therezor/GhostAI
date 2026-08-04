import { describe, expect, it } from 'vitest';

import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
} from '#src/spinner.js';
import { visibleWidth } from '#src/text.js';

describe('spinnerFrame', () => {
  it('walks the frames in order and wraps round', () => {
    // A function of a tick rather than an object with a timer: the timer
    // belongs to whoever is waiting, and that is what keeps this synchronous.
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(1)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrame(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
  });

  it('accepts a negative tick rather than returning nothing', () => {
    expect(spinnerFrame(-1)).toBe(SPINNER_FRAMES.at(-1));
  });

  it('is one column wide in every frame, so the row never reflows under it', () => {
    for (const frame of SPINNER_FRAMES) {
      expect(visibleWidth(frame)).toBe(1);
    }
  });

  it('suggests an interval a rotation reads well at', () => {
    expect(SPINNER_INTERVAL_MS).toBeGreaterThan(0);
    expect(SPINNER_INTERVAL_MS).toBeLessThan(250);
  });
});
