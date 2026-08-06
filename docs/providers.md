# Providers

A provider is data; only a wire protocol is code. The registry is a table, and adding an
OpenAI-compatible endpoint means adding a row — or not even that, since `custom` takes any
base URL.

## The registry

| Type         | Wire               | Default base                                              | Env key              | Local | Notes                                  |
| ------------ | ------------------ | --------------------------------------------------------- | -------------------- | :---: | -------------------------------------- |
| `ollama`     | openai-chat        | `http://127.0.0.1:11434/v1`                               | —                    |  ✅   | Detected by port                       |
| `lmstudio`   | openai-chat        | `http://127.0.0.1:1234/v1`                                | —                    |  ✅   | Detected by port                       |
| `llamacpp`   | openai-chat        | `http://127.0.0.1:8080/v1`                                | —                    |  ✅   |                                        |
| `vllm`       | openai-chat        | `http://127.0.0.1:8000/v1`                                | `VLLM_API_KEY`       |  ✅   |                                        |
| `openrouter` | openai-chat        | `https://openrouter.ai/api/v1`                            | `OPENROUTER_API_KEY` |       | Gateway. Key prefix `sk-or-`. Caching. |
| `openai`     | openai-chat        | `https://api.openai.com/v1`                               | `OPENAI_API_KEY`     |       | Uses `max_completion_tokens`. Caching. |
| `anthropic`  | anthropic-messages | `https://api.anthropic.com/v1`                            | `ANTHROPIC_API_KEY`  |       | **See the note below.** Caching.       |
| `gemini`     | openai-chat        | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY`     |       | Google's OpenAI-compatible layer       |
| `deepseek`   | openai-chat        | `https://api.deepseek.com/v1`                             | `DEEPSEEK_API_KEY`   |       | Caching                                |
| `groq`       | openai-chat        | `https://api.groq.com/openai/v1`                          | `GROQ_API_KEY`       |       | Key prefix `gsk_`                      |
| `xai`        | openai-chat        | `https://api.x.ai/v1`                                     | `XAI_API_KEY`        |       |                                        |
| `custom`     | openai-chat        | _none — you must set `apiBase`_                           | `OPENAI_API_KEY`     |       | Only selected by name                  |

Every type except `anthropic` answers `GET /models`, so the UI's model question is a list
rather than a text box.

**Only the `openai-chat` adapter exists.** Four wire protocols are named
(`openai-chat`, `anthropic-messages`, `gemini-generate`, `openai-responses`) and one is
implemented. Selecting a wire that has no adapter is a loud configuration error, not a
silent fallback: `createProvider` refuses at construction rather than letting a
misconfiguration surface as a 404 mid-turn. Reaching one of those providers today means
pointing an instance at an endpoint that speaks `openai-chat`.

## Types and instances

`config.providers` is keyed by an **instance id you choose**, with `type` naming a
registry row. The same type can appear more than once, which is the only way to express
two Ollama servers:

```json
{
  "providers": {
    "ollama": { "type": "ollama" },
    "ollama-gpu": {
      "type": "ollama",
      "label": "GPU box",
      "apiBase": "http://gpu.lan:11434/v1"
    }
  }
}
```

The instance id is also the vault key for that instance's credential, so the two entries
above can hold different tokens. A local endpoint may carry one too — for a model server
behind an authenticating proxy.

A `config.json` written before instances existed is migrated on load and rewritten in
place: each key keeps its name and gains the matching `type`, so credentials already in
the vault keep resolving.

## Resolution

`agents.defaults.provider` — or an agent's own override — takes one of three forms:

1. **An instance id.** Exact, and the common case.
2. **A bare provider type.** Means "any enabled instance of that type, or a default one if
   none is configured", which is what keeps `ghost chat --provider ollama` working on a
   machine with no config file.
3. **`auto`.** Runs the resolution order: gateway and local detection by key prefix or
   base URL, then model-name keywords.

`auto` returns `null` rather than guessing when nothing matches. An empty `model` is a
separate condition — it means _unconfigured_, and every turn is refused with a message
saying so. There is no model-picking code anywhere; the setup wizard's model step is
skippable, and the UI treats an empty model as a question to answer rather than as
"choose for me".

Disabled instances are skipped by both resolution and model listing, but kept in the file.

## Credentials

Keys never appear in `config.json`. They live in the encrypted vault under the namespace
`providers`, keyed by instance id.

**The vault wins over the environment.** An env var is consulted only when the vault has
no entry for that instance — so a key set in the UI is not silently shadowed by a stale
shell export. The vault is opened only if `vault.json` already exists, so a local-only
install never creates a keychain entry it did not need.

Over HTTP the vault is write-only: `PUT /api/settings/credentials` stores one, and nothing
reads one back out. What a client can see is a per-instance `credentialsPresent` boolean.

The provider base URL deliberately does **not** go through `guardedFetch` — the common
case is loopback, which the SSRF guard exists to refuse. What is enforced instead is
narrower and matches the actual risk: an API key is never sent over plain HTTP to a public
address.

## Resilience

`withResilience` decorates both streaming and non-streaming calls. Its retry ladder is
declarative: on a rejection that names a parameter the endpoint does not support, it drops
`reasoning_effort`, then `tool_choice`, then images, then the oldest turns — each step a
narrower request rather than the same one again.

**A stream that has already emitted output is never retried.** Retrying it would either
duplicate text the user has read or silently replace it.

Errors are typed. `ProviderError` carries a `reason`, and nothing in the codebase branches
on a substring of a provider's message — a `notice` with kind `provider_fallback` or
`degraded` tells the operator when a request was narrowed to succeed.

## Token accounting

Two counters on purpose. A cheap `ceil(length / 4)` estimate is allocation-free and safe
in hot paths; a real tokenizer is loaded lazily on first use (about 40 ms and 50 MB) and
cached, for the places where accuracy matters.

Cached-prompt tokens are read back from the response and surfaced per turn, so the effect
of the [prompt caching split](prompts.md#two-halves-and-why) is visible in the UI's turn
info rather than merely asserted here.
