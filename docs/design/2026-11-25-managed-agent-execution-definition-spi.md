# Managed Agent execution definition input SPI

[English](2026-11-25-managed-agent-execution-definition-spi.md) | [简体中文](2026-11-25-managed-agent-execution-definition-spi.zh-CN.md)

> Status: design proposal; not implemented. Created: 2026-11-25.
>
> Tracking: [#18289](https://github.com/QwenLM/qwen-code/issues/18289). The host integration companion document is maintained by the host workspace; this document owns the generic Managed Agent input contract.

## 1. Problem and decision

An embedding host owns business Agent/Skill/MCP publications, authorization and immutable materials. Managed Agent (MA) needs the effective execution inputs, not an independently editable copy of that catalog.

| Contract                            | Owner | Implementer | Purpose                                                                          |
| ----------------------------------- | ----- | ----------- | -------------------------------------------------------------------------------- |
| `ManagedAgentDefinitionSource`      | MA    | Host        | Resolve an exact, authorized effective Agent definition during a new preparation |
| `ManagedMcpDefinitionSource`        | MA    | Host        | Provide a complete exact MCP recipe and its non-secret inputs                    |
| `ManagedMcpCredentialSource`        | MA    | Host        | Read an exact, private credential revision during controlled materialization     |
| `ManagedExtensionSource` (existing) | MA    | Host        | Resolve/open exact Skill or Extension inputs                                     |

MA also exposes `ManagedAgentDefinitionPreparation`, implemented **by MA**. It prepares a Definition/material plan; it does not create a Session, apply a configuration or execute a model/tool Turn. Those are separate MA application operations with their own operation keys and receipts.

Node's agent-loop never calls a host SPI. Runtime Workers use material persisted by MA or delivered through an authenticated, verified protocol.

### Non-goals

- A second business catalog, host-product-specific types, a universal configuration map or a mandatory loopback Java HTTP adapter.
- AgentRun-style selection on every Turn, Definition callback in every model round, or automatic token rotation during an active Turn.
- Treating Definition preparation as proof of Runtime activation, or pretending that a saved credential reference is sufficient for recovery when the protected material has not been retained.

## 2. Current behavior this design preserves

Baseline: `dev/managed-agent@e8c189fb90a204ab8762f8c8fc8e66d0f833271c`.

- Native AgentDefinitions are tenant-scoped append-only revisions. Native Session admission pins `agentId/revision/digest`; updating a definition affects new Sessions only.
- During Session creation, `QwenHostedHarnessConnector.agentDefinition` publishes instructions/Skill refs for the admitted Session (`QwenHostedHarnessConnector.java:2585-2625`). Node reads them through the Resource Store with byte/digest verification, not a host callback (`http-managed-session-store.ts:2665-2717`). There is no supported pre-Session global instructions publisher.
- The hosted pin is narrow, not a complete configuration (`packages/cli/src/serve/hosted-agent-definition.ts:16-90`).
- Static Skill bodies do not carry asset files. Extension compilation records assets and their directories (`packages/core/src/extension/managed-package.ts:404-426`).
- `ManagedExtensionSource` authorizes exact `skill|extension` references. Package preparation computes/source-verifies digests and persists compiled packages (`ManagedExtensionPackageService.java:246-315`). A new source-based selection performs authorization `resolve`; admitted replay and eligible recovery use saved pins. `resolvePin` reads MA-stored archive, not the original host Source.
- Package compilation/import is independent of extension settings creation. An imported package may use `settingsRevision=null`; an actual settings revision comes from the separate `saveSettings` operation, not from ZIP compilation.
- Base independent MCP definitions currently come from a Runtime-private manifest (`QWEN_MANAGED_MCP_CONFIG`). Its Version-1 closed fields cover transport recipes, but neither an arbitrary host `includeTools` field nor arbitrary independent Definition imports (`packages/cli/src/serve/managed-context-worker.ts:436-464`, `managed-mcp-runtime.ts:179-196,259-342`). Extension staging already shows how a complete manifest can be assembled (`managed-extension-manifests.ts:40-56,192-238`).
- Definition create has persistent idempotency receipts. For the same tenant/key/normalized native definition request, a losing concurrent writer replays the winner's receipt rather than keeping another random native ID (`JdbcManagedAgentDefinitionStore.java:47-91,157-196`; `ManagedAgentDefinitionService.java:96-113`). Update needs a separate ordering policy and is not identical to replay.
- Personal MCP OAuth, expiry-aware private revisions and transparent refresh are not delivered by the current self-service protocol.

The concepts borrowed from an established coordinator–host adaptation are limited to: trusted server-created identity, `current` versus `exact`, verified material digests, external I/O outside database transactions, and a distinct host/native revision mapping. MA does not inherit another coordinator's revision format, Manifest or Run lifecycle.

## 3. Interface ownership and call sequence

The diagram below is the target design. It does not represent an implemented end-to-end path or a promise of transactional behavior across host and MA stores.

```mermaid
sequenceDiagram
    autonumber
    participant Exec as Host ExecutionProvider
    participant Reader as Host definition reader
    participant Bind as Host ProviderBinding
    participant Prep as ManagedAgentDefinitionPreparation
    participant App as MA Session / Runtime applications
    box Host SPI implementations
        participant Def as ManagedAgentDefinitionSource
        participant Ext as ManagedExtensionSource
        participant McpDef as ManagedMcpDefinitionSource
        participant Cred as ManagedMcpCredentialSource
    end
    participant Store as MA Definition / Material Store
    participant Harness as Node Hosted Harness
    participant Runtime as MA Broker / Runtime Worker

    Note over Exec,Prep: Phase A: Definition/material preparation only
    Exec->>Prep: prepare(authenticated Principal, Selection, operationKey)
    Prep->>Store: Validate Principal; derive trusted scope; find by commandDigest(scope, operationKey, originalSelection)
    alt Existing committed preparation with the same commandDigest
        Store-->>Prep: Original projection and native refs
        Note over Def,Cred: No new Source call and no latest lookup
        Prep-->>Exec: PrepareReceipt(original prepared result)
        opt ProviderBinding was not saved locally
            Exec->>Bind: Save the original source-to-native mapping
        end
    else Existing pending preparation
        Store-->>Prep: Original saved stage and any already-resolved projection
        Prep-->>Exec: Continue/reconcile that pending operation; no completed receipt
        Note over Def,Cred: Do not reselect a newer projection to complete an older operation
    else New preparation or a normalized request-producing a committed winner
        Prep->>Store: Atomically admit pending command, or read existing committed receipt
        Prep->>Def: resolve(MA-derived Context, Current / Exact)
        Def->>Reader: Authorize selection and exact effective materials
        Reader-->>Def: sourceRevision, inputDigest and complete effective Definition
        Def-->>Prep: Definition(model / instructions / tools / skill / suite / MCP refs)
        Prep->>Store: Persist resolved projection and next preparation stage before further I/O
        opt Skill assets or suite present
            Prep->>Ext: resolve(Context, exact source reference)
            Ext-->>Prep: Private locator and expected digest
            opt No matching compiled native package exists
                Prep->>Ext: open(Context, exact source)
                Ext-->>Prep: Original archive stream
                Prep->>Harness: preparePackage(metadata, stream)
                Harness-->>Prep: Canonical package and packageDigest
                Prep->>Store: Save immutable package (settingsRevision remains null unless separately saved)
            end
        end
        opt Independent settings revision required
            Prep->>Store: Independently save/prepare exact settings with its own operation key
            Note over Store: This is not a by-product of package compilation
        end
        opt Independent MCP present
            Prep->>McpDef: resolve(Context, exact server reference)
            McpDef-->>Prep: Complete recipe, includeTools and exact SecretRefs
            Prep->>Cred: open(Context, exact secret revision)
            Cred-->>Prep: Protected material, secret revision and expiresAt
            Note over Cred: Secret handles close in try/finally after materialization or failure
        end
        Prep->>Store: Save compiled Definition/material plan and committed preparation receipt
        Prep-->>Exec: PrepareReceipt(operation, native definition/material plan)
        Exec->>Bind: Save the ProviderBinding mapping
    else Same operationKey with different originalSelection or caller scope

        Store-->>Prep: idempotency conflict
        Prep-->>Exec: Reject without replacing the original operation
    end

    Note over Exec,Runtime: Phase B: distinct native admission and apply operations, each with its own receipt
    Exec->>App: admit native Session(newSessionOperationKey, exact native Definition pin)
    App->>Store: Persist native Session admission and obtain sessionId before Harness calls
    App->>Store: Publish instruction/Skill refs on create; reuse exact saved refs on attach
    App->>Harness: Create/attach Session by exact native pin
    Harness->>Store: Read this Session's instruction/Skill refs
    Store-->>Harness: refs/resource bytes after digest verification
    App->>Store: Read actual Session agent_id, agent_revision and agent_digest
    Store-->>App: Actual pinned Definition identity
    App-->>Exec: AdmissionReceipt(sessionId, verified Definition identity)
    opt Extension apply required
        Exec->>App: applyExtensions(newApplyOperationKey, saved package/settings pins)
        App->>Runtime: Deliver exact saved archive, selected settings and manifest
        Runtime-->>App: applied/active configuration revision
        App-->>Exec: AppliedReceipt(target config revision, corresponding package/settings pins)
    end
    opt Independent MCP apply required
        Exec->>App: applyMcp(newMcpOperationKey, complete recipe and selected secret revisions)
        App->>Runtime: Deliver complete manifest and hydrate selected private material
        Runtime-->>App: Connection/discovery result and applied receipt
        App-->>Exec: AppliedReceipt(native server identity and applied configuration revision)
    end
    Exec->>Bind: Persist native admission and independently proven applied versions
    Note over Exec,Runtime: A normal model/tool Turn follows later; it uses saved refs/packages/catalogs and never calls a host Source
```

`DefinitionSource.Current` is used only for a new business selection. `Exact` is a fresh authorized read of a known source reference. Neither is a per-Turn callback. A replay first looks up the persisted command intent and phase; it does not re-evaluate `Current` or reinterpret a pending operation as completed work.

The preparation path atomically admits the original command as pending before source I/O, saves the resolved exact projection immediately after it is returned, and marks preparation committed only after the material plan and native refs exist. A concurrently committed winner is replayed without another Source call. An unresolved projection cannot be recovered by picking whatever is latest after a restart.

On the Session path, MA first persists admission and has a concrete sessionId, publishes instruction/Skill refs for that Session only on create (reuse exact saved refs on attach), and only then invokes Harness create/attach. This matches the existing connector order; it does not create a global pre-Session resource publisher.

There are two distinct directions:

- **Host → MA**: call MA's Definition preparation and, separately, its native admission/application operations.
- **MA → Host**: MA invokes source SPI, deriving the trusted context itself. Host selection and authorization do not replace MA's Workspace/Principal checks.

## 4. DefinitionSource contract

The following illustrates Java shapes, not an existing ABI. Names may be refined during contract review if these semantics are preserved.

```java
public interface ManagedAgentDefinitionSource {
    Definition resolve(Context context, Selection selection);

    // Constructed by MA from its authenticated Principal and authorized scope,
    // never accepted as an arbitrary caller-supplied tenant/actor identity.
    record Context(String tenantId, String actorId, String workspaceId,
            String executionScope, String requestId, Instant deadline) {}

    sealed interface Selection permits Current, Exact {}
    record Current(String agentKey) implements Selection {}
    record Exact(DefinitionRef ref) implements Selection {}

    record DefinitionRef(String agentKey, String sourceRevision,
            String inputDigest) {}

    record Definition(DefinitionRef ref, String modelId,
            String instructions, ToolPolicy tools,
            List<SkillInput> skills, List<ExtensionUse> suites,
            List<ManagedMcpDefinitionSource.Ref> mcpServers) {}

    record ToolPolicy(String profile, String approvalMode) {}

    sealed interface SkillInput permits InlineSkill, ExtensionUse {}
    record InlineSkill(String name, String description, String body,
            String baseDirectory) implements SkillInput {}

    record ExtensionUse(ManagedExtensionSource.Reference source,
            ManagedExtensionPackages.Target target) implements SkillInput {}
}
```

### Semantics

- `Current` returns a complete exact result after fresh host authorization and selection. MA does not retain a live current view.
- `Exact` must return the original `sourceRevision` and `inputDigest`; it may not silently substitute a newer publication.
- `agentKey` is a host Agent reference, not an authorization token. `executionScope` identifies an authorized execution partition and does not itself grant access to a secret or resource.
- Native scope derives from MA-authenticated Principal and its Workspace checks. It is not constructed by trusting raw caller-provided tenant/actor strings.
- `inputDigest` covers normalized effective public inputs and exact selected material identities. An Agent integer revision alone may not distinguish dynamic dependencies, base composition, permitted enterprise policy or chosen artifacts.
- An asset-bearing Skill or a suite uses `ExtensionUse`. It is not an `InlineSkill` whose `baseDirectory` points into a host filesystem. Host-specific classes remain outside MA.
- Model credentials live behind the configured Runtime model route, not public Definition JSON.
- Definition content is bounded text. There is no per-Turn `DefinitionSource.open`; large artifacts travel through the existing Extension source.

### Context compatibility with existing Extension source

The original `ManagedExtensionSource.Context` carries tenant, actor, Workspace, requestId and deadline. Reuse of this SPI means reuse of `resolve/open` and private locator semantics, not pretending that the new source group can be passed unchanged through every older context record.

When `executionScope` is merely a stable host bookkeeping namespace, an adapter can deterministically map it without changing resource authority. If it changes which material an actor may use, source authorization must preserve that exact scope through an updated common Context/adaptor. Such a contract/Context extension must be explicitly reviewed and versioned before any Provider is integrated; the existing actor/Workspace pair is not silently equivalent to an arbitrary new authorization scope. A `SecretRef` is never a substitute for a fresh exact-revision authorization check.

## 5. Extension, MCP, and credentials

### 5.1 Skill and suite materials

A `Reference` must remain exact across `resolve`, `open` and the resolved locator. If an expected digest is supplied, MA validates it while reading bytes. The native `packageDigest` belongs to the compiled output, not the original input.

```text
authorized resolve
  ├─ matching native package absent: open → compile → persist immutable package
  └─ matching native package exists: reuse it, without host open/recompile
       → Worker delivery always loads saved package from MA, not from host Source
```

An imported/compiled package does not automatically create a settings revision. If a null/empty setting is used, it is explicit. If a non-null revision is needed, it is saved/applied through its own operation key and independently protected value flow.

### 5.2 `ManagedMcpDefinitionSource`

```java
public interface ManagedMcpDefinitionSource {
    Definition resolve(ManagedAgentDefinitionSource.Context context,
            Ref ref);

    record Ref(String providerId, String serverId,
            String sourceRevision, String definitionDigest) {}

    record Definition(Ref ref, Recipe recipe,
            List<String> includeTools) {}

    sealed interface Recipe permits Stdio, Http {}
    record Stdio(String command, List<String> args,
            Map<String, String> environment,
            Map<String, SecretRef> secretEnvironment) implements Recipe {}

    record Http(URI endpoint, Mode mode, Map<String, String> headers,
            Map<String, SecretRef> secretHeaders) implements Recipe {}

    enum Mode { SSE, STREAMABLE_HTTP }

    record SecretRef(String credentialId, String revision) {}
}
```

The source-level revision and digest bind a complete recipe, not a display name. private credential refs identify exact material rather than plaintext secret bytes.

MA generates and retains a separate **native `serverRevision` (a JavaScript-safe positive integer) and native `definitionDigest`**. The host's text `sourceRevision` is only a mapping key. The native digest describes the complete admitted public recipe plus intended private-reference identities; it must not contain plaintext secrets or expose a public hash of low-entropy secret values.

This full connection recipe is **not accepted by the current Node `mcp-configure` pin protocol or Version-1 base manifest**. The implementation must explicitly add a versioned internal Runtime apply/manifest path for:

- independently sourced full recipes and historical native revisions;
- `includeTools` filtering in discovery/advertised tool input schemas, rather than silently adding an unknown v1 key;
- exact private-reference materialization and secret delivery;
- digest verification, idempotent application, release/reconnect and recovery.

Extension manifest staging can inform this path, but an independent Definition is not disguised as an Extension contribution merely to avoid a reviewed contract change. `managed-agent-public-api.openapi.json` changes only if a public HTTP surface is later exposed.

### 5.3 `ManagedMcpCredentialSource`

```java
public interface ManagedMcpCredentialSource {
    Secret open(ManagedAgentDefinitionSource.Context context,
            ManagedMcpDefinitionSource.SecretRef ref);

    interface Secret extends AutoCloseable {
        String revision();
        Instant expiresAt(); // Nullable only when the issuer declares no expiry.
        byte[] bytes();      // Sensitive: never log it or put it in a public projection.
        @Override void close();
    }
}
```

Every `open` authorizes the exact requested source revision. The source returns exactly that revision or a typed failure. The secret handle is used only during bounded private materialization and closes in `try/finally`, including failed preparation/delivery. The implementation must never put raw values into a model prompt or ordinary resource reference.

A refresh uses a new exact secret revision and independent apply operation. It cannot rewrite an admitted operation or mutate an executing Turn. If a refresh's receipt is unknown, only that original operation may be queried or continued.

**Eligibility for secret recovery:** either MA or the Runtime must have retained every required private value under the required protection and exact selected revision. If only a `SecretRef` survives, recovery cannot invent the missing value. It must return an explicit `recovery_unavailable` / `refresh_required` outcome rather than unrelated latest material or a false success. Before this private persistence and hydration story is implemented, independent MCP secret recovery is pending rather than an accepted closed contract.

### 5.4 `ManagedAgentDefinitionPreparation`

```java
public interface ManagedAgentDefinitionPreparation {
    PrepareReceipt prepare(Command command);

    // Principal is authenticated/issued by MA or its embedded trust boundary.
    record Command(Principal principal,
            ManagedAgentDefinitionSource.Selection selection,
            String operationKey) {}

    record PrepareReceipt(OperationRef operation,
            NativeDefinitionRef definition, PlanRef materials) {}
}
```

`prepare` is implemented by MA and handles only Definition/material preparation. `Principal` is not a caller-declared tenancy and `operationKey` is not permission credential. A receipt names the actual persisted native definition/material plan and operation. It does not include or fake an applied state.

Subsequent native Session admission, Extension apply and independent MCP application are called as their own MA operations, use independent operation keys and read their own receipts. `getPublicSession` verifies the actual admitted Session's native definition identity. Normal model/tool Turns follow their own admission and execution protocol.

## 6. Identity, idempotency and recovery rules

### Three related but distinct digests

- **Command digest:** normalized authenticated caller scope, operation key and original Selection (including `Current(agentKey)` or `Exact(ref)`). It identifies the original application intent and receipt lookup. It does not claim the actual selected publication.
- **Effective projection digest (`inputDigest`):** normalized resolved Definition and exact non-secret material identities. It distinguishes different resolved publications/configurations and is part of the source→native mapping.
- **Native definition/package digests:** computed and persisted by MA for the actual compiled Definition and package representations. These are not substituted for the host's projection digest, and a package digest is not a settings revision.

A later `Current(agentKey)` alone cannot reconstruct the previous projection from memory. An admitted replay therefore reads the saved projection, phase and receipt, not a repeater call to Source selecting latest.

### Independent operation namespaces

Definition preparation, native Session admission, Extension import, settings save/apply, MCP application and refresh have independent operation keys and receipts. Replay of one does not authorize another, especially a new Session or application.

### First release: create-only per effective projection

Do not update a shared native Agent for each publication update in the first integration. This avoids the native update revision-order problem.

For two replicas planning the same exact effective projection:

1. both derive the same normalized request and stable source group;
2. the winner atomically commits the native definition/material plan and receipt;
3. the losing writer rolls back its duplicate attempt and replays that exact recorded winner;
4. both read the same native refs, without latest lookup.

This requires the same normalized request, not merely the same business Agent name or raw `Current(agentKey)` selector. Different original commands using one key conflict. New valid projections use new source-group/receipt identities.

If MA committed but the host has not saved ProviderBinding or the response is lost, the host retries the original command operation, reads the original result and then saves the binding. A mapping table with an independent uniqueness authority is not needed to implement the persistent receipt pattern.

Continued linear updates under one native ID need an explicit expected-base/CAS or group serialization contract. A failed competing command with no committed receipt must not be described as replaying the command's previously accepted response.

### Preparation, pending, replay and recovery

- `prepare` only creates a persisted definition/material plan. It never performs a model/tool Turn, and its completed receipt does not authorize subsequent admission/application.
- An admitted but still pending preparation returns/reconciles its current saved stage, not a completed result. Any already-resolved projection remains fixed. If no resolved projection was saved, recovery must report that it cannot recover one rather than choosing a newer candidate.
- Admitted replay selects the original saved projection; proven recovery uses the original operation and saved exact material. New business authorization happens only for a new admission/selection operation.
- A missing cached native Worker package does not cause host `open` or recompilation. Delivery reads the stored package. Host open/compilation is limited to a missing native compiled package following a newly authorized selection.
- Secret references are useful only if their protected material was retained. If not retained, recovery is explicitly unavailable until an authorized new operation supplies it.
- Generation/revision for application is recorded independently from source or secret revision. An applied receipt links the target configuration generation to exact package/settings/server identities and the actual admitted operation.

The `executionScope` participates in both idempotency and authorized selection. Replicas must not derive a group from a process ID, random request UUID or timestamp, and no replay may broaden a caller's scope.

## 7. Proposed implementation locations

These are proposals, not existing files or present compatibility promises.

- `contracts/.../catalog/`: generic Definition source, trusted context, value types and compiler integration.
- `contracts/.../mcp/`: exact MCP recipe, private credential source and bounded types.
- `control-plane/.../catalog/`: Definition preparation orchestration, stage/receipt persistence and actual native identity verification.
- Existing Extension services and `ExtensionArchiveStorage`: retain source/package compilation, saved archive access and separate settings save behavior.
- Runtime/Broker/Worker contracts: receive the explicitly versioned archive, manifest and private delivery additions. `HarnessConnector` remains an operations interface, not a host material source SPI.
- Node `managed-context-worker.ts` and managed MCP modules: accept the reviewed exact manifest/scheme and perform only their native materialization/discovery/connection paths.
- Node Hosted Session loaders: continue verifying persisted native Session/ref identities instead of following a live host feed.

The first integration uses Java embedding through the official `ManagedAgentConfiguration`; it does not require a new public HTTP surface. Existing public Definition registration retains its behavior when no host SPI is provided. Any eventual public HTTP protocol requires an explicit OpenAPI change and its own authentication/client updates.

The host owns business selection, ProviderBinding and adapters. MA must never depend on the host product's packages or protocol.

## 8. Delivery stages and verification

1. **Definition-only spine:** admit an exact definition with a generic fake host; prepare instruction/Skill refs in Session creation; read back its actual native identity before the next submit.
2. **Extension assets:** show an actual attached-file use, source/package digest validation, correct package/settings identities and reprepare.
3. **Independent MCP:** implement the explicit internal manifest/apply version, real discovery and actual connection, protected hydration and bounded secret recovery.
4. **Configuration transition:** separately review any whole-configuration transition for an existing Session. Until then, changing a native AgentDefinition pin requires a new native Session; model/approval/Extension/MCP operations are not automatically an atomic publication flow.
5. **Host acceptance:** real MySQL, multiple replicas, actual Node/Worker processes and normal model/tool effects. Distinguish source reads, prepared plans, admitted Sessions and independently applied configurations.

### Required tests and evidence

- **Principal isolation:** raw caller tenant/actor strings cannot select a source or disclose a credential; generic fake hosts and no-provider existing paths work without product-specific types or bypasses.
- **Command and phase recovery:** same original command replays exact saved results; pending preparation is never reported as completed; an unresolved projection is not silently selected afresh; responses lost after native commit save the same host binding later.
- **Concurrent registration:** equal exact normalized input converges on one native ID and refs. Raw `Current(agentKey)` alone must not be used as a proof that differing resolved inputs are equal.
- **Source and cache:** a fresh admission runs `resolve`; only a missing native compiled package runs `open` + compile; a Worker requiring delivery reads saved packages without those operations.
- **Revocation:** same-pin new authorization is refused after source revoke/delete; admitted original replay uses its receipt; recovery uses retained MA material only when all other conditions hold.
- **Settings and credentials:** compile/import never silently produces a custom settings revision; missing protected material is an explicit recovery failure; receipt-lost refresh continues the original operation; active-Turn apply is rejected unless a separate specified refresh protocol supports it.
- **Native content:** instruction resources, assets, Extension contributions, actual discovery/tool schemas and normal model/tool effects are correct. Sensitive values stay outside logs, public recipes, ordinary catalog refs and events.

## 9. Implementation-review points and verification status

Still to be reviewed precisely during implementation:

- Final package names, the concrete authenticated `Principal` type and how authorized execution scope is mapped to the existing Extension source Context without weakening resource authorization.
- Canonicalization of command and projection digests, native recipe versions and the receipt records' scoped uniqueness constraints.
- The versioned independent MCP Runtime/Worker manifest contract, private protected storage/hydration and recovery behavior. Existing Extension settings tables are not silently repurposed.
- Tool-profile compatibility, session rebuilding versus later whole-definition transition, and real MySQL/Node/Worker/multi-replica evidence budgets for widening the first vertical slice.

Documentation verification for this update:

- Relative links and reciprocal language links were checked with a local script.
- English and Chinese section structure, Java declarations and Mermaid diagrams were compared. Translated Java comments are explanatory text and were excluded from the declaration comparison.
- `git diff --check` and added-file whitespace checks passed.
- The standard Prettier check was **not completed**: no installed executable exists locally, and `npx --no-install` attempted a registry request that failed with `ECONNRESET`. `mmdc` was also unavailable locally, so no generated image was validated. These missing checks must not be reported as passed.
- No production Java/TypeScript changes were made and no build, runtime process or end-to-end acceptance has been run. This remains a design proposal, not an implemented, recovered or accepted capability.
