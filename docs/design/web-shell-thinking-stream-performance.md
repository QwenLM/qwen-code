# Web Shell thinking stream performance

## Problem

Streaming thought deltas update the collapsed "Thinking" row without showing
the thought body, but each visible transcript tick still projects the complete
transcript. MessageList also limits its existing tail-only cache to assistant
messages, so thinking streams repeat compact-message merging and display-item
derivation. Both costs grow with retained history and compete with the
paint-bound thinking shimmer on the browser main thread.

## Design

First, extend MessageList's committed tail cache to thinking messages. In
non-compact mode the new thinking message replaces the previous tail directly.
In compact mode the streaming thought is represented by the final synthetic
tool summary, so update only that summary and its final thought while preserving
all earlier message, tool, and display-item identities. Any dependency or
structural change uses the complete derivation path.

Second, expose an optional transcript block change summary from the SDK store.
The summary identifies its source store and advances a barrier for every change
except a validated append to the active top-level assistant or thought block.
Web Shell carries the summary with the throttled block snapshot. Equal barriers
from the same source prove that skipped revisions were pure tail appends, so the
message hook can append only the new text to its committed tail message instead
of invoking the complete projector.

Reconciliation-derived keys and resolved background-agent history use the same
barrier, connection session, and resolution snapshot identities. They are
reused only for a proven tail append; tool, permission, notification, history,
reset, session, metadata, and terminal changes rebuild through the existing
paths.

Third, top-level assistant and thought deltas share reducer side indexes that
they cannot mutate, including historical tool, permission, parent, and progress
indexes. The normal cloning path remains in place for nested deltas, mixed
batches, and any update that can cross the effective transcript block limit.

Finally, a virtualized MessageList drives bottom-follow and overflow reporting
from its measured total height and item count instead of message identity.
Content-only updates with unchanged geometry therefore perform no scroll
layout reads or writes. Non-virtual transcripts keep the existing per-message
follow behavior because their row height is not tracked by the virtualizer.

## Compatibility

The store method is optional. Older store implementations retain the existing
reference-scan fallback. There are no daemon protocol, persistence, route, or
animation changes.

## Verification

- Compare incremental compact and non-compact thinking results with complete
  derivation.
- Prove pure assistant and thought appends preserve the store barrier while
  mixed, structural, terminal, reset, and bounded-text changes advance it.
- Prove pure tail ticks skip the complete projector and reconciliation scans.
- Prove top-level text deltas reuse populated side indexes without sharing
  across nested or transcript-trimming paths.
- Prove content-only virtual transcript updates perform no scroll geometry
  reads or writes while the streamed tail still updates.
- Extend the deterministic browser performance scenario to stream thought
  events and record animation-frame gaps.
