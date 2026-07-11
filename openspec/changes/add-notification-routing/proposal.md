# add-notification-routing

## Why

`add-webpush-notifications` delivers pushes; `add-policy-engine` decides
which tool calls auto-resolve vs. prompt. Neither change owns the
question "should this event become a notification, and to which
subscriptions?" Today that question is answered implicitly: every
`permission_required` event fans out to every subscription whose
preferences include `permission.required`. That is too coarse.

Concrete failures of the current rule:

- A policy-auto-allowed tool call still pages every subscribed device,
  because the event passes through the existing filter (preferences
  match on `kind`, not on `policy.decisionSource`).
- A `policy.deny` rolls past silently when the operator would prefer
  to hear about it, because subscriptions default to `permission`-only
  for `approve`-scope tokens.
- The operator is actively typing in the web tab on their laptop AND
  their phone pings them with the same prompt; one of those two
  notifications is wasted attention.
- The operator wants a heads-up only when a tool call mentions
  `production` or `billing` in args; there is no way to express that
  short of a custom bridge.
- Quiet hours suppress notifications, but there is no operator-
  controlled "snooze for 1 hour right now" override that survives a
  daemon restart.

This change adds the decision layer between the event bus and
`pushSender.enqueue`. Per-client rules express which events go to
which subscriptions; "working device" detection suppresses redundant
pushes; mentions provide content-based routing; snooze provides a
quick global override.

## What Changes

- **Routing layer.** A pure decision module
  `packages/cli/src/serve/remoteControl/routing/` consumes events from
  the bus, looks up subscriptions and routing state, and emits a set
  of `(subscriptionId, payload, urgency)` tuples to
  `pushSender.enqueue`. The existing per-subscription `prefs` filter
  becomes an input to this module, not the sole gate.
- **Routing config file `~/.qwen/rc/routing.yaml`** with optional
  workspace override `<workspace>/.qwen/routing.yaml` (strict
  precedence; workspace wins per matching rule, daemon-global rules
  remain in effect for everything else).
- **Rule format.** `match:` against `kind`, `sessionTag`,
  `originatingClientScope`, `policy.decisionSource`, `subActor`,
  `mentionPatterns`. `route:` selects which subscriptions
  (by tokenScope, by tokenId, by device tag), sets `urgency`,
  declares `suppressIfWorkingDevice`, declares `digestUntil`.
- **Policy-engine awareness.** When a `policy_decision` event resolves
  with `action: allow` and `decisionSource: rule`, no push fires by
  default. When `action: deny`, a push fires to subscriptions whose
  prefs include `policy.deny`. When `action: prompt` (fall-through),
  the existing `permission.required` push pipeline runs.
- **Working-device detection.** A subscription is "working" if its
  owning token has posted to the session (prompt, vote, cancel,
  `ui_command`) in the last `workingDeviceWindowSec` (default 120).
  Routes with `suppressIfWorkingDevice: true` skip those
  subscriptions. The other devices still receive the push.
- **Mentions.** A list of glob patterns on tool-call args (`"*production*"`,
  `"*billing*"`, `"*--force*"`). At routing time the engine evaluates
  patterns against the args; on match, emits a synthetic event of
  `kind: mention` carrying the matched pattern and bare context
  (≤140 chars). Details remain fetched on tap-through per
  `add-webpush-notifications` payload privacy posture.
- **Snooze.** `POST /rc/routing/snooze { durationSec, scope:
"all"|"<kind>" }` suppresses pushes globally for the duration.
  Persisted in `~/.qwen/rc/snooze.state` (JSON) so it survives a
  daemon restart. Auto-expires; can be cleared with `DELETE
/rc/routing/snooze`. CLI `qwen rc snooze 1h` and web "Snooze for"
  menu use this.
- **New SSE event `routing_decision`.** When a push is suppressed or
  routed, the daemon emits a `routing_decision` event visible to
  attached clients ("permission.required suppressed for phone:
  reason=working_device on laptop"). Operators see why their phone
  didn't ping.
- **Audit.** Every routing decision is audited
  (`action: push_routed | push_suppressed`, with the matching rule id
  and suppression reason). Routing decisions emit `material: false`
  by default; explicit operator-defined rules can mark them
  `material: true`.

## Capabilities

### New Capabilities

- `notification-routing` — routing rule file format, evaluator
  semantics, working-device detection, mention patterns, snooze
  state, `routing_decision` SSE event, integration points with
  `webpush-notifications` and `policy-engine`.

## User Stories

**R1. The phone stops pinging when the laptop is in use.** I'm sitting
at my laptop with the web client tab focused, typing prompts. The
agent fires `permission.required`. The daemon notes the laptop's
token posted within the last 120 s and suppresses the phone push.
The web client renders the approval card; the phone stays quiet. I
walk away; 130 s later another prompt fires; the phone receives that
one because the laptop is no longer "working."

**R2. Policy-auto-allows produce no pushes.** I ship a policy rule
that auto-allows `npm test*`. The agent fires 47 `npm test` calls
overnight. Each emits a `policy_decision` event with
`decisionSource: rule, action: allow`. The routing layer matches the
default rule "policy-auto-allows do not page" and emits no pushes.
I sleep through the night. Audit log in the morning shows 47
`push_suppressed` entries with reason `policy_auto_allow`.

**R3. Policy-auto-denies do produce pushes.** I ship a `deny` rule on
`rm -rf*`. The agent proposes one. The daemon `policy_denied`s it; the
routing layer pushes a `policy.deny` notification to my phone so I
know the agent is trying something it shouldn't.

**R4. Mention on `production`.** I configure `mentionPatterns:
["*production*", "*PROD-*"]`. The agent runs `kubectl get pods -n
production`. The routing layer evaluates the args, matches, emits a
synthetic `mention` event, and pushes a notification "mention:
_production_ in tool call" with deep link. I tap through to see the
full command.

**R5. Snooze before a meeting.** Before a 1-hour meeting I run
`qwen rc snooze 1h`. The phone stops pinging for the next hour. If
the daemon restarts mid-meeting, the snooze persists and is still
active. At meeting end, the snooze expires; suppressed events are
NOT replayed as pushes (the SSE WAL still has them for in-app
review). A single "Snooze ended" event is emitted.

**R6. Operator sees why no push fired.** The agent fired a prompt;
no phone ping. I open the web client and see in the audit feed:
"push_suppressed → phone-subscription: reason=working_device(laptop)".
I now know it was a routing decision, not a delivery failure.

**R7. Partner's read-token does not page on prompts.** My partner's
laptop has a `read+approve` scoped token paired. Default routing
rules say `permission.required` pushes go only to `approve` and
`owner` scopes — they do. But a `task.completed` ping does go to my
partner's subscription if their prefs allow it. They can tune their
own subscription's prefs; they cannot tune routing rules (those are
owner-only).

## Impact

- **qwen-code repo**: new package
  `packages/cli/src/serve/remoteControl/routing/` with
  `loader.ts` (YAML schema), `evaluator.ts` (rule match),
  `workingDevice.ts` (per-token activity tracking), `mentions.ts`
  (glob match), `snooze.ts` (persisted state), `index.ts` (decision
  module API).
- **Integration point**: `eventBus → routing.route(event) →
pushSender.enqueue(decisions)`. Existing direct
  `pushSender.enqueue` calls in `server.ts` rerouted through the new
  module.
- **Wire protocol**: new SSE event type `routing_decision`. New
  endpoints `POST /rc/routing/snooze`, `DELETE /rc/routing/snooze`,
  `GET /rc/routing/snooze`, `POST /rc/routing/reload`,
  `GET /rc/routing/rules`.
- **Capability response**: `remoteControl.notificationRouting` block
  with `version`, `supportedMatchFields`, `defaultRules`.
- **Audit schema**: new action types `push_routed`,
  `push_suppressed`, `routing_snoozed`, `routing_unsnoozed`.
- **CLI**: `qwen rc snooze [duration]`, `qwen rc unsnooze`,
  `qwen rc routing {reload, rules, test <event-json>}`.
- **Web client**: snooze button in nav bar; routing-decision feed
  visible to owner-scope clients; per-client "Show me what was
  suppressed" filter on the audit feed.
- **No breaking changes**: without a `routing.yaml`, the default
  ruleset reproduces today's behavior (every event matching prefs
  produces a push) except for the policy-auto-allow suppression,
  which is on by default and documented in CHANGELOG.
- **Out of scope** (deliberately):
  - Cross-daemon routing (one daemon = one workspace).
  - Notification grouping or threading at the OS level (the OS
    decides). Daemon-side coalescing remains in
    `add-webpush-notifications`.
  - Routing to non-WebPush channels (those are bridges; see
    `add-bridge-protocol` and the per-channel changes).
  - Machine-learned mention classification. Pattern globs only.
  - Per-rule scripting / code execution. Declarative YAML only,
    consistent with `add-policy-engine`'s rule language.
