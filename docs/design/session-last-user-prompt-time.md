# Last user prompt time in session summaries

[English](session-last-user-prompt-time.md) | [简体中文](session-last-user-prompt-time.zh-CN.md)

Status: implemented and locally verified. Credential-dependent loaded-session E2E remains blocked in the isolated test environment; focused status-route tests pass.
Target baseline: `2cba716faf2b8ca807e3d89ab82e605c5247e1a8`.

## Problem and current behavior

Session clients need the time of the latest actual user question to display elapsed time. `createdAt` identifies session creation. `updatedAt` combines persisted file mtime and live turn-completion activity, so assistant output, metadata writes and background execution can advance it. Neither is the requested fact.

The current persisted session list reads only the first ten records plus bounded metadata windows. The batch catalog's full scan enumerates all session files; it is not a full-message traversal of every file. `SessionTranscriptReader` already performs a complete frozen-snapshot traversal and reconstructs the active main transcript, including Managed committed-record projection. Reusing its semantics avoids inventing a second transcript parser.

## Goals and scope boundaries

Add optional `lastUserPromptAt: string` to native session summaries and SDK types. A valid ISO calendar timestamp is normalized to UTC with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). It is present only when the time can be derived from a qualifying persisted user record. Absence means unavailable or no qualifying question; it never means creation time or current time.

The feature does not change session ordering, pagination, source filtering, group membership, `updatedAt`, live-state polling, prompt execution, or UI formatting. It adds no public endpoint, capability flag, configuration option or prompt text payload. Exact elapsed-time UI and localization are client responsibilities.

## Source-of-truth rules

The source is the existing `ChatRecord.timestamp` of the latest qualifying record in the session's effective main transcript, in transcript order. Normalize a valid timestamp to ISO; skip invalid timestamps rather than substituting another clock. Preserve the stored time, including a future value caused by clock skew; display clamping belongs to clients.

A qualifying record is a main-session `type: user` record with no non-user provenance and no subtype, subtype `mid_turn_user_message`, subtype `realtime_message`, or subtype `agent_mention`. Include attachment-only user messages, real voice input, and human questions directed to an agent. An `agent_mention` authored by an external agent remains excluded through its `external_agent` provenance. Text visibility is not a predicate. Legacy records lacking provenance remain eligible if their shape otherwise matches.

Include a persisted `mid_turn_user_message`: it is a genuine human message drained from the host queue, recorded exactly once at injection, not a synthetic duplicate user turn. The subtype exists to reconstruct API history and must not disqualify the user's question. A `backgroundTurn` context property alone is not evidence that the author was automatic, because genuine injected human input may be recorded during background execution.

Exclude notification, cron, Goal runtime/control, tool results, assistant/system records, `agentId` or `isSidechain` records, inherited `forkedFrom` history, and records outside the effective active branch. A child's records never advance its parent's timestamp; child sessions are not rejected solely for having `parentSessionId`. Determine attribution from each record, not the row's source category. The canonical reader retains inherited history unless its hide-inherited option is selected, so timestamp projection must explicitly ignore `forkedFrom` instead of assuming every replay record is a question asked in this session.

Retries, continue operations, restore-ask-user-question and rejected/cancelled queued prompts that never create a qualifying record do not advance the field. This is recorded-question time, not queue admission or model completion time. Uncommitted Managed events do not qualify; use the existing Managed projection.

## Implementation by layer

### Core transcript metadata

Add one shared qualifying-record predicate and timestamp projection adjacent to the transcript reader. Canonical index entries retain only the candidate timestamp needed to select the final effective record. Reuse active-branch, inherited-history, sidechain and Managed projection logic. Do not reuse the current turn-state text-only predicate or the navigation label predicate, because their inclusion rules differ.

Expose `getLastUserPromptAt(sessionId, archiveState)` through `SessionService` and `SessionTranscriptReader`. The service prechecks persisted ownership with `readProjectSessionHead`, reading only the first record instead of scanning title/source metadata, and the reader reuses a frozen canonical index and its single-flight cache. The scalar cache also retains the indexed first record's session ID and cwd, and every caller validates those owner scalars outside the shared promise, including cache hits. This binds authorization to the timestamp's actual snapshot if the path is replaced after the precheck, without retaining message bodies or scanning a warm snapshot again. Listing does not call `loadSession` or `readRestoreProjection`.

### Historical backfill and cache

Historical files contain no authoritative last-question sidecar, so some cold read is unavoidable. Enrich only the final returned page after filtering, sorting and slicing. Never hydrate all up-to-50,000 catalog members just to obtain a field that does not participate in sorting.

Reuse the canonical frozen-index reader and its single-flight behavior. Add a simple bounded scalar LRU keyed by canonical runtime/file path and snapshot fingerprint (file identity, size and mtime). Store only the optional timestamp and first-record owner scalars, not message bodies. This avoids making a page of 100 rows thrash the dense reader cache, whose capacity is only 32 entries. An unchanged fingerprint is a cache hit; replacement, truncation, changed mtime or size is a miss. Do not persist this cache or add a new sidecar, write schema or independent JSONL parser.

A cold selected-page row may need one canonical frozen-snapshot traversal; that historical backfill cost is explicit. Use at most two concurrent per-page metadata reads, sharing in-flight work for the same fingerprint. Repeated unchanged-file list/status reads must not perform another complete scan, even after dense-index eviction. File changes may rebuild through the existing authoritative reader; suffix indexing and writer-side optimization are not required in this feature. Measure a larger changing file and a warm page. If measured work is unacceptable, report the concrete cost for review instead of silently using activity time.

The metadata reader checks the file size before index construction. A transcript exceeding the canonical 256 MiB index limit has no timestamp metadata: return absence without a full scan, warning or retry, rather than failing the entire page. This safety omission does not mean that the history has no user input. Other I/O errors retain the existing failure contract.

Metadata reads freeze the observed prefix and accept size growth under the same file identity, so a concurrent assistant append does not fail the page. Replacement, truncation, or a same-size rewrite with a changed mtime rejects the snapshot. This metadata-specific tolerance does not change the stricter default snapshot signature used by restore. Cancellation stops this caller from starting subsequent page rows; an already shared scan may finish for other waiters.

Do not hydrate unreturned rows or change the first-ten-record list read. Respect the existing reader's size/snapshot/Managed validation and cancellation boundaries; no next row begins after cancellation. Bound the scalar cache by a small internal entry limit, with no public configuration. Initial implementation may use 512 entries and validate that this holds a page of 100 without unbounded retention.

### Daemon summaries, catalog and status

Treat the timestamp as persisted-workspace metadata. Add it to `BridgeSessionSummary` and `DaemonSessionSummary`. Enrich selected response rows inside the resolved workspace runtime, using its runtime output directory, archive state and canonical cwd. Batch catalog reuses the same single-workspace producer. Unknown, removed, untrusted or unavailable runtime behavior stays unchanged; there is no primary-runtime fallback and no ACP child is created by browsing.

Preserve the persisted value when merging live summaries; an absent live value must not erase it. A live session whose first real question has reached the transcript can expose that persisted time. Before a qualifying durable record exists, leave it absent. The bridge's prompt echo and running/terminal events use different clocks and must not populate this field. Enrich status through the same metadata owner; keep the memory-only live-state endpoint memory-only.

### SDK and other consumers

SDK list, catalog, standalone-summary and status methods retain the optional timestamp unchanged. Update both public wire-type mirrors and relevant API documentation. Review every `BridgeSessionSummary` and `SessionListItem` construction/consumer. The field is daemon-summary metadata. Native CLI JSON listing, human-readable CLI columns, `SessionListItem` and client UIs are unchanged. Core session info/count-only paths do not start metadata backfill.

## Expected files

- `packages/core/src/services/session-transcript-reader.ts` and focused tests: effective-record projection, Managed compatibility, cached summary projection.
- A small adjacent metadata helper only if needed to keep the shared predicate/cache isolated; no general storage framework.
- `packages/core/src/services/sessionService.ts` and focused tests: owner-validated metadata accessor; no `SessionListItem` changes.
- `packages/cli/src/serve/server/session-list.ts` and tests: final-page enrichment, live merge, archive ownership and cache/read bounds.
- `packages/cli/src/serve/routes/session.ts` and `session-catalog.ts` tests: status and batch behavior under existing runtime ownership.
- `packages/acp-bridge/src/bridgeTypes.ts`, `packages/sdk-typescript/src/daemon/types.ts`, relevant SDK tests and protocol docs: additive optional wire field.

## Validation and acceptance

Use globally installed `qwen` first, with synthetic history, isolated HOME/runtime/workspace and loopback-only daemon; no model request is required for persisted catalog coverage. Then verify the same plan against the built local CLI. A field absent in the baseline is an expected gap, not a successful feature assertion.

Test normal multi-turn questions, assistant/metadata changes, voice and attachment-only questions, injected/background/cron/Goal messages, sidechains and forks, retry/continue/cancel, Managed committed versus uncommitted state, invalid/missing timestamps, live/persisted merging, archive/restore, replacement/truncation/rewind, concurrent readers, cache hits/invalidation, multi-workspace isolation and final-page read bounds. Assert timestamps against fixture records, never against mtime. Run build, typecheck, bundle, focused package tests, then self-audit and review.

Success requires unchanged existing ordering/cursors, no per-card network request, no creation/execution during read-only browsing, and no additional full-file scan for unchanged snapshots retained by the scalar cache, including a page larger than the dense-index cache. Unknown data stays absent. The E2E plan records distinct baseline, local verification and blocked cases.

Local validation completed with `npm run build`, `npm run typecheck` and `npm run bundle`. The affected core package was rebuilt after review fixes. Focused tests passed: 427 core tests, 70 list/catalog tests, 6 status-route tests and 8 SDK tests. Status tests were run separately with coverage disabled to avoid concurrent coverage-output conflicts.

The built CLI passed 49 isolated synthetic E2E assertions across ordinary and excluded records, invalid timestamps, human agent mentions, repeated reads, assistant/user append, restart, multiple owners and oversized history. Four native CLI NDJSON reads retained their existing output contract. Sixteen response objects that should omit the field contained no key rather than `null`. Loading a live session required credentials, so that E2E status case remains blocked; persisted-only status retained `404`, and focused route tests cover status enrichment. No model prompt or real credentials were used. Isolated-daemon shutdown can retain the baseline preheat shutdown error; all test listeners were closed.

## Measured cost and boundaries

The following are single local measurements using synthetic transcripts and the metadata getter, not production latency guarantees. The larger fixture contained 8,389,847 bytes. Each changing-file read rebuilt one canonical index; assistant append did not advance the user timestamp, while real user append did.

| Read                          |      Time | Index builds |
| ----------------------------- | --------: | -----------: |
| Larger file, cold             |  31.68 ms |            1 |
| Larger file, unchanged        |   0.14 ms |            0 |
| Larger file, assistant append |  17.98 ms |            1 |
| Larger file, user append      |  32.19 ms |            1 |
| 100-row page, cold            | 127.31 ms |          100 |
| 100-row page, unchanged       |   4.71 ms |            0 |

The field contract, persisted human mid-turn inclusion, page-only enrichment and two-read concurrency limit above are implemented decisions. Warm reads still perform bounded ownership and file-stat checks, but do not repeat the full scan. This change adds no HTTP request, polling, auto-retry, timer or background task. A new write-side schema, persistent metadata sidecar and incremental reader framework remain outside this feature. Local validation does not establish deployment or production performance.
