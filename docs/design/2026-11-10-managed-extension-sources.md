# Application-owned Managed extension sources

[English](2026-11-10-managed-extension-sources.md) | [简体中文](2026-11-10-managed-extension-sources.zh-CN.md)

## Status and scope

Repository implementation candidate; deployment acceptance is pending. Applications retain asset CRUD, business tables, permissions, version selection and original archives. Managed accepts exact Skill or extension references through a Java SPI, compiles immutable execution packages, and keeps installation receipts. Independent MCP catalogs, HTTP providers, WebShell browsing, business instance policy and lifecycle migration are outside this change. Static Session Skills remain supported independently.

## Contracts and ownership

`ManagedExtensionSource` supplies a stable provider ID, authorized `resolve(Context, Reference)` and `open(Context, Resolved)`. References contain provider, kind, resource ID and exact revision. Context comes from trusted tenant, actor and Workspace identity and includes a request ID and deadline. Providers own business authorization and canonical identities. Missing and inaccessible resources both report not found; transient failures never become empty catalogs or local-package fallback. Resolved archive handles are private adapter state and are not persisted or returned publicly.

`ExtensionArchiveStorage` supplies atomic immutable `putIfAbsent`, streaming `open` and configuration validation. The default directory backend backs off for an application Bean. Custom storage needs no local persistent archive directory. All replicas use the same private namespace; tenant and Workspace scope are part of each key. Managed verifies bytes and bounds temporary storage, and releases file leases only after HTTP streaming or asynchronous Runtime upload actually settles. Execution packages remain retained; this change adds no garbage collector.

## Import and durability

`POST /v1/agents/workspaces/{workspaceId}/extensions/source-imports` accepts an exact reference, target and idempotency header. Managed checks Workspace/deployment permission, queries the original receipt, resolves and streams the source, hashes its actual bytes, and reuses Hosted `managed-package-preparation/1`. No Session, model, Hook, MCP connection or installation is created during preparation. Existing archive, capacity and deadline limits apply. Unsupported package content fails explicitly.

The compiled package is stored through the storage SPI. `ma_extension_package.source_json` retains the canonical reference, original source digest and import request fingerprint. Logical sources keep one Workspace extension identity. Business revision, package revision and Session configuration revision are independent. Source and compiled package digests are independent. Same-key retries return the original receipt; different requests conflict. Regular uploads cannot replace a source-bound identity. CSI inventory and schema validation retain provenance. Business tables are not migrated; the Managed schema remains separate.

## Authorization and recovery

`ma_extension_source_import` keeps the original reference/target fingerprint before any external I/O, under the actor-scoped import key. This small Managed receipt table is necessary because a provider failure can happen before a compiled package exists. `GET .../source-imports/{operationId}` and `GET .../source-imports` with the original idempotency header return the original intent even during provider outages. Before preparation the result has `operationId`, `state=pending`, and `reference`; preparation adds `operation` and `source`, and only settled publication adds `pin`. The nested operation keeps the existing `kind=publish` protocol. Both this table and package `source_json` are preserved by CSI. No business schema changes are needed.

Catalog reads, package details, independent downloads, inspection, settings access and new Session/apply admissions recheck business access. Authorization occurs outside Managed SQL transactions; admission validates the frozen selection against local rows. Completed creation replay and admitted apply continuation use the original operation, preserving Session/Workspace and actor checks. Provider outages do not block receipt queries or recovery of already admitted Sessions. Capability checks do not read the business catalog.

Revocation blocks new selection and independent package access. Existing admitted Sessions keep their fixed content and restore directly from execution storage without resolving the current business source. Missing or corrupt execution packages fail; recovery does not substitute latest content or silently recompile. Business defaults and forced selections remain the trusted application's responsibility. Credentials continue through existing encrypted settings, never provenance or archive handles.

Public v2 Session close/delete resource settlement terminally releases Hook and MCP owners after lifecycle effects. Ordinary Harness detach keeps its deterministic owners re-acquirable. Lifecycle claim, identity, generation, unsettled-execution and final worker-stop verification remain required; detach receipts cannot substitute for terminal close evidence.

## Application integration and acceptance

DataAgent adapters belong in its repository and depend only on Managed contracts. Reuse existing exact-version and permission rules over Skill and expert-suite versions, not public DTOs that swallow archive failures or current-version-only tickets. Do not infer publication from historical DTO fields or add published-only restrictions to exact revisions. Original ZIP checksum compatibility belongs to the adapter; Managed hashes actual bytes.

Validate custom Bean backoff, duplicate providers, strict references, streaming cleanup, immutable storage, same-key conflicts, concurrent imports and unknown writes; source ACL on every new-use/read path; fixed versions across updates, revocation and process replacement; original operation replay during source outage; and CSI provenance restoration. Run public API/SurfaceRegistry and embedding contracts, real MySQL concurrency/recovery and Hosted execution. The module's shared ten-minute local Java budget applies; full CI and real DataAgent deployment acceptance remain separate evidence. No deployment is claimed by this design.

Local evidence includes focused Java/API tests, real MySQL 8.4 import concurrency and CSI provenance round trips, custom-storage Spring backoff, and Boot 3.5.3 source import/Session admission. DataAgent's independent `managed-extension-sources / pinned-versions` runner requires a deployed candidate and owned historical Skill/script and suite fixtures; it has not run against a deployment. Source revocation, provider outage, process replacement and corrupt-package deployment scenarios remain a separate pending fault matrix. The existing daemon/Muster journeys do not establish Managed acceptance. An earlier DataAgent candidate recorded an ACP protocol IT failure and retained its failed report. The current inner-host candidate passed its complete local gate (3,222 unit tests, 20.123 seconds, 86.93% aggregate line coverage), embedded Boot 3.5.3 assembly, and 320 disposable MySQL 8.4.11 cases. These checks do not establish deployment or Hosted execution acceptance.
