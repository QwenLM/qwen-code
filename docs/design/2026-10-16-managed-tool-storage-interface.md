# Managed tool storage interface

[English](2026-10-16-managed-tool-storage-interface.md) | [简体中文](2026-10-16-managed-tool-storage-interface.zh-CN.md)

Status: implemented; local storage checks passed on macOS. Full current-baseline verification has a separately reproduced main failure. Deployment qualification remains separate.

## Problem and previous implementation

Before this change, Managed tool publication already injected `ToolPublicationObjectStore` into its publication, retention, collection and recovery readers. However, its Spring configuration always created an Aliyun OSS client, its API and asynchronous verification paths inspected `OSSException`, and the interface exposed a bucket-versioning check through `requireUnversioned()`. An application could not supply another implementation without also provisioning or overriding OSS infrastructure.

## Goals and scope

Make the existing byte-storage interface replaceable while retaining Aliyun OSS as the default implementation. Preserve publication authorization, immutable bytes, quotas, verification, recovery, garbage collection, public responses and the disabled-by-default setting. SQL remains authoritative for publication identity, operations and ownership; the object store holds bytes.

This change does not implement S3, MinIO or a production filesystem backend, add backend routing, move Workspace files, change the public API or migrate existing objects. The OSS SDK remains bundled with the server. Supplying a different implementation is an application integration through a Spring `@Bean`, not a runtime plugin installer.

## Proposed changes

### Storage contract

Keep `ToolPublicationObjectStore` and its existing create, read and delete operations. Rename `requireUnversioned()` to `validateConfiguration()` and retain the existing verification and collection call sites. The method validates the implementation's storage guarantees; OSS implements it with its existing bucket-versioning check. An implementation must provide private, durable, immutable objects, atomic creation without overwrite, readable original bytes, and physical deletion of the exact owned key. A completed physical create must never be automatically replayed, including after later collection. SQL's durable write-attempt ledger continues to control reconciliation.

The guarded read overload must check the supplied authorization/lease guard before each new storage request or retry. Returning a stream does not authorize replaying a failed stream. A custom implementation must explicitly implement the guarantees; a no-op validation is appropriate only for a test fixture or a backend that enforces them by construction. Production implementations must implement `deleteIfPresent`, even with scheduled GC disabled, because failed-publication cleanup also deletes objects. Its existing unsupported default remains a refusal.

### Provider-neutral failures

Introduce `ToolPublicationStorageException` with `ACCESS_DENIED` and `FAILURE` reasons and an original cause. The OSS adapter converts OSS service/client failures at its boundary, after its existing bounded read retries. Create and delete requests retain their existing retry policy. Guard failures and standard stream I/O failures keep their current behavior.

The API handler and asynchronous verifier use the neutral reason. Access denial retains HTTP 403 and `managed_tool_publication_storage_denied`; other failures retain the existing generic failure handling. Provider messages, credentials and object coordinates do not enter public responses. Original diagnostics remain available through the exception cause.

### Default OSS wiring

Move OSS client construction and the default store bean into a dedicated Boot auto-configuration registered through `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`. Enable it only when the common publication configuration exists, tool publication is enabled and no `ToolPublicationObjectStore` bean exists. Deferred auto-configuration evaluates application beans first, avoiding component-scan ordering dependence. A maintenance-only Boot context must not initialize publication storage. The default implementation retains its own configured OSS client rather than reusing an unrelated application's OSS bean.

Keep the common publication configuration independent of OSS classes. Validate the common publication service URL there. A supplied store still requires the common publication capacities, deadlines and service URL, but does not require OSS endpoint, region, bucket or credentials. Existing deployments without a supplied store retain the original OSS settings, fixed regional HTTPS validation, V4 signing, private-bucket check, retry behavior and client shutdown.

### Consumers and maintenance tools

Publication writes and verification, retention reads, collection, Managed Session resource reads, Workspace recovery readers and public artifact downloads continue using the same injected store. No consumer selects a different backend or falls back when an object is missing.

The standalone `WorkspaceRecoveryMain` and `WorkspaceCsiWorkerAckMain` remain explicitly OSS-specific launchers because they construct storage without a Spring application context. Update their interface usage but keep their environment contract. Custom-backend operators must integrate the same store into their recovery tooling; the bundled OSS launchers do not acquire support for arbitrary providers in this change.

## Compatibility and risks

There is one authoritative store per deployment, shared by all server instances using that SQL catalog. Existing SQL rows contain object keys, not provider identities. Replacing a bean or changing its namespace is therefore not a data migration: retained objects must remain readable with the same keys, or the operator must migrate them separately before switching. Missing or corrupt old objects continue to block reads/recovery rather than falling back to another store.

The private Java interface method rename requires custom implementations and test fixtures to recompile. No SQL, wire schema, public request or response changes are needed. The main risks are incorrect default-bean ordering, accidental OSS initialization with a custom store, loss of access-denial classification and weakened retry/collection guarantees.

## Validation and acceptance criteria

- A custom store starts the complete publication configuration with no OSS settings or credentials and is the only injected store, without creating an OSS client. H2 publication/retention/collection fixtures separately exercise byte writes, reads and deletion through the same interface.
- Publication disabled creates no default store/client. With publication enabled and no supplied store, the OSS default retains endpoint, signing and lifecycle behavior. Invalid OSS configuration still fails startup.
- Neutral access denial produces the existing API response and terminal asynchronous-verification rejection; ordinary storage failures remain generic and retry behavior is unchanged.
- Existing SDK-backed HTTP tests retain exact read-request counts, original causes, guard expiry, no write replay and bucket-versioning refusal. Existing publication, retention, recovery-reader and collector tests remain green.
- Run focused Maven tests, then `mvn verify` with JDK 21 and the current checkout's SDK. Build existing JavaScript prerequisites for native CSI tests. New backend deployment qualification, real-bucket acceptance and cross-host recovery are separate gates.

## Verification results

- Repository `npm run build` passed using the healthy bundled Node 24.19.0. Java checks used JDK 21.0.8, Maven 3.9.14, Node 22.22.3 and the current checkout's SDK installed into an isolated Maven repository.
- After rebasing onto main `52ae53b02a`, all 113 focused storage tests passed, including 9 configuration cases. Full `mvn verify` on 2026-10-16 ran 4,193 tests: 4,183 passed, 9 skipped and 1 error in `WorkspaceCsiSessionMainTest.oldWorkspaceCreationDoesNotAcquireTheNewProfileOrRequestPin`. The same case independently failed on an untouched snapshot of that main revision: legacy creation rejects the fixture's CSI storage through `WorkspaceStorageKindGuard`. Neither `ManagedAgentStore` nor that test is changed by this feature. Full current-baseline verification is not green.
- Both configured Checkstyle executions and SpotBugs were then run directly against the rebased feature output: zero violations, zero bug instances and zero analysis errors. Their separate success does not replace the failed full verification.
- The 30 changed code/test/resource files match the current source snapshot. Across the rebases, the server source/test/resource patch is unchanged and its production/resource files remain byte-identical; the query-budget test also retains unrelated upstream changes.
- The 9 skips were three platform-specific tests, four tests requiring real MySQL, one Kubernetes opt-in test and one test requiring an explicitly supplied real worker bundle. No new backend, real-bucket OSS, deployed Hosted recovery or cross-host qualification was performed. Spring replacement checks and H2 publication/retention/collection fixtures are local evidence, not deployed custom-backend E2E acceptance.
- Two consecutive clean self-audit passes and an independent read-only review of the feature diff found no actionable issues. The integration review was repeated after rebasing. Markdown formatting, bilingual structure and local references passed validation.

## Open questions

None for this bounded change. Additional backend implementations and provider-aware maintenance launchers are follow-up work driven by an actual deployment requirement.
