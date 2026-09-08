# Web Shell session overview

## Problem

The overview ranks blocked sessions first, but permission requests, questions,
and running turns share the same spinner. Session IDs occupy a full column,
while long titles compete with workspace, branch, and action columns. Clicking
a title opens the session; clicking elsewhere in the same row selects it.
The sidebar already offers a richer session details popover, but the overview
uses only its Git-specific variant.

## Design

- Keep the existing session catalog, live-state subscriptions, workspace
  identities, pagination, and mutation capability checks.
- Use a two-line session cell: title first, then workspace, branch, and PR.
  Move the complete ID and path into the shared details popover.
- Show distinct permission, question, running, and idle states in the table.
  Keep a compact active/attention cue beside the pinned title so narrow
  layouts do not hide the row's state behind the pinned actions.
  Add an all/needs-attention/running/idle filter and keep workspace selection
  visible in the toolbar. Search titles, IDs, branches, and PR numbers.
- Reuse the sidebar details popover on title hover. Provide an explicit
  details button for keyboard and touch users. Keep PR/issue links and ID
  copying inside the popover, with events isolated from row navigation.
  Only one overview details popover is open at a time. Long values wrap in
  an internally scrolling surface; keyboard focus stays visible when it opens.
  When hover replaces focused details, move focus to the incoming title
  before opening its preview. Ordinary hover preserves an external input's
  focus, and Tab continues from the row after the preview closes.
- Make the popover status agree with the overview's derived live state,
  including older daemons that provide pending approvals via status reports.
- Open a session when its row or title is clicked. Checkboxes exclusively
  control selection; existing rename/export/archive/delete controls keep their
  behavior. Show batch actions only when a selection exists.
  Dragging to select text does not navigate. Clicking a plain cell during an
  inline rename preserves the draft; Enter saves and Escape cancels.
  Starting rename closes details. If the edited row leaves the visible page,
  discard the hidden draft so it cannot disable navigation or return later.
  Preserve row state across the temporary empty page while a shrinking catalog
  clamps pagination, then reconcile against the final visible identities.
- Keep the existing shared table and portal primitives. Popovers must stay
  within the Web Shell boundary and preserve React 18 ref forwarding.

## Scope

The implementation stays in the Web Shell package: the overview, its styles
and tests, the shared session details popover and tests, and English/Chinese
messages. No daemon routes, SDK fields, permission changes, new dependencies,
or cross-package refactors are required. Idle does not imply task completion.

## Verification

Validate title/row navigation versus selection, search and filter reset rules,
status priority, full details, keyboard entry and Escape dismissal, ID copy,
portal event propagation, and existing cross-workspace mutation restrictions.
Run focused unit tests, the build/typecheck/bundle workflow, and independent
browser or test-script verification. Record baseline and post-change evidence
under `.qwen/e2e-tests/`.

## Open questions

None. The accepted prototype establishes the first iteration; archived-session
browsing and changes to mutation semantics remain outside this PR.
