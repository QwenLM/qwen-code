# Managed Agent SPI definition input: implementation plan

[English](2026-11-25-managed-agent-definition-input-spi.md) | [简体中文](2026-11-25-managed-agent-definition-input-spi.zh-CN.md)

> Status: Q1 implemented and locally verified; Q2–Q4 pending. Date: 2026-11-25.
>
> Q1 verification with JDK 21 and Maven 3.9.11: `mvn -Dmaven.repo.local=<task-specific-repository> -Dtest=DefinitionInputContractsTest,ManagedDefinitionInputProvidersTest,ManagedAgentDefinitionServiceTest test checkstyle:check` — 14 tests, no failures, errors or skips; Checkstyle passed. No real MySQL, process or host acceptance was run.
>
> Parent contract: [execution-definition and bootstrap-input design](../design/2026-11-25-managed-agent-execution-definition-spi.md) ([简体中文](../design/2026-11-25-managed-agent-execution-definition-spi.zh-CN.md)).
>
> Issue: [#18289](https://github.com/QwenLM/qwen-code/issues/18289).
>
> This slice is confined to qwen-code. It does not implement the host product adapter and does not change pre-registered AgentDefinition flows.

## 1. Deliverable and hard limits

Deliver a **Java-embedded, opt-in SPI preparation path** that produces the same kinds of immutable native Definition and Extension artifacts already supported by MA. The first vertical slice contains only:

- an exact `sourceRef → native definition/material plan` mapping;
- bounded-text Definition input from a host Source;
- one-shot bootstrap archive download only when the matching native Extension package does not exist;
- immutable native artifacts usable in subsequent native admissions.

`PRE_REGISTERED` remains the default and keeps the existing public definition API, JSON shapes, JDBC store and Session behavior. SPI is enabled through explicit embedding configuration and registered providers, never by an arbitrary request/Turn parameter. Missing provider or required configuration fails closed, without an opaque fallback to a different database or latest object.

### Explicitly out of scope for this slice

- host product adapter/module implementation;
- generalized personal MCP OAuth, automatic token rotation and dynamic existing-Session definition re-pinning;
- new MCP v1 fields, public HTTP endpoints, premature new preparation/material tables, and a second Session/Turn state machine;
- arbitrary vendor ZIP execution, whole-archive bytes in JVM heap or `ma_agent_definition.definition_json`, and real-time host callbacks from the Node agent loop.

## 2. Confirmed reuse points in the current source

- `ManagedAgentDefinitionStore` has immutable native revisions and an idempotent `create`/replay path. Its request and response `definitionJson` include non-secret definition fields; existing native IDs and versioning remain owned by MA.
- `ma_agent_definition` already persists `tenant_id/agent_id/revision/digest/definition_json/gmt_create`; no change to the meaning of pre-registered full `AgentDefinitionRequest`.
- `ExtensionArchiveStorage.Key(tenantId, workspaceId, digest)` provides atomic, shared, immutable archive storage. Its `putIfAbsent` contract is reused for immutable package bytes; it must not replay an unknown write.
- `ma_extension_package` stores compiled package manifest and `source_json`, not the archive as a database BLOB. `ma_extension_settings` is an independent encrypted settings revision scope; compilation does not create one.
- `ma_request_receipt` already persists receipt scope, idempotency key/digest, request digest, state, native agent revision and `result_json`. Source preparation uses an independent operation namespace, does not borrow `AGENT_DEFINITION` registration to imply Session admission, and does not change old keys or replay behavior.
- `RequestDigests` uses a configured canonical `ObjectMapper` and `DigestUtils.sha256Hex`. Reuse this rather than inventing a second digest algorithm (`model/RequestDigests.java:13-17`).
- `AgentDefinitionCompiler` and `AgentDefinitionExtensions` remain responsible for supported definition/tool/skill shapes.
- `ManagedExtensionPackageService.importSource` already stages bounded archive streams into an output stream with per-iteration deadline checks. Reuse the current streaming and bounded-staging pattern rather than `readAllBytes()` (`ManagedExtensionPackageService.java:246-290`).
- During Session creation, `QwenHostedHarnessConnector.agentDefinition` publishes instructions/Skill refs after a concrete native sessionId exists. Node reads them through the Resource Store. No pre-Session global resource is introduced.

The interfaces and operation below are new; they are not claimed to already exist.

## 3. Contracts to freeze before production edits

### 3.1 `ManagedAgentDefinitionSource`

Keep the small interface from the parent design:

```java
Definition resolve(Context context, Selection selection);
```

Inputs and invariants:

- `Context` contains MA-derived tenant/actor/workspace, an authorized `executionScope`, requestId and deadline. It is derived from an authenticated MA Principal, not trusted from arbitrary caller strings.
- `Selection` is `Current(agentKey)` or `Exact(sourceRef)`.
- `Current` is used only for a fresh authorized selection, returning a complete exact definition.
- `Exact` must return the original exact revision/projection or fail explicitly; it cannot return the latest publication instead.
- `Definition` contains model reference, instructions, tool policy, static Skill or Extension references, and an optional bootstrap BundleRef. No arbitrary secret or signed URI goes into the public Definition.

The exact SourceRef is part of the persisted source projection metadata associated with the generated native Definition:

```text
providerId / agentKey / sourceRevision / projectionDigest / executionScope
```

It is not the native `agentId`, a random request UUID or a nonce. Different base/policy/resource choices or an unauthorized scope must not reuse another scope's prepared projection.

### 3.2 `AgentBootstrapBundleSource`

Return `Resolved` from `resolve(Context, BundleRef)`:

- exact `providerId/resourceId/sourceRevision`;
- an optional expected byte length;
- expected source digest;
- `signedUri` and `expiresAt`: the short-lived, scoped download URI and its issuer-provided expiry;
- content type/schema profile for the existing **canonical Managed Extension package**.

MA itself owns bounded download handling. The URI represents one exact fetch operation, never a durable permission grant and never a future lookup key. A Source may offer an analogous bounded stream where that avoids an unnecessary URL round-trip. Existing `ManagedExtensionSource.resolve/open` remains the implementation for normal Extension materials.

Only canonical, already-supported Managed Extension packages are accepted in this slice. MA does not infer safe executable semantics from an arbitrary opaque ZIP name.

### 3.3 `ManagedAgentDefinitionPreparation`

`prepare(Command)` is implemented by MA. It accepts an authenticated Principal, Selection and stable operationKey. It does not:

- create a Session;
- apply an Extension or independent MCP configuration;
- start a model/tool Turn;
- set an applied/active configuration state.

`PrepareReceipt` returns the native Definition/material plan and operation identity. Native Session admission and subsequent application are separate MA application operations with independent keys and receipts.

## 4. Implementation sequence

### Q1: Contracts and old-path regression

1. Put new Source/data contracts under `contracts` alongside catalog/extension APIs; do not introduce host-product types or DTO dependencies.
2. Add a provider registration boundary that accepts embedded Spring source providers, rejects missing/duplicate provider IDs and uses MA's verified Principal/Workspace checks to construct Source Context.
3. Expose `ManagedAgentDefinitionPreparation` from `ManagedAgentConfiguration`'s existing no-Servlet composition. There is no new default controller/Web endpoint.
4. Keep public AgentDefinition create/update/get and direct-definition native admission exactly as before when `PRE_REGISTERED` is selected. Do not hard-wire Mode into old methods or alter their JSON serialization.
5. Define and test a single canonicalization path for `commandDigest`, `SourceRef.projectionDigest` and native digest using existing MA `RequestDigests` and the existing native definition digest generation. Preserve scope in the command/receipt identity rather than globally deduplicating all tenants and actors.

**Exit evidence:** pre-registered paths work unchanged with no source provider. An explicitly selected SPI mode without required provider/configuration gives a deterministic refusal before source or Runtime side effects.

### Q2: Source preparation and exact native recording

Implement `ManagedAgentDefinitionPreparation` using these steps:

1. Resolve and validate the MA Principal and authorized Workspace/execution scope.
2. Find an existing matching native projection. If an already-settled receipt and matching exact projection exist, return its native refs and then verify the native Definition revision/digest before submission. No fresh `current` evaluation.
3. Otherwise, register a pending preparation in the existing receipt boundary before first external Source I/O. Its namespace separates it from legacy Definition create and later admission/apply operations.
4. Invoke the selected Source. Immediately preserve the exact SourceRef/projection and its native Definition identity, before any package I/O. Continue later stages only from this exact projection.
5. Convert the accepted Definition through the existing native definition representation. Use its JSON/response shape to store an immutable native revision; associate SourceRef in a non-secret metadata/source-preparation representation without changing the meaning of old metadata.
6. If there are pending stages with a saved exact projection, resume/reconcile them. If no resolved projection is persisted, do not claim to have one and do not select a new latest one.
7. Commit the native Definition/material plan with the atomic write/replay behavior already used by the Definition store. If the host's separate ProviderBinding save fails, recover the same native receipt under the original command and retry just that host-local save.

**Exit evidence:** two concurrent replicas committing the same exact normalized request converge to one native definition identity and receipt. A different input using the same operation key is rejected. A repeated call can recover its original result without querying latest or requiring host lookup.

Required rules:

- `PREPARED` denotes a persisted immutable Definition/material plan, never a Runtime-applied config.
- Do not add `ma_definition_preparation`/`ma_definition_material` merely to imitate logging. Introduce no new schema until an unavoidable unrepresented native recovery fact is demonstrated in a concrete contract test.
- If missing preparation phase cannot be expressed safely by the chosen receipt contract, stop at an explicit `unsupported_feature` for that path; never silently reinterpret pending as committed.

### Q3: Bootstrap archive download only for a missing native package

Add a bounded downloader/preparation component for the new Source shape:

1. For an accepted `BundleRef`, look for an exact native package identity first (including source digest, package version and compiler format). Do not consider a live latest bundle cache a substitute for an exact pin.
2. If found with matching immutable content, reuse it and continue **without** `resolve/open`/compilation/downloading. Worker consumers later access MA's saved artifact.
3. If absent, authorize through `AgentBootstrapBundleSource.resolve`, obtain the short-lived URI, and stream through MA's controlled downloader to private staging. Do not hand the URI to Node as an external access grant.
4. During transfer, count actual read bytes, compute source SHA-256 incrementally with `DigestUtils`, enforce configured size/concurrency/time limits, and honor the Source Context deadline. Use an approved target/redirect policy and HTTPS for the URI client; status and exception categories must be explicit.
5. On mismatch/timeout/too-large/failure, close stream/response in `try/finally` and do not replace any existing package. Give download responses and exception summaries a deliberately redacted view rather than relying on a record's default `toString()` or logging a signed URI/header. Do not issue a new initial bundle under another latest source name.
6. Feed the verified artifact to the existing Harness package preparation path for the supported canonical Managed Extension package format. That path, not MA's own semantic review of arbitrary ZIP content, supplies the package-specific parsing/validation needed for actual Worker usage.
7. Persist the normalized package atomically using `ExtensionArchiveStorage.putIfAbsent` and existing package/receipt contracts. `settingsRevision` remains null unless an independent settings-save operation provides a non-null revision. Saving a receipt must not be portrayed as actual Worker configuration application.

For denied hosts, malformed endpoints, expiring downloads or corrupted bytes, fail the initialization rather than executing a package or silently using a previous blob. There is no unconditional fallback to latest data.

The producer format is bounded; MA does not interpret business semantics from its inside. Existing Worker package validation/activation remains responsible for files it actually installs/executes.

### Q4: Verification and documentation only after source paths pass

Compile/prove the smallest live path before considering any optional host integration:

```text
pre-registered input → original flow (unchanged)
one Source definition → immutable native Definition → exact native admission/read-back
one missing Extension package → bounded fetch → immutable native archive → saved-artifact delivery
```

Do not claim the broader host integration, dynamic configuration transitions, independent MCP private refresh or full process recovery until those have their own implementation and evidence. Updating this plan's status must use actual test/commit identifiers and actual checks run.

## 5. Proposed code/test locations

Use existing module structure and no new parallel project/module.

- `contracts/.../catalog/`: new SourceRef/Definition source types and context/selection;
- `contracts/.../extensions/`: Bootstrap Source and bounded download descriptor in the same general material family;
- `control-plane/.../catalog/`: `ManagedAgentDefinitionPreparation` composition, projection normalization, receipt assembly and read-back;
- `control-plane/.../extensions/`: bounded bundle download/reuse and the existing native package preparation path;
- Existing JDBC Definition/Extension repositories and `ExtensionArchiveStorage`: continue owning immutable native storage;
- `ManagedAgentConfiguration`: opt-in Spring provider wiring only;
- `verification/src/test/java/.../catalog/`: source and preparation tests;
- `verification/src/test/java/.../extensions/`: downloader and reuse/recovery tests;
- existing `ManagedPublishedAgentConfigurationTest`, `ManagedAgentDefinitionAdmissionTest`, `HostedExtensionsIT`: unchanged/shared regression, used only when behavior warrants their profile.

Do not hand-edit generated public OpenAPI types. If an eventual public HTTP surface is separately approved, update `managed-agent-public-api.openapi.json`, all mapped routes and client generation as a distinct delivery.

## 6. Required acceptance cases

### Definition and compatibility

1. Complete pre-registered JSON is registered/admitted byte-semantically as before; no SPI beans are needed.
2. A fake Source returns a small exact Definition with two dependency refs; the native content and real `agentRevision/agentDigest` are verified. No free-text source name accidentally substitutes for this exact SourceRef.
3. `Current` is authorized anew, while an admitted settled replay skips Source and uses its original receipt/projection. `Exact` with altered or mismatched content fails.
4. Duplicate same-scope exact normalized input across replicas converges to the same native ref. Different scope/input produces a different source group or an idempotency conflict.
5. No source callback occurs within Node's normal model/tool round, and a saved projection survives restart.

### Download and stage isolation

1. A fake bounded OSS HTTP server hands a short-lived URI. Assert one fetch occurs only while the native package does not exist, and that streamed bytes do not produce an in-memory copy of the whole ZIP.
2. Match expected source digest/length/content type, atomically retain the normalized package and mark the plan prepared. Do not mark it applied.
3. A second exact preparation has no source `open`, URL issuance or recompilation. A Worker with no local archive still consumes the saved native artifact, without a retry to the expired original address.
4. Interrupt download, oversize response, short body, digest mismatch, target redirect, timeout and URI expiry all preserve the last valid package. Signed URLs/auth headers and ZIP bytes never enter logs, Definition JSON, ordinary refs or prompts.
5. An actually concurrent race either returns one immutable artifact or uses the settled winner. It never produces two independently accepted plans or silently chooses a different revision.

### Recovery limits

- A locally failed host ProviderBinding save can replay the original native receipt and then save the binding.
- Pending initialization returns the persisted stage, not a fabricated completed plan.
- If a resolved exact projection has not been saved, the operation fails explicitly; a newer published Agent is not substituted.
- Missing private material/receipt produces an explicit unavailable result, not an inferred recovery. This slice does not claim general MCP secret recovery or Turn-safe dynamic configuration replacement.

## 7. Validation entry points

This is currently a document-only plan. Production edits would require the following project-local checks with actual reports, not assumed success.

From `packages/managed-agent-server/`, choose focused new and affected tests rather than an indiscriminate full-repo run:

```bash
mvn -Dtest=ManagedDefinitionPreparationTest,ManagedBootstrapBundleTest \
  test checkstyle:check
```

Before testing, ensure JDK 21/Maven and an isolated sibling SDK matching the tested source. When installing a needed SDK artifact, use a task-specific local Maven repository and the same setting for subsequent Maven commands as defined by the module's `AGENTS.md`.

- Required real MySQL for SQL/persistence, receipt and concurrent-writer paths: select the corresponding `mysql-integration` cases against disposable MySQL 8.4, following the current module's environment and setup constraints.
- Keep full unit/H2, Checkstyle/SpotBugs and Hosted profiles for CI; do not exempt them or invent acceptance based solely on H2 or mocks.
- If the implementation requires changes in Core/CLI/native Harness code paths, follow the repository's separate existing Node core/CLI build and focused tests. Any actual hosted-processing or recovery behavior must also have appropriate real-process evidence; current files' presence is not proof of it.
- If only Java/Doc changes land, use the MA-local Maven and doc checks rather than unrelated repository-wide TypeScript/Vitest gates. Run the repository's Prettier on added/modified docs.
- Target budget for this module's local verification per change is at most 10 minutes, unless explicitly extended. Unavailable MySQL/native process paths remain explicitly pending CI, with no substitution claim.

Each final report should identify: source commit, selected test commands and outcomes, exact mode tested, real-MySQL evidence etc. No deployment, release or host product acceptance is presumed by this plan.

## 8. Stop conditions and unknowns carried into implementation review

Only these narrow decisions remain for the implementation review, not a larger redesign:

- exact Java package chosen for Source contracts and its authenticated `Principal` type;
- canonical SourceRef representation in native metadata and the receipt namespace for the new prepare operation;
- whether the authorized `executionScope` needs a backward-compatible Source Context extension versus a narrow adapter mapping in the selected Source provider;
- concrete approved size/concurrency/time limits for the supported deployment, under the existing staging pattern;
- any required real-process/MySQL checks still pending locally, rather than pretending CI evidence exists.

Stop rather than silently degrade if supported package structure forces a new parser or a new native store, if a pending/recovery path cannot be represented, if identity authorization requires weakening Workspace/Principal checks, or if bootstrap exceeds resource constraints despite streaming.

Do not convert this first step into a generic dynamic configuration system. It remains an optional, bounded SPI preparation and missing-native-bootstrap mechanism alongside the untouched pre-registered AgentDefinition pipeline.
