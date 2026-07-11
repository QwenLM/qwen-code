# idle-suggestions — spec delta

## ADDED Requirements

### Requirement: Config file and reload

The daemon SHALL load `~/.qwen/rc/idle.yaml` with at minimum these
fields:

```yaml
enabled: true
idleAfterSec: 60
maxSuggestionsPerHour: 5
syntheticPrompt: '<operator-tunable prompt text>'
```

The daemon SHALL watch the file for changes with a 250 ms debounce.
On parse error the daemon SHALL retain the previous good config in
memory AND emit an audit event `idle_config_parse_failed`.

#### Scenario: Default shipped config is valid

- **GIVEN** a fresh install with no edits to `idle.yaml`
- **WHEN** the daemon starts
- **THEN** the loader applies the shipped defaults
- **AND** `/capabilities`'s `remoteControl.idleSuggestions.enabled`
  is `true`

#### Scenario: Edit hot-reloads

- **GIVEN** the daemon is running with `maxSuggestionsPerHour: 5`
- **WHEN** the operator edits the file to `maxSuggestionsPerHour: 2`
- **THEN** within 500 ms subsequent rate-limit checks use the new
  bucket size

#### Scenario: Parse error keeps old config

- **WHEN** the file is overwritten with malformed YAML
- **THEN** the previously loaded config remains in effect
- **AND** an audit event `idle_config_parse_failed` is written

### Requirement: Idle detection

A session SHALL be considered "idle" exactly when:

1. The most recent `session_update` on the session carried
   `stopReason: end_turn`, AND
2. No `permission_request` is outstanding on the session, AND
3. No `/session/:id/prompt` request has arrived for at least
   `idleAfterSec` seconds since condition (1) became true.

While the timer is active, the daemon SHALL cancel the pending idle
firing immediately upon any real (non-synthetic) prompt arrival.

#### Scenario: end_turn starts the timer

- **GIVEN** session `S` with idle suggestions enabled and
  `idleAfterSec: 60`
- **WHEN** the agent emits `session_update` with `stopReason:
end_turn`
- **THEN** the daemon schedules an idle firing 60 s later

#### Scenario: User prompt cancels

- **GIVEN** the timer is scheduled to fire in 30 s
- **WHEN** a user prompt arrives via `POST /session/:id/prompt`
- **THEN** the timer is cancelled
- **AND** no synthetic prompt is sent

#### Scenario: Pending permission blocks scheduling

- **GIVEN** the session has an outstanding `permission_request`
- **WHEN** `session_update.stopReason: end_turn` is emitted
- **THEN** the daemon does NOT schedule an idle firing
- **AND** the firing is scheduled when the permission resolves AND
  no prompt has arrived since

### Requirement: Synthetic round-trip suppression

When the daemon fires a synthetic idle-suggest prompt to the agent,
both the synthetic prompt itself AND the agent's response to it
SHALL be excluded from:

- the session's JSONL transcript at
  `~/.qwen/projects/<cwd>/chats/<sid>.jsonl`
- the session's SSE event stream (no `session_update`,
  `prompt_received`, or similar frames emitted to subscribers for
  the synthetic round-trip)
- the SSE event ring used for `Last-Event-ID` replay

The daemon SHALL record one owner-visible audit entry
`idle_suggest_round_trip` per synthetic round-trip containing the
synthetic prompt text, the raw response text, and the parse outcome.

#### Scenario: Subscribers see no synthetic frames

- **GIVEN** a client attached to session `S` via SSE
- **WHEN** the daemon performs a synthetic idle-suggest round-trip
- **THEN** the client receives zero `session_update` frames for
  that round-trip
- **AND** the client may receive at most one `idle_suggestions`
  frame (depending on parse outcome)

#### Scenario: Transcript unchanged

- **GIVEN** the JSONL transcript file before the synthetic firing
- **WHEN** the synthetic round-trip completes
- **THEN** the transcript file has the same byte count plus only
  what subsequent NORMAL prompts add — no synthetic content

### Requirement: Rate limit

The daemon SHALL enforce a per-session token bucket with capacity
`maxSuggestionsPerHour` and refill `1 token / (3600 /
maxSuggestionsPerHour) seconds`. When empty, the daemon SHALL skip
the synthetic firing AND emit a deduped (≤1 per hour per session)
audit event `idle_suggest_rate_limited`.

#### Scenario: Bucket exhausted

- **GIVEN** `maxSuggestionsPerHour: 5` and 5 suggestions have fired
  in the last hour
- **WHEN** a 6th idle window completes
- **THEN** no synthetic prompt is sent
- **AND** an audit event `idle_suggest_rate_limited` is written
  (only once per hour even on subsequent suppressed firings)

### Requirement: Response parsing

The daemon SHALL parse the synthetic response with the following
steps in order:

1. Strip a leading and/or trailing triple-backtick markdown code
   fence (including optional `json` language tag).
2. Trim whitespace.
3. `JSON.parse`. If this throws, audit
   `idle_suggest_parse_failed` with reason `not_json` and drop.
4. Confirm the parsed value is an array. Else audit with reason
   `not_array` and drop.
5. For each element, confirm string type and trimmed length between
   5 and 140 characters inclusive. If any element fails, audit with
   reason `element_invalid` and drop the entire response.
6. Cap the resulting array at 3 items.
7. If the resulting array is empty after capping, drop without
   emitting (and without audit).

Otherwise, emit an `idle_suggestions` SSE event.

#### Scenario: Code-fenced JSON parsed

- **GIVEN** the model returns ` ```json\n["a", "b", "c"]\n``` `
- **WHEN** the parser runs
- **THEN** the resulting suggestions are `["a", "b", "c"]`

#### Scenario: Invalid JSON drops silently

- **GIVEN** the model returns `Sure! Here you go: a, b, c`
- **WHEN** the parser runs
- **THEN** no `idle_suggestions` event is emitted
- **AND** an audit event `idle_suggest_parse_failed` is written
  with reason `not_json`

#### Scenario: Too-long element rejects whole array

- **GIVEN** the model returns `["short", "<150-char string>"]`
- **WHEN** the parser runs
- **THEN** no event is emitted
- **AND** an audit event `idle_suggest_parse_failed` is written
  with reason `element_invalid`

### Requirement: `idle_suggestions` SSE event

The daemon SHALL emit an SSE event of type `idle_suggestions` with
the envelope of `add-remote-control`'s wire-protocol spec and a
`data` payload:

```jsonc
{
  "sessionId": "<id>",
  "suggestions": ["string", ...],
  "expiresAt": "<ISO-8601>",
  "rateLimitState": {
    "remainingThisHour": <int>,
    "nextSlotAt": "<ISO-8601>"
  }
}
```

`suggestions` SHALL contain between 1 and 3 strings inclusive.
`expiresAt` SHALL default to 5 minutes after emission.

#### Scenario: Event well-formed

- **WHEN** the parser produces a 2-item suggestion array
- **THEN** subscribers receive an `idle_suggestions` event with
  exactly 2 entries
- **AND** the event's `expiresAt` is 5 minutes after the daemon's
  current time

### Requirement: Per-session toggle

The daemon SHALL expose `POST /session/:id/idle-suggest-toggle`
accepting `{ enabled: boolean }` for tokens with at least write
scope. The flag SHALL apply for the lifetime of that session only.
Built-in client slash command `/suggest [on|off|status]` SHALL post
to this endpoint.

#### Scenario: `/suggest off` disables for this session

- **GIVEN** the session has idle suggestions enabled by default
- **WHEN** a write-scope client runs `/suggest off`
- **THEN** the toggle endpoint records `enabled: false` for this
  session
- **AND** no further idle-suggest firings occur for this session
- **AND** the daemon default still applies to other / new sessions

#### Scenario: `/suggest status` reports state

- **WHEN** a client runs `/suggest status`
- **THEN** the response includes the per-session enabled state, the
  effective `idleAfterSec`, and `remainingThisHour`

### Requirement: Cost attribution

Usage events generated by the synthetic round-trip SHALL be written
with `attribution_token_id = NULL` and `sub_actor = "_idle-suggest"`
(or another system-internal namespace agreed with
`add-bridge-protocol`'s sub-actor regex extension). Operators
querying `/rc/usage?group_by=sub_actor` SHALL be able to isolate
synthetic spend separately from human-attributed spend.

#### Scenario: Usage row carries system sub-actor

- **GIVEN** `add-cost-tracking` is enabled
- **WHEN** a synthetic round-trip completes successfully
- **THEN** at least one row is written to `usage_events` with
  `attribution_token_id` NULL and `sub_actor: "_idle-suggest"`

#### Scenario: Usage panel can exclude synthetic

- **GIVEN** the same setup
- **WHEN** an owner queries
  `/rc/usage?group_by=sub_actor&since=24h`
- **THEN** rows for `_idle-suggest` appear as a distinct line item
  separable from human attribution

### Requirement: Client rendering

Web and terminal clients SHALL render received `idle_suggestions`
payloads as up to 3 chips immediately below the prompt input box.
The chips SHALL:

- be clickable / selectable
- on activation, place the chip's text into the prompt input box
  WITHOUT submitting
- auto-clear at the `expiresAt` timestamp
- not appear in the transcript area

The terminal client SHALL bind `Alt-1`, `Alt-2`, `Alt-3` to the
first, second, and third chip respectively.

#### Scenario: Web chip fills input

- **GIVEN** the web client receives an `idle_suggestions` event
  with suggestions `["Run tests"]`
- **WHEN** the user taps the chip
- **THEN** the prompt input box contains the text `Run tests`
- **AND** no `POST /session/:id/prompt` is fired yet

#### Scenario: Auto-clear at expiry

- **GIVEN** the chip was rendered 5 minutes 1 second ago with
  `expiresAt` 5 minutes after render
- **WHEN** the client's timer ticks
- **THEN** the chips are removed from the UI

### Requirement: Capability advertisement

`GET /capabilities`'s `remoteControl` block SHALL include:

```jsonc
{
  "idleSuggestions": {
    "enabled": true,
    "idleAfterSec": 60,
    "maxSuggestionsPerHour": 5,
  },
}
```

Clients SHALL render the chip surface only when `enabled: true`.

#### Scenario: Capability present

- **WHEN** any token GETs `/capabilities`
- **THEN** the response's
  `remoteControl.idleSuggestions.enabled` is `true`
