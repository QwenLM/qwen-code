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
- Only creation is paused: every create entry point is disabled or omitted, and a first prompt in a fresh draft (which would allocate a session) is refused with the same warning. Prompts to existing sessions, cancel, and navigation are untouched. Managed mode is exempt: its home button creates no daemon session.
- The daemon-side gate, its thresholds, and the status contract are unchanged by this slice.
- **Inert at this commit, by design.** Nothing in this tree produces either pause source: the gate, the `runtime.loadAdmission` publication, the 503 `system_overloaded` path and the `load-based-session-admission` design docs this file links to all ship in #18052, which must merge first (or in the same batch). Until then the poll runs against daemons that omit the field and the strip can only appear via the reactive refusal hint, which older daemons never send. The SDK member stays optional for exactly this reason.

## Design

### State sources

Two independent sources, OR-combined at render time:

1. **Proactive poll.** A `useDaemonStatusReport({ detail: 'summary' })` resource in the App, reloaded on a 5-second interval while the daemon is available. `report.runtime.loadAdmission.overloaded` drives the paused state; the tooltip text is composed from the snapshot's `reason`, `loadRatio`, and `eventLoopLagP99Ms` through i18n. The SDK's `DaemonStatusReport` runtime type gains an additive optional `loadAdmission` field, following the existing "older daemons omit this field" convention; daemons without the gate simply never report it.
2. **Reactive refusal.** The existing notice effect that already handles `session_limit_exceeded` also handles `code === 'system_overloaded'` on `create_session`: it stores the notice message with an expiry of `Date.now() + 15_000` (the daemon's `Retry-After`), cleared by a timeout. This covers the window between polls and daemons whose status poll fails.

`overloadPaused = pollOverloaded || reactiveUnexpired`. The tooltip prefers the poll's localized readings when the poll reports overload, otherwise the refusal message. No merged state machine: the poll side is derived from the resource each render, the reactive side is a single expiring state value.

### Sidebar presentation

`WebShellSidebar` gains two optional props: `overloadPaused?: boolean` and `overloadDetail?: string`. While paused:

- A warning strip renders inside the new-task nav row, above the button: warning icon plus `sidebar.overloadPaused` ("System overloaded — new tasks paused"), `title`/`aria-label` carrying `overloadDetail`.
- `newSessionDisabled` becomes `creatingSession || overloadPaused`, disabling the button; `handleNewSession` and the worktree variant return early while paused so every sidebar entry point is guarded by the same predicate.
- The App-level create handler refuses with a warning toast while paused, covering entry points outside the sidebar (panel, empty page) with the same verdict.
- The strip disappears and the button re-enables as soon as both sources clear.

The poll/expiry/OR logic lives in a small `useDaemonOverloadPause` hook next to `useDaemonStatusReport`, so it is testable without rendering the App; the App owns the refusal state fed by the notice effect and composes the localized tooltip.

### i18n

New keys in both dictionaries: `sidebar.overloadPaused` (strip label) and `sidebar.overloadDetail` (tooltip template with reason/ratio/lag placeholders). The reactive path reuses the daemon's own message verbatim.

## Design decisions and rationale

- **Point of action, not a dashboard.** The sidebar header is where the gated operation lives; a strip there turns a surprise 503 into a visible, explained pause. Raw metrics already have a home in the status dialog.
- **Poll plus refusal, not poll alone.** A 5-second poll can lag the gate by up to one interval plus the gate's own debounce; the reactive refusal makes the first failed click immediately explanatory, and its TTL matches the daemon's retry hint so the UI never stays paused longer than the daemon advises without poll confirmation.
- **Poll alone is not enough either.** Without it the state only appears after a failed click, which is exactly the surprise this slice removes.
- **Derived OR, no merge machine.** Two sources with different lifetimes (render-derived vs expiring state) combine in one expression; storing a merged verdict would need reconciliation on every poll and every expiry.
- **Additive SDK field.** Older daemons omit `loadAdmission`; the optional field keeps the client compatible with them and with the opt-out flag (`enabled: false` never pauses).

## Constraints and risks

- The poll adds one summary request per 5 seconds per open Web Shell; the summary is the cheap in-memory view already used by the status dialog.
- A daemon behind a proxy that strips the new status field degrades to reactive-only behavior, which is today's behavior plus the strip.
- The strip must not shift layout when it appears/disappears beyond its own row; it renders inside the existing nav container.

## Validation plan

- Component tests: sidebar renders the strip and disables the button (and early-returns from the create handler) while `overloadPaused`, and restores both when cleared; tooltip carries the detail string.
- Hook/App-level tests: poll overload drives the paused state; a `system_overloaded` notice sets the expiring reactive state; expiry clears it; a non-overloaded poll does not clear an unexpired reactive hint.
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

| File                                                                                   | Change                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/sdk-typescript/src/daemon/types.ts`                                          | Additive `runtime.loadAdmission` type    |
| `packages/web-shell/client/App.tsx`                                                    | Poll + reactive state, props, notice     |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`                     | Strip, disabled predicate, handler guard |
| `packages/web-shell/client/i18n.tsx`                                                   | en + zh keys                             |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css`              | Warning strip styles                     |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonOverloadPause.ts`           | Poll + expiry + OR hook                  |
| `packages/web-shell/client/daemon/workspace/hooks/index.ts`                            | Hook barrel export                       |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.overload-strip.test.tsx` | Strip/disabled tests                     |
| `packages/web-shell/client/daemon/workspace/hooks/useDaemonOverloadPause.test.ts`      | Poll/reactive/expiry tests               |
