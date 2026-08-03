import type { LookupAddress } from 'node:dns';
import { type Server, createServer } from 'node:http';

import fc from 'fast-check';
import { Response } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isGhostError } from '@ghostai/core';

import {
  type DnsResolver,
  type FetchImplementation,
  type PinnedAddress,
  guardedFetch,
  pinnedLookup,
  systemResolver,
  validateTarget,
} from '#src/fetch.js';

const resolvesTo =
  (...addresses: readonly string[]): DnsResolver =>
  () =>
    Promise.resolve(
      addresses.map<PinnedAddress>((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly hasDispatcher: boolean;
  readonly body: unknown;
}

interface Recorder {
  readonly calls: RecordedCall[];
  readonly fetchImpl: FetchImplementation;
}

/** A fetch that records what it was asked to do and replays scripted responses. */
function recorder(...responses: readonly Response[]): Recorder {
  const calls: RecordedCall[] = [];
  let index = 0;
  return {
    calls,
    fetchImpl: (url, init) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        hasDispatcher: init.dispatcher !== undefined,
        body: init.body,
      });
      const response = responses[index] ?? new Response('ok', { status: 200 });
      index += 1;
      return Promise.resolve(response);
    },
  };
}

const redirect = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { location } });

const expectBlocked = async (
  promise: Promise<unknown>,
  match: RegExp,
): Promise<void> => {
  await expect(promise).rejects.toThrow(match);
  await promise.catch((error: unknown) => {
    expect(isGhostError(error)).toBe(true);
    if (!isGhostError(error)) return;
    expect(error.kind).toBe('network');
    // A blocked target stays blocked; retrying it only burns time.
    expect(error.retryable).toBe(false);
  });
};

describe('validateTarget: schemes and hosts', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'gopher://example.com',
    'data:text/plain,x',
  ])('refuses the scheme in %j', async (url) => {
    await expectBlocked(validateTarget(url), /Only http and https/);
  });

  it('refuses a string that is not a URL', async () => {
    await expect(validateTarget('not a url')).rejects.toThrow(/Not a URL/);
    await validateTarget('not a url').catch((error: unknown) => {
      expect(isGhostError(error) && error.kind).toBe('invalid_input');
    });
  });

  it.each(['http://', 'https://', 'http://@', 'https:// /'])(
    'refuses %j, which the URL parser rejects for lack of a host',
    async (url) => {
      await expect(validateTarget(url)).rejects.toThrow(/Not a URL/);
    },
  );

  it('accepts a public host and pins what the resolver returned', async () => {
    const target = await validateTarget('https://example.com/a?b=c', {
      resolver: resolvesTo('93.184.216.34'),
    });
    expect(target.host).toBe('example.com');
    expect(target.url).toBe('https://example.com/a?b=c');
    expect(target.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(target.exempt).toBe(false);
  });

  it('refuses a denied host before anything else', async () => {
    await expectBlocked(
      validateTarget('https://example.com/', {
        deniedHosts: ['example.com'],
        allowedHosts: ['example.com'],
        resolver: resolvesTo('93.184.216.34'),
      }),
      /denied by configuration/,
    );
  });

  it('matches a leading-dot denied entry against subdomains', async () => {
    await expectBlocked(
      validateTarget('https://api.internal.example/', {
        deniedHosts: ['.internal.example'],
      }),
      /denied by configuration/,
    );
    await expectBlocked(
      validateTarget('https://internal.example/', {
        deniedHosts: ['.internal.example'],
      }),
      /denied by configuration/,
    );
  });

  it('ignores empty entries in a host list', async () => {
    const target = await validateTarget('https://example.com/', {
      deniedHosts: ['', '   '],
      resolver: resolvesTo('93.184.216.34'),
    });
    expect(target.exempt).toBe(false);
  });
});

describe('validateTarget: address literals', () => {
  it.each([
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://127.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fe80::1]/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://[fc00::1]/',
    'http://0.0.0.0/',
    'http://[64:ff9b::7f00:1]/',
  ])('refuses %s', async (url) => {
    await expectBlocked(validateTarget(url), /blocked range/);
  });

  it('permits loopback only when the policy says so', async () => {
    await expectBlocked(
      validateTarget('http://127.0.0.1:11434/api/chat'),
      /blocked range/,
    );
    const target = await validateTarget('http://127.0.0.1:11434/api/chat', {
      allowLoopback: true,
    });
    expect(target.addresses).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });

  it('permits IPv6 loopback under the same flag', async () => {
    const target = await validateTarget('http://[::1]:11434/', {
      allowLoopback: true,
    });
    expect(target.addresses).toEqual([{ address: '::1', family: 6 }]);
  });

  it('permits private ranges only when the policy says so', async () => {
    await expectBlocked(validateTarget('http://10.1.2.3/'), /blocked range/);
    await expect(
      validateTarget('http://10.1.2.3/', { allowPrivate: true }),
    ).resolves.toBeDefined();
  });

  it('never unlocks link-local, whatever is allowed', async () => {
    // 169.254.169.254 is the cloud metadata endpoint. No flag reaches it.
    await expectBlocked(
      validateTarget('http://169.254.169.254/', {
        allowLoopback: true,
        allowPrivate: true,
      }),
      /blocked range/,
    );
  });

  it('lets an allow-listed host past the address check', async () => {
    const target = await validateTarget('http://127.0.0.1:11434/', {
      allowedHosts: ['127.0.0.1'],
    });
    expect(target.exempt).toBe(true);
  });

  it('leaves a routable literal alone', async () => {
    await expect(validateTarget('https://8.8.8.8/')).resolves.toMatchObject({
      addresses: [{ address: '8.8.8.8', family: 4 }],
    });
  });
});

describe('validateTarget: resolution', () => {
  it('refuses a name that resolves into a blocked range', async () => {
    await expectBlocked(
      validateTarget('http://rebind.example/', {
        resolver: resolvesTo('169.254.169.254'),
      }),
      /resolves to 169\.254\.169\.254/,
    );
  });

  it('refuses when any one of several answers is blocked', async () => {
    // The connection may use any of them, so one poisoned answer blocks the set.
    await expectBlocked(
      validateTarget('http://rebind.example/', {
        resolver: resolvesTo('93.184.216.34', '127.0.0.1'),
      }),
      /blocked range/,
    );
  });

  it('refuses an IPv6 answer in a blocked range', async () => {
    await expectBlocked(
      validateTarget('http://rebind.example/', {
        resolver: resolvesTo('fd00::1'),
      }),
      /blocked range/,
    );
  });

  it('refuses an answer it cannot parse', async () => {
    await expectBlocked(
      validateTarget('http://weird.example/', {
        resolver: resolvesTo('not-an-address'),
      }),
      /unparseable address/,
    );
  });

  it('reports an empty answer as a network failure', async () => {
    await expect(
      validateTarget('http://void.example/', {
        resolver: () => Promise.resolve([]),
      }),
    ).rejects.toThrow(/Cannot resolve host/);
  });

  it('wraps a resolver failure', async () => {
    const failing: DnsResolver = () => Promise.reject(new Error('ENOTFOUND'));
    await validateTarget('http://void.example/', { resolver: failing }).catch(
      (error: unknown) => {
        expect(isGhostError(error) && error.kind).toBe('network');
      },
    );
    await expect(
      validateTarget('http://void.example/', { resolver: failing }),
    ).rejects.toThrow(/Cannot resolve host/);
  });

  it('skips classification for an allow-listed name but still pins it', async () => {
    const target = await validateTarget('http://ollama.internal/', {
      allowedHosts: ['.internal'],
      resolver: resolvesTo('10.0.0.5'),
    });
    expect(target.exempt).toBe(true);
    expect(target.addresses).toEqual([{ address: '10.0.0.5', family: 4 }]);
  });

  it('resolves through node:dns by default', async () => {
    // localhost is the one name guaranteed to resolve without a network.
    const addresses = await systemResolver('localhost');
    expect(addresses.length).toBeGreaterThan(0);
    for (const entry of addresses) expect([4, 6]).toContain(entry.family);
  });

  it('uses node:dns when no resolver is injected', async () => {
    // Which is how `localhost` gets blocked: the name is innocuous, the answer
    // is not.
    await expectBlocked(
      validateTarget('http://localhost:11434/'),
      /blocked range/,
    );
    await expect(
      validateTarget('http://localhost:11434/', { allowLoopback: true }),
    ).resolves.toMatchObject({ host: 'localhost' });
  });
});

describe('pinnedLookup', () => {
  const addresses: readonly PinnedAddress[] = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800::1', family: 6 },
  ];

  it('answers the all: true shape used by autoSelectFamily', () => {
    const callback = vi.fn();
    pinnedLookup(addresses)('example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800::1', family: 6 },
    ]);
  });

  it('answers the single-address shape', () => {
    const callback = vi.fn();
    pinnedLookup(addresses)('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('filters to the requested family', () => {
    const callback = vi.fn();
    pinnedLookup(addresses)('example.com', { family: 6 }, callback);
    expect(callback).toHaveBeenCalledWith(null, '2606:2800::1', 6);
  });

  it('fails when nothing was pinned at all', () => {
    const callback = vi.fn();
    pinnedLookup([])('example.com', {}, callback);
    const error = callback.mock.calls[0]?.[0] as NodeJS.ErrnoException;
    expect(error.code).toBe('ENOTFOUND');
    expect(error.message).toContain('family any');
  });

  it('fails rather than substituting another family', () => {
    const callback = vi.fn();
    pinnedLookup([{ address: '93.184.216.34', family: 4 }])(
      'example.com',
      { family: 6 },
      callback,
    );
    const error = callback.mock.calls[0]?.[0] as NodeJS.ErrnoException;
    expect(error.code).toBe('ENOTFOUND');
  });

  it('never consults DNS, whatever hostname it is handed', () => {
    // The whole point: the second resolution cannot differ from the first
    // because there is no second resolution.
    const callback = vi.fn();
    pinnedLookup(addresses)(
      'attacker-controlled.example',
      { all: true },
      callback,
    );
    const answered = callback.mock.calls[0]?.[1] as LookupAddress[];
    expect(answered.map((entry) => entry.address)).toEqual([
      '93.184.216.34',
      '2606:2800::1',
    ]);
  });
});

describe('guardedFetch', () => {
  const publicResolver = resolvesTo('93.184.216.34');

  it('fetches, reports the pinned address, and passes a dispatcher', async () => {
    const fetcher = recorder(new Response('hello', { status: 200 }));
    const result = await guardedFetch('https://example.com/x', {
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });

    expect(await result.response.text()).toBe('hello');
    expect(result.url).toBe('https://example.com/x');
    expect(result.address).toBe('93.184.216.34');
    expect(result.redirects).toEqual([]);
    expect(fetcher.calls[0]?.hasDispatcher).toBe(true);
  });

  it('sends the method, headers and body it was given', async () => {
    const fetcher = recorder(new Response('ok'));
    await guardedFetch('https://example.com/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      },
      body: '{"a":1}',
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(fetcher.calls[0]).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret',
      },
    });
  });

  it('refuses the request before connecting when the target is blocked', async () => {
    const fetcher = recorder();
    await expectBlocked(
      guardedFetch('http://169.254.169.254/latest/meta-data/', {
        fetchImpl: fetcher.fetchImpl,
      }),
      /blocked range/,
    );
    expect(fetcher.calls).toEqual([]);
  });

  it('follows a redirect and re-validates the next hop', async () => {
    const fetcher = recorder(
      redirect('https://example.org/final'),
      new Response('landed'),
    );
    const result = await guardedFetch('https://example.com/start', {
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(result.url).toBe('https://example.org/final');
    expect(result.redirects).toEqual(['https://example.org/final']);
    expect(await result.response.text()).toBe('landed');
  });

  it('refuses a redirect into a blocked range', async () => {
    // The classic two-step SSRF: a public URL that 302s to the metadata service.
    const fetcher = recorder(
      redirect('http://169.254.169.254/latest/meta-data/'),
    );
    await expectBlocked(
      guardedFetch('https://example.com/start', {
        resolver: publicResolver,
        fetchImpl: fetcher.fetchImpl,
      }),
      /blocked range/,
    );
    expect(fetcher.calls).toHaveLength(1);
  });

  it('re-resolves each hop rather than reusing the first pin', async () => {
    const resolver = vi
      .fn<DnsResolver>()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    const fetcher = recorder(
      redirect('https://elsewhere.example/x'),
      new Response('ok'),
    );
    const result = await guardedFetch('https://example.com/', {
      resolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(result.address).toBe('1.1.1.1');
  });

  it('drops credentials when the origin changes', async () => {
    const fetcher = recorder(
      redirect('https://attacker.example/collect'),
      new Response('ok'),
    );
    await guardedFetch('https://example.com/', {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=1',
        Accept: 'text/html',
      },
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(fetcher.calls[1]?.headers).toEqual({ accept: 'text/html' });
  });

  it('keeps credentials on a same-origin redirect', async () => {
    const fetcher = recorder(
      redirect('https://example.com/next'),
      new Response('ok'),
    );
    await guardedFetch('https://example.com/', {
      headers: { Authorization: 'Bearer secret' },
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(fetcher.calls[1]?.headers).toMatchObject({
      authorization: 'Bearer secret',
    });
  });

  it('turns a 303 into a GET and drops the body', async () => {
    const fetcher = recorder(
      redirect('https://example.com/result', 303),
      new Response('ok'),
    );
    await guardedFetch('https://example.com/submit', {
      method: 'POST',
      body: 'a=1',
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(fetcher.calls[1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('keeps the method on a 307', async () => {
    const fetcher = recorder(
      redirect('https://example.com/result', 307),
      new Response('ok'),
    );
    await guardedFetch('https://example.com/submit', {
      method: 'POST',
      body: 'a=1',
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(fetcher.calls[1]).toMatchObject({ method: 'POST', body: 'a=1' });
  });

  it('stops after the redirect limit', async () => {
    const fetcher = recorder(
      redirect('https://example.com/1'),
      redirect('https://example.com/2'),
      redirect('https://example.com/3'),
    );
    await expectBlocked(
      guardedFetch('https://example.com/0', {
        maxRedirects: 2,
        resolver: publicResolver,
        fetchImpl: fetcher.fetchImpl,
      }),
      /Too many redirects/,
    );
  });

  it('treats a redirect with no location as the final response', async () => {
    const fetcher = recorder(new Response('body', { status: 302 }));
    const result = await guardedFetch('https://example.com/', {
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(result.response.status).toBe(302);
  });

  it('refuses a redirect to something that is not a URL', async () => {
    const fetcher = recorder(redirect('http://['));
    await expectBlocked(
      guardedFetch('https://example.com/', {
        resolver: publicResolver,
        fetchImpl: fetcher.fetchImpl,
      }),
      /not a URL/,
    );
  });

  it('resolves a relative redirect against the current hop', async () => {
    const fetcher = recorder(redirect('/next'), new Response('ok'));
    const result = await guardedFetch('https://example.com/deep/path', {
      resolver: publicResolver,
      fetchImpl: fetcher.fetchImpl,
    });
    expect(result.url).toBe('https://example.com/next');
  });

  it('wraps a transport failure', async () => {
    const failing: FetchImplementation = () =>
      Promise.reject(new Error('ECONNREFUSED'));
    await guardedFetch('https://example.com/', {
      resolver: publicResolver,
      fetchImpl: failing,
    }).catch((error: unknown) => {
      expect(isGhostError(error) && error.kind).toBe('network');
      expect(isGhostError(error) && error.message).toMatch(
        /Request to example\.com failed/,
      );
    });
    await expect(
      guardedFetch('https://example.com/', {
        resolver: publicResolver,
        fetchImpl: failing,
      }),
    ).rejects.toThrow(/failed/);
  });

  it('passes an abort signal through, and honours one already aborted', async () => {
    const fetcher = recorder(new Response('ok'));
    const controller = new AbortController();
    controller.abort();
    await guardedFetch('https://example.com/', {
      signal: controller.signal,
      timeoutMs: 0,
      resolver: publicResolver,
      fetchImpl: (url, init) => {
        expect(init.signal?.aborted).toBe(true);
        return fetcher.fetchImpl(url, init);
      },
    });
  });

  it('omits the signal entirely when there is neither a caller signal nor a timeout', async () => {
    await guardedFetch('https://example.com/', {
      timeoutMs: 0,
      resolver: publicResolver,
      fetchImpl: (url, init) => {
        expect(init.signal).toBeUndefined();
        return Promise.resolve(new Response('ok'));
      },
    });
  });

  describe('body cap', () => {
    const streamOf = (chunks: readonly string[]): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          },
        }),
      );

    it('errors the stream once the budget is exceeded', async () => {
      const result = await guardedFetch('https://example.com/', {
        maxBytes: 8,
        resolver: publicResolver,
        fetchImpl: () => Promise.resolve(streamOf(['12345', '67890'])),
      });
      await expect(result.response.text()).rejects.toThrow(/exceeded 8 bytes/);
    });

    it('passes a body that fits', async () => {
      const result = await guardedFetch('https://example.com/', {
        maxBytes: 16,
        resolver: publicResolver,
        fetchImpl: () => Promise.resolve(streamOf(['12345', '67890'])),
      });
      expect(await result.response.text()).toBe('1234567890');
    });

    it('leaves the body alone when the cap is disabled', async () => {
      const result = await guardedFetch('https://example.com/', {
        maxBytes: 0,
        resolver: publicResolver,
        fetchImpl: () => Promise.resolve(streamOf(['a'.repeat(1000)])),
      });
      expect((await result.response.text()).length).toBe(1000);
    });

    it('handles a response with no body', async () => {
      const result = await guardedFetch('https://example.com/', {
        resolver: publicResolver,
        fetchImpl: () => Promise.resolve(new Response(null, { status: 204 })),
      });
      expect(result.response.status).toBe(204);
    });

    it('preserves status and headers through the cap', async () => {
      const result = await guardedFetch('https://example.com/', {
        maxBytes: 64,
        resolver: publicResolver,
        fetchImpl: () =>
          Promise.resolve(
            new Response('body', {
              status: 201,
              headers: { 'x-trace': 'abc' },
            }),
          ),
      });
      expect(result.response.status).toBe(201);
      expect(result.response.headers.get('x-trace')).toBe('abc');
    });
  });
});

describe('against a real server, through the real dispatcher', () => {
  /**
   * The tests above inject a fetch, which proves the policy. These prove the
   * plumbing: that a pinned `Agent` actually connects, and that the address
   * validation resolved is the one the socket uses. A mocked transport cannot
   * show that, because the pin only exists in the connector.
   */
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect-to-metadata') {
        response.writeHead(302, {
          location: 'http://169.254.169.254/latest/meta-data/',
        });
        response.end();
        return;
      }
      if (request.url === '/big') {
        response.writeHead(200);
        response.end('x'.repeat(4096));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`served ${request.headers.host ?? ''}`);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('fetches over the pinned dispatcher', async () => {
    const result = await guardedFetch(`${origin}/hello`, {
      allowLoopback: true,
    });
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toContain('served 127.0.0.1');
    expect(result.address).toBe('127.0.0.1');
  });

  it('sends the Host header for the name, not the pinned address', async () => {
    // The pin changes where the socket goes, never what the request says.
    const result = await guardedFetch(
      `${origin.replace('127.0.0.1', 'localhost')}/hello`,
      {
        allowLoopback: true,
      },
    );
    expect(await result.response.text()).toContain('served localhost');
  });

  it('refuses a real redirect into a blocked range', async () => {
    await expect(
      guardedFetch(`${origin}/redirect-to-metadata`, { allowLoopback: true }),
    ).rejects.toThrow(/blocked range/);
  });

  it('caps a real response body', async () => {
    const result = await guardedFetch(`${origin}/big`, {
      allowLoopback: true,
      maxBytes: 1024,
    });
    await expect(result.response.text()).rejects.toThrow(/exceeded 1024 bytes/);
  });

  it('reports a refused connection as a network error', async () => {
    // Port 1 on loopback: nothing listens, and the failure is immediate.
    await expect(
      guardedFetch('http://127.0.0.1:1/', { allowLoopback: true }),
    ).rejects.toThrow(/Request to 127\.0\.0\.1 failed/);
  });

  it('still refuses a blocked target with the real transport in place', async () => {
    await expect(
      guardedFetch('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/blocked range/);
  });
});

describe('property: no blocked address is reachable', () => {
  /**
   * Whatever encoding is used and whichever position the blocked answer takes,
   * `guardedFetch` must refuse before the transport is invoked. The assertion is
   * on the fetch never being called, not merely on the rejection: a guard that
   * connects first and complains afterwards has already leaked.
   */
  const blockedHost = fc.constantFrom(
    '127.0.0.1',
    '2130706433',
    '0177.0.0.1',
    '0x7f000001',
    '127.1',
    '[::1]',
    '[::ffff:127.0.0.1]',
    '169.254.169.254',
    '0xa9fea9fe',
    '10.0.0.1',
    '192.168.0.1',
    '172.20.1.1',
    '[fc00::1]',
    '[fe80::1]',
    '0.0.0.0',
    '[::]',
    '224.0.0.1',
  );

  it('holds for literals in the URL', async () => {
    await fc.assert(
      fc.asyncProperty(
        blockedHost,
        fc.constantFrom('http', 'https'),
        async (host, scheme) => {
          const fetcher = recorder();
          await expect(
            guardedFetch(`${scheme}://${host}/x`, {
              fetchImpl: fetcher.fetchImpl,
            }),
          ).rejects.toThrow();
          expect(fetcher.calls).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('holds for names that resolve to a blocked address', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          '127.0.0.1',
          '169.254.169.254',
          '10.0.0.1',
          'fd00::1',
          '::1',
        ),
        async (address) => {
          const fetcher = recorder();
          await expect(
            guardedFetch('https://rebind.example/', {
              resolver: resolvesTo(address),
              fetchImpl: fetcher.fetchImpl,
            }),
          ).rejects.toThrow();
          expect(fetcher.calls).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
