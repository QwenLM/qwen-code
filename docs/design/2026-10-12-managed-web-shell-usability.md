# Managed Agent standard Web Shell UI

[中文版本](2026-10-12-managed-web-shell-usability.zh-CN.md)

## Problem and current state

Managed Agent has its own textarea/send form and Workspace creation form. Users cannot follow the standard Web Shell welcome/composer flow, and Java creation does not expose a host-owned model preset choice. Standard Web Shell already has a welcome header, message list, composer, model menu and Workspace selector.

The Java provider already offers tenant/actor-authorized Workspace list/get, empty bound Session creation, transcript, Actions, cancellation and revision-checked cwd operations. Its existing create API accepts initial input and pins an AgentDefinition. This feature reuses that contract and UI, without changing Java routes or schemas.

## Proposed behavior

New Java bound Sessions use the existing WelcomeHeader, ChatEditor, native model menu and Workspace context row with the existing App layout classes. The user explicitly chooses an authorized Workspace, an optional relative directory and a model preset, then sends the first task. One create request admits both Session and initial Turn; no extra submit follows creation.

Conversation pages use the existing MessageList and ChatEditor layout. Managed owns admission, permission Actions, cancellation, progress, transcript paging, cwd and tool-result consumers. An empty loaded conversation shows the standard welcome header. Existing Sessions keep their original Workspace and AgentDefinition; another model or Workspace requires a new Session.

## Ownership and model choices

The host may supply `modelPresets`, an array of AgentDefinition IDs and presentation labels, through ManagedAgentWebShell or the Java provider. Each selectable ID must already be published and allowed by Java. The default Agent remains available. Labels do not establish the model actually executed; Java pins the definition revision/digest and performs admission. The browser sends no raw model override or model credentials.

Workspace options come only from authorized Java list/get responses. IDs are opaque, including legal values such as `__standalone__`; the standard selector treats its projectless sentinel specially only when that capability is enabled. Even a sole Workspace remains explicitly selectable. No daemon filesystem discovery or primary-Workspace fallback is introduced.

## Admission, retries and drafts

Before the first request, persist the frozen Agent ID, Workspace ID, relative directory, input, client ID and idempotency key in the existing scoped pending record. A lost response retries that exact request. Once a Session ID is saved, retries read it back without resubmitting input. Verify returned Session, Agent and Workspace identity before selecting it and clearing the owning editor. Preserve previous empty pending records and older providers without initial-input creation.

Later conversation input uses the existing Managed pending-command flow. Clear a draft only after admission and only for the editor that owns that attempt. Retrying Session A while viewing Session B must preserve B's draft. Abandoning local confirmation restores the owning prompt and does not delete server state. Same-identity credential refresh keeps pending commands; tenant/actor scope changes remount and abort the old command lifetime.

Shared composer options disable Shell mode and legacy history fallback for Managed. Focused/global bang shortcuts remain literal input, direct Shell setters cannot enable it, and mobile Shell controls stay hidden. Ordinary Web Shell retains current defaults. Managed also disables daemon attachments, file mentions, slash commands, mode overrides, Git and voice controls.

## Files and integration

| Area                                           | Change                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Managed page and creator                       | Reuse standard components and layout; bind native menus to Java identity and frozen admission.               |
| Java provider and provider interface           | Add optional preset data and initial-input bound creation; preserve Agent identity in Session summaries.     |
| Shared editor, composer and Workspace selector | Add populated opt-out/visibility options with compatible defaults; guard projectless sentinel by capability. |
| Standalone wrapper                             | Forward host presets without a daemon context; reuse the standard app frame and theme sizing tokens.         |
| Development entry                              | Parse explicit Workspace opt-in, model presets and optional trusted local actor identity.                    |
| Tests and documentation                        | Cover actual menus/editor, HTTP payloads, retries, drafts and compatibility; document host setup.            |

Local Vite development can opt in with `managedWorkspace=1` or `VITE_MANAGED_AGENT_WORKSPACE_BINDING=true`; presets come from `VITE_MANAGED_AGENT_MODEL_PRESETS`. An optional `VITE_MANAGED_AGENT_ACTOR_ID` joins tenant identity in storage scope and uses the existing trusted actor header. This header configuration is only appropriate for a trusted loopback development deployment. Production hosts supply authenticated headers and product scope themselves.

## Scope and constraints

No Java source/API/schema, approval policy, model discovery contract, Workspace registration, administrative script, Vite management endpoint, Runtime provisioning, live model switch or child-agent task panel is included. Existing file execution still needs separately configured Java/Broker/Harness mounts and authorization. Local macOS demo execution does not prove production isolation, durable Linux recovery or MySQL failure recovery.

## Validation and acceptance

Run focused package tests for creation, provider, wrapper, conversation, native selector, shared editor/core and development options; run repository build/typecheck/bundle and changed-file static checks. Exercise browser creation with explicit authorized selection, model presets, literal bang/Enter/Shift+Enter, one initial create and no duplicate submit, response-loss retry, accepted read-back retry, foreign draft preservation and a narrow viewport. Use deterministic transport for failure injection and identify it as mock evidence.

Record before/after UI evidence from the unchanged main baseline and extracted implementation. Historical real Java/model execution remains separately attributed to the local demo, not inherited as exact-head PR verification. Do not alter the user's existing local service, database or conversation to collect new evidence.

## Open questions

None for this slice. Model discovery, live model changes and formal Workspace management need separate contracts and work.

## UI evidence

The exact main baseline and extracted implementation use the same isolated dark host and deterministic authorized Java transport. These screenshots establish browser presentation, not real backend/model execution.

![Before: separate Workspace form](assets/managed-webshell-usability-before.png)

![After: standard welcome and composer](assets/managed-webshell-usability-after.png)

![After: narrow viewport](assets/managed-webshell-usability-narrow.png)
