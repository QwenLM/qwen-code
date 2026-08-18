# Bounded Memory Recall Candidates

## Problem

The project and user memory scanners enumerate, read, and parse every topic,
then return only the 200 most recent documents. Recall uses those shared scanner
APIs, so an older relevant document outside either 200-document window cannot
reach the heuristic or model selector even though the expensive scan work has
already happened. The truncation key is recency, applied per scope and before
anything has looked at the query.

The same capped APIs are also used by Forget, Indexer, Status, and Extraction.
Removing their limit globally would widen unrelated behavior.

## Decision

Keep the existing scanner APIs and their 200-document limit unchanged. Add
explicit all-topic variants used only by recall.

Recall ranks the combined project and user pool before model selection:

- retain up to 180 documents with a lexical match using the existing scorer;
- fill the remaining candidate slots by recency, preserving at least 20 recent
  opportunities when enough lexical matches exist;
- interleave recent opportunities with lexical candidates so the manifest byte
  budget cannot systematically exclude the entire recent reserve;
- send at most 200 candidates to the model selector;
- append manifest entries only while their cumulative UTF-8 size remains at or
  below 25,000 bytes;
- validate selector output only against documents actually present in that
  bounded manifest.

The heuristic fallback continues to score the complete recall pool and still
returns at most five documents. Existing body and prompt limits remain
unchanged.

### This is a change of truncation key, not a lifted ceiling

"Removes the 200-document cap" is the wrong summary, and reviewers should
read the effect per pool size rather than as a uniform widening. What the
change actually does is replace a per-scope, query-blind recency truncation
with a global, query-aware one:

- **Pool at or under 200 documents.** No document is excluded by count under
  either design. The new 25,000-byte manifest budget is a ceiling the old
  path did not have, so a pool with long descriptions can now be truncated
  where previously it was not. The interleaving above exists so that
  truncation cannot fall entirely on the recent reserve.
- **Pool between 200 and 400 documents, neither scope over 200.** The old
  path sent every document to the selector — up to 200 project plus 200 user.
  The new path sends at most 200 in total, so **fewer** documents reach the
  model. The candidates that survive are chosen by lexical relevance plus a
  recency reserve rather than by recency alone, which is the intended trade,
  but the raw count goes down.
- **Either scope over 200 documents.** This is the case the change is for.
  An old, lexically matching document that the recency cap made permanently
  invisible can now be selected.

The manifest byte budget also packs rather than prefixes: a document whose
line does not fit is skipped and later, shorter lines are still considered.
A long-description document can therefore be dropped while a lower-ranked one
is kept.

Forget, Indexer, Status, and Extraction keep the capped scanner. That preserves
their current behavior but means an older document can become recallable before
it becomes manageable by those non-recall flows.

## Failure and compatibility boundaries

Project scanning remains required. User scanning remains best-effort. Invalid
or unreadable files keep the existing skip behavior. Empty candidate manifests
return no model selection rather than sending an unbounded request.

There is no public setting, persistent index, new dependency, provider API, or
second selection pathway. Each recall enumerates, reads, and parses the full
project and user memory trees once, then performs O(n) local ranking and
active-tool filtering over the parsed documents. The deterministic fast path
described in `2026-08-08-native-memory-recall-reliability.md` reuses the
candidates produced by that single pass, so it adds no scan, no ranking work,
and no state machine — only an earlier delivery point for results already
computed. The model candidate count and manifest are
bounded, but the local I/O and filtering work grow with the memory tree; a
persistent catalog requires separate measurement and evidence.

## Verification

- A deliberately old relevant topic beyond the regular 200-document result is
  recalled from a real temporary memory tree.
- The regular scanner still returns 200 documents and omits that topic.
- The model candidate set contains the lexical target and recent reserve while
  remaining at 200 documents.
- A manifest built from large multibyte descriptions stays within 25,000 UTF-8
  bytes.
- A real temporary memory-tree integration test verifies overflow-topic recall;
  client tests independently verify bounded initial waiting and later
  ToolResult delivery.
