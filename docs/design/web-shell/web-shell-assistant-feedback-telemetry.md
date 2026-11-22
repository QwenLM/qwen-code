# Web Shell Assistant Feedback Telemetry

[English](web-shell-assistant-feedback-telemetry.md) | [简体中文](web-shell-assistant-feedback-telemetry.zh-CN.md)

Status: implemented in this change.

Builds on [Web Shell Assistant Answer Feedback](web-shell-assistant-feedback.md),
which implemented the per-turn satisfied / not-satisfied marks as host-opt-in,
browser-local UI state with no telemetry.

## Problem

The standalone Web Shell — the app the `qwen serve` daemon serves — does not
show the marks at all: its entry (`packages/web-shell/client/main.tsx`) never
passes the `assistantFeedback` option, and the original design deliberately
left it out because the standalone app had no host to notify. The product
requirement now is that a reader's per-turn good/bad mark in the standalone
app reaches the telemetry pipeline, so the `user_feedback` signal the TUI
already reports is also collected from Web Shell conversations.

Two facts shape the solution:

- The mark UI, its local storage, and the host notification hook already exist
  and are tested. What is missing is the standalone opt-in and a wire path from
  the browser to a telemetry logger.
- A daemon session's `Config` — the object every telemetry logger needs — lives
  in the session's ACP child process (`qwen --acp`), not in the daemon process.
  The daemon only holds a bridge. Daemon-driven turns already emit telemetry
  from that child (for example `logUserPrompt` in
  `packages/cli/src/acp-integration/session/Session.ts`), so the sink side is
  proven; only the client-to-child leg is new.

## Goals

- Show the existing marks in the standalone Web Shell on completed assistant
  turns, gated by a daemon capability so older daemons keep today's footer.
- Deliver every satisfied / not-satisfied mark to the session's telemetry
  pipeline as a `user_feedback` event, with the correct rating, the session's
  authoritative model and approval mode, and the turn's `promptId`.
- Keep the mark itself instant and final: telemetry is a best-effort side
  effect that can never revert or block the UI state.
- Leave embedded hosts, the TUI, and the local-mark storage contract unchanged.

## Non-goals

- No server-side persistence of the mark. `localStorage` remains the UI's
  source of truth; the telemetry event is a notification, not a record the
  client reads back. Cross-device mark sync stays out of scope (the original
  design's follow-up).
- No new telemetry event type. The existing `UserFeedbackEvent`
  (`packages/core/src/telemetry/types.ts`) is reused as-is.
- No "cleared" telemetry. The event type has no cleared state; clearing a mark
  stays a local-only transition.
- No change to the TUI feedback dialog, including its pre-existing rating
  rotation defect (documented in the original design's follow-up). The new
  path maps ratings explicitly and must not inherit that defect.
- No Managed Agent equivalent. The capability parity matrix records the tag as
  deliberately absent on the Managed side.

## Design

### End-to-end path

```
browser click
  → existing mark UI + localStorage (unchanged)
  → customization.assistantFeedback.onRate (existing notification hook)
  → App.tsx standalone wiring (new): fire-and-forget session action
  → DaemonSessionClient / DaemonClient (new SDK method)
  → POST /session/:id/feedback (new daemon route, live-session-owner)
  → runtime.bridge → ACP extMethod qwen/control/session/feedback (new)
  → acpAgent.extMethodInternal case (new), session Config in hand
  → logUserFeedback(config, UserFeedbackEvent) (existing core logger)
  → sinks (existing): ui_telemetry chat record, QwenLogger RUM, OTel
```

### Wire contract

`POST /session/:id/feedback`

- Body: `{ "promptId": "<non-empty string>", "rating": "up" | "down" }`.
- Optional `clientId` header, parsed exactly like `POST /session/:id/model`.
- Registered as `app.post(path, mutate(), withOwnerMutableSession(...))` —
  ownership scope **live-session-owner**, the same wrapper the model route
  uses. Unknown, untrusted, ambiguous, draining, or removed session states
  follow that wrapper's existing failure semantics and never fall back to the
  primary runtime.
- `200` → `{ "recorded": boolean }`. `recorded: false` means the session's
  settings disabled feedback collection (`ui.enableUserFeedback === false`);
  no event was emitted. `recorded: true` means the event was handed to
  `logUserFeedback`.
- `400` for a missing/empty `promptId` or a `rating` outside `up`/`down`.
- The route forwards to a new `AcpSessionBridge.rateSessionTurn(sessionId,
req, opts?)` method, implemented over the bridge's existing session
  extMethod request helper (timeout + channel-closed race), mirroring the
  other control-plane methods.

### ACP ext method

- Registry: `SERVE_CONTROL_EXT_METHODS.sessionFeedback =
'qwen/control/session/feedback'` in `packages/acp-bridge/src/status.ts`.
- The `qwen/control/session/` prefix makes it session-scoped automatically in
  `acpAgent.isSessionScopedExtMethod`, so it runs inside the session's id
  context like its siblings.
- SSH workspaces: allowed. The method is telemetry-only with no workspace
  side effects, so it stays out of `unsupportedSessionMethods` in
  `ssh-workspace-guards.ts`.
- Handler (`acpAgent.extMethodInternal`): validate params, resolve the session
  (`sessionOrThrow`), read the session workspace's merged settings through the
  existing cached-settings path; when `ui.enableUserFeedback === false`,
  return `{ recorded: false }` without emitting. Otherwise map the rating,
  build the event from the session's own `Config`, and call `logUserFeedback`.

### Rating mapping

| Web Shell mark | `UserFeedbackRating` | Numeric |
| -------------- | -------------------- | ------- |
| `up`           | `GOOD`               | 3       |
| `down`         | `BAD`                | 1       |

The mapping is explicit, by enum member. The TUI dialog's defect — numbering
options `GOOD: 1, BAD: 2, FINE: 3` and casting them straight into an enum
ordered `BAD = 1, FINE = 2, GOOD = 3` — must not be reproduced: unit tests pin
`up → 3` and `down → 1` by value.

### Event payload

The daemon side fills every identity field from the live session `Config`;
the client sends only `promptId` and `rating`:

- `session_id`: `config.getSessionId()`.
- `rating`: the mapped enum value.
- `model`: `config.getModel()`.
- `approval_mode`: `config.getApprovalMode()`.
- `prompt_id`: the request's `promptId` — the daemon's admitted per-turn uuid,
  the same identity the marks are stored under and the turn routes address.

This keeps stale client state out of the event: the child's `Config` is the
authority for model and approval mode at the moment of the mark.

### Gating

Three independent gates, each with a distinct owner:

1. **Capability** — new baseline tag `session_turn_feedback: { since: 'v1' }`
   in `SERVE_CAPABILITY_REGISTRY`. Advertised unconditionally by the legacy
   daemon; not carried into the hosted persona (no `hostedPersona` flag). The
   standalone client enables the marks only when
   `connection.capabilities.features` includes the tag, so an older daemon
   keeps today's footer exactly.
2. **Feedback collection setting** — `ui.enableUserFeedback === false` in the
   session workspace's merged settings skips emission (`recorded: false`).
   The TUI reads the same key to suppress its dialog; honoring it here keeps
   one user-facing meaning for the setting. The marks themselves stay visible
   as local presentation state.
3. **Usage statistics** — unchanged, enforced inside
   `QwenLogger.getInstance(config)`: when the user opted out
   (`privacy.usageStatisticsEnabled`, env `QWEN_USAGE_STATISTICS_ENABLED`),
   the RUM upload sink is absent. The local `ui_telemetry` chat record and the
   OTel sink behave exactly as they do for every other `logUserFeedback`
   caller; this change adds no new privacy surface.

### Client wiring

- `App.tsx` computes the effective `assistantFeedback` customization: a
  host-provided option wins untouched (embedded hosts keep exact control,
  including `enabled: false`); otherwise, when running standalone with the
  capability present, it supplies an `onRate` that fires the session action.
  The standalone entry (`main.tsx`) needs no change.
- The `onRate` handler ignores `rating: null` (clearing is local-only) and
  otherwise calls the new `rateAssistantTurn` session action fire-and-forget:
  failures are logged and swallowed. The mark has already landed in the UI
  and storage before the notification runs — the existing notification
  contract — and nothing in the wire path can change that.
- The action resolves the current session; with no session it is a no-op.
  Rapid session switches follow the existing action-layer owner guards, so a
  late response cannot attribute a mark to a different session.
- SDK: hand-written types per the daemon SDK convention —
  `RateSessionTurnResult` in
  `packages/sdk-typescript/src/daemon/types.ts`, `DaemonClient.rateSessionTurn`
  modeled on `setSessionModel` (fetch with timeout, JSON body, clientId
  header, `failOnError`), and a `DaemonSessionClient` wrapper.

### Sinks and observability

`logUserFeedback` (existing) writes three sinks:

- `uiTelemetryService` in-memory UI event.
- A `system` / `ui_telemetry` chat record carrying the event in
  `systemPayload.uiEvent`, appended to the session JSONL by the chat recording
  service. This is the locally observable proof that the event traversed the
  logger with the right fields, and the E2E assertion seam.
- `QwenLogger.logUserFeedbackEvent` → RUM action event `user` /
  `user_feedback` (usage-statistics gated), plus the OTel log when the SDK is
  initialized.

## Decisions and rationale

- **Route through the session-owning ACP child, not the daemon process.**
  Every telemetry logger takes the session `Config`, and the daemon process
  does not have one — synthesizing a Config there would fork model, approval
  mode, and settings away from the session's authority. The child already
  emits telemetry for daemon-driven turns; the new ext method joins that
  proven path instead of opening a second one.
- **Reuse `extMethod`, not a new standard ACP method.** The control plane
  already carries every session mutation this way (`SERVE_CONTROL_EXT_METHODS`),
  with timeouts, channel-closed races, session-id context, and SSH guards
  handled by shared machinery. A standard-method proposal would add protocol
  surface for a qwen-specific signal.
- **Daemon fills model and approval mode.** The client's view of both can lag
  (model switches, mode changes); the child's `Config` is current at click
  time. The client payload stays minimal: two fields.
- **Clearing emits nothing.** `UserFeedbackEvent` has no cleared state, and
  inventing one would change a shared telemetry schema for a UI nuance. A
  clear→re-mark sequence emits one event per mark transition, matching the
  notification hook's "every change" semantics.
- **Fire-and-forget on the client.** The original design's core invariant is
  that the host is a listener, never an authority. Awaiting the wire or
  reverting on failure would make the icon depend on a network round trip.
  Best-effort delivery is the same contract every other telemetry sink has.
- **Capability-gated opt-in inside App, not the entry.** The entry has no
  session client; App already owns capability-gated standalone behavior
  (auto-recap is the precedent). Keeping the host prop authoritative means
  embedded hosts see zero behavior change.
- **`promptId` validated as a non-empty string only.** The marks are offered
  only for turns whose admitted id the transcript carries, so honest clients
  always send a real one. Cross-checking the turn index would add a scan to a
  telemetry-only surface; the daemon is token-authenticated and local.

## Constraints

- The wire path requires the live owning session. A mark clicked after the
  session's child exited fails the route's ownership resolution; the mark
  stays lit locally and the event is dropped (best-effort).
- Separate tabs each emit their own clicks; there is no dedup across
  instances, consistent with the local storage's existing multi-instance
  constraint.
- Split-view panes inherit the standalone option but own a different session
  than the app-level dispatch target. The wiring drops payloads whose
  `sessionId` differs from the app-level session, so a pane mark lights
  locally but emits no telemetry rather than mis-pairing a foreign
  `promptId` with the app session's identity. Pane telemetry awaits a
  dispatch that reaches the pane's own session client.
- The hosted persona and Managed channels do not advertise the tag; the
  standalone client against such a daemon shows no marks.
- `recorded: true` attests emission into `logUserFeedback`, not RUM delivery:
  the RUM flush is periodic and best-effort, and usage-statistics opt-out
  removes that sink entirely.

## Risks

- A buggy or hostile local client could send an arbitrary `promptId` and
  pollute analytics; mitigated by token auth and the non-empty validation,
  accepted as a telemetry-only surface.
- Fire-and-forget drops events silently when the child is restarting or the
  request times out. This matches telemetry's existing best-effort contract;
  the UI mark is unaffected.
- The standalone `onRate` adds a second consumer of the notification hook;
  if a future host embeds the standalone entry's behavior, host precedence
  must be preserved (covered by tests).

## Files affected

| File                                                                    | Change                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/serve/routes/session.ts`                              | New `POST /session/:id/feedback` route (live-session-owner).                                                     |
| `packages/sdk-typescript/src/daemon/capabilities.ts`                    | `session_turn_feedback` registry tag (the registry lives in the SDK; the serve module re-exports it).            |
| `packages/cli/src/serve/capability-parity.ts`                           | Parity row: no Managed equivalent.                                                                               |
| `packages/cli/src/serve/server.test.ts`                                 | Expected advertised-features list.                                                                               |
| `integration-tests/cli/qwen-serve-routes.test.ts`                       | Expected advertised-features list.                                                                               |
| `packages/acp-bridge/src/status.ts`                                     | `SERVE_CONTROL_EXT_METHODS.sessionFeedback`.                                                                     |
| `packages/acp-bridge/src/bridgeTypes.ts`                                | `AcpSessionBridge.rateSessionTurn` + request/result types.                                                       |
| `packages/acp-bridge/src/session-control-plane.ts`                      | Bridge implementation over the session extMethod helper.                                                         |
| `packages/cli/src/acp-integration/acpAgent.ts`                          | `extMethodInternal` case: gates, mapping, `logUserFeedback`.                                                     |
| `packages/cli/src/serve/server/telemetry.ts` (+ `.test.ts`)             | Feedback route catalog entry (`handler_resolved`) and the audited route counts.                                  |
| `package.json` + `scripts/tests/no-ak-integration-ci.test.js`           | No-AK CI enrollment of the integration suite (list and pinned argv together).                                    |
| `integration-tests/cli/_daemon-harness.ts`                              | `envDrop` option so hermetic rigs can strip host-session env leakage.                                            |
| `packages/sdk-typescript/src/daemon/index.ts`                           | Barrel re-export of `RateSessionTurnResult`.                                                                     |
| `packages/sdk-typescript/src/daemon/types.ts`                           | `RateSessionTurnResult`.                                                                                         |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts`                    | `rateSessionTurn` POST method.                                                                                   |
| `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`             | Session-handle wrapper.                                                                                          |
| `packages/web-shell/client/daemon/session/actions.ts`                   | `rateAssistantTurn` action.                                                                                      |
| `packages/web-shell/client/daemon/chat-capabilities.ts`                 | Exhaustive feature→region map entry: no chat region flips with the tag.                                          |
| `packages/web-shell/client/App.tsx`                                     | Standalone, capability-gated `assistantFeedback` wiring with host precedence and a cross-session dispatch guard. |
| `docs/developers/qwen-serve-protocol.md`                                | Route + capability documentation, next to the turn-status section.                                               |
| `docs/design/web-shell/web-shell-assistant-feedback.md` (+ `.zh-CN.md`) | Standalone opt-in and telemetry status updated, linked here.                                                     |

Tests are collocated with each changed source file per repository convention.

## Validation plan

Unit tests (per layer, collocated):

- Route: body validation matrix (missing/empty `promptId`, invalid `rating`,
  valid bodies), clientId header parsing, bridge forwarding, ownership
  wrapper behavior inherited from the shared helper.
- Agent handler: `up → GOOD(3)` and `down → BAD(1)` pinned by numeric value;
  event fields taken from the session Config; `ui.enableUserFeedback ===
false` → `{ recorded: false }` and no logger call; missing session →
  invalid params; usage-statistics opt-out leaves RUM absent (existing
  `QwenLogger` gate, asserted at the handler boundary).
- Bridge: ext method name, params shape, timeout/closed-channel propagation.
- SDK: request URL, method, body, clientId header, error propagation.
- Web Shell: action no-op without a session and error containment; App wiring
  matrix — capability absent → no marks; capability present → marks + wire
  call on `up`/`down`, no wire call on `null`; host-provided option wins,
  including `enabled: false`.

E2E (real daemon + real browser; plan in `.qwen/e2e-tests/`):

- Baseline gap: today's standalone page shows no marks; `POST
/session/:id/feedback` is unrouted.
- After: complete a turn, click Satisfied → HTTP 200 `{ recorded: true }`;
  the session JSONL gains a `system/ui_telemetry` record whose
  `systemPayload.uiEvent` has `event.name === 'qwen-code.user_feedback'` (the
  canonical name `logUserFeedback` stamps; the event class itself carries
  `user_feedback`), `rating === 3`, and `prompt_id` equal to the turn's
  admitted promptId. Not satisfied → `rating === 1`. Clearing the lit mark →
  no new record and no wire call.
- `ui.enableUserFeedback: false` in the workspace settings → `{ recorded:
false }`, no record; marks still light locally.
- RUM delivery itself is not asserted against the live endpoint (it would
  send real data to the production sink); the chat record plus the unit-level
  logger assertions cover the path up to the existing, shared RUM enqueue.

## Acceptance criteria

- With a daemon advertising `session_turn_feedback`, the standalone Web Shell
  shows the marks on completed interactive turns; clicking one lights it
  immediately and emits exactly one `user_feedback` event with the correctly
  mapped rating and the turn's `promptId`.
- The event's `session_id`, `model`, and `approval_mode` come from the live
  session Config, not the client.
- Clearing a mark emits nothing; embedded hosts and older daemons behave
  exactly as before.
- `ui.enableUserFeedback === false` suppresses emission while leaving the
  local mark UX intact; usage-statistics opt-out continues to remove the RUM
  sink.
- A wire failure never reverts, blocks, or delays the visible mark.

## Open questions

None blocking. Server-side persistence of the mark itself remains the
original design's follow-up, untouched here.
