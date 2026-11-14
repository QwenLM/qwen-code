# Web Shell Goals page: multi-workspace support

[English](2026-11-14-web-shell-goals-multi-workspace.md) | [简体中文](2026-11-14-web-shell-goals-multi-workspace.zh-CN.md)

Status: implemented, pending review (2026-11-14). Current-state claims
verified against `origin/main` `114694062b`; implementation based on
`23ccf4d0b7` (the goals surfaces are unchanged between the two).

## Problem

The Web Shell sidebar "Goals" page lists active goals for the **primary
workspace only**. On a multi-workspace daemon:

- Goals running in secondary workspaces are invisible on the page, even
  though the Goal runtime itself is session-scoped and workspace-agnostic.
- The page's create form targets the currently selected workspace
  (`resolveWorkspaceMaintenanceTargetCwd`), so a goal created while a
  secondary workspace is selected never appears in the page's own list.

The sibling "Scheduled tasks" page already solved the same problem with a
workspace-qualified daemon route plus client-side aggregation. Goals should
follow that pattern.

## Current state

Verified at `origin/main` `114694062b` (line numbers from that commit):

| Layer                                                                                                         | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal runtime                                                                                                  | Session-scoped, owned by each `qwen --acp` child. Any workspace's sessions can run goals. No change needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /goals` (`packages/cli/src/serve/routes/goals.ts`)                                                       | Registered once in `server.ts` (`registerGoalsRoutes`, line 3935) with `boundWorkspace: primaryBoundWorkspace`, `bridge: primaryBridge`, the primary trust gate, and the primary generation assertion. Enumerates `bridge.listWorkspaceSessions(boundWorkspace)`, filters out agent-host sessions, fans out `sessionGoalGet` probes (concurrency 10), drops failed probes into `droppedCount`.                                                                                                                                                                                            |
| Per-session goal routes (`POST/GET /session/:id/goal`, `POST /session/:id/goal/clear` in `routes/session.ts`) | Already workspace-aware: `withOwnerMutableSession` / `withOwnerReadSession` resolve the owning runtime across workspaces (`resolveLiveSessionRuntime`). Pinned by `multi-workspace-sessions.test.ts`. No change needed.                                                                                                                                                                                                                                                                                                                                                                   |
| Client `listGoals()` (`packages/web-shell/client/daemon/workspace/actions.ts`, line 1026)                     | Always requests unqualified `/goals`; no `workspaceId` parameter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GoalsDialog` (`packages/web-shell/client/components/dialogs/GoalsDialog.tsx`)                                | Polls `actions.listGoals()` every 10 s; cards keyed by `sessionId`; controls go through the per-session routes above; create delegates to the App's `onCreateGoal(condition)`. No workspace awareness.                                                                                                                                                                                                                                                                                                                                                                                    |
| Scheduled-tasks reference pattern                                                                             | Daemon: `registerWorkspaceQualifiedScheduledTasksRoutes` (`routes/scheduled-tasks.ts`, line 2312) resolves `:workspace` via `resolveWorkspaceRuntimeWithLiveCompatibilityFromParam` + `requireTrustedWorkspaceRuntime`. Client: `listScheduledTasks(workspaceId?)` builds `/workspaces/:id/scheduled-tasks` for secondaries and keeps the unqualified route for the primary; `ScheduledTasksDialog` fans out over `operableWorkspaces` (primary + trusted secondaries), tags each item with `workspaceId`/`workspaceCwd`, badges cards, and offers a workspace picker in the create form. |

One trust-semantics difference matters: the primary scheduled-tasks read
surface is trust-free, while the primary `GET /goals` keeps its trust gate
(`isWorkspaceTrusted`). This design preserves each surface's existing gate.

## Goals

- The Goals page lists non-terminal goals from every operable workspace
  (the primary plus every trusted secondary), each card tagged with its
  workspace when more than one workspace is present.
- The create form can target any operable workspace; the default stays the
  currently selected workspace.
- Pause / resume / edit / clear keep working for goals in any workspace
  (the per-session control routes already resolve the owner).
- Single-workspace and locked-workspace deployments keep today's behavior
  and chrome (no badges, no picker).

## Non-goals

- No change to the Goal runtime, the per-session control routes, or the
  primary `GET /goals` contract.
- No cross-workspace aggregation on the daemon: the fan-out stays on the
  client, exactly like scheduled tasks.
- No goals listing for the internal "Conversations" (live) workspace in the
  page UI: the page aggregates `ordinaryWorkspaces`, which excludes live
  entries, same as scheduled tasks. The qualified daemon route itself still
  supports live-conversation runtimes for read-only listing, mirroring the
  qualified scheduled-tasks resolver.
- No new telemetry route entries: `/goals` and `/scheduled-tasks` are absent
  from the telemetry route table today; the qualified goals route stays
  consistent with that.

## Proposed changes

### Daemon: workspace-qualified goals listing

Refactor `routes/goals.ts` so the probe/collect/project logic is shared, and
add a second registration:

- `registerGoalsRoutes` keeps the exact primary contract (path, trust gate,
  generation assertion, response shape `{ v: 1, goals, droppedCount }`).
- New `registerWorkspaceQualifiedGoalsRoutes(app, { workspaceRegistry })`
  registers `GET /workspaces/:workspace/goals`. Per request it:
  1. Resolves the runtime with
     `resolveWorkspaceRuntimeWithLiveCompatibilityFromParam` (unknown or
     malformed selector → 400 `workspace_mismatch`; inactive runtime → 503
     `workspace_runtime_unavailable`; unavailable Conversations runtime →
     503 `conversation_runtime_unavailable`).
  2. Requires trust via `requireTrustedWorkspaceRuntime` (403
     `untrusted_workspace`).
  3. Runs the shared listing against `runtime.bridge` and
     `runtime.workspaceCwd`, with the runtime's `generationGuard` as the
     generation assertion when present.
- The shared listing keeps today's semantics: agent-host sessions filtered
  out, probe concurrency 10, failed probes dropped and counted, newest-first
  sort, read-only.

`server.ts` registers the qualified surface next to the existing
`registerGoalsRoutes` call, passing the same `workspaceRegistry` the other
qualified routes use.

### Client SDK: workspace-aware `listGoals`

- `DaemonWorkspaceActions.listGoals(workspaceId?: string)` in
  `daemon/workspace/types.ts` and `actions.ts`: with a `workspaceId` it
  requests `/workspaces/<encoded id>/goals`; without one it keeps
  `/goals`. Same response parsing and snapshot filtering as today.
- `DaemonGoal` gains optional `workspaceId?: string` and
  `workspaceCwd?: string`, populated by the page during fan-out (the daemon
  payload does not carry them), mirroring `DaemonScheduledTask`.

### GoalsDialog: aggregation, badges, picker

Mirror `ScheduledTasksDialog`'s multi-workspace shape:

- New optional props `workspaces?: DaemonWorkspaceCapability[]` and
  `lockedWorkspace?: DaemonWorkspaceCapability`, passed by App exactly as
  for scheduled tasks (`lockedWorkspaceCwd ? visibleWorkspaces :
ordinaryWorkspaces`, and `lockedWorkspaceCapability`).
- Derived state: `isMultiWorkspace = !lockedWorkspace && workspaces.length
  > 1`; `operableWorkspaces = workspaces.filter(ws => ws.primary ||
  > ws.trusted)`; `workspaceActionId(ws) = ws.primary ? undefined : ws.id`.
- Reload: locked → single qualified (or primary) fetch; multi → fan out
  over `operableWorkspaces` with `Promise.all`, tag each goal with its
  workspace, sum `droppedCount`, keep the first error while retaining the
  other workspaces' goals; single → today's unqualified fetch. The existing
  monotonic reload sequence and self-chaining 10 s poll stay unchanged.
- Cards: in multi-workspace view, a workspace badge (label from the existing
  `workspaceLabel` utils) leads the card footer. Card keys stay
  `sessionId` (session ids are daemon-global, unlike scheduled-task ids).
- Create form: in multi-workspace view, a workspace picker defaulting to
  the currently selected workspace when it is operable, else the primary.
  The App supplies that default through a `defaultWorkspaceCwd` prop.
  Edit form: no picker — the goal's session already owns its workspace.
- `onCreateGoal` becomes `(condition: string, workspaceCwd?: string)`.
  `onOpenSession` becomes `(sessionId: string, workspaceCwd?: string)` and
  the App loads the session in the goal's own workspace, exactly as the
  scheduled-tasks page does. Controls (`controlGoal`, clear) are unchanged:
  the per-session routes resolve the owning runtime.

### App wiring

- Pass `workspaces` / `lockedWorkspace` / `defaultWorkspaceCwd` to
  `GoalsDialog` (the same workspace arrays the scheduled-tasks page gets).
- `onCreateGoal(condition, workspaceCwd?)`: when the picker supplied a cwd,
  create the session in that workspace; otherwise keep
  `resolveWorkspaceMaintenanceTargetCwd()`. The stranded-session recovery,
  owner-guard, and show-chat flow stay unchanged.
- `onOpenSession` passes the goal's tagged `workspaceCwd` so
  `loadSidebarSession` switches to the goal's workspace context, mirroring
  the scheduled-tasks wiring.

### i18n

Add the goals-page workspace picker label (`goals.workspace`) to the en and
zh locales, reusing the scheduled-tasks wording; the partial ru locale
falls back to en, the same way it does for `scheduledTasks.workspace`.
Workspace display names come from the existing `workspaceLabel` /
`workspaceLabelForCwd` utils; the badge tooltip is the raw cwd.

## Design decisions

1. **Client-side fan-out, not a daemon aggregate route.** Matches scheduled
   tasks; keeps the daemon read surface per-workspace and lets one failing
   workspace degrade gracefully instead of failing the whole list.
2. **Primary keeps the unqualified, trust-gated route.** The client passes
   `undefined` for the primary exactly like scheduled tasks. Because
   `GET /goals` (unlike primary scheduled-tasks reads) is trust-gated, an
   untrusted primary's fan-out member returns 403 and surfaces as the
   page's partial-load error while other workspaces still render. This is
   the existing primary behavior, not a regression.
3. **No workspace fields in the daemon payload.** The client tags goals
   during fan-out, mirroring `DaemonScheduledTask`; the primary contract
   stays byte-compatible.
4. **Controls unchanged.** Owner-resolving per-session routes already work
   cross-workspace (pinned by `multi-workspace-sessions.test.ts`); adding
   qualified control routes would duplicate that machinery.
5. **Live-conversation workspaces excluded from the page, supported by the
   route.** Same split as scheduled tasks: the UI aggregates ordinary
   workspaces; the qualified resolver still handles the internal runtime
   read-only.

## Files affected

- `packages/cli/src/serve/routes/goals.ts` (shared listing + qualified
  registration) and `goals.test.ts`
- `packages/cli/src/serve/server.ts` (register qualified surface)
- `packages/web-shell/client/daemon/workspace/types.ts`, `actions.ts`,
  `goals.actions.test.ts`
- `packages/web-shell/client/components/dialogs/GoalsDialog.tsx`,
  `GoalsDialog.test.tsx`, `GoalsDialog.module.css` (badge/picker styles)
- `packages/web-shell/client/App.tsx` (props + create wiring)
- `packages/web-shell/client/i18n.tsx` (new keys, both locales)
- `packages/web-shell/client/e2e/utils/mockDaemon.ts` (qualified `/goals`
  branch) and affected E2E specs

## Constraints and risks

- **Poll cost.** The page polls every 10 s; aggregation multiplies that by
  the operable-workspace count, and each listing itself fans out to live
  sessions (concurrency 10 per workspace). Acceptable at today's workspace
  counts; the self-chaining poll already prevents overlapping fan-outs.
- **Stale workspace list.** Capabilities refresh can add/remove workspaces
  while the page is open; the reload callback depends on the memoized
  workspace arrays, so a change re-runs the mount effect (same as scheduled
  tasks).
- **Dropped-probe accounting.** `droppedCount` becomes a sum across
  workspaces; the degraded banner wording stays count-based and remains
  accurate.
- **Untrusted secondary.** Excluded from `operableWorkspaces`; its goals
  are silently absent, matching scheduled tasks. The qualified route
  rejects direct reads with 403.

## Validation plan

- Unit: daemon route tests for the qualified surface (happy path, trust
  403, unknown selector 400, inactive runtime 503, generation-closed 503,
  agent-host filtering, dropped probes, live-conversation runtime);
  client action URL tests; GoalsDialog aggregation/badge/picker/error
  tests; existing primary-surface tests must pass unchanged.
- E2E: mock-daemon Web Shell run with two registered workspaces, goals in
  both, verifying aggregation, badges, picker-targeted creation, and
  cross-workspace pause/clear; single-workspace regression run.
- `npm run build && npm run typecheck`, focused vitest suites for every
  changed file, lint/format.

## Acceptance criteria

- On a multi-workspace daemon, the Goals page shows non-terminal goals from
  the primary and every trusted secondary, each tagged with its workspace.
- Creating a goal via the picker lands it in the chosen workspace and the
  page lists it on the next poll.
- Pause/resume/edit/clear work for secondary-workspace goals.
- One workspace failing to list does not blank the others; the error and
  dropped counts surface.
- Single-workspace and locked-workspace views are unchanged (no badges, no
  picker, unqualified route).
- The primary `GET /goals` response contract is unchanged.

## Open questions

- None at proposal time. The aggregation UX follows the scheduled-tasks
  precedent; if a per-workspace filter is wanted later it can be added on
  top of the tagged list without daemon changes.
