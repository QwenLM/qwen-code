# Activity view

[English](activity-view.md) | [简体中文](activity-view.zh-CN.md)

## Problem and evidence

The sidebar lists projects and conversations but offers no single queue for
approval, input, errors, unread updates and running work. Completion dots are
currently ephemeral. The reference desktop application implements an activity
snapshot rather than continuously sorting a filtered list. Its bundled code
was decompiled and inspected alongside the supplied report and screenshots; it is behavioral
reference material, not a dependency or source to copy.

## Scope and decisions

Implement a complete activity mode for the Web Shell's daemon workspace
conversations. Respect the existing host, locked-workspace and trust boundaries.
The activity directory follows the selected daemon host; it does not aggregate
other hosts or standalone conversations without a workspace. Managed-agent and
live-voice surfaces keep their own navigation. Unsupported sources must not be
silently treated as workspace conversations. Qwen has no
equivalent of ChatGPT's account history or explicit silent-heartbeat flag; do
not invent those sources or suppress ordinary background work.

Use the existing directory, live-state feed, transcript page reads and archive
APIs. No new directory database, model-generated summaries or per-row polling.
Reuse the sidebar's existing in-memory `completedUnreadIds` for unread state.
A conversation becomes unread when the page observes its running-to-finished
transition while it is not the current conversation. Activity rows and the
existing blue dots share this state; historical conversations are not initially
unread merely because they lack a read record. Do not add backend read fields,
capabilities or write requests. Refreshing or remounting the sidebar clears the
record, completions while the page is closed cannot be reconstructed, and
separate tabs or clients do not synchronize reads. These are intentional limits
of preserving the existing completion-dot semantics. Preview reads do not
change unread state.

## Comparison with the earlier persisted-read design

The current design preserves the existing completion-dot behavior. It reuses
the daemon's existing organization capabilities and introduces no read-state
backend version gate. Marking read is a local state update, so it has no receipt
request failures, retries or cross-client synchronization races. Its limits
are deliberate: refresh loses unread records, offline completions cannot be
reconstructed, and each tab or client has independent read state.

The earlier design added `lastReadActivityAt` and required the new
`session_activity_read_state` capability and an upgraded daemon. It could retain
read state across reloads and share it through directory refresh. It used the
observed `updatedAt`, with monotonic writes to prevent older requests from
overwriting newer acknowledgements. Those guards did not make a session update
equivalent to a completed assistant turn, and persistence alone did not recover
every offline completion. Treating historical conversations with no receipt as
unread also changed the old behavior undesirably. Receipt failures, retries and
late responses added asynchronous state that this revision removes.

The retained optional `hasTurnError` live-state field is separate from unread
state. Older daemons can still support activity through existing capabilities,
but without this field error presentation is best effort: an error may be absent
or remain stale until other session data refreshes. A future persisted design
could improve continuity if it defines completion or turn identities, migration
of unknown historical read state, and whether read ownership belongs to a user
or a shared daemon. Those decisions are outside this revision.

## Interaction and state

- A bell and Cmd/Ctrl+Alt+U toggle activity. Escape closes it. The bell indicates
  unread or actionable states, not running work alone.
  Its selected state uses the existing theme blue with a faint blue background,
  consistently in the expanded sidebar and navigation rail. Both entries use a
  pointer cursor in their selected and unselected states.
- The list starts with its first category, without a separate Activity heading.
  Exactly one options trigger belongs to the first displayed category: Priority
  when enabled, otherwise Pinned or the first recent date. An empty list uses a
  Today heading so the options remain reachable. The options trigger reuses the
  existing workspace overflow button, vertical ellipsis, right inset and
  standard auto-width dropdown rather than activity-specific menu styling.
  Category headings use the normal sidebar's spacing, typography and controls.
  Activity participates in the existing session-list layout without an extra
  padded container; groups reuse the normal pinned-session list so headings,
  row titles, status indicators and action buttons align with normal mode.
  Expanded empty categories use that same list container and bottom spacing;
  the priority empty-state message is rendered inside it.
  Pinned shares its expanded
  state and chevron interaction with the normal sidebar. Priority also has a
  collapse toggle, local to the open activity view; date headings remain static.
  Collapsed category rows are not rendered, do not load previews and consume no
  visible-row budget. Pinned uses the normal sidebar's ordering, with newly
  pinned conversations appended rather than placed first.
- Initial priority order is input/approval/error, unread, running, then idle;
  ties use descending activity time and stable identity. Child sessions are
  excluded unless pinned; archived and inaccessible sessions are excluded.
- Opening records a snapshot. Existing priority entries retain their relative
  order and remain after reading or completion; new eligible entries merge in.
  Closing discards the snapshot. Clear read removes settled read entries only.
- Priority is enabled by default, a separate pinned section and scheduled tasks
  are disabled. Preferences persist. Reset restores these defaults.
  The options menu begins with a Display label. When preferences differ from the
  defaults, an accessible reset icon appears at the right of that label instead
  of a separate reset menu row. Reset keeps the menu open and recomputes the
  activity snapshot; it does not change read state or pinned expansion.
- Recent conversations cover seven local calendar days including today, grouped
  by date. Priority has no age cutoff. Sections never duplicate identities.
  A shared budget starts at ten and expands by ten.
- Rows use the normal sidebar's `renderSessionRow` directly, preserving its
  selection, keyboard handling, status indicators, inline actions, context menu,
  rename, pin and archive behavior with the same capability checks. There is no
  activity-specific row layout, styling, idle dot or always-visible workspace
  suffix. The existing hover details popover shows time, workspace and other
  available context, including branch, pull requests and session identity.
  Assistant previews are capped at 600 Unicode code points and use the normal
  row's existing snippet slot and styles. Visible rows load bounded transcript
  pages without attaching or starting sessions. Preview failures use the shared
  notice layout and can be retried; loading and partial failure remain
  distinguishable from an empty queue.
- Selecting a conversation clears its existing completion dot through the
  sidebar's shared state. Mark all read removes the priority section's unread
  identities from that same in-memory set; it neither clears the snapshot nor
  changes unrelated conversations. Closing activity discards only its snapshot,
  not the sidebar's unread set.
- Bulk archive applies to priority, excluding recent and pinned-only entries.
  Confirmation explains when running work will stop. The existing atomic
  close-and-archive API performs the operation; successes disappear, failures
  remain, and undo restores successful archives without restarting work.
  Operations are bounded to eight concurrent requests. Navigation leaves an
  archived current conversation only after confirmed success.

## Implementation boundaries

Unread state stays in the existing sidebar component; the activity model accepts
the derived unread flag and the catalog controller handles directory reads,
previews and archive operations. Each identity has one completion observer:
the legacy trackers skip conversations currently covered by the activity
catalog, so delayed responses cannot recreate a completion already marked read.
Core organization metadata, Bridge summaries
and daemon organization routes gain no read-state fields. Live-state includes
turn errors. Existing workspace routes must use resolved runtime storage,
including failure paths. Web Shell adds an activity model, controller and view
under `components/sidebar`, reuses shared UI primitives, and integrates the bell
with the sidebar. The activity view owns grouping, budgets and preview loading;
the sidebar supplies its existing session renderer, so ordinary row features
and styling have one implementation. English and Chinese messages remain
aligned.

## Validation and acceptance

Test ranking, snapshot stability, date boundaries, filtering, identity,
pagination, first-category menu placement and empty fallback, priority collapse,
shared pinned collapse state and ordering, collapsed-row budget, normal/activity
header and row alignment, shared row actions and hover context, reset icon
visibility and keyboard access, observed
completion transitions, shared blue-dot/read behavior,
refresh reset, absence of read-state writes, stale async responses, partial
failures, archive scope and undo. Run a baseline against global `qwen`
and browser fixtures before implementing, then focused tests, browser E2E,
build, typecheck and bundle. Read the full diff in two clean audit passes and
perform an independent review. Test only isolated conversations; never archive
the user's real reference chats. There are no product decisions awaiting user
approval; implementation and verification findings may refine this document.

## Related work and visual evidence

Issue [#16020](https://github.com/QwenLM/qwen-code/issues/16020) tracks this
feature. Existing unread persistence work in
[#11451](https://github.com/QwenLM/qwen-code/issues/11451) and
[#12672](https://github.com/QwenLM/qwen-code/pull/12672) remains separate; this
feature does not resolve offline or reload continuity. The latter proposes
browser localStorage, not backend receipts, and overlapping sidebar changes
will need reconciliation if it lands first.

The screenshots below use synthetic daemon fixtures, not personal conversations.

![Ordinary sidebar](images/activity-view/normal.png)

![Activity sidebar](images/activity-view/activity.png)
