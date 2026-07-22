# Remote Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin rc-gateway surface (`POST /rc/reviews` + list/detail/cancel) that triggers and observes the fork's existing bundled `/review` skill as a tagged daemon session, with a scope-tiered approval bridge.

**Architecture:** A review is a daemon session running `/review <target>` verbatim, tagged in a gateway-local `ReviewRegistry`, mirroring the `add-agent-observability` plane (persisted JSON store + lifecycle three-surface emit + reconciliation) but without a redundant `AgentRecord`. A dedicated per-review `subscribeEvents(sessionId,{lastEventId:0})` permission bridge classifies each `permission_request` (escalate-by-default, keyed on ACP `kind` + `rawInput`) and either votes (`respondToSessionPermission` with the `allow_once` option) or escalates to the owner. The daemon stays fully unmodified.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, Express, Vitest, `@qwen-code/sdk` `DaemonClient`. Two repos: specs in `qwen-code-remote` (OpenSpec), implementation in the `qwen-code` fork (`packages/rc-gateway`), current branch `add-remote-control-spec`.

## Global Constraints

- **Design source of truth:** `docs/superpowers/specs/2026-07-20-remote-review-design.md` (in the fork). Every task implements part of it.
- **Security-critical tasks are Opus-only** (author AND review): Phase C (classifier + permission bridge) and the trigger saga's scope-gate/approval wiring (Task D.2). Do not author or review these with a non-Opus model.
- **ESM imports** use `.js` specifiers (`import { X } from './x.js'`) even for `.ts` files. Match the existing `packages/rc-gateway/src` style.
- **Persisted stores** use mode `0o600`, `JSON.stringify(body, null, 2)`, `mkdir(dirname,{recursive:true})` before write; path under `join(homedir(),'.qwen','rc',...)`.
- **Audit rows carry ids/metadata only** — never diff content, report bodies, or prompt text.
- **Registry edits in qwen-code-remote are DIRECT edits** to the authoritative tables in `add-remote-control/specs/{wire-protocol,pairing-auth}/spec.md`. Do NOT create `## MODIFIED Requirements` partial-content delta files inside `add-remote-review` — that causes archive-time data loss and violates repo precedent.
- **The daemon is not modified.** No edits to `packages/cli/src/serve/*` or `packages/core/*`. The gateway reaches the daemon only through existing `DaemonClient` methods.
- **Commit after every task** (each task's final step). Pre-commit hooks run prettier/eslint on staged files; let them reformat.
- **Scope constants** (`packages/rc-gateway/src/scopes.ts`): `SESSION_READ='session:read'`, `WRITE='write'`, `OWNER='owner'`. There is no `READ`; the read scope is `SESSION_READ`. `hasScope(granted, required)` is transitive (`owner ⊃ write ⊃ session:read`).

---

## File Structure

**qwen-code-remote (specs):**

- Create `openspec/changes/add-remote-review/{proposal,design,tasks}.md` and `.../specs/remote-review/spec.md`.
- Edit `openspec/changes/add-remote-control/specs/wire-protocol/spec.md` (+4 SSE rows).
- Edit `openspec/changes/add-remote-control/specs/pairing-auth/spec.md` (+2 audit rows).

**qwen-code fork (`packages/rc-gateway/src`):**

- Create `reviews/reviewRegistry.ts` — the persisted `ReviewRecord` store.
- Create `reviews/reviewClassifier.ts` — pure `classifyReviewToolCall` (security-critical).
- Create `reviews/reviewPermissionBridge.ts` — dedicated subscription + vote/escalate (security-critical).
- Create `reviews/reviewLifecycle.ts` — status transitions + owner-stream emit.
- Create `routes/review.ts` — trigger saga + list/detail/cancel handlers.
- Modify `ownerEvents.ts` — add review event type + payload + `OwnerEvent` variant.
- Modify `auditLog.ts` — add `review_started`, `review_cancelled`.
- Modify `webpush/payload.ts` — add `review.completed`/`review.failed` branch.
- Modify `webpush/notifier.ts` — add `review.*` to `KIND_SCOPE`.
- Modify `server.ts` — `GatewayDeps.review` + route mount.
- Modify `cli.ts` — open the registry, reconcile at boot, construct lifecycle + bridge.
- Modify `testing/stubDaemon.ts` — add `sessionSupportedCommands`, permission-frame scripting, `subscribeEvents` replay.

---

## Phase A — Spec (qwen-code-remote)

### Task A.0: Alignment

- [ ] **Step 1: Verify prerequisites and spec state**

Run (in `/home/evan/projects/qwen-code-remote`):

```bash
ls openspec/changes/add-agent-observability >/dev/null && echo "agent-obs present"
grep -n "agent_spawned" openspec/changes/add-remote-control/specs/wire-protocol/spec.md
grep -n "workflow_started" openspec/changes/add-remote-control/specs/pairing-auth/spec.md
cat openspec/config.yaml
```

Expected: the SSE registry (`### Requirement: SSE event-type registry`, `| Event type | Owning change | data payload |`) and the audit registry (`### Requirement: Audit record schema (v1)`, `| Extension field | Introduced by | Meaning |`) both exist with the shown rows. Confirm no `add-remote-review` dir exists yet. Record confirmation; no code changes in this step.

### Task A.1: Create the `add-remote-review` OpenSpec change + register rows

**Files:**

- Create: `openspec/changes/add-remote-review/proposal.md`
- Create: `openspec/changes/add-remote-review/design.md`
- Create: `openspec/changes/add-remote-review/tasks.md`
- Create: `openspec/changes/add-remote-review/specs/remote-review/spec.md`
- Modify: `openspec/changes/add-remote-control/specs/wire-protocol/spec.md` (append 4 rows)
- Modify: `openspec/changes/add-remote-control/specs/pairing-auth/spec.md` (append 2 rows)

- [ ] **Step 1: Write `proposal.md`**

Mirror `add-remote-rewind/proposal.md` structure (`# add-remote-review` → `## Why` → `## What Changes`). Content:

```markdown
# add-remote-review

## Why

qwen-code already ships a capable upstream `/review` skill (9 parallel
dimension agents → batch verify → iterative reverse audit → inline PR
comments, with worktree-isolated PR fetch and a deterministic
linter/build/test pre-pass). But it is a local-CLI-only, LLM-driven
skill: there is no way to trigger or observe a review through
rc-gateway. A remote client cannot start a review, watch it, or cancel
it from off the workstation.

## What Changes

- **`POST /rc/reviews` (gateway).** Triggers the existing `/review`
  skill as a tagged daemon session. `write` scope; `owner` if
  `comment`, `autofix`, or `autoApprove` is set. Returns
  `{ reviewId, sessionId }`.
- **`GET /rc/reviews`, `GET /rc/reviews/:id`, `POST /rc/reviews/:id/cancel`.**
  List/detail (`read`), cancel (`write`).
- **Scope-tiered approval bridge.** A dedicated per-review permission
  subscription: `write` triggers escalate every privileged call to the
  owner (vote mode); `owner` + `autoApprove` runs a strict
  escalate-by-default classifier (read/search/allowlisted-shell
  auto-approve; edit gated on `autofix`; the agent fanout, `web_fetch`,
  and everything else escalate).
- **New SSE events** `review_started|completed|failed|cancelled` and
  **audit actions** `review_started|review_cancelled`, registered in the
  authoritative wire-protocol and pairing-auth registries.
- **No daemon change.** The daemon is reached only through existing
  `DaemonClient` methods (`createOrAttachSession`,
  `sessionSupportedCommands`, `prompt`, `subscribeEvents`,
  `respondToSessionPermission`, `endSession`).
```

- [ ] **Step 2: Write `design.md`**

Copy the fork's design doc (`docs/superpowers/specs/2026-07-20-remote-review-design.md`) content, adapting the heading to `# Design — remote-review` and keeping the Alternatives + Threat-model sections (config.yaml requires: architecture records the alternative considered; threat model enumerates attacker/capability/mitigation). It already satisfies both.

- [ ] **Step 3: Write `specs/remote-review/spec.md`**

Pattern: `# remote-review — spec delta` → `## ADDED Requirements` → `### Requirement:` (RFC-2119) each with ≥1 `#### Scenario:` (GIVEN/WHEN/THEN bullets). Wire requirements MUST cite method+path or SSE event. Include these requirements (write full scenarios for each):

1. **Requirement: Trigger a remote review** — `POST /rc/reviews` with `{ target, comment?, autofix?, autoApprove? }` SHALL require `write`, and SHALL require `owner` when any of `comment`/`autofix`/`autoApprove` is set; on success returns `202 { reviewId, sessionId }`. Scenarios: write triggers a local review (202); read is rejected (403 scope_required); write + `autofix:true` is rejected (403 owner_scope_required); owner + `autoApprove:true` succeeds.
2. **Requirement: Skill-availability pre-flight** — the trigger SHALL confirm `review` is in the session's supported commands before sending the prompt, and SHALL return `502 review_skill_unavailable` otherwise, registering nothing. Scenario: a session lacking the `review` skill → 502, no record, session ended.
3. **Requirement: Scope-tiered approval** — a `write` review SHALL escalate every privileged tool call to the owner; an `owner` `autoApprove` review SHALL auto-approve only read/search tool kinds and `run_shell_command` whose command matches a metacharacter-free build/test/read allowlist, SHALL gate `edit`-kind on `autofix` and the PR-comment post on `comment`, and SHALL escalate `web_fetch`, the agent fanout, and all other kinds. Scenarios: read-kind auto-approved; `edit` escalated when `autofix` false; out-of-allowlist shell escalated; `web_fetch` escalated.
4. **Requirement: `review_*` SSE events** — the owner event stream SHALL emit `review_started` on accept, `review_completed`/`review_failed` on terminal outcome, `review_cancelled` on cancel, each carrying `{ reviewId, sessionId, target, status }`. Scenario: trigger → exactly one `review_started`; completion → one `review_completed` carrying `reportPath` when derivable.
5. **Requirement: List, detail, cancel** — `GET /rc/reviews` (`read`) lists records; `GET /rc/reviews/:id` (`read`) returns detail incl. cost rollup; `POST /rc/reviews/:id/cancel` (`write`) ends the session and marks `cancelled`, `409 review_not_running` if terminal. Scenarios for each.
6. **Requirement: Reconciliation** — on gateway start, `running`/`blocked` reviews whose session is no longer live SHALL become `orphaned`, never dropped. Scenario: restart with a vanished session → `orphaned`.
7. **Requirement: Rewind-audit action** _(rename: Review audit actions)_ — `review_started` and `review_cancelled` audit rows SHALL record target + flags + tokenId, never diff/report content. Scenario: a trigger writes one `review_started` row with the target and flags.

- [ ] **Step 4: Register the 4 SSE rows (DIRECT edit)**

Append to the table under `### Requirement: SSE event-type registry` in `add-remote-control/specs/wire-protocol/spec.md` (3-column `| Event type | Owning change | data payload |`):

```
| `review_started` | `add-remote-review` | `{ reviewId, sessionId, target, status }` — a remote review was accepted via `POST /rc/reviews`; emitted on the owner events stream |
| `review_completed` | `add-remote-review` | `{ reviewId, sessionId, target, status, reportPath?, summary? }` — the review session's prompt settled successfully; `reportPath` is the saved `.qwen/reviews/` report when derivable, `summary` the PR `findingsCount`/`verdict` when the target is a PR |
| `review_failed` | `add-remote-review` | `{ reviewId, sessionId, target, status }` — the review session died or its prompt failed |
| `review_cancelled` | `add-remote-review` | `{ reviewId, sessionId, target, status }` — a client cancelled the review via `POST /rc/reviews/:id/cancel` |
```

- [ ] **Step 5: Register the 2 audit rows (DIRECT edit)**

Append to the table under `### Requirement: Audit record schema (v1)` in `add-remote-control/specs/pairing-auth/spec.md` (`| Extension field | Introduced by | Meaning |`, action rows use the `<name> (action)` form):

```
| `review_started` (action) | `add-remote-review` | Audit `action`: remote client triggered a review via `POST /rc/reviews`; row carries the actor token id, the target (pr/path/local), the comment/autofix/autoApprove flags, and the approval leg — never diff or report content |
| `review_cancelled` (action) | `add-remote-review` | Audit `action`: remote client cancelled a review via `POST /rc/reviews/:id/cancel`; row carries the review id and session id |
```

- [ ] **Step 6: Write `tasks.md`** mirroring `add-remote-rewind/tasks.md` (phase headers; each task `- [ ] **N.M Title**` with `- **Status:** not-started` and `- **Prompt:** > …`). Summarize Phases A–E of this plan.

- [ ] **Step 7: Validate and commit**

Run:

```bash
cd /home/evan/projects/qwen-code-remote && npx openspec validate add-remote-review 2>&1 | tail -20
```

Expected: validation passes (or only warnings). Then:

```bash
git add openspec/changes/add-remote-review openspec/changes/add-remote-control/specs
git commit -m "spec(add-remote-review): OpenSpec change + register review SSE/audit rows"
```

---

## Phase B — Registry, lifecycle vocabulary, lifecycle (fork)

### Task B.0: Alignment

- [ ] **Step 1: Verify the templates are unchanged**

Run (in `/home/evan/projects/qwen-code`):

```bash
sed -n '34,50p;80,110p;153,183p' packages/rc-gateway/src/agents/agentRegistry.ts
sed -n '44,130p' packages/rc-gateway/src/agents/agentLifecycle.ts
grep -n "AgentLifecycleEventType\|AgentLifecyclePayload\|OwnerEvent\b" packages/rc-gateway/src/ownerEvents.ts | head
```

Expected: `AgentRegistry` has `open/register/get/findBySessionId/list/setStatus/reconcile`; `AgentLifecycle` has `emit/handleSessionEvent/onPromptSettled`; `ownerEvents.ts` exports `AgentLifecycleEventType`, `AgentLifecyclePayload`, and an `OwnerEventBus.publish(event: OwnerEvent)`. These are the mirrors for reviews. No changes this step.

### Task B.1: Review event vocabulary in `ownerEvents.ts`

**Files:**

- Modify: `packages/rc-gateway/src/ownerEvents.ts`
- Test: `packages/rc-gateway/src/ownerEvents.test.ts` (add cases if the file exists; else create)

**Interfaces:**

- Produces: `ReviewLifecycleEventType`, `ReviewLifecyclePayload`, and an `OwnerEvent` union member `{ type: ReviewLifecycleEventType; review: ReviewLifecyclePayload }`, consumed by B.3 and used by the events route (which JSON-stringifies the whole frame — no route change needed).
- Consumes: `ReviewTarget` from B.2 is NOT yet available; declare `target` here as `unknown`-free structural type inline (see code) to avoid a cycle — B.2 will import the payload's target type is NOT needed; keep payload `target` as the same union.

- [ ] **Step 1: Write the failing test**

Add to `ownerEvents.test.ts`:

```ts
import { OwnerEventBus, type OwnerEvent } from './ownerEvents.js';

it('publishes a review lifecycle event to subscribers', () => {
  const bus = new OwnerEventBus();
  const seen: OwnerEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  bus.publish({
    type: 'review_started',
    review: {
      reviewId: 'r1',
      sessionId: 's1',
      target: { kind: 'local' },
      status: 'running',
    },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ type: 'review_started' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/ownerEvents.test.ts`
Expected: FAIL — `'review_started'` not assignable to `OwnerEvent`.

- [ ] **Step 3: Implement** — add to `ownerEvents.ts` near `AgentLifecycleEventType`:

```ts
export type ReviewLifecycleEventType =
  | 'review_started'
  | 'review_completed'
  | 'review_failed'
  | 'review_cancelled';

export interface ReviewLifecyclePayload {
  reviewId: string;
  sessionId: string;
  target:
    | { kind: 'pr'; number: number }
    | { kind: 'path'; path: string }
    | { kind: 'local' };
  status: string;
  reportPath?: string | null;
  summary?: { findingsCount?: number; verdict?: string } | null;
}
```

Then add to the `OwnerEvent` union (next to the agent variant):

```ts
  | { type: ReviewLifecycleEventType; review: ReviewLifecyclePayload }
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/ownerEvents.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/ownerEvents.ts packages/rc-gateway/src/ownerEvents.test.ts
git commit -m "feat(rc-gateway): review lifecycle event vocabulary on the owner bus"
```

### Task B.2: `reviewRegistry.ts`

**Files:**

- Create: `packages/rc-gateway/src/reviews/reviewRegistry.ts`
- Test: `packages/rc-gateway/src/reviews/reviewRegistry.test.ts`

**Interfaces:**

- Produces: `ReviewStatus`, `TERMINAL_REVIEW_STATUSES`, `ReviewTarget`, `ReviewRecord`, `ReviewRegistry` with:
  - `static open(filePath: string, nowFn?: () => number): Promise<ReviewRegistry>`
  - `register(input: { sessionId: string; target: ReviewTarget; comment: boolean; autofix: boolean; approvalLeg: 'vote'|'auto'; triggeredByTokenId: string }): Promise<ReviewRecord>`
  - `get(reviewId: string): ReviewRecord | undefined`
  - `findBySessionId(sessionId: string): ReviewRecord | undefined`
  - `list(filter?: { status?: ReviewStatus }): ReviewRecord[]`
  - `setStatus(reviewId: string, status: ReviewStatus): Promise<boolean>`
  - `setReport(reviewId: string, reportPath: string | null, summary: ReviewRecord['summary']): Promise<void>`
  - `reconcile(liveSessionIds: readonly string[]): Promise<string[]>`
- Consumed by: B.3 (lifecycle), D.2/D.3 (routes), cli.ts (E.2).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewRegistry } from './reviewRegistry.js';

describe('ReviewRegistry', () => {
  it('registers, persists 0600, and finds by session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reviews-'));
    const path = join(dir, 'reviews.json');
    let t = 1000;
    const reg = await ReviewRegistry.open(path, () => t);
    const rec = await reg.register({
      sessionId: 's1',
      target: { kind: 'pr', number: 42 },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'tok1',
    });
    expect(rec.reviewId).toBeTruthy();
    expect(rec.status).toBe('running');
    expect(reg.findBySessionId('s1')?.reviewId).toBe(rec.reviewId);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.reviews).toHaveLength(1);
  });

  it('setStatus refuses to leave a terminal status and stamps finishedAt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reviews-'));
    let t = 5;
    const reg = await ReviewRegistry.open(join(dir, 'r.json'), () => t);
    const rec = await reg.register({
      sessionId: 's',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'auto',
      triggeredByTokenId: 'x',
    });
    t = 9;
    expect(await reg.setStatus(rec.reviewId, 'completed')).toBe(true);
    expect(reg.get(rec.reviewId)?.finishedAt).toBe(new Date(9).toISOString());
    expect(await reg.setStatus(rec.reviewId, 'cancelled')).toBe(false);
  });

  it('reconcile marks non-live running reviews orphaned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reviews-'));
    const reg = await ReviewRegistry.open(join(dir, 'r.json'), () => 1);
    const a = await reg.register({
      sessionId: 'live',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'x',
    });
    const b = await reg.register({
      sessionId: 'gone',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'x',
    });
    const orphaned = await reg.reconcile(['live']);
    expect(orphaned).toEqual([b.reviewId]);
    expect(reg.get(a.reviewId)?.status).toBe('running');
    expect(reg.get(b.reviewId)?.status).toBe('orphaned');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/reviews/reviewRegistry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `reviewRegistry.ts`** (adapts `agentRegistry.ts` verbatim conventions):

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ReviewStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

export const TERMINAL_REVIEW_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);

export type ReviewTarget =
  | { kind: 'pr'; number: number }
  | { kind: 'path'; path: string }
  | { kind: 'local' };

export interface ReviewRecord {
  reviewId: string;
  sessionId: string;
  target: ReviewTarget;
  comment: boolean;
  autofix: boolean;
  approvalLeg: 'vote' | 'auto';
  status: ReviewStatus;
  reportPath: string | null;
  summary: { findingsCount?: number; verdict?: string } | null;
  triggeredByTokenId: string;
  triggeredAt: string;
  finishedAt: string | null;
}

interface PersistShape {
  reviews: ReviewRecord[];
}

export class ReviewRegistry {
  private constructor(
    private readonly filePath: string,
    private records: ReviewRecord[],
    private readonly nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<ReviewRegistry> {
    let records: ReviewRecord[] = [];
    try {
      const parsed = JSON.parse(
        await readFile(filePath, 'utf8'),
      ) as PersistShape;
      if (Array.isArray(parsed.reviews)) records = parsed.reviews;
    } catch {
      // Missing/corrupt → start empty; first register() persists it.
    }
    return new ReviewRegistry(filePath, records, nowFn);
  }

  async register(input: {
    sessionId: string;
    target: ReviewTarget;
    comment: boolean;
    autofix: boolean;
    approvalLeg: 'vote' | 'auto';
    triggeredByTokenId: string;
  }): Promise<ReviewRecord> {
    const rec: ReviewRecord = {
      reviewId: randomUUID(),
      sessionId: input.sessionId,
      target: input.target,
      comment: input.comment,
      autofix: input.autofix,
      approvalLeg: input.approvalLeg,
      status: 'running',
      reportPath: null,
      summary: null,
      triggeredByTokenId: input.triggeredByTokenId,
      triggeredAt: new Date(this.nowFn()).toISOString(),
      finishedAt: null,
    };
    this.records.push(rec);
    await this.persist();
    return { ...rec };
  }

  get(reviewId: string): ReviewRecord | undefined {
    const r = this.records.find((x) => x.reviewId === reviewId);
    return r ? { ...r } : undefined;
  }

  findBySessionId(sessionId: string): ReviewRecord | undefined {
    const matches = this.records.filter((r) => r.sessionId === sessionId);
    const live = matches.find((r) => !TERMINAL_REVIEW_STATUSES.has(r.status));
    const r = live ?? matches[matches.length - 1];
    return r ? { ...r } : undefined;
  }

  list(filter: { status?: ReviewStatus } = {}): ReviewRecord[] {
    return this.records
      .filter((r) => filter.status === undefined || r.status === filter.status)
      .map((r) => ({ ...r }));
  }

  async setStatus(reviewId: string, status: ReviewStatus): Promise<boolean> {
    const r = this.records.find((x) => x.reviewId === reviewId);
    if (!r || TERMINAL_REVIEW_STATUSES.has(r.status)) return false;
    r.status = status;
    if (TERMINAL_REVIEW_STATUSES.has(status)) {
      r.finishedAt = new Date(this.nowFn()).toISOString();
    }
    await this.persist();
    return true;
  }

  async setReport(
    reviewId: string,
    reportPath: string | null,
    summary: ReviewRecord['summary'],
  ): Promise<void> {
    const r = this.records.find((x) => x.reviewId === reviewId);
    if (!r) return;
    r.reportPath = reportPath;
    r.summary = summary;
    await this.persist();
  }

  async reconcile(liveSessionIds: readonly string[]): Promise<string[]> {
    const live = new Set(liveSessionIds);
    const orphaned: string[] = [];
    const finishedAt = new Date(this.nowFn()).toISOString();
    for (const r of this.records) {
      if (TERMINAL_REVIEW_STATUSES.has(r.status)) continue;
      if (live.has(r.sessionId)) continue;
      r.status = 'orphaned';
      r.finishedAt = finishedAt;
      orphaned.push(r.reviewId);
    }
    if (orphaned.length > 0) await this.persist();
    return orphaned;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = { reviews: this.records };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/reviews/reviewRegistry.test.ts` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/reviews/reviewRegistry.ts packages/rc-gateway/src/reviews/reviewRegistry.test.ts
git commit -m "feat(rc-gateway): ReviewRegistry persisted store (mirrors AgentRegistry)"
```

### Task B.3: `reviewLifecycle.ts`

**Files:**

- Create: `packages/rc-gateway/src/reviews/reviewLifecycle.ts`
- Test: `packages/rc-gateway/src/reviews/reviewLifecycle.test.ts`

**Interfaces:**

- Consumes: `ReviewRegistry`, `ReviewRecord` (B.2); `OwnerEventBus`, `ReviewLifecycleEventType`, `ReviewLifecyclePayload` (B.1).
- Produces: `ReviewLifecycle` with:
  - `constructor(registry: ReviewRegistry, ownerEvents: OwnerEventBus, costFor?: (sessionId: string) => number | undefined, resolveReport?: (rec: ReviewRecord) => Promise<{ reportPath: string | null; summary: ReviewRecord['summary'] }>)`
  - `emit(type: ReviewLifecycleEventType, record: ReviewRecord): void`
  - `async onPromptSettled(reviewId: string, outcome: 'completed' | 'failed'): Promise<void>`
  - `async handleSessionEvent(sessionId: string, ev: { type: string; data: unknown }): Promise<void>` (session_died → failed)
  - `async setBlocked(sessionId: string): Promise<void>` / `async setRunning(sessionId: string): Promise<void>` (bridge callbacks; no frame)
  - `async onCancelled(reviewId: string): Promise<void>` (used by cancel route to emit `review_cancelled` after `setStatus('cancelled')`)
- Consumed by: routes (D), bridge wiring (C.2 callbacks), cli.ts (E.2).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewRegistry } from './reviewRegistry.js';
import { ReviewLifecycle } from './reviewLifecycle.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'rl-'));
  const reg = await ReviewRegistry.open(join(dir, 'r.json'), () => 1);
  const bus = new OwnerEventBus();
  const seen: OwnerEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  return { reg, bus, seen };
}

describe('ReviewLifecycle', () => {
  it('emits review_completed with resolved report + cost', async () => {
    const { reg, bus, seen } = await fixture();
    const rec = await reg.register({
      sessionId: 's',
      target: { kind: 'pr', number: 7 },
      comment: false,
      autofix: false,
      approvalLeg: 'auto',
      triggeredByTokenId: 'x',
    });
    const lc = new ReviewLifecycle(
      reg,
      bus,
      () => 4242,
      async () => ({
        reportPath: '/p/.qwen/reviews/x-pr-7.md',
        summary: { findingsCount: 3, verdict: 'ok' },
      }),
    );
    await lc.onPromptSettled(rec.reviewId, 'completed');
    const frame = seen.find((e) => e.type === 'review_completed') as any;
    expect(frame.review.reportPath).toBe('/p/.qwen/reviews/x-pr-7.md');
    expect(frame.review.summary.findingsCount).toBe(3);
    expect(reg.get(rec.reviewId)?.status).toBe('completed');
  });

  it('session_died → failed + review_failed', async () => {
    const { reg, bus, seen } = await fixture();
    const rec = await reg.register({
      sessionId: 's2',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'x',
    });
    const lc = new ReviewLifecycle(reg, bus);
    await lc.handleSessionEvent('s2', { type: 'session_died', data: {} });
    expect(seen.some((e) => e.type === 'review_failed')).toBe(true);
    expect(reg.get(rec.reviewId)?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `reviewLifecycle.ts`** (adapts `agentLifecycle.ts`, owner-stream only):

```ts
import type {
  OwnerEventBus,
  ReviewLifecycleEventType,
  ReviewLifecyclePayload,
} from '../ownerEvents.js';
import type { ReviewRegistry, ReviewRecord } from './reviewRegistry.js';

export class ReviewLifecycle {
  constructor(
    private readonly registry: ReviewRegistry,
    private readonly ownerEvents: OwnerEventBus,
    private readonly costFor?: (sessionId: string) => number | undefined,
    private readonly resolveReport?: (
      rec: ReviewRecord,
    ) => Promise<{
      reportPath: string | null;
      summary: ReviewRecord['summary'];
    }>,
  ) {}

  private payloadFor(rec: ReviewRecord): ReviewLifecyclePayload {
    return {
      reviewId: rec.reviewId,
      sessionId: rec.sessionId,
      target: rec.target,
      status: rec.status,
      reportPath: rec.reportPath,
      summary: rec.summary,
    };
  }

  emit(type: ReviewLifecycleEventType, record: ReviewRecord): void {
    this.ownerEvents.publish({ type, review: this.payloadFor(record) });
  }

  async onPromptSettled(
    reviewId: string,
    outcome: 'completed' | 'failed',
  ): Promise<void> {
    if (outcome === 'completed' && this.resolveReport) {
      const rec = this.registry.get(reviewId);
      if (rec) {
        try {
          const { reportPath, summary } = await this.resolveReport(rec);
          await this.registry.setReport(reviewId, reportPath, summary);
        } catch {
          // Best-effort; a missing report leaves the fields null.
        }
      }
    }
    if (await this.registry.setStatus(reviewId, outcome)) {
      this.emit(
        outcome === 'completed' ? 'review_completed' : 'review_failed',
        this.registry.get(reviewId)!,
      );
    }
  }

  async handleSessionEvent(
    sessionId: string,
    ev: { type: string; data: unknown },
  ): Promise<void> {
    const rec = this.registry.findBySessionId(sessionId);
    if (!rec) return;
    if (ev.type === 'session_died') {
      if (await this.registry.setStatus(rec.reviewId, 'failed')) {
        this.emit('review_failed', this.registry.get(rec.reviewId)!);
      }
    }
  }

  async setBlocked(sessionId: string): Promise<void> {
    const rec = this.registry.findBySessionId(sessionId);
    if (rec && rec.status === 'running')
      await this.registry.setStatus(rec.reviewId, 'blocked');
  }

  async setRunning(sessionId: string): Promise<void> {
    const rec = this.registry.findBySessionId(sessionId);
    if (rec && rec.status === 'blocked') {
      // No terminal guard issue: 'blocked' is non-terminal.
      const r = this.registry.get(rec.reviewId);
      if (r) await this.registry.setStatus(rec.reviewId, 'running');
    }
  }

  async onCancelled(reviewId: string): Promise<void> {
    this.emit('review_cancelled', this.registry.get(reviewId)!);
  }
}
```

> Note: `setStatus` refuses to leave a terminal status, but `blocked`/`running` are non-terminal so `blocked → running` is allowed. `costFor` is retained for read-time cost in the routes (D.3), not embedded in the frame payload.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/reviews/reviewLifecycle.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/reviews/reviewLifecycle.ts packages/rc-gateway/src/reviews/reviewLifecycle.test.ts
git commit -m "feat(rc-gateway): ReviewLifecycle owner-stream transitions"
```

---

## Phase C — Classifier + permission bridge (fork) — **SECURITY-CRITICAL, OPUS-ONLY**

### Task C.0: Alignment

- [ ] **Step 1: Confirm the real permission-frame shape and vote API**

Run (in `/home/evan/projects/qwen-code`):

```bash
grep -n "toolCall\|rawInput\|requestId\|options" packages/sdk-typescript/src/daemon/events.ts | head
grep -n "respondToSessionPermission\|subscribeEvents\|selectAllowOnceOptionId" packages/rc-gateway/src -r | head
sed -n '9,35p' packages/rc-gateway/src/permissionOptions.ts
```

Expected: `DaemonPermissionRequestData { requestId, sessionId, toolCall, options }` with `toolCall` typed `unknown` (real runtime shape `{ toolCallId, title, kind, rawInput, ... }`); `selectAllowOnceOptionId(options)` returns the `allow_once` optionId or `undefined`; `respondToSessionPermission(sessionId, requestId, response)` and `subscribeEvents(sessionId, opts)` exist on `DaemonClient`. Record the exact `subscribeEvents` option name for `lastEventId`. No changes this step. **This and C.1/C.2 are Opus-only.**

### Task C.1: `reviewClassifier.ts` (pure, security-critical)

**Files:**

- Create: `packages/rc-gateway/src/reviews/reviewClassifier.ts`
- Test: `packages/rc-gateway/src/reviews/reviewClassifier.test.ts`

**Interfaces:**

- Produces: `ReviewToolCall`, `ReviewPolicy`, `ReviewDecision`, `classifyReviewToolCall(toolCall, policy): ReviewDecision`.
- Consumed by: C.2 (bridge).

- [ ] **Step 1: Write the failing test** (uses the REAL `{ title, kind, rawInput }` frame shape — never `{ name, input }`):

```ts
import { describe, it, expect } from 'vitest';
import {
  classifyReviewToolCall,
  type ReviewPolicy,
} from './reviewClassifier.js';

const AUTO: ReviewPolicy = {
  autoApprove: true,
  autofix: false,
  comment: false,
};
const shell = (command: string) => ({
  kind: 'execute',
  title: command,
  rawInput: { command },
});

describe('classifyReviewToolCall', () => {
  it('vote mode escalates everything', () => {
    const VOTE: ReviewPolicy = {
      autoApprove: false,
      autofix: true,
      comment: true,
    };
    expect(classifyReviewToolCall({ kind: 'read', rawInput: {} }, VOTE)).toBe(
      'escalate',
    );
    expect(classifyReviewToolCall(shell('git diff'), VOTE)).toBe('escalate');
  });

  it('auto-approves read and search kinds', () => {
    expect(classifyReviewToolCall({ kind: 'read', rawInput: {} }, AUTO)).toBe(
      'approve',
    );
    expect(classifyReviewToolCall({ kind: 'search', rawInput: {} }, AUTO)).toBe(
      'approve',
    );
  });

  it('gates edit on autofix', () => {
    expect(classifyReviewToolCall({ kind: 'edit', rawInput: {} }, AUTO)).toBe(
      'escalate',
    );
    expect(
      classifyReviewToolCall(
        { kind: 'edit', rawInput: {} },
        { ...AUTO, autofix: true },
      ),
    ).toBe('approve');
  });

  it('escalates fetch and other and unknown', () => {
    expect(
      classifyReviewToolCall(
        { kind: 'fetch', rawInput: { url: 'http://x/?d=secret' } },
        AUTO,
      ),
    ).toBe('escalate');
    expect(
      classifyReviewToolCall(
        { kind: 'other', title: 'agent: review', rawInput: {} },
        AUTO,
      ),
    ).toBe('escalate');
    expect(classifyReviewToolCall({ kind: 'weird', rawInput: {} }, AUTO)).toBe(
      'escalate',
    );
    expect(classifyReviewToolCall({ rawInput: {} }, AUTO)).toBe('escalate'); // missing kind
  });

  it('auto-approves allowlisted read/build/test shell', () => {
    for (const c of [
      'git diff --stat',
      'git status',
      'npm run build',
      'npm test',
      'cargo test',
      'go build ./...',
      'tsc --noEmit',
      'qwen review fetch-pr 42 owner/repo --remote origin',
      'mkdir -p /proj/.qwen/reviews',
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO), c).toBe('approve');
    }
  });

  it('escalates dangerous, out-of-allowlist, and metacharacter shell', () => {
    for (const c of [
      'git commit -m x',
      'git push',
      'rm -rf /',
      'curl http://x',
      'npm install evil',
      'git diff; rm -rf /',
      'git diff && curl x',
      'echo $(cat secret)',
      'git diff | sh',
      'git diff > /etc/x',
    ]) {
      expect(classifyReviewToolCall(shell(c), AUTO), c).toBe('escalate');
    }
  });

  it('gates the gh comment-post shell on comment', () => {
    expect(
      classifyReviewToolCall(shell('gh api repos/o/r/pulls/1/reviews'), AUTO),
    ).toBe('escalate');
    expect(
      classifyReviewToolCall(shell('gh api repos/o/r/pulls/1/reviews'), {
        ...AUTO,
        comment: true,
      }),
    ).toBe('approve');
  });

  it('escalates a non-string command', () => {
    expect(
      classifyReviewToolCall(
        { kind: 'execute', rawInput: { command: 42 } },
        AUTO,
      ),
    ).toBe('escalate');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `reviewClassifier.ts`**:

```ts
export interface ReviewToolCall {
  kind?: string;
  title?: string;
  rawInput?: Record<string, unknown>;
}

export interface ReviewPolicy {
  /** false = vote mode: escalate everything. */
  autoApprove: boolean;
  autofix: boolean;
  comment: boolean;
}

export type ReviewDecision = 'approve' | 'escalate';

// Only these characters may appear in an auto-approvable shell command.
// Anything else (; & | $ ` < > ( ) { } newline quotes backslash, etc.)
// forces escalation — this defeats metacharacter smuggling like
// `git diff; rm -rf /` or `echo $(cat secret)`.
const SAFE_SHELL_CHARS = /^[A-Za-z0-9 _\-./=:@,]+$/;

// argv[0] → allowed argv[1] verbs. `true` = any subcommand allowed.
const SHELL_ALLOWLIST: Record<string, ReadonlySet<string> | true> = {
  git: new Set([
    'status',
    'diff',
    'log',
    'show',
    'rev-parse',
    'ls-files',
    'cat-file',
    'branch',
  ]),
  npm: new Set(['run', 'test', 'ci', 'exec']),
  pnpm: new Set(['run', 'test', 'exec']),
  yarn: new Set(['run', 'test']),
  npx: new Set(['tsc', 'vitest', 'jest', 'eslint']),
  cargo: new Set(['build', 'test', 'check', 'clippy']),
  go: new Set(['build', 'test', 'vet']),
  mvn: true,
  './mvnw': true,
  mvnw: true,
  gradle: true,
  './gradlew': true,
  gradlew: true,
  make: new Set(['build', 'test', 'check']),
  tsc: true,
  qwen: new Set(['review']),
  mkdir: true,
};

function classifyShell(command: unknown, policy: ReviewPolicy): ReviewDecision {
  if (typeof command !== 'string' || command.length === 0) return 'escalate';
  if (!SAFE_SHELL_CHARS.test(command)) return 'escalate';
  const argv = command.trim().split(/\s+/);
  const cmd = argv[0];
  // The PR-comment post is a `gh` invocation; gate it on `comment`.
  if (cmd === 'gh') return policy.comment ? 'approve' : 'escalate';
  const allowed = SHELL_ALLOWLIST[cmd];
  if (allowed === undefined) return 'escalate';
  if (allowed === true) return 'approve';
  return argv[1] !== undefined && allowed.has(argv[1]) ? 'approve' : 'escalate';
}

export function classifyReviewToolCall(
  toolCall: ReviewToolCall,
  policy: ReviewPolicy,
): ReviewDecision {
  if (!policy.autoApprove) return 'escalate';
  switch (toolCall.kind) {
    case 'read':
    case 'search':
      return 'approve';
    case 'edit':
      return policy.autofix ? 'approve' : 'escalate';
    case 'execute':
      return classifyShell(toolCall.rawInput?.['command'], policy);
    case 'fetch':
    case 'other':
    default:
      return 'escalate';
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/reviews/reviewClassifier.test.ts` → PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/reviews/reviewClassifier.ts packages/rc-gateway/src/reviews/reviewClassifier.test.ts
git commit -m "feat(rc-gateway): escalate-by-default review tool-call classifier"
```

### Task C.2: `reviewPermissionBridge.ts` (dedicated subscription, security-critical)

**Files:**

- Create: `packages/rc-gateway/src/reviews/reviewPermissionBridge.ts`
- Test: `packages/rc-gateway/src/reviews/reviewPermissionBridge.test.ts`

**Interfaces:**

- Consumes: `classifyReviewToolCall`, `ReviewPolicy` (C.1); `selectAllowOnceOptionId` (`../permissionOptions.js`).
- Produces: `ReviewBridgeDaemon` (structural minimal daemon interface), `ReviewBridgeDeps`, `ReviewPermissionBridge` with `open(sessionId, policy)`, `close(sessionId)`, `closeAll()`.
- Consumed by: routes (D.2) + cli.ts (E.2).

**Design:** For each opened session, subscribe via `daemon.subscribeEvents(sessionId, { lastEventId: 0, signal })` and consume frames in a loop. On `permission_request`: `classifyReviewToolCall(data.toolCall, policy)`.

- `approve` → pick `selectAllowOnceOptionId(data.options)`; if present, `daemon.respondToSessionPermission(sessionId, data.requestId, { outcome: { outcome: 'selected', optionId } })`; if absent, fall through to escalate (cannot safely one-time-approve).
- `escalate` → `deps.onEscalate?.(sessionId, data)` (wiring notifies the owner + marks the review blocked); do NOT vote (leave pending for the human).
- Any tool-output/session_update frame → `deps.onResume?.(sessionId)`.

- [ ] **Step 1: Write the failing test** (inject a fake daemon that yields scripted frames):

```ts
import { describe, it, expect } from 'vitest';
import {
  ReviewPermissionBridge,
  type ReviewBridgeDaemon,
} from './reviewPermissionBridge.js';
import type { ReviewPolicy } from './reviewClassifier.js';

function fakeDaemon(frames: Array<{ type: string; data: unknown }>) {
  const votes: Array<{ requestId: string; outcome: unknown }> = [];
  const daemon: ReviewBridgeDaemon = {
    async *subscribeEvents() {
      for (const f of frames) yield f;
    },
    async respondToSessionPermission(_sid, requestId, response) {
      votes.push({ requestId, outcome: (response as any).outcome });
      return true;
    },
  };
  return { daemon, votes };
}
const allowOnce = [
  { optionId: 'ok', kind: 'allow_once' },
  { optionId: 'always', kind: 'allow_always' },
];

describe('ReviewPermissionBridge', () => {
  it('auto-approves a read call with the allow_once option', async () => {
    const frames = [
      {
        type: 'permission_request',
        data: {
          requestId: 'q1',
          sessionId: 's',
          toolCall: { kind: 'read', rawInput: {} },
          options: allowOnce,
        },
      },
    ];
    const { daemon, votes } = fakeDaemon(frames);
    const bridge = new ReviewPermissionBridge({ daemon });
    const policy: ReviewPolicy = {
      autoApprove: true,
      autofix: false,
      comment: false,
    };
    await bridge.open('s', policy);
    await bridge.drain('s'); // test helper: await the loop's completion
    expect(votes).toEqual([
      { requestId: 'q1', outcome: { outcome: 'selected', optionId: 'ok' } },
    ]);
  });

  it('escalates an edit call (autofix off): no vote, onEscalate fires', async () => {
    const frames = [
      {
        type: 'permission_request',
        data: {
          requestId: 'q2',
          sessionId: 's',
          toolCall: { kind: 'edit', rawInput: {} },
          options: allowOnce,
        },
      },
    ];
    const { daemon, votes } = fakeDaemon(frames);
    const escalated: string[] = [];
    const bridge = new ReviewPermissionBridge({
      daemon,
      onEscalate: (sid) => escalated.push(sid),
    });
    await bridge.open('s', {
      autoApprove: true,
      autofix: false,
      comment: false,
    });
    await bridge.drain('s');
    expect(votes).toEqual([]);
    expect(escalated).toEqual(['s']);
  });

  it('escalates when no allow_once option is offered', async () => {
    const frames = [
      {
        type: 'permission_request',
        data: {
          requestId: 'q3',
          sessionId: 's',
          toolCall: { kind: 'read', rawInput: {} },
          options: [{ optionId: 'always', kind: 'allow_always' }],
        },
      },
    ];
    const { daemon, votes } = fakeDaemon(frames);
    const escalated: string[] = [];
    const bridge = new ReviewPermissionBridge({
      daemon,
      onEscalate: (sid) => escalated.push(sid),
    });
    await bridge.open('s', {
      autoApprove: true,
      autofix: false,
      comment: false,
    });
    await bridge.drain('s');
    expect(votes).toEqual([]);
    expect(escalated).toEqual(['s']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `reviewPermissionBridge.ts`**:

```ts
import { selectAllowOnceOptionId } from '../permissionOptions.js';
import {
  classifyReviewToolCall,
  type ReviewPolicy,
  type ReviewToolCall,
} from './reviewClassifier.js';

/** Minimal structural view of DaemonClient the bridge needs. */
export interface ReviewBridgeDaemon {
  subscribeEvents(
    sessionId: string,
    opts?: { lastEventId?: number; signal?: AbortSignal },
  ): AsyncIterable<{ type: string; data: unknown }>;
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: {
      outcome:
        | { outcome: 'selected'; optionId: string }
        | { outcome: 'cancelled' };
    },
  ): Promise<boolean>;
}

export interface ReviewBridgeDeps {
  daemon: ReviewBridgeDaemon;
  /** Called when a call is escalated (leave pending for a human vote). */
  onEscalate?: (sessionId: string, data: PermissionRequestData) => void;
  /** Called when tool output flows again (unblock). */
  onResume?: (sessionId: string) => void;
}

interface PermissionRequestData {
  requestId: string;
  sessionId: string;
  toolCall: ReviewToolCall;
  options: Array<{ optionId: string; kind: string }>;
}

export class ReviewPermissionBridge {
  private readonly loops = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  constructor(private readonly deps: ReviewBridgeDeps) {}

  async open(sessionId: string, policy: ReviewPolicy): Promise<void> {
    if (this.loops.has(sessionId)) return;
    const abort = new AbortController();
    const done = this.run(sessionId, policy, abort.signal).catch(() => {});
    this.loops.set(sessionId, { abort, done });
  }

  private async run(
    sessionId: string,
    policy: ReviewPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    const it = this.deps.daemon.subscribeEvents(sessionId, {
      lastEventId: 0,
      signal,
    });
    for await (const ev of it) {
      if (signal.aborted) return;
      if (ev.type === 'permission_request') {
        await this.handlePermission(
          sessionId,
          policy,
          ev.data as PermissionRequestData,
        );
      } else {
        this.deps.onResume?.(sessionId);
      }
    }
  }

  private async handlePermission(
    sessionId: string,
    policy: ReviewPolicy,
    data: PermissionRequestData,
  ): Promise<void> {
    const decision = classifyReviewToolCall(data.toolCall ?? {}, policy);
    if (decision === 'approve') {
      const optionId = selectAllowOnceOptionId(data.options);
      if (optionId !== undefined) {
        await this.deps.daemon.respondToSessionPermission(
          sessionId,
          data.requestId,
          {
            outcome: { outcome: 'selected', optionId },
          },
        );
        return;
      }
      // No one-time option → cannot safely approve; fall through to escalate.
    }
    this.deps.onEscalate?.(sessionId, data);
  }

  close(sessionId: string): void {
    const loop = this.loops.get(sessionId);
    if (!loop) return;
    loop.abort.abort();
    this.loops.delete(sessionId);
  }

  closeAll(): void {
    for (const sid of [...this.loops.keys()]) this.close(sid);
  }

  /** Test helper: await the subscription loop draining a finite fake stream. */
  async drain(sessionId: string): Promise<void> {
    await this.loops.get(sessionId)?.done;
  }
}
```

> Note: `selectAllowOnceOptionId` is at `packages/rc-gateway/src/permissionOptions.ts`. Confirm its exact export name in C.0; if it differs, adapt the import. The bridge never sends a `cancelled` outcome — escalation leaves the permission pending for the owner, matching the design (a human decides deny).

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/reviews/reviewPermissionBridge.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/reviews/reviewPermissionBridge.ts packages/rc-gateway/src/reviews/reviewPermissionBridge.test.ts
git commit -m "feat(rc-gateway): dedicated per-review permission bridge (vote/escalate)"
```

---

## Phase D — Routes, saga, stub daemon (fork)

### Task D.0: Alignment

- [ ] **Step 1: Verify the SDK surface + stub shape**

Run:

```bash
grep -n "sessionSupportedCommands\|createOrAttachSession\|endSession\|respondToSessionPermission\|subscribeEvents" packages/sdk-typescript/src/daemon/DaemonClient.ts
grep -n "promptStopReason\|POST /session\|sessionSupportedCommands\|permission" packages/rc-gateway/src/testing/stubDaemon.ts
sed -n '28,53p' packages/rc-gateway/src/routes/agents.ts
```

Expected: `sessionSupportedCommands(sessionId)` returns `{ availableSkills: string[]; ... }`; `createOrAttachSession`, `endSession`, `subscribeEvents`, `respondToSessionPermission` exist. Confirm the stub does NOT yet serve `sessionSupportedCommands` (D.1 adds it). Record the `AgentRoutesDeps` factory pattern to mirror. No changes.

### Task D.1: Extend `stubDaemon.ts`

**Files:**

- Modify: `packages/rc-gateway/src/testing/stubDaemon.ts`
- Test: covered by the route/integration tests that use it (no dedicated test).

- [ ] **Step 1: Add options + routes.** Add to `StubDaemonOptions`: `supportedSkills?: string[]` (default `['review']`), `permissionFrames?: Array<{ type: string; data: unknown }>` (frames a `subscribeEvents` call replays). Add handlers:
  - `GET /session/:id/supported-commands` (or the path `sessionSupportedCommands` hits — confirm in D.0) → `{ availableSkills: opts.supportedSkills ?? ['review'], availableCommands: [] }`.
  - Ensure the SSE `GET /session/:id/events` handler can emit `opts.permissionFrames` (used by the integration test to script permission requests). Reuse the existing frame-emission mechanism (event id inside the JSON envelope, per the stub's existing convention).
  - Record `lastRespondedPermission` (`{ requestId, response }`) when `POST /session/:id/permission/:requestId` is hit, exposed as a getter for assertions.

- [ ] **Step 2: Verify the stub still compiles + existing tests pass**

Run: `cd packages/rc-gateway && npx vitest run src/agents/agents.integration.test.ts src/routes/rewind.integration.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 3: Commit**

```bash
git add packages/rc-gateway/src/testing/stubDaemon.ts
git commit -m "test(rc-gateway): stubDaemon serves supported-commands + scripted permission frames"
```

### Task D.2: `routes/review.ts` — trigger saga (`POST /rc/reviews`) — **SECURITY-CRITICAL, OPUS-ONLY**

**Files:**

- Create: `packages/rc-gateway/src/routes/review.ts`
- Test: `packages/rc-gateway/src/routes/review.test.ts`

**Interfaces:**

- Consumes: `ReviewRegistry`, `ReviewTarget` (B.2); `ReviewLifecycle` (B.3); `ReviewPermissionBridge` (C.2); `DaemonClient`; `AuditRecorder`; `PromptQueue`; scope helpers (`OWNER`, `hasScope` from `../scopes.js`).
- Produces: `ReviewRoutesDeps`, `createTriggerReviewRoute(deps): RequestHandler` (D.2); `createListReviewsRoute`, `createGetReviewRoute`, `createCancelReviewRoute` (D.3).

**Saga** (mirrors `createSpawnAgentRoute`, adds pre-flight + bridge):

1. Parse `{ target, comment?, autofix?, autoApprove? }`. Validate `target` → `ReviewTarget` (default `{kind:'local'}`); 400 `invalid_target` on malformed input.
2. If `comment||autofix||autoApprove` and `!hasScope(req.rcClient.scopes, OWNER)` → `403 owner_scope_required`.
3. `daemon.createOrAttachSession({ sessionScope: 'thread' })`; fail → `502 daemon_unavailable`.
4. **Pre-flight:** `daemon.sessionSupportedCommands(sessionId)`; if `!availableSkills.includes('review')` → `endSession` (best-effort), `502 review_skill_unavailable`, register nothing.
5. Open the bridge: `bridge.open(sessionId, { autoApprove: !!autoApprove, autofix: !!autofix, comment: !!comment })`.
6. `registry.register({ sessionId, target, comment, autofix, approvalLeg: autoApprove?'auto':'vote', triggeredByTokenId })`.
7. Build the prompt (`/review <n>|<path>|''` + `--comment` if comment + report-only suffix if !autofix), send via a serialized prompt (accept-window race like agents); `send_failed` → `bridge.close`, `endSession`, `setStatus('failed')`, `502 prompt_send_failed`. On settle, `lifecycle.onPromptSettled(reviewId, ...)` then `bridge.close(sessionId)`.
8. `lifecycle.emit('review_started', rec)`, `audit.record({ action:'review_started', ... })`, `202 { reviewId, sessionId }`.

- [ ] **Step 1: Write the failing test** (drive the real `createGatewayApp`; see the boilerplate in `agents.integration.test.ts`). Cover: owner triggers local review → 202 + `review_started` frame + audit row; `read` token → 403; `write` token with `autofix:true` → 403 `owner_scope_required`; stub with `supportedSkills:[]` → 502 `review_skill_unavailable` + no record; target `{pr:42}` → the stub's `lastPromptBody` text is `/review 42`; `autofix:false` local → prompt text contains the report-only suffix. (Write these as concrete `fetch` assertions against the mounted app + `gw.ownerEvents` frame capture, mirroring the agents integration test.)

- [ ] **Step 2: Run to verify it fails** — route not mounted / module missing.

- [ ] **Step 3: Implement** `routes/review.ts` trigger handler + the target→prompt and prompt-suffix helpers. (Follow `createSpawnAgentRoute` verbatim for the session-create/register/accept-window/rollback legs; insert the pre-flight and bridge steps.) Full handler code — the implementer writes it against the interfaces above; the target→prompt mapping is:

```ts
function targetToPrompt(
  t: ReviewTarget,
  comment: boolean,
  autofix: boolean,
): string {
  const base =
    t.kind === 'pr'
      ? `/review ${t.number}`
      : t.kind === 'path'
        ? `/review ${t.path}`
        : '/review';
  const flag = comment ? ' --comment' : '';
  const suffix = autofix
    ? ''
    : '\n\nReport only — do not apply autofixes (skip the autofix step).';
  return base + flag + suffix;
}
```

and target parsing rejects anything not matching the three shapes (a `path` MUST be a non-empty string; a `pr` MUST be a positive integer).

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/routes/review.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/routes/review.ts packages/rc-gateway/src/routes/review.test.ts
git commit -m "feat(rc-gateway): POST /rc/reviews trigger saga (pre-flight + bridge)"
```

### Task D.3: `routes/review.ts` — list, detail, cancel

**Files:**

- Modify: `packages/rc-gateway/src/routes/review.ts`
- Test: `packages/rc-gateway/src/routes/review.test.ts` (add cases)

- [ ] **Step 1: Write the failing test** — list returns registered reviews with cost rollup (`withCost` from `deps.costFor`); detail 404 on unknown; cancel ends the session (stub `lastEndedSessionId`) + marks `cancelled` + emits `review_cancelled`; cancel on a terminal review → 409 `review_not_running`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** `createListReviewsRoute`, `createGetReviewRoute`, `createCancelReviewRoute` mirroring `createListAgentsRoute`/`createGetAgentRoute`/`createAgentCancelRoute` (cancel: 404 unknown → 409 terminal → `daemon.endSession` (502 on failure) → `setStatus('cancelled')` CAS (409 if lost) → `lifecycle.onCancelled(reviewId)` → audit `review_cancelled` → `200 { reviewId, status:'cancelled' }`). Add a `withReviewCost(rec, costFor)` helper.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/routes/review.ts packages/rc-gateway/src/routes/review.test.ts
git commit -m "feat(rc-gateway): GET/list/detail + cancel review routes"
```

---

## Phase E — Wiring, audit/notify, integration (fork)

### Task E.0: Alignment

- [ ] **Step 1: Verify the audit/payload/notifier + server/cli seams**

Run:

```bash
grep -n "session_rewound\|AUDIT_ACTIONS" packages/rc-gateway/src/auditLog.ts | tail
grep -n "WORKFLOW_EVENT_KINDS\|session_rewound\|buildPayload" packages/rc-gateway/src/webpush/payload.ts | head
grep -n "KIND_SCOPE\|SNOOZE_BYPASS" packages/rc-gateway/src/webpush/notifier.ts | head
grep -n "if (deps.agents)\|GatewayDeps\|AgentLifecycle(" packages/rc-gateway/src/server.ts | head
grep -n "AgentRegistry.open\|reconcile\|SessionEventPump" packages/rc-gateway/src/cli.ts | head
```

Expected: matches Phase-B/A findings. No changes.

### Task E.1: Audit actions + notification payload/scope

**Files:**

- Modify: `packages/rc-gateway/src/auditLog.ts` (add `review_started`, `review_cancelled` to BOTH the `AuditAction` union AND the `AUDIT_ACTIONS` array)
- Modify: `packages/rc-gateway/src/webpush/payload.ts` (add `review_completed`/`review_failed` → `review.completed`/`review.failed` branch)
- Modify: `packages/rc-gateway/src/webpush/notifier.ts` (add `review.completed`/`review.failed` → `SESSION_READ` in `KIND_SCOPE`; do NOT touch `SNOOZE_BYPASS_KINDS`)
- Test: `packages/rc-gateway/src/webpush/payload.test.ts` (add a case)

- [ ] **Step 1: Write the failing test** — `buildPayload({ type:'review_completed', review:{ reviewId:'r', sessionId:'s', target:{kind:'local'}, status:'completed' } } as any, { sessionId:'s' })` returns `{ kind: 'review.completed', ... }` with a summary line; `review_failed` → `review.failed`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement.**
  - `auditLog.ts`: append `| 'review_started' | 'review_cancelled'` to the `AuditAction` union AND `'review_started', 'review_cancelled',` to the `AUDIT_ACTIONS` array (both maintained separately).
  - `payload.ts`: add a `REVIEW_EVENT_KINDS = { review_completed: 'review.completed', review_failed: 'review.failed' }` map + a lookup block mirroring `WORKFLOW_EVENT_KINDS`, reading `event.review` for `sessionId`/`reviewId` and building `{ v:1, kind, sessionId, summary: truncate(...), url: sessionUrl(ctx.sessionId) }`.
  - `notifier.ts`: `KIND_SCOPE['review.completed'] = SESSION_READ; KIND_SCOPE['review.failed'] = SESSION_READ;`.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/webpush/payload.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/auditLog.ts packages/rc-gateway/src/webpush/payload.ts packages/rc-gateway/src/webpush/payload.test.ts packages/rc-gateway/src/webpush/notifier.ts
git commit -m "feat(rc-gateway): review audit actions + notification kinds"
```

### Task E.2: Wire into `GatewayDeps`, `server.ts`, `cli.ts`

**Files:**

- Modify: `packages/rc-gateway/src/server.ts` (`GatewayDeps.review` + `GatewayApp` optional exports + route mount)
- Modify: `packages/rc-gateway/src/cli.ts` (open registry, reconcile, construct lifecycle + bridge, pass deps)
- Test: `packages/rc-gateway/src/routes/review.test.ts` already drives `createGatewayApp` with the review deps; no new unit test (integration in E.3).

**Interfaces:**

- Add to `GatewayDeps`:

```ts
  review?: {
    registry: ReviewRegistry;
    costFor?: (sessionId: string) => number | undefined;
    resolveReport?: (rec: ReviewRecord) => Promise<{ reportPath: string | null; summary: ReviewRecord['summary'] }>;
    promptAcceptWindowMs?: number;
  };
```

- [ ] **Step 1: Mount the routes in `server.ts`** under `if (deps.review) { ... }` after `bearerResolve` (line ~555), constructing `new ReviewLifecycle(deps.review.registry, ownerEvents, deps.review.costFor, deps.review.resolveReport)` and `new ReviewPermissionBridge({ daemon: deps.daemon, onEscalate: (sid, data) => { void lifecycle.setBlocked(sid); void notifier?.notify({ type: 'permission_request', data }, { sessionId: sid }); }, onResume: (sid) => void lifecycle.setRunning(sid) })`. Build `reviewDeps` and mount:

```ts
app.post(
  '/rc/reviews',
  requireScope(WRITE, audit),
  recordActivity(workingDevice),
  createTriggerReviewRoute(reviewDeps),
);
app.get(
  '/rc/reviews',
  requireScope(SESSION_READ, audit),
  createListReviewsRoute(reviewDeps),
);
app.get(
  '/rc/reviews/:id',
  requireScope(SESSION_READ, audit),
  createGetReviewRoute(reviewDeps),
);
app.post(
  '/rc/reviews/:id/cancel',
  requireScope(WRITE, audit),
  recordActivity(workingDevice),
  createCancelReviewRoute(reviewDeps),
);
```

Expose `reviewLifecycle?` on `GatewayApp` (mirroring `agentLifecycle?`).

> **Terminal signal:** reviews do NOT need pump-seam wiring. The primary terminal signal is the trigger saga's prompt promise — `daemon.prompt(...)` resolves → `lifecycle.onPromptSettled(reviewId,'completed')`, rejects (incl. daemon death mid-turn) → `onPromptSettled(reviewId,'failed')`. `ReviewLifecycle.handleSessionEvent` (session_died → failed) is retained and unit-tested but is a redundant backup; if wiring it is cheap, feed it from the bridge by adding an `onSessionDied?(sessionId)` callback to `ReviewPermissionBridge` (the bridge's subscription already sees every frame) — do NOT add a second pump-seam subscription. The `setStatus` CAS guarantees only one terminal emission even if both fire.

- [ ] **Step 2: Open the registry + reconcile in `cli.ts`** near the `AgentRegistry.open` + reconcile block:

```ts
const reviewRegistry = await ReviewRegistry.open(
  join(homedir(), '.qwen', 'rc', 'reviews.json'),
);
// ... inside the existing caps.workspaceCwd reconcile try-block, after agents:
const orphanedReviews = await reviewRegistry.reconcile(
  live.map((s) => s.sessionId),
);
if (orphanedReviews.length > 0)
  console.warn(`reviews: marked ${orphanedReviews.length} orphaned`);
```

Build `resolveReport` (globs `<workspaceCwd>/.qwen/reviews/*-<target-suffix>.md` newest, reads `<workspaceCwd>/.qwen/review-cache/pr-<n>.json` for PR summary) and pass `review: { registry: reviewRegistry, costFor: <same costFor used for agents>, resolveReport, ... }` into `createGatewayApp`.

- [ ] **Step 3: Typecheck + full gateway build**

Run: `cd packages/rc-gateway && npx tsc --noEmit && npx vitest run src/routes/review.test.ts`
Expected: no type errors; route tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/cli.ts
git commit -m "feat(rc-gateway): wire review registry, lifecycle, bridge, routes"
```

### Task E.3: Integration test

**Files:**

- Create: `packages/rc-gateway/src/reviews/review.integration.test.ts`

- [ ] **Step 1: Write the test** (mirror `agents.integration.test.ts` boilerplate: real `createGatewayApp` + `startStubDaemon` + `TokenStore`/`PairingService`). Cover:
  1. **Trigger → frames → cancel** (owner token, vote mode): `POST /rc/reviews {target:{local:true}}` → 202; assert one `review_started` on `gw.ownerEvents`; `POST /rc/reviews/:id/cancel` → 200; assert `review_cancelled` + stub `lastEndedSessionId`.
  2. **Auto-approve scripted permissions**: start the stub with `permissionFrames` = `[read→expect vote, edit→expect no vote/escalate]`; trigger `{ autoApprove:true }` with an owner token; assert the stub's `lastRespondedPermission` shows the read was `selected`/`allow_once` and the edit was NOT voted (escalated).
  3. **Skill unavailable**: stub `supportedSkills:[]` → 502 `review_skill_unavailable`, `GET /rc/reviews` empty.

- [ ] **Step 2: Run** — `cd packages/rc-gateway && npx vitest run src/reviews/review.integration.test.ts` → PASS.

- [ ] **Step 3: Full suite sanity**

Run: `cd packages/rc-gateway && npx vitest run`
Expected: all green (no regressions across agents/workflows/rewind/reviews).

- [ ] **Step 4: Commit**

```bash
git add packages/rc-gateway/src/reviews/review.integration.test.ts
git commit -m "test(rc-gateway): remote review end-to-end (trigger/frames/cancel/auto-approve)"
```

### Task E.4: Archive the change (deferred — run only once deployed)

- [ ] **Step 1:** After the feature is merged and deployed, run in `qwen-code-remote`:

```bash
npx openspec archive add-remote-review
```

Status: `deferred:until-deployed` until then.

---

## Self-review checklist (run after execution, before final review)

- Every spec requirement (A.3 list) maps to a task: trigger saga (D.2), pre-flight (D.2), approval (C.1/C.2), SSE events (B.1/B.3/E.2), list/detail/cancel (D.3), reconciliation (B.2/E.2), audit (E.1/D.2/D.3). ✅
- No placeholder tasks; every code step shows real code or a verbatim pattern reference to a cited template.
- Type consistency: `ReviewTarget`/`ReviewRecord`/`ReviewPolicy`/`ReviewDecision` used identically across B.2, B.3, C.1, C.2, D.2, E.2.
- Security-critical tasks (C.1, C.2, D.2) flagged Opus-only.
- No daemon (`packages/cli`, `packages/core`) edits anywhere.
