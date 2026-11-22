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
  from live-state and carried no background field in the catalog. Tracked in
  #17819.
- Re-grading the Session Overview panel's cards. A background-only session
  still reads `idle` there, which keeps the panel's sort order and displayed
  status unchanged; its two destructive card actions are gated separately (see
  below), because that grade alone would offer them.
- The pre-existing difference for a _turn_ running in a session this client is
  not attached to: the sidebar row still offers Delete while the Session
  Overview card refuses it, because the card has always required an `idle`
  grade. This change makes the two agree about background work; aligning the
  turn case is a separate policy decision.
- Deciding what the `unknown` and `unsupported` grades mean for archive and
  delete. The shared predicate answers "is work known to be running"; the
  side-task archive gate additionally fails closed on those grades, and that
  difference is deliberate and documented on the predicate.

## Solution

Reuse the existing trailing busy marker instead of adding a new indicator:

- One shared predicate, `hasLiveWork` in `client/session-catalog/`, answers
  "would closing this session end work it is still doing": a turn, other active
  work, **or** background tasks. The row's busy marker renders on it, so
  background-only rows get the marker back — including the monitor shape, which
  holds no active-work category and grades the row idle.
- The same predicate replaces every other copy of that question on the action
  side: the sidebar's archive and delete eligibility checks, its standalone
  archive handler, the recent rows' archive gate, the delete dialog's refusal
  guard, the Session Overview card actions, and the Activity archive
  confirmation (which previously spelled the same disjunction out twice). A
  row that says it is busy must not offer the action that ends the work, and no
  two entry points may disagree.
- The delete rule itself lives beside that predicate as `sessionBlocksDelete`,
  which takes the caller's own notion of "current" rather than deriving it from
  an id: the sidebar compares workspace-qualified identity and lets the
  recent/standalone adapters override it, while the dialog compares session ids.
  The sidebar row, the sidebar eligibility check and the delete dialog call
  it, so that rule has one home. The Session Overview card gates are a fourth
  delete path and deliberately stay stricter — they also require an `idle`
  grade and block live work on every card, not just the attached one — so they
  keep their own expression; the Out of scope list above records the same
  asymmetry for a running turn as a pre-existing difference.
- Delete refuses background work on any row, not just the attached one, in
  both the sidebar and the delete dialog: the delete route has no idle guard,
  so confirming would kill work the row advertises, and the Session Overview
  card already refuses that session. Clicking a refused row in the dialog
  names the reason in its hint — the danger button is disabled in that state,
  so the row click is the only place the refusal can reach the user — and only
  the attached row's wording says "the current session".
  An idle attached session stays deletable (#12619). The hint tracks live state
  rather than the click: it names whichever rule blocks the row now, goes away
  once the row is deletable again, and stays quiet while a delete is running or
  a live error or a delete outcome holds the slot — the dialog renders those nowhere
  else, so a refusal must not take the slot from them. The load error and the
  delete outcome keep separate slots: sharing one let a recovering list clear
  a failure the user had not been told about yet.
- Three staleness holes close with it. Selection mode keeps its own copy of
  each ticked session, so its refresh contract now carries the background flag
  too — otherwise bulk Archive would judge a session by the value it had when
  ticked. The delete dialog re-evaluates the guard when building the request,
  not only on click. And it prunes a row that turned busy out of the selection,
  so the checkbox and the count the user reads agree with what is sent — a
  blocked row cannot be unchecked by hand, so leaving it ticked would silently
  omit a session the dialog said was included.
- Tint the marker with the same amber as the status dot (`--warning-color`)
  whenever background tasks are running, via `.sessionLoadingBackground`.
- Name the marker only where it is the sole carrier. In the background-only
  shape the status dot already carries `background.running`, so the marker
  stays unnamed and carries no `title`; during a turn it keeps the existing
  `sidebar.running` / `sidebar.activeWork` name and adds a `title` composing
  both states. A live-starting row swaps the dot for its own spinner, so the
  marker takes the name back there rather than leaving the state unnamed.
- In `SessionDetailsTooltip`, append ` · background.running` to the approval,
  question and running arms whenever background tasks are running. The
  background-only arm already names it and is left alone, and blocked-state
  precedence is unchanged.

The status dot precedence is unchanged: green while a turn runs, amber for
background-only, and green for other active work (updated from blue in #18072
so blue stays reserved for completed-unread sessions).

## Design decisions and rationale

- **No new icon or badge.** The row already has a busy marker; widening its
  condition and tinting it is the smallest change that satisfies both goals,
  and it keeps the meta slot's marker vocabulary unchanged.
- **Keep the prompt-gated dot.** An existing end-to-end contract pins that the
  amber dot is absent while a turn runs and that the row's busy marker is
  labeled `Running` in that shape. Both still hold.
- **Color is never the only carrier.** The status dot's name, the marker's name
  during a turn, and the details status all name the background work in text,
  so the state is reachable without perceiving the tint.
- **One name per row, not two.** The row is a `role="button"` whose accessible
  name is assembled from its children, so naming both the dot and the marker
  with the same string made every background-only row announce it twice.
- **A `title` only where it adds information.** Hovering the marker hides it
  and, on rows with actions, the revealed overlay covers it, so a native
  tooltip is not a dependable carrier. The composed `title` is kept for the
  turn-in-flight shape as a secondary description; the reachable carrier for
  both states is the details popover.
- **Guards follow the advertisement.** Widening only the row's visual would
  leave a row that says "busy" offering Archive, which closes the live session
  daemon-side and kills the background work. The two poll-cadence aggregates
  that ask a similar question are deliberately untouched: they only choose
  between fast and idle catalog polling on daemons without live-state, where
  coverage is independent of them.
- **Hide the marker when a background-only row reveals its actions.** Such a
  row is not `.runningSession`, so hovering anywhere on the row reveals the
  action overlay; `.sessionRow:hover:not(.runningSession) .sessionLoading` joins
  the existing marker-hiding rule so the spinner never sits under the buttons.

## Constraints and risks

- The amber tint relies on `--warning-color`, already used by the background
  status dot; the fallback `#d29922` matches it.
- The marker reuses `background.running`, `sidebar.running` and
  `sidebar.activeWork`, which already exist in every locale. One key is added:
  `sidebar.deleteRunningDisabled`, because both existing delete-refusal strings
  say "the current session" and the row gate also refuses other sessions. It is
  translated in every locale.
- The composed strings join with a middle dot (`·`) surrounded by spaces, the
  separator already used by the details tooltip and the capacity dialog.
- Touch layouts are unaffected: the new hiding rule lives inside
  `@media (hover: hover)`, so the touch block still hides no marker.
- The busy marker shares the meta slot's trailing position with the branch /
  worktree icon, so a background-only row now shows the spinner instead of that
  icon — the same tradeoff a row with a running turn already makes.

## Validation

Unit (`packages/web-shell`):

- The whole `client/session-catalog/`, `client/components/dialogs/` and
  `client/components/sidebar/` directories plus
  `client/visual-capture-contracts.test.ts` — 79 files, 1761 passed. Running the
  directories rather than only the touched files is what catches an older
  contract that the widened guards could have broken.
- `npm run typecheck`, ESLint and Prettier clean on the changed files.

Existing end-to-end contracts (`npx playwright test`, mock daemon):
`client/e2e/web-shell.background-turn.spec.ts` and
`client/e2e/web-shell.composer-usage.spec.ts` — 8 passed, including "keeps the
background task sidebar indicator visible on hover and prioritizes the prompt
spinner".

Mutation witnesses (each a one-line edit to the reviewed tree, run against the
committed tests, then reverted) — twelve killed, each by the assertion that
owns it: dropping the background term from `hasLiveWork`, judged by both the
predicate's own test and the sidebar suites; restoring the delete dialog's own
two-term predicate; naming the marker even when the dot already does; ignoring
the live-starting swap when deciding the carrier; dropping
the suffix from the approval arm and from the question arm; keeping the
redundant `title` on background-only rows; swapping the amber token for the
muted one; deleting the amber rule outright; composing the suffix
unconditionally; and dropping the amber class.

Browser (dev server from this worktree proxied to a live daemon, real sessions,
no response interception):

| Shape             | Busy marker                                                                                                           | Left dot                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Turn + background | `aria-label="Running"`, `title="Running · Background tasks running"`, `border-top-color: rgb(236, 201, 75)`, spinning | `data-web-shell-session-running`            |
| Background only   | unnamed and no `title` (the dot carries the name once), same amber, spinning                                          | `data-web-shell-session-background-running` |

Hovering the background-only row: busy marker opacity `0`, actions opacity `1`.
The details popover on the turn + background row reads
`Running · Background tasks running`, and the same popover names the background
work behind an approval or a question. Archive is disabled on a background-only
row. No page errors.

## Acceptance criteria

1. A background-only row shows the trailing amber busy marker, and the row
   announces `background.running` exactly once.
2. A row with a turn in flight and background work shows the amber marker with
   `Running` as its accessible name and the composed `title`.
3. The details popover names both states whenever they coexist, including
   behind an approval or a question, without reordering blocked-state
   precedence.
4. Archive and delete are not offered for a session with background work — on
   the project rows (whether or not it is the attached session), the recent
   rows, the Session Overview cards, and in the delete dialog. An idle attached
   session stays deletable. Bulk Archive follows the flag as it changes after a
   row is ticked; a row that turns busy after selection is unchecked, stops
   being counted, and is dropped from the request.
5. Dot precedence (turn running > background-only amber > other active work,
   with active work sharing the running green per #18072 and blue reserved for
   completed-unread), the touch layout, and the existing hover contracts hold.
6. Every assertion above dies under the corresponding mutation.

## Open questions / follow-ups

- Non-live sessions with a still-running detached background shell remain
  unmarked; fixing that needs a daemon-side liveness source (status file plus
  pid check) and a bounded scan cost. Tracked separately.
- Whether the amber marker should eventually carry a task count. The session
  summary has no count today, so this would need a protocol field.
