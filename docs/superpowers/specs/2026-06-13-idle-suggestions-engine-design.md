# Idle-suggestions generation engine — slice 1 (cycle 89)

## Context / decision

`add-idle-suggestions` (next-step chips after the agent goes idle) is specced as
a DAEMON-side feature: send a synthetic "suggest next steps" prompt to the
session but suppress its transcript write + SSE fan-out. The gateway cannot
suppress those from outside the public SDK, so the faithful spec would breach the
zero-edit invariant. The user chose **option B**: the gateway generates
suggestions with its OWN model call — never touching the daemon session — and
surfaces them out-of-band. That sidesteps both the transcript pollution / viewer
noise / conversation-steering of an un-suppressed synthetic prompt AND the
zero-edit question.

## Slicing

- **Slice 1 (this cycle): the generation engine, inert library code + tests.**
  Config resolution + chat transport + response parser + the suggester
  orchestrator. NOT wired into the pump/SSE/route — nothing in the gateway
  runtime imports it yet, so there is zero behavior change.
- **Slice 2:** idle detection on the cycle-10 pump (a turn-completion
  `stopReason` flows through the events it already consumes) + a bounded
  transcript-tail reader + emit an `idle_suggestions` frame on the cycle-49
  owner-event SSE bus.
- **Slice 3:** web chips (fill-on-select, auto-expire) + `idle.yaml` config +
  the per-session `/suggest on|off` toggle + rate-limit.

## The one real risk: where transcript content is sent (advisor)

Option B's new exposure is that a suggestion call ships recent transcript
content (prompts, code, tool output) to an LLM endpoint. The project's posture is
"the workstation owns the context." So `resolveSuggestConfig` returns the
`(apiKey, baseUrl, model)` triple as a COHERENT SET from a SINGLE source, in
precedence order:

1. `QWEN_RC_SUGGEST_API_KEY` + `QWEN_RC_SUGGEST_BASE_URL` (dedicated pair).
2. `OPENAI_API_KEY` + `OPENAI_BASE_URL` (both required — a key without an
   explicit base is NOT used against a guessed host).
3. `DASHSCOPE_API_KEY` alone → the dashscope compatible-mode base is the
   unambiguous home of a dashscope key.

The model may be overridden by `QWEN_RC_SUGGEST_MODEL`/`OPENAI_MODEL` (not
host-sensitive). **No coherent key+host → `null` → the feature is inert, no calls
ever** — which also matches the spec's opt-in `enabled` default. We NEVER pair a
key from one source with a host from another (that would leak the user's content
and key to a host they never chose).

## Transport (built robust now; the pump reuses it in slice 2)

`createChatTransport` POSTs OpenAI-compatible `/chat/completions` with a Bearer
key. Two properties baked in from the start because they carry into the pump
path: a hard **timeout** (default 15 s) composed with any caller signal via
`AbortSignal.any` (a hung endpoint can't wedge the caller), and the caller feeds
a **bounded** context (slice 2's tail reader caps turns/bytes — tool outputs can
be huge). `fetchImpl` is injectable for tests.

## Parser (the production failure surface — spec I5)

`parseSuggestions` is TOTAL and never-throws; any malformed reply → `[]` (no UI
breakage, no transcript pollution). Handles: ```json fences; a prose preamble
before the array (bracket-span fallback ONLY after a whole-string parse fails, so
a valid non-array object is never bracket-mined); a JSON object instead of an
array → `[]`; non-string elements skipped; empty array / truncated JSON /
non-string input → `[]`. Survivors are whitespace-collapsed, capped at `max`(3),
ellipsis-truncated at`maxLen`.

## suggester

`generateSuggestions({turns, chat, max, signal, timeoutMs})` — builds a
system+user message pair from the recent turns, calls the transport, parses.
TOTAL: a transport error/timeout/abort or unparseable reply → `[]`; no turns →
`[]` (and no model call). It NEVER touches the daemon session.

## Verification

Unit tests: parser robustness across every realistic failure mode (the oracle);
`resolveSuggestConfig` coherent-set + no-mix + inert cases; transport request
shape (bearer/model/messages/URL) + non-2xx throw + aborted-signal via a fake
fetch; suggester orchestration (context fed, never-throws, no-turns no-call, max,
malformed→[]). Throwaway dist smoke: a local stub OpenAI-compatible server +
the real global `fetch` + `AbortSignal.any` → fenced reply parsed to suggestions;
inert when no key.

## Deferred (slices 2–3)

Idle detection + pump wiring + `idle_suggestions` SSE; bounded transcript-tail
reader; web chips; `idle.yaml` + `/suggest` toggle + rate-limit; Qwen OAuth
credential source (API-key/OpenAI-compatible only this slice).
