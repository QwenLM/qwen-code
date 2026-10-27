# Session tree for derived sub-sessions in the Web Shell sidebar

[English](web-shell-sidebar-session-tree.md) | [简体中文](web-shell-sidebar-session-tree.zh-CN.md)

## Problem and current state

A session can spawn derived sessions through `create_sub_session` (the `agent`
tool's background path, side tasks, isolated scheduled-task dispatch). Each
derived session is a full top-level session: it persists its own transcript,
appears in the daemon session list, and carries its spawner's id in
`parentSessionId`. Nesting is capped at one level, so the lineage is always a
two-level tree.

The sidebar does not render that lineage. Three surfaces behave differently:

| Surface                   | Derived sessions | Shape                                                     |
| ------------------------- | ---------------- | --------------------------------------------------------- |
| Projects / workspace list | shown            | Flat rows interleaved with their parents                  |
| Organized group view      | shown            | Flat rows, `groupId: null` lands them in Ungrouped        |
| Recent sessions           | hidden           | `sortRecentSessions` skips any row with `parentSessionId` |

Measurement against a running daemon (`/Users/wenshao/git/qwen-code`, 396
persisted sessions) shows one parent with eight derived sessions
(`🧵 codex-tools`, `🧵 codex-ide-research`, ...) rendered as eight sibling rows.
The parent label gives no hint that these rows are its children, and a burst of
derived sessions pushes unrelated sessions out of the five-row preview
(`SIDEBAR_SESSION_PREVIEW_LIMIT`).

## Goals

- Render derived sessions under their parent in the workspace list, one
  indentation level, collapsed by default.
- Keep the parent row's own affordances (open, rename, pin, archive, delete)
  unchanged.
- Make collapsed children stop consuming the ten-row preview budget.

## Scope boundaries

In scope: every session list the sidebar renders — the primary workspace list
and the grouped views, which `WebShellSidebar` renders itself, plus the secondary
workspace lists `WorkspaceSection` renders, including their organized group
sections (Ungrouped included) and channel groups.

Out of scope: the Recent sessions section (it deliberately excludes derived
sessions), the Pinned section (a pinned row is an independent reference, not a
tree node), the Archived section, and the standalone-session list. None of them
gains a tree in this change; derived sessions keep their current treatment
there. No daemon, SDK, storage, or protocol change is required: the list
response already carries `parentSessionId`, and the parent filter
(`?parentSessionId=`) is not used by this design.

## Proposed solution

Build the tree in the render layer, from the page the sidebar already holds.

A new pure module `sessionTree.ts` turns a page's session array plus the set of
expanded parent ids into a render sequence:

- A row with no `parentSessionId` is a root at depth 0.
- A row whose `parentSessionId` matches a root in the same page becomes a child
  at depth 1. Children appear only when the parent is expanded.
- Depth 1 is the maximum; a nested parent id cannot occur because the daemon
  rejects nested spawns.
- An ordering rule keeps each child directly after its parent, preserving the
  activity order of the roots.

The parent row gains a chevron whose accessible label carries the number of
children known in the current page. Clicking it toggles that parent only; the
state is stored per workspace and parent session id, so it survives re-renders
and reloads.

Truncation and counting follow the tree, not the raw page: the preview limit and
each group header's count apply to rendered rows, so a collapsed parent counts as
one row and its hidden children count as zero.

Two cases fall back to the current flat behavior:

- When the parent is not in the loaded page, its children have no anchor. In the
  default list they are hidden, matching the Recent section's existing rule and
  keeping unanchored derived rows out of the main list. During a search they
  stay visible as flat rows, because hiding them would make a content match
  unreachable.
- A child whose parent is filtered out by a group's membership (the two landed
  in different groups) is rendered flat inside the group that carries it.
- A child whose parent moved to the Pinned section stays flat in this list: the
  project list does not render that parent row, so nesting would hide the child
  behind a row that lives elsewhere.

Searching expands the matched parents: when a child matches and its parent is in
the filtered result, the parent's children are shown regardless of the stored
toggle, so a matched row is never hidden behind a collapsed parent.

## Design decisions and rationale

**Render-layer tree, not a daemon change.** The page already carries the lineage
field and the daemon's list contract exposes it on every path. Adding a server
aggregate would duplicate paging, sorting, and merge-live rules for a purely
visual grouping.

**Page-scoped tree rather than on-demand child fetches.** Derived sessions are
typically newer than their spawner, so the parent is usually inside the loaded
preview. A fetch per parent would add one request per row on a list that polls
every ten seconds. The cost of the page-scoped choice is the unanchored case
above, which the fallback rules make explicit.

**One level, because the daemon enforces one level.** `create-sub-session`
rejects a spawn whose caller already has a parent ("nesting is capped at one
level"), so no recursive rendering path is needed.

**Collapsed by default.** Derived sessions arrive in bursts (eight in the
measured case). Expanding by default would recreate today's problem in
indented form.

## Files affected

- `packages/web-shell/client/components/sidebar/sessionTree.ts` (new) and its
  collocated test: tree building, expansion persistence, search overrides.
- `packages/web-shell/client/components/sidebar/useSessionTree.ts` (new): the
  expansion state, persistence, and search overrides both list renderers share.
- `packages/web-shell/client/components/sidebar/WorkspaceSection.tsx`: build the
  sequence for each secondary-workspace render path, pass tree options to
  `renderSession`, count rendered rows.
- `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`: build the
  sequence for the primary workspace's flat list, grouped sections, and channel
  sections; accept the tree option in `renderSessionRow`, render the chevron and
  the indentation.
- `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css`:
  chevron slot and child indentation.
- `packages/web-shell/client/i18n.tsx`: the chevron's accessible label in both
  languages.

## Risks and constraints

- The children count on a parent reflects only the loaded page. A parent with
  older parents outside the page shows a smaller number than the transcript
  holds. Acceptable: the count labels what the row expands.
- `SessionGroupSection` truncates its children by `Children.toArray`, so a
  collapsed tree must not emit hidden children as elements. This design builds
  only rendered rows.
- `view=organized` rejects `parentSessionId` (HTTP 400), which is why the design
  never fetches children separately.
- Archiving a parent does not imply archiving its children. Because the active
  list no longer carries the archived parent, its children have no anchor there
  and are hidden by the default rule; they remain visible, flat, in the
  Archived section.
- An untrusted secondary workspace keeps its read-only flat list: those rows
  render through a separate path with no hover actions and no chevron.

## Validation plan

Focused unit tests for the pure module cover: flat input without lineage,
parent-child grouping, expansion and collapse, unanchored children in the
default list, unanchored children under search, group-membership splits, and
row-count effects on truncation. Component tests cover the rendered chevron,
indentation, the accessible label, and that the parent's own actions still fire.

Browser verification against a local `qwen serve` uses the measured workspace:
before, eight `🧵 ...` rows sit beside their parent; after, the parent shows one
chevron with eight children collapsed, and expanding reveals the eight indented
rows. The E2E plan and results live under `.qwen/e2e-tests/`.

## Acceptance criteria

- Derived sessions never render as siblings of their parent in the workspace
  list, the organized groups, or channel groups.
- A collapsed parent occupies one preview slot; descendants do not consume the
  preview limit.
- Expanding a parent reveals exactly the children present in the loaded page,
  indented one level, in activity order.
- A content search that matches only a child still shows that child.
- The Recent, Pinned, and Archived sections keep their current behavior.

## Open questions

None blocking. A later change could replace the page-scoped children count with
an exact count if the daemon ever exposes a child total per summary.
