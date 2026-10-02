# Managed AgentDefinition Revisions (Stage D8a)

[English](2026-10-01-managed-agent-definitions.md) | [简体中文](2026-10-01-managed-agent-definitions.zh-CN.md)

Status: implemented in this change
Date: 2026-10-01
Issue: [#12867](https://github.com/QwenLM/qwen-code/issues/12867), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
Builds on: [API contract (D1)](2026-09-27-managed-agent-api-contract.md) and [Session query (D2)](2026-09-27-managed-agent-session-query.md)

## 1. Problem

The contract declares `POST /v1/agents`, `GET /v1/agents/{agentId}` and
`POST /v1/agents/{agentId}` with the `AgentDefinitionRequest` and
`AgentDefinition` schemas, but all three are `planned`. A Session records the
fixed revision from `QWEN_MANAGED_AGENT_REVISION` and the only accepted agent
is `qwen-code`, so there is nowhere to keep a definition or its history.

The bare collection path also skipped the tenant scope: `TenantContextFilter`
matched the `/v1/agents/` prefix, which `/v1/agents` does not have.

#12867 splits D8 into three slices. D8a stores definitions and serves the
routes. D8b makes a Session pin a stored revision. D8c makes definition fields
change Harness execution and needs its own design.

## 2. Goals

- Serve the three routes with the contract's request and response schemas.
- Keep revisions append-only and immutable, each with a digest of its
  canonical content.
- Make create and update idempotent under their `Idempotency-Key`.
- Scope definitions to the tenant, including the bare collection path.

## 3. Non-goals

- Sessions keep pinning `qwen-code` and the configured revision (D8b).
- No definition field changes model selection, instructions, tools or
  permissions (D8c).
- A separate publish step, listing definitions, deleting them, and the
  role matrix from section 10 of the contract.

## 4. Design

### 4.1 Storage

Flyway `V33`, following main's `V32` Workspace session-close migration, adds two tables. `managed_agent_definition` holds one row per
revision, keyed by tenant, agent ID and revision number, with the digest, the
request's JSON and the creation time. Rows are only inserted.
`managed_agent_definition_command` records each create or update under its
tenant and `Idempotency-Key`, with the request digest and the revision the
command answered with.

### 4.2 Identity and digests

The server generates agent IDs as `agent_` plus 32 hex digits; the request has
no ID field. `GET`/`POST /v1/agents/{agentId}` answer `404 agent_not_found` for
any ID that is not of that form. The reserved names are answered elsewhere:
literal routes outrank `{agentId}` in Spring's path matching, so
`/v1/agents/sessions` (GET and POST) and `/v1/agents/workspaces` (GET) reach the
Session and Workspace routes, while a reserved name whose method has no literal
sibling — `POST /v1/agents/workspaces` — still reaches the definition route and
answers `404`. Either way the reserved names never resolve to a stored row, and
neither do padded or case-folded variants of a real ID.

The content is the request with absent and null optional fields removed; the
contract declares `skills`, `mcp_servers` and `metadata` nullable for that
reason. Array items must be objects, so a `null` item answers `400`. The
digest is the SHA-256 of the canonical JSON (keys sorted at every level), so
key order does not change it, and neither does an explicit `null` for one of
the optional top-level fields. Null stripping is one level only: a `null`
nested inside an open map such as `metadata` does change the digest. The
request digest also covers the operation and, for an update, the agent ID.

### 4.3 Semantics

- **Create** stores revision `1` and answers `202`.
- **Update** stores the next revision. When the content digest equals the
  latest revision's, it stores nothing and answers with that revision.
- **Replay.** The same key and request digest answer the recorded revision
  with `X-Qwen-Idempotent-Replay: true`. The same key with a different request,
  including a create key reused for an update, answers
  `409 idempotency_conflict`.
- **Concurrency.** Revision rows and the command commit in one transaction.
  When a concurrent request commits first, the losing write rolls back and
  reads the command committed under its key: the same request replays that
  result. Otherwise a concurrent update that took the revision number answers
  `409 agent_revision_conflict` without recording the command, so its key can
  be retried, and a different request under the same key answers
  `409 idempotency_conflict`. A no-op update may precede an overlapping
  content-changing update; its response and later replays still name the
  recorded revision, even if that revision is no longer the head when the
  response arrives.
- **Get** reads the latest revision, or the one named by `revision` (a decimal
  number from `1`). Anything else answers `404 agent_not_found`.
- The response carries `id`, `object: "agent"`, `revision`, `digest`,
  `created_at` and the request's `metadata`. It does not echo the content.

### 4.4 Tenant scope

`TenantContextFilter` now also covers the exact path `/v1/agents`, so every
route requires `X-Qwen-Tenant-Id` and refuses a mismatched trusted actor with
`403 actor_scope_mismatch`. Reads and updates in another tenant answer `404`.

### 4.5 Contract

The three routes move to `implemented` with descriptions, create and update
declare `400`, and the contract is v1.29.0. The version assumes #13112 lands
v1.28 first.

## 5. Open questions for D8b and D8c

1. Which fields take effect, and which stay stored only until their stage
   lands (for example `skills` and `mcp_servers` with Stage H)?
2. Is a stored revision usable at once, or does a publish step decide which
   revision new Sessions use?
3. How do `tools` and `permission_policy` map onto the frozen Hosted tool
   profiles and the approval mode a Session pins today?

## 6. Verification

- `ManagedAgentDefinitionTest`: creation and replay, unchanged and changed
  updates, revision reads, key conflicts, tenant scope, server-generated IDs,
  validation, and canonical digests.
- `ManagedAgentDefinitionServiceTest`: a write that loses a race replays the
  committed result for the same request and keeps its conflict otherwise.
- `ManagedAgentApiContractTest`: the three routes against their schemas,
  including `400`, `404` and `409`, and the tenant filter refusal on the bare
  collection path.
- `TenantContextFilterTest`: the bare path requires a tenant, and an unrelated
  path with the same prefix is not filtered.
