# Managed Public API shape enrichment (slice 4a batch 4) implementation plan

[English](2026-11-15-managed-public-shape-enrichment.md) | [简体中文](2026-11-15-managed-public-shape-enrichment.zh-CN.md)

Status: planned; not started. Date: 2026-11-15. Baseline: `main` at `7fb3668355`. Branch: `feat/managed-agent-slice-4a-public-api-parity` (worktree `bright-oak-630bca`), which already carries four local, unpushed commits: `ffec8d4571` (slices 4/5 bilingual design), `b0c4c8fe34` / `5596d351d7` / `66054808ae` (25 additive Public routes, OpenAPI `1.120.0`, all four gates green). The [slices 4/5 design](../design/2026-11-13-managed-agent-slices-4-5-convergence.md) is the contract; this plan completes the half of slice 4a that was deferred: enriching the existing Public shapes so `/v1/agents/**` is a true superset of the WebShell surface. This is the hard prerequisite for slice 4b (migrating the web-shell client off `/api/agent/web-shell/v1/**`).

## 1. Why this batch exists

Slice 4a so far added 25 new Public endpoints but did not enrich the existing Public response shapes. The web-shell frontend reads `WebShellSession` fields that `PublicSession` does not yet carry: `title`, `environment`, `approvalMode`, `approvalRevision`, `initialApprovalMode`, `planMode`, `planModeSupported`, `modelContext`, `modelSelection`, `lifecycleOperation`. `SessionCapabilities` likewise lacks the interactive flags. Until these are present on the Public shapes, the frontend cannot move to `/v1/agents/sessions` without losing data. Do this batch before any consumer migration.

Scope rule: additive only. Keep every existing Public field, flag, status code and the existing Public capability computation unchanged; add the new fields/flags alongside. WebShell routes and records stay untouched. Each landed increment must keep the four gates and Checkstyle green.

## 2. The core difficulty: actor-scoped projection

`ManagedAgentService.publicSession` / `publicSessions` currently take no `actorId` and compute capabilities from visibility/retention gates only. The new fields and flags are actor-scoped and are produced by `webShellSessions` / `webShellSession` through batched reads. The enrichment must thread `actorId` into the Public projection and replicate those reads without regressing the existing Public flags.

Reference implementation to mirror (read it first): `ManagedAgentService.webShellSessions` (~line 1497) and `webShellSession` (~line 1602). The batched reads to replicate in `publicSessions`:

- `store.findLatestTurns(tenantId, ids)` (Public currently uses `findActiveTurns`; keep the existing active-turn field, add latest-turn only if a new field needs it).
- `store.findLatestEnvironmentEvents(tenantId, latestTurns)` → `environment`.
- `store.findApprovalOwners(tenantId, actorId, boundIds)` → lifecycle-owner gate.
- `store.findLatestLifecycleOperations(tenantId, ids)` → `lifecycle_operation`.
- `store.findApprovalSelections(tenantId, approvalIds)` → approval mode/revision/plan/rules.
- `store.findModelSelections(tenantId, boundIds)` and `store.findModelContexts(tenantId, boundIds)` → model fields.
- `submitterGrants(tenantId, actorId, grantWorkspaces)` + `store.sessionsWithExecutionRegistryFacts(tenantId, candidateIds)` + the `inputPolicy.maySubmitShape` / `mayChangeContextShape` / `mayCompressShape` candidate sets → the `maySubmit` / `mayChangeContext` conjuncts used by the new capability flags.

Call-site changes: `getPublicSession` → `publicSession(session, actorId)`; `listPublicSessions` → `publicSessions(page.sessions(), actorId, page.worktrees())`. Keep the zero-query short-circuits (empty page, no bound ids, null/empty actor) that `webShellSessions` uses.

## 3. Increments

Land these together as one coherent batch (records, service, OpenAPI and tests must agree for `recordsMatchTheirSchemas` and the route gates), then verify. They are listed in dependency order.

### 3.1 New Public records (`contracts/.../model/ApiModels.java`)

Add snake_case records mirroring their WebShell twins (field-for-field, `@JsonProperty` on every multi-word name):

- `PublicModelContext` ← `WebShellModelContext`.
- `PublicLifecycleOperation` ← `WebShellLifecycleOperation`.
- `PublicModelSelection` already exists (batch 3); reuse it.

Because these live in `ApiModels`, `recordsMatchTheirSchemas` auto-scans them: add a `RECORD_SCHEMAS` entry and an OpenAPI schema for each in the same batch.

### 3.2 `PublicSession` + `SessionCapabilities`

- `PublicSession`: add `title`, `environment` (`Map<String,Object>`), `approval_mode`, `approval_revision`, `initial_approval_mode`, `plan_mode`, `plan_mode_supported`, `model_context` (`PublicModelContext`), `model_selection` (`PublicModelSelection`), `lifecycle_operation` (`PublicLifecycleOperation`). Keep `@JsonInclude(NON_NULL)`; update `withRecovery` / `withWorktree`.
- `SessionCapabilities`: add `workspace_turns`, `cwd_change`, `model_change`, `approval_mode_change`, `input_attachments`, `rename`, `client_files`.
- Populate in `publicSession` exactly as `webShellSession` does: `environment` reuses the `webShellEnvironment(event)` mapping; approval/initial-approval are null for catalog Sessions (no workspace and no agent-definition digest); `plan_mode_supported` = `visible && approvalSupported && mayChangeContext && harness.supportsPlanMode() && store.supportsPlanMode(session)`; the new capability flags copy the `webShellSession` conjuncts (including the `approvalExecutable` guard and the `publicChild` suppression). Do not alter the existing Public flags.

### 3.3 `CreateSessionRequest`

Add optional `title`, `approval_mode`, `plan_mode`, `model_id` and wire them through `createSession` / `createWorkspaceSession` the way `WebShellCreateRequest` is handled. When all four are null, behavior must be byte-for-byte the current Public create.

### 3.4 Task list and workspace shapes

- `PublicTaskList`: expose `active_child_count` (mirror `WebShellTaskPage`); check `ManagedTaskService.listPublicTasks` and the Public tasks route return type.
- `WorkspaceDiscoveryController.PublicItem`: add `default_cwd_relative`, `can_select_directory`; `PublicCapabilities`: add `workspace_creation`, `approval_mode_selection`, `directory_selection`, `local_directory_import` (mirror the WebShell list/get shapes). This also enriches the existing Public workspace list/get responses. Erratum: an earlier draft said `workspace_listing`, which has no WebShell counterpart; the twin is `approvalModeSelection` (the client reads it to decide whether to offer creation-time approval-mode selection), so the mirrored name is `approval_mode_selection`.

### 3.5 OpenAPI + contract sync

- Update `PublicSession`, `SessionCapabilities`, `CreateSessionRequest`, `PublicWorkspace` / `PublicWorkspaceList` schemas; add `PublicModelContext` / `PublicLifecycleOperation` schemas and the task-list/workspace field additions. Bump `info.version` (`1.120.0` → `1.121.0`).
- Respect the NON_NULL rule: a `@JsonInclude(NON_NULL)` record omits null fields, so a schema `required` array must not list a nullable field (batch 3 hit this with `PublicModelSelection.model_id` and `PublicTranscript.older_cursor`). Mirror the corresponding WebShell schema's `required` set.
- `bothSurfacesReportTheSameSession` and any shape-pinning assertions may need to account for the new Public fields; update them to assert parity rather than deleting checks.

## 4. Verification (the four gates + Checkstyle)

Use the isolated Maven repo (SDK already installed) and skip GPG. From `packages/managed-agent-server`:

```
export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home
MVN=~/apache-maven-3.9.12/bin/mvn; REPO=/tmp/tier1-pr1-m2
# regenerate the surface capture, then run the gates
$MVN -pl verification -am -Dtest=ManagedSurfaceCaptureTest -Dcapability.parity.capture=true \
  -DfailIfNoTests=false -Dcheckstyle.skip -Dspotbugs.skip -Dgpg.skip=true -Dmaven.repo.local=$REPO test
$MVN -pl verification -am -Dtest='SurfaceRegistryGateTest,ManagedAgentApiContractTest,SurfaceAdmissionAcceptanceTest,ManagedSurfaceCaptureTest' \
  -DfailIfNoTests=false -Dcheckstyle.skip -Dspotbugs.skip -Dgpg.skip=true -Dmaven.repo.local=$REPO test
$MVN -pl contracts,control-plane,server,verification checkstyle:check -Dmaven.repo.local=$REPO
```

If `/tmp/tier1-pr1-m2` is gone, clone `~/.m2/repository` (APFS `cp -Rc`) and install the sibling SDK from `packages/sdk-java/qwencode` with `-DskipTests -Dgpg.skip=true`. Incremental runs are ~30–60s. The CLI `capability-parity.test.ts` needs built TS workspace dist (`npm run build`); if unavailable, record it as CI-pending (the Java capture gate already validates surface consistency and this batch adds no new Capability enum).

Acceptance: all four gates green, Checkstyle 0 violations, existing Public fields/flags/statuses unchanged, WebShell untouched, one clean local commit. Full MySQL/Hosted lanes remain CI-pending.

## 5. After this batch (slice 4b, do not start here)

The web-shell client `JavaManagedAgentClient` is the single HTTP boundary (`API_PREFIX = '/api/agent/web-shell/v1'`); the 80+ downstream components consume `JavaAgent*` aliases that equal the camelCase `WebShell*` shapes. The generator `generate-managed-agent-api.mjs` filters `tags.includes('WebShell')`. Once the Public shapes are a superset, choose between: (a) point the client at `/v1/agents/**` and adapt snake_case→camelCase at the boundary (downstream unchanged, but the generator still emits WebShell types and must be resolved in 4c), or (b) switch the generator to Public and update downstream (larger). Decide after batch 4 lands.
