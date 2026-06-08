# Remote-Control Gateway — Policy Engine Part 2: Enforcement (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 14)
**Scope:** Wire the cycle-13 evaluator into the live event path so matching `allow`
/`deny` rules **auto-vote** on `permission_request` events (and `prompt` falls
through to push) — the gateway-side realization of `add-policy-engine`. Builds on
cycles 10 (pump), 9 (notifier), 13 (evaluator).

## Deviation recap

Proposal evaluates inside the daemon pre-emit; we evaluate on the pumped SSE event
and auto-vote via the cycle-6 route a beat later (clients may briefly see a card
that auto-resolves). Same security outcome, zero upstream edits.

## Security note (this is the sensitive cycle)

This cycle makes the gateway **act autonomously** (cast approve/deny votes). The
cycle-13 safety invariant (deferred-field rules downgrade to `prompt`) plus
fail-closed defaults (no policy file → everything is `prompt` → nothing
auto-votes → behavior identical to pre-policy) keep it safe. A bug here could
auto-approve a tool call the user didn't sanction, so: default-prompt is the floor,
`deny` is never overridable by a client, and every decision is audited.

## This cycle's scope

**In:** a `PolicyEnforcer` that, for a `permission_request` event, evaluates policy
and auto-votes (`allow`→selected, `deny`→cancelled) or signals fall-through; pump
integration (enforcer consulted for permission_request; push suppressed when
auto-handled); boot-load `~/.qwen/rc/policy.yaml`; a `policy_decision` audit action.

**Deferred:** workspace `<cwd>/.qwen/policy.yaml` merge; hot-reload + `qwen rc
policy` CLI; timeOfDay/expiresAt/quota evaluation; the `policy_decision` SSE frame
to clients (we audit it; surfacing it in the viewer is a later polish); web UI.

## Decisions

1. **`PolicyEnforcer` owns the evaluate+vote+audit logic** so the pump stays thin
   and the enforcer is unit-testable against the stub daemon.
2. **Build `ToolCallContext` defensively from the event.** From
   `event.data` (`permission_request`): `tool` =
   `data.toolCall?.name || data.toolCall?.title || data.toolName || ''`; `args` =
   `data.toolCall?.input ?? data.toolCall?.args ?? data.toolCall ?? {}`;
   `requestId` = `data.requestId`; the approve option id =
   `data.options?.[0]?.optionId`. `originScope`/`sessionTag` are not on the event
   yet → left undefined (rules using them won't match — fine).
3. **Auto-vote uses the cycle-6 SDK shape.** allow →
   `respondToSessionPermission(sessionId, requestId, { outcome: { outcome:
'selected', optionId } })`; deny → `{ outcome: { outcome: 'cancelled' } }`.
4. **`allow` with no usable `optionId` or no `requestId` → DO NOT vote; fall
   through to prompt/push** (fail-safe: never fabricate a vote).
5. **Vote failures are swallowed** (best-effort, never throw into the pump); a
   failed auto-vote falls through to push so the human still gets pinged.
6. **`policy_decision` audit** `{ requestId, action, ruleId?, voted: boolean }` on
   every evaluated permission_request (allow/deny/prompt). Never the args.
7. **Fail-closed default.** Empty/absent policy → evaluator returns `prompt` for
   all → enforcer never votes → identical to pre-policy behavior.

## Components

### `PolicyEnforcer` (`src/policy/enforcer.ts`) — new

```ts
export class PolicyEnforcer {
  constructor(daemon: DaemonClient, policy: Policy, audit?: AuditRecorder);
  setPolicy(policy: Policy): void; // for a future reload
  /**
   * Evaluate a permission_request event and, on allow/deny, cast the vote.
   * Returns true if the event was auto-handled (caller should NOT push).
   */
  handlePermission(
    sessionId: string,
    event: { type: string; data: unknown },
  ): Promise<boolean>;
}
```

- If `event.type !== 'permission_request'` → return false (not ours).
- Build ctx + requestId + approveOptionId (decision §2).
- `const d = evaluate(this.policy, ctx)`.
- `allow`: if `requestId` and `approveOptionId` → try vote `selected`; on success
  audit `policy_decision {requestId, action:'allow', ruleId, voted:true}`, return
  true. If missing id/option or vote throws/returns false → audit `{action:'allow',
voted:false}` and return false (fall through to push).
- `deny`: if `requestId` → try vote `cancelled`; success → audit `{action:'deny',
voted:true}`, return true; else `{voted:false}`, return false.
- `prompt`: audit `{action:'prompt', ruleId, voted:false}`, return false.
- All daemon calls wrapped in try/catch (swallow → return false). Never throws.

### Pump integration (`src/webpush/pump.ts`)

- Optional `enforcer?: PolicyEnforcer` in `SessionEventPumpOptions`.
- In `runLoop`, for each event: if `enforcer` and `event.type ===
'permission_request'` → `const handled = await enforcer.handlePermission(
sessionId, event)`; if `handled` → continue (skip notify). Else →
  `await notifier.notify({type, data}, ctx)` as today.
- `onDispatch` still fires (with a flag or unchanged) so tests can observe.

### Audit (`src/auditLog.ts`)

Add `'policy_decision'` to the `AuditAction` union + `AUDIT_ACTIONS`.

### Boot (`src/cli.ts`, `src/server.ts`)

- `createGatewayApp` already returns `{ app, notifier }`. Add `enforcer?` to the
  return (built when a policy is supplied) OR — simpler — build the enforcer in
  `cli.ts` after loading the policy and pass it into the pump. **Decision:** build
  in `cli.ts`: `const policy = (await loadPolicyFile(join(homedir(),'.qwen','rc',
'policy.yaml'))) ?? { defaults:{action:'prompt',requireScope:'approve'}, rules:[]
}; const enforcer = new PolicyEnforcer(handle.daemon, policy);` (with the gateway
  app's audit — see note) and `new SessionEventPump(handle.daemon, notifier, {
enforcer })`. Banner line: `policy: <n> rules` (or `default-prompt` when 0).
  - Audit note: the enforcer should share the gateway's AuditLog. Simplest: have
    `createGatewayApp` also return the `audit` instance (or accept an injected one),
    so cli.ts passes the SAME audit into the enforcer. **Decision:** add `audit` to
    the `createGatewayApp` return alongside `notifier`.

### Stub daemon

`POST /session/:id/permission/:requestId` already exists (cycle 6,
`permissionStatus`). Reused to assert the enforcer's vote (status drives
voted/handled). The stub ignores the body, so the vote SHAPE is covered by
typecheck + the cycle-6 real-daemon e2e, not here.

## Testing strategy (TDD)

**`enforcer.test.ts`** (real `DaemonClient`→stub, fake `AuditRecorder`):

- allow rule + event with `options:[{optionId:'ok'}]`, stub `permissionStatus:200`
  → `handlePermission` returns true; audit `policy_decision {action:'allow',
voted:true, ruleId}`.
- deny rule → returns true; audit `{action:'deny', voted:true}`.
- prompt (default, empty policy) → returns false; audit `{action:'prompt',
voted:false}`.
- allow rule but event has NO options → returns false (no vote), audit
  `{action:'allow', voted:false}`.
- stub `permissionStatus:404`/`500` on an allow → vote not accepted/throws →
  returns false (fall through), `voted:false`.
- non-`permission_request` event → returns false, no audit.

**`pump.test.ts`** (extend): pump with an `enforcer` whose policy denies bash; a
`permission_request` for bash → notifier.notify is NOT called (auto-handled);
with an empty-policy enforcer (prompt) → notify IS called.

**`server.test.ts`**: `createGatewayApp` returns `audit` (assert defined).

**e2e:** unchanged (auto-vote against a real daemon needs a live permission flow;
the enforcer logic is unit-covered). Optionally assert boot with a policy file
doesn't crash — skip if not trivial.

## File boundary

All within `packages/rc-gateway/`. New: `src/policy/enforcer.ts` (+ test).
Modified: `src/webpush/pump.ts` (+ test), `src/auditLog.ts` (1 action),
`src/server.ts` (return `audit`), `src/cli.ts` (load policy + enforcer + banner),
`src/index.ts` (export `PolicyEnforcer`), `src/server.test.ts`. Zero upstream edits.

## Follow-on

Then `add-policy-engine` core is functional. Later cycles: workspace policy merge;
timeOfDay/expiresAt + quota counters (Phase 2 — adds a clock + WAL); hot-reload +
`qwen rc policy {reload,explain,lint}` (Phase 3); `policy_decision` SSE frame +
viewer rendering + web UI (Phase 4). Next proposal per backlog:
`add-notification-routing` (which now has both policy decisions and push to route
between).
