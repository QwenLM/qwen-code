# RC Gateway — Policy Engine Part 2: Enforcement (Cycle 14)

> **For agentic workers:** TDD, `- [ ]` steps. All inside `packages/rc-gateway/`. ZERO edits outside it. This cycle makes the gateway auto-vote — fail-closed and audit everything.

**Goal:** A `PolicyEnforcer` that auto-votes allow/deny on `permission_request` events (prompt → fall through to push), wired into the pump, with boot-loaded policy and a `policy_decision` audit action.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-policy-enforcement-design.md` — full enforcer contract, defensive ctx extraction, vote shapes, and the fail-safe rules. Implement as written.

**Builds on:** cycle 13 evaluator (`evaluate`, `loadPolicyFile`, `Policy`), cycle 10 pump, cycle 9 notifier, cycle 6 vote shape (NESTED `{outcome:{outcome:'selected',optionId}}` / `{outcome:{outcome:'cancelled'}}`).

**Conventions:** license headers; `.js` imports; commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; run git/npm from repo root `/home/evan/projects/qwen-code`.

---

### Task 1: `policy_decision` audit action

- [ ] `src/auditLog.ts`: add `'policy_decision'` to the `AuditAction` union AND `AUDIT_ACTIONS`.
- [ ] typecheck. Commit: `feat(rc-gateway): policy_decision audit action`.

### Task 2: PolicyEnforcer (TDD)

**Files:** `src/policy/enforcer.ts` (+ `enforcer.test.ts`); export from `src/index.ts`.

- [ ] Failing test per design's `enforcer.test.ts` bullets (real `DaemonClient`→`startStubDaemon`, fake audit). Cover: allow+options+200→true/voted; deny→true/voted; prompt(empty policy)→false; allow+no-options→false/not-voted; stub 404/500 on allow→false; non-permission event→false/no-audit.
- [ ] Implement `PolicyEnforcer` per the design:
  - ctor `(daemon, policy, audit?)`; `setPolicy(p)`.
  - `handlePermission(sessionId, event)`: if `event.type !== 'permission_request'` → return false. Defensive extract: `data = (event.data ?? {}) as any`-equivalent (use `Record<string,unknown>` + safe reads, NO `any` — repo bans it); `tool`, `args`, `requestId`, `approveOptionId` per design §2. `const d = evaluate(this.policy, {tool, args})`.
    - allow: if `requestId && approveOptionId`: `try { const ok = await daemon.respondToSessionPermission(sessionId, requestId, {outcome:{outcome:'selected',optionId:approveOptionId}}); if (ok) { audit policy_decision {requestId, action:'allow', ruleId:d.ruleId, voted:true}; return true } } catch {}`; (any miss) → audit `{action:'allow', voted:false}`, return false.
    - deny: if `requestId`: `try { const ok = await daemon.respondToSessionPermission(sessionId, requestId, {outcome:{outcome:'cancelled'}}); if (ok){ audit {action:'deny',voted:true}; return true } } catch {}`; else audit `{action:'deny',voted:false}`, return false.
    - prompt: audit `{action:'prompt', ruleId:d.ruleId, voted:false}`, return false.
  - Never throws. Audit detail NEVER includes args.
- [ ] Test passes. Export `PolicyEnforcer`. Commit: `feat(rc-gateway): policy enforcer auto-votes allow/deny`.

### Task 3: pump integration (TDD)

**Files:** `src/webpush/pump.ts` (+ extend `pump.test.ts`).

- [ ] Add `enforcer?: PolicyEnforcer` to `SessionEventPumpOptions`; store it.
- [ ] In `runLoop`'s event loop: if `this.enforcer && ev.type === 'permission_request'` → `const handled = await this.enforcer.handlePermission(s.sessionId, {type:ev.type, data:ev.data}); if (handled) { this.opts.onDispatch?.(s.sessionId, ev); continue; }`. Else → `await this.notifier.notify({type:ev.type, data:ev.data}, {sessionId:s.sessionId, sessionName:name})` (unchanged), then `onDispatch`.
- [ ] Extend `pump.test.ts`: pump with an enforcer whose policy DENIES bash → a `permission_request` (bash) frame → `notifier.notify` NOT called (use a fake notifier counting calls); pump with an empty-policy enforcer → notify IS called. (Stub frames already configurable; set a frame with `type:'permission_request'`, data `{requestId:'r1', toolCall:{name:'bash'}, options:[{optionId:'ok'}]}`.)
- [ ] Tests pass. Commit: `feat(rc-gateway): pump consults policy enforcer before push`.

### Task 4: boot wiring + server return audit (TDD)

**Files:** `src/server.ts`, `src/cli.ts`, `src/server.test.ts`.

- [ ] `createGatewayApp` return type gains `audit: AuditLog` (the instance it already builds). Return `{ app, notifier, audit }`. Update the `boot()` destructure in server.test.ts.
- [ ] `src/server.test.ts`: assert `createGatewayApp(...)` returns a defined `audit`.
- [ ] `src/cli.ts`: `import { loadPolicyFile } from './policy/loader.js'; import { PolicyEnforcer } from './policy/enforcer.js';` After `const { app, notifier, audit } = createGatewayApp({...})`: `const policy = (await loadPolicyFile(join(homedir(),'.qwen','rc','policy.yaml'))) ?? { defaults:{action:'prompt',requireScope:'approve'}, rules:[] };` `const enforcer = notifier ? new PolicyEnforcer(handle.daemon, policy, audit) : undefined;` Pass `{ enforcer }` into `new SessionEventPump(handle.daemon, notifier, { enforcer })` (only when notifier exists, as today). Banner: `policy: ${policy.rules.length} rule(s)`.
- [ ] typecheck + build + test green. Commit: `feat(rc-gateway): load policy + wire enforcer into serve`.

### Task 5: full verification

- [ ] From repo root: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green. Then `node scripts/rc-gateway-e2e.mjs` → still passes (boot with no policy file = default-prompt, unchanged behavior).
- [ ] Commit any leftover (skip if clean).

## Self-review checklist

- **Fail-closed:** no policy file → all `prompt` → enforcer never votes → behavior identical to pre-policy (e2e proves boot still works).
- **Fail-safe vote:** allow without a usable optionId/requestId → NO vote, falls through to push. Vote errors swallowed → fall through. Enforcer never throws.
- allow/deny use the NESTED cycle-6 shape `{outcome:{outcome:...}}`.
- `policy_decision` audit on every evaluated permission_request; detail has requestId/action/ruleId/voted but NEVER the args.
- Pump still notifies non-permission events and prompt-decision permission events; auto-handled events are NOT pushed.
- `createGatewayApp` return change applied at both call sites; all prior tests green. Zero files outside `packages/rc-gateway/`.
