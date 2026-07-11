# Design — add-idle-suggestions

## Context

The session loop emits `session_update` with `stopReason: end_turn`
when the agent has finished its current response. From the daemon's
view this is the natural boundary for "a unit of work just
completed." After that frame, the session sits idle until the next
`/session/:id/prompt`.

This change watches for that boundary, waits a tunable interval,
sends a synthetic prompt to the agent asking for next-step
suggestions, and surfaces the parsed response as ephemeral chips —
not transcript messages. The agent is the same one already running
the session, so suggestions inherit full context naturally without
any custom prompt-engineering plumbing.

The key UX constraint is "don't pollute the transcript." Suggestions
must be visible, dismissible, ephemeral, and free of side effects.
Failure modes (model returns garbage, rate-limited, opted-out) must
fail silently.

## Goals / Non-Goals

**Goals:**

- Idle detection that doesn't accidentally fire while the agent is
  mid-tool-call or waiting for permission.
- Synthetic prompts that produce JSON suggestions reliably enough to
  surface ≥80% of the time, and drop silently when they don't.
- Cost transparency: every synthetic call attributable in
  `/rc/usage`.
- Per-session opt-out and global opt-out.

**Non-Goals:**

- A learning system. The synthetic prompt is the same every time;
  the agent's context is what changes.
- Suggesting tool calls directly (e.g., auto-running tests).
  Suggestions are text the user reviews before sending.
- Multi-language localization of the suggestion prompt (defer until
  qwen-code adds an i18n layer).
- Pushing suggestions off-device.

## Architecture

```
session_update stopReason=end_turn
            │
            ▼
   IdleWatcher (per session)
   - cancel any existing timer
   - if session opted-out → return
   - if rate limit exceeded → return
   - start timer (idleAfterSec)
            │
            ▼
   timer fires (no new prompt arrived)
            │
            ▼
   SyntheticEmitter
   - mark next ingester write with sub_actor = "idle-suggest"
   - send synthetic prompt via internal /session/:id/prompt path
     with `attribution: { synthetic: "idle-suggest" }`
            │
            ▼
   Agent returns response (normal session_update path)
            │
            ▼
   ResponseParser
   - intercept the synthetic response BEFORE transcript write
   - parse as JSON array of strings (best-effort: strip code-fence,
     trim, JSON.parse)
   - validate: array, 1-5 items, each 5-140 chars
   - on success → emit idle_suggestions SSE event,
     suppress transcript line
   - on failure → audit idle_suggest_parse_failed,
     suppress everything
```

The "intercept before transcript write" hook is the most invasive
part. We add a per-prompt flag `attribution.synthetic` that the
daemon's transcript writer and SSE fan-out check; when set, the
agent's response is consumed by the idle module and not forwarded.
The synthetic prompt itself is similarly suppressed from the
transcript (no point recording "Suggest 1-3 next steps…" in the
JSONL).

## Config file

`~/.qwen/rc/idle.yaml`:

```yaml
enabled: true
idleAfterSec: 60
maxSuggestionsPerHour: 5

# Operator-tunable; default suitable for English prompts.
syntheticPrompt: |
  Looking at our recent work, suggest 1-3 short next-step actions
  the user might want. Return ONLY a JSON array of strings, no
  prose. Each string ≤120 characters. If no good suggestion
  exists, return [].

# Rate limit is per-session unless overridden globally.
globalRateLimit: false
```

Hot-reloaded on file change (250 ms debounce, same primitive as the
rate table). Default file ships with these values; operators rarely
need to edit.

## Slash command

`/suggest [on|off|status]` toggles for the current session:

- `/suggest off` — disables for this session until end. The session
  state stores `idleSuggestEnabled: false`.
- `/suggest on` — re-enables (used after a previous off).
- `/suggest status` — replies with current state and how many were
  shown this hour.

This is a built-in command on the client side (because it's
session-scoped, not workspace-rooted). It posts a small endpoint
`POST /session/:id/idle-suggest-toggle { enabled: bool }` which
updates the session-state flag.

## Rate limiting

Per-session token bucket: `capacity = maxSuggestionsPerHour, refill
= 1 per (3600 / maxSuggestionsPerHour) seconds`. Default
(`5/hour`) gives one refill every 12 minutes.

When the bucket is empty, the IdleWatcher does not fire the
synthetic prompt and writes a single `idle_suggest_rate_limited`
audit (deduped per hour). The web client subscribes to this and
shows a subtle "Suggestions paused" badge near the input.

## Response parsing

The model is fallible. The parser:

1. Strips a leading/trailing markdown code fence
   (` ``` ` or ` ```json `).
2. Trims whitespace.
3. `JSON.parse` and confirm `Array.isArray(value)`.
4. For each element: confirm `typeof === 'string'`, 5–140 chars
   (after trim). Reject the whole response if any element fails.
5. Cap at 3 items (extra silently dropped).
6. Reject empty array entirely (no event emitted, no audit).

Failures emit audit `idle_suggest_parse_failed` with a one-line
reason (`not_json`, `not_array`, `element_invalid`). The raw model
output is NOT recorded in audit (it may contain sensitive context
summaries — see Threat model).

## SSE event shape

```jsonc
{
  "type": "idle_suggestions",
  "v": 1,
  "data": {
    "sessionId": "<id>",
    "suggestions": [
      "Run the test suite",
      "Update the changelog with the changes we made",
      "Commit and create a PR",
    ],
    "expiresAt": "<ISO-8601, default now + 5 min>",
    "rateLimitState": {
      "remainingThisHour": 4,
      "nextSlotAt": "<ISO>",
    },
  },
}
```

The `expiresAt` field signals the client to grey out / remove the
chips after the time elapses, so stale suggestions don't sit there
indefinitely.

## Decisions

### D1 — Reuse the session agent, do not call a separate model

**Choice**: The synthetic prompt is sent to the same agent child
that the session is using. Suggestions inherit context naturally.

**Alternative considered**: A separate small / cheap model gets a
summary of the session and produces suggestions.

**Why**: A separate model needs a context summary, which is itself
an expensive call. Reusing the session agent is simpler, has full
context, and the cost (one short response with `n_ctx` of the
session) is bounded.

**Cost**: The session model might be expensive (Qwen3-coder-plus).
For users on tight budgets, `maxSuggestionsPerHour: 0` disables;
plus the per-call cost is small (response capped to a few dozen
tokens).

### D2 — Suppress synthetic round-trip from transcript and SSE

**Choice**: The synthetic prompt and its response are both excluded
from the JSONL transcript and from `session_update` SSE
broadcasts. Only the parsed `idle_suggestions` event is emitted.

**Alternative considered**: Emit `session_update` frames with a
`synthetic: true` flag and let clients ignore.

**Why**: Pollution risk. A client that doesn't know about the flag
will render the synthetic content as a transcript line. Belt-and-
suspenders: suppress at source.

**Cost**: A debugging surprise ("why doesn't this Q&A show up in
the transcript?"). Mitigated by audit-logging the synthetic
emission with the resolved prompt and response in
`audit.log` under owner-only visibility.

### D3 — Chips don't auto-send; they fill the input

**Choice**: Tapping a chip puts its text into the prompt input
without sending. The user reviews and presses Enter / submits.

**Alternative considered**: Tap-to-send for fewer clicks.

**Why**: Suggestions are model-generated. Auto-sending makes the
agent the originator of prompts, which is conceptually wrong — and
opens a footgun where a bad suggestion runs immediately. Filling
preserves the user as the authoritative speaker.

**Cost**: One extra interaction per accepted suggestion. Trivial.

### D4 — Do NOT push suggestions via WebPush

**Choice**: `add-webpush-notifications` SHALL NOT include
`idle_suggestions` in its routable event types.

**Alternative considered**: Push to phone after a long idle so the
user sees a nudge on their lock screen.

**Why**: Suggestions necessarily summarize session context (the
model picks them based on what just happened). Pushing those off
the workstation, even to a paired phone, violates the principle
that the workstation is the trust boundary for session context. A
leaked push notification could expose work-in-progress.

**Cost**: No mobile nudge. Acceptable; the user opens the PWA when
they want to engage anyway.

### D5 — Sub-actor attribution for synthetic usage

**Choice**: Synthetic prompt's usage events are attributed with
`attribution_token_id = NULL` and `sub_actor = "idle-suggest"` so
the operator can filter or exclude them in `/rc/usage`.

**Alternative considered**: Attribute to the owner who triggered
the session.

**Why**: It's not the owner's fault when an idle suggestion runs;
attributing makes the per-token spend look inflated. Treating it as
a system-originated activity is cleaner.

**Cost**: The sub-actor namespace gains a "synthetic" namespace
(`idle-suggest`, future `auto-compact`, etc.) that doesn't match
the bridge `<kind>:<id>` regex. Spec note: the regex in
`add-bridge-protocol` requires `<kind>:<id>` shape, which
`idle-suggest` does NOT match (no `:`). We extend the audit-writer
to accept system-source sub-actors that match
`^_[a-z][a-z0-9-]{0,31}$`, OR adjust the bridge regex. Recommend
the latter: bridge regex allows OR prefix `_` for system-internal
sources. Update `add-bridge-protocol`'s sub-actor spec when this
ships.

## Threat model

| Attacker                                            | Capability                            | Mitigation                                                                           |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| Model emits prompt-injection content in suggestions | User taps and unwittingly sends it    | Chips do not auto-send; the user reviews. Plus, suggestions are short and visible.   |
| Sensitive context summarized into a suggestion      | Leak via push or shoulder-surfing     | No WebPush push (D4). Suggestions visible only to attached SSE subscribers in scope. |
| Compromised attached client                         | Race to read suggestions before owner | No different from other SSE content. Standard scope rules apply.                     |
| Cost amplification via short idleAfterSec           | Drain operator budget                 | Per-hour rate limit; operator owns the config; default conservative (5/hour).        |

## Risks

| Risk                                                           | Likelihood | Impact | Mitigation                                                                                                             |
| -------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Model rarely returns valid JSON                                | M          | M      | Tolerant parser (strip fences, trim). On persistent failure, suggestions just don't appear.                            |
| `end_turn` fires mid-tool-call inadvertently                   | L          | L      | Detect strictly: end_turn AND no pending permission_request.                                                           |
| User toggles `/suggest off`; setting forgotten in next session | M          | L      | Document scope (per session). Daemon default re-applies in new sessions.                                               |
| Multiple clients see different chips after a race              | L          | L      | Daemon is single source of truth; both clients receive identical SSE.                                                  |
| Idle-suggest model call interleaves with real prompt           | M          | M      | When a real prompt arrives mid-synthetic, daemon cancels suggestion (`AbortController`) and discards partial response. |

## Open questions

1. **Should `/suggest off` persist beyond the session?** Today it's
   per-session. An operator who hates suggestions sets `enabled:
false` in `idle.yaml`. A middle ground would be per-paired-
   client persistence (in `tokens.db`); probably overkill for v1.

2. **Are 3 chips the right cap?** Anthropic shows 3. We follow.

3. **Should the idle module respect bridge scopes — i.e., a
   Telegram session via the bridge should never get suggestions
   because the chat-service UX doesn't support chips well?** Leaning
   yes: skip idle suggestions for sessions whose currently-attached
   clients are all bridges. Phase 2 work.

4. **`expiresAt` default**: 5 minutes is a guess. If users routinely
   come back later and find the chips gone, raise to 30 minutes.
   Phase 3 review.
