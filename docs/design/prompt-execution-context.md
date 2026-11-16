# Prompt execution context in chat recordings

[English](prompt-execution-context.md) | [简体中文](prompt-execution-context.zh-CN.md)

## Problem and scope

Web Shell records user prompts but does not attach the model and approval mode in effect when each prompt starts executing. Existing `session_model` and `session_approval_mode` records restore the latest session state; assistant `model` describes a response. None is a self-contained prompt snapshot.

Add optional `executionContext` metadata to user chat records. Keep the UI, transport, model input, and session restoration behavior unchanged. Use the shared recorder so CLI prompts have the same metadata. This covers the Config-backed ACP daemon used by Web Shell, including managed transcript sinks; the separate Hosted Harness writer and external Managed Agent backend are outside this change.

## Proposed change

`ChatRecordingService` reads its own session Config synchronously when `recordUserMessage` or `recordMidTurnUserMessage` constructs a record, before the asynchronous writer queue. The snapshot contains `modelId` from `getModel()`, optional `authType` from `getAuthType()`, and `approvalMode` from `getApprovalMode()`. Authentication can be unavailable for a command that does not call a model. No credentials or provider configuration are recorded.

The snapshot belongs to the prompt's record and is not part of `message`. Queued prompts take their snapshot when execution reaches the recorder, rather than browser submission. Mid-turn input takes its snapshot when it is drained into the active turn. Subsequent configuration changes cannot alter earlier snapshots. Existing retry and continue paths reuse the original user record and its snapshot; this is not a per-attempt audit log. Slash commands record the configuration at their existing recording point, generally before command execution. A later model fallback or approval-mode transition does not rewrite the snapshot; assistant model records remain the evidence for response models.

## Compatibility and consumers

The field is optional: old JSONL remains valid, and unknown historical values are never filled from current settings. Transcript validation preserves additional top-level metadata. API-history reconstruction consumes `message`, so the snapshot is not sent to the model. Session restoration continues to consume the explicit session-state records. Managed message projections and branch copies preserve complete records. UI transcript projection and presentation exports may omit the metadata; this change guarantees storage in the source recording, not display or export of the snapshot.

## Files and validation

Update the chat-record type and the two recording entry points in `packages/core/src/services/chatRecordingService.ts`. Extend collocated recorder tests and any existing recorder test Config fixtures that need the getters. Add focused compatibility coverage for transcript preservation and API-history isolation if not already exercised by recorder tests.

Run the global CLI baseline, then local build, typecheck, bundle, focused unit tests, and an isolated daemon/API E2E run with a mock OpenAI provider. Verify the persisted user record, not just streaming response metadata. The provider is simulated; the daemon and recording backend must be real. Keep test scripts and results under `.qwen/e2e-tests/`.

## Acceptance criteria and risks

- Normal prompts and mid-turn input contain the effective session model, authentication type when available, and approval mode at their recording point.
- Changing configuration before a subsequent prompt does not change previous snapshots, including pending asynchronous writes.
- Old records load without the field, and snapshot metadata does not enter model messages or restore permissions.
- Retry and continue do not create duplicate user records.

Approval mode describes the selected approval policy, not the complete sandbox, tool allowlist, or individual permission decisions. Model identity is the selected model ID and authentication type, not a unique provider endpoint. There are no open design questions.
