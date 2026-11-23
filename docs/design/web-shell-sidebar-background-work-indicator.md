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

- ~~Sessions that are no longer live (closed, reclaimed, or after a daemon
  restart) while a detached background shell keeps running.~~ Moved into scope
  by the detached background-shell extension below (#17819).
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
  question, running and completed-unread arms whenever background tasks are
  running, and to an override label (`statusLabel`, e.g. the voice starting
  cue) for the same hidden-background reason. The background-only arm
  (`!hasActivePrompt && hasRunningBackgroundTasks`) already names it and is
  left alone. The completed-unread arm mirrors the row's dot precedence: it
  outranks the running, active-work and unknown arms, the background-only arm
  outranks it, and blocked-state precedence is unchanged (#18070).

The status dot precedence mirrors that chain (#18070): the live-starting
spinner replaces the dots; the background-only dot
(`!hasActivePrompt && hasRunningBackgroundTasks`) outranks the unread dot; the
unread dot outranks the running and active-work dots (an in-flight turn gates
off the background-only dot). Tints: green while a turn runs or other work is
active (updated from blue in #18072 so blue stays reserved for
completed-unread sessions), amber for background-only, blue for
completed-unread.

## Detached background shells (#17819)

The first out-of-scope item above became its own extension. A session whose
owning CLI process died can leave `running` shell sidecars behind — the
registry settles them on graceful exit only, so a hard kill orphans both the
process and the report. For such a row the in-memory signal does not exist,
and deleting it looks like harmless cleanup while a shell is still running
(#17819).

The daemon resolves the signal best-effort while building the catalog:

- The session list probes each persisted-only row's
  `<projectTempDir>/background-shells/<sessionId>/shell-*.status` sidecars
  (`detached-work-liveness.ts` in the serve layer). A `running` or `cancelled`
  claim, or a `failed` claim with a process token, reads as running when the
  Linux PID namespace and process-start token match a live process. An exited process or
  a different process reusing that PID in the same namespace clears the claim.
  Legacy records without identity, inaccessible or malformed records, and
  unsupported probes read as `unknown`.
- The verdict lands on the summary as `detachedBackgroundWork`: `'running'`,
  `'unknown'`, or absent (no sidecars, or every running claim disproven).
  Live entries never carry it: the in-memory `hasRunningBackgroundTasks` is
  authoritative for a session this daemon owns, and the live merge drops the
  persisted signal.
- Probe results are cached for 45 s (absent verdicts included). Each request
  checks up to 100 uncached sessions, 128 directory entries per session, and
  16 KiB per file. An open catalog with persisted rows reconciles every 60 s
  even when the live catalog version has not changed.

The client treats the two grades differently, mirroring the existing
`unknown` policy:

- `running` joins `hasLiveWork` and `sessionBlocksDelete` as a third term.
  It is not the attached runtime's work, so it blocks delete on any row —
  that is precisely the row shape whose delete looks like cleanup — and
  disables archive. The row renders the amber background marker under
  `data-web-shell-session-background-running="detached"`.
- `unknown` renders a hollow, muted, non-pulsing dot
  (`data-web-shell-session-background-unknown`, tooltip
  `background.detachedUnknown`) and blocks nothing — a hint, not knowledge
  of work, exactly like the `unknown` active-work grade. In the delete
  dialog the row stays tickable. The hint shows `delete.mayStillBeRunning`
  while the selection contains an unknown row, with errors and active delete
  progress taking precedence.

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
- **Best-effort, never an error.** The detached resolver runs inside the
  session list response path, so every probe failure degrades to `unknown` or
  to "no detached work" rather than failing the request.
- **Capture the OS identity on registration.** A promoted shell may have
  started long before the registry records its wall-clock `startTime`. Keep
  the original Linux process-start token and PID namespace on subsequent
  writes. `cancelled` is written before cancellation is requested, so those
  claims also require a process probe.
- **`unknown` still does not block.** Folding it into the predicates would
  block delete on every row probed on a platform without a start-time source
  (macOS, Windows) — those failure modes are environmental, not evidence of
  work.
- **Merge keeps live priority.** A session live in this daemon gets its
  background state from the registries; stacking the sidecar signal on top
  would double-report and could outlive the session's own state.

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
- The detached extension adds two keys in English and Simplified Chinese:
  `background.detachedUnknown` (the hollow dot's tooltip) and
  `delete.mayStillBeRunning` (the delete dialog's advisory). Other locales
  fall back to the English strings, as with any untranslated key.

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
   behind an approval or a question and under an override label such as the
   voice starting cue, without reordering blocked-state precedence; the
   unread arm outranks running/active-work/unknown and sits below the
   background-only arm.
4. Archive and delete are not offered for a session with background work — on
   the project rows (whether or not it is the attached session), the recent
   rows, the Session Overview cards, and in the delete dialog. An idle attached
   session stays deletable. Bulk Archive follows the flag as it changes after a
   row is ticked; a row that turns busy after selection is unchecked, stops
   being counted, and is dropped from the request.
5. Dot precedence mirrors the hover chain (starting spinner over all,
   background-only amber over unread, unread over running/active-work, with an
   in-flight turn gating off the background-only dot and active work sharing
   the running green per #18072 so blue stays reserved for completed-unread);
   the touch layout and the existing hover contracts hold.
6. Every pinned assertion dies under its corresponding mutation: the tooltip
   matrix (including per-arm suffix occurrence counts and the
   unread-over-running row) covers the composed hover chains, and the row-side
   witnesses pin the running→idle promotion via a control phase, the
   background-over-unread slot, the unread-over-active-work slot (with an
   active-only control row), and the tracker clearing unread when a completed
   session starts running again. The running dot's `!completedUnread` guard is
   defensive for the render-before-effect transient, with the
   unread-over-running leg pinned at hover level by the tooltip matrix.
7. A persisted-only session with a verified-running detached shell shows the
   amber background marker and refuses delete in the sidebar row and the
   delete dialog, and refuses archive, exactly as if the in-memory signal
   had been set.
8. A persisted-only session with an unverifiable detached shell shows the
   hollow unknown marker, keeps delete offered everywhere, and names the
   unknown status in the delete dialog's hint while an unknown row is selected.
   The hint expires once the grade clears or the last unknown row is deselected.
9. A live session never carries `detachedBackgroundWork`, even when stale
   sidecars exist on disk.
10. After a detached shell exits, a Web Shell left open clears the running
    marker on its next slow catalog reconciliation after the probe cache
    expires.

## Open questions / follow-ups

- Whether the amber marker should eventually carry a task count. The session
  summary has no count today, so this would need a protocol field.
