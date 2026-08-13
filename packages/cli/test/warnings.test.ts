import { describe, expect, it, vi } from 'vitest';

import { silenceSqliteExperimentalWarning } from '#src/warnings.js';

function fakeProcess(): {
  target: NodeJS.Process;
  emitted: ReturnType<typeof vi.fn>;
} {
  const emitted = vi.fn();
  const target = { emitWarning: emitted } as unknown as NodeJS.Process;
  return { target, emitted };
}

const SQLITE = 'SQLite is an experimental feature and might change at any time';

describe('silenceSqliteExperimentalWarning', () => {
  it('drops the warning Node emits when node:sqlite loads', () => {
    const { target, emitted } = fakeProcess();
    silenceSqliteExperimentalWarning(target);

    target.emitWarning(SQLITE, 'ExperimentalWarning');

    expect(emitted).not.toHaveBeenCalled();
  });

  it('drops it in the options-object spelling too', () => {
    const { target, emitted } = fakeProcess();
    silenceSqliteExperimentalWarning(target);

    target.emitWarning(SQLITE, { type: 'ExperimentalWarning' });

    expect(emitted).not.toHaveBeenCalled();
  });

  it('lets every other experimental warning through, unchanged', () => {
    // The whole reason this is a predicate rather than `--no-warnings`: the
    // next experimental API somebody reaches for by accident still says so.
    const { target, emitted } = fakeProcess();
    silenceSqliteExperimentalWarning(target);

    target.emitWarning('Type stripping is an experimental feature', {
      type: 'ExperimentalWarning',
      code: 'ExperimentalWarning',
    });

    expect(emitted).toHaveBeenCalledWith(
      'Type stripping is an experimental feature',
      { type: 'ExperimentalWarning', code: 'ExperimentalWarning' },
    );
  });

  it('keeps the same text under another type, which is a real warning', () => {
    const { target, emitted } = fakeProcess();
    silenceSqliteExperimentalWarning(target);

    target.emitWarning(SQLITE, 'DeprecationWarning');

    expect(emitted).toHaveBeenCalledWith(SQLITE, 'DeprecationWarning');
  });

  it('keeps a warning with no type at all', () => {
    const { target, emitted } = fakeProcess();
    silenceSqliteExperimentalWarning(target);

    target.emitWarning(SQLITE);

    expect(emitted).toHaveBeenCalledWith(SQLITE);
  });

  it('reads an Error the same way it reads a string', () => {
    const { target, emitted } = fakeProcess();
    silenceSqliteExperimentalWarning(target);

    target.emitWarning(new Error(SQLITE), 'ExperimentalWarning');
    target.emitWarning(new Error('something else'), 'ExperimentalWarning');

    expect(emitted).toHaveBeenCalledTimes(1);
    expect(emitted.mock.calls[0]?.[0]).toMatchObject({
      message: 'something else',
    });
  });

  it('puts the emitter back when the undo is called', () => {
    const { target, emitted } = fakeProcess();
    const restore = silenceSqliteExperimentalWarning(target);

    restore();
    target.emitWarning(SQLITE, 'ExperimentalWarning');

    expect(emitted).toHaveBeenCalledWith(SQLITE, 'ExperimentalWarning');
  });
});
