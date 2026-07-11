# notification-routing — spec delta

## ADDED Requirements

### Requirement: Routing rule file

The daemon SHALL load routing rules from
`~/.qwen/rc/routing.yaml`. If
`<workspace>/.qwen/routing.yaml` exists, its rules SHALL be prepended
to the daemon-global rules (workspace rules evaluate first; both
remain in effect). When neither file exists, the daemon SHALL apply
a built-in default ruleset documented in `design.md`.

The file SHALL be hot-reloaded on change with a 250 ms debounce. On
parse failure, the daemon SHALL retain the previously-compiled rule
set and emit an audit `routing_reload_failed` entry.

#### Scenario: Default ruleset silences policy auto-allows

- **GIVEN** neither `~/.qwen/rc/routing.yaml` nor a workspace
  override exists
- **AND** a `policy_decision` event with
  `decisionSource: rule, action: allow` is emitted
- **WHEN** the routing layer evaluates the event
- **THEN** no push is sent for the underlying
  `permission_required`
- **AND** a `routing_decision` SSE event is emitted with
  `decisions[0].action == "suppressed"` and
  `reason == "policy_auto_allow"`

#### Scenario: Hot-reload swaps rules atomically

- **GIVEN** a routing.yaml with rule `R` active
- **WHEN** the file is rewritten to drop `R`
- **THEN** within 1 s the daemon evaluates events under the new
  ruleset
- **AND** an in-flight event begun before reload completes under
  the rules it began with (atomicity per-event)

#### Scenario: Parse failure preserves prior rules

- **GIVEN** a valid loaded ruleset
- **WHEN** the file is rewritten to invalid YAML
- **THEN** the daemon emits `routing_reload_failed` audit
- **AND** subsequent events continue to evaluate under the prior
  rules

### Requirement: Rule match operators

A routing rule's `match` block SHALL support the following operators,
all optional, all evaluated as logical AND:

- `kind` — event kind, string or list of strings
- `sessionTag` — glob against session name
- `originatingClientScope` — one of `owner`, `write`, `approve`,
  `read`, `bridge`
- `policy.decisionSource` — one of `rule`, `fallthrough`, or null
- `policy.action` — one of `allow`, `deny`, `prompt`
- `subActor` — glob against `X-RC-SubActor`
- `urgencyAtLeast` — `low`, `normal`, or `high`

The mention block at file scope (NOT inside a rule) defines
`mentions.patterns` and `mentions.caseSensitive`; matched mentions
synthesize a separate `kind: mention` event evaluated by the rule
set normally.

Rules SHALL be evaluated in array order. The first rule with
`route.drop: true` matching SHALL short-circuit and produce zero
decisions. Otherwise, the routing layer SHALL union the subscription
selections from all matching rules and emit a `send` decision per
subscription with the highest urgency requested.

#### Scenario: Drop short-circuits

- **GIVEN** rules `[R1: match kind=X drop=true, R2: match kind=X
route to phone]`
- **WHEN** an event of kind `X` is evaluated
- **THEN** no `send` decision is emitted
- **AND** no further rules are evaluated for that event

#### Scenario: Multiple matching rules union subscriptions

- **GIVEN** rules `[R1: match kind=X → scopeIn=[owner],
R2: match kind=X → scopeIn=[write]]`
- **AND** subscriptions `S_owner` (owner scope) and `S_write`
  (write scope)
- **WHEN** an event of kind `X` is evaluated
- **THEN** `send` decisions are emitted for both `S_owner` and
  `S_write`
- **AND** each carries the highest urgency requested by any
  matching rule

### Requirement: Policy-engine integration

When the routing layer receives an event whose `data` includes a
`policy.decisionSource` field, the rule evaluator SHALL be able to
match on `policy.decisionSource` and `policy.action` per the rule
match operators above.

The default ruleset SHALL include:

1. A rule silencing `policy.decisionSource == rule, policy.action ==
allow` events (no push).
2. A rule paging `owner+write+approve` subscriptions with high
   urgency on `kind: policy.deny`.
3. A rule paging `owner+approve` subscriptions with high urgency on
   `kind: permission.required` AND
   `policy.decisionSource != rule` (fall-through).

#### Scenario: Auto-allowed call is silent

- **GIVEN** a policy rule auto-allows `npm test*`
- **AND** the default ruleset is in effect
- **WHEN** the agent invokes `bash npm test`
- **THEN** the daemon resolves the request via the policy engine
- **AND** no push is sent
- **AND** an audit entry records `push_suppressed` with
  `reason: policy_auto_allow`

#### Scenario: Auto-denied call pages owner

- **GIVEN** a policy rule auto-denies `rm -rf*`
- **AND** the operator has an `owner`-scope subscription with
  `policy.deny` in its prefs
- **WHEN** the agent proposes `bash rm -rf /tmp/build`
- **THEN** the daemon emits a `policy.deny` event
- **AND** the routing layer sends a push to the owner subscription
  with urgency `high`

#### Scenario: Fall-through prompt pages approvers

- **GIVEN** no policy rule matches a tool call
- **AND** the default ruleset is in effect
- **WHEN** the agent fires `permission.required`
- **THEN** the routing layer sends pushes to all subscriptions
  whose owning token has `owner` or `approve` scope
- **AND** does NOT send to `read`-only subscriptions

### Requirement: Working-device suppression

The daemon SHALL maintain an in-memory map of
`(tokenId → lastWriteAt, lastSessionId)` updated by middleware on
every write-equivalent route. A token is "working" for a session if
its `lastSessionId` matches and `now - lastWriteAt <
workingDeviceWindowSec` (default 120 s, configurable in
`routing.yaml`).

Rules with `route.suppressIfWorkingDevice: true` SHALL drop
subscriptions whose owning token is working for the event's session.
The routing layer SHALL emit a `Decision { kind: "suppress",
reason: "working_device", workingTokenId }` for each suppressed
subscription.

Working-device state is in-memory only; daemon restart MAY cause
one redundant push per token until that token next writes.

#### Scenario: Working laptop suppresses phone push

- **GIVEN** subscriptions `S_phone` (phone token) and `S_laptop`
  (laptop token)
- **AND** the laptop token posted a prompt 30 s ago to session `X`
- **AND** the active rule for `permission.required` has
  `suppressIfWorkingDevice: true`
- **WHEN** a new `permission.required` event fires for session `X`
- **THEN** `S_laptop` does NOT receive a push
- **AND** `S_phone` DOES receive a push
- **AND** a `routing_decision` SSE event lists
  `S_laptop suppressed reason=working_device`

#### Scenario: Working-device window elapsed

- **GIVEN** the laptop token last wrote 150 s ago
- **AND** `workingDeviceWindowSec == 120`
- **WHEN** a new `permission.required` event fires
- **THEN** `S_laptop` is NOT considered working
- **AND** the rule sends to all configured subscriptions

#### Scenario: Cross-session writes do not count

- **GIVEN** the laptop token last wrote 30 s ago to session `Y`
- **AND** an event fires for session `X`
- **THEN** the laptop is NOT considered working for `X`

### Requirement: Mention patterns

`routing.yaml` MAY define `mentions.patterns` as a list of glob
expressions and `mentions.caseSensitive` (default `false`). At
routing time, for each emitted event whose `data` includes
tool-call args, the daemon SHALL canonicalize args to
`"<toolName> <JSON.stringify(args)>"` and match each pattern.

On match, the daemon SHALL publish a synthetic event of kind
`mention` carrying:

- `originatingEventId` (the matched event's id),
- `matched` (the pattern string that fired),
- `context` (≤140 chars: tool name + filename + matched pattern
  label; SHALL NOT include raw args byte content),
- `sessionId`, `sessionName`.

The synthetic event SHALL flow through the routing engine like any
other event.

#### Scenario: Mention on production keyword

- **GIVEN** `mentions.patterns: ["*production*"]`
- **AND** a rule `match { kind: mention } → owner urgency high`
- **WHEN** the agent proposes `bash kubectl get pods -n
production`
- **THEN** a synthetic `mention` event is published with
  `matched: "*production*"`
- **AND** a push is sent to owner-scope subscriptions
- **AND** the push `summary` is ≤140 chars and does not include
  the raw args verbatim

#### Scenario: No mention does not synthesize

- **GIVEN** `mentions.patterns: ["*production*"]`
- **WHEN** the agent proposes `bash ls`
- **THEN** no `mention` event is emitted

### Requirement: Snooze

The daemon SHALL accept `POST /rc/routing/snooze` from owner-scope
tokens with body `{ durationSec: int, scope: "all" | "<event-kind>"
}`. The state SHALL be persisted atomically to
`~/.qwen/rc/snooze.state` (mode 0600). `durationSec` SHALL be
capped at 86400 (24 h).

While a snooze is active:

- The routing layer SHALL suppress all `send` decisions whose
  event kind matches `scope` (or all kinds if `scope == "all"`).
- The daemon SHALL still publish a `routing_decision` SSE event
  per affected subscription with `reason: "snoozed"`.
- The daemon SHALL still emit pushes for `kind: session.died` to
  subscriptions owned by `owner`-scope tokens. This floor SHALL
  NOT be configurable via `routing.yaml`.

`DELETE /rc/routing/snooze` (owner) SHALL clear the snooze.

The daemon SHALL auto-expire snoozes at `until`. On expiry it
SHALL emit `routing_unsnoozed` audit + SSE events. Suppressed
events SHALL NOT be replayed as pushes.

#### Scenario: Snooze suppresses pushes

- **GIVEN** the operator runs `qwen rc snooze 1h`
- **WHEN** any non-`session.died` event fires
- **THEN** no push is sent
- **AND** a `routing_decision` event with `reason: snoozed` is
  emitted

#### Scenario: Snooze persists across restart

- **GIVEN** snoozed until `T + 1h` at time `T`
- **WHEN** the daemon restarts at `T + 30 min`
- **THEN** on resume the daemon reads
  `~/.qwen/rc/snooze.state` and remains snoozed until `T + 1h`

#### Scenario: Session.died still pages owner while snoozed

- **GIVEN** snoozed `scope: all`
- **AND** an owner-scope subscription `S_owner` exists with
  `session.died` in its prefs
- **WHEN** the agent session dies
- **THEN** `S_owner` receives a push
- **AND** the audit entry notes
  `snooze_overridden_by_floor: session.died`

#### Scenario: Snooze max duration enforced

- **WHEN** the operator POSTs `durationSec: 100000`
- **THEN** the response is `400 Bad Request` with code
  `snooze_duration_exceeds_max`

### Requirement: `routing_decision` SSE event

For every event that produces at least one routing decision, the
daemon SHALL emit a `routing_decision` SSE event with the schema in
`design.md`. The event SHALL be visible to `owner`-scope clients in
full; other scopes SHALL see only decisions affecting subscriptions
owned by their token.

#### Scenario: Owner sees full routing decision

- **GIVEN** an event fires affecting 3 subscriptions
- **WHEN** the owner client receives the `routing_decision` event
- **THEN** all 3 per-subscription decisions are present

#### Scenario: Non-owner sees scoped subset

- **GIVEN** an event fires affecting subscriptions owned by tokens
  `T_owner`, `T_write_a`, `T_write_b`
- **WHEN** a `write`-scope token `T_write_a` receives the event
- **THEN** only the decision for `T_write_a`'s subscription is
  present

### Requirement: Audit entries for routing

The daemon SHALL emit audit entries for routing actions:

- `push_routed` — a send decision was enqueued.
- `push_suppressed` — a suppress decision was emitted; entry
  includes `reason` (one of `working_device`, `snoozed`,
  `policy_auto_allow`, `prefs_mismatch`, `digest_window`).
- `routing_snoozed`, `routing_unsnoozed` — snooze state changes.
- `mention_emitted` — synthetic mention event published.
- `routing_reloaded`, `routing_reload_failed` — config changes.

Each entry SHALL include the matched `ruleId` where applicable.

#### Scenario: Suppression carries reason

- **GIVEN** a working-device suppression fires for `S_laptop`
- **WHEN** the audit log is queried
- **THEN** an entry exists with `action: push_suppressed,
subscription_id: S_laptop, reason: working_device,
rule_id: prompt-fallthrough`

### Requirement: Operator inspection and dry-run

The daemon SHALL expose:

- `GET /rc/routing/rules?resolved=true|false` — owner-only; returns
  the merged ruleset.
- `POST /rc/routing/test` with `{ event: <EventEnvelope>,
subscriptions: <Subscription[]>, workingDevices?: <map> }` —
  owner-only; returns decisions the engine would produce. Does
  NOT enqueue any push or emit audit.

The CLI SHALL expose `qwen rc routing rules`, `qwen rc routing
reload`, and `qwen rc routing test <file.json>` as thin wrappers.

#### Scenario: Operator dry-runs a rule change

- **GIVEN** the operator has saved a candidate
  `routing.yaml.preview`
- **AND** edits the file at `~/.qwen/rc/routing.yaml` and runs
  `qwen rc routing reload`
- **WHEN** the operator runs `qwen rc routing test event.json`
- **THEN** the CLI prints a table of decisions per subscription
- **AND** no audit entries are written for the dry-run

#### Scenario: Operator inspects effective ruleset

- **GIVEN** both daemon and workspace routing.yaml exist
- **WHEN** the operator runs `qwen rc routing rules --resolved`
- **THEN** the output lists workspace rules first, then daemon
  rules
- **AND** each rule shows its source file path

### Requirement: Capability advertisement

`GET /capabilities` SHALL include a
`remoteControl.notificationRouting` block:

```jsonc
{
  "version": 1,
  "supportedMatchFields": [
    "kind",
    "sessionTag",
    "originatingClientScope",
    "policy.decisionSource",
    "policy.action",
    "subActor",
    "urgencyAtLeast",
  ],
  "supportedRouteFields": [
    "drop",
    "subscriptions.scopeIn",
    "subscriptions.tokenIdsIn",
    "subscriptions.deviceTagsIn",
    "urgency",
    "suppressIfWorkingDevice",
    "digestUntilQuietHoursEnd",
    "material",
  ],
  "snooze": {
    "maxDurationSec": 86400,
    "floorKinds": ["session.died"],
  },
}
```

#### Scenario: Capability response carries routing version

- **WHEN** a client requests `/capabilities`
- **THEN** the response includes the `notificationRouting` block
- **AND** `version` is the integer agreed for this change
