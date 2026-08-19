/**
 * The pino record, as a line.
 *
 * The cases that matter are the ones where a formatter can lose information:
 * a line that is not JSON, a record that is not one of ours, and a field whose
 * value is an object. Losing a log line to the thing that was meant to make it
 * readable is worse than showing an ugly one.
 */

import { describe, expect, it } from 'vitest';

import { paletteFor, stripAnsi } from '@ghostwire/tui';

import { formatLogLine } from '#src/log-line.js';

/** The identity palette, so every assertion below is about text. */
const PLAIN = paletteFor(false);

const record = (fields: Record<string, unknown>): string =>
  `${JSON.stringify({ level: 40, time: 1786007865399, name: 'ghost', ...fields })}\n`;

const format = (line: string, colors = PLAIN): string =>
  formatLogLine(line, colors);

describe('formatLogLine', () => {
  it('puts the sentence first, where a reader looks', () => {
    const line = format(record({ msg: 'something happened' }));
    expect(line).toBe('warn  something happened\n');
  });

  it('keeps the context, after the sentence rather than before it', () => {
    // The real case: the memory warning, which is worth reading and was
    // previously buried in a hundred characters of JSON.
    const line = format(
      record({
        memory: 'milestones',
        file: '/w/memory/milestones.md',
        msg: 'memory has no description; skipped',
      }),
    );

    expect(line).toBe(
      'warn  memory has no description; skipped · ' +
        'memory=milestones file=/w/memory/milestones.md\n',
    );
  });

  it('drops the fields every record carries and none identify it by', () => {
    // `time` because the line is read as it happens, `name` because it is
    // `ghostai` on every line this will ever see.
    const line = format(record({ pid: 4, hostname: 'h', msg: 'hi' }));
    expect(line).toBe('warn  hi\n');
  });

  it('names each level, and prints an unknown one as itself', () => {
    expect(format(record({ level: 30, msg: 'x' }))).toContain('info ');
    expect(format(record({ level: 50, msg: 'x' }))).toContain('error ');
    expect(format(record({ level: 60, msg: 'x' }))).toContain('fatal ');
    expect(format(record({ level: 35, msg: 'x' }))).toContain('35 ');
  });

  it('passes a line that is not JSON through untouched', () => {
    // A crash writes here too, and its output is not a record. Swallowing it
    // would hide the one thing worth seeing.
    const raw = 'Error: connect ECONNREFUSED 127.0.0.1:11434\n';
    expect(format(raw)).toBe(raw);
  });

  it('passes a JSON line that is not a record through untouched', () => {
    expect(format('[1,2,3]\n')).toBe('[1,2,3]\n');
    expect(format('"a string"\n')).toBe('"a string"\n');
    expect(format('null\n')).toBe('null\n');
  });

  it('passes a record with no message through as its JSON', () => {
    // Not one of ours — a library logging its own shape. Its JSON says more
    // than a level and a blank would.
    const line = `${JSON.stringify({ level: 40, other: 1 })}\n`;
    expect(format(line)).toBe(line);
  });

  it('flattens an object field rather than walking into it', () => {
    // A nested `err` is one fact about the line, not several — and walking in
    // would rebuild the wall of JSON this exists to remove.
    const line = format(
      record({ err: { code: 'ENOENT' }, msg: 'read failed' }),
    );
    expect(line).toBe('warn  read failed · err={"code":"ENOENT"}\n');
  });

  it('collapses newlines in a value, so one record stays one line', () => {
    const line = format(record({ detail: 'a\n  b', msg: 'x' }));
    expect(line).toBe('warn  x · detail=a b\n');
  });

  it('truncates a long value rather than wrapping the terminal', () => {
    const line = format(record({ blob: 'x'.repeat(400), msg: 'x' }));
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(200);
  });

  it('leaves an empty line alone', () => {
    expect(format('')).toBe('');
    expect(format('\n')).toBe('\n');
  });
});

describe('colour', () => {
  // The palette the CLI actually builds, so `dim` here is the bright black
  // production emits rather than the faint attribute it stopped emitting.
  const COLOUR = paletteFor(true);
  // `@ghostwire/tui`'s own, rather than a regex here. A literal escape character
  // is what `no-control-regex` rejects and what `grep` goes blind to — this
  // file already had one, invisible in every read of it.
  const strip = stripAnsi;

  it('paints a warning and an error differently', () => {
    const warned = formatLogLine(record({ msg: 'x' }), COLOUR);
    const failed = formatLogLine(record({ level: 50, msg: 'x' }), COLOUR);

    expect(warned).toContain(COLOUR.yellow('warn'));
    expect(failed).toContain(COLOUR.red('error'));
    expect(warned).not.toBe(failed);
  });

  it('dims the context but not the sentence', () => {
    // The sentence is what a reader is scanning for; the fields say which thing
    // it is about, which only matters once the sentence has been read.
    const line = formatLogLine(
      record({ file: '/w/a.md', msg: 'skipped' }),
      COLOUR,
    );

    expect(line).toContain('skipped');
    expect(line).toContain(COLOUR.dim('· file=/w/a.md'));
  });

  it('says the level in words, so colour is never the only signal', () => {
    // `@ghostwire/tui`'s theme states this rule. Under NO_COLOR, in a pipe, or to
    // a reader who cannot tell the yellow from the red, `warn` still reads.
    const line = formatLogLine(record({ msg: 'x' }), COLOUR);

    expect(strip(line)).toBe('warn  x\n');
  });

  it('is byte-identical to the plain form under an identity palette', () => {
    // What `--no-color` and `NO_COLOR` both reduce to — one branch, not a
    // second code path that can drift.
    const line = record({ file: '/w/a.md', msg: 'skipped' });

    expect(formatLogLine(line, PLAIN)).toBe(strip(formatLogLine(line, COLOUR)));
  });
});
