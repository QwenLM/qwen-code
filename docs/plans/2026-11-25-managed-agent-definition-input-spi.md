# Managed Agent SPI definition input: implementation plan

[English](2026-11-25-managed-agent-definition-input-spi.md) | [简体中文](2026-11-25-managed-agent-definition-input-spi.zh-CN.md)

> Status: Q1–Q3 implemented and locally verified; Q4 records the actual implementation, configuration and remaining CI/process qualifications. Date: 2026-11-25.
>
> Implemented commits: Q1 `97e4b6c2efc024e9eba26327352d87c2e5a7c4de`, Q2 `e07b74d2c5`, Q3 `d48bc5a036`. These are feature-branch commits, not a merged/release baseline.
>
> Q1: 14 focused tests plus Checkstyle. Q2: 32 focused tests plus a real MySQL 8.4 concurrent-preparation case. Q3: 76 focused tests plus the same real-MySQL path, followed by 28 focused contract/download/replay checks including the added authorization test. Overlapping test selectors are not added together as unique coverage.
>
> JDK 21 and Maven 3.9.11 were used with a task-specific Maven repository. Full CI gates, full SQL/Hosted profiles, SpotBugs, real Node/Worker application, host-product acceptance and production OSS qualification remain separate and are not claimed here.
>
> Parent contract: [execution-definition and bootstrap-input design](../design/2026-11-25-managed-agent-execution-definition-spi.md) ([简体中文](../design/2026-11-25-managed-agent-execution-definition-spi.zh-CN.md)).
>
> Issue: [#18289](https://github.com/QwenLM/qwen-code/issues/18289).
>
> This slice is confined to qwen-code. It does not implement the host product adapter and does not change pre-registered AgentDefinition flows.

## 1. Deliverable and hard limits

Deliver a **Java-embedded, opt-in SPI preparation path** that produces immutable native Definitions and bootstrap archives. The first vertical slice contains only:

- an exact `sourceRef → native Definition/material refs` mapping;
- typed Definition input from a host Source;
- one-shot raw bootstrap archive download only when the matching native artifact does not exist;
- immutable references that subsequent, separate native application operations can consume.

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

The following contracts now exist under `contracts/definitions`, `contracts/extensions` and `contracts/repository`. `managedAgentDefinitionPreparation` is implemented in the control-plane catalog package, with bootstrap download/storage in the extensions and persistence layers. Their scope is still the narrow one below, rather than a complete host configuration system.

## 3. Contracts to freeze before production edits

### 3.1 `ManagedAgentDefinitionSource`

Keep the small interface from the parent design:

```java
Definition resolve(Context context, Selection selection);
```

Inputs and invariants:

- `Context` contains tenant/actor/workspace, `executionScope`, requestId and deadline. A trusted embedding application supplies these caller fields after authenticating its caller; MA verifies Workspace OPERATOR access and does not add a second login facade or accept arbitrary HTTP identity headers for this Java path.
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
- `application/zip` or `application/octet-stream` for a trusted raw initialization archive; no URI userinfo or redirect-based replacement. MA does not infer executable or Extension-catalog semantics from this raw ZIP.

MA itself owns bounded download handling. The URI represents one exact fetch operation, never a durable permission grant and never a future lookup key. A Source may offer an analogous bounded stream where that avoids an unnecessary URL round-trip. Existing `ManagedExtensionSource.resolve/open` remains the implementation for normal Extension materials.

This slice accepts a raw, trusted initialization archive and verifies its identity and bytes, without interpreting its inner business semantics. MA does not infer safe executable semantics from an arbitrary opaque ZIP name or automatically turn it into a registered Extension package. Consumption by a Worker remains a separate operation and responsibility.

### 3.3 `ManagedAgentDefinitionPreparation`

`prepare(Command)` is implemented by MA. It accepts tenant/actor/workspace/execution scope, `Current`/`Exact`/`PreRegistered` selection, an exact deadline and a stable operationKey through the trusted embedding caller. It does not:

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
5. Compute `commandDigest` over the canonical original command with existing MA `RequestDigests`; include tenant, actor, Workspace, execution scope and selection. Treat the Source's exact `projectionDigest` as an input identity, not a hash recomputed from the complete native request. Compute native Definition digest over MA's transformed native content. Derive the deterministic SPI native `agentId` from tenant and the complete exact SourceRef; keep random IDs for the existing public create API.

**Exit evidence:** pre-registered paths work unchanged with no source provider. An explicitly selected SPI mode without required provider/configuration gives a deterministic refusal before source or Runtime side effects.

### Q2: Source preparation and exact native recording

Implement `ManagedAgentDefinitionPreparation` using these steps:

1. Accept the trusted embedding caller fields and verify MA Workspace OPERATOR access for the requested execution scope.
2. Find an existing matching native projection. If an already-settled receipt and matching exact projection exist, return its native refs and then verify the native Definition revision/digest before submission. No fresh `current` evaluation.
3. Otherwise, register a pending preparation in the existing receipt boundary before first external Source I/O. Its namespace separates it from legacy Definition create and later admission/apply operations.
4. Invoke the selected Source. Persist its exact SourceRef and effective input before package I/O. Derive native identity from the tenant and complete SourceRef, persist the transformed native Definition and verify its id/revision/digest on read-back, and continue later stages only from that exact projection.
5. Convert the accepted Definition through the existing native definition representation. Use its JSON/response shape to store an immutable native revision; associate SourceRef in a non-secret metadata/source-preparation representation without changing the meaning of old metadata.
6. If there are pending stages with a saved exact projection, resume/reconcile them. If no resolved projection is persisted, do not claim to have one and do not select a new latest one.
7. Commit the native Definition/material plan with the atomic write/replay behavior already used by the Definition store. If the host's separate ProviderBinding save fails, recover the same native receipt under the original command and retry just that host-local save.

**Exit evidence:** two coordinated concurrent Java service calls using real MySQL and the production Definition-store transaction semantics converge to one native definition identity and receipt. This is not evidence about several independent OS processes. A different input using the same operation key is rejected. A repeated call recovers its original result without querying latest or requiring host lookup.

Required rules:

- `PREPARED` denotes a persisted immutable Definition/material plan, never a Runtime-applied config.
- Do not add `ma_definition_preparation`/`ma_definition_material` merely to imitate logging. Introduce no new schema until an unavoidable unrepresented native recovery fact is demonstrated in a concrete contract test.
- If missing preparation phase cannot be expressed safely by the chosen receipt contract, stop at an explicit `unsupported_feature` for that path; never silently reinterpret pending as committed.

### Q3: Bootstrap archive download only for a missing native package

Add a bounded downloader/preparation component for the new Source shape:

1. `ManagedAgentBootstrapPreparationService` accepts the authorized Definition context and at most 32 distinct bundle refs. An actual `expectedDigest` is mandatory for this preparation path; expected length is optional but verified when supplied.
2. As with the existing extension path, every new `prepare` invokes `AgentBootstrapBundleSource.resolve` to authorize the exact ref. A settled replay of the outer Definition preparation returns its saved receipt without any provider call. Revocation must not be hidden by cached bytes.
3. Look up `ExtensionArchiveStorage.Key(tenantId, workspaceId, expectedDigest)` with the new `stat` operation. A valid existing object is reused without an HTTP body download; only a missing object proceeds to the downloader. An original URL that has expired does not invalidate the saved artifact, but source authorization failure still fails the new prepare.
4. Require an approved HTTPS hostname and non-expired signed URI, reject userinfo and redirects, and download an HTTP 200 `application/zip` or `application/octet-stream` response into a private temporary file. Consume no more than 64 KiB per read, incrementally compute digest/length, fail closed on oversize, digest mismatch, truncation or timeout, and remove unsuccessful staging.
5. Store validated raw bytes atomically with `putIfAbsent`. Return immutable `PreparedBundle{source,digest,byteLength,reused}` references in the Definition preparation result and receipt. A matching content digest may share saved bytes, without creating an unbounded cache key or another Definition revision.
6. There is deliberately no second ZIP-in-JVM-heap path, preparation/material table, or default Node URL handoff. The saved archive is an opaque bootstrap artifact, not automatically an entry in the registered Extension catalog, a `settingsRevision`, or an applied/active Session configuration. Any Worker materialization/application remains a separate operation and needs its own acceptance evidence.

For denied hosts, malformed endpoints, expiring downloads or corrupted bytes, fail the initialization rather than executing a package or silently using a previous blob. There is no unconditional fallback to latest data.

The producer format is bounded; MA does not interpret business semantics from its inside. Existing Worker package validation/activation remains responsible for files it actually installs/executes.

### Q4: Verification and documentation only after source paths pass

Compile/prove the smallest live path before considering any optional host integration:

```text
pre-registered input → original flow (unchanged)
one Source definition → immutable native Definition → exact native admission/read-back
one missing bootstrap archive → bounded HTTPS fetch → immutable raw artifact/ref (separate from apply)
```

Do not claim the broader host integration, dynamic configuration transitions, independent MCP private refresh or full process recovery until those have their own implementation and evidence. Updating this plan's status must use actual test/commit identifiers and actual checks run.

## 5. Actual code/test locations

Use existing module structure and no new parallel project/module.

- `contracts/.../definitions/`: `ManagedAgentDefinitionSource`, `ManagedAgentDefinitionPreparation`, exact SourceRef and selection types;
- `contracts/.../extensions/`: `AgentBootstrapBundleSource`, `ManagedAgentBootstrapPreparation`, `ExtensionArchiveStorage.Info` and the shared immutable archive key;
- `control-plane/.../catalog/`: `ManagedAgentDefinitionPreparation` composition, projection normalization, receipt assembly and read-back;
- `control-plane/.../extensions/`: bounded bundle download/reuse and the existing native package preparation path;
- Existing JDBC Definition/Extension repositories and `ExtensionArchiveStorage`: continue owning immutable native storage;
- `ManagedAgentConfiguration`: opt-in Spring provider wiring only;
- `verification/src/test/java/.../catalog/`: source and preparation tests;
- `verification/src/test/java/.../extensions/`: downloader and reuse/recovery tests;
- existing `ManagedAgentEmbeddingTest`, `ManagedAgentDefinitionAdmissionTest`, `HostedExtensionsIT`: unchanged/shared regression, used only when behavior warrants their profile. The embedding test explicitly obtains the preparation service without SPI providers; `HostedExtensionsIT` was not run for this slice.

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
3. A subsequent exact preparation may `resolve` again for authorization, but does not download original bytes or create another native revision. It reuses the saved raw artifact rather than retrying an expired original URL. The native artifact is not an applied Worker configuration; delivery/application uses a separate operation and validation path.
4. Interrupt download, oversize response, short body, digest mismatch, target redirect, timeout and URI expiry all preserve the last valid package. Signed URLs/auth headers and ZIP bytes never enter logs, Definition JSON, ordinary refs or prompts.
5. An actually concurrent race either returns one immutable artifact or uses the settled winner. It never produces two independently accepted plans or silently chooses a different revision.

### Recovery limits

- A locally failed host ProviderBinding save can replay the original native receipt and then save the binding.
- Pending initialization returns the persisted stage, not a fabricated completed plan.
- If a resolved exact projection has not been saved, the operation fails explicitly; a newer published Agent is not substituted.
- Missing private material/receipt produces an explicit unavailable result, not an inferred recovery. This slice does not claim general MCP secret recovery or Turn-safe dynamic configuration replacement.

## 7. Validation entry points

The implementation was exercised with project-local checks and actual reports, not assumed success. Reproduce the affected checks from `packages/managed-agent-server/` rather than inferring acceptance from documentation status.

From `packages/managed-agent-server/`, choose focused new and affected tests rather than an indiscriminate full-repo run:

```bash
mvn -Dtest=ManagedDefinitionPreparationTest,ManagedAgentBootstrapPreparationTest,ExtensionArchiveStorageTest \
  test checkstyle:check
```

Before testing, ensure JDK 21/Maven and an isolated sibling SDK matching the tested source. When installing a needed SDK artifact, use a task-specific local Maven repository and the same setting for subsequent Maven commands as defined by the module's `AGENTS.md`.

- Required real MySQL for SQL/persistence, receipt and concurrent-writer paths: select the corresponding `mysql-integration` cases against disposable MySQL 8.4, following the current module's environment and setup constraints.
- Keep full unit/H2, Checkstyle/SpotBugs and Hosted profiles for CI; do not exempt them or invent acceptance based solely on H2 or mocks.
- If the implementation requires changes in Core/CLI/native Harness code paths, follow the repository's separate existing Node core/CLI build and focused tests. Any actual hosted-processing or recovery behavior must also have appropriate real-process evidence; current files' presence is not proof of it.
- If only Java/Doc changes land, use the MA-local Maven and doc checks rather than unrelated repository-wide TypeScript/Vitest gates. Run the repository's Prettier on added/modified docs.
- Target budget for this module's local verification per change is at most 10 minutes, unless explicitly extended. Unavailable MySQL/native process paths remain explicitly pending CI, with no substitution claim.

Each final report should identify: source commit, selected test commands and outcomes, exact mode tested, real-MySQL evidence etc. No deployment, release or host product acceptance is presumed by this plan.

## 8. Remaining qualifications

The implementation fixes the source packages to `contracts/definitions` and `contracts/extensions`, includes the original command and actor scope in receipt identity, uses `SOURCE_DEFINITION_PREPARATION`, and requires an explicit exact ref when multiple Definition providers exist. Bundle resolution has its own Source Context rather than making execution scope an anonymous credential or handing a signed URL to Node.

The verified scope is limited to the commits and tests recorded above. Full CI, complete MySQL/Hosted profiles, SpotBugs, host adaptation, production OSS access and Node/Worker application are not established by focused Java/H2/mock tests. Reusing bytes does not establish independent Runtime activation.

No generic dynamic configuration system, MCP secret refresh, second Session/Turn state machine or claim of Worker application was added. Full CI, real native processes and real host integration are remaining gates, not facts inferred from this document.
