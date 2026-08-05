# Live journal truncation recovery

## Context

The daemon keeps a bounded in-memory live journal for an unfinished turn. When the journal exceeds 10,000 events or 8 MiB, it discards the oldest replay events and prepends a `history_truncated` marker. The persisted transcript and turn-boundary compaction remain authoritative, so the complete turn becomes available again after a formal terminal event.

The marker previously had no prompt ownership, the SDK rendered a generic message, and WebUI either hid the marker behind history pagination or left the retained tail permanently visible. This design keeps the existing resource limits and eviction policy while making the loss precise and repairing the visible tail without another model request.

## Protocol and SDK

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

## Verification

Unit coverage exercises marker ownership, post-terminal compaction, payload validation, precise status text, prompt matching, replay validation, atomic suffix replacement, duplicate-side-effect suppression, history preservation, failure fallback, and reload-source propagation. Daemon integration tests use a deterministic mock ACP agent and a three-event journal to observe the live marker from a second client, verify the complete compacted turn after terminal, and mount the real WebUI provider to prove that recovery adds one load and no model request.
