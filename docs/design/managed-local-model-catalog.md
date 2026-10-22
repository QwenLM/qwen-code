# Local Managed model catalog

[English](managed-local-model-catalog.md) | [简体中文](managed-local-model-catalog.zh-CN.md)

## Problem and scope

The local `qwen serve --managed` adapter inherits the user's model configuration for Hosted Harness execution, but neither configures the Java model catalog nor supplies new-task model presets. The UI therefore shows only the server default despite configured local models. Main already supplies both Java contracts. This change connects the local launcher to them; it adds no Java API, provider credential transport, remote provisioning behavior, or changes to existing Sessions.

## Design

At startup, load the same deployment settings as the Hosted Harness: honor the selected `QWEN_HOME`, system settings and provider protocol declarations; ignore workspace settings and environment-file loading. Use the existing model registry to resolve configured routes. Include conversation models with exactly one matching ID across all registry protocols/routes, excluding the built-in OAuth catalog and specialized fast/image/voice/vision models. Resolve the default with the existing CLI generation-config resolver, including auth type and environment precedence. Put a uniquely matching model first; otherwise include the built-in `qwen-code` default preset so other configured providers cannot silently replace the current default. Keep the remaining models in configuration order. No configured models retains the existing default option. IDs shared by routes are excluded because the existing Hosted model pin intentionally refuses ambiguous IDs.

Pass only `{modelId,label}` entries and allowed model IDs to Java through a launcher-owned `SPRING_APPLICATION_JSON` array. Allow the existing `hosted-workspace-shell/1` definition profile. The launcher continues to filter inherited Spring and Managed server overrides and keeps the signed loopback boundary.

After readiness, create one immutable AgentDefinition per model using the existing signed `POST /v1/agents` API. Its content includes only the model ID, empty instructions, the shell tool profile and default asking policy. Derive the idempotency key from that exact content so restarts and label changes reuse the stored definition. A failed or malformed admission aborts startup, rather than advertising a choice that cannot execute. Definitions are created only by the launcher; the browser proxy does not expose management routes.

The authenticated, same-origin `/managed/boot` response supplies `{agentId,label}` presets. The standalone client validates them and forwards them to the existing provider. New tasks pin the chosen definition. Existing Sessions use the separate Java Session model catalog and its idle/revision/Workspace-grant gates. Model pin resolution and cached credentials remain in Hosted Harness. Credentials, provider URLs and signing material are absent from the boot response, definitions and model catalog.

## Constraints and risks

The catalog is a startup snapshot; reload configuration by restarting the local service. Cached credentials are checked by existing execution logic, not by making provider requests at startup. Built-in OAuth-only models and ambiguous model IDs retain the existing default execution path but are not explicit choices. Removing a configured model does not rewrite historical definitions or Sessions; execution fails closed if a historical pin no longer resolves. Runtime workers retain their isolated `QWEN_HOME`; this change copies no settings or credentials into it. Browser storage and product identity remain unchanged.

## Validation and acceptance

Focused tests cover local settings scope, protocol routing and ambiguous IDs, specialized-model filtering, selected-model ordering, metadata-only serialization, signed idempotent registration, failed admission, and boot validation. Build, typecheck and run the affected package tests. In an isolated deployment using two controlled model endpoints, select B for a new task and observe `request.model=B`, switch the idle Session to A and observe the next `request.model=A`, then reread the selection after refresh and a new service cohort. Verify catalog/boot output contains no provider endpoint or secret and an unauthenticated browser cannot fetch boot. Update the existing local preview only after validation and confirm its original Workspace/Session data survives.
