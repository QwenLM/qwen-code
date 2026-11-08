# Live journal truncation recovery

## Context

The daemon keeps a bounded in-memory live journal for an unfinished turn. Consecutive compatible text or thought chunks share bounded replay entries, with at most 256 source events per entry. When the journal exceeds 10,000 replay entries or 8 MiB of serialized source events, it discards the oldest entries and prepends a `history_truncated` marker whose retained and truncated counts still describe source events. The persisted transcript and turn-boundary compaction remain authoritative, so the complete turn becomes available again after a formal terminal event.

The marker previously had no prompt ownership, the SDK rendered a generic message, and WebUI either hid the marker behind history pagination or left the retained tail permanently visible. This design keeps the existing resource limits and eviction policy while making the loss precise and repairing the visible tail without another model request.

Web Shell renders the parent transcript in summary mode and discards nested subagent updates, but those updates previously still consumed the parent live-journal limits. A long-running subagent could therefore evict the visible root Agent status and leave the summary UI with only the truncation marker.

## Protocol and SDK

The compaction engine maintains independently bounded `full` and `summary` live journals. Both share the completed-turn compaction and event high-water mark. The full journal retains every update. The summary journal excludes `session_update` frames carrying a non-empty `_meta.parentToolCallId`, while retaining root updates and all non-session events. Two exceptions mirror the main-transcript projection. First, nested `agent_message_chunk` frames whose `_meta.usage` carries a numeric `inputTokens` or `outputTokens` are retained: the main transcript consumes exactly those frames for subagent token accounting, so dropping them would silently lose nested usage from the restored conversation's totals. Second, a frame whose `_meta.parentToolCallId` equals its own `toolCallId` is treated as root, matching the UI normalizer's self-reference guard (`normalizeToolUpdate` drops a self-parent), so both projections agree such a frame is a root tool block. The two journals share one pair of caps (entry count and byte size), so a single in-flight turn can retain up to twice the cap of journal heap; operators sizing daemon memory from `maxJournalBytes x live sessions` must double the journal term, including any adaptively grown cap.

`session/load` accepts optional `liveReplayMode: 'full' | 'summary'`. Omission means `full`, preserving SDK, `/acp`, and other daemon consumers. WebUI requests `summary` only when its existing `subagentTranscriptMode` is summary; Web Shell already selects that mode for the main transcript. Persisted transcript pagination remains complete and unchanged. Concurrent restores of the same session only coalesce on identical shapes; the single exception is that a `summary` request may share an in-flight `full` restore: the two journals can diverge under cap pressure (each evicts independently against the shared caps), so once the restore settles the daemon recomputes the waiter's replay fields for its own mode from the registered session — the owner's projected fields are never reused or filtered down for a waiter of a different mode — and the waiter never inherits the owner's unprojected full journal or its truncation marker. A `full` request never shares an in-flight `summary` restore (that projection would lack the nested detail the full client expects), so that direction stays fenced with `restore_in_progress`.

For a live-journal marker returned by `session/load`, the bridge copies the session's authoritative `activePromptId` to the marker envelope as optional `promptId`. The persisted event and event schema version do not change. An older daemon without this field is repairable only when the retained live events have exactly one prompt ID.

`DaemonHistoryTruncatedData` exposes the existing optional `scope` and `maxEvents` fields. Validation rejects malformed optional values. Normalized status data retains the complete daemon payload. The text distinguishes replay-history truncation from live-turn truncation, states that the newest events were retained and older replay events were discarded, and promises post-terminal recovery only when `fullTranscriptAvailable` is true.

## WebUI recovery episode

During snapshot replay, a recoverable live marker creates an episode checkpoint immediately before the marker. The checkpoint reuses immutable transcript blocks and retains the session ID, target prompt ID, snapshot event watermark, marker block ID, and a deterministic episode signature. Older history pages and provider-local status blocks are mirrored into the checkpoint while the marker is active.

Only a matching `turn_complete` or `turn_error` arms recovery. Cancellation is represented by a formal terminal event with a cancelled stop reason and follows the same path. Buffered transcript events are flushed and prompt state is settled before recovery is attempted. An in-flight session load, history page request, navigation, or local prompt delays the attempt until the next idle point.

Recovery performs one same-session `session/load` with in-memory replay and no configured history page size. The current transcript stays attached and visible until validation succeeds. The fresh snapshot must not be degraded and must contain both the target prompt's user input and a matching formal terminal. A validation or retriable transport failure rejects the replacement, resumes the previous session handle from its SSE cursor, preserves the transcript, and emits one recoverable `daemon.live_journal_repair.failed` notice. Authentication failures and a missing session also preserve the transcript and emit the notice, but retain the provider's existing disconnected or reauthentication state because that SSE stream cannot safely resume.

On success, WebUI rebuilds the target suffix from the earliest matching user input through the fresh snapshot tail. It starts from the checkpoint when the marker block is still retained; otherwise it rebuilds a bounded full snapshot. Replayed events rebuild transcript state, including `assistant.done`, but events at or below the episode watermark do not repeat notices, workspace signals, pending-prompt publications, follow-up publications, or other side effects. Newer event IDs retain their normal effects.

The resulting state is committed with one store reset. When the complete suffix fits within the checkpoint's `maxBlocks`, retained history block IDs, pagination cursor, loaded depth, and capacity state remain stable. If it crosses that limit, the existing store policy may trim the oldest loaded blocks rather than create an unbounded repair exception. A fresh suffix that ends with another recoverable live marker creates a separate episode for that prompt.

## Concurrency and lifecycle

An episode is attempted automatically at most once. A configured reload, session switch, page unmount, or explicit session clear aborts and removes it. A repair reload preserves it until success or failure. The reload pauses the old SSE subscription without detaching its session registration. A rejected candidate is detached and the previous handle resumes from its existing cursor; a validated candidate becomes the new subscription owner.

The checkpoint inherits the current transcript store's effective `maxBlocks`, while the marker-trimmed fallback uses the configured `maxBlocks`. This preserves the existing oversized-initial-replay behavior without creating a new exception for repair. Blocks are shared rather than copying text payloads, and no unbounded journal or second transcript cache is introduced.

## Compatibility

- The marker `promptId`, `scope`, and `maxEvents` fields are optional.
- Old clients ignore the marker envelope extension.
- New clients accept old payloads and safely decline ambiguous automatic repair.
- Default `reloadSession` behavior remains configured replay; only the internal repair path requests memory replay.
- Daemon persistence, transcript APIs, journal limits, and oldest-first eviction are unchanged.
- Existing load callers and `/acp` continue to receive full live replay by default.
- Summary and full journals track truncation independently, so full-journal pressure does not create a summary marker.

## Verification

Unit coverage exercises marker ownership, post-terminal compaction, independent full/summary limits, default-full compatibility, request validation and propagation, precise status text, prompt matching, replay validation, atomic suffix replacement, duplicate-side-effect suppression, history preservation, failure fallback, and reload-source propagation. Daemon integration tests use a deterministic mock ACP agent and a three-event journal to observe the live marker from a second client, verify the complete compacted turn after terminal, and mount the real WebUI provider to prove that recovery adds one load and no model request.
