# Indexed reads of managed authority history

[English](2026-10-20-managed-authority-history-lookups.md) | [简体中文](2026-10-20-managed-authority-history-lookups.zh-CN.md)

## Problem and scope

This independent slice of #13184 reduces repeated history scans. The authority
currently filters every retained event for a sequence range, visits the prefix
again for each later page, and scans backward for the latest event of a kind.
Repeated projection pages therefore revisit already consumed history; an absent
or infrequent kind also costs the whole retained history on each lookup.

This change preserves every event, command identity, receipt, recovery fact, and
read result. It does not complete authority memory limits, native journal
snapshot/compaction, terminal-identity retention, or the separate activation/inbox
snapshot slice. No retention floor or TTL is introduced.

## Current invariants and consumers

The journal scanner requires committed event sequences to start at 1 and remain
contiguous. Each live transaction validates that it continues the committed
sequence before append; only committed transactions enter the authority's event
array. An uncertain append remains invisible until its outcome is known.

Paged projection and Hosted transcript/event reads use `readEvents`; recorder
context summaries, Hosted execution and recovery use `eventsInSequenceRange`;
Hook activation and original-receipt checkpoint observation also use
`lastEventOfKind`. These synchronous APIs and their output objects stay the same.
The existing receipt-by-execution-call index stays first-receipt-wins.

`context.compacted` covers model-history summaries. Its coverage is independent
of a native journal replay floor and is not used to skip retained events here.

## Proposed changes

- Keep one latest committed event per validated event kind. Seed this finite map
  while opening the committed journal, then update it in the existing committed
  event indexing path shared by ordinary appends and settled uncertain appends.
  It holds at most one reference per member of the closed event-kind schema.
- Convert inclusive sequence endpoints to event-array offsets and copy only the
  requested range. Clamp endpoints to the retained array, preserve fractional
  endpoint behavior, and return an empty range for unordered/NaN bounds.
- Start a paged read at the sequence-addressed array offset instead of walking
  the already-consumed prefix. Keep the existing limit calculation, positive
  limit refusal, iteration, and stopping condition, including existing numeric
  edge behavior. This avoids changing the caller contract to gain performance.

The existing `limit: 1.5` and `limit: NaN` cases still read the remaining tail,
while `afterSequence: NaN` starts at the first event. These compatibility cases
are covered explicitly without changing higher-level cursor validation.

A latest-kind read becomes O(1), and a range/page becomes O(number returned)
without inspecting the earlier prefix. The history array and existing historical
indexes still grow; the new map itself is bounded by schema kinds. No event
references are cloned or replaced in returned arrays.

## Decisions and boundaries

Direct offsets use the current verified 1-based contiguous-history invariant.
Enabling physical event eviction later requires a durable historical reader and
new offset basis; it must not silently keep this addressing after removing a
prefix. This change neither adds that reader nor claims compaction is enabled.

The index updates only when a transaction is committed or proven landed. Failed,
rejected, or unresolved attempts must not become the latest event. Existing
idempotent command replays must not advance the index.

No new options, public fields, endpoints, generated contracts, or consumer
migrations are needed. A new historical-reader contract would be a separate
change with its own persistence and recovery verification.

## Validation

1. Reproduce prefix visits with a real in-memory journal and the authority's
   validated open/commit paths. Count numeric event-array reads rather than
   asserting a wall-clock threshold. A bounded tail page/range must inspect only
   its returned events, and a missing-kind lookup must not visit history.
2. Verify empty, inclusive, reversed, clipped, fractional, and non-finite numeric
   ranges and pages, plus default/maximum limits and existing limit errors.
3. Compare latest-kind answers before and after new commits, command retries,
   reopen, rejected append and uncertain-append settlement.
4. Run authority, recorder, projection, Hook, and original-receipt consumer tests,
   build, typecheck, bundle, formatting/reference checks, two self-audit passes,
   and independent verification/review.

## Acceptance and remaining work

Returned sequences, event identities, first-receipt semantics, command replay,
recovery and all existing tests remain unchanged. Measured visits for a bounded
page/range are independent of its prefix length. All journal bytes and retained
history remain available. The remaining #13184 authority memory and native
snapshot/compaction requirements remain explicitly open.
