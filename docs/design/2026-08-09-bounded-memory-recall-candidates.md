# Bounded Memory Recall Candidates

## Problem

The project and user memory scanners enumerate, read, and parse every topic,
then return only the 200 most recent documents. Recall uses those shared scanner
APIs, so an older relevant document outside either 200-document window cannot
reach the heuristic or model selector even though the expensive scan work has
already happened.

The same capped APIs are also used by Forget, Indexer, Status, and Extraction.
Removing their limit globally would widen unrelated behavior.

## Decision

Keep the existing scanner APIs and their 200-document limit unchanged. Add
explicit all-topic variants used only by recall.

Recall ranks the combined project and user pool before model selection:

- retain up to 180 documents with a lexical match using the existing scorer;
- fill the remaining candidate slots by recency, preserving at least 20 recent
  opportunities when enough lexical matches exist;
- send at most 200 candidates to the model selector;
- append manifest entries only while their cumulative UTF-8 size remains at or
  below 25,000 bytes;
- validate selector output only against documents actually present in that
  bounded manifest.

The heuristic fallback continues to score the complete recall pool and still
returns at most five documents. Existing body and prompt limits remain
unchanged.

## Failure and compatibility boundaries

Project scanning remains required. User scanning remains best-effort. Invalid
or unreadable files keep the existing skip behavior. Empty candidate manifests
return no model selection rather than sending an unbounded request.

There is no public setting, persistent index, new dependency, provider API, or
Fast/Refined state machine. Recall still performs an O(n) local pass over the
already parsed documents; a persistent catalog requires separate measurement
and evidence.

## Verification

- A deliberately old relevant topic beyond the regular 200-document result is
  recalled from a real temporary memory tree.
- The regular scanner still returns 200 documents and omits that topic.
- The model candidate set contains the lexical target and recent reserve while
  remaining at 200 documents.
- A manifest built from large multibyte descriptions stays within 25,000 UTF-8
  bytes.
- The deterministic CLI E2E selects the overflow topic and exposes its unique
  marker at the ToolResult delivery point after the bounded initial wait
  expires.
