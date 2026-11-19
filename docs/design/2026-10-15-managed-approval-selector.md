# Managed approval policy in the shared composer

[English](2026-10-15-managed-approval-selector.md) | [中文](2026-10-15-managed-approval-selector.zh-CN.md)

## Status

This document records the initial creation-selector slice. Its fixed-policy and Shell Full Access restrictions are superseded by [Managed approval selection](managed-approval-selection.md), which adds capability-gated Full Access and idle Session policy changes while preserving this creation contract.

## Problem and current behavior

Local WebShell exposes an approval selector, while Managed creation hides it. Managed already supports durable permission Actions and the shared ToolApproval card. The Java server pins an approval mode in each Session, and the Harness confirms that mode on load. Mode selection must change actual admission, not just its label.

## Behavior and scope

New Workspace-bound Managed tasks use the shared selector with modes returned by the server. The built-in qwen-code Agent supports default and auto-edit for the Shell profile, and additionally yolo for the file-only profile. Classifier auto and plan are unsupported in Hosted execution and never offered. Shell never bypasses permission approval. Stored AgentDefinitions keep their compiled policy; their options contain only that mode. The interface displays the current Session's saved policy as fixed; changing policy requires a new task.

Live Session policy mutation, classifier support, changes to permission decision semantics, new tools, AgentDefinition policy overrides, and the existing expired-writer recovery issue are outside this change. Local mode keeps its existing choices.

## API and admission

An actor-required tenant-scoped WebShell endpoint `POST /api/agent/web-shell/v1/session-options/query` accepts `agentId` and returns `approvalMode` and `availableApprovalModes`. Workspace discovery advertises `approvalModeSelection` when this endpoint and create contract are supported. Options come from the same Agent/profile resolution as creation. No host paths or credentials are returned.

The WebShell create request gains optional `approvalMode` for Workspace-bound creation. Omission preserves existing defaults and old request digests. An explicit mode is included in the creation digest and frozen retry; reuse of a key with another mode conflicts. New admission validates the selected mode against the resolved Agent and tool profile, stores it in existing `ma_session.approval_mode`, and passes that pinned value through the existing Harness path. Unsupported values and explicit policy on an unbound Session fail closed. Definition admission cannot silently override its saved policy. There is no schema migration or public REST create contract change.

WebShell Session summaries return the persisted `approvalMode` for Workspace-bound or definition-pinned Sessions. Legacy unbound built-in Sessions omit it because their execution uses the deployment policy. Missing metadata on an older provider means the UI cannot claim a policy or expose a selector. Existing create callers and saved pending requests remain compatible.

## Browser integration

ChatEditor gains an optional available-mode list; absent means the current Local choices. Managed creation loads effective options for the selected Agent, chooses the server default, and sends the selected mode with both empty and initial-prompt Session creation. Agent/model changes refresh options without losing the prompt or Workspace. Stale async option results cannot overwrite the current Agent's selection. Loading or invalid supported options block creation; servers without the capability keep the existing behavior.

The pending Session creation record freezes the chosen policy before network effects and restores it after refresh. An old pending record without a mode retains that omission. If the server loses the capability, an explicit-mode request without a known Session ID cannot be resent; a known Session ID can be read back only with a matching policy. Once a Session exists, its composer shows the read-back policy with mode controls disabled. Existing approval Actions continue through the shared card and durable response operation; approval and rejection must be verified by actual tool effects.

## Affected areas

| Area                            | Change                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Java WebShell API/service/store | Effective options query, optional creation mode, digest/admission validation, persisted summary |
| OpenAPI and generated client    | Optional request/summary fields, option response and capability                                 |
| Shared editor                   | Optional filtering of approval modes, preserving Local defaults                                 |
| Managed provider and UI         | Server options, frozen selection, fixed current policy and existing approval cards              |
| Tests and documentation         | Admission/replay/unsupported-mode tests, browser permission effects and experience instructions |

## Acceptance criteria

1. Server and UI agree on available modes; auto/plan are refused, and Shell+yolo is refused even for crafted requests.
2. Default asks before a file write; before approval the target file is absent. Denial leaves it absent, approval creates the exact expected file.
3. Auto-edit executes the same permitted file write without a card; Shell still presents a permission Action.
4. The saved Session mode survives refresh; an existing Session cannot change it. Pending retries preserve the original mode and idempotency key.
5. Local mode, model/Workspace choices, draft retention, empty creation, and old providers/pending records retain their prior behavior. Hidden Managed controls do not capture Local interaction.
6. Build, typecheck, focused tests, paired documentation, self-audit and independent review complete before delivery. Browser acceptance uses native file evidence rather than model claims.

## Open questions

None for the supported-mode scope. Expanding Hosted policy capabilities requires separate backend work.
