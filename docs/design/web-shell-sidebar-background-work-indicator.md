# Web Shell Sidebar: Make Background Work Visible on a Session Row

[English](web-shell-sidebar-background-work-indicator.md) | [简体中文](web-shell-sidebar-background-work-indicator.zh-CN.md)

Status: implemented and verified locally (browser-level evidence below).

## Problem

A session that is running background tasks does not look busy in the left
sidebar. Two shapes were reported and measured:

- **Turn finished, background work still running.** The row shows only a small
  amber dot (6px in CSS). The trailing busy spinner and the `runningSession` row
  highlight are deliberately suppressed for this shape, so the row reads almost
  exactly like an idle row.
- **Turn in flight and background work running.** Nothing on the row names the
  background work at all: the status dot is prompt-gated, so the amber dot is
  replaced by the green running dot.

## Current state

The data path is already correct and was measured end to end against a live
daemon (0.28.0, local and remote):

- `Session.hasRunningBackgroundTasks()` derives from the background task, shell,
  workflow and monitor registries; the active-work snapshot carries it to the
  daemon.
- `GET /workspaces/:workspace/sessions/live-state` and the session catalog both
  publish `hasRunningBackgroundTasks`.
- Three real top-level sessions in the "turn finished + background shell"
  shape rendered `data-web-shell-session-background-running` with computed
  `visibility: visible`, `color: rgb(236, 201, 75)`, size 5×5 px.

So this is an expression gap, not a reporting gap. In `WebShellSidebar.tsx` the
row computed `backgroundRunning = !hasActivePrompt && hasRunningBackgroundTasks`
and then rendered the busy marker only when `running && !backgroundRunning`.

## Goals and scope

Goals:

1. A row whose only activity is background work must read as busy at a glance.
2. A row with a turn in flight must still name its background work.

Out of scope (recorded as follow-ups, not silently dropped):

- Sessions that are no longer live (closed, reclaimed, or after a daemon
  restart) while a detached background shell keeps running. The shell registry
  is in-memory, so no `hasRunningBackgroundTasks` reaches the client at all.
  Evidence: a remote session whose shell pid had been alive ~26h was absent
  from live-state and carried no background field in the catalog.
- Surfacing background work in surfaces other than the sidebar row and its
  details tooltip.

## Solution

Reuse the existing trailing busy marker instead of adding a new indicator:

- Render it when `running || backgroundTasks`, so background-only rows get it
  back. `backgroundTasks` is the unprompt-gated fact; `running` alone is not
  enough because a monitor holds no active-work category and grades the row
  idle.
- Tint it with the same amber as the status dot (`--warning-color`) whenever
  background tasks are running, via `.sessionLoadingBackground`.
- Label it `background.running` when background work runs without a turn;
  otherwise keep the existing `sidebar.running` / `sidebar.activeWork` label and
  append the background text to its `title`.
- In `SessionDetailsTooltip`, compose the status as
  `sidebar.running · background.running` when a turn and background work
  coexist.

The status dot precedence is unchanged: green while a turn runs, amber for
background-only, blue for other active work.

## Design decisions and rationale

- **No new icon or badge.** The row already has a busy marker; widening its
  condition and tinting it is the smallest change that satisfies both goals,
  and it keeps the meta slot's marker vocabulary unchanged.
- **Keep the prompt-gated dot.** An existing end-to-end contract pins that the
  amber dot is absent while a turn runs and that the row's busy marker is
  labeled `Running` in that shape. Both still hold.
- **Color is never the only carrier.** The marker's `aria-label`/`title` and the
  details status name the background work in text, so the state is reachable
  without perceiving the tint.
- **Hide the marker when a background-only row reveals its actions.** Such a
  row is not `.runningSession`, so hovering anywhere on the row reveals the
  action overlay; `.sessionRow:hover:not(.runningSession) .sessionLoading` joins
  the existing marker-hiding rule so the spinner never sits under the buttons.

## Constraints and risks

- The amber tint relies on `--warning-color`, already used by the background
  status dot; the fallback `#d29922` matches it.
- No new i18n keys: `background.running`, `sidebar.running` and
  `sidebar.activeWork` already exist in every locale.
- The composed strings join with a middle dot (`·`) surrounded by spaces, the
  separator already used by the details tooltip and the capacity dialog.
- Touch layouts are unaffected: the new hiding rule lives inside
  `@media (hover: hover)`, so the touch block still hides no marker.
- The busy marker shares the meta slot's trailing position with the branch /
  worktree icon, so a background-only row now shows the spinner instead of that
  icon — the same tradeoff a row with a running turn already makes.

## Validation

Unit (`packages/web-shell`):

- `client/components/sidebar/WebShellSidebar.collapse-persist.test.tsx` — 85
  passed, including the extended state matrix and a new background-only case
  with `activeWorkState: 'idle'`.
- `client/components/sidebar/SessionDetailsTooltip.test.tsx` — 20 passed.
- `client/components/sidebar/WebShellSidebar.css.test.ts` and
  `client/visual-capture-contracts.test.ts` — 16 passed.
- `npm run typecheck`, ESLint and Prettier clean on the changed files.

Existing end-to-end contracts (`npx playwright test`, mock daemon):
`client/e2e/web-shell.background-turn.spec.ts` and
`client/e2e/web-shell.composer-usage.spec.ts` — 8 passed, including "keeps the
background task sidebar indicator visible on hover and prioritizes the prompt
spinner".

Mutation witnesses (each applied to the reviewed tree, run, then reverted):
reverting the gate to `running && !backgroundRunning`, dropping the
`|| backgroundTasks` arm, dropping the amber class, dropping the composed
`title`, and reverting the tooltip composition — all five killed (5/5).

Browser (dev server from this worktree proxied to a live daemon, real sessions,
no response interception):

| Shape             | Busy marker                                                                                                           | Left dot                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Turn + background | `aria-label="Running"`, `title="Running · Background tasks running"`, `border-top-color: rgb(236, 201, 75)`, spinning | `data-web-shell-session-running`            |
| Background only   | `aria-label="Background tasks running"`, same amber, spinning                                                         | `data-web-shell-session-background-running` |

Hovering the background-only row: busy marker opacity `0`, actions opacity `1`.
The details tooltip on the turn + background row reads
`Running · Background tasks running`. No page errors.

## Acceptance criteria

1. A background-only row shows the trailing busy marker, amber, labeled
   `background.running`.
2. A row with a turn in flight and background work shows the amber marker with
   `Running` as its accessible name and the composed `title`.
3. The details tooltip names both states when they coexist.
4. Dot precedence, the touch layout, and the existing hover contracts are
   unchanged.
5. Every assertion above dies under the corresponding mutation.

## Open questions / follow-ups

- Non-live sessions with a still-running detached background shell remain
  unmarked; fixing that needs a daemon-side liveness source (status file plus
  pid check) and a bounded scan cost. Tracked separately.
- Whether the amber marker should eventually carry a task count. The session
  summary has no count today, so this would need a protocol field.
