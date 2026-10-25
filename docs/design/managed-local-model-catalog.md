# Local Managed model catalog

[English](managed-local-model-catalog.md) | [简体中文](managed-local-model-catalog.zh-CN.md)

## Problem and scope

The local `qwen serve --managed` adapter inherits the user's model configuration for Hosted Harness execution, but neither configures the Java model catalog nor supplies new-task model presets. The UI therefore shows only the server default despite configured local models. Main supplies the Session model catalog and approval contracts. This change connects the local launcher to them and adds optional initial model selection to WebShell creation, as detailed in [the creation design](2026-10-22-managed-initial-model-selection.md). It adds no provider credential transport, remote provisioning behavior, or changes to existing Sessions.

## Design

At startup, load the same deployment settings as the Hosted Harness: honor the selected `QWEN_HOME`, system settings and provider protocol declarations; ignore workspace settings and environment-file loading. Use the existing model registry to resolve configured routes. Include conversation models with exactly one matching ID across all registry protocols/routes, excluding the built-in OAuth catalog and specialized fast/image/voice/vision models. Resolve the default with the existing CLI generation-config resolver, including auth type and environment precedence. Put a uniquely matching model first; otherwise include the built-in `qwen-code` default preset so other configured providers cannot silently replace the current default. Keep the remaining models in configuration order. No configured models retains the existing default option. IDs shared by routes are excluded because the existing Hosted model pin intentionally refuses ambiguous IDs.

Pass only `{modelId,label}` entries and allowed model IDs to Java through a launcher-owned `SPRING_APPLICATION_JSON` array. Allow the existing `hosted-workspace-shell/1` definition profile. The launcher continues to filter inherited Spring and Managed server overrides and keeps the signed loopback boundary.

Use the built-in `qwen-code` Agent for new local tasks. Publish each configured model as a separate `modelId`; do not register a custom AgentDefinition whose compiled asking policy would constrain the permission menu. Keep definition model/profile allowlists for existing custom Sessions, and keep management routes private.

The authenticated, same-origin `/managed/boot` response supplies `{agentId: "qwen-code",modelId,label}` presets. The standalone client validates unique model choices and forwards them to the provider, while legacy `{agentId,label}` presets remain supported. New tasks select the host-catalog model and approval independently; a capability-gated creation request persists both before its first Turn. Existing Sessions use the separate Java Session model catalog and its idle/revision/Workspace-grant gates. Model pin resolution and cached credentials remain in Hosted Harness. Credentials, provider URLs and signing material are absent from the boot response, definitions and model catalog.

## Constraints and risks

The catalog is a startup snapshot; reload configuration by restarting the local service. Cached credentials are checked by existing execution logic, not by making provider requests at startup. Built-in OAuth-only models and ambiguous model IDs retain the existing default execution path but are not explicit choices. Removing a configured model does not rewrite historical definitions or Sessions; execution fails closed if a historical pin no longer resolves. Runtime workers retain their isolated `QWEN_HOME`; this change copies no settings or credentials into it. Browser storage and product identity remain unchanged.

## Validation and acceptance

Focused tests cover local settings scope, protocol routing and ambiguous IDs, specialized-model filtering, selected-model ordering, metadata-only serialization, independent model/approval selection, atomic creation/replay, unsupported admission, and boot validation. Build, typecheck and run the affected package tests. In an isolated deployment using two controlled model endpoints, select B for a new task and observe `request.model=B`, switch the idle Session to A and observe the next `request.model=A`, then reread the selection after refresh and a new service cohort. Verify catalog/boot output contains no provider endpoint or secret and an unauthenticated browser cannot fetch boot. Update the existing local preview only after validation and confirm its original Workspace/Session data survives.
