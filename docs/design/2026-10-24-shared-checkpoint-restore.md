# Shared checkpoint restore correctness

[English](2026-10-24-shared-checkpoint-restore.md) | [中文](2026-10-24-shared-checkpoint-restore.zh-CN.md)

## Status and scope

Stack on the complete session replay/recovery batch in [#15384](https://github.com/QwenLM/qwen-code/pull/15384). Exact source, artifact and runtime results belong in this batch's PR verification report. It repairs the existing Ink checkpoint restore behavior; it does not claim new OpenTUI checkpoint creation or a default renderer change. B will add complete OpenTUI capture, scheduler/writer and hot/cold acceptance while depending on this shared contract. A keeps Read generation fencing in this same delivery rather than opening a tiny separate PR. Historical aggregate runs are evidence of the original defect/expected behavior, not validation of this extraction.

## Problem

Loading a saved API history clears prior-read authority. Replaying a checkpoint edit can therefore fail despite successful filesystem rollback. A local replay also has a fresh physical execution ID: treating it as an unrelated model result leaves the original pending logical call orphaned, while retaining the old active journal suffix makes cold resume see stale OLD1 results and discarded answers rather than actual NEW2.

## Restore authority before effects

Resolve the original pending function call uniquely from the checkpoint API history, including name, original model arguments, logical ID and nearest real user prompt metadata. Capture the actual recorder/session and validate the persisted assistant anchor before file rewind, UI history load or API history replacement. Missing, ambiguous, paired, wrong-prompt and wrong-recorder requests fail before those effects. A legacy tool-only checkpoint without pending API history keeps its existing local behavior; recording-disabled sessions keep their hot-only path.

After history replacement, use the real interactive scheduler for a fresh Read when the existing edit target requires it. Preserve the established client-tool Mod policy and normal Core Read permissions/hooks. Ask uses the existing confirmation API, not a new UI history row. Deny, cancellation, abort, owner loss, session replacement or changed original arguments cannot authorize an edit. New-file creation and missing targets retain their existing legitimate tool semantics. A cache-clear generation sampled at actual Read execution prevents a stale read's fast path, record or catch cleanup from granting/invalidation across a replacement generation.

The checkpoint writer saves the original logical call ID. Authorized hooks and approval may change execution arguments without changing the model call. New checkpoints select by call ID; legacy checkpoints admit only a unique same-name candidate. Execution parameters cannot prove identity after an authorized rewrite, so multiple same-name calls without a saved ID fail before effects, even if one argument set matches. The recorder anchor always validates original model arguments. Before scheduling, bind the physical execution ID to the existing owner. Completion checks that execution ID and tool name while retaining the session, history revision, tail and recorder guards; authorized argument changes on that execution still publish its actual result against the original logical call.

## Actual replay binding

The binding captures configuration, client/chat identity, session, replacement revision, raw history tail/length, original call identity, current submission owner and exact recorder. The chat revision advances for destructive/replacement APIs even when the same array/tail/length is supplied; ordinary append does not advance it. Raw-tail/length and real owner checks remain necessary around appends. The restore-only captured submission predicate prevents competing requests from claiming an admitted restore.

Register the binding on the existing Ink continuation owner before scheduling. Preserve the replay's fresh physical ID in UI and telemetry. Once the real tool and PostToolUse hook complete, use its actual finalized parts, terminal status, output files/artifacts and Goal provenance. No synthetic OLD success or copied response is accepted as NEW. Duplicate completion starts at most one durable publication. Recheck ownership before publication and before API append; strict recording failure must not add an API result. Collect file-history snapshots at completion time, preserving dates/backup metadata.

## Durable cold branch

Use the existing active branch, topology fence, rewind record, strict append and metadata projection. Resolve an unambiguous persisted original assistant-call anchor and preserve its complete message, media and sibling calls. Publish only the selected replay's actual new result under the original logical ID; discard old results/answers from active ancestry while retaining raw old records physically. Unreplayed siblings remain truthful missing/error or actual cancellation, never fake success. A multi-call checkpoint is not silently rejected as a single-pending-only policy.

Maintain actual persisted cursor semantics for partial strict-write failure. A persisted rewind followed by failed NEW-result write is a truthful partial branch; do not claim atomic rollback or fabricate the result UUID as persisted. Buffered successor records must preserve their actual reparented topology, turn boundaries, titles and snapshots when the fence releases. Rebuild recorder prompt identities and parent boundaries from the same retained records so an ordinary rewind of a subsequent prompt preserves the restored ancestry. Session, owner, writer lease, prompt and metadata guards stay scoped to the captured operation.

## Confirmation consumers

The existing Ink extension-consent hook and OpenTUI generic consent bridge both consume signal/current options from this shared command API. They reject pre-aborted, stale, unmounted or late-yes callbacks once, dispose listeners and preserve unrelated successor dialogs. This is an existing API consumer fix; A adds no OpenTUI scheduleTool/capture/snapshot port.

## Verification before Ready

Run normal build, full typecheck, lint and all affected complete CLI/core files on the actual extracted source. Preserve tests for real Read descriptor/cache races; destructive chat revisions; recorder disk/lease/fence failures; pre-effects command refusal; permission deny/cancel/current loss; captured binding/duplicate/recorder replacement; both existing confirmation consumers; and actual Ink completion ownership. Syntax parsing alone is not these gates.

Use a fresh inventory-bound product for the permanent checkpoint case on Node+Ink and Bun+Ink: actual model Read/Edit and approval checkpoint, original backup A, initial OLD1, physical rollback A, exactly one approved replay NEW2, explicit followup with NEW2 paired to the original logical call, two natural exits and same-UUID cold resume with active-ancestry/backup/old-answer negatives. Record raw HTTP, journal, PTY, actual runtime and finite cleanup. Preserve multi-call truthful sibling and real permission/owner negatives; a green single selected case does not prove them. Other collected names are NOT_SELECTED, never product passes. Two clean source-review passes and actual fresh acceptance are required. B later extends the same permanent fixture to strict OpenTUI only after its real creation/capture/writer consumers exist.

## Limits

No new schema, global registry, generic snapshot framework, runtime pin, headless/updater behavior or automatic LLM request is introduced. A does not claim every platform, installed package or future B behavior is validated. The complete transaction and tests are kept even if the advisory size target is exceeded; measured production/test/doc counts accompany review.
