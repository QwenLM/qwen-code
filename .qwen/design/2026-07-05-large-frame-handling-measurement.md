# Large Pipe Frame Handling Measurement

## Summary

This PR is a measurement and design step for large `qwen serve` ACP pipe frames. It does not change pipe payloads, frame limits, EventBus behavior, SDK behavior, public protocol fields, CLI flags, HTTP query parameters, or advertised capabilities.

The immediate goal is to collect low-cardinality attribution for oversized NDJSON pipe messages so the next sidecar design can use real `pipe.message_bytes` distributions instead of guessed thresholds.

## Current Limits

The ACP child pipe currently has no single-frame byte cap. Existing daemon metrics record `pipe.message_bytes` with only the `direction` attribute, which is intentionally low-cardinality but cannot explain which payload families cause large frames.

SDK SSE readers already have a separate 16 MiB buffer cap for browser/event-stream delivery. That cap does not bound the daemon-to-child pipe frame size and does not explain pipe frame sources.

Bulk session replay currently has a count cap of 10,000 updates. It does not have a byte cap, so a bounded number of large updates can still create a large response frame.

## Measurement Shape

The new internal NDJSON observer receives `{ direction, bytes, message }` after a message is successfully read from or written to the pipe. Existing byte hooks still receive only `bytes`, preserving the current metric path.

The daemon records existing pipe counts, totals, maximums, histogram metrics, and status fields for every frame. Large-frame attribution only runs when `bytes >= 256 * 1024`.

Large-frame logs are sampled with a per-daemon process window of 50 records per 60 seconds. Suppressed sample counts are attached to the next recorded large-frame log.

Logged fields are restricted to low-sensitive attribution: direction, byte size, threshold, JSON-RPC message kind, method, source class, update count, session update type, tool name, tool provenance, and shallow text-byte maxima for content and raw output. Payloads, session IDs, client IDs, file paths, prompts, and raw tool output are not logged.

The histogram remains low-cardinality and keeps only `direction`; fields such as method, tool name, session update, and source class are not added as metric attributes.

## Source Classes

The observer uses only source classes that can be proven from the frame shape:

- `session_update_notification`: a `session/update` notification with `params.update`.
- `load_session_bulk_replay_response`: a JSON-RPC response carrying `_meta["qwen.session.loadReplay"]`.
- `load_updates_response`: a JSON-RPC response carrying `result.updates` plus load-update response markers.
- `jsonrpc_request`: any other JSON-RPC request or notification with a method.
- `jsonrpc_response`: any other JSON-RPC response.
- `unknown`: anything else.

The pipe layer cannot reliably distinguish live versus replayed `session/update` frames, so this measurement does not emit a `live` or `replay` attribution field.

## Sidecar Candidates For The Next Phase

The likely sidecar target is large tool output carried by `tool_call_update`, especially text in `content[]` and `rawOutput`. A later implementation should keep a small wire preview or stub in the update while placing the full body in a daemon-managed sidecar.

Metadata should travel through `_meta` so older clients ignore it and newer clients can opt into resolving sidecar content. The sidecar contract should define lifecycle, access control, cleanup, byte thresholds, fallback behavior, and client UX before implementation.

Bulk replay and `qwen/session/loadUpdates` need separate handling because a response can be large through many medium updates or a few large updates. The measurement fields include `updateCount`, `maxContentTextBytes`, and `maxRawOutputTextBytes` to separate those cases.

## Non-Goals

This PR does not implement sidecar storage, temp-file transfer, frame caps, replay-ring byte caps, compaction trimming, EventBus byte caps, or ACP HTTP binding buffer byte caps.

This PR does not add a `?maxFrameBytes` or `?maxQueuedBytes` query parameter, a CLI flag, an SDK option, or a capability. The daemon memory and transport budget should not be raised by arbitrary clients.

This PR does not change public event schemas. Any future sidecar protocol must be additive and separately reviewed.
