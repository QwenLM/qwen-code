# Cancelled turn recovery

[English](cancelled-turn-recovery.md) | [简体中文](cancelled-turn-recovery.zh-CN.md)

## Problem and scope

After explicit daemon cancellation, restored model history can resemble a crashed turn. Recovery must consult the existing `turn_result`, distinguish user intent from infrastructure interruption, and refuse to resume work the user stopped. Unknown legacy cancellation still requires confirmation. Model response and tool repair semantics stay unchanged.

## Turn identity and terminal outcome

Client prompt IDs identify logical input; daemon prompt IDs identify executions and terminal results. The active transcript branch binds them through user records and `turn_attempt` records. Full and selective restore share the same validated ownership resolution, including records before compression and independently of the replay window. Unique user cancellation requires `state: 'cancelled'`, finite `cancelledAt`, `cancelReason: 'user'`, and an unambiguous owning execution. Missing or duplicate identities cannot certify user intent. A latest validated timestamped cancellation with uncertain ownership or legacy provenance supplies an unknown cancellation boundary. Later model input, attempts or terminal results supersede that fallback; completed local commands excluded from model history do not.

`LlmClient` owns the current execution ID and its normalized cancellation outcome. Both live settlement and cold restore use the same terminal normalization. Successful model-input preparation accepts the existing invocation ID (or the existing model prompt ID for a direct call); terminal settlement updates only that execution. Failed preparation that rolls back input cannot replace its owner. A pre-send cancellation that preserves input accepts that input explicitly. An admission-only cancellation and a late terminal from another execution cannot cancel the current work.

A durable Retry attempt advances execution ownership before asynchronous preparation. Continue advances only after its final recovery and confirmation check. Rejected continuation returns before creating transcript records, so repeated no-op requests cannot erase the old cancellation boundary. Accepted attempts retain the prior cancellation until actual input preparation clears it. Restored tool interaction writes its attempt only after the restore no-op check. Failed attempt writes reject execution. Compression, startup reminders, tool-result cleanup and replacement chat instances change content without changing the logical execution. Explicit history replacement, rewind and clear invalidate execution ownership. Message arrays carry no cancellation state and require no cancellation snapshot or re-marking.

## Cancellation and confirmation

Cancellation provenance passes through the existing cancellation metadata. Human Cancel, queued-input removal and active client Close carry user intent. Transport close, deadlines, channel steering, automatic teardown, runtime disposal and ordinary SDK aborts carry interruption. Remote Host stop keeps its explicit lease provenance; restart fencing does not invent user intent. Later human cancellation can upgrade an in-flight interruption, and FIFO ownership waits for both cancellation handshakes. Only user intent stamps the durable marker; interruption notices retain their own wording.

Legacy timestamps alone do not prove user intent. Unknown cancellation disables automatic continuation and exposes its terminal execution ID. WebShell explains the uncertainty; REST, ACP, SDK and stream-json return that ID on explicit confirmation. Admission and final execution check the current boundary again. Missing, stale or mismatched confirmation makes no model request; confirmation never overrides proven user cancellation. Invalid terminal payloads supply no provenance, and history gaps retain the degraded-history guard.

## Validation and acceptance

Use a controlled loopback provider and a real built daemon: run `read_file`, hold the next provider response, explicitly Cancel, restart, reattach (`POST /session/:id/resume`) and Continue. Require refusal with no additional provider request. In the paired control, omit Cancel and SIGKILL during the held response; after restart and reattachment, require continuation and a correlated terminal. SIGKILL after a flushed explicit cancellation must still refuse recovery. Calling Continue without reattachment produces a routing 404 and proves neither case.

Verify full/selective restore, compressed histories, user/unknown outcomes through full and fast compaction and idle cleanup, preparation rollback, local commands, newer input, late settlement, explicit history replacement, abandoned branches and malformed ownership. Check missing/current/stale legacy confirmation at admission and final execution. Retry tests use an errored bridge turn or direct ACP retry; bridge resubmission after cancelled completion is fresh input. Preserve cancellation upgrade and FIFO handshake coverage.

## Risks and remaining work

This scope covers recorded daemon cancellation and does not invent durable provenance for independent TUI paths. Untagged cron/steering boundaries can still prevent ownership resolution; walking past them risks suppressing legitimate newer input. Exact Todo Stop Guard and task-notification handling respects tagged input and the cold recorder's notification count, including zero. These remaining ownership decisions stay in #13502. Active/admission-waiting client Close preserves intent, but idle Close after an earlier interruption still lacks a durable closed marker. No transcript migration or release is included.
