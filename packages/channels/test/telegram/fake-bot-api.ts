/**
 * Telegram, as a queue of canned answers.
 *
 * Not a testkit: it lives beside the tests that use it because nothing outside
 * this package has a Telegram channel to drive. What it replaces is the network
 * — every test in `test/telegram/` runs against this, so the suite opens no
 * socket and the paths that only a broken API produces (a 429 with a
 * `retry_after`, a 409, a body that is not JSON) are reachable at all.
 *
 * `getUpdates` is the one method with a life of its own: it resolves when a
 * test pushes an update and otherwise parks, which is what lets the poll loop
 * be driven a step at a time instead of raced against a timer.
 */

import type {
  FetchLike,
  TelegramMessage,
  TelegramUpdate,
} from '#src/telegram/api.js';

/** One recorded call: the method and the body it was given. */
export interface RecordedCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** What a canned answer looks like. Either an envelope or a transport throw. */
export interface CannedAnswer {
  readonly status?: number;
  readonly body?: unknown;
  /** A network failure — `fetch` itself rejecting. */
  readonly throws?: Error;
}

const OK = (result: unknown): CannedAnswer => ({
  status: 200,
  body: { ok: true, result },
});

export class FakeBotApi {
  readonly calls: RecordedCall[] = [];
  /** Queued answers per method; the last one repeats once the queue empties. */
  private readonly queued = new Map<string, CannedAnswer[]>();
  private readonly pending: TelegramUpdate[] = [];
  private waiting: (() => void) | undefined;
  private nextMessageId = 100;

  /** The `fetch` a `BotApi` is built over. */
  get fetch(): FetchLike {
    return async (url, init) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      const body = JSON.parse(init.body) as Record<string, unknown>;
      this.calls.push({ method, body });

      const answer = await this.answerFor(method, init.signal);
      if (answer.throws !== undefined) throw answer.throws;
      return {
        status: answer.status ?? 200,
        json: async () => await Promise.resolve(answer.body),
      };
    };
  }

  /** Queues one answer for the next call to `method`. */
  reply(method: string, answer: CannedAnswer): this {
    const queue = this.queued.get(method) ?? [];
    queue.push(answer);
    this.queued.set(method, queue);
    return this;
  }

  /** Queues a Telegram-shaped failure. */
  fail(
    method: string,
    input: {
      code: number;
      description?: string;
      retryAfterSec?: number;
      status?: number;
    },
  ): this {
    return this.reply(method, {
      status: input.status ?? input.code,
      body: {
        ok: false,
        error_code: input.code,
        description: input.description ?? 'failed',
        ...(input.retryAfterSec === undefined
          ? {}
          : { parameters: { retry_after: input.retryAfterSec } }),
      },
    });
  }

  /** A user typing, or a button being pressed. Wakes a parked `getUpdates`. */
  push(
    update: Omit<TelegramUpdate, 'update_id'> & { update_id?: number },
  ): void {
    this.pending.push({
      update_id: update.update_id ?? this.pending.length + 1,
      ...update,
    });
    this.waiting?.();
    this.waiting = undefined;
  }

  /** Every call to one method, oldest first. */
  bodies(method: string): Array<Record<string, unknown>> {
    return this.calls
      .filter((call) => call.method === method)
      .map((call) => call.body);
  }

  /** The `text` of everything the bot posted or edited, oldest first. */
  texts(): string[] {
    return this.calls
      .filter(
        (call) =>
          call.method === 'sendMessage' || call.method === 'editMessageText',
      )
      .map((call) =>
        typeof call.body.text === 'string' ? call.body.text : '',
      );
  }

  private async answerFor(
    method: string,
    signal: AbortSignal | undefined,
  ): Promise<CannedAnswer> {
    const queue = this.queued.get(method);
    if (queue !== undefined && queue.length > 0) {
      // The last queued answer stays, so a test that wants "and 429 forever"
      // queues it once.
      return queue.length === 1 ? queue[0]! : queue.shift()!;
    }

    switch (method) {
      case 'getMe':
        return OK({ id: 1, username: 'ghost_test_bot' });
      case 'getUpdates':
        return OK(await this.drain(signal));
      case 'sendMessage':
      case 'editMessageText': {
        this.nextMessageId += 1;
        const message: TelegramMessage = {
          message_id: this.nextMessageId,
          chat: { id: 1, type: 'private' },
        };
        return OK(message);
      }
      default:
        return OK(true);
    }
  }

  /**
   * Whatever has arrived, or a park until something does.
   *
   * The park is what makes the poll loop testable: without it `getUpdates`
   * returns an empty array immediately and the loop spins as fast as the event
   * queue allows, burning the test's timeout instead of waiting like a real
   * long poll.
   */
  private async drain(
    signal: AbortSignal | undefined,
  ): Promise<readonly TelegramUpdate[]> {
    if (this.pending.length === 0) {
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        signal?.addEventListener('abort', () => {
          resolve();
        });
      });
    }
    return this.pending.splice(0);
  }
}

/** A message update, with the boilerplate a private chat always carries. */
export function messageUpdate(input: {
  text: string;
  userId?: number;
  chatId?: number;
  updateId?: number;
}): Omit<TelegramUpdate, 'update_id'> & { update_id?: number } {
  const userId = input.userId ?? 42;
  const chatId = input.chatId ?? userId;
  return {
    ...(input.updateId === undefined ? {} : { update_id: input.updateId }),
    message: {
      message_id: 1,
      chat: { id: chatId, type: chatId === userId ? 'private' : 'supergroup' },
      from: { id: userId, username: 'tester' },
      text: input.text,
      ...(input.text.startsWith('/')
        ? {
            entities: [
              {
                type: 'bot_command',
                offset: 0,
                length: input.text.split(' ')[0]?.length ?? 0,
              },
            ],
          }
        : {}),
    },
  };
}

/** A button press. */
export function callbackUpdate(input: {
  data: string;
  userId?: number;
  chatId?: number;
  messageId?: number;
}): Omit<TelegramUpdate, 'update_id'> & { update_id?: number } {
  const userId = input.userId ?? 42;
  const chatId = input.chatId ?? userId;
  return {
    callback_query: {
      id: 'cbq-1',
      from: { id: userId, username: 'tester' },
      data: input.data,
      message: {
        message_id: input.messageId ?? 100,
        chat: {
          id: chatId,
          type: chatId === userId ? 'private' : 'supergroup',
        },
      },
    },
  };
}
