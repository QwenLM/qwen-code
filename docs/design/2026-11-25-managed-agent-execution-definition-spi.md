# Managed Agent execution-definition and bootstrap-input design

[English](2026-11-25-managed-agent-execution-definition-spi.md) | [简体中文](2026-11-25-managed-agent-execution-definition-spi.zh-CN.md)

> Status: design proposal; not implemented. Revised on 2026-11-25.
>
> Tracking: [#18289](https://github.com/QwenLM/qwen-code/issues/18289). The host integration companion document is maintained by the host workspace; this document owns the generic MA input contract, not any product-specific catalog.
>
> Implementation plan: [English](../plans/2026-11-25-managed-agent-definition-input-spi.md) | [简体中文](../plans/2026-11-25-managed-agent-definition-input-spi.zh-CN.md).

## 1. Decision and compatibility

MA supports two ways of receiving an executable definition:

| Input mode       | Input                                                   | Outcome                    |
| ---------------- | ------------------------------------------------------- | -------------------------- |
| `PRE_REGISTERED` | The existing public definition/API and JDBC store       | Unchanged behavior         |
| `SPI`            | Exact, authorized input supplied through host SPI beans | New input preparation only |

`PRE_REGISTERED` is the default. The pre-registered full `AgentDefinitionRequest` (`model/instructions/tools/skills/mcp_servers/permission_policy/metadata`), existing create/update/get behavior and existing native Session admission remain unchanged. No existing pre-registered JSON requires migration or conversion to an SPI loader.

SPI mode is enabled by the embedding application's configuration and registered source providers. It is not selected per Turn or changed midway through an operation. Without the required provider/normalization/archive configuration, it fails closed rather than falling back to an unrelated source or latest global object.

**MA always persists the native Definition it executes.** SPI does not mean an empty Definition store or a live callback for every model round. The critical mapping is:

```text
sourceRef (exact host input identity)
  → native Definition and material refs (what MA executes and recovers)
```

ZIP initialization is an optional source-material optimization. It is used only when a matching immutable native package is absent, not for each Worker cache miss or each Turn.

### Non-goals

- A second host-product-specific business configuration authority;
- a universal `Map<String,Object>` configuration blob or mandatory loopback Java HTTP;
- replacing the existing stored-definition implementation;
- making a signed URL or log message a substitute for native execution evidence;
- arbitrary Provider reads of secrets or worker-side unbounded ZIP downloads.

## 2. Source and native identities

A source key is not just a business Agent name. An effective input must have an immutable, exact projection identity:

```java
record SourceRef(
    String providerId,       // which host SPI implementation is selected
    String agentKey,         // opaque business Agent reference, not native agentId
    String sourceRevision,   // exact immutable host revision, never "latest"
    String projectionDigest, // effective public content plus exact material identities
    String executionScope    // authenticated scope used for authorization and idempotency
) {}
```

For a new selection (`Current(agentKey)`), a host chooses the publication and returns this precise SourceRef together with the effective Definition. For an already selected projection (`Exact`), the source must return the same SourceRef/content/digest or fail; no substitution of the current publication.

The native side has distinct identities:

| Identity                                              | Responsibility                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `nativeAgentId/nativeRevision/nativeDefinitionDigest` | Immutable native Definition used by Session admission and read-back                             |
| `packageRevision/packageDigest/settingsRevision`      | Immutable installed package and independently saved settings                                    |
| `commandDigest`                                       | Original intent and receipt lookup, including caller scope and `Current/Exact` selection        |
| `appliedConfigRevision`                               | The configuration generation proven to have been applied in an actual Runtime operation         |
| `secretRef/revision`                                  | A separate exact private credential reference; it does not itself prove validity or application |

`sourceRevision`, `projectionDigest` and native digests must not be conflated. If base composition, policy or exact resource selections change, a different projection or revision may be required. A business publication integer alone need not identify a full effective projection.

MA authenticates the caller and derives authorized scope from its own Principal and Workspace checks. Source Context is not a caller-supplied set of identity strings. A provider must re-authorize its exact resolution/read against the effective Principal; possessing a SourceRef is not access permission.

## 3. Core interfaces

### 3.1 DefinitionSource

```java
public interface ManagedAgentDefinitionSource {
    Definition resolve(Context context, Selection selection);

    record Context(String tenantId, String actorId, String workspaceId,
            String executionScope, String requestId, Instant deadline) {}

    sealed interface Selection permits Current, Exact {}
    record Current(String agentKey) implements Selection {}
    record Exact(SourceRef ref) implements Selection {}

    record Definition(SourceRef ref, String modelId,
            String instructions, ToolPolicy toolPolicy,
            List<SkillInput> skills, List<ExtensionUse> suites,
            List<ManagedMcpDefinitionSource.Ref> mcpServers,
            List<BundleRef> bootstrapBundles) {}

    record ToolPolicy(String profile, String approvalMode) {}
}
```

This returns bounded text and exact references, not a runtime download of every business setting. MA transforms accepted fields into its native immutable Definition and resource pins. Generated instructions and static Skill refs are published during native Session creation for the admitted sessionId, not as unscoped global resources beforehand.

### 3.2 Bootstrap bundles

```java
public interface AgentBootstrapBundleSource {
    Resolved resolve(Context context, BundleRef ref);

    record BundleRef(String providerId, String resourceId,
            String sourceRevision, String expectedDigest,
            Long expectedLength) {}

    record Resolved(BundleRef ref, Download download) {}

    // Private locator obtained for this authorized, exact request.
    record Download(URI signedUri, Instant expiresAt,
            String contentType) {}
}
```

`signedUri` is a short-lived, scoped third-party download location, optionally obtained by the host from services such as OSS. MA consumes it with a controlled downloader that enforces allowed destinations and redirect policy; the URI does not itself confer an arbitrary outbound routing permission. It is not a durable permission grant and must not be written to public Definition JSON, logs or an ordinary resource reference.

An implementation may also return a bounded byte stream through an analogous source contract where that is cheaper than a URL indirection. The existing `ManagedExtensionSource.resolve/open` remains the preferred existing implementation when no URL-based initialization is needed.

MA retains the downloaded/normalized immutable package and precise pin. Once captured, subsequent Worker preparation uses MA's saved artifact rather than a second signed URI. Once an invocation has started, its outcome is reconciled through the same preparation receipt, not by minting a new address under another projection.

### 3.3 Skill and suite

Re-use the existing `ManagedExtensionSource`:

- independent Skill → `kind="skill"`;
- suite or an asset-bearing Skill → `kind="extension"`;
- resolve returns an exact source reference and private locator, optionally with expectedDigest;
- open is a bounded stream only for a necessary new immutable package.

`settingsRevision` is a separately saved/applied settings identity and never a by-product of ZIP compilation.

### 3.4 Independent MCP and credentials

```java
public interface ManagedMcpDefinitionSource {
    Definition resolve(ManagedAgentDefinitionSource.Context context, Ref ref);
    // Ref: providerId, serverId, sourceRevision, definitionDigest.
    // Definition: complete transport recipe and includeTools, without secret plaintext.
}

public interface ManagedMcpCredentialSource {
    Secret open(ManagedAgentDefinitionSource.Context context, SecretRef ref);

    interface Secret extends AutoCloseable {
        String revision();
        Instant expiresAt(); // Nullable only if the issuer has no expiry.
        byte[] bytes();      // Protected; never logged or publicly projected.
        @Override void close();
    }
}
```

The native server revision is a MA-generated JavaScript-safe positive integer and native definition digest; it is not the host text revision. Secret refresh is an independently admitted operation with a new exact revision and expected applied config revision. It never overwrites an existing operation's content or silently changes the running Turn.

Every credential open re-authorizes the exact secret revision and returns a handle closed in `try/finally`, including preparation/delivery failure. When neither MA nor the Runtime retains the required protected value, failure recovery cannot invent it from a SecretRef: the result is `recovery_unavailable/refresh_required`, not simulated success.

### 3.5 MA's application entry

```java
public interface ManagedAgentDefinitionPreparation {
    PrepareReceipt prepare(Command command);

    record Command(Principal principal, Selection selection,
            String operationKey) {}

    record PrepareReceipt(OperationRef operation,
            NativeDefinitionRef definition, MaterialPlanRef materials) {}
}
```

The host calls this MA-owned method. It is not a host SPI implementation.

`prepare` only prepares immutable Definition/material plans. Native Session creation, settings apply, Extension application and MCP application are separate MA operations, with independent operation keys, reads and actual applied receipts. A completed preparation does not substitute for any of these admission steps.

## 4. Persisted state versus diagnostics

### Existing records kept

| Record                                                      | What remains authoritative                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ma_agent_definition`                                       | Pre-registered, complete immutable definition content keyed by tenant/id/revision/digest |
| `ma_session`, `ma_turn`, `ma_session_record`, `ma_resource` | Actual Session, Turn, journal and immutable content/ref evidence                         |
| `ma_runtime_binding`                                        | Runtime placement and drain/ownership facts                                              |
| `ma_extension_package` / archive storage                    | Existing compiled extension material and immutable payloads                              |
| `ma_extension_settings`                                     | Independently saved, encrypted settings revisions                                        |
| `ma_request_receipt`                                        | Admitted operation identity and replayable results for its own operation namespace       |

For SPI-produced definitions, associate the `SourceRef` with the native Definition and Material Plan using the native source-preparation/metadata and receipt representation chosen during implementation. That association is necessary to decide whether an exact native projection already exists; it is not a license to reinterpret a free-text agent name as a unique accurate cache key.

### No mandatory pair of new tables by default

The initial minimal SPI initialization does **not** require two new preparation/material tables. Prefer reusing the existing immutable Definition, resource, package, settings and receipt contracts. Logs additionally record provider/ref, byte counts, digest checks, operation identity, target worker and outcome for audit and latency analysis.

If the implementation later promises recovery of a long-running or unknown preparation, persist the command as pending in an operation receipt **before the first external Source I/O**, preserve the exact resolved projection at receipt of that projection, and mark prepared only when its native refs exist. If the existing receipt and native plan cannot express the required state, add the smallest persistent preparation record justified by a concrete multi-replica recovery case; do not store this solely in a log and call it recoverable.

### ZIP bytes and signing details

Never put a large ZIP blob into `ma_agent_definition.definition_json` or JVM heap. Persist immutable normalized packages in a private archive backend, with their digest, expected/actual length and native pin. Store source digest and source-to-native mapping, not short-lived URLs or Authorization values.

## 5. Target sequence

```mermaid
sequenceDiagram
    autonumber
    participant Host as Host ExecutionProvider
    participant Prep as ManagedAgentDefinitionPreparation
    participant App as MA Session / Runtime applications
    participant Bind as Host ProviderBinding
    participant Def as ManagedAgentDefinitionSource
    participant Bundle as AgentBootstrapBundleSource
    participant Store as MA Definition / Material Store
    participant Harness as Node Hosted Harness
    participant Runtime as MA Broker / Runtime Worker

    Note over Host,Runtime: PRE_REGISTERED remains the default and keeps its existing API/store flows
    Host->>Prep: prepare(authenticated Principal, Selection, operationKey)
    Prep->>Store: Validate Principal; inspect original receipt and exact native projection
    alt Matching committed native projection exists
        Store-->>Prep: Exact native Definition/material refs and original receipt
        Note over Def,Bundle: No host call and no latest lookup
        Prep-->>Host: PrepareReceipt(original)
    else New source preparation (or a saved pending stage to continue)
        Prep->>Store: Admit/continue the exact operation phase before external I/O
        Prep->>Def: resolve(MA-derived Context, Current / Exact)
        Def-->>Prep: SourceRef and complete effective Definition
        Prep->>Store: Preserve exact SourceRef/projection and native Definition identity
        opt A specified bootstrap package has no matching native artifact
            Prep->>Bundle: resolve(Context, exact BundleRef)
            Bundle-->>Prep: Short-lived signed download locator, expected digest and length
            Prep->>Bundle: Controlled streaming download through the downloader
            Bundle-->>Prep: Bytes validated against expected limits/digest, never whole-blob in heap
            Prep->>Store: Save immutable native package and source-to-native mapping
            Note over Store: No signed URL, Authorization or ZIP bytes in Definition JSON
        end
        Prep->>Store: Commit native Definition/material plan and original operation
        Prep-->>Host: PrepareReceipt(native definition/material plan)
    else Same operationKey, different original command
        Store-->>Prep: idempotency conflict
        Prep-->>Host: Reject without selecting latest or inventing a new source identity
    end

    Note over Host,Runtime: Independent MA application operations with their own keys/receipts, not part of prepare
    Host->>App: admitNativeSession(newSessionOperationKey, exact native Definition pin)
    App->>Store: Persist admission/sessionId; publish Session instructions/Skill refs on create
    App->>Harness: Create/attach by native pin
    Harness->>Store: Read Session instructions/Skill refs with digest validation
    App->>Runtime: Apply exact saved package/settings and MCP recipe/private material
    Runtime-->>App: Native admission and applied/active receipts
    App-->>Host: Return independent admission and applied/active receipts
    Host->>Bind: Persist ProviderBinding plus exact prepared and applied references
    Note over Def,Bundle,Runtime: Normal Turns never call host SPI; saved material may be delivered to a new Worker without re-download
```

The `Current` path requires fresh host authorization and selection. `Exact` means the host returns a known immutable input, not a global latest lookup. An admitted settled replay is answered before recalculating current. Pending initialization returns/reconciles its persisted stage and cannot return a completed plan. A missing resolved projection can never be recovered by choosing whatever is latest after a restart.

## 6. Streaming, parsing and safety boundaries

The current Extension import provides a useful receiving pattern: chunk input into a private temporary file, stage hash and byte counts while reading, cap concurrent preparation, and only proceed after verified content. Its existing example uses 64 KiB chunks and a limit of four concurrent preparation operations (`ManagedExtensionPackageService.java:246-290`). This is an implementation pattern, not a promise that every deployment shares one size limit.

For the proposed bootstrap download:

1. enforce a configured maximum archive size and concurrent download count;
2. count actually read bytes, rather than trusting `Content-Length`;
3. use bounded reader/writer, private staging, connection/read/operation deadlines, and cleanup in `try/finally`;
4. release responses only after validation length and digest agree, then atomically publish the native artifact;
5. stream subsequent Runtime delivery from the immutable artifact rather than allocating a full-package `byte[]`;
6. redact signed URLs, issuer headers and raw secrets from logs, receipts, prompts and public refs.

MA can act as an integrity-checked opaque receiver for a trusted, well-specified host package. **It need not perform business semantic review of the archive contents.** Archive extraction path containment, entry count/size limits, manifest schema compatibility and safe execution must remain covered by the trusted package packaging profile and the Worker that consumes the archive, where those checks are applicable. If MA stores a package as executable input, it must not silently accept an arbitrary opaque vendor ZIP as an already supported executable package.

Receiving signature verification, artifact publication, Worker materialization and actual configuration activation are distinct evidence. A successful signature check alone does not prove successful execution or recovery.

## 7. Delivery and verification plan

Start with the smallest vertical slice:

1. Preserve the existing pre-registered definitions and Sessions unchanged.
2. Validate one small Definition via SPI: authenticated scope, exact SourceRef, native revision/digest, actual read-back before submission, and no host callback in a normal model round.
3. Introduce one bootstrap ZIP: verify only a missing native package triggers the download, limiting and streaming work as described, a private immutable archive forms, and its subsequent Worker uses the saved artifact.
4. Exercise two concurrent preparations, a locally failed provider binding save, missing current configurations, an expired URL, an oversized package, and lose the response after native commit. They must reconcile to the same native refs or an explicit unresolved stage, not a newly selected latest one.
5. Only then add native MCP protocol changes: complete recipes, `includeTools` handling in exact advertised capabilities/schema, native `serverRevision`, and protected credential durability/recovery. Do not alter the closed v1 base manifest by silently accepting new unknown keys.

Required observational assertions:

- legacy pre-registered inputs do not require SPI beans or change behavior;
- repeated preparations with the same exact projection derive the same native identity; a different scope cannot reuse the authorization result;
- the right Source method is called for a fresh authorization, while replay/recovery uses saved exact refs;
- Worker delivery need not imply another original-source `open` or compilation;
- an unavailable/empty secret is a recovery error, never an unspecified global-latest fallback;
- native admission, prepared material and actual applied/active receipts remain distinct, with real MySQL and actual Node/Worker-process verification before broader acceptance.

## 8. Current status and change log

The previous revision conflated preparation and application in one sequence, and imposed two unspecified preparation/material tables. This revision narrows the first delivery to:

- source-reference identity input plus immutable native Definition/material persistence;
- one-shot initialization only for a missing native artifact, using bounded streaming download;
- preservation of pre-registered full AgentDefinition behavior;
- independent native application operations and their receipts;
- a small, generic SPI that can be implemented by arbitrary hosts.

Source-reading baseline: `dev/managed-agent@e8c189fb90a204ab8762f8c8fc8e66d0f833271c`. The new names and tables mentioned as proposals are not present implementations. No build, run, recovery or real-process acceptance is claimed by this design revision.
