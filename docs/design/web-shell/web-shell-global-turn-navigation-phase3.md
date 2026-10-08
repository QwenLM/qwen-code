# Continuous scrolling with global turn navigation

## Problem and requested behavior

Phase 2B replaces ordinary upward history loading with an explicit historical snapshot toolbar. The user requests the original continuous scrolling experience plus a left navigation rail covering every persisted turn, with distant transcript content loaded on demand. This supersedes the user-facing snapshot controls in the Phase 2B design; its bounded storage and isolated materialization remain useful internally.

## Design

The default TranscriptViewport passes the existing live MessageList pagination props through unchanged. It keeps the original follow-bottom, upward loading, error handling, and jump-to-latest behavior. Capability detection must not disable ordinary history loading.

A global turn rail uses the navigation store's effective turn count and lazily loads metadata for visible ordinal slots. Its scrollable list renders a bounded number of buttons, including placeholders for unloaded metadata, and supports keyboard navigation. Existing loaded-only navigation remains the fallback for daemons without turn indexes. The rail is hidden in narrow layouts and existing split panes, matching the current compact-layout policy.

Selecting a loaded turn maps its source block ID to the current message ID and uses MessageList's existing scroll and highlight behavior. Selecting a distant turn calls locateOrdinal, then displays the admitted bounded range in the same message area. User input, another selection, return-to-latest, and session or owner changes invalidate pending navigation. Historical content remains isolated from the live transcript and control consumers. No snapshot title or page navigation toolbar is shown.

At the top and bottom of a historical range, scrolling loads the adjacent boundary while preserving the visible block and tool-call anchor. The existing jump-to-latest action remains available throughout historical reading. Reaching a live boundary returns to live content using an overlapping reading anchor where available. Errors retain the current content and expose a retry action rather than silently skipping gaps.

## Components and scope

`useTranscriptViewport` owns local selection intent, range pinning, loading and pending scroll targets. `TranscriptViewport` integrates the rail, restores anchors and observes historical scroll boundaries. A dedicated global rail component reuses shared buttons and theme tokens and bounds rendered ordinal slots. The navigation store adds only internal cancellation support if needed; no daemon routes, persistence format, SDK protocol, or reducer semantics change. Focused component tests and browser tests cover navigation and the restored ordinary scroll path.

## Decisions and limitations

All-history means all ordinal slots, not only cached index pages. The index and transcript caches keep their existing budgets. A distant jump does not load intervening history or replace live reducer state. Split panes retain their existing compact policy. The user explicitly chose all historical turns with content loaded on demand; there are no outstanding scope questions.

## Compact rail presentation

The rail uses the original short ticks and their hover expansion instead of a permanent text list. A shared portal-aware tooltip shows the indexed prompt label and optional detail on hover or keyboard focus. The rail is 64px wide and vertically centered; all ordinal slots remain virtually scrollable with 16px spacing. Hover reads existing metadata only and does not fetch transcript content. Clicking still locates distant content on demand.
