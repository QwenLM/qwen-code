# Design — add-notification-routing

## Context

After `add-remote-control`, `add-webpush-notifications`, and
`add-policy-engine` ship, the notification flow looks like this:

```
   event bus ──▶ (per-subscription prefs filter) ──▶ pushSender.enqueue
                  ▲
                  └── only filter: subscription.prefs.kinds ⊇ event.kind
```

That single filter ignores:

- whether the policy engine resolved the underlying request silently
  (no human attention needed);
- whether the operator is already looking at the session on another
  device (no need to ping a second one);
- content-based interest (`*production*` in args is more interesting
  than args we don't care about);
- ad-hoc operator state ("I'm in a meeting, snooze everything for an
  hour").

This change replaces the single prefs filter with a decision module
that consumes all of those signals.

## Goals / Non-Goals

**Goals:**

- One declarative rule file expresses which events become pushes and
  to which subscriptions.
- Policy-engine decisions are first-class inputs: auto-allow silent
  by default, auto-deny audible by default.
- Working-device suppression cuts redundant pushes without losing
  events (other devices still ping; WAL still records).
- Mentions match operator-defined glob patterns at routing time.
- Snooze is one CLI / one button and survives daemon restart.
- Decisions are visible (`routing_decision` SSE event) and audited.

**Non-Goals:**

- Replacing per-subscription `prefs` from `add-webpush-notifications`.
  Prefs continue to exist as a _subscription-owned_ opt-out. Routing
  rules are _operator-owned_ policy. Both apply.
- Routing to non-WebPush channels. Bridges (Telegram, Discord, etc.)
  consume the SSE event stream directly and apply their own routing
  logic; this module emits only WebPush decisions.
- Cross-daemon coordination ("don't push to my phone if my watch
  already pinged"). One daemon, one decision domain.
- Machine learning, model-based classification, sentiment, etc. Globs
  and structural fields only.
- Code-based / scriptable rules. Consistent with policy-engine D3:
  declarative YAML only.

## Architecture

```
   ┌────────────────────────────────────────────────────────────────┐
   │ Daemon                                                         │
   │                                                                │
   │  event bus ──▶ routing/index.ts: route(event, state)           │
   │                                  ├── load rules (hot-reload)   │
   │                                  ├── per-subscription prefs    │
   │                                  ├── workingDevice.recentFor(t)│
   │                                  ├── mentions.match(args)      │
   │                                  ├── snooze.isActive()         │
   │                                  └── policy.decisionSource     │
   │                                       │                        │
   │                                       ▼                        │
   │                              Decisions[] {                     │
   │                                subscriptionId, urgency,        │
   │                                payload, ruleId, suppressedBy?  │
   │                              }                                 │
   │                                       │                        │
   │                                       ├── enqueue → pushSender │
   │                                       ├── emit routing_decision│
   │                                       └── audit push_routed /  │
   │                                            push_suppressed     │
   │                                                                │
   │  workingDevice tracker ◀── HTTP middleware records each        │
   │     in-memory                token's last write timestamp      │
   │     no WAL (best-effort)                                       │
   │                                                                │
   │  snooze.state ◀── POST /rc/routing/snooze                      │
   │     on disk      DELETE /rc/routing/snooze                     │
   │                                                                │
   │  routing.yaml + workspace/.qwen/routing.yaml                   │
   │     hot-reload via fsnotify (debounced 250ms)                  │
   └────────────────────────────────────────────────────────────────┘
```

The decision module is **pure** given its inputs:

```ts
type Inputs = {
  event: EventEnvelope;
  rules: CompiledRule[];
  subscriptions: Subscription[];
  workingDevices: Map<TokenId, LastWriteAt>;
  snooze: SnoozeState | null;
  policyMeta?: PolicyDecisionMeta; // from policy_decision events
};

type Decision =
  | {
      kind: 'send';
      subscriptionId: string;
      payload: Payload;
      urgency: 'high' | 'normal' | 'low';
      ruleId: string;
    }
  | {
      kind: 'suppress';
      subscriptionId: string;
      reason: SuppressReason;
      ruleId: string;
    };

function route(inputs: Inputs): Decision[];
```

Pure-function-with-state-snapshot makes the module trivially testable
and replayable (golden-input → golden-decision tests).

## Rule file format

`~/.qwen/rc/routing.yaml`:

```yaml
version: 1
mentions:
  patterns:
    - '*production*'
    - '*PROD-*'
    - '*billing*'
    - '*--force*'
  caseSensitive: false

workingDeviceWindowSec: 120 # default

rules:
  # 1. Policy auto-allow → silent (default-on)
  - id: silence-policy-auto-allow
    match:
      kind: permission.required
      policy.decisionSource: rule
      policy.action: allow
    route:
      drop: true

  # 2. Policy deny → page everyone with policy.deny prefs
  - id: page-policy-deny
    match:
      kind: policy.deny
    route:
      subscriptions:
        scopeIn: [owner, write, approve]
      urgency: high

  # 3. Permission prompt fall-through → page approvers, suppress working device
  - id: prompt-fallthrough
    match:
      kind: permission.required
      policy.decisionSource: fallthrough # or absent
    route:
      subscriptions:
        scopeIn: [owner, approve]
      urgency: high
      suppressIfWorkingDevice: true

  # 4. Task completed → low urgency, working-device aware, digestible
  - id: task-completed-digest
    match:
      kind: task.completed
    route:
      subscriptions:
        scopeIn: [owner, write, read]
      urgency: low
      suppressIfWorkingDevice: true
      digestUntilQuietHoursEnd: true

  # 5. Mentions → high urgency, always page (no working-device suppression)
  - id: mention-paging
    match:
      kind: mention
    route:
      subscriptions:
        scopeIn: [owner, write]
      urgency: high
      suppressIfWorkingDevice: false

  # 6. Session died → owner only, highest urgency
  - id: session-died
    match:
      kind: session.died
    route:
      subscriptions:
        scopeIn: [owner]
      urgency: high
```

Match operators:

| Field                    | Type                      | Notes                                      |
| ------------------------ | ------------------------- | ------------------------------------------ |
| `kind`                   | enum or list              | event kind                                 |
| `sessionTag`             | glob                      | matches session name                       |
| `originatingClientScope` | one of owner/write/...    | who triggered the underlying event         |
| `policy.decisionSource`  | `rule`/`fallthrough`/null | from `add-policy-engine` `policy_decision` |
| `policy.action`          | `allow`/`deny`/`prompt`   | only meaningful if decisionSource present  |
| `subActor`               | glob                      | from `add-bridge-protocol`                 |
| `mentionPatterns`        | implicit                  | matched by `mentions.patterns` block       |
| `urgencyAtLeast`         | low/normal/high           | matches event's pre-routing urgency        |

Route operators:

| Field                        | Effect                                             |
| ---------------------------- | -------------------------------------------------- |
| `drop: true`                 | no push, no further rule evaluation                |
| `subscriptions.scopeIn`      | filter subscriptions by their owning token's scope |
| `subscriptions.tokenIdsIn`   | filter by specific token ids                       |
| `subscriptions.deviceTagsIn` | filter by user-tagged labels (phone/laptop/watch)  |
| `urgency`                    | low / normal / high; passed to push sender         |
| `suppressIfWorkingDevice`    | drop subscription if its token wrote within window |
| `digestUntilQuietHoursEnd`   | per `add-webpush-notifications` quiet-hours digest |
| `material: true`             | include in audit feed with `material` flag         |

Rules evaluate in order; first match with `drop: true` short-circuits;
otherwise the routing engine UNION-merges the chosen subscriptions
across all matching rules (so a single event can satisfy multiple
rules). Within a subscription, the highest `urgency` wins.

## Working-device detection

Maintained in-memory only (per-process):

```ts
class WorkingDeviceTracker {
  private lastWrite = new Map<TokenId, EpochMs>();
  recordWrite(tokenId: TokenId, sessionId: SessionId): void;
  isWorking(
    tokenId: TokenId,
    withinSec: number,
    sessionId?: SessionId,
  ): boolean;
  recentFor(tokenId: TokenId): { at: EpochMs; sessionId: SessionId } | null;
}
```

Updated by HTTP middleware on every write-equivalent route
(`prompt`, `cancel`, `permission` vote, `ui_command`, model switch).
Read by the routing module.

Restart loses the in-memory map; first event after restart is treated
as no-working-device. This is acceptable — the suppression is a
nicety, not a security boundary. Documented in spec.

## Mentions

A `mention` event is synthetic — the routing layer constructs it
from a real `permission_request` / `tool_call_started` / etc. when an
arg glob matches:

```ts
function checkMentions(event, patterns): MentionEvent | null {
  const haystack = canonicalizeArgs(
    event.data.args ?? event.data.toolCall?.args,
  );
  for (const p of patterns) {
    if (glob(p, haystack)) {
      return {
        kind: 'mention',
        sessionId: event.sessionId,
        sessionName: event.sessionName,
        matched: p,
        context: haystack.slice(0, 140),
        originatingEventId: event.id,
      };
    }
  }
  return null;
}
```

The synthesized mention event is published to the bus alongside the
original event so all attached clients see it (and any other rules
that match `kind: mention` fire). The mention payload travels as
WebPush with the same 140-char limit on `summary`. Sensitive token
fields (passwords, keys) are NOT redacted at this layer — operators
who write mention patterns that match those fields are responsible
for the consequences; default patterns suggested in
`docs/operator/routing.md` deliberately avoid them.

## Snooze

State file `~/.qwen/rc/snooze.state` (JSON):

```jsonc
{
  "v": 1,
  "active": true,
  "until": "2026-05-15T16:30:00Z",
  "scope": "all" | "permission.required" | ...,
  "createdBy": "tkn_abc",
  "createdAt": "2026-05-15T15:30:00Z"
}
```

Daemon reads it at start, treats `active && now < until` as snoozed.
Background task auto-cleans expired snoozes and emits a
`routing_unsnoozed` audit + SSE event.

`POST /rc/routing/snooze { durationSec, scope }` writes a fresh
snooze. Idempotent: a second snooze overwrites the first (the
operator is fine with longer-than-intended snooze; they can DELETE
to clear).

`DELETE /rc/routing/snooze` clears it.

`GET /rc/routing/snooze` returns the current state (or `{ active:
false }`).

While snoozed:

- Routing module emits ONLY the synthetic `routing_decision` SSE
  events; no pushes go out.
- Snooze does NOT affect the SSE event stream; clients still receive
  every underlying event. The web client renders them; only push
  notifications are gated.
- Snooze does NOT override `session.died` for owner-scope tokens —
  this is hardcoded as a safety floor. Documented.

## SSE `routing_decision` event

```jsonc
{
  "type": "routing_decision",
  "data": {
    "originatingEventId": "0000…0123",
    "originatingKind": "permission.required",
    "sessionId": "ses_xxx",
    "decisions": [
      {
        "subscriptionId": "sub_phone",
        "action": "sent",
        "urgency": "high",
        "ruleId": "prompt-fallthrough",
      },
      {
        "subscriptionId": "sub_laptop",
        "action": "suppressed",
        "reason": "working_device",
        "workingTokenId": "tkn_laptop",
        "ruleId": "prompt-fallthrough",
      },
    ],
  },
}
```

Visible to owner-scope clients by default (configurable). Other
scopes see only decisions affecting their own subscriptions.

## Decisions

### D1 — Pure decision module, not in-line in pushSender

**Choice**: Routing is a separate pure module
(`routing/index.ts: route(inputs) → decisions`). PushSender remains
"take a decision, encrypt, sign, POST."

**Alternative considered**: Inline routing inside `pushSender.enqueue`.

**Why**: Testability — `route(inputs) → decisions` is golden-test
friendly. Replay — given an event log we can re-run routing for a
"what would have happened if I changed this rule?" tool. Reuse — a
future "desktop notification" channel can call the same routing
module. Separation — pushSender stays focused on transport; routing
on policy.

**Cost**: One extra function call per event, one extra module to
keep in sync. Negligible.

### D2 — Rules in YAML, declarative only, no scripting

**Choice**: YAML rules with the operators listed above. No JS
function bodies, no embedded expressions, no Lua.

**Alternative considered**: A small DSL or JavaScript predicate
function.

**Why**: Consistent with `add-policy-engine` D3 (declarative rules
only). Scripts inside the daemon process are an exfiltration path.
Predicate functions are hard to hot-reload safely. Globs cover the
real use cases.

**Cost**: Operators cannot express "send only if X is even AND
Tuesday." If a real user needs that, they write a sidecar consuming
the SSE stream — exactly what bridges do.

### D3 — Working device tracked in-memory, lost on restart

**Choice**: `WorkingDeviceTracker` is a process-local
`Map<TokenId, lastWriteAt>`. No WAL. After restart, no device is
"working" until it writes again.

**Alternative considered**: Persist last-write timestamps so daemon
restarts are seamless.

**Why**: Working-device detection is a nicety, not a correctness
property. Restarts are rare; the cost of one extra ping post-restart
is small; the cost of additional persistence is non-trivial (this
state mutates on every write).

**Cost**: A couple of redundant pings post-restart. Acceptable.

### D4 — Policy-auto-allow silent by default

**Choice**: The default ruleset (used when no `routing.yaml` is
present) includes `silence-policy-auto-allow` as rule 0.

**Alternative considered**: Default is "all events page"
(current behavior). Operators opt-in to silence.

**Why**: The whole point of `add-policy-engine` is "I trust this
class of call." Treating policy-allowed events as "send a push"
contradicts that. The CHANGELOG and `qwen rc routing rules` output
make the silence explicit; operators who want pings on allows can
add a higher-priority rule.

**Cost**: A new user with both policy and push will see a behavior
change between `qwen serve` Stage 1 and this change's ship. Called
out in CHANGELOG.

### D5 — Snooze persisted, with a hardcoded session.died exception

**Choice**: Snooze state persists across restart. While snoozed,
nothing pushes EXCEPT `session.died` for owner-scope subscriptions.

**Alternative considered**: Pure snooze (everything off, including
session.died); operator chooses exceptions per-snooze.

**Why**: `session.died` typically means an unattended task crashed.
Silencing it because of a meeting snooze creates a worst-case:
operator's overnight task crashes at 3am while they're "snoozed
until 6am." Hardcoded floor protects against that. Operators who
want absolute silence can revoke their subscription instead.

**Cost**: The floor is a hidden behavior. Documented in spec text
and shown by `qwen rc snooze` confirmation message.

### D6 — Mentions evaluated at routing time, not at event-emit time

**Choice**: The agent / daemon emit normal events; the routing
module synthesizes a `mention` event when a pattern matches.

**Alternative considered**: A separate `mentioner` module on the
event bus that publishes mention events directly; routing then
treats them like any other event.

**Why**: The above is the implementation, just described differently
— the routing module is the natural place because it already loads
the patterns (operator config), it already knows which events have
args worth scanning, and it emits to the same downstream consumers.
A separate module duplicates rule loading and config plumbing.

**Cost**: Mentions cannot affect non-WebPush channels (bridges) via
this path. Bridges interested in mentions consume the SSE stream
themselves and apply their own pattern matching. Documented.

### D7 — Workspace override is rule-level, not file-replace

**Choice**: `<workspace>/.qwen/routing.yaml` is loaded if present;
its rules are PREPENDED to the daemon-global rules (so workspace
rules can short-circuit globals). Both files remain active.

**Alternative considered**: Workspace file fully replaces the
daemon-global file when present.

**Why**: Symmetric with `add-policy-engine` precedence; operators
typically want workspace-specific exceptions, not a full rewrite of
defaults like "policy auto-allow is silent."

**Cost**: A workspace rule cannot un-set a daemon-global silence
without an explicit override rule. Documented; the `qwen rc routing
rules --resolved` command prints the merged list.

## Threat model

| Attacker                                                     | Capability                                                                                                                      | Mitigation                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator misconfigures rule → silently drops critical pushes | "drop: true" rule with broad match never pings                                                                                  | `qwen rc routing test <event-json>` and `--resolved` make decisions inspectable; CHANGELOG warns about default policy-auto-allow silence.                                                                           |
| Compromised non-owner token tries to snooze the daemon       | A `write` token could call `/rc/routing/snooze`                                                                                 | Snooze endpoint requires `owner` scope. Documented; integration-tested.                                                                                                                                             |
| Compromised owner token issues an indefinite snooze          | All pushes silenced; agent runs unattended                                                                                      | Snooze hardcoded `maxDurationSec: 24h`. Longer snoozes require explicit owner re-issuance.                                                                                                                          |
| Mention pattern matches a credential                         | Push payload's `summary` carries credential fragment                                                                            | Per `add-webpush-notifications` `summary` is allowlisted; mention context truncated to 140 chars and excludes args byte-for-byte (uses tool name + filename + pattern matched). Documented; tested by golden cases. |
| Routing config mutation via API                              | Attacker rewrites rules to drop everything                                                                                      | Rule reload requires `owner` scope; rules loaded from disk only, not from HTTP body.                                                                                                                                |
| Working-device suppression race                              | Subscription A's token wrote 121s ago, rule says suppressIfWorkingDevice with 120s — push fires, but A's user just stepped away | Best-effort nicety; documented as not a security boundary; both A and other devices see the SSE event regardless.                                                                                                   |

## Risks / Trade-offs

| Risk                                                           | Likelihood | Impact | Mitigation                                                                                  |
| -------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| Operator writes a rule that silences pages they wanted to hear | M          | H      | `qwen rc routing test`; `routing_decision` SSE event makes suppression visible at runtime.  |
| Working-device detection thrashes on quick alternation         | L          | L      | Window default 120s; bumpable per-rule.                                                     |
| Mention pattern false positives                                | M          | L      | Patterns are operator-defined; default is empty. `qwen rc routing test` to dry-run.         |
| Snooze state file corruption / partial write                   | L          | M      | Atomic write (write to `.tmp`, fsync, rename); on parse failure log + treat as not snoozed. |
| Hot-reload of `routing.yaml` while events stream               | L          | M      | Debounced fsnotify; rule swap is atomic per-event.                                          |
| Rule eval cost on hot path                                     | L          | L      | Rules compile once at load; per-event eval is O(rules × matchFields); typical ≤ 20 rules.   |

## Open questions

1. **Should `routing_decision` events go through the WAL?** Currently
   yes, since they ride the existing SSE event bus. Argues against:
   they're noise for non-owner clients. Argues for: replay-after-
   reconnect needs them for the "show suppressed" feed. Defaulting
   to "yes, in WAL"; revisit if WAL bloat is real.

2. **How do bridges interact with routing?** Bridges consume the SSE
   stream directly. They see normal events; they DO see synthetic
   `mention` events; they DO see `routing_decision` events (so a
   Telegram bridge can render "no push fired because phone is
   working"). Documented as informational only; bridges decide their
   own message-to-chat policy.

3. **Per-subscription overrides on routing rules?** Today routing
   rules can filter by subscription via `scopeIn`/`tokenIdsIn`. Should
   a subscription be able to opt OUT of a rule that targets it?
   Plausible but adds complexity (rule-vs-prefs precedence). Defer:
   for now, subscription prefs are an additional filter applied AFTER
   routing decides "would have sent" — `prefs` blocks a send, never
   forces one.

4. **CLI ergonomics of snooze.** `qwen rc snooze 1h` vs
   `qwen rc snooze --until 17:00` vs `qwen rc snooze --next-meeting`
   (read from calendar). Ship plain duration + `--until`; calendar
   integration is bridge work, out of scope.

5. **Should `digest` collapse across kinds or only same-kind?**
   `add-webpush-notifications` D6 coalesces same-kind in a 5s window.
   Routing's `digestUntilQuietHoursEnd` could span kinds. Leaning:
   same-kind only, for consistency with the underlying push pipeline.
   Phase 4 prototype to confirm.
