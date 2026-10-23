# Managed incremental message projection

[简体中文](managed-incremental-message-projection.zh-CN.md)

## Problem

`ManagedSessionsPage` currently rebuilds every rendered message from the full
Managed session event list whenever the list changes. A live session therefore
re-folds its retained history for each appended event, even though the event
merge path already distinguishes a strictly newer append from a snapshot or
overlap.

## Current state

`managedEventsToMessages(events, truncatedLabel)` is the stateless projection
API used by the Managed WebShell and its tests. `mergeManagedEvents` returns a
new sorted, deduplicated array and has a fast path for a strictly newer
ascending tail. The projection fold contains behavior for Turn boundaries,
late tool results, runtime failures, cancellation, and authoritative result
revisions that must remain unchanged.

## Goals

- Keep the existing stateless API and its event-by-event fold semantics.
- Add a page-held projector that folds only a proven new suffix of an append
  chain.
- Keep returned message snapshots independent from later mutations of the
  projector's working state.
- Rebuild when the event chain, event label, or retained snapshot identity is
  no longer proven compatible.

## Scope boundaries

This change is limited to:

- `packages/web-shell/client/components/managed/managed-session-messages.ts`
- `packages/web-shell/client/components/managed/ManagedSessionsPage.tsx`
- the existing `managed-session-messages.test.ts` regression coverage
- this English and Chinese design pair

It does not add package dependencies, public wire fields, configuration,
server behavior, or Core behavior. Storage compression and quota policy,
action scanning, and malformed-row handling remain separate #13184 work.

## Proposed solution

`mergeManagedEvents` records an opaque epoch token for each returned array in a
module-local `WeakMap`. A strictly newer append, including an empty incoming
copy, carries the current epoch once. The parent array's metadata is consumed
by that child, so a second sibling append from the same parent receives a new
epoch and rebuilds instead of reusing the first branch. Snapshot, overlap,
replacement, sorting, and old-page prepend paths receive a fresh epoch. The
metadata stores only the token; it does not retain a predecessor array or an
event history.

The new `createManagedMessageProjector()` owns the same fold state used by the
stateless function. It compares the incoming array's epoch, the number of
events already folded, and `truncatedLabel`. A matching chain folds only the
new suffix. Any mismatch reconstructs the fold from the complete event list.
The fold remains in one internal helper so the stateless API and the projector
cannot drift apart.

Each result is a message snapshot: messages are shallow-copied and each
`tool_group` tool is shallow-copied. Nested payloads remain shared because the
fold replaces those fields rather than mutating their nested values in place.

`ManagedSessionsPage` creates one projector per provider/session pair and
memoizes its result by the projector, current detail events, and translated
truncation label. It does not create a projector during every render or invoke
it again for an unrelated render.

## Design decisions and rationale

### Epochs instead of boundary comparisons

First and last event IDs, array length, or object identity at only one boundary
cannot prove that a snapshot preserved its prefix. A replacement can preserve
the same first and last IDs and reuse the last event object before a later
append. Epoch propagation makes that replacement a new chain and forces a
correct rebuild. Consuming a parent token also makes sibling append branches
independent: only the first child may inherit the parent's epoch.

### One fold implementation

The existing fold is moved behind a small append helper. The stateless API
creates a fresh state and applies all events; the page projector applies all
events on a rebuild and only the suffix on a verified append. This preserves
special handling for cross-Turn boundaries, late `tool_result_updated`,
`runtime_failed` and cancellation booking, and authoritative projection
revisions.

### Bounded snapshot copying

Copying the top-level messages and the tools in a tool group prevents a later
append from changing a previously returned assistant or tool snapshot. A
general copy-on-write framework would add complexity without protecting any
additional fields used by this fold.

## Constraints and risks

The full retained event history remains in WebShell state. After a valid chain
is established, the projector folds only the new events, but it retains the
existing per-event scan costs: a boundary event may run `settle` and
`stopStreaming` over current messages, a terminal event may walk current tools,
and each returned snapshot copies the currently rendered messages and tools.
Consequently, a batch of `k` such events can still cost `O(k*M)` for current
message/tool state `M`, plus snapshot copying; this is not an `O(k+M)` or
overall `O(1)` guarantee. The change also does not solve storage growth.

The epoch map is process-local metadata. Raw arrays that did not come from the
merge helper intentionally rebuild because their append lineage is unproven.
Changing the translated truncation label also rebuilds so previously rendered
truncation text is correct.

## Validation plan

Retain the existing stateless projection tests and add focused coverage for:

1. a strictly newer append reading only the new event payload;
2. snapshots whose assistant and tool results are not changed by a later
   append;
3. replacement, overlap, old-page prepend, and append-after-replacement
   invalidation; and
4. truncation-label changes producing the same result as a fresh stateless
   projection.

The package's existing WebShell test and typecheck commands remain the final
verification gates. They are pending in this implementation worktree.

## Acceptance criteria

- `managedEventsToMessages` preserves its current output for all existing
  fixtures.
- A projector folds a suffix only when the merge epoch, processed length, and
  label all match.
- A parent array's append epoch is inherited by at most one child; sibling
  branches rebuild independently.
- Snapshot, overlap, replacement, old-page prepend, and label changes rebuild
  with stateless-equivalent output.
- Previously returned assistant and tool messages remain unchanged after a
  later append.
- The page holds a stable projector for each provider/session pair.
- The page memoizes projector output by its event list and translated label.
- No server, Core, wire, configuration, dependency, or unrelated #13184
  behavior changes are introduced.

## Open questions

None for item 5. Event-retention compression and quota, action scanning, and
bad-row policy require separate design and acceptance decisions.
