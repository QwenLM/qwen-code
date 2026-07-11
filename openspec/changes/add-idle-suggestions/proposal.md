# add-idle-suggestions

## Why

When the agent finishes a unit of work and the user goes quiet, the
session sits idle until a human types the next prompt. New users
often don't know what they could ask next; experienced users
sometimes appreciate a reminder of follow-ups they would otherwise
forget ("run the tests," "update the changelog," "stage and commit
this"). Anthropic's `code.claude.com` ships "next-step suggestions"
after the agent's reply; qwen-code has no equivalent.

A naive implementation pollutes the transcript with model-suggested
follow-ups every turn, which most users find noisy. The right
implementation is opt-in, rate-limited, surfaced as chips below the
input (not as transcript messages), and clearly attributed so the
cost is auditable.

## What Changes

- **Opt-in config.** `~/.qwen/rc/idle.yaml` controls per-daemon
  defaults: `enabled: bool, idleAfterSec: int, maxSuggestionsPerHour:
int`. A per-session `/suggest on|off` slash command overrides
  the default for that session.
- **Idle detection.** A session is "idle" after a
  `session_update.stopReason: end_turn` AND no new
  `/session/:id/prompt` arrives within `idleAfterSec` (default 60).
- **Suggestion mechanism.** When a session goes idle and the
  per-hour rate limit allows, the daemon emits a synthetic prompt
  to the same agent child (the prompt text is operator-configurable,
  default: "Suggest 1-3 short next-step actions the user might
  want. Return JSON array of strings.").
- **Capture, do not insert.** The response is parsed, validated as a
  JSON array of strings, and rendered as a single SSE event of new
  type `idle_suggestions` with payload `{ suggestions: string[],
expiresAt }`. The model's response text is NOT appended to the
  session transcript (no JSONL line written), and no
  `session_update` is forwarded to subscribers.
- **Client rendering.** Web and terminal clients render the
  suggestions as chips below the input. Tapping or pressing a chip
  fills the prompt input box (does not auto-send).
- **Cost attribution.** The synthetic call still consumes tokens.
  The usage event is attributed with `attribution_token_id = null`
  and `sub_actor = "idle-suggest"` so `/rc/usage` filtering can
  isolate or exclude it.
- **Privacy default.** Suggestions are NOT pushed via WebPush. They
  could leak session context summaries; pushing them off-device by
  default would violate the principle that the workstation owns the
  context.

## Capabilities

### New Capabilities

- `idle-suggestions` — config file schema and per-session toggle,
  idle-detection algorithm, synthetic prompt emission, response
  parsing and validation, the `idle_suggestions` SSE event,
  rate-limiting, cost attribution for the synthetic call, and the
  client-side rendering contract (chips, fill-on-select).

## User Stories

**I1. New user gets a nudge.** I just finished my first qwen-code
task. After 60 seconds of no input, three chips appear below the
input box: `[Run the tests]` `[Show me git status]` `[Summarize
what we did]`. I tap "Run the tests"; the prompt input fills with
that text; I review it and press Enter.

**I2. Power user toggles off.** I work in deep focus and don't want
suggestions. I run `/suggest off` once; for the rest of the session
no idle suggestions fire. My setting persists for this session id;
new sessions inherit the daemon default.

**I3. Cost transparency.** I notice my daily Qwen bill went up. In
the Usage panel I filter by `sub_actor = idle-suggest` and see
$0.04 in synthetic prompts today. I edit `idle.yaml` to lower the
hourly cap from 5 to 2.

**I4. Rate-limit avoided spam.** The agent finishes 8 small tasks
in 10 minutes. The first 5 trigger suggestions; the 6th–8th do not
(per-hour cap reached). A subtle indicator in the web client shows
"Suggestions paused (rate limit)."

**I5. Bad model response is dropped.** The model returns
"`\ntext\n`" instead of valid JSON. The daemon parses, fails,
emits no `idle_suggestions` event, audit-logs
`idle_suggest_parse_failed`. No transcript pollution, no broken UI.

## Impact

- **qwen-code repo**: new module
  `packages/cli/src/serve/remoteControl/idle/` containing the idle
  detector, the synthetic-prompt emitter, the response parser, and
  rate-limit accounting. One new SSE event type (`idle_suggestions`).
  One new slash command (`/suggest`) for per-session toggle.
- **Web client**: chip component below the input box; listens for
  `idle_suggestions` and renders.
- **Terminal client**: same renderer in Ink/React; numbered
  shortcuts (`Alt-1`, `Alt-2`, `Alt-3`) to fill.
- **Interaction with `add-cost-tracking`**: usage events from
  idle-suggest carry `sub_actor: "idle-suggest"`. No other code
  changes required from the cost-tracking side.
- **Capability advertisement**: `/capabilities` gains
  `remoteControl.idleSuggestions: { enabled, idleAfterSec,
maxSuggestionsPerHour }`.
- **Out of scope** (deliberately):
  - Cross-session learning ("the user usually asks X after Y").
  - RAG over past sessions to inform suggestions.
  - Pushing suggestions via WebPush.
  - Auto-accepting a suggestion if the user is gone for a long
    time.
  - Different model for suggestions (uses whatever the session
    uses).
  - Personalized suggestions based on the operator's profile.
