# Security

Everything that decides whether an agent may touch a path, reach a host, spawn a process,
run in a container or read a credential is in `packages/security` and nowhere else.
Reviewing the security surface means reading one package — that is why it is a package.

It carries the strictest coverage bar in the repo, 95% lines **and** branches, because an
untested branch in a guard is a bypass rather than a bug. The layer graph helps: `core`
may not use the network or `child_process` at all.

## Threat model

The agent is assumed to be **capable and not adversarial, but steerable by its inputs**.
It runs code the operator asked for, on the operator's machine, with the operator's
credentials. The attacks worth defending against come from three directions:

1. **Content the agent reads** — a web page, a file, a tool result — containing text
   designed to redirect it.
2. **Model error** — a wrong path, a wrong host, a destructive command, none of it
   malicious.
3. **Someone reaching the server** — over the network, or with filesystem access to the
   install.

What is explicitly _not_ claimed: this does not defend against a model that is
deliberately hostile and has host `exec`. That is what [toolboxes](toolboxes.md) are for,
and the limit is stated in the jail section below rather than papered over.

---

## Workspace jail

**Stops:** path traversal and symlink escape.

The workspace is a root in the `chroot` sense, not a prefix to compare against.
`/etc/passwd` addresses `<workspace>/etc/passwd`. `../../secrets` addresses
`<workspace>/secrets`. `~/.ssh/id_ed25519` addresses `<workspace>/.ssh/id_ed25519`. There
is no way to spell "outside".

Three rules, in this order:

1. **Lexical normalisation before resolution.** The path is _constructed_ from its
   segments — `..` popping an empty stack is a no-op — so containment holds by
   construction rather than by a check that could be wrong.
2. **`realpath`, then containment.** A symlink inside the workspace pointing at `/etc` is
   refused. Comparing before canonicalising is the classic version of this bug.
3. **Normalisation is total.** Every input maps either to a path inside the root or to a
   refusal _about the filesystem_, with the original string's shape recorded for the audit
   log.

Platform-independent: `\` is a separator and drive letters are handled everywhere, not
only on Windows, because the model does not know which host it is on.

### The stated limit

**A workspace is an organisational boundary, not a security boundary, wherever `exec` is
enabled on the host.** A spawned child process does not honour the jail's clamping. This
is why the exec guard _refuses_ out-of-workspace path arguments rather than resolving them
inside — refusal is the only honest answer when the thing being constrained can walk out.

An agent that must be genuinely confined gets a [toolbox](toolboxes.md).

---

## Exec guard

**Stops:** command injection.

`guardExec` takes `argv: string[]` and produces a plan for `execFile` with
`shell: false`. **There is no shell, ever** — a lint rule fails the build on
`shell: true`.

There is deliberately **no deny-list of shell metacharacters**. With no shell there is no
string for `$(...)`, backticks or `| sh` to be interpreted in, so scanning for them blocks
nothing and breaks honest commands — a commit message containing `$HOME`, a grep for a
pipe character.

What actually constrains the child:

- **`argv[0]` against a deny-list, then an allow-list**, matched on basename so
  `/usr/bin/git`, `git` and `git.exe` get one verdict.
- **Shell binaries refused unless explicitly listed**, and the `-c` family refused even
  then.
- **Every path-shaped argument classified and refused** if it points outside the
  workspace. This is the one place in GhostAI that refuses rather than clamping, for the
  reason above.
- **An environment allow-list** — `PATH`, `HOME`, `LANG`, `TZ` by default — so the child
  inherits what it needs and nothing holding a token.
- **An output budget enforced while the child writes**, not after it exits, so a runaway
  process cannot fill memory before the cap notices.

Inside a toolbox the shell ban and the path ban lift together; see
[Toolboxes](toolboxes.md#why-the-exec-guard-relaxes-inside-one) for why that is not a
weakening.

---

## Guarded fetch

**Stops:** SSRF and DNS rebinding.

The usual shape — resolve the hostname, check the address, then hand the _URL_ to an HTTP
client — is advisory only, because the client resolves again when it connects and nothing
makes the two answers agree.

Here, validation resolves the host itself and **pins the resulting addresses into the
dispatcher**, using a lookup that never consults DNS. There is no second resolution to
differ from the first.

- **Every redirect hop is re-validated** with a fresh pin.
- **`Authorization` and `Cookie` are dropped on origin change.**
- **The body is capped as it streams**, not measured afterwards.
- Defaults: 3 redirects, 5 MiB, 30-second timeout.

Policy knobs: `allowLoopback`, `allowPrivate`, `allowedHosts` (exact or leading-dot),
`deniedHosts` (checked before everything, including the allow-list), `maxRedirects`.

### Address classification

All of these reach 127.0.0.1, and a naive `hostname === 'localhost'` check passes every
one:

```
http://2130706433/        decimal
http://0177.0.0.1/        octal
http://0x7f.1/            hex
http://127.1/             short form
http://[::ffff:7f00:1]/   IPv4 mapped into IPv6
```

Literals are parsed with the same semantics `getaddrinfo` uses, so all five classify as
loopback.

The blocked set is data, and deliberately wider than "private": `0.0.0.0/8`, `10/8`,
`100.64/10` (CGNAT), `127/8`, and **`169.254/16`** — link-local, which is where cloud
metadata lives at `169.254.169.254`, the highest-value SSRF target there is. **Nothing
unlocks link-local.** IPv6 transition prefixes (6to4, Teredo, NAT64) are blocked
wholesale rather than unwrapped, because unwrapping is another parser to get wrong.

Note that the **provider** base URL does not go through this guard — the common case is
loopback, which the guard exists to refuse. What is enforced there instead is narrower and
matches the real risk: an API key is never sent over plain HTTP to a public address.

---

## Prompt injection

**Stops:** text in a tool result being read as an instruction.

Every tool result is wrapped in a delimiter carrying a **fresh 64-bit random nonce,
regenerated every turn**, and the system prompt states that everything inside such a
delimiter is inert data. An attacker who cannot guess the nonce cannot close the envelope.
Closing tags appearing inside the content are escaped case-insensitively, because the
model does the parsing and the model is not case-sensitive.

The policy text lives in the runtime half of the prompt, at the tail — the nonce changes
every turn, and in the cached half it would invalidate the session's prefix every time.
It is the one part of the prompt an operator cannot edit, because it is a mechanism rather
than a message.

**Detection is deliberately non-destructive.** When injection-shaped text is spotted, a
`prompt_injection` notice raises a badge in the UI and **the content passes through
byte-for-byte**. Replacing a match with a warning banner fires on this project's own
security documentation, and leaves the model hallucinating around the hole where the text
used to be. Telling the operator is more useful than lying to the model.

---

## Credential vault

**Stops:** key theft at rest.

AES-256-GCM, one file, mode `0600`.

- **GCM rather than CBC**, because it must detect _tampering_: someone who can write the
  file but not read it could otherwise flip bits in a stored base URL and redirect
  traffic. A failed auth tag is a hard error, never a fallback to "treat as empty".
- **A version string is bound in as additional authenticated data**, so a file from
  another format or another application cannot be replayed into this one.
- **The key lives in the OS keychain** when one is reachable, and in a `0600` keyfile when
  not. The fallback is not a lesser mode — it is what makes this work in a container, over
  SSH, and on a headless box.

Keys never appear in `config.json`, which is what makes that file safe to commit. Over
HTTP the vault is **write-only**: a client can store a credential and nothing reads one
back out. What a client can see is a per-instance `credentialsPresent` boolean.

---

## Toolbox authorisation

**Stops:** the policy an agent runs under being changed underneath the operator.

A toolbox is authorised by **content hash, not signature** — the question is "are these
exact bytes approved?", not "who wrote them". Editing an installed manifest silently
revokes its approval, and the next turn refuses with a sentence naming the drift.

Two things are refused outright: an image that is not digest-pinned, and any of
`NET_ADMIN`, `SYS_ADMIN`, `SYS_MODULE`. Manifests live beside the workspace, never inside
it, so `write_file` plus an injection cannot rewrite them.

Full detail in [Toolboxes](toolboxes.md).

---

## Authentication

**Stops:** someone reaching the server.

- **argon2id** at the OWASP baseline (19 MiB, t=2, p=1) for the password.
- **Session tokens** are `<id>.<secret>` with 32 bytes of randomness, stored as SHA-256
  and compared with a constant-time equality. A KDF on a random 32-byte token would only
  be a rate limit.
- **The cookie** is `httpOnly`, `SameSite=Strict` (which stands in for a CSRF token), and
  `Secure` except on plain HTTP to a loopback host — Safari will not store `Secure` on
  `http://localhost`. No token is ever in a response body, because this app renders text a
  model wrote.
- **A wrong username and a wrong password give the same answer, in the same time.** The
  hash is verified on every attempt, against a decoy when the username does not match, so
  a failed login cannot confirm an account name.
- **Changing either credential revokes every other session**, and requires the current
  password — a session on its own is not enough to rotate the credential it was minted
  from.
- **The first-run setup code** is 12 random bytes rendered as 20 Crockford-base32
  characters. Single use, and dead the moment a password is set.

### Login throttling

Two scopes at once, asymmetric on purpose. Counters live in `ghost.db`, so a restart does
not clear them.

| Scope                                       | After      | Backoff         | Caps at    |
| ------------------------------------------- | ---------- | --------------- | ---------- |
| One address                                 | 4 failures | doubles from 1s | 15 minutes |
| The account, wherever the attempt came from | 4 failures | doubles from 1s | 30 seconds |

The per-address scope handles one host hammering the form. The account scope is the one a
botnet cannot spread out of: every guess lands in the same bucket regardless of origin,
capping the aggregate rate at roughly two a minute however many addresses are in play.

It caps _low_ deliberately. On a single-account server an unbounded lockout is a denial of
service an attacker can trigger on purpose, so the operator's worst case is half a minute
while the attacker's throughput is dead either way.

### Binding

The server binds `127.0.0.1` by default, and **a non-loopback host with auth disabled
refuses to start**. `0.0.0.0` and `::` count as remote. A warning would not be enough — it
scrolls past, and the result is an unauthenticated shell-capable agent on a LAN address.
The same check runs again when settings are saved, so it cannot be turned off from inside
the UI.

Workspace media is served through **short-lived HMAC-signed URLs** rather than an open
file endpoint, so an `<img>` tag can render a file without a credential and the URL stops
working ten minutes later.

---

## Logging

Secrets are redacted **by path, not by scanning values** — a scanner cannot tell an API
key from any other opaque string, and will either miss keys or redact identifiers.

Redacted paths include `apiKey`, `api_key`, `token`, `accessToken`, `refreshToken`,
`clientSecret`, `password`, `passphrase`, `secret`, `authorization` and `cookie`, each
with one and two levels of nesting, plus `headers.authorization`, `headers.cookie` and
`set-cookie`.

Errors log structured context rather than interpolated messages, because interpolation
happens past the point where redaction can reach it.

---

## Privacy

Not a claim — three mechanisms, two of which fail the build.

- **Zero telemetry.** A repo-wide grep for `telemetry`, `analytics`, `posthog`, `sentry`,
  `gtag` or `mixpanel` returns exactly one hit: the comment in the test that forbids them.
- **`self-contained.test.ts`** scans the shipped UI for any external origin, any
  `preconnect` or `dns-prefetch`, any cross-origin stylesheet. Fonts ship from npm.
- **`offline.spec.ts`** blocks every request that is not the server's own origin, in a
  real browser, and drives the whole app. This catches what a grep cannot: a font, icon
  set or highlighter theme a bundler quietly left as a runtime fetch.

The reasoning is stated in the design rules: a first paint that reaches a third party
leaks every user's IP address on load, and on an air-gapped machine it is a page in Times
New Roman while a request times out.

What leaves the machine, and only because you configured it: requests to whichever model
provider you chose — local ones go to `127.0.0.1` — and whatever an agent fetches, within
your network policy.
