import { createTranscript } from '#src/transcript.js';
import { describe, expect, it } from 'vitest';

describe('taking writes the way a stream does', () => {
  it('joins fragments that do not end on a line break', () => {
    // Which is how a streamed answer arrives: `the par`, `ser is`, `\n`.
    const transcript = createTranscript();
    transcript.write('the par');
    transcript.write('ser is');
    transcript.write(' split\n');

    expect(transcript.lines).toEqual(['the parser is split', '']);
  });

  it('reports whether the last thing written ended a line', () => {
    const transcript = createTranscript();
    expect(transcript.atLineStart).toBe(true);

    transcript.write('half');
    expect(transcript.atLineStart).toBe(false);

    transcript.write('\n');
    expect(transcript.atLineStart).toBe(true);
  });
});

describe('drawing', () => {
  it('refolds at the width it is asked for rather than the one it took', () => {
    // The whole reason the conversation is kept as text: a narrower window
    // re-wraps the paragraph instead of clipping it.
    const transcript = createTranscript();
    transcript.write('one two three four five six\n');

    expect(transcript.render(40)).toEqual(['one two three four five six', '']);
    expect(transcript.render(12)).toEqual([
      'one two',
      'three four',
      'five six',
      '',
    ]);
  });

  it('hands back the same rows between writes', () => {
    // The renderer's diff compares row against row on every keystroke. Rebuilt
    // strings would make typing cost the length of the conversation.
    const transcript = createTranscript();
    transcript.write('a line\n');

    expect(transcript.render(40)).toBe(transcript.render(40));
  });

  it('rebuilds after a write', () => {
    const transcript = createTranscript();
    transcript.write('first\n');
    const before = transcript.render(40);
    transcript.write('second\n');

    expect(transcript.render(40)).not.toBe(before);
    expect(transcript.render(40)).toEqual(['first', 'second', '']);
  });
});

describe('a style that spans a line break', () => {
  const ESC = String.fromCharCode(27);
  const DIM = `${ESC}[2m`;
  const OFF = `${ESC}[22m`;

  it('re-opens it on the line below, because every row is drawn on its own', () => {
    // The shape a streamed chunk of reasoning actually has: `"\n\nLet me"`,
    // dimmed whole. The opener lands on the line above, which the terminal has
    // already drawn, so the first words of the paragraph rendered plain white
    // against dim grey — "the first letter of a sentence is not grey".
    const transcript = createTranscript();
    transcript.write(`${DIM}tools.${OFF}`);
    transcript.write(`${DIM}\n\nLet me think${OFF}`);

    const rows = transcript.render(80);
    expect(rows.at(-1)?.startsWith(DIM)).toBe(true);
    expect(rows.at(-1)).toContain('Let me think');
  });

  it('closes the line it leaves, so the style does not bleed downward', () => {
    const transcript = createTranscript();
    transcript.write(`${DIM}open`);
    transcript.write('\nplain');

    expect(transcript.lines[0]?.endsWith(`${ESC}[0m`)).toBe(true);
  });

  it('still reports the start of a line when the style is all that is on it', () => {
    const transcript = createTranscript();
    transcript.write(`${DIM}done\n`);

    expect(transcript.atLineStart).toBe(true);
  });
});

describe('bounds', () => {
  it('drops the oldest lines in blocks rather than one at a time', () => {
    // One at a time would shift every row on every write, and a shifted row
    // zero costs a full redraw — which is the expensive path, once per line.
    const transcript = createTranscript();
    for (let at = 0; at < 12_001; at += 1) {
      transcript.write(`line ${String(at)}\n`);
    }

    expect(transcript.lines.length).toBeLessThan(12_001);
    expect(transcript.lines.at(-2)).toBe('line 12000');
  });
});
