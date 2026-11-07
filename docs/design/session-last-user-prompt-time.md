# Last human prompt time in session summaries

[简体中文](session-last-user-prompt-time.zh-CN.md)

## Product requirement

Clients need the recorded time of the latest genuine human question to show “asked 5 minutes ago” and to support a view ordered by the user's questions. Session creation time is unrelated; activity `updatedAt` also advances on assistant output and background work.

For example, the user asks A at 10:00 and B at 10:05, then A continues output at 10:10. Activity ordering puts A first; question-time ordering must keep B first. Both are valid product views and require distinct facts.

This PR supplies optional `lastUserPromptAt` consistently on workspace session-list pages, batch catalog rows, standalone SDK summaries and loaded-session status. It also includes the optional server and WebShell [question-time sort](session-question-time-sort.md), which processes the complete eligible candidate set before pagination. Default ordering remains compatible.

## Timestamp semantics

Use the recorded timestamp of the last qualifying input on the effective main transcript branch, normalized to UTC ISO milliseconds. Include attachment-only, voice and persisted human mid-turn messages and human agent mentions. Exclude assistant/tool/system activity, notifications, cron/Goal, external agents, inherited fork history and inactive branches. Missing means unknown or no qualifying input, never creation/activity/current time. Do not advance for input rejected, cancelled before recording, or failed persistence.

## Performance problem in the first implementation

The original scalar cache used JSONL identity, size and mtime. Assistant appends changed its key and could rebuild the full transcript index on the next list/catalog/status request. A synthetic reproduction at `16435cd` measured full index-build counts of 1 cold, 1 unchanged, 2 after one assistant append and 3 after another, with the human timestamp unchanged. Existing catalog enumeration reads bounded metadata; this does not make an additional effective-transcript scan free.

## Cold recovery and hot updates

- On a cold metadata miss, reconstruct the effective persisted transcript using the canonical reader. Enrich returned rows for default reads, or the complete eligible set before question sorting, at most two concurrently; concurrent reads share the same initialization. The scalar cache retains complete scopes within 100,000 entries and 64 scopes and survives the separate catalog TTL and dense-index eviction.
- For warm default metadata reads, inspect file identity/size/mtime without reading transcript content. Ordinary append growth retains the scalar. Replacement, truncation or same-size rewrite is an explicit recovery condition. On filesystems reporting no verifiable inode, a changed warm snapshot omits the optional value without rescanning until a human notification or cold recovery re-establishes it. A cold miss above the canonical 256 MiB index ceiling omits metadata without scanning.
- After a qualifying human record is successfully persisted, the recorder sends its actual recorded timestamp through the existing owner-scoped ACP notification transport. The daemon installs that scalar in the same runtime/workspace cache used by list, catalog and status, then advances the catalog version. No full transcript scan is required for this update. A hot known timestamp can still be served for a transcript above the cold-scan ceiling.
- Assistant/tool/automatic activity does not send a prompt-time update and append growth does not invalidate hot metadata. No new HTTP endpoint, client request, polling loop or background timer is added.
- Persisted rewind and message-group deletion invalidate the scalar; the next read recovers the effective branch once. A newly registered owner also invalidates older process-local metadata, so a restore/replacement recovers any changes made while no live owner was present. Restart naturally starts cold.

This metadata is authoritative for this daemon's observed writer. Unobserved external append-only writes to an otherwise warm, unloaded session become visible on a cold recovery/owner registration/cache eviction; they do not trigger a full scan on every catalog request. This is the deliberate hot-memory contract.

## Ownership and consumers

The persisted metadata is workspace/runtime scoped. Resolve the runtime first, use its storage root and canonical workspace, and validate cold snapshot ownership. The cache key includes both the resolved transcript path and workspace. Default reads detect file replacement; warm question sorting uses the observed writer cache until explicit recovery. ACP notifications are accepted only for the session owned by the sending channel; unknown/foreign owners do not update memory. Do not fall back to the primary runtime.

Workspace session-list and batch catalog share one enrichment producer. Status resolves its live owner and uses the same cache. SDK list/catalog/standalone/status preserve the optional wire value. Memory-only live-state keeps its existing shape and performs no transcript enrichment. Native CLI columns/JSON and ACP listing are unchanged.

## Verification

The ignored E2E plan is `.qwen/e2e-tests/pr14654-hot-prompt-time.md`. Verify exact values and scan counts: one cold scan; no additional full scans for repeated reads, dense-index eviction, assistant/automatic appends or a notified persisted human question; failed writes do not notify. Verify list/catalog/status consistency, observer disposal, foreign-owner rejection, archive isolation, topology recovery and restart. Use isolated synthetic workspaces and loopback-only daemons; no production history or model credentials.

Record final test results in the PR validation comment. Local source-level evidence is not a production latency guarantee.
