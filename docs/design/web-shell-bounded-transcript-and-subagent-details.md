# Web Shell Bounded Transcript and On-Demand Subagent Details

## Status

Proposed design. This document does not authorize implementation and does not
change the existing daemon protocol.

## Problem

The Web Shell currently bounds rendered DOM nodes with virtual scrolling, but
the full loaded transcript still participates in several client-side costs:

- transcript blocks and their indexes remain in React state;
- block-to-message conversion and derived views inspect the loaded history;
- streaming updates copy or rebuild structures whose cost grows with history;
- expanded or collapsed rows only change presentation, not retained data;
- subagent text and nested tool calls are folded into the parent agent tool as
  `subContent` and `subTools`, even when the agent row is collapsed.

This means DOM virtualization alone cannot make memory and update latency flat
for very long sessions. Subagents are especially expensive because one compact
row in the main transcript can retain a large, deeply nested execution trace.

## Goals

1. Keep Web Shell transcript memory and streaming update cost bounded as a
   session grows.
2. Keep only a window of complete main-agent turns near the viewport, plus the
   live tail and state required for active interactions.
3. Render subagents in the main transcript as compact status rows only.
4. Fetch and render a subagent's full transcript in the existing right-side
   panel when the user opens it.
5. Preserve stable scrolling, reconnect behavior, permissions, nested agents,
   and the ability to return to the live tail.
6. Preserve the complete authoritative transcript in daemon storage.

## Non-goals

- Deleting or compacting persisted session history.
- Changing what the model receives as conversation context.
- Making the browser hold a fake continuously measured scroll area for every
  message in an arbitrarily large session.
- Adding an IndexedDB transcript cache in the first version.
- Paginating an individual subagent detail transcript in the first version.
- Redesigning the existing artifact/review panel chrome.
- Optimizing Markdown parsing or syntax highlighting in this change.

## Current behavior

### Main transcript

The Web Shell requests bounded transcript pages and can prepend older history.
`MessageList` already preserves the scroll anchor while prepending and uses
`@tanstack/react-virtual` above a threshold. The transcript store nevertheless
has one logical block array. Its maximum-block trimming is a safety cap, not a
reloadable sliding window: it does not model gaps, independently cached pages,
or a newer-page cursor.

The public transcript API supports a cursor and `beforeRecordId`. This is
sufficient to walk toward older history from a known tail, but it is not a
complete contract for moving both directions after newer pages have been
evicted.

### Subagents

Persisted and live child events carry `parentToolCallId`. The transcript
normalizer retains those blocks, and `transcriptToMessages` attaches child text
and tools to the parent agent tool. `SubAgentPanel` then hides or displays this
already-materialized content. Collapsing an agent therefore saves some DOM and
Markdown work, but not transcript, message, index, or payload memory.

### Right-side panel

The existing artifact panel already provides the desired right-side layout:
resizing, tabs, close behavior, and per-session panel state. The implementation
should add a subagent tab kind and content renderer rather than create another
competing side panel.

## Design principles

### The daemon remains authoritative

The client may evict any completed historical page because the persisted
transcript remains available from the daemon. Eviction must never alter the
stored transcript or the model's context.

### Main and subagent transcripts are separate projections

The main transcript is not the complete execution trace. It is a projection
containing main-agent conversation blocks and compact root-subagent summaries.
Subagent detail is a separately addressable projection, keyed by the root agent
tool call ID.

### Evict complete semantic units

The client evicts completed main-agent turns and complete cached subagent
detail entries, not arbitrary individual blocks. Active tools, permissions,
agents, and the current turn are pinned until they reach a terminal state.

### Stable IDs, never array positions

Scroll anchors, expansion state, detail tabs, and page boundaries use persisted
record IDs, block IDs, tool call IDs, and turn IDs. An array index is not a
stable identity after a prepend, eviction, replay, or branch change.

## Proposed user experience

### Main transcript

- The newest window behaves as it does today and follows streaming output when
  the user is at the bottom.
- Scrolling near the top loads an older main-agent window.
- If the user remains in history, pages farthest from the viewport are evicted.
- New output continues in a separately pinned live tail. The UI shows a new
  activity count and a **Back to latest** action instead of moving the user's
  reading position.
- When a discontinuity exists below the current historical window, the bottom
  sentinel loads newer pages or jumps directly to the live tail.
- The application does not pretend that unloaded turns have exact pixel
  heights. Gaps are explicit loading boundaries.

### Subagents

The main transcript shows one compact row per root subagent:

- agent type and short task description;
- pending, running, completed, failed, or waiting-for-approval state;
- elapsed time;
- tool count and token count when available;
- a short failure or termination reason when applicable;
- an **Open details** affordance.

The main row does not render or retain child thinking, child messages, nested
tool output, or the full subagent result. Clicking it opens a subagent tab in
the right-side panel. The panel fetches the detail projection and renders:

- the subagent result;
- chronological child text and tool calls;
- nested subagents;
- loading, unavailable, and partial-history states;
- live updates while the detail tab is open.

The detail never expands inside the message flow. On a regular viewport wider
than 1000px the existing right panel remains docked and resizable. On narrower
viewports, and whenever the app is showing split sessions, the same panel and
tab content is hosted in a right-edge floating drawer so opening details does
not shrink or reflow the transcript panes.

Closing the tab releases an over-budget detailed transcript immediately;
smaller completed details may remain in the short bounded cache. Reopening it
fetches the complete detail again if it has been evicted.

## Data model

### Main transcript window

The Web Shell should replace the single conceptual historical block list with
a page table plus a small mutable live tail:

```ts
interface MainTranscriptWindow {
  pages: MainTranscriptPage[];
  liveTail: LiveTranscriptPage;
  olderBoundary?: TranscriptBoundary;
  newerBoundary?: TranscriptBoundary;
  viewportAnchor?: ScrollAnchor;
}

interface MainTranscriptPage {
  id: string;
  blocks: readonly DaemonTranscriptBlock[];
  firstRecordId: string;
  lastRecordId: string;
  byteSize: number;
  turnIds: readonly string[];
}

interface TranscriptBoundary {
  cursor?: string;
  recordId?: string;
  hasMore: boolean;
}

interface ScrollAnchor {
  blockId: string;
  offsetPx: number;
}
```

Historical pages are immutable. Only `liveTail` accepts streaming mutations.
When a turn finishes, its live blocks become immutable historical data. A live
delta must not copy every historical page.

Pages may be fetched in record-sized chunks, but eviction only removes a range
whose turns are complete within the client. A boundary turn split across two
responses remains pinned until its neighboring response is available.

### Subagent summary

The main projection needs a normalized, bounded summary instead of carrying a
large `rawOutput` object:

```ts
interface DaemonSubagentSummary {
  toolCallId: string;
  parentToolCallId?: string;
  subagentType?: string;
  description?: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  toolCount?: number;
  tokenCount?: number;
  terminationReason?: string;
  requiresAction?: boolean;
  hasDetails: boolean;
}
```

String fields must have daemon-enforced size limits. The summary must not carry
the prompt, result, child tool arguments, child tool output, or child text.
Root subagents appear in the main projection. Nested subagents appear only in
their root detail projection.

### Subagent detail cache

```ts
interface SubagentDetailEntry {
  sessionId: string;
  rootToolCallId: string;
  status: 'idle' | 'loading' | 'ready' | 'partial' | 'error';
  blocks: readonly DaemonTranscriptBlock[];
  byteSize: number;
  lastAccessedAt: number;
}
```

The cache is bounded by both entry count and bytes. Open tabs and active
subagents are pinned. Closed completed entries are least-recently-used eviction
candidates. Detail state must not be inserted back into the main transcript
window.

## Daemon and SDK protocol

### Main transcript projection

Extend transcript reads with an explicit projection:

```text
GET /session/:id/transcript?projection=main
GET /workspaces/:workspace/session/:id/transcript?projection=main
```

`projection=full` remains the compatibility default for existing consumers.
Web Shell opts into `projection=main`.

The main projection:

- includes top-level user, assistant, thought, tool, permission, status, and
  shell events;
- includes bounded root-subagent lifecycle summaries;
- excludes events whose `parentToolCallId` belongs to a subagent execution;
- strips large subagent result/detail fields from the root tool event;
- preserves source record IDs and ordering required for pagination.

Projection must happen before response serialization. Fetching full history and
discarding child events in React is not an acceptable lazy-loading design.
The page limit counts records visible in the selected projection, not raw
records inspected by the reader. The transcript index therefore needs a
projection-aware record sequence (or an equivalent skip index). Otherwise one
large subagent could produce a long run of empty `projection=main` pages.

Permission and other control-plane events are not hidden merely because their
originating tool belongs to a subagent. A pending child approval remains in the
session's bounded sidechannel state, and the root summary exposes a bounded
`requiresAction` indication. The main row can open the relevant detail tab;
existing global approval UI remains actionable without loading historical
child output.

### Bidirectional main pagination

Add a fresh-snapshot forward anchor alongside the existing backward anchor:

```ts
interface DaemonSessionTranscriptPageOptions {
  cursor?: string;
  beforeRecordId?: string;
  afterRecordId?: string;
  limit?: number;
  projection?: 'full' | 'main';
  clientId?: string;
}
```

Exactly one of `cursor`, `beforeRecordId`, or `afterRecordId` may be supplied.
The response should expose the first and last returned record IDs, and whether
older and newer records exist. Opaque cursors remain snapshot-bound; an anchor
request creates a fresh snapshot so the client can recover from an expired
cursor.

The live event stream covers records appended after the loaded tail. On
reconnect or cursor expiry, the Web Shell discards affected page cursors and
re-anchors by the last retained persisted record ID.

The projection is a response view only. It must not mutate the authoritative
event or remove the subagent result that core/model execution consumes.

### Subagent detail endpoint

Add workspace-scoped and legacy-primary routes:

```text
GET /session/:id/subagents/:toolCallId/transcript
GET /workspaces/:workspace/session/:id/subagents/:toolCallId/transcript
```

The workspace-scoped route must resolve the same selected runtime and trust
boundary as the corresponding session transcript route. It must never fall
back to the primary runtime when the workspace or session owner is ambiguous,
unavailable, draining, or removed.

The endpoint returns the root subagent's complete ordered descendant event set
in one response, including nested subagents. It has no page cursor in the first
version. Descendant membership is the transitive closure of
`parentToolCallId`, not a text match and not adjacency in the file. The daemon
transcript index should maintain the parent-to-child record relationship so
opening one old subagent does not linearly replay the entire session.

```ts
interface DaemonSubagentTranscript {
  v: 1;
  sessionId: string;
  rootToolCallId: string;
  events: DaemonEvent[];
  replayBoundary?: number;
  partial?: true;
  replayError?: string;
}
```

This deliberately differs from main-transcript pagination: users browse the
main history incrementally, while opening a subagent opts into loading that one
execution in full. A very large open subagent may therefore exceed the normal
detail-cache byte target. The open entry remains pinned for correctness and is
released when its tab closes instead of being partially truncated.

The response must distinguish:

- unknown tool call ID;
- a known root with no persisted details;
- partial/corrupt transcript detail;
- detail that was valid but became unavailable after transcript rewriting.

### Live detail

In the first implementation, the existing live session stream may continue to
carry child events, but the Web Shell routes them directly to an open detail
entry and drops them when no corresponding detail is open. They must never
enter the main window reducer. The detail snapshot response includes a replay
boundary so buffered live events can be merged without a race, duplicate, or
gap.

This first step removes the dominant React-state and retained-memory cost but
does not remove child-event network and JSON-decoding cost. If measurement
shows that active subagents still produce material transport overhead, add a
separate per-client detail subscription in a later protocol change. That
optimization is deliberately not required for the first version.

## Client rendering

### Main subagent row

`ToolLine` should render the summary row and call an injected
`onOpenSubagent(toolCallId)` handler. It must no longer mount `SubAgentPanel` in
the main transcript. Approval indicators for a child tool remain visible on
the root summary row; opening the detail panel reveals the approving tool.

The click behavior should open details, not toggle a large inline accordion.
The row can retain a small disclosure icon only if it clearly represents the
right panel. Existing inline expansion state for agent rows is removed from the
main transcript.

### Right panel integration

Add a `subagent` variant to the existing right-panel tab union. The tab stores
only session ID, root tool call ID, title, and the latest summary. Its content
component owns the detail fetch and uses the existing transcript conversion
and tool rendering primitives in detail mode.

Do not copy detail blocks into the artifact list and do not encode them into
the tab object. The tab is an identity and navigation record, not a data cache.

Opening the same subagent again focuses its existing tab. Switching sessions
uses the panel's current per-session state behavior. A tab restored for a
session refetches details if its cache entry is no longer present.

### Expansion state

Any expandable row inside subagent details is keyed by stable tool call or
block ID. Component-local expansion state may be lost when a detail cache entry
is evicted; this is acceptable for the first version and should be documented
as such. Main transcript turn-collapse state must remain independent from
subagent detail state.

## Memory policy

Use both item and byte budgets. A count-only limit is unsafe because one tool
result or Markdown block can be much larger than thousands of ordinary rows.

Initial defaults should be selected by benchmark rather than treated as API,
but the starting test configuration is:

- main historical window: 100 completed turns;
- minimum context around viewport: two fetched pages on each side;
- main normalized payload target: 16 MiB;
- closed subagent detail cache: at most three entries and 16 MiB total;
- active turn, active approvals, running tools, and open detail tabs: pinned.

When pinned content alone exceeds a budget, correctness wins: keep it, record a
diagnostic metric, and resume eviction after it becomes terminal. The UI must
not silently truncate an active tool or permission request.

## Scroll anchoring

Before a prepend, page removal, expansion, or detail-panel resize, record the
first visible stable block ID and its offset from the scroller top. After the
layout change, restore that block to the same offset. Cache measured heights by
block ID only as a rendering aid; correctness must not depend on an estimate
for an unloaded turn.

Eviction must not remove the page containing the anchor or the configured
neighboring pages. If the anchor record was invalidated by a branch rewrite,
fall back to the closest retained record and show a non-blocking history
refresh notice.

## Derived features and gaps

Several existing features assume that `messages` contains all loaded history.
They need explicit window semantics:

- session timeline lists loaded turns plus older/newer loading boundaries;
- scroll-to-message first checks the window, then requests a page containing
  the persisted record if a locator is available;
- Todo and plan floating state is maintained as a small session-level snapshot
  and is not recomputed only from the visible window;
- usage totals come from daemon session metadata or an accumulated summary,
  not from summing only visible messages;
- branch and rewind actions use daemon-owned record identities and can request
  the containing page before showing a target;
- search must either be explicitly limited to loaded content or use a daemon
  search/locator API; it must not imply that an unloaded result does not exist.

The first delivery may label timeline and search as “loaded messages” if a
server-side locator is deferred, but branch, rewind, approval, and active-task
correctness cannot be deferred.

## Failure handling

- A failed older/newer page request leaves the current window unchanged and
  exposes a retry sentinel.
- A failed subagent detail request leaves the compact main summary usable and
  shows retry in the right panel.
- Duplicate events are deduplicated by persisted record/event identity.
- Out-of-order live child events are buffered until their parent mapping is
  known, within a strict bound; overflow triggers a detail refetch.
- An expired snapshot cursor re-anchors by a retained record ID.
- If the daemon is offline, already-loaded windows remain readable; evicted
  pages and details are reported as temporarily unavailable.

## Delivery plan

### Phase 1: main/detail projection boundary

1. Add bounded subagent summary types and the `projection=main` transcript
   response.
2. Add the subagent detail route and transcript child index.
3. Split child events from the main reducer in Web Shell.
4. Replace inline `SubAgentPanel` expansion with the compact summary row.
5. Add the subagent tab to the existing right panel and load detail on demand.

This phase provides a meaningful memory improvement even before the main turn
window is fully sliding, because subagent traces no longer inflate the main
block and message graphs.

### Phase 2: bounded main window

1. Add forward anchoring and bidirectional page metadata.
2. Introduce immutable historical pages and a separate mutable live tail.
3. Evict complete turns by combined turn and byte budgets.
4. Add older/newer sentinels, detached-live status, and jump-to-latest.
5. Make timeline, Todo/plan, jump, branch, and rewind gap-aware.

### Phase 3: measured follow-ups

- Add a filtered live subagent subscription only if transport profiling shows
  material remaining cost.
- Add server-side search/locate-by-message if unloaded-history navigation is a
  frequent workflow.
- Tune budgets from real heap and interaction measurements.

## Verification

### Correctness tests

- The main projection contains one bounded summary for each root subagent and
  no descendant text, tool arguments, output, or nested tool blocks.
- Opening detail returns the exact descendant tree for the selected root and
  never includes a concurrent sibling subagent.
- Nested subagents preserve parent-child order and identity.
- Pending child approval pins the root summary and remains actionable.
- Snapshot plus buffered live events has no missing or duplicate child event.
- An evicted completed turn reloads with identical stable IDs and content.
- No page eviction splits an active or incomplete turn.
- Scrolling older and newer across repeated eviction cycles preserves order.
- Reconnect, branch rewrite, transcript gaps, and expired cursors recover using
  their declared behavior.
- Workspace-scoped detail requests never cross into another runtime.

### UI tests

- Agent rows never mount detailed Markdown or nested tool rows in the main
  transcript.
- Clicking an agent opens or focuses the correct right-panel tab.
- Loading, partial, error, retry, running, completed, and failed states render
  correctly.
- Reading old history while new output streams does not move the viewport.
- Prepend, append, eviction, turn expansion, and panel resize preserve the
  visible anchor within two pixels in deterministic DOM tests.
- Closing detail releases unpinned detail state according to the cache policy.

### Performance tests

Create deterministic fixtures containing ordinary long conversations, a few
very large tool results, many small subagents, and one deeply nested large
subagent. Measure at 1,000, 10,000, 50,000, and 200,000 persisted blocks:

- retained JavaScript heap after forced GC;
- main transcript block/message counts;
- DOM node count;
- p50 and p95 live-delta reducer time;
- React commit duration while streaming;
- time to open cached and uncached subagent details;
- bytes transferred for main transcript pages;
- scroll-anchor error and long tasks.

Acceptance criteria:

- main Web Shell heap reaches a stable plateau once the configured window is
  full, excluding explicitly pinned active content;
- main transcript retained block and DOM counts stay within configured bounds;
- live-delta reducer p95 does not grow materially with persisted session size;
- main projection payload does not grow with hidden subagent detail size;
- opening detail cost scales with the selected subagent, not the full session;
- there are no duplicate, missing, cross-session, or cross-subagent records.

## Risks and mitigations

| Risk                                            | Mitigation                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A collapsed row still retains full data         | Project and filter on the daemon before serialization; never treat CSS collapse as lazy loading.  |
| Child approval disappears from main UI          | Pin active child state and reflect it in the root summary.                                        |
| Detail snapshot races live events               | Return a replay boundary and merge buffered events by stable identity.                            |
| Newer history cannot be restored after eviction | Add `afterRecordId` and fresh-snapshot anchoring before enabling bidirectional eviction.          |
| Scroll jumps after page removal                 | Preserve a stable block anchor and never evict its neighboring pages.                             |
| Nested agent records leak into a sibling        | Build descendant closure from indexed `parentToolCallId` relationships and test concurrent roots. |
| Byte budget is exceeded by active work          | Pin for correctness, emit diagnostics, and evict after completion.                                |
| Existing SDK consumers change behavior          | Keep `projection=full` as the compatibility default; Web Shell opts in.                           |
| Right panel becomes two competing systems       | Extend the existing tab union and panel chrome rather than add another side panel.                |

## Alternatives considered

### Only virtualize DOM rows

Rejected as the long-session solution. It bounds mounted DOM but retains the
full transcript, derived messages, subagent trees, and indexes.

### Keep inline subagent expansion but render lazily

Useful only as a small rendering optimization. If `subContent` and `subTools`
remain attached to the main message graph, memory and update costs remain.

### Fetch the full transcript and filter subagents in the browser

Rejected. It pays the network, parsing, normalization, and transient-memory
cost that on-demand detail is intended to avoid.

### Create a second dedicated side panel

Rejected. The existing right-side tabbed panel already supplies the necessary
layout and session behavior.

## Decision summary

The target architecture combines two independent bounds:

1. a page-based, bidirectional main-agent transcript window with an isolated
   live tail; and
2. a summary-only main representation of subagents whose complete descendant
   transcripts are fetched into a bounded right-panel cache on demand.

Implement the subagent projection boundary first, then the general sliding
window. This order removes one of the largest and least splittable sources of
main-transcript growth while establishing the projection and cache boundaries
needed by the complete long-session design.
