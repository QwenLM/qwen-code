# UI Auth Transaction Coordinator — Design

**Date:** 2026-08-16
**Status:** Approved for implementation

## Goal

Make every UI-originated authentication, provider-install, and model-selection mutation latest-request-wins, so a cancelled or superseded operation cannot persist, publish, or roll back over a later UI operation.

## Scope

The coordinator is owned by the CLI UI layer. It serializes these shared-state writers:

- `/auth` provider submissions, including Copilot token discovery, device flow, persistence, and installation;
- ModelDialog primary model switches, including cached-token Copilot switching;
- interactive `/model <id>` switches;
- provider-template update confirmation.

ACP, serve, VS Code, and direct core callers retain their current APIs and are not coordinated by this UI service.

## Coordinator

`useUiProviderTransaction()` is created once by AppContainer and exposed through UI actions/context. It owns one active `AbortController`, a monotonically increasing generation, and a promise tail.

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

A new `run` immediately invalidates publication and aborts the active generation, then waits for that generation to settle before starting. A newer queued `run` supersedes an older queued operation; the stale operation resolves `undefined` before taking a settings backup, snapshot, network request, or runtime mutation. `cancelActive` invalidates and aborts **only the active** generation; a queued later operation remains eligible and starts after the active operation settles. Hook teardown performs a private disposal path: it aborts the active generation, preserves its rollback ownership through settlement, and invalidates every queued operation so no UI mutation starts after unmount.

`canPublish()` becomes false immediately on cancellation or supersession and fences refresh publication plus all success/error UI. `ownsRollback()` stays true for the active generation until its operation settles, then becomes false, so the core install transaction completes its rollback before the next generation can snapshot or mutate shared state. Core `isCurrentTransaction` receives `ownsRollback`; Config refresh receives `canPublish`. Internal tail settlement always absorbs prior rejection so a later queued operation starts; the original caller still receives its operation rejection.

## `/auth` integration

`useAuthCommand.handleProviderSubmit` runs its complete flow inside one coordinator operation. Copilot discovery/device flow/token persistence receives the transaction signal. Every provider passes the same `signal` and `ownsRollback` to `applyProviderInstallPlan`; Config refresh receives `canPublish`.

Before installation, the hook snapshots the current UI runtime: auth type, active runtime model, and registry base URL. It always supplies `rollbackRuntime`:

- previously unauthenticated: `config.resetAuth(previousModelId)`;
- previously authenticated: `config.switchModel(previousAuthType, previousModelId, { baseUrl })`.

The coordinator does not release the next operation until the prior install either succeeds or completes rollback. Thus a later submission snapshots the last settled state, never a partial predecessor. Core keeps its existing optional `signal` and `isCurrentTransaction` interfaces; non-UI callers remain behaviorally compatible.

## Other UI writers

ModelDialog, interactive `/model`, and every provider-update confirmation mutation run their existing mutations through the same coordinator. AppContainer injects the UI-local runner into the interactive slash-command context; non-interactive and ACP command contexts retain current behavior. A multi-provider update confirmation is one atomic UI transaction: it snapshots persistent and live state before its first entry and restores the whole batch if any entry is cancelled or fails. Provider updates pass transaction signal/rollback ownership plus `rollbackRuntime` to their install plans; Config refresh receives `canPublish`. ModelDialog snapshots any process-environment hydration it performs and restores it if its switch becomes stale. All writers suppress stale success and failure feedback. They do not invent broad rollback for ordinary completed model switches; serialization ensures they cannot interleave with a provider-install transaction.

## Cancellation UX

`cancelAuthentication` calls the coordinator’s `cancelActive`. Copilot device progress uses the existing external-auth progress surface, which takes precedence over AuthDialog while external auth state exists and exposes the same cancellation action. The coordinator’s own unmount cleanup uses disposal rather than `cancelActive`, invalidating queued work as well as aborting active work.

## Required RED-first matrix

1. Ordinary `/auth` install A is cancelled while refresh is deferred; B begins only after A rolls back, then B succeeds.
2. A is cancelled while refresh is deferred; B begins after settlement and fails; persistent and runtime state return to the pre-A baseline.
3. First-time unauthenticated Copilot cancellation restores no selected auth/model/generator.
4. A stale transaction cannot publish or restore after newer `/auth`, ModelDialog, `/model`, or provider-update operation begins.
5. Cancelling discovery, polling, persistence, installation, unmount, and overlapping submissions prevents all later continuation.
6. Normal successful provider setup and model switch remain passing controls.

## Constraints

- No new dependency and no global core transaction coordinator.
- `fs.promises.rename` and an already-running refresh cannot be withdrawn; after they settle the active UI transaction must either commit as current or roll back before the next generation starts.
- Every new test records an actual RED failure before production code changes and retains a passing control.
