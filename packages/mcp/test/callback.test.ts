/**
 * The one suite here that binds a port.
 *
 * It binds `127.0.0.1:0`, which is what `packages/server`'s own tests already
 * do, and the alternative — asserting the handler by calling a private method —
 * would prove nothing about the thing that matters: that a redirect arriving
 * from a browser reaches the right pending authorization.
 */

import { silentLogger } from '@ghostwire/core';
import { afterEach, describe, expect, it } from 'vitest';

import { CallbackListener } from '#src/callback.js';
import { manualClock } from '#testkit/clock.js';

const open: CallbackListener[] = [];

function listener(): {
  subject: CallbackListener;
  clock: ReturnType<typeof manualClock>;
} {
  const clock = manualClock();
  const subject = new CallbackListener({
    clock,
    logger: silentLogger,
    // Ephemeral, so a developer running the suite while a GhostAI is up does
    // not collide with its fixed port.
    port: 0,
  });
  open.push(subject);
  return { subject, clock };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

async function visit(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

describe('CallbackListener', () => {
  it('binds loopback and reports where a redirect should go', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);

    expect(handle.redirectUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/mcp\/callback$/,
    );
    expect(handle.state).toMatch(/^[0-9a-f]{24}$/);
    handle.cancel('done');
  });

  it('hands the code to the authorization that minted the state', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);

    const page = await visit(
      `${handle.redirectUrl}?code=the-code&state=${handle.state}`,
    );
    expect(page.status).toBe(200);
    expect(page.body).toContain('github');
    await expect(handle.code).resolves.toBe('the-code');
  });

  it('routes two outstanding authorizations by their own state', async () => {
    const { subject } = listener();
    const first = await subject.begin('github', 60_000);
    const second = await subject.begin('linear', 60_000);

    await visit(`${second.redirectUrl}?code=second&state=${second.state}`);
    await expect(second.code).resolves.toBe('second');

    await visit(`${first.redirectUrl}?code=first&state=${first.state}`);
    await expect(first.code).resolves.toBe('first');
  });

  it('refuses a state it is not waiting for', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);

    const page = await visit(`${handle.redirectUrl}?code=x&state=guessed`);
    expect(page.status).toBe(400);
    handle.cancel('done');
  });

  it('consumes a state once', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);
    await visit(`${handle.redirectUrl}?code=one&state=${handle.state}`);
    await expect(handle.code).resolves.toBe('one');

    // The listener stops with the last outstanding authorization, so a replay
    // has nothing to reach — which is the same answer as an unknown state.
    const replay = await fetch(
      `${handle.redirectUrl}?code=two&state=${handle.state}`,
    ).catch(() => undefined);
    expect(replay?.status).not.toBe(200);
  });

  it('reports a refusal from the authorization server', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);

    const page = await visit(
      `${handle.redirectUrl}?error=access_denied&error_description=nope&state=${handle.state}`,
    );
    expect(page.status).toBe(200);
    expect(page.body).toContain('nope');
    await expect(handle.code).rejects.toThrow(/refused/);
  });

  it('refuses a redirect that carried no code', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);

    const page = await visit(`${handle.redirectUrl}?state=${handle.state}`);
    expect(page.status).toBe(400);
    await expect(handle.code).rejects.toThrow(/no code/);
  });

  it('answers 404 for anything but the callback path', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);
    const base = handle.redirectUrl.replace('/mcp/callback', '');

    expect((await visit(`${base}/`)).status).toBe(404);
    handle.cancel('done');
  });

  it('gives up on the injected clock rather than waiting for real time', async () => {
    const { subject, clock } = listener();
    const handle = await subject.begin('github', 30_000);

    clock.advance(29_999);
    let settled = false;
    void handle.code.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    clock.advance(1);
    await expect(handle.code).rejects.toThrow(/not completed in time/);
  });

  it('bounds an authorization that asked for no timeout', async () => {
    // `0` is the schema's no-limit convention, and an authorization that can
    // never expire holds a listener open forever.
    const { subject, clock } = listener();
    const handle = await subject.begin('github', 0);
    clock.advance(5 * 60_000);
    await expect(handle.code).rejects.toThrow(/not completed in time/);
  });

  it('stops listening once nothing is outstanding', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);
    const url = handle.redirectUrl;
    handle.cancel('done');
    await expect(handle.code).rejects.toThrow();

    // An open port nobody is using is a surface with no purpose.
    await expect(fetch(url)).rejects.toThrow();
  });

  it('refuses everything outstanding when it closes', async () => {
    const { subject } = listener();
    const handle = await subject.begin('github', 60_000);
    await subject.close();
    await expect(handle.code).rejects.toThrow(/shutting down/);
  });
});
