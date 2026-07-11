# tasks — add-notification-routing

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~1 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-webpush-notifications` Phase 5 `completed`
    > (pushSender exists with `enqueue(envelope)`), and
    > `add-policy-engine` Phase 3 `completed` (policy_decision SSE
    > event exists with `decisionSource`/`action`/`ruleId`). If
    > either is not yet completed, mark this change as blocked.
    > Verify the existing event bus surfaces a single entry point
    > we can intercept; record the file path here.
    > Set Status to `in-progress` before any other tool call.

- [ ] **0.1 Module scaffold + types**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/routing/index.ts`,
    `packages/cli/src/serve/remoteControl/routing/types.ts`
  - **Prompt:**
    > Create the module skeleton. Define `Inputs`, `Decision`,
    > `CompiledRule`, `SuppressReason`, `Subscription` types per
    > `design.md` "Architecture" section. Export
    > `route(inputs: Inputs): Decision[]` as a stub that returns
    > the legacy behavior (preferences filter only) so the wiring
    > does not break existing webpush tests.
    > Acceptance: type-checks cleanly; existing webpush tests pass
    > unchanged.

- [ ] **0.2 Wire interception point**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/serve/server.ts` (or the existing
    event-bus → pushSender call site)
  - **Prompt:**
    > Replace direct `pushSender.enqueue(envelope)` calls with
    > `for (const d of route(buildInputs(event))) pushSender.applyDecision(d)`.
    > `applyDecision` is added to pushSender as a thin shim that
    > dispatches `send` decisions to the existing enqueue path and
    > swallows `suppress` decisions (the routing module emits
    > separate audit + SSE entries for those).
    > Acceptance: existing webpush integration test still
    > delivers; new in-memory test verifies the route function is
    > called once per event.

- [ ] **0.3 `routing_decision` SSE event type**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Register `routing_decision` in the event-envelope union.
    > Update `add-remote-control` `specs/wire-protocol/spec.md`
    > only with a drift note pointing at this change's spec
    > delta. Acceptance: a hand-emitted `routing_decision` event
    > rides the SSE stream end-to-end in an integration test.

## Phase 1 — Rule loader + evaluator

**Effort:** ~2 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Verify
    > `~/.qwen/rc/routing.yaml` is NOT already used by another
    > module. Confirm policy-engine's fsnotify wrapper is reusable;
    > if so we extend it, otherwise we copy its pattern.

- [ ] **1.1 YAML schema + loader**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/routing/loader.ts`
  - **Prompt:**
    > Implement `loadRoutingConfig(daemonPath, workspacePath?)`
    > returning a `CompiledRule[]` plus mention patterns and
    > `workingDeviceWindowSec`. Validate against a JSON schema
    > matching `design.md` "Rule file format". Workspace rules
    > prepend to daemon-global rules. Embed a `DEFAULT_RULES`
    > constant used when neither file exists, equivalent to the
    > example in `design.md`.
    > Acceptance: scenarios under `Requirement: Routing rule file`.

- [ ] **1.2 Rule evaluator**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/routing/evaluator.ts`
  - **Prompt:** > Implement `evaluate(event, rules, ctx) → MatchedRule[]`. > Match operators per `design.md`. First rule with > `drop: true` short-circuits; otherwise UNION the > subscription selections across all matching rules; pick the > highest urgency per subscription. Pure function; no I/O. > Acceptance: golden tests over fixture events; scenarios > `Auto-allow silenced`, `Auto-deny pages`, `Prompt fall-
through pages approvers`.

- [ ] **1.3 Hot-reload**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > fsnotify on both `~/.qwen/rc/routing.yaml` and
    > `<workspace>/.qwen/routing.yaml`. Debounce 250ms. On parse
    > failure, log + keep prior compiled rules. Emit audit
    > `routing_reloaded` or `routing_reload_failed`.
    > Acceptance: scenario `Hot-reload swaps rules atomically`.

- [ ] **1.4 `POST /rc/routing/reload` + `GET /rc/routing/rules`**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Owner-scope endpoints. `reload` forces a reload (returns the
    > rule count and any parse warnings). `rules` returns the
    > merged `--resolved` list of rules (workspace + daemon).
    > Acceptance: scenario `Operator inspects effective ruleset`.

## Phase 2 — Working-device detection

**Effort:** ~1 day.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Decide whether the existing
    > auth middleware exposes a stable hook to observe
    > authenticated request completion; if not, add one. Record
    > the chosen hook here.

- [ ] **2.1 `WorkingDeviceTracker`**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/routing/workingDevice.ts`
  - **Prompt:**
    > Implement `WorkingDeviceTracker` class per `design.md` D3.
    > In-memory Map; LRU bound of 1024 tokens; per-token entry
    > stores `lastWriteAt` + `lastSessionId`. Expose
    > `recordWrite(tokenId, sessionId)` and
    > `isWorking(tokenId, withinSec, sessionId?) → boolean`.
    > Acceptance: unit tests for recency, scope to session id when
    > provided, eviction.

- [ ] **2.2 Wire middleware to tracker**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > After the existing auth middleware, on every
    > write-equivalent route (`POST /session/:id/prompt`,
    > `/cancel`, `/model`, `/permission/:id`, `ui_command`),
    > call `tracker.recordWrite(req.tokenId, req.sessionId)`.
    > Acceptance: integration test verifies tracker reflects the
    > most recent post within the configured window.

- [ ] **2.3 Evaluator consumes tracker**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > In `route()`, pass `workingDevices` snapshot into rule > evaluation. A rule with `suppressIfWorkingDevice: true` > drops the subscription if its owning token is working > within `workingDeviceWindowSec`. Suppression produces a > `Decision { kind: "suppress", reason: "working_device",
workingTokenId }`. > Acceptance: scenario `Working laptop suppresses phone push`.

## Phase 3 — Mentions

**Effort:** ~1 day.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm the events with `args`
    > we want to scan are exactly: `permission_request`,
    > `tool_call_started`, `policy_decision`. Adjust set if
    > anything new lands.

- [ ] **3.1 Pattern compile + match**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/routing/mentions.ts`
  - **Prompt:** > Implement `compileMentionPatterns(patterns, caseSensitive)` > and `matchMentions(event, compiled): MentionEvent | null`. > Canonicalize args to a single string > (`<toolName> <JSON.stringify(args)>`); apply each glob; > first match wins; truncate context to 140 chars excluding > the literal pattern string (only tool name + filename + > matched-pattern label travel in the synthetic event). > Acceptance: scenarios `Mention on production`, `No mention
does not synthesize event`.

- [ ] **3.2 Synthetic mention event bus**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > When a mention is detected, publish a `kind: mention` event
    > on the bus BEFORE returning routing decisions for the
    > original event. This guarantees the rule set sees the
    > mention event in the same routing tick. Audit
    > `mention_emitted` includes `originatingEventId` and
    > `matched`.

- [ ] **3.3 Web client mention surface**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Web client renders mentions in a dedicated "Mentions" tab
    > of the audit feed; deep link from notification opens the
    > originating event. Implementation note only — UI lives in
    > `packages/web-client/src/views/Mentions.tsx`. Acceptance:
    > scenario `Mention surface in web client`.

## Phase 4 — Snooze

**Effort:** ~1 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Decide on snooze state file
    > location (`~/.qwen/rc/snooze.state`) and confirm no name
    > collision with existing files.

- [ ] **4.1 Snooze state store**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/routing/snooze.ts`
  - **Prompt:** > Implement `SnoozeStore` with `get()`, `set({ durationSec,
scope, createdBy })`, `clear()`, `isActive(eventKind,
subscriptionScope)`. Atomic write (tmp + rename + fsync). > Enforce `maxDurationSec: 86400`. Hardcode the > `session.died` exception per `design.md` D5 (owner-scope > subscriptions still receive `session.died` while snoozed). > Acceptance: unit tests cover persistence across mock- > restart, expiry, the death floor.

- [ ] **4.2 Endpoints + CLI**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > `POST /rc/routing/snooze`, `DELETE /rc/routing/snooze`, > `GET /rc/routing/snooze` (owner scope). CLI > `qwen rc snooze [duration]` and `qwen rc unsnooze`. > Confirmation message names the hardcoded death floor. > Acceptance: scenarios `Snooze active suppresses pushes`, > `Snooze persists across restart`, `Snooze does not silence
session.died for owner`.

- [ ] **4.3 Evaluator integration**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > In `route()`, consult `snooze.isActive(event.kind, sub.scope)`
    > AFTER rule-based selection. Suppressed subscriptions emit
    > `Decision { kind: "suppress", reason: "snoozed" }`.

## Phase 5 — Polish

**Effort:** ~1 day.

- [ ] **5.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 4 `completed`. Spot-check that
    > `routing_decision` SSE events are not flooding the WAL; if
    > one event produces > 5 decisions per second sustained,
    > rate-limit publication (group within 1s window).

- [ ] **5.1 `qwen rc routing test <event-json>`**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Operator dry-run: read an event JSON from stdin or file,
    > run it through the loaded rules with a hypothetical
    > subscription set, print the decisions table. Print
    > `would_send` and `would_suppress` rows. Acceptance:
    > scenario `Operator dry-runs a rule change`.

- [ ] **5.2 Audit + capability advertisement**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Add audit action types `push_routed`, `push_suppressed`,
    > `routing_snoozed`, `routing_unsnoozed`, `mention_emitted`,
    > `routing_reloaded`, `routing_reload_failed`. Extend
    > `/capabilities` with the `notificationRouting` block per
    > proposal. Acceptance: capability response carries the
    > correct version and `supportedMatchFields`.

- [ ] **5.3 Docs**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `docs/operator/routing.md`
  - **Prompt:**
    > Operator-facing guide: example `routing.yaml` for common
    > setups (overnight task, working hours, multi-device), the
    > `--resolved` workflow, snooze caveats, mention pitfalls
    > around credentials. Under 1500 words.

- [ ] **5.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Run `openspec archive add-notification-routing`.

## Effort summary

| Phase     | Description              | Estimate (days) |
| --------- | ------------------------ | --------------- |
| 0         | Foundation               | 1               |
| 1         | Loader + evaluator       | 2               |
| 2         | Working-device detection | 1               |
| 3         | Mentions                 | 1               |
| 4         | Snooze                   | 1               |
| 5         | Polish + docs + archive  | 1               |
| **Total** |                          | **7**           |
