# Retire Managed Session directory switching

[English](2026-10-26-retire-managed-cwd-change.md) | [简体中文](2026-10-26-retire-managed-cwd-change.zh-CN.md)

## Problem

The Managed conversation currently exposes a Change directory action that the normal daemon WebShell does not offer. Workspace and initial working directory already identify where a new Session runs. The user requested removing this extra action and any backend submission code without other business callers.

## Decision

Remove new Managed Session directory-change admission through the conversation UI and both public/WebShell cwd submission APIs. Repository-wide call tracing finds the WebShell path is the only in-repository production caller; the public API has no SDK or business consumer. The daemon/ACP changeSessionCwd mechanism has independent callers in Live, standalone/resume and child Session flows and is retained.

Creation-time cwdRelative, standalone directory display, context revisions, Workspace validation and execution bindings remain. The home conversation omits the extra Workspace/directory/model/runtime summary row; the composer keeps its model selector. Existing durable CWD_CHANGE operations may outlive a UI deployment: retain their record vocabulary, operation query/projection, coordinator settlement, recovery and admission fences until those original operations settle. Retire unused new-operation methods rather than deleting historical operation data or silently cancelling work. No schema migration or history rewrite is required.

## Implementation and validation

Remove the frontend control, hook and unused provider/client submit wiring and translated action strings; keep standalone directory display and creation references. Remove the home summary row and its unused styling. Remove the two Java submission controller mappings, request DTOs and new admission helpers. Withdraw the advertised cwdChange capability, update OpenAPI and generated consumers, and keep old-operation response schemas still used by generic operation queries. Update surface/capability contracts and replace obsolete new-admission tests with focused removed-route and historical-settlement coverage.

The focused plan is `.qwen/e2e-tests/remove-managed-directory-change/plan.md`. Verify absent controls even with an older capable backend, preserved completed history and creation behavior, removed route contracts and retained historical operation settlement. Build and typecheck TypeScript, run affected Java/contract checks under the module budget, and review the full diff. Build independently of live previews. A UI-only front-door refresh against the original Java process proves frontend behavior only; removed backend endpoints require a matching new Java build or isolated controller checks and are reported separately.

## Scope

This change does not remove Workspace-local import, file upload, directory listing, tool-level working directories, daemon relocation, historical operation records or recovery. No new setting, compatibility shim or speculative replacement UI is added.

Follow-up: remove the deprecated, always-false `cwdChange` response field only after historical operations have drained and remaining consumers have migrated, as a separately versioned contract change.
