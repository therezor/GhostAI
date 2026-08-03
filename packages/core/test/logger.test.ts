import { describe, expect, it } from 'vitest';

import { REDACT_CENSOR, createLogger, silentLogger } from '#src/logger.js';

interface Capture {
  readonly destination: { write(chunk: string): void };
  readonly lines: () => Record<string, unknown>[];
}

function capture(): Capture {
  const chunks: string[] = [];
  return {
    destination: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
    lines: () => chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('emits structured JSON', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info({ tool: 'read_file' }, 'executing');

    expect(sink.lines()[0]).toMatchObject({ msg: 'executing', tool: 'read_file' });
  });

  it('tags lines with a component name', () => {
    const sink = capture();
    createLogger({ name: 'agent', destination: sink.destination }).info('up');
    expect(sink.lines()[0]).toMatchObject({ name: 'agent' });
  });

  it('adds base fields to every line', () => {
    const sink = capture();
    const log = createLogger({ base: { sessionKey: 'web:1' }, destination: sink.destination });
    log.info('one');
    log.info('two');

    expect(sink.lines().every((line) => line.sessionKey === 'web:1')).toBe(true);
  });

  it('stamps epoch milliseconds so log time matches stored time', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info('x');

    const time = sink.lines()[0]?.time;
    expect(typeof time).toBe('number');
    expect(time).toBeGreaterThan(1_600_000_000_000);
  });

  it('defaults to info and drops debug', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.destination });
    log.debug('invisible');
    log.info('visible');

    expect(sink.lines()).toHaveLength(1);
  });

  it('reads the level from the environment', () => {
    const sink = capture();
    createLogger({ destination: sink.destination, env: { GHOSTAI_LOG_LEVEL: 'debug' } }).debug('d');
    expect(sink.lines()).toHaveLength(1);
  });

  it('falls back to LOG_LEVEL', () => {
    const sink = capture();
    createLogger({ destination: sink.destination, env: { LOG_LEVEL: 'debug' } }).debug('d');
    expect(sink.lines()).toHaveLength(1);
  });

  it('prefers an explicit level over the environment', () => {
    const sink = capture();
    const log = createLogger({
      level: 'error',
      destination: sink.destination,
      env: { GHOSTAI_LOG_LEVEL: 'debug' },
    });
    log.info('dropped');
    log.error('kept');

    expect(sink.lines()).toHaveLength(1);
  });

  it('survives an unrecognised level rather than failing at boot', () => {
    const sink = capture();
    // Losing the logger to a typo also loses the diagnostics needed to find it.
    const log = createLogger({ destination: sink.destination, env: { LOG_LEVEL: 'chatty' } });
    log.info('still works');
    expect(sink.lines()).toHaveLength(1);
  });
});

describe('redaction', () => {
  it('redacts a top-level secret', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info({ apiKey: 'sk-live-123' }, 'x');
    expect(sink.lines()[0]?.apiKey).toBe(REDACT_CENSOR);
  });

  it('redacts one level down', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info({ provider: { apiKey: 'sk-1' } }, 'x');
    expect(sink.lines()[0]?.provider).toEqual({ apiKey: REDACT_CENSOR });
  });

  it('redacts inside a keyed record of providers', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info(
      { providers: { openai: { apiKey: 'sk-1' } } },
      'x',
    );
    expect(sink.lines()[0]?.providers).toEqual({ openai: { apiKey: REDACT_CENSOR } });
  });

  it('redacts request headers', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info(
      { headers: { authorization: 'Bearer abc', 'content-type': 'application/json' } },
      'x',
    );

    expect(sink.lines()[0]?.headers).toEqual({
      authorization: REDACT_CENSOR,
      'content-type': 'application/json',
    });
  });

  it('covers the common secret field names', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info(
      {
        token: 'a',
        accessToken: 'b',
        refreshToken: 'c',
        password: 'd',
        secret: 'e',
        clientSecret: 'f',
        cookie: 'g',
      },
      'x',
    );

    const line = sink.lines()[0] ?? {};
    for (const field of [
      'token',
      'accessToken',
      'refreshToken',
      'password',
      'secret',
      'clientSecret',
      'cookie',
    ]) {
      expect(line[field]).toBe(REDACT_CENSOR);
    }
  });

  it('leaves ordinary fields untouched', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info({ model: 'qwen3', tokens: 42 }, 'x');
    expect(sink.lines()[0]).toMatchObject({ model: 'qwen3', tokens: 42 });
  });

  it('cannot reach a secret interpolated into the message', () => {
    const sink = capture();
    createLogger({ destination: sink.destination }).info(`key=sk-live-123`);
    // Documents why the convention is to log structured context: redaction is
    // by path, and a message string has no paths.
    expect(sink.lines()[0]?.msg).toContain('sk-live-123');
  });
});

describe('silentLogger', () => {
  it('accepts calls and writes nothing', () => {
    expect(() => {
      silentLogger.error({ apiKey: 'x' }, 'ignored');
      silentLogger.info('ignored');
    }).not.toThrow();
  });
});
