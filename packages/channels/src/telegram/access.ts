/**
 * Who is allowed to drive this install from Telegram.
 *
 * This is the security boundary, and it is worth being blunt about what is on
 * the other side of it: a bot username is discoverable, and behind this bot is
 * an agent with the operator's credentials, their workspace and — depending on
 * the permission map — `exec`. An unguarded bot is a remote shell that anybody
 * who guesses `@something_bot` can reach.
 *
 * So the rules here are the strict ones:
 *
 *  - **An empty allowlist denies everyone, and the channel refuses to start.**
 *    Deny-by-default is only half of it: a channel that started and silently
 *    answered nobody would look identical to a broken token, so the refusal is
 *    what turns a misconfiguration into a sentence at startup.
 *  - **The sender is checked, not the chat.** In a group, being in the room is
 *    not permission — the group has to be listed *and* so does the person
 *    typing. Checking the chat alone would hand the agent to everyone else in
 *    it.
 *  - **A button press is checked exactly like a message.** Anyone in a group
 *    can tap a button the bot posted, so an approval answered from an inline
 *    keyboard is an authorisation decision arriving from an unauthenticated
 *    source unless it goes through here too.
 *
 * It is its own module, rather than a few lines inside the channel, so that the
 * package's coverage gate measures it on its own and a new branch here has to
 * bring a test with it.
 */

/** One parsed allowlist entry. */
interface AllowedParty {
  /** The Telegram id. Positive for a user, negative for a group. */
  readonly id: number;
  /** Whatever the operator wrote after the pipe. For logs, never matched on. */
  readonly label: string | undefined;
}

/** Who is asking, and where. */
interface Requester {
  /** `from.id` — the person, on a message or on a button press. */
  readonly userId: number;
  /** `chat.id` — equal to `userId` in a private chat, negative in a group. */
  readonly chatId: number;
}

/**
 * Reads `<id>` or `<id>|<label>`.
 *
 * A malformed entry throws rather than being skipped. Skipping it would narrow
 * the allowlist by one without saying so, and the symptom — one person the bot
 * has stopped answering — is a long way from the typo that caused it.
 */
export function parseAllowlist(
  entries: readonly string[],
): readonly AllowedParty[] {
  return entries.map((entry) => {
    const [rawId = '', ...rest] = entry.split('|');
    const id = Number(rawId.trim());
    if (!Number.isSafeInteger(id) || id === 0) {
      throw new Error(
        `channels.telegram.allowlist entry "${entry}" is not a Telegram id. ` +
          'Use the numeric id, optionally as "<id>|<label>".',
      );
    }
    const label = rest.join('|').trim();
    return { id, label: label === '' ? undefined : label };
  });
}

/**
 * The allowlist, as the channel consults it.
 *
 * Built once at startup so a malformed entry fails there rather than on the
 * first message from the person it was meant to admit.
 */
export class AccessList {
  private readonly allowed: ReadonlySet<number>;
  private readonly adminIds: ReadonlySet<number>;
  private readonly parties: readonly AllowedParty[];
  /** Ids already logged, so a stranger cannot fill the disk. Capped. */
  private readonly reported = new Set<number>();

  constructor(input: {
    readonly allowlist: readonly string[];
    readonly admins: readonly string[];
  }) {
    this.parties = parseAllowlist(input.allowlist);
    this.allowed = new Set(this.parties.map((party) => party.id));
    this.adminIds = new Set(parseAllowlist(input.admins).map((a) => a.id));
  }

  /** Everyone on the list, for the startup log line. */
  get members(): readonly AllowedParty[] {
    return this.parties;
  }

  get empty(): boolean {
    return this.allowed.size === 0;
  }

  /**
   * Whether this request may be acted on at all.
   *
   * A private chat needs only the sender. A group needs the group *and* the
   * sender, because membership of a room is not a decision the operator made.
   */
  permits(requester: Requester): boolean {
    if (!this.allowed.has(requester.userId)) return false;
    const isGroup = requester.chatId !== requester.userId;
    return !isGroup || this.allowed.has(requester.chatId);
  }

  /**
   * Whether this request may run a command that reaches past its own chat.
   *
   * An empty `admins` means every allowed sender is one, so the distinction
   * costs a single-operator install nothing.
   */
  admits(requester: Requester): boolean {
    if (!this.permits(requester)) return false;
    return this.adminIds.size === 0 || this.adminIds.has(requester.userId);
  }

  /**
   * Whether this refusal is the first from that id, and so worth a log line.
   *
   * Silence is the right reply to a stranger — answering confirms the bot is
   * live and spends the rate limit on them — but silence with no trace leaves
   * the operator no way to admit the person they actually meant to. One line
   * per id is the whole onboarding path: message the bot, read the log, add the
   * id, restart.
   */
  shouldReport(userId: number): boolean {
    // Bounded, because the ids arriving here are chosen by whoever is knocking.
    if (this.reported.size >= 1000) return false;
    if (this.reported.has(userId)) return false;
    this.reported.add(userId);
    return true;
  }
}
