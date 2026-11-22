# Daemon overload indicator in the task sidebar

[English](daemon-overload-sidebar-indicator.md) | [简体中文](daemon-overload-sidebar-indicator.zh-CN.md)

Status: proposed

## Problem

The load-admission gate (see [load-based session admission](load-based-session-admission.md)) refuses new sessions with `503 system_overloaded` while the host is saturated. Today the Web Shell only surfaces that refusal as a toast after the user clicks "New task": the state is invisible before the click, and the button keeps looking actionable while every click is guaranteed to fail. The raw gauges (CPU, memory, child RSS) already live in the Daemon Status dialog's metrics tab; what is missing is the actionable state at the point of action.

## Goals

- Show the overload state in the task sidebar header area, next to the "New task" button it governs.
- Disable "New task" and every creation entry point while overloaded, with the reason available as a tooltip.
- Learn the state proactively from `GET /daemon/status` (`runtime.loadAdmission`) so it is visible before the first refused click, and reactively from a `system_overloaded` refusal so a poll gap cannot hide it.
- Clear the state when the daemon reports recovery or the refusal hint expires.

## Scope boundaries

- No new dashboard and no raw CPU/memory numbers in the sidebar; those stay in the Daemon Status dialog.
- The indicator is a thin warning strip that only occupies space while overloaded; normal operation is visually unchanged.
- Only fresh ACP child allocation is paused: creation entry points disable or guard allocation, and a first prompt in a fresh draft (which would allocate a session) is refused with the same warning. Prompts to existing sessions, cancel, navigation, and warm runtime reuse remain available. Managed mode is exempt: its home button creates no daemon session.
- The daemon-side gate, its thresholds, and the status contract are unchanged by this slice.
- **Inert at this commit, by design.** Nothing in this tree produces either pause source: the gate, the `runtime.loadAdmission` publication, the 503 `system_overloaded` path and the `load-based-session-admission` design docs this file links to all ship in #18052, which must merge first (or in the same batch). Until then the poll runs against daemons that omit the field and the strip can only appear via the reactive refusal hint, which older daemons never send. The SDK member stays optional for exactly this reason.

## Design

### State sources

Two independent sources, OR-combined at render time:

1. **Proactive poll.** Inside `useDaemonOverloadPause`, `useOptionalDaemonWorkspace()` supplies `actions.loadDaemonStatus('summary')` to `useDaemonResource` (`autoLoad: true`, gated on `enabled && actions !== undefined && visible`), reloaded on a 5-second interval while the daemon is available and the tab is visible (with in-flight tracking across mount and interval ticks). `report.runtime.loadAdmission.overloaded` (gated on `enabled && error === undefined`) drives the paused state; the tooltip text is composed from the snapshot's `reason`, `loadRatio`, and `eventLoopLagP99Ms` through i18n. The SDK's `DaemonStatusReport` runtime type gains an additive optional `loadAdmission` field, following the existing "older daemons omit this field" convention; daemons without the gate simply never report it.
2. **Reactive refusal.** The existing notice effect that already handles `session_limit_exceeded` also handles `code === 'system_overloaded'` on `create_session`, `branch_session`, `fork_session`, `load_session`, and `resume_session`: it stores the notice message with an expiry of `Date.now() + 15_000` (the daemon's `Retry-After`), cleared by a timeout. This covers the window between polls and daemons whose status poll fails.

`overloadPaused = pollOverloaded || reactiveUnexpired`. The tooltip prefers the poll's localized readings when the poll reports overload, otherwise the refusal message. No merged state machine: the poll side is derived from the resource each render, the reactive side is a single expiring state value.

### Sidebar presentation

`WebShellSidebar` gains optional `overloadPaused`, `overloadDetail`, and `onOverloadRefused` props. While paused:

- A warning strip renders inside the new-task nav row, above the button: warning icon plus `sidebar.overloadPaused` ("System overloaded — new tasks paused"), `title`/`aria-label` carrying `overloadDetail`.
- `newSessionDisabled` becomes `creatingSession || overloadPaused`, disabling the button; `handleNewSession` and the worktree variant return early while paused so every sidebar entry point is guarded by the same predicate.
- The App-level create handler refuses with a warning toast while paused, covering entry points outside the sidebar (panel, empty page) with the same verdict.
- Every branch flow that can activate a restored child, including a record-point branch, uses the same pre-dispatch pause in `branchCurrentSession`. `atRecordId` is a history reference, not proof that the UI stays on the current runtime: the returned session can start a fresh `startSessionSwitch` load after publication. Refusing before mutation also avoids publishing a history point that cannot be activated during the pause. The slash handler propagates an explicit `false` to preserve its typed directive, while the `onBranchSession` callback keeps its existing `void | Promise<void>` contract.

#### `fork` versus a fresh ACP child

- `/fork` starts an `Agent` tool fork behind the current ACP `entry.connection` and its queue, not a `reserveFreshSession` operation. A fork subagent shares the parent's lifecycle and synthesized runtime configuration, so it belongs to existing work rather than to the new-ACP-child categories `spawn`, `load`, `resume`, and `branch`. New-task pause does not forbid this existing-session background path.
- An actual daemon `503 { code: "system_overloaded" }` is different from a pre-dispatch policy decision. `forkSession` and `branchSession` preserve the code while retaining their own `fork_session` / `branch_session` operations, including the deferred error from `startSessionSwitch` after a branch has already been published. The App notice effect recognizes those plus `create_session`, so unexpected overload errors still drive reactive pause instead of becoming only a generic failed-command toast. Their actual operations are preserved rather than relabeling either as `create_session`.
- A deferred branch-load overload is a recovery state, not a reason to request another branch. The already published branch retains its session ID for an explicit load after admission clears. The `actions` tests exercise this by rejecting the real `pendingSessionLoadRef` after publication and checking that the delayed notice retains both `branch_session` and `system_overloaded`.
- The strip disappears and the button re-enables as soon as both sources clear.

#### Control navigation and restore semantics

- **Removal remains available.** A current session that has already been removed or archived must not leave deleted history on screen. Its explicit workspace-directory recovery reset can clear local state and prepare a draft, but never allocates an ACP child in that reset; the subsequent first prompt still observes admission. Inherited/live intents do not inherit a pause bypass. Session Overview Back while paused only closes the panel and preserves the selected conversation; it neither clears nor allocates a session.
- **Async admission is allowed to return no destination.** If overload arrives while preflight or draft creation is in flight, `sendPrompt` checks `sessionIdAfterEnsure` before clearing the composer. A missing ID restores the cancelled/pre-admission state and returns `false`; no optimistic commit, disconnected-session send, or erased draft follows. Normal accepted sessions continue through the same owner checks.
- **Task consumption follows refreshed authority.** `ScheduledTasksDialog` applies `shouldRefuseManualRun` after refreshing the task, before either deleting a one-shot or dispatching a fresh child. The App reads the latest pause and connection state, so stale render closures cannot consume against an obsolete pause verdict. Recurring per-run dispatch is protected too, while a matching fully loaded connection or an unbound task on that connection can still run. A different bound ID is treated conservatively as a possible cold restore.
- **`/send`, `load`, and `resume` preserve their resource boundary.** `/send` without `--session-id` requests a fresh child and is refused before its RPC. An explicit target can still use an existing runtime (`byId` -> attach), and its backend overload response is mapped to the reactive hint and warning toast. On shared `startSessionSwitch` failure, an overload becomes a `load_session` or `resume_session` warning with `code: system_overloaded`, marked `_alreadyDispatched` to avoid a second error toast. Generic failures and aborts retain their previous handling; cold restore retry remains available when the host recovers.
- **Published worktree branches stay recoverable.** A post-publication overload invalidates the source workspace captured at the start of the request, not whichever workspace is selected when the error arrives. The persisted session ID can be opened explicitly once the host recovers. Ordinary branch callbacks keep their pending-Promise contract.
- **Warnings share the actual live detail.** `dispatchActionError` emits overload as a warning while other failures retain their original error tone. The sidebar's optional `onOverloadRefused` receives the App's current reason rather than a generic error placeholder. Embedders that do not supply that callback retain the existing `onError` fallback, and native disabled controls remain the hard UI boundary.

The poll/expiry/OR logic lives in a small `useDaemonOverloadPause` hook next to `useDaemonStatusReport`, so it is testable without rendering the App; the App owns the refusal state fed by the notice effect and composes the localized tooltip.

### i18n

New keys in all four shipped catalogs (`en`, `zh-CN`, `zh-TW`, `ru`): `sidebar.overloadPaused` (strip label) and `sidebar.overloadDetail` (interpolating function formatting reason, load ratio, and event-loop lag). Only `en` and `zh-CN` are inlined into the document export bundle (`zh-TW` and `ru` are transcript-stubbed). The reactive path reuses the daemon's own message verbatim.

## Design decisions and rationale

- **Point of action, not a dashboard.** The sidebar header is where the gated operation lives; a strip there turns a surprise 503 into a visible, explained pause. Raw metrics already have a home in the status dialog.
- **Poll plus refusal, not poll alone.** A 5-second poll can lag the gate by up to one interval plus the gate's own debounce; the reactive refusal makes the first failed click immediately explanatory, and its TTL matches the daemon's retry hint so the UI never stays paused longer than the daemon advises without poll confirmation.
- **Poll alone is not enough either.** Without it the state only appears after a failed click, which is exactly the surprise this slice removes.
- **Reuse before refusal.** In `resolveSessionForWorkspace` the pause guard sits below both reuse branches (connected-session ownership, newest catalog session) and above allocation: GitDialog commit/PR generation allocates nothing and must keep working while overloaded; only `forceCreate`/allocation is refused.
- **Freshness bound on the poll verdict.** `useDaemonResource` retains the last payload across poll failures and while disabled, so `pollOverloaded` requires `enabled && error === undefined`; while status is unreachable or offline only the expiring refusal hint may pause the UI.
- **Mount-request tracking and hidden-tab gate.** The autoLoad/mount request is counted in the same in-flight accounting as interval polls, and the resource is enabled only while the tab is visible (a `visibilitychange` listener re-enables and reloads on return), so a backgrounded or saturated-daemon tab never stacks summary requests.
- **One managed exemption across every guarded entry point.** Every `App.tsx` guard carries `!managedModeRef.current` — `createNewSession`, `sendPrompt`, `ensureSessionForPrompt`, `resolveSessionForWorkspace`, `handleGoalSlashCommand`, `branchCurrentSession` (including an early checkpoint check before worktree preflight), the `!` inline-shell branch of `handleSubmit` (checked before command queuing when a new session would be required), `ensureAgentMentionSession` (returning `{ paused: true }` so `useAgentChatEntry` skips `collab.mention.noSession`), and both side-task creation boundaries. `createSideTask` keeps its public boolean contract while `createEmptySideTask` omits a duplicate error; `createSideTaskSession` also refuses a failed tab's Retry with an already-dispatched rejection. The `overloadPaused && !managedMode` prop goes to `WebShellSidebar` and `ArtifactPanel`. `ScheduledTasksDialog` instead receives `shouldRefuseManualRun`, applied after its server refresh and before consuming a one-shot or recording a per-run attempt. The predicate re-reads live pause and connection refs. Every per-run dispatch is considered allocation; a missing connection, loading transcript, or different bound session ID is treated conservatively as a possible cold restore. Only a matching connection with `status: connected` and no active transcript load, or an unbound task on such a connection, may reuse existing work. This avoids deleting a one-shot before a refused cold load without claiming that every bound ID is warm in the UI.
- **Explicit refusal contract.** `sendPrompt` returns `false` on the pause refusal; the composer submit and the settings language sync honor it (draft kept / no false success), `enqueueManualRun` rejects with `_alreadyDispatched: true` so `reportError` does not emit a duplicate error toast, and fire-and-forget callers are unaffected.
- **Derived OR, no merge machine.** Two sources with different lifetimes (render-derived vs expiring state) combine in one expression; storing a merged verdict would need reconciliation on every poll and every expiry.
- **Additive SDK field.** Older daemons omit `loadAdmission`; the optional field keeps the client compatible with them and with the opt-out flag (`enabled: false` never pauses).

## Constraints and risks

- The poll adds one summary request per 5 seconds per open Web Shell; the summary is the cheap in-memory view already used by the status dialog.
- A daemon behind a proxy that strips the new status field degrades to reactive-only behavior, which is today's behavior plus the strip.
- The strip must not shift layout when it appears/disappears beyond its own row; it renders inside the existing nav container.

## Validation plan

- Component tests: sidebar renders the strip and disables the button (and early-returns from the create handler) while `overloadPaused`, and restores both when cleared; tooltip carries the detail string.
- Hook/App-level tests: poll overload drives the paused state (and drops on poll failure or `enabled: false`); a `system_overloaded` notice sets the expiring reactive state; expiry clears it; a non-overloaded poll does not clear an unexpired reactive hint; paused `!ls`, `/goal set`, `@`-mention, New side task, `createNewSession`, and unbound manual runs each emit a single warning toast without creating a session, and a paused unbound one-shot in `ScheduledTasksDialog` is refused before `runScheduledTask` consumes it. Paused `/branch` and checkpoint activation are refused before branch allocation or worktree preflight; ordinary checkpoint requests preserve their pending Promise and both worktree fallbacks await it. Branch/fork overload notices retain their operation and code, including a deferred branch-load refusal after publication, while `/fork` remains usable on the parent ACP runtime. Removal keeps a deleted session from blocking the view, Overview Back remains usable, and an overload arriving during async preflight preserves the draft. Refreshed cold-bound one-shot and recurring per-run dispatches are refused before consume/allocation, while a matching current session can still be reused. Missing-target `/send` is refused, an explicit warm target can be sent, and a real 503 triggers warning and reactive pause. Load/resume notices preserve operation/code, and a published worktree overload invalidates its source workspace. The sidebar warning callback preserves a no-new-session refusal instead of redirecting it to the ordinary error handler.
- `npm run build && npm run typecheck` plus the touched web-shell suites; SDK type addition checked by the sdk typecheck.
- E2E plan: `.qwen/e2e-tests/daemon-overload-sidebar-indicator.md` (component-level matrix plus an optional live probe against a loaded daemon).

## Acceptance criteria

- While the daemon reports `loadAdmission.overloaded`, the sidebar shows the warning strip and "New task" is disabled with the reason tooltip; no creation entry point creates.
- A `503 system_overloaded` refusal shows the strip immediately even if the poll has not caught up, and clears after the 15-second hint unless the poll confirms overload.
- Recovery (poll reports not overloaded and no unexpired refusal) removes the strip and re-enables creation.
- Daemons without the gate, or started with `--no-load-admission`, never show the strip.

## Open questions

- Whether the strip should also offer a "view daemon status" affordance opening the dialog's metrics tab; deferred to keep this slice minimal.

## Files affected

| File                                                                                   | Change                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/sdk-typescript/src/daemon/types.ts`                                          | Additive `runtime.loadAdmission` type             |
| `packages/web-shell/client/App.tsx`                                                    | Poll + reactive state, root guards, notice        |
| `packages/web-shell/client/App.test.tsx`                                               | App-level pause guard & reactive notice tests     |
| `packages/web-shell/client/daemon/session/httpErrors.ts`                               | `isSystemOverloadedError` classifier              |
| `packages/web-shell/client/daemon/session/httpErrors.test.ts`                          | Classifier shape & negative-control table         |
| `packages/web-shell/client/daemon/session/actions.ts`                                  | Overload notice metadata and warnings             |
| `packages/web-shell/client/daemon/session/actions.test.ts`                             | Overload operation/code tests                     |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`                     | Strip, disabled predicate, warning callback       |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css`              | Warning strip & disabled header-action styles     |
| `packages/web-shell/client/components/sidebar/StandaloneRecents.tsx`                   | `newSessionDisabled` prop                         |
| `packages/web-shell/client/components/workspace-agents/useAgentChatEntry.ts`           | `{ paused: true }` short-circuit for `@`-mentions |
| `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.tsx`                | Pre-consume/pre-dispatch manual-run guard         |
| `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.test.tsx`           | Cold-bound and per-run guard tests                |
| `packages/web-shell/client/components/artifacts/ArtifactPanel.tsx`                     | `overloadPaused` disable on New side task         |
| `packages/web-shell/client/i18n.tsx`                                                   | `en` overload keys                                |
| `packages/web-shell/client/i18n-zh-cn.ts`                                              | `zh-CN` overload keys                             |
| `packages/web-shell/client/i18n-zh-tw.ts`                                              | `zh-TW` overload keys                             |
| `packages/web-shell/client/i18n-ru-part3.ts`                                           | `ru` overload keys                                |
| `packages/web-shell/client/i18n.test.ts`                                               | Four-locale interpolation & parity test           |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonOverloadPause.ts`           | Poll + expiry + freshness + OR hook               |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonOverloadPause.test.ts`      | Poll/reactive/expiry/freshness tests              |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.overload-strip.test.tsx` | Strip/disabled/menu/standalone tests              |
| `packages/web-shell/client/e2e/utils/mockDaemon.ts`                                    | Default healthy `GET /daemon/status` mock         |
| `packages/web-templates/src/export-html/build.mjs`                                     | Merged-tree export-size budget re-track           |
