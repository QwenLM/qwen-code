# OpenTUI session replay and rewind

[简体中文](./2026-10-21-opentui-session-replay.zh-CN.md)

## Scope

Stack on the complete owned-interactions batch in [#15283](https://github.com/QwenLM/qwen-code/pull/15283). Resume, replay and rewind share the existing recorded history, command host and session lifecycle. Preserve the earlier cancellation, prepared Retry, shell ownership, recall and quit behavior. This design defines the complete batch; exact source, artifact and runtime results belong in its PR verification report.

## Current gaps and affected layers

Before this batch, resumed display and command history can use different projections, rewind has no complete OpenTUI transaction, and ordinary native tool results can reach the model without being recorded. Changes stay in the CLI history converter/projector, live turn and command host, startup/logger lifecycle, native result consumer, rewind selector and shared Ink rewind transaction, with their collocated and interactive tests. No core schema, runtime launcher or dependency change is required.

## Replay and startup

For resumed startup, join the existing Config initialization flight before reading tool metadata, then re-read the authoritative resumed session installed by recording activation. Fresh sessions retain early paint and initialization failures retain the existing cleanup/fallback behavior.

Project complete recorded rows through the existing projector. Keep their original source identity across text/image/tool fanout and replace an updated host row at its original transcript position. Hidden zero-render source rows must remain hidden; do not synthesize partial history from formatted strings. The host and visible transcript start from the same canonical startup snapshot. Expansion reveals suppressed rows without discarding a running turn or its structured queue.

## Rewind ownership

Both renderers use the existing shared rewind transaction for API history, visible history and file rollback. A real builtin slash rewind can open its selector during its own artificial command-responding state; unrelated model, shell or replacement-command ownership cannot borrow that exception. Preserve prompt identities, code/conversation/both choices, file failures and stale successor checks.

Preserve main's source-identity rewind contract when sharing the transaction: resolve the recorded boundary independently through `promptId` or the conversation-only `rewindId`, and retain checkpoint snapshots by their actual association rather than visible row counts. Refuse missing recorded boundaries or ambiguous checkpoint associations before changing files or conversation. Recording-disabled sessions retain conversation rewind; a recovered legacy identity never authorizes file restore. Native rewind carries that recovered key through its existing canonical history row, and both selectors offer only identity-backed turns. This carries the existing upstream fix into the extracted transaction rather than introducing another rewind authority.

OpenTUI owns the selector's actual available region. Resize, tiny regions and labels too narrow to identify an action cannot commit an invisible target. Keep pending restore single-owner and preserve the draft only while the committed rewind remains current. Restored image and typed-file display use the original user form and saved model context rather than re-reading changed files.

## Ordinary native journal

Record each finalized ordinary model/native tool response once, with its real status, display, output metadata and existing Goal provenance. Apply the same path to Mod final responses without a second record. Do not publish an old turn/session result over its successor. This repairs the native persistence consumer described in issue #15326; the earlier D retry/fallback pending-request clear remains intact.

## Deferred checkpoint authority

This batch does not add checkpoint creation, a full native snapshot getter, a checkpoint writer, restore-response binding, pre-effect Read authority or durable restore branch publication. Those remain one complete AB follow-up. Replay source retention here has actual replay/host consumers; it is not a new shared framework or an unused checkpoint option.

## Acceptance

Run normal build/typecheck and complete affected package test files on the extracted base. Run the dedicated session suite on Node+Ink, Bun+Ink and strict OpenTUI: preserve existing D cases and add cold image/typed-file resume. Verify real rewind conversation/API/file boundaries and stale cancellation, selector resize/narrow labels, authoritative startup metadata, and an ordinary native tool's actual journal result before a natural quit and same-session cold replay. Aggregate evidence from the preserved source does not establish this candidate's acceptance. Installed/platform and full checkpoint hot/cold gates remain separate.
