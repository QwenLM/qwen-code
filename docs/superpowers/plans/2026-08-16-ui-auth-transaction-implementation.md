# UI Auth Transaction Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize every UI-originated provider and model mutation so a cancelled or superseded operation cannot clobber a later UI operation.

**Architecture:** AppContainer owns a latest-request-wins transaction coordinator and exposes it through UI actions/context. `/auth`, ModelDialog, `/model`, and provider-update writers run through that coordinator; `applyProviderInstallPlan` continues to receive optional signal/currentness callbacks and non-UI callers remain unchanged.

**Tech Stack:** TypeScript, React hooks/context, Vitest, existing Config and provider-install APIs.

**Spec:** `docs/superpowers/specs/2026-08-16-ui-auth-transaction-design.md`

## Global Constraints

- The coordinator is CLI-UI-local; do not add a global core coordinator or dependency.
- Serialize before any settings backup, runtime snapshot, network request, or state mutation.
- Every new behavioral test must fail before production edits and retain a passing control.
- A stale generation never emits success/error UI, commits settings/runtime state, or rolls back over a newer settled generation.
- Run tests from their owning package directory.

---

### Task 1: Add the UI transaction coordinator

**Files:**

- Create: `packages/cli/src/ui/hooks/useUiProviderTransaction.ts`
- Create: `packages/cli/src/ui/hooks/useUiProviderTransaction.test.ts`
- Modify: `packages/cli/src/ui/contexts/UIActionsContext.tsx`
- Modify: `packages/cli/src/ui/AppContainer.tsx`

**Interfaces:**

- Produces:

```ts
interface UiProviderTransaction {
  run<T>(
    operation: (context: {
      signal: AbortSignal;
      canPublish: () => boolean;
      ownsRollback: () => boolean;
    }) => Promise<T>,
  ): Promise<T | undefined>;
  cancelActive(): void;
}
```

- Consumed by all later UI mutation tasks through `UIActions`.

- [ ] **Step 1: Write failing coordinator tests**

Add deterministic deferred-promise tests proving a second `run` makes the first `canPublish()` false and aborts its signal, but leaves its `ownsRollback()` true until settlement and false afterward; the second waits for settlement before starting. Start A, queue B, call `cancelActive`, then settle A; assert B starts afterward with an un-aborted, publishable context. Start A, queue B, unmount, then settle A; assert B never runs and resolves `undefined`. Start A, queue B then C, settle A; assert B never runs and its promise resolves `undefined`, while C starts afterward. Reject A while B is queued; assert A’s caller sees the rejection but B still starts after A settles. The normal control asserts one callback execution, an un-aborted/publishable/rollback-owning context, and the sentinel result.

- [ ] **Step 2: Capture RED**

Run: `cd packages/cli && npx vitest run src/ui/hooks/useUiProviderTransaction.test.ts`

Expected: failures because the hook/module and `UIActions` method do not yet exist.

- [ ] **Step 3: Implement the minimal coordinator**

Use refs for the active entry, latest queued request, and a rejection-safe promise tail. `run` invalidates publication and aborts only the active entry, marks older queued work stale, waits for the prior tail with rejection absorbed, exits stale queued work with `undefined`, then executes the latest queued entry. Its context reports `canPublish` from immediate cancellation/supersession and `ownsRollback` until that entry settles. The internal tail always resolves after settlement even when the caller-facing promise rejects. `cancelActive` invalidates publication and aborts only the active entry without invalidating queued work or releasing rollback ownership.

- [ ] **Step 4: Wire AppContainer and UI actions**

Instantiate the hook once in AppContainer and publish `runUiProviderTransaction` and `cancelUiProviderTransaction` through `UIActionsContext` without changing non-UI APIs.

- [ ] **Step 5: Capture GREEN**

Run: `cd packages/cli && npx vitest run src/ui/hooks/useUiProviderTransaction.test.ts`

Expected: all coordinator and control tests pass.

### Task 2: Serialize `/auth` and make cancellation transactional

**Files:**

- Modify: `packages/cli/src/ui/auth/useAuth.ts`
- Modify: `packages/cli/src/ui/auth/useAuth.test.ts`
- Modify: `packages/cli/src/ui/components/DialogManager.tsx`
- Create: `packages/cli/src/ui/components/DialogManager.test.tsx`
- Modify only if required by tests: `packages/cli/src/ui/auth/AuthDialog.tsx`

**Interfaces:**

- Consumes: `runUiProviderTransaction`, `cancelUiProviderTransaction`, and existing `applyProviderInstallPlan` optional `signal`/`isCurrentTransaction`/`rollbackRuntime` callbacks.
- Produces: all provider submissions—including ordinary providers and Copilot—take snapshots only after previous UI transaction settlement; `ownsRollback` is passed to core and `canPublish` fences refresh/UI completion.

- [ ] **Step 1: Write failing cross-provider tests**

Add deferred-refresh tests for:

```ts
// A is cancelled during refresh; B is queued but does not begin until A rolls back.
// B then succeeds and remains the selected runtime.

// A is cancelled during refresh; B begins after A settles then fails.
// The final persistent/runtime state equals the state before A.

// First-time Copilot cancellation returns to no auth/model/generator.

// A late cancelled completion/rejection cannot clear B's active UI, publish history,
// record a slash result, or emit visible success/error telemetry.
```

Rewrite the existing concurrent-Copilot test so it queues B, proves B has not started, settles A, then awaits B. Split its prior two-flow cancellation assertion into explicit-cancel (A aborts, B later starts) and unmount (A aborts, B never starts) controls. Add a DialogManager rendering test proving Copilot external-auth progress takes precedence over AuthDialog and its cancel callback routes to `cancelAuthentication`. Retain successful ordinary-provider and Copilot setup tests as controls.

- [ ] **Step 2: Capture RED**

Run: `cd packages/cli && npx vitest run src/ui/auth/useAuth.test.ts src/ui/components/DialogManager.test.tsx`

Expected: interleaved submissions start before predecessor settlement or preserve partial predecessor state, and Copilot external progress is absent or masked by AuthDialog.

- [ ] **Step 3: Run complete submit flow inside the coordinator**

Remove the private Copilot controller as the transaction owner. Keep Copilot discovery, device flow, and token persistence inside the coordinator operation. Pass `signal` plus `ownsRollback` to every provider install, use `canPublish` for Config refresh, capture a pre-install runtime snapshot only after coordinator ownership begins, and always provide authenticated and unauthenticated rollback restoration. Suppress stale completion/error/history/telemetry effects.

- [ ] **Step 4: Wire visible cancellation**

`cancelAuthentication` calls the coordinator cancellation action while preserving its Qwen OAuth behavior. Make Copilot external-auth progress take precedence over AuthDialog and use the same cancellation action rather than a private flow.

- [ ] **Step 5: Capture GREEN**

Run: `cd packages/cli && npx vitest run src/ui/auth/useAuth.test.ts src/ui/components/DialogManager.test.tsx`

Expected: all ordinary/Copilot cancellation, first-time, overlapping, and successful controls pass.

### Task 3: Serialize direct model and provider-update UI writers

**Files:**

- Modify: `packages/cli/src/ui/AppContainer.tsx`
- Modify: `packages/cli/src/ui/components/ModelDialog.tsx`
- Modify: `packages/cli/src/ui/components/ModelDialog.test.tsx`
- Modify: `packages/cli/src/ui/commands/types.ts`
- Modify: `packages/cli/src/ui/hooks/slashCommandProcessor.ts`
- Modify: `packages/cli/src/ui/commands/modelCommand.ts`
- Modify: `packages/cli/src/ui/commands/modelCommand.test.ts`
- Modify: `packages/cli/src/ui/hooks/useProviderUpdates.ts`
- Modify: `packages/cli/src/ui/hooks/useProviderUpdates.test.ts`

**Interfaces:**

- Consumes: the AppContainer-published UI transaction coordinator.
- Produces: direct model switching and provider-template updates cannot interleave with `/auth` install/rollback and do not present stale UI success/errors.

- [ ] **Step 1: Write failing cross-surface tests**

Add deterministic deferred-switch/install tests proving:

```ts
// A ModelDialog switch that becomes stale cannot persist settings, record history,
// publish slash feedback, close the dialog, or retain a hydrated process.env value
// after a later transaction starts.

// Interactive /model receives the AppContainer runner through optional CommandContext
// services and cannot start switchMainModel until an active auth transaction settles.
// Non-interactive and ACP command contexts remain uncoordinated controls.

// Provider update, skip, and later confirmation mutations run as one coordinator
// operation; no shared settings backup/reload begins while auth owns the transaction.
// A cancelled update restores the pre-update live auth/model/runtime. For a
// multi-provider pending batch, cancellation or failure of a later entry restores
// every earlier entry too; a stale update emits neither success nor error history.
```

Keep existing successful switch/update and genuine `/model` rejection tests as controls.

- [ ] **Step 2: Capture RED**

Run: `cd packages/cli && npx vitest run src/ui/components/ModelDialog.test.tsx src/ui/commands/modelCommand.test.ts src/ui/hooks/useProviderUpdates.test.ts`

Expected: current direct writers begin while the competing mutation is pending.

- [ ] **Step 3: Wrap direct writers**

Pass the AppContainer runner directly to parent-level hooks. Add optional UI-only transaction runner services to the interactive slash-command context; use it only for interactive `/model`. Before a multi-provider update batch, snapshot persistent and live runtime state; on cancellation or failure restore the whole snapshot, including already successful earlier entries. Pass signal/rollback ownership plus `rollbackRuntime` to each install and publish ownership to Config refresh. Run the complete provider-update/skip/later mutation path inside one transaction. Snapshot ModelDialog environment hydration and restore it if the switch becomes stale. Use `context.canPublish()` before feedback, persistence, history, telemetry, error rendering, and dialog closure. Preserve existing single-operation guards and non-interactive/ACP behavior.

- [ ] **Step 4: Capture GREEN**

Run: `cd packages/cli && npx vitest run src/ui/components/ModelDialog.test.tsx src/ui/commands/modelCommand.test.ts src/ui/hooks/useProviderUpdates.test.ts`

Expected: all cross-surface regressions and normal controls pass.

### Task 4: Verify core compatibility and cancellation UX

**Files:**

- Modify: `packages/core/src/providers/__tests__/install.test.ts`
- Modify: `packages/cli/src/ui/components/DialogManager.test.tsx`

**Interfaces:**

- Consumes: existing optional core transaction callbacks.
- Produces: unchanged non-UI provider-install behavior and a reachable Copilot progress/cancellation UI path.

- [ ] **Step 1: Add compatibility control and mutation-proven UX regression**

Add a complete non-UI `applyProviderInstallPlan` control that omits `signal`, `isCurrentTransaction`, and `rollbackRuntime` while asserting normal provider patch, model selection, persistence/cleanup, reload, sync, and refresh callbacks. In DialogManager, render real `ExternalAuthProgress` inside `KeypressProvider` with active Copilot external auth and AuthDialog both present; assert progress content and `Esc to cancel`, absence of AuthDialog content, and Esc invoking `cancelAuthentication` plus updating auth state. The core control is already green by design; prove the UI test can fail by temporarily mutating the existing progress-precedence condition, capture that RED result, then restore it before the normal GREEN run.

- [ ] **Step 2: Capture RED**

Run: `cd packages/cli && npx vitest run src/ui/components/DialogManager.test.tsx`

Expected under the temporary precedence mutation: Copilot progress is absent/masked or Esc does not reach the Auth action.

- [ ] **Step 3: Apply only required wiring**

Restore the original precedence production code after the mutation proof. Do not change core production APIs; optional callback compatibility remains a control. Fix production only if the unmutated rendered test finds an actual defect.

- [ ] **Step 4: Capture GREEN**

Run: `cd packages/core && npx vitest run src/providers/__tests__/install.test.ts` and `cd packages/cli && npx vitest run src/ui/components/DialogManager.test.tsx`; retain all controls.

### Task 5: Hybrid final verification

**Files:**

- Review the full redesign diff and documentation.

- [ ] Run `npm run typecheck`, `npm run lint`, and `npm run build` after targeted suites pass.
- [ ] Use a fresh read-only hybrid review team for transaction ownership, stale publication, rollback, and cross-surface UI races.
- [ ] Use a separate adversarial reviewer after the team reports to challenge every handled-seam claim.
- [ ] Read the final diff twice, including documentation. Stop after two clean passes.
- [ ] Prepare PR title/body materials without creating a PR.
