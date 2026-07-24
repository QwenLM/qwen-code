# Remote Approval Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a remote rc-gateway surface to set a session's approval mode (`POST /session/:id/approval-mode`) and forward the daemon's `approval_mode_changed` event to owner clients.

**Architecture:** One new route mirroring `createRewindRoute` (validate → tiered scope → `daemon.setSessionApprovalMode` → 200), plus a one-branch extension of the session-event pump's existing `onEvent` handler that forwards the daemon's `approval_mode_changed` onto the owner stream + as a notification. The daemon is unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, Express, Vitest, `@qwen-code/sdk` `DaemonClient`. Two repos: specs in `qwen-code-remote`, implementation in the `qwen-code` fork (`packages/rc-gateway`), branch `add-remote-control-spec`.

## Global Constraints

- **Design source of truth:** `docs/superpowers/specs/2026-07-23-remote-approval-mode-design.md`. Every task implements part of it.
- **No daemon change.** Nothing under `packages/cli/src/serve` or `packages/core` may be modified. The gateway reaches the daemon only through the existing `DaemonClient.setSessionApprovalMode` and the SSE stream. `packages/rc-gateway/src/cli.ts` (the gateway boot file) IS in scope; the daemon's `packages/cli/src/serve` is NOT.
- **No edits outside `packages/rc-gateway/`** in the fork (importing from `@qwen-code/sdk` / `@qwen-code/qwen-code-core` is fine and precedented).
- **ESM `.js` import specifiers**, matching the existing `packages/rc-gateway/src` style.
- **Modes** are exactly `DAEMON_APPROVAL_MODES = ['plan','default','auto-edit','auto','yolo']` (imported from `@qwen-code/sdk`). `POWER_MODES = {'auto-edit','auto','yolo'}` require OWNER; `plan`/`default` require only WRITE.
- **`persist:true` requires OWNER** regardless of mode (durable host-settings write).
- **Fail-closed:** an unknown mode or non-boolean persist → `400`; insufficient scope → `403`; the route never grants more than the request explicitly asks for.
- **Audit/notification carry only ids, mode enum values, and booleans** — never args, paths, or prompt text.
- **Two repos.** Task 0 authors an OpenSpec change in `/home/evan/projects/qwen-code-remote` (branch `add-remote-approval-mode`, PR'd to `main`). Tasks 1–5 are fork implementation on `add-remote-control-spec`. Spec first.
- **Never a partial-content `## MODIFIED Requirements` fragment.** A MODIFIED block MUST carry the complete requirement (header + all scenarios). Register the new rows by DIRECT edit to the authoritative `add-remote-control` tables.
- **Commit after every task.** Pre-commit hooks run prettier/eslint on staged files; let them reformat.
- **Scope constants** (`packages/rc-gateway/src/scopes.ts`): `WRITE='write'`, `OWNER='owner'`, `SESSION_READ='session:read'`; `hasScope(granted, required)` is transitive (`owner ⊃ write ⊃ session:read`).

---

## File Structure

**qwen-code-remote (specs):**

- Create `openspec/changes/add-remote-approval-mode/{proposal,design,tasks}.md` + `specs/remote-approval-mode/spec.md`.
- Edit `openspec/changes/add-remote-control/specs/wire-protocol/spec.md` (+1 SSE row).
- Edit `openspec/changes/add-remote-control/specs/pairing-auth/spec.md` (+1 audit row).

**qwen-code fork (`packages/rc-gateway/src`):**

- Modify `ownerEvents.ts` — `ApprovalModePayload` + `OwnerEvent` arm.
- Modify `auditLog.ts` — `session_approval_mode_set` action (union + array).
- Modify `webpush/payload.ts` — `approval_mode_changed` → `session.approval_mode_changed` branch.
- Modify `webpush/notifier.ts` — `KIND_SCOPE` entry.
- Create `routes/approvalMode.ts` — the route.
- Modify `testing/stubDaemon.ts` — a `POST /session/:id/approval-mode` handler (test infra).
- Modify `server.ts` — mount the route.
- Modify `cli.ts` — the pump `onEvent` forward branch.

---

## Task 0: OpenSpec change (qwen-code-remote)

**Files (all in `/home/evan/projects/qwen-code-remote`):**

- Create: `openspec/changes/add-remote-approval-mode/{proposal,design,tasks}.md`, `.../specs/remote-approval-mode/spec.md`
- Modify: `openspec/changes/add-remote-control/specs/wire-protocol/spec.md`, `.../pairing-auth/spec.md`

- [ ] **Step 1: Branch + orient**

```bash
cd /home/evan/projects/qwen-code-remote && git checkout main && git pull --ff-only && git checkout -b add-remote-approval-mode
sed -n '95,125p' openspec/changes/add-remote-control/specs/wire-protocol/spec.md   # SSE table
sed -n '188,205p' openspec/changes/add-remote-control/specs/pairing-auth/spec.md   # audit table
cat openspec/config.yaml
ls openspec/changes/add-remote-review   # the 4-file template to mirror
```

Record the exact SSE-registry column format (`| Event type | Owning change | data payload |`) and the audit-registry format (`| Extension field | Introduced by | Meaning |`, action rows use the `<name> (action)` form).

- [ ] **Step 2: Write `proposal.md`** (`# add-remote-approval-mode` → `## Why` → `## What Changes`). Why: the gateway has no way to view or set a session's approval mode remotely; the daemon route + SDK setter + `approval_mode_changed` SSE already exist but are unexposed. What: `POST /session/:id/approval-mode` (tiered WRITE/OWNER), a forward of the daemon `approval_mode_changed` to the owner stream + a `session.approval_mode_changed` notification, and a `session_approval_mode_set` audit action. No daemon change.

- [ ] **Step 3: Write `design.md`** — copy `/home/evan/projects/qwen-code/docs/superpowers/specs/2026-07-23-remote-approval-mode-design.md`, changing only the top heading to `# Design — add-remote-approval-mode`. It already carries the Alternatives + Threat-model sections config.yaml requires.

- [ ] **Step 4: Write `specs/remote-approval-mode/spec.md`** — `# remote-approval-mode — spec delta` → `## ADDED Requirements`, each requirement RFC-2119 with ≥1 `#### Scenario:` (GIVEN/WHEN/THEN); the route requirement cites `POST /session/:id/approval-mode`, the event requirement cites the `approval_mode_changed` SSE. Cover:
  1. **Requirement: Set approval mode** — `POST /session/:id/approval-mode` `{ mode, persist? }` SHALL require `write`, and SHALL require `owner` when `mode ∈ {auto-edit,auto,yolo}` or `persist` is true; returns `200 { sessionId, mode, previous, persisted, planExitedOutOfBand }`. Scenarios: write sets `plan` (200); write + `auto` → 403 owner_scope_required; write + `persist:true` → 403; owner sets `yolo` (200); an unknown mode → 400 invalid_approval_mode.
  2. **Requirement: Trust-gate passthrough** — a daemon 403 trust-gate rejection (auto-\* mode in an untrusted folder) SHALL be surfaced unchanged. Scenario: daemon 403 → gateway 403 `trust_gate`.
  3. **Requirement: Out-of-band plan-exit signal** — the response SHALL set `planExitedOutOfBand` true iff the daemon reports `previous:'plan'` and the new mode is not `plan`. Scenario: previous plan + new default → flag true; previous default → flag false.
  4. **Requirement: Approval-mode change forwarding** — the owner event stream SHALL emit an `approval_mode_changed` frame `{ sessionId, previous, next, persisted }` for a daemon approval-mode change (regardless of origin), and it SHALL be a routable notification kind that respects quiet hours. Scenario: a daemon `approval_mode_changed` yields one owner frame + one notification, not snooze-bypassing.
  5. **Requirement: Approval-mode audit** — a `session_approval_mode_set` audit row SHALL record the actor token id, mode, previous, persisted, and `planExitedOutOfBand`, never content. Scenario: a set writes one such row.

- [ ] **Step 5: Register the rows (DIRECT edits).** Append to the wire-protocol SSE table:

```
| `approval_mode_changed` | `add-remote-approval-mode` | `{ sessionId, previous, next, persisted }` — the session's approval mode changed (any origin); forwarded from the daemon SSE onto the owner events stream |
```

Append to the pairing-auth audit table:

```
| `session_approval_mode_set` (action) | `add-remote-approval-mode` | Audit `action`: remote client set a session's approval mode via `POST /session/:id/approval-mode`; row carries the actor token id, the mode, the previous mode, the persisted flag, and `planExitedOutOfBand` — never args or prompt content |
```

If a notification-kinds registry table exists (grep for `permission.required` / `review.completed` in the specs), add a `session.approval_mode_changed` row there too; otherwise it is registered only in code (Task 1) and named in this change's spec.md.

- [ ] **Step 6: Write `tasks.md`** mirroring `add-remote-review/tasks.md` (phase headers; `- [ ] **N.M Title**` with `- **Status:** not-started` and a `- **Prompt:** >` blockquote). Summarize Tasks 0–5.

- [ ] **Step 7: Validate + commit**

```bash
cd /home/evan/projects/qwen-code-remote && npx openspec validate add-remote-approval-mode 2>&1 | tail -20
grep -rn "MODIFIED Requirements" openspec/changes/add-remote-approval-mode || echo "no MODIFIED blocks — good"
git add openspec/changes/add-remote-approval-mode openspec/changes/add-remote-control/specs
git commit -m "spec(add-remote-approval-mode): remote set + change-event forward"
```

---

## Task 1: Vocabulary — owner event, audit action, notification

**Files:**

- Modify: `packages/rc-gateway/src/ownerEvents.ts`
- Modify: `packages/rc-gateway/src/auditLog.ts`
- Modify: `packages/rc-gateway/src/webpush/payload.ts`
- Modify: `packages/rc-gateway/src/webpush/notifier.ts`
- Test: `packages/rc-gateway/src/webpush/payload.test.ts` (add a case)

**Interfaces:**

- Produces: `ApprovalModePayload`, the `OwnerEvent` arm `{ type:'approval_mode_changed'; mode: ApprovalModePayload }` (consumed by Task 4's forward), the `'session_approval_mode_set'` audit action (consumed by Task 3), and the `session.approval_mode_changed` notification kind.

- [ ] **Step 1: Write the failing test**

Add to `packages/rc-gateway/src/webpush/payload.test.ts`:

```ts
it('maps approval_mode_changed to session.approval_mode_changed with the next mode', () => {
  const p = buildPayload(
    {
      type: 'approval_mode_changed',
      data: {
        sessionId: 's1',
        previous: 'default',
        next: 'plan',
        persisted: false,
      },
    },
    { sessionId: 's1' },
  );
  expect(p).not.toBeNull();
  expect(p!.kind).toBe('session.approval_mode_changed');
  expect(p!.summary).toBe('Approval mode → plan');
});

it('gives approval_mode_changed a generic summary when next is absent', () => {
  const p = buildPayload(
    { type: 'approval_mode_changed', data: { sessionId: 's1' } },
    { sessionId: 's1' },
  );
  expect(p!.kind).toBe('session.approval_mode_changed');
  expect(p!.summary).toBe('Approval mode changed');
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/rc-gateway && npx vitest run src/webpush/payload.test.ts` → FAIL (returns null).

- [ ] **Step 3: Implement.**

`ownerEvents.ts` — near the review-lifecycle arm, add:

```ts
export interface ApprovalModePayload {
  sessionId: string;
  previous: string;
  next: string;
  persisted: boolean;
}
```

and in the `OwnerEvent` union, add the arm:

```ts
  | { type: 'approval_mode_changed'; mode: ApprovalModePayload }
```

`auditLog.ts` — add `| 'session_approval_mode_set'` to the `AuditAction` union (after the last member) AND `'session_approval_mode_set',` to the `AUDIT_ACTIONS` array (both are maintained separately).

`webpush/payload.ts` — in `buildPayload`, add a branch (mirror the `session_rewound` single-event branch) BEFORE the final `switch`/`return null`:

```ts
if (event.type === 'approval_mode_changed') {
  const d = event.data as { next?: unknown } | undefined;
  const next =
    typeof d?.next === 'string' && d.next.length > 0 ? d.next : undefined;
  return {
    v: 1,
    kind: 'session.approval_mode_changed',
    sessionId: ctx.sessionId,
    ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
    summary: truncate(
      next ? `Approval mode → ${next}` : 'Approval mode changed',
    ),
    url: sessionUrl(ctx.sessionId),
  };
}
```

`webpush/notifier.ts` — add to `KIND_SCOPE`:

```ts
  'session.approval_mode_changed': SESSION_READ,
```

Do NOT add it to `SNOOZE_BYPASS_KINDS`.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/webpush/payload.test.ts` → PASS. Then `npx tsc --noEmit -p tsconfig.json` (no NEW errors vs. the ~9-error baseline) to confirm the `OwnerEvent` arm and audit union are well-typed.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/ownerEvents.ts packages/rc-gateway/src/auditLog.ts packages/rc-gateway/src/webpush/payload.ts packages/rc-gateway/src/webpush/notifier.ts packages/rc-gateway/src/webpush/payload.test.ts
git commit -m "feat(rc-gateway): approval-mode owner event, audit action, notification kind"
```

---

## Task 2: `stubDaemon` approval-mode handler (test infra)

**Files:**

- Modify: `packages/rc-gateway/src/testing/stubDaemon.ts`

**Interfaces:**

- Produces: a `POST /session/:id/approval-mode` handler + `StubDaemonOptions.approvalModeResult` / `approvalModeStatus` and a `lastApprovalModeBody` getter (consumed by Task 3's route tests).

- [ ] **Step 1: Add options + handler.** Add to `StubDaemonOptions`: `approvalModeResult?: { sessionId?: string; mode: string; previous: string; persisted: boolean }` and `approvalModeStatus?: number` (default 200) and `approvalModeBody?: unknown` (the JSON body to return on a non-200, e.g. `{ code:'trust_gate', errorKind:'auth_env_error' }`). Add a route mirroring the stub's existing `POST /session/:id/rewind` handler:

```ts
app.post('/session/:id/approval-mode', express.json(), (req, res) => {
  lastApprovalModeBody = req.body;
  const status = opts.approvalModeStatus ?? 200;
  if (status !== 200) {
    res.status(status).json(opts.approvalModeBody ?? { error: 'stub' });
    return;
  }
  const r = opts.approvalModeResult ?? {
    sessionId: req.params.id,
    mode: req.body?.mode ?? 'default',
    previous: 'default',
    persisted: false,
  };
  res
    .status(200)
    .json({
      sessionId: r.sessionId ?? req.params.id,
      mode: r.mode,
      previous: r.previous,
      persisted: r.persisted,
    });
});
```

Add a module-scoped `let lastApprovalModeBody: unknown;` and expose `get lastApprovalModeBody()` on the returned `StubDaemon` object (mirror `lastRewindBody`). Follow the file's existing conventions exactly; do not restructure.

- [ ] **Step 2: Verify existing suites still pass** — `cd packages/rc-gateway && npx vitest run src/routes/rewind.integration.test.ts src/agents/agents.integration.test.ts` → PASS (no regressions).

- [ ] **Step 3: Commit**

```bash
git add packages/rc-gateway/src/testing/stubDaemon.ts
git commit -m "test(rc-gateway): stubDaemon serves POST /session/:id/approval-mode"
```

---

## Task 3: `routes/approvalMode.ts` — the route — **SECURITY-RELEVANT**

**Files:**

- Create: `packages/rc-gateway/src/routes/approvalMode.ts`
- Test: `packages/rc-gateway/src/routes/approvalMode.test.ts`

**Interfaces:**

- Consumes: `DaemonClient.setSessionApprovalMode` (SDK); `DAEMON_APPROVAL_MODES` (`@qwen-code/sdk`); `OWNER`, `hasScope` (`../scopes.js`); `AuditRecorder` (`../auditLog.js`); the audit action `'session_approval_mode_set'` (Task 1); the stub handler (Task 2).
- Produces: `ApprovalModeDaemon`, `ApprovalModeRouteDeps`, `createApprovalModeRoute(daemon, deps): RequestHandler`.

- [ ] **Step 1: Write the failing test** (drive the real `createGatewayApp`; mirror `rewind.integration.test.ts` boilerplate — `startStubDaemon` + `TokenStore` + `PairingService`, listen on an ephemeral port, `fetch` with a bearer token):

```ts
// helpers: startStubDaemon(...), store.issue([...scopes], label) -> { token }, fetch POST with Authorization
it('write token sets plan → 200', async () => {
  // stub approvalModeResult: { mode:'plan', previous:'default', persisted:false }
  // POST /session/s1/approval-mode { mode:'plan' } with a write token
  // expect 200 { sessionId:'s1', mode:'plan', previous:'default', persisted:false, planExitedOutOfBand:false }
});
it('write token + auto → 403 owner_scope_required (no daemon call)', async () => {
  // POST { mode:'auto' } with write token → 403 code:'owner_scope_required'; stub.lastApprovalModeBody undefined
});
it('write token + persist:true → 403 owner_scope_required', async () => {
  /* { mode:'plan', persist:true } write → 403 */
});
it('owner token + yolo → 200', async () => {
  /* owner token, stub result mode yolo → 200 */
});
it('unknown mode → 400 invalid_approval_mode with allowed list', async () => {
  /* { mode:'nope' } → 400, body.allowed includes 'plan' */
});
it('non-boolean persist → 400 invalid_persist_flag', async () => {
  /* { mode:'plan', persist:'yes' } → 400 */
});
it('daemon 403 trust-gate passes through unchanged', async () => {
  // stub approvalModeStatus:403, approvalModeBody:{ code:'trust_gate', errorKind:'auth_env_error' }
  // owner token + { mode:'auto' } → 403 code:'trust_gate', errorKind:'auth_env_error'
});
it('daemon 404 → 502 approval_mode_unsupported', async () => {
  /* stub status 404 → 502 approval_mode_unsupported */
});
it('planExitedOutOfBand true when previous was plan', async () => {
  // stub result previous:'plan', mode:'default' → 200 planExitedOutOfBand:true
});
it('writes a session_approval_mode_set audit row (no content)', async () => {
  // after a successful owner set, read the audit log file → one row action:'session_approval_mode_set'
  // detail has mode/previous/persisted/planExitedOutOfBand, and JSON has no command/path text
});
```

Write these as concrete `fetch` assertions against the mounted app (mirror the rewind integration test's setup verbatim; use `store.issue(['write'], 'w')` and `store.issue(['owner'], 'o')`).

- [ ] **Step 2: Run to verify it fails** — route not mounted / module missing.

- [ ] **Step 3: Implement `routes/approvalMode.ts`:**

```ts
import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import { OWNER, hasScope } from '../scopes.js';

export type ApprovalModeDaemon = Pick<DaemonClient, 'setSessionApprovalMode'>;

export interface ApprovalModeRouteDeps {
  audit?: AuditRecorder;
}

const POWER_MODES = new Set(['auto-edit', 'auto', 'yolo']);

export function createApprovalModeRoute(
  daemon: ApprovalModeDaemon,
  deps: ApprovalModeRouteDeps = {},
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const body = (req.body ?? {}) as { mode?: unknown; persist?: unknown };

    // Validate mode.
    if (
      typeof body.mode !== 'string' ||
      !(DAEMON_APPROVAL_MODES as readonly string[]).includes(body.mode)
    ) {
      res.status(400).json({
        error: 'Invalid approval mode',
        code: 'invalid_approval_mode',
        allowed: DAEMON_APPROVAL_MODES,
      });
      return;
    }
    const mode = body.mode;

    // Validate persist.
    if (body.persist !== undefined && typeof body.persist !== 'boolean') {
      res
        .status(400)
        .json({ error: 'Invalid persist flag', code: 'invalid_persist_flag' });
      return;
    }
    const persist = body.persist === true;

    // Tiered scope: OWNER for power modes or a durable persist; WRITE (the
    // mount floor) is enough for plan/default. Fail closed.
    const needsOwner = POWER_MODES.has(mode) || persist;
    if (needsOwner && !hasScope(req.rcClient?.scopes ?? [], OWNER)) {
      void deps.audit?.record({
        action: 'scope_denied',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        detail: { required: 'owner', reason: 'approval_mode', mode, persist },
      });
      res
        .status(403)
        .json({ error: 'Owner scope required', code: 'owner_scope_required' });
      return;
    }

    // Set via the daemon.
    let result;
    try {
      result = await daemon.setSessionApprovalMode(
        sessionId,
        mode,
        persist ? { persist: true } : {},
      );
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      const eBody = (err as { body?: unknown }).body as
        | { code?: unknown; errorKind?: unknown }
        | undefined;
      if (status === 403) {
        // Daemon trust gate (auto-* mode in an untrusted folder) — surface
        // unchanged so the remote client learns the folder is untrusted.
        res.status(403).json({
          error: 'Approval mode blocked by folder trust',
          code: typeof eBody?.code === 'string' ? eBody.code : 'trust_gate',
          ...(typeof eBody?.errorKind === 'string'
            ? { errorKind: eBody.errorKind }
            : {}),
        });
        return;
      }
      if (status === 404) {
        res.status(502).json({
          error: 'Daemon does not support approval-mode control',
          code: 'approval_mode_unsupported',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    const planExitedOutOfBand =
      result.previous === 'plan' && result.mode !== 'plan';

    void deps.audit?.record({
      action: 'session_approval_mode_set',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: sessionId,
      detail: {
        mode: result.mode,
        previous: result.previous,
        persisted: result.persisted,
        planExitedOutOfBand,
      },
    });

    res.status(200).json({
      sessionId,
      mode: result.mode,
      previous: result.previous,
      persisted: result.persisted,
      planExitedOutOfBand,
    });
  };
}
```

> The route does NOT publish to the owner stream or notify — that is the pump forward (Task 4), driven by the daemon's own `approval_mode_changed` event, so there is exactly one broadcast per change.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/routes/approvalMode.test.ts` → PASS (all cases). Also `npx tsc --noEmit -p tsconfig.json` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/routes/approvalMode.ts packages/rc-gateway/src/routes/approvalMode.test.ts
git commit -m "feat(rc-gateway): POST /session/:id/approval-mode (tiered scope, trust-gate passthrough)"
```

---

## Task 4: Wiring — mount the route + forward the event

**Files:**

- Modify: `packages/rc-gateway/src/server.ts`
- Modify: `packages/rc-gateway/src/cli.ts`
- Test: `packages/rc-gateway/src/cli.approvalModeForward.test.ts` (new, a focused forward test) OR extend an existing pump/cli test — see Step 1.

**Interfaces:**

- Consumes: `createApprovalModeRoute` (Task 3); the `OwnerEvent` arm + notification kind (Task 1).

- [ ] **Step 1: Write the failing test** for the forward branch. The branch lives in `cli.ts`'s pump `onEvent` handler, which is awkward to unit-test in isolation; instead test the _shape_ by extracting the forward into a tiny exported pure helper and testing that, OR add an integration assertion. Preferred: add a small exported helper in a new file `packages/rc-gateway/src/webpush/approvalModeForward.ts`:

```ts
import type { OwnerEventBus } from '../ownerEvents.js';
export interface ApprovalNotifySink {
  notify(
    e: { type: string; data: unknown },
    ctx: { sessionId: string },
  ): Promise<void>;
}
/** Forward a daemon approval_mode_changed frame to the owner stream + notifier. */
export function forwardApprovalModeChange(
  sid: string,
  data: unknown,
  ownerEvents: OwnerEventBus,
  notifier?: ApprovalNotifySink,
): void {
  const d = (data ?? {}) as {
    previous?: unknown;
    next?: unknown;
    persisted?: unknown;
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
    ?.notify({ type: 'approval_mode_changed', data }, { sessionId: sid })
    .catch(() => {});
}
```

Test (`approvalModeForward.test.ts`): a real `OwnerEventBus` with a subscriber + a fake notifier → `forwardApprovalModeChange('s1', {previous:'default',next:'plan',persisted:false}, bus, notifier)` publishes exactly one `approval_mode_changed` owner frame with `mode.next==='plan'` and calls `notify` once with `{type:'approval_mode_changed'}`.

- [ ] **Step 2: Run to verify it fails** — module missing.

- [ ] **Step 3: Implement.**
  - Create `webpush/approvalModeForward.ts` with the helper above.
  - `server.ts`: import `createApprovalModeRoute`, and mount AFTER the `notifier` `let` is assigned (near the rewind mount, ~line 1057), reusing the same middleware chain:

```ts
app.post(
  '/session/:id/approval-mode',
  requireScope(WRITE, audit),
  recordActivity(workingDevice),
  enforceSessionLock(audit),
  createApprovalModeRoute(deps.daemon, { audit }),
);
```

(`requireScope`, `WRITE`, `enforceSessionLock`, `recordActivity` are already imported for the rewind/prompt routes.)

- `cli.ts`: add `import { forwardApprovalModeChange } from './webpush/approvalModeForward.js';`. In the pump-construction block, the `onEvent` option is currently wired only when `usageIngester || agentLifecycle || reviewLifecycle` (a conditional spread). Change it so `onEvent` is **always** provided whenever the pump is constructed — drop that outer conditional and pass `onEvent` unconditionally; each existing call inside it is already guarded by its own optional chaining (`usageIngester?.ingest`, `agentLifecycle?.handleSessionEvent(...)`, the review branch), so widening the wiring changes nothing for the existing consumers. Add the forward branch inside that handler:

```ts
if (ev.type === 'approval_mode_changed') {
  forwardApprovalModeChange(sid, ev.data, ownerEvents, notifier);
}
```

`ownerEvents` is already destructured from `createGatewayApp(...)` (`cli.ts:548`); `notifier` is in scope (may be undefined — the helper handles it via `?.`). Note the forward is bounded by the pump running at all (the pump starts only when `notifier || usageIngester || agentLifecycle || reviewLifecycle`) — this matches the design's documented "pump must be subscribed" residual; do not try to make the pump run in configurations where it otherwise wouldn't.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/webpush/approvalModeForward.test.ts` → PASS. Then the route tests + a typecheck: `npx vitest run src/routes/approvalMode.test.ts && npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/cli.ts packages/rc-gateway/src/webpush/approvalModeForward.ts packages/rc-gateway/src/webpush/approvalModeForward.test.ts
git commit -m "feat(rc-gateway): mount approval-mode route; forward approval_mode_changed to owner stream"
```

---

## Task 5: Integration test + archive

**Files:**

- Create: `packages/rc-gateway/src/routes/approvalMode.integration.test.ts`

- [ ] **Step 1: Write the test** (real `createGatewayApp` + `startStubDaemon` + owner token). Cover the happy path end to end: `POST /session/s1/approval-mode { mode:'plan' }` with an owner token (stub `approvalModeResult` `{mode:'plan',previous:'default',persisted:false}`) → `200` with the full result body; subscribe to `gw.ownerEvents` before the call and assert the request itself produced no owner frame (the route doesn't publish); then feed the stub an `approval_mode_changed` frame on the session events stream and assert exactly one forwarded `approval_mode_changed` owner frame appears (proving the forward path, independent of the route). Keep timing deterministic (poll-wait for the forwarded frame; no fixed sleep).

- [ ] **Step 2: Run** — `cd packages/rc-gateway && npx vitest run src/routes/approvalMode.integration.test.ts` → PASS. Then the full suite sanity: `npx vitest run` → all green.

- [ ] **Step 3: Commit**

```bash
git add packages/rc-gateway/src/routes/approvalMode.integration.test.ts
git commit -m "test(rc-gateway): remote approval-mode end-to-end (set + forward)"
```

- [ ] **Step 4 (deferred): Archive.** After merge + deploy, run `npx openspec archive add-remote-approval-mode` in `qwen-code-remote`. Status: `deferred:until-deployed`.

---

## Self-review checklist (run before the final review)

- Spec coverage: OpenSpec change (T0) · owner arm + audit action + payload + notifier (T1) · stub (T2) · route with tiered scope + trust-gate passthrough + planExitedOutOfBand + audit (T3) · mount + forward (T4) · integration (T5). ✅
- No placeholders; every code step shows real code.
- Type consistency: `ApprovalModePayload` (T1) is what the forward publishes (T4); `'session_approval_mode_set'` (T1) is what the route records (T3); `'session.approval_mode_changed'` kind is consistent across payload.ts + notifier.ts + the forward's notify.
- No daemon (`packages/cli/src/serve`, `packages/core`) edits.
- Route never publishes/notifies (single broadcast via the pump forward); audit carries only ids/enum/booleans.
