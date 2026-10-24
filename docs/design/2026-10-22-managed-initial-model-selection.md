# Model selection at Managed Workspace creation

[English](2026-10-22-managed-initial-model-selection.md) | [简体中文](2026-10-22-managed-initial-model-selection.zh-CN.md)

## Problem

The local launcher registered one custom AgentDefinition per configured model, with a compiled `default` approval policy. This made model selection restrict the new-task permission menu to `default`, although built-in `qwen-code` supports `default`, `auto-edit` and `yolo`.

## Decision

Publish local model presets as `{agentId: "qwen-code", modelId, label}`. Keep legacy `{agentId, label}` presets compatible. Selecting a model changes `modelId`, independently of Agent identity and approval mode. Existing stored definitions and Sessions retain their original identity and policy; no data migration is required.

Add optional `modelId` to bound WebShell creation and advertise `modelSelectionSupported` in Session options. Require built-in `qwen-code`, the existing Harness model-selection capability, and an exact host-catalog entry. Reject an unsupported choice before admission. Missing capability means the client cannot submit a catalog model. Preserve omitted-field request digests and default behavior.

Freeze the chosen model in the persisted client creation intention and server idempotency digest. In the existing creation transaction, write `model_id` and `model_revision=1` before inserting the first Turn, which snapshots that selection alongside approval. Empty Sessions also retain it. Same-key retries return the original admission before current capability gates; changed model content conflicts. Read back Agent, Workspace, model and initial approval before clearing the draft.

## Scope and risks

Reuse existing model-catalog validation, actor/Workspace checks, Turn snapshots and Harness execution. Do not replace an existing Session, modify custom-definition creation policy, change runtime authority, or create multiple requests that could send the first Turn before model/approval selection. Keep local definition allowlists for previously created custom Sessions. The new optional fields require a compatible control plane and frontend; update the local preview with matched artifacts.

## Verification

Verify two deterministic models under all three approval modes, including the first Turn's model and approval snapshots. Cover empty creation, omitted `modelId`, unknown models, missing capabilities, actor/Workspace refusal, frozen retry identity and different-body conflict. Exercise the UI model and permission selectors together, draft retention and readback, and confirm legacy custom presets remain supported. Run affected Java/TypeScript tests, API contract gates, build/typecheck/bundle, module verification and an isolated native smoke before updating the user preview.
