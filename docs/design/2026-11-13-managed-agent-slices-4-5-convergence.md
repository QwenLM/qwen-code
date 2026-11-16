# Managed Agent Server Slices 4 & 5 Implementation Design

[English](2026-11-13-managed-agent-slices-4-5-convergence.md) | [简体中文](2026-11-13-managed-agent-slices-4-5-convergence.zh-CN.md)

- Status: **In Progress (Step 4c; 4a/4b complete)**
- Date: 2026-11-13
- Scope: `packages/managed-agent-server/**`, `packages/web-shell/**`, `packages/cli/src/serve/**`, `integration-tests/**`, `.github/workflows/**`, `scripts/**`
- Related: implements Slices 4 and 5 of pre-production convergence; amends [Managed Agent Server Maven modules](2026-10-29-managed-agent-maven-modules.md) in Step 5a.

## Problem Statement

After Tier-1 pre-production convergence landed (`#17044`, `#17047`, `#17058`, `#17064`, `#17072`, `#17075`), two large structural duplications remain in `managed-agent-server`:

1. **Dual external API surfaces (`Public` `/v1/agents/**`vs`WebShell` `/api/agent/web-shell/v1/**`).** `SurfaceRegistry` declares 92 `PUBLIC_*` routes and 92 `WEBSHELL_*` routes, backed by 22 `Public*` (`snake_case`) and 67 `WebShell*` (`camelCase`) DTO records in `ApiModels` plus 145 `WebShell*` OpenAPI schemas. While 63 `WEBSHELL_*` routes have 1:1 `PUBLIC_*` twins, 29 `WEBSHELL_*` routes either have no `/v1/agents/**` counterpart (23 routes) or overlap asymmetrically (6 routes), and `PublicSession` omits interactive projection fields (`title`, `environment`, `approval_mode`, `model_selection`, `model_context`, `lifecycle_operation`, and interactive capability flags).
2. **Micro-module fragmentation and single-implementation interface mirrors.** The Maven reactor splits 14 modules where 7 `runtime-*` modules pull zero exclusive vendor SDKs and `persistence` + `control-plane` are artificially separated across `contracts`, manufacturing 24 read-only `*Settings` mirror interfaces and ~28 intra-module single-implementation `*Store`/`*Repository` interfaces enforced by `ClassSizeRatchetTest` and `ModuleArchitectureTest`.

## Locked Decisions

| ID   | Decision                                                                                                                                                                                                    | Consequence                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| S4-1 | Staged execution (`4a -> 4b -> 4c -> 5a -> 5b`), each step independently verifiable and mergeable.                                                                                                          | Avoids unreviewable cross-language mega-diffs; Step 4a is purely additive on `/v1/agents/**`.                                         |
| S4-2 | Unified REST + `snake_case` + `Idempotency-Key` header on `/v1/agents/**`; reuse existing `POST/GET /v1/agents/sessions/{sessionId}/events` for turn submit, turn cancel, and SSE streaming.                | No `POST .../query` `camelCase` RPC endpoints are copied onto `/v1/agents/**`.                                                        |
| S5-1 | Delete `ClassSizeRatchetTest` (`class-size-ratchet.properties`) and fold `runtime-external` into `runtime-broker` alongside the other `runtime-*` modules rather than dropping external-runtime capability. | Eliminates artificial class-splitting interface proliferation while preserving active `external-workspace` work (`#15684`, `#16023`). |
| S5-2 | Do not modify the upper-layer `data-agent` repository in this round; record an exact host migration table here.                                                                                             | `qwen-code` lands cleanly first; `data-agent` updates imports and DTOs when bumping its embedded preview dependency.                  |

## Current State (Verified Against `7fb3668355`)

- **Routes:** 208 `SurfaceRegistry` entries (`92` `PUBLIC`, `92` `WEBSHELL`, `24` `INTERNAL`).
- **OpenAPI (`v1.117.0`):** 168 paths (`76` `/v1/**`, `92` `/api/agent/web-shell/v1/**`), 315 schemas (`145` `WebShell*`, `42` `Public*`).
- **Downstream WebShell consumers in `qwen-code`:** `packages/web-shell` (40 files; `generate-managed-agent-api.mjs` filters `tags.includes('WebShell')`), `packages/cli` (4 local-proxy files), `integration-tests` (2 SSE helper files), `scripts` (2 qualification files), `verification/src/test` (41 Java test files).
- **Maven modules:** 14 modules (`contracts`, `control-plane`, `persistence`, `runtime-broker`, `runtime-http`, `runtime-host`, `runtime-local`, `runtime-external`, `runtime-kubernetes`, `runtime-ssh`, `runtime-static`, `adapters`, `server`, `verification`).

## Goals and Non-Goals

### Goals

- Make `/v1/agents/**` a complete interactive superset of `/api/agent/web-shell/v1/**` in Step 4a, migrate TS/UI consumers in Step 4b, and delete the entire WebShell API arm in Step 4c.
- Collapse the 14-module reactor to 6 modules (`contracts`, `runtime-broker`, `control-plane`, `adapters`, `server`, `verification`) in Step 5a and remove the 24 `*Settings` mirror interfaces plus intra-module single-implementation store interfaces in Step 5b.
- Preserve every security, durability, fencing, and host-embedding invariant.

### Non-Goals

- Changing SQL schema (`V1__managed_schema.sql`), runtime broker wire protocols (`v2`/`v3`/`v4`), or `RuntimeBrokerHttpServer`.
- Modifying `data-agent` in this round.

## Proposed Solution

### Staged Execution Plan

1. **Step 4a — Additive Public API Parity (`packages/managed-agent-server`, `packages/cli` parity gate):**
   - Enrich `CreateSessionRequest`, `PublicSession`, `SessionCapabilities`, `PublicTaskList`, and `WorkspaceDiscoveryController` Public DTOs (`snake_case`).
   - Add 25 RESTful `/v1/agents/**` endpoints covering all WebShell-only and asymmetric capabilities (see exact mapping below), sharing identical `RuleClass`, `Capability`, `TenantContext` (`actorId()` / `requireActorId()`), and service-layer ownership checks.
   - Bump `managed-agent-public-api.openapi.json` (`1.117.0 -> 1.118.0`), register all 25 routes in `SurfaceRegistry`, regenerate `managed-surface.txt`, and update `ManagedAgentApiContractTest` + `SurfaceAdmissionAcceptanceTest`.
   - **Done (2026-11-15/16)**: batches 1–3 (`b0c4c8fe34` / `5596d351d7` / `66054808ae`, 1.118.0→1.120.0) + batch 4 shape enrichment (`3fdf1ed142`, 1.121.0) + b0 semantic alignment (`9aa0ffe001`, 1.122.0: `latest_turn`, `recovery_blocked` synthesis, capability conjunct alignment, worktree tags).
2. **Step 4b — Consumer Migration (`packages/web-shell`, `packages/cli`, `integration-tests`, `scripts`):**
   - Switch `generate-managed-agent-api.mjs` from `WebShell` operations to `Public` operations (`Public Sessions` / `Public Resources`), migrate `java-managed-agent-client.ts`, `managed-client-files-bridge.ts`, unit tests, Playwright fixtures, CLI serve proxy, and SSE integration helpers to `/v1/agents/**`.
   - **Done (2026-11-16)**: b1 (`26f69b8064`, CLI proxy dual prefix + bootstrap + qualification scripts) + b2 (`b5e062331e`, Public-only generator + 106 frozen contract types + 85-method boundary adapter + 12 Playwright specs + all unit suites). The `integration-tests` SSE helpers test both server surfaces and migrate in 4c as planned. See the [4b implementation plan and record](../plans/2026-11-15-managed-webshell-consumer-migration.md).
3. **Step 4c — Remove WebShell Surface (`packages/managed-agent-server`, `packages/cli`):**
   - Delete all 92 `/api/agent/web-shell/v1/**` controller mappings (`WebShellAgentController`, `WebShellSkillsController`, `ManagedToolDetailsController` WebShell route, and dual WebShell arms), 92 `WEBSHELL_*` `SurfaceRegistry` entries, 67 `WebShell*` records in `ApiModels`, and 145 `WebShell*` OpenAPI schemas; migrate remaining Java tests in `verification/src/test` to `/v1/agents/**`.
4. **Step 5a — Maven Module Consolidation (14 -> 6 modules) & Ratchet Removal:**
   - Merge `persistence` into `control-plane`; merge `runtime-http`, `runtime-host`, `runtime-local`, `runtime-external`, `runtime-kubernetes`, `runtime-ssh`, and `runtime-static` into `runtime-broker` (consolidating `META-INF/services/...RuntimeProviderFactory`).
   - Delete `ClassSizeRatchetTest` and `class-size-ratchet.properties`.
   - Update `ModuleArchitectureTest`, `ManagedAgentPackagingIT`, `RuntimeProviderPluginsTest`, `.github/workflows/{sdk-java,verify-maven-repo,sdk-java-flyway-open-prs}.yml`, `scripts/check-flyway-open-prs.js`, and workflow meta-tests; amend `2026-10-29-managed-agent-maven-modules(.zh-CN).md`.
5. **Step 5b — Eliminate `*Settings` Mirrors & Intra-Module Single-Impl Store Interfaces:**
   - Replace `ManagedAgentSettings` (21 interfaces) and `SshSettings` (3 interfaces) with pure Java config POJOs bound via Spring Boot `@ConfigurationProperties` in `server`, keeping `contracts` free of Spring imports.
   - Collapse ~28 intra-`control-plane` single-implementation `*Store`/`*Repository` interfaces while keeping cross-module ports (`adapters`, `runtime-broker`, `server`) and genuine host SPIs (`ManagedExtensionSource`, `ExtensionArchiveStorage`, `ToolPublicationObjectStore`, `MemoryProvider`).

### Complete 29-Route WebShell-to-Public Mapping (Step 4a)

#### A. Covered by Existing `/v1/agents/**` Endpoints (4 routes — no new route added)

| WebShell Entry          | Existing Public Endpoint                                                 | Notes                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBSHELL_TURN_SUBMIT`  | `POST /v1/agents/sessions/{sessionId}/events` (`PUBLIC_TURN_EVENTS`)     | `type = "agent.session.input.message"`, `Idempotency-Key` header, returns `202 CommandAdmission`.                                                               |
| `WEBSHELL_TURN_CANCEL`  | `POST /v1/agents/sessions/{sessionId}/events` (`PUBLIC_TURN_EVENTS`)     | `type = "agent.session.cancel"`, `turn_id` required, `Idempotency-Key` header, returns `202 CommandAdmission`.                                                  |
| `WEBSHELL_EVENT_STREAM` | `GET /v1/agents/sessions/{sessionId}/events` (`PUBLIC_EVENT_LIST`)       | `stream=true` or `Accept: text/event-stream`, cursor via `Last-Event-ID` or `after`, emits `PublicEvent` (`created_at` in seconds) and `SessionResyncRequired`. |
| `WEBSHELL_SESSION_MCP`  | `GET /v1/agents/sessions/{sessionId}/mcp-catalog` (`PUBLIC_MCP_CATALOG`) | Already returns identical `PublicMcpCatalog` JSON; enforces actor ownership on `owner_only`/workspace sessions.                                                 |

#### B. 25 New `/v1/agents/**` Public Endpoints Added in Step 4a

| `SurfaceRegistry` Constant            | HTTP Method & Path                                                | `RuleClass`                    | `Capability`                   | Auth & Request/Response Summary                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_CLIENT_FILES_REGISTER`        | `POST /v1/agents/sessions/{sessionId}/client-files/register`      | `CLIENT_FILES_OPERATOR`        | `CLIENT_FILES_REGISTER`        | `requireActorId()`; body `{connection_id}` -> `200 PublicClientFilesRegistrationAck` (`snake_case`, `no-store`)                                                                        |
| `PUBLIC_CLIENT_FILES_UNREGISTER`      | `POST /v1/agents/sessions/{sessionId}/client-files/unregister`    | `CLIENT_FILES_OPERATOR`        | `CLIENT_FILES_UNREGISTER`      | `requireActorId()`; body `{connection_id}` -> `200 PublicClientFilesStatus` (`no-store`)                                                                                               |
| `PUBLIC_CLIENT_FILES_STATUS`          | `GET /v1/agents/sessions/{sessionId}/client-files`                | `CLIENT_FILES_ACTOR`           | `CLIENT_FILES_STATUS`          | `requireActorId()`; query `connection_id` -> `200 PublicClientFilesStatus` (`no-store`)                                                                                                |
| `PUBLIC_CLIENT_FILES_STREAM`          | `GET /v1/agents/sessions/{sessionId}/client-files/requests`       | `CLIENT_FILES_ACTOR`           | `CLIENT_FILES_STREAM`          | `requireActorId()`; query `generation`, `connection_id` -> `200 text/event-stream`                                                                                                     |
| `PUBLIC_CLIENT_FILES_RESPOND`         | `POST /v1/agents/sessions/{sessionId}/client-files/responses`     | `CLIENT_FILES_ACTOR`           | `CLIENT_FILES_RESPOND`         | `requireActorId()`; body `{generation, connection_id, rpc_request_id, response_json, error_code}` -> `200 {settled}`                                                                   |
| `PUBLIC_RUNTIME_NODE_LIST`            | `GET /v1/agents/runtime-nodes`                                    | `RUNTIME_NODE_ACCESS`          | `RUNTIME_NODE_LIST`            | `requireActorId()`; `200 PublicRuntimeNodeList` (`no-store`)                                                                                                                           |
| `PUBLIC_WORKSPACE_DIRECTORY_CHECK`    | `POST /v1/agents/runtime-nodes/{nodeId}/check-directory`          | `RUNTIME_NODE_ACCESS`          | `WORKSPACE_DIRECTORY_CHECK`    | `requireActorId()`; body `{path}` -> `200 PublicSshDirectory` (`no-store`)                                                                                                             |
| `PUBLIC_WORKSPACE_REGISTER`           | `POST /v1/agents/workspaces/registrations`                        | `RUNTIME_NODE_ACCESS`          | `WORKSPACE_REGISTER`           | `requireActorId()`, `Idempotency-Key` header; body `{node_id, path, display_name}` -> `202 PublicWorkspaceRegistrationOperation`                                                       |
| `PUBLIC_WORKSPACE_REGISTRATION_GET`   | `GET /v1/agents/workspaces/registrations/{operationId}`           | `WORKSPACE_REGISTRATION_OWNER` | `WORKSPACE_REGISTRATION_GET`   | `requireActorId()`; `200 PublicWorkspaceRegistrationOperation` (`no-store`)                                                                                                            |
| `PUBLIC_WORKSPACE_CREATE`             | `POST /v1/agents/workspaces`                                      | `WORKSPACE_ALLOCATION`         | `WORKSPACE_CREATE`             | `requireActorId()`, `Idempotency-Key` header; body `{display_name, source_workspace_id, cwd_relative, local_path}` -> `200 PublicWorkspaceSummary`                                     |
| `PUBLIC_WORKSPACE_DIRECTORIES`        | `GET /v1/agents/workspaces/directories`                           | `WORKSPACE_ALLOCATION`         | `WORKSPACE_DIRECTORIES`        | `requireActorId()`; query `workspace_id`, `cwd_relative`, `local_path` -> `200 PublicWorkspaceDirectoryList`                                                                           |
| `PUBLIC_WORKSPACE_FILES_QUERY`        | `GET /v1/agents/workspace-files`                                  | `WORKSPACE_FILES`              | `WORKSPACE_FILES_QUERY`        | `requireActorId()`; query `session_id`, `workspace_id`, `cwd_relative`, `directory`, `query`, `expected_scope_revision` -> `200` (`snake_case`, `no-store`)                            |
| `PUBLIC_WORKSPACE_FILES_READ`         | `GET /v1/agents/workspace-files/content`                          | `WORKSPACE_FILES`              | `WORKSPACE_FILES_READ`         | `requireActorId()`; query `session_id`, `workspace_id`, `cwd_relative`, `path`, `expected_scope_revision` -> `200` (`snake_case`, `no-store`)                                          |
| `PUBLIC_WORKSPACE_FILES_UPLOAD`       | `POST /v1/agents/workspace-files/uploads`                         | `WORKSPACE_FILES`              | `WORKSPACE_FILES_UPLOAD`       | `requireActorId()`; `application/octet-stream`, query `session_id`, `workspace_id`, `cwd_relative`, `path`, `expected_scope_revision`, `upload_id` -> `200` (`snake_case`, `no-store`) |
| `PUBLIC_WORKSPACE_FILES_UPLOAD_QUERY` | `GET /v1/agents/workspace-files/uploads/{uploadId}`               | `WORKSPACE_FILES`              | `WORKSPACE_FILES_UPLOAD_QUERY` | `requireActorId()`; `200` (`snake_case`, `no-store`)                                                                                                                                   |
| `PUBLIC_SESSION_OPTIONS`              | `GET /v1/agents/session-options`                                  | `SESSION_OPTIONS`              | `SESSION_OPTIONS`              | `requireActorId()`; query `agent_id` -> `200 PublicSessionOptions` (`no-store`)                                                                                                        |
| `PUBLIC_SESSION_MODELS`               | `GET /v1/agents/sessions/{sessionId}/models`                      | `READER_ACTOR`                 | `SESSION_MODELS`               | `requireActorId()`; `200 PublicSessionModels`                                                                                                                                          |
| `PUBLIC_SESSION_MODEL_CHANGE`         | `POST /v1/agents/sessions/{sessionId}/models`                     | `OPERATOR`                     | `SESSION_MODEL_CHANGE`         | `requireActorId()`, `Idempotency-Key` header; body `{model_id, expected_revision}` -> `200 PublicModelChangeResult`                                                                    |
| `PUBLIC_SESSION_APPROVAL`             | `GET /v1/agents/sessions/{sessionId}/approval`                    | `READER_ACTOR`                 | `SESSION_APPROVAL`             | `requireActorId()`; `200 PublicSessionApproval`                                                                                                                                        |
| `PUBLIC_SESSION_APPROVAL_CHANGE`      | `POST /v1/agents/sessions/{sessionId}/approval`                   | `OWNER`                        | `SESSION_APPROVAL_CHANGE`      | `requireActorId()`, `Idempotency-Key` header; body `{approval_mode, expected_revision, plan_mode, permission_rules}` -> `200 PublicApprovalChangeResult`                               |
| `PUBLIC_SESSION_SKILLS`               | `GET /v1/agents/sessions/{sessionId}/skills`                      | `READER_ACTOR`                 | `SESSION_SKILLS`               | `requireActorId()`; `200 PublicSessionSkills` (`no-store`)                                                                                                                             |
| `PUBLIC_TRANSCRIPT`                   | `GET /v1/agents/sessions/{sessionId}/transcript`                  | `READER`                       | `TRANSCRIPT_QUERY`             | `actorId()`; query `cursor`, `limit` -> `200 PublicTranscript`                                                                                                                         |
| `PUBLIC_TRANSCRIPT_ITEMS`             | `GET /v1/agents/sessions/{sessionId}/transcript/items`            | `READER`                       | `ITEM_LIST`                    | `actorId()`; query `cursor`, `limit` -> `200 PublicItemList`                                                                                                                           |
| `PUBLIC_SESSION_EXPORT`               | `GET /v1/agents/sessions/{sessionId}/export`                      | `READER`                       | `ITEM_LIST`                    | `actorId()`; query `cursor`, `limit` -> `200 PublicItemList`                                                                                                                           |
| `PUBLIC_TOOL_DETAILS_GET`             | `GET /v1/agents/sessions/{sessionId}/items/{itemId}/tool-details` | `READER_ACTOR`                 | `TOOL_RESULT_GET`              | `requireActorId()`; `200 PublicToolDetails` (`private, no-store`)                                                                                                                      |

### `PublicSession` & Request Model Enrichments (Step 4a)

- **`CreateSessionRequest`:** add optional `title`, `approval_mode`, `plan_mode`, `model_id`, and annotate `extension_pins` consistently.
- **`PublicSession`:** add optional `title`, `environment`, `approval_mode`, `approval_revision`, `initial_approval_mode`, `plan_mode`, `plan_mode_supported`, `model_context` (`PublicModelContext`), `model_selection` (`PublicModelSelection`), and `lifecycle_operation` (`PublicLifecycleOperation`), populated in `ManagedAgentService.publicSessions(records, actorId)` using the same batched queries as `webShellSessions`. Keep `created_at` / `updated_at` in epoch seconds per existing Public API convention.
- **`SessionCapabilities`:** add `workspace_turns`, `cwd_change`, `model_change`, `approval_mode_change`, `input_attachments`, `rename`, `client_files`.
- **`PublicTaskList`:** return `PublicTaskList` (`object = "list"`, `data`, `next_cursor`, `has_more`, `active_child_count`) on `GET /v1/agents/sessions/{sessionId}/tasks`.
- **`WorkspaceDiscoveryController`:** extend `PublicItem` with `default_cwd_relative` and `can_select_directory`, and `PublicCapabilities` with `workspace_creation`, `approval_mode_selection`, `directory_selection`, and `local_directory_import` (`approval_mode_selection` mirrors WebShell's `approvalModeSelection`; an earlier draft misnamed it `workspace_listing`).

## Security and Ownership Invariants

- Every new `/v1/agents/**` route sits under `PublicSurface.covers(...)`, enforcing `SignatureAuthFilter` / `TrustedActorHeaderFilter` and `TenantContextFilter` (`X-Qwen-Tenant-Id` vs `AuthenticatedTenantActor` scope check -> `403 actor_scope_mismatch`).
- Every route delegates to the exact existing control-plane service method, preserving Service-layer horizontal ownership checks (`checkAccess` / workspace grant / session owner / creator-only rules) and returning `404` on cross-tenant or unauthorized resource probes.
- Workspace file routes (`PUBLIC_WORKSPACE_FILES_*`) declare `RuleClass.WORKSPACE_FILES` and remain strictly scoped to the resolved workspace/session grant without falling back to the primary runtime.

## Upper-Layer Host (`data-agent`) Migration Checklist (Deferred per S5-2)

When `data-agent` (`releases/20261112155816552_...`) upgrades past Steps 4c and 5b:

1. **DTOs (`ManagedRuntimeController`, `ManagedRuntimeService` + tests):** replace `ApiModels.WebShellSession`, `WebShellPage`, `WebShellSessionCapabilities`, `WebShellSessionModels`, `WebShellModelOption`, `WebShellModelChangeResult`, `WebShellSessionApproval`, `WebShellApprovalChangeResult`, `WebShellSessionSkills`, `WebShellSkill`, `WebShellRenameResult`, `WebShellCommandOperation`, `WebShellEvent`, `WebShellTranscript` with their `Public*` counterparts (`snake_case` JSON properties, epoch-second timestamps on `PublicSession`/`PublicEvent`).
2. **Packaging script (`.aoneci/managed-sdk/*/assemble-preview.py`):** update module count assertion (`13 -> 5` production jars) and schema path (`persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql` -> `control-plane/src/main/resources/db/managed-schema/V1__managed_schema.sql`).
3. **Internal imports (29 Java files):** update package imports for any collapsed intra-`control-plane` store interfaces in Step 5b (`ManagedAgentProperties` and `@Import(ManagedAgentConfiguration.class)` remain supported).

## Risks and Constraints

- **10-minute local Java verification budget:** batch all Step 4a edits cleanly before running focused Maven checks (`SurfaceRegistryGateTest`, `ManagedSurfaceCaptureTest`, `ManagedAgentApiContractTest`, `SurfaceAdmissionAcceptanceTest`, Checkstyle).
- **OpenAPI version uniqueness:** bump `info.version` monotonically (`1.117.0 -> 1.118.0`) and verify with `node scripts/check-contract-version.js`.

## Validation Plan and Acceptance Criteria

- **Step 4a local validation:**
  - `ManagedSurfaceCaptureTest` (`-Dcapability.parity.capture=true` then read-only verify), `SurfaceRegistryGateTest`, `ManagedAgentApiContractTest`, `SurfaceAdmissionAcceptanceTest`, plus `checkstyle:check` across all modules.
  - CLI parity test: `cd packages/cli && npx vitest run src/serve/capability-parity.test.ts`.
  - Contract version script: `git diff HEAD` + `check-contract-version` check.
- **Full gates:** full unit/H2 suite, SpotBugs, MySQL 8.4 integration, and Hosted profiles remain in CI; acceptance is pending until required CI gates pass.
