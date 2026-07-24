# Remote approval mode — design (2026-07-23)

A thin rc-gateway surface to **set** a daemon session's approval mode
(including plan mode) from off the workstation, and to **observe** mode
transitions live. P3 of the permissions arc.

The daemon side already exists and is not modified: `POST
/session/:id/approval-mode`, the SDK `setSessionApprovalMode`, the
`approval_mode_changed` SSE event, and the trust-gate contract. This
change adds only the gateway surface — a route, a scope policy, an
owner-stream forward, an audit action, and a notification kind.

## Premise (verified)

The gateway has **zero** approval-mode awareness today — grep of
`packages/rc-gateway/src` for `approval_mode_changed` / `approvalMode` /
`setSessionApprovalMode` returns nothing: no route, no scope, no audit
action, no owner-stream forward. Everything here is new gateway work
over an unchanged daemon.

What already exists and is reused:

- **SDK setter** (`DaemonClient.setSessionApprovalMode(sessionId, mode,
{ persist? })`, `DaemonClient.ts:863`) → daemon `POST
/session/:id/approval-mode`, returning `DaemonApprovalModeResult
{ sessionId, mode, previous, persisted }` (`types.ts:724`).
- **Modes** `DAEMON_APPROVAL_MODES = ['plan','default','auto-edit',
'auto','yolo']` (`types.ts:706`).
- **Trust gate:** core throws `TrustGateError` for a non-`plan`,
  non-`default` mode in an untrusted folder (`config.ts:2945`); the
  daemon surfaces it as **HTTP 403 `{ code:'trust_gate',
errorKind:'auth_env_error' }`** (`server.ts:2441`). `plan`/`default`
  are trust-gate-exempt (always allowed).
- **SSE event** `approval_mode_changed` with payload
  `{ sessionId, previous, next, persisted, originatorClientId? }`
  (`events.ts:333`). The gateway does not forward it today.
- **No daemon read path.** There is no `GET
/session/:id/approval-mode` and no SDK getter. The only remote way to
  learn the current mode is to observe the change event — so this design
  forwards that event rather than synthesizing a GET that would report
  "unknown" until the first observed change.

## Scope decisions (user-confirmed)

- **Set + forward the change event** (not set-only, not a synthesized
  GET). The setter changes the mode; a separate path forwards the
  daemon's `approval_mode_changed` onto the owner stream so transitions
  are visible **regardless of origin** (local CLI, another device, or
  this route).
- **Tiered scope WRITE/OWNER** (not owner-for-all): `plan`/`default`
  require `WRITE`; the auto-\* modes require `OWNER`.
- **Warn on out-of-band plan exit**: the response carries a
  `planExitedOutOfBand` flag; no behavior change.

## Control plane

| Endpoint                                               | Scope                                                                                 | Behavior                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /session/:id/approval-mode` `{ mode, persist? }` | `WRITE`; escalates to `OWNER` if `mode ∈ {auto-edit,auto,yolo}` **or** `persist:true` | Validate → `daemon.setSessionApprovalMode` → `200 { sessionId, mode, previous, persisted, planExitedOutOfBand }` |

### Route (`routes/approvalMode.ts`, new)

Mirrors `createRewindRoute`'s shape: a narrowed daemon type
(`Pick<DaemonClient,'setSessionApprovalMode'>`) and a minimal deps object
`{ audit? }`. The route does not take `bus`/`notifier` — it neither
publishes to the owner stream nor sends a notification (the pump forward
in "Observation" owns both, from the daemon's own event, to avoid a
double-emit). Actor is derived from `req.rcClient?.id` (never the body);
audit records ids/enum-values only.

Handler steps:

1. **Validate.** `mode` must be a string in `DAEMON_APPROVAL_MODES` else
   `400 { code:'invalid_approval_mode', allowed: DAEMON_APPROVAL_MODES }`
   (mirrors the daemon's own code). `persist`, if present, must be a
   boolean else `400 { code:'invalid_persist_flag' }`.
2. **Scope escalation** (in-handler; the mount floor is
   `requireScope(WRITE)`). `const needsOwner = POWER_MODES.has(mode) ||
persist === true;` where `POWER_MODES = {auto-edit, auto, yolo}`. If
   `needsOwner && !hasScope(req.rcClient.scopes, OWNER)` → `403
{ code:'owner_scope_required' }` and a `scope_denied` audit row.
   Rationale: `plan`/`default` only restrict or reset — no new power
   granted; the auto-\* modes hand the model standing auto-approval;
   `persist:true` writes durably to the host's `settings.json`, which the
   SDK deliberately keeps opt-in so a remote caller does not pollute host
   settings.
3. **Set.** `const result = await daemon.setSessionApprovalMode(id, mode,
persist ? { persist: true } : {})`.
4. **Map daemon errors.**
   - `403 trust_gate` / `errorKind:'auth_env_error'` → surface unchanged
     (`403 { code:'trust_gate', errorKind:'auth_env_error' }`): the
     workstation folder is untrusted for that mode. This is the daemon's
     decision; the gateway does not second-guess it.
   - `404` (older daemon without the `session_approval_mode_control`
     capability) → `502 { code:'approval_mode_unsupported' }`.
   - transport failure → `502 { code:'daemon_unavailable' }`.
5. **Compute** `planExitedOutOfBand = result.previous === 'plan' &&
result.mode !== 'plan'`.
6. **Audit** (fire-and-forget): `action:'session_approval_mode_set'`,
   actor `req.rcClient?.id`, target `sessionId`, detail
   `{ mode, previous: result.previous, persisted: result.persisted,
planExitedOutOfBand }` — enum values + booleans only, never content.
7. **Respond** `200 { sessionId, mode: result.mode, previous:
result.previous, persisted: result.persisted, planExitedOutOfBand }`.

The route does **not** publish to the owner stream (see Observation) —
that would double-emit, because the set causes the daemon to emit
`approval_mode_changed`, which the forward path already broadcasts.

### Mount (`server.ts`)

Mounted after the `notifier` `let` is assigned (like the rewind route,
same temporal-dead-zone reason), with the middleware chain
`requireScope(WRITE, audit)` → `recordActivity(workingDevice)` →
`enforceSessionLock(audit)` → `createApprovalModeRoute(deps.daemon,
{ audit })`. WRITE is the floor; OWNER is enforced in-handler because it
is conditional on the requested mode/persist.

## Observation — forwarding the change event

The `SessionEventPump` already subscribes to live daemon sessions and
exposes an `onEvent(sessionId, event)` seam (`pump.ts:45,231`), which
`cli.ts` already wires for usage ingestion and the agent/review
lifecycles. Extend that existing handler with one branch:

```ts
if (ev.type === 'approval_mode_changed') {
  const d = ev.data as {
    sessionId?: string;
    previous?: string;
    next?: string;
    persisted?: boolean;
  };
  ownerEvents.publish({
    type: 'approval_mode_changed',
    mode: {
      sessionId: sid,
      previous: typeof d.previous === 'string' ? d.previous : '',
      next: typeof d.next === 'string' ? d.next : '',
      persisted: d.persisted === true,
    },
  });
  void notifier
    ?.notify(
      { type: 'approval_mode_changed', data: ev.data },
      { sessionId: sid },
    )
    .catch(() => {});
}
```

`ownerEvents` and `notifier` are both in scope at the pump construction
site (`cli.ts:548,1118`). Because the source is the _daemon's_ event, a
mode change made **locally at the workstation or from another device**
is forwarded too — not only gateway-initiated changes.

New `OwnerEvent` arm (`ownerEvents.ts`, mirroring the review-lifecycle
arm — a dedicated payload + union member; the `/rc/events` route
JSON-stringifies the whole frame, so no route change):

```ts
export interface ApprovalModePayload {
  sessionId: string;
  previous: string;
  next: string;
  persisted: boolean;
}
// union arm:
| { type: 'approval_mode_changed'; mode: ApprovalModePayload }
```

### Notification

New routable kind `session.approval_mode_changed`:

- `webpush/payload.ts` — a `buildPayload` branch: `kind:
'session.approval_mode_changed'`, `summary: 'Approval mode → ' +
next` (mode names are a closed enum, so no content leak). Read `next`
  from `event.data`, defaulting to a generic label if absent.
- `webpush/notifier.ts` — `KIND_SCOPE['session.approval_mode_changed'] =
SESSION_READ`. Do **not** add it to `SNOOZE_BYPASS_KINDS`: a mode
  change is informational and must respect quiet hours.

## Audit

New action `session_approval_mode_set`, added to **both** the
`AuditAction` union and the `AUDIT_ACTIONS` runtime array
(`auditLog.ts`). Detail is `{ mode, previous, persisted,
planExitedOutOfBand }` — enum values and booleans only; never args,
paths, or prompt text. A rejected owner-scope escalation records the
existing `scope_denied` action via `requireScope`/the in-handler check,
not a new action.

## Error handling

| Failure                                                    | Behavior                                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode` missing/not in the enum                             | `400 invalid_approval_mode` with the `allowed` list.                                                                                                                       |
| `persist` present but non-boolean                          | `400 invalid_persist_flag`.                                                                                                                                                |
| auto-\* mode or `persist:true` without `owner` scope       | `403 owner_scope_required` + `scope_denied` audit; no daemon call.                                                                                                         |
| Untrusted folder + auto-\* mode (daemon trust gate)        | `403 trust_gate` (`errorKind:'auth_env_error'`), surfaced unchanged.                                                                                                       |
| Older daemon lacking the capability (404)                  | `502 approval_mode_unsupported`.                                                                                                                                           |
| Daemon transport failure                                   | `502 daemon_unavailable`.                                                                                                                                                  |
| Session lock mismatch (share token)                        | `403 session_locked` (via `enforceSessionLock`, before the handler).                                                                                                       |
| `approval_mode_changed` arrives before the pump subscribes | The forward is missed for that one transition; the setter's `200` response still carried the authoritative result. Acceptable for active sessions the pump already tracks. |

## Threat model

| Attacker                  | Capability                                                 | Mitigation                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised `write` token | Flip a session to an auto-approval mode (standing power)   | The auto-\* modes require `owner`, not `write`; `write` can only set `plan`/`default` (restrict/reset).                                                                                                                                              |
| Compromised `owner` token | Grant `yolo` remotely / persist it to host settings        | `owner` required and audited; the daemon's trust gate still blocks auto-\* modes in an untrusted folder (defense in depth); `persist` is a separate owner gate so a durable host-settings change is never incidental.                                |
| Any                       | Leak session content via the notification/audit            | Payloads carry only the mode enum values + booleans + ids; the daemon's `approval_mode_changed` frame contains no args or prompt text.                                                                                                               |
| Any                       | Silently drop a pending plan by exiting plan mode remotely | Not prevented (it mirrors the daemon's own behavior), but surfaced: `planExitedOutOfBand` in the response lets a remote UI warn. Low consequence — a remotely-set plan almost always came from `default`, so there is nothing meaningful to restore. |
| Malicious LAN process     | Forge a set                                                | Same auth surface as every gateway route: scope-gated bearer token; no new unauthenticated path.                                                                                                                                                     |

**Residuals (documented, accepted):**

- **No point-in-time read.** The daemon exposes no current-mode getter,
  so a client that never observed a change cannot query the mode; it
  must watch the forwarded event or read its own last `set` response.
  Adding a synthesized GET was rejected — it would report "unknown"
  until the first observed change, which is worse than honest absence.
- **Out-of-band plan exit** discards `prePlanMode` and skips the
  `ExitPlanMode` confirmation, as above.
- **Pump subscription race** for a transition that lands before the pump
  attaches to a session — the forward is best-effort; the setter
  response is authoritative.

## Alternatives considered

- **Set-only (no forward).** Rejected: without forwarding, a remote
  client can only know the mode it set itself and can't see local or
  other-device changes — no live observability, which was the point.
- **Synthesized `GET` tracking observed events.** Rejected: it would
  return "unknown" until the first change is seen (the daemon exposes no
  initial value), presenting an approximate reading as authoritative.
- **OWNER for all modes.** Rejected: makes flipping a session to the
  strictly-safer `plan` mode an owner-only action; the tiered policy
  matches actual risk.
- **Block remote plan-exit.** Rejected: the gateway can't read current
  mode before acting (no getter), so it can't cleanly enforce or roll
  back; warn-in-response gives the same protection value at no cost.
- **Route publishes the owner event itself** (instead of the pump
  forward). Rejected: it would cover only gateway-initiated changes and
  double-emit with the daemon's event; the pump forward is the single
  origin-agnostic path.

## Testing

Vitest, existing stub-daemon pattern:

- **Route:** validation (bad mode → 400 with `allowed`; bad persist →
  400); tiered scope (`write` sets `plan`/`default`; `write` + `auto` →
  403 owner_scope_required; `write` + `persist:true` → 403; `owner` sets
  `yolo`); daemon error mapping (trust-gate 403 passthrough, 404 →
  502 unsupported, transport → 502); `planExitedOutOfBand` true when the
  stub reports `previous:'plan'` and false otherwise; the audit row
  carries the flags and no content.
- **Forward:** an `approval_mode_changed` frame through the pump's
  `onEvent` produces one owner-stream `approval_mode_changed` arm and one
  `notify` call; the route itself publishes nothing (no double-emit).
- **Payload:** `buildPayload` maps `approval_mode_changed` →
  `session.approval_mode_changed` with a `→ <mode>` summary and no
  content; `KIND_SCOPE` gate present; not in `SNOOZE_BYPASS_KINDS`.
- **Integration:** trigger `POST /session/:id/approval-mode` against the
  stub → 200 with the result → the forwarded owner frame observed on
  `GET /rc/events`.

## Spec artifacts (qwen-code-remote)

Ships as OpenSpec change `add-remote-approval-mode` (proposal, design,
tasks, `specs/remote-approval-mode/spec.md`). Registry edits made
directly in `add-remote-control`'s authoritative tables: **1 SSE row**
(`approval_mode_changed`), **1 audit row** (`session_approval_mode_set`),
**1 notification kind** (`session.approval_mode_changed`) — no
partial-content `## MODIFIED` fragments.

## Follow-ups (out of scope)

- A daemon `GET /session/:id/approval-mode` (and SDK getter) would enable
  an exact point-in-time read; needs a daemon change, so deferred.
- P4 — runtime decision "why" (surface the policy rule reason/trace at
  enforcement time), independent of this change.
