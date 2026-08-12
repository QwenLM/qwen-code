# Session List persisted catalog cache

## Problem

Organized and metadata-filtered session lists must load the complete persisted session catalog before applying organization, source, ordering, and cursor rules. Concurrent `all`, `pinned`, source-filtered, and LiveTask requests currently repeat the same JSONL and worktree-sidecar reads. The synchronous portions of those scans amplify event-loop lag when a workspace has many or large transcripts.

## Design

The daemon keeps a process-local catalog snapshot keyed by the resolved session runtime root, the exact workspace identity, and active versus archived state. Query, group, source, cursor, trust, and live-merge options are intentionally excluded because they do not change persisted catalog contents.

The first request installs an in-flight Promise before starting the loader. Concurrent requests for the same generation await that Promise. A successful catalog, including worktree sidecars, remains available for two seconds from scan completion. Organization and every live bridge field are merged after lookup on every request. Default numeric pagination and the separate session-info counter do not use the catalog cache.

Each scope has a generation. Explicit metadata, close, delete, archive, and unarchive operations invalidate the affected states. An invalidated in-flight load may finish for requests that already joined it, but its generation cannot repopulate the cache. Failures are never cached and there is no stale-on-error fallback.

Metadata title persistence remains asynchronous in the bridge extension method. Invalidation prevents a pre-mutation generation from being installed, while the live merge exposes the new title immediately; it does not claim that the metadata response waits for durable JSONL persistence. A scan racing that background write can still publish its older file view for the normal two-second snapshot lifetime.

The cache retains at most 50,000 summaries across all workspaces. A snapshot larger than the limit is still returned to its current waiters but is not installed. Expiry timers are unreferenced and identity-checked, and the oldest completed snapshots are evicted before a new snapshot would exceed the limit.

## Consistency and isolation

Daemon-managed callers pass the selected runtime root explicitly, and the complete read runs in that pinned Storage context. Secondary runtimes never fall back to the primary runtime. Read-only trust policy remains request-scoped; sharing the persisted snapshot does not enable live merging or debug logging.

The cache is not a filesystem transaction. Unknown writers can update a file after that file was read but before the snapshot finishes. Such a snapshot can remain visible for two seconds after publication. Live session state and organization changes are not subject to that window.

## Observability

Request spans distinguish physical scans, cache hits, and single-flight waiters before awaiting the shared Promise, so failures retain their cache status. Successful lookups also record archive state, query kind, summary count, scan pages, truncation, and either leader scan duration or cache age. Paths, session identifiers, titles, and source identifiers are never attached.

## Out of scope

This change does not alter public protocols, Web Shell polling, the session-info scan, cross-workspace scan scheduling, core filesystem APIs, or daemon timeout policy. The outer lifecycle timeout fix remains necessary for a single slow cold scan.
