# Managed Agent execution-definition and bootstrap-input design

[English](2026-11-25-managed-agent-execution-definition-spi.md) | [简体中文](2026-11-25-managed-agent-execution-definition-spi.zh-CN.md)

> Status: first Java preparation slice implemented and locally verified; Section 8 records its exact limits and remaining qualifications. Revised on 2026-11-25.
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

    sealed interface Selection permits Current, Exact, PreRegistered {}
    record Current(String agentKey) implements Selection {}
    record Exact(SourceRef ref) implements Selection {}

    record Definition(SourceRef ref, String modelId,
            String instructions, ToolPolicy toolPolicy,
            List<SkillInput> skills, List<ExtensionUse> suites,
            List<BundleRef> bootstrapBundles) {}

    record ToolPolicy(String profile, String approvalMode) {}
}
```

`PreRegistered` is an MA application-selection variant carrying the complete existing `AgentDefinitionRequest`; it is not passed to a host Source. An absent `modelId` is supported and omits the native `model` field. Source preparation maps `modelId`, `instructions`, `toolPolicy` and inline Skills into native Definition fields. A null `approvalMode` preserves the pre-registered omission semantics: native Definition preparation emits empty `permission_policy` and retains the ordinary default inheritance. It is distinct from an explicit `"default"` approval mode. Extension Skill and Suite choices are preserved as non-secret source/material references in metadata; this slice does not automatically import or apply them. Sealed Skill JSON uses explicit `inline`/`extension` type tags for durable receipt replay.

For a new `Current`, a single registered Definition provider may be selected implicitly; multiple providers require an explicit `Exact` ref. The host provider owns the exact `projectionDigest` input identity. MA separately computes the command digest and native Definition digest. There is no independent MCP source in this slice.

A settled operation replay uses its saved projection without re-evaluating current. A fresh operation re-authorizes its exact Source input. Existing Session creation still publishes instructions/static Skill refs for a particular admitted sessionId, not as unscoped global resources; that application operation is not included in preparation.

For concurrent calls sharing one `Current` operation key, the first durably saved `RESOLVED` projection fixes that operation's version; competing callers converge on it whether it is still `RESOLVED` or already `PREPARED`. Changing a publication requires a new operation key. `Exact` continues to reject different content under the same precise ref. Resuming `RESOLVED` rechecks the caller deadline, whereas an admitted `PREPARED` replay returns its saved receipt before another native or bundle preparation.

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

Every new preparation resolves the exact ref for source authorization. MA then looks up raw immutable bytes under `Key(tenantId, workspaceId, expectedDigest)` using archive `stat`; only a missing artifact streams from the signed URI. This does not bypass revocation: a refused Source resolution still fails. A cache hit consumes no download body or URI expiry, so an expired original URL does not invalidate the saved artifact.

The supplied `expectedDigest` is mandatory for bootstrap preparation, and a supplied `expectedLength` is checked against actual bytes. MA persists the original verified archive, not an unsigned URL or an inspected/recompiled business configuration. `stat` is a narrowly added metadata/read operation on `ExtensionArchiveStorage`; existing `putIfAbsent/open` behavior remains unchanged. Custom storage providers implement it only when serving this input path.

Receipt preparation finishes with immutable Definition and raw material references. Bootstrap storage does not register an Extension catalog row and does not create a settings revision. Runtime delivery/application must stream from this native archive and remains a separate operation, not an assumed consequence of preparation.

### 3.3 Skill and suite

Re-use the existing `ManagedExtensionSource`:

- independent Skill → `kind="skill"`;
- suite or an asset-bearing Skill → `kind="extension"`;
- resolve returns an exact source reference and private locator, optionally with expectedDigest;
- open is a bounded stream only for a necessary new immutable package.

`settingsRevision` is a separately saved/applied settings identity and never a by-product of ZIP compilation.

### 3.4 Independent MCP and credentials

The following remains a future protocol design; these MCP/credential interfaces are not implemented in the first Java slice.

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

    record Command(String tenantId, String actorId, String workspaceId,
            String executionScope, String operationKey,
            Selection selection, Instant deadline) {}

    record PrepareReceipt(OperationRef operation, AgentDefinition definition,
            List<PreparedBundle> bundles) {}
}
```

The host calls this MA-owned method. It is not a host SPI implementation.

`prepare` only prepares immutable Definition/material plans. Native Session creation, settings apply, Extension application and MCP application are separate MA operations, with independent operation keys, reads and actual applied receipts. A completed preparation does not substitute for any of these admission steps.

## 4. Persisted state versus diagnostics

### Existing records kept

| Record                                                      | What remains authoritative                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ma_agent_definition`                                       | Immutable native Definition content keyed by tenant/id/revision/digest, never a ZIP BLOB |
| `ma_session`, `ma_turn`, `ma_session_record`, `ma_resource` | Actual Session, Turn, journal and immutable content/ref evidence                         |
| `ma_runtime_binding`                                        | Runtime placement and drain/ownership facts                                              |
| `ma_extension_package` / archive storage                    | Existing compiled extension material and immutable payloads                              |
| `ma_extension_settings`                                     | Independently saved, encrypted settings revisions                                        |
| `ma_request_receipt`                                        | Admitted operation identity and replayable results for its own operation namespace       |

SPI-produced native Definition metadata records `sourceProjection`, non-secret extension Skill/Suite choices and bootstrap references. The `SOURCE_DEFINITION_PREPARATION` receipt stores the command digest, phase, effective input, native Definition ref and immutable bundle refs. The original `ma_extension_package` catalog remains independent; bootstrap archives are content-addressed bytes in the archive backend, not implicitly new catalog entries. No signed locator or private settings value is stored in these public representations.

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
    Host->>Prep: prepare(caller fields, Selection, operationKey, deadline)
    Prep->>Store: Require Workspace OPERATOR; find/admit the original operation receipt
    alt The same operation is settled
        Store-->>Prep: Original native Definition, bundle refs and receipt
        Note over Def,Bundle: No provider call and no latest lookup
        Prep-->>Host: PrepareReceipt(original)
    else Pending, or a saved RESOLVED stage to continue
        Prep->>Store: Admit PENDING before external Source I/O
        opt A projection still needs resolution
            Prep->>Def: resolve(MA-checked context, Current / Exact)
            Def-->>Prep: Exact SourceRef and effective Definition
            Prep->>Store: Save the exact input as RESOLVED
        end
        Prep->>Store: Create/reuse the deterministic native Definition and verify its pin
        opt The input names bootstrap bundles
            Prep->>Bundle: resolve(authorized Context, exact BundleRef)
            Bundle-->>Prep: Exact ref and private signed locator
            Prep->>Store: Look up the immutable archive by content digest
            opt The matching native artifact is missing
                Prep->>Bundle: Bounded HTTPS streaming
                Bundle-->>Prep: Actual bytes and digest verified in private staging
                Prep->>Store: putIfAbsent(raw verified archive)
                Note over Store: No signed URL, Authorization or ZIP bytes in Definition JSON
            else A matching native archive already exists
                Note over Bundle,Store: Reuse saved bytes without download, even if the old URL expired
            end
        end
        Prep->>Store: Mark the Definition and bundle refs PREPARED on the original receipt
        Prep-->>Host: PrepareReceipt(native definition, immutable bundle refs)
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

For the implemented bootstrap download:

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

The first Java slice is implemented on `feature/managed-agent-definition-input-spi`: Q1 `97e4b6c2efc024e9eba26327352d87c2e5a7c4de`, Q2 `e07b74d2c5`, Q3 `d48bc5a036`. Initial source-reading baseline was `dev/managed-agent@e8c189fb90a204ab8762f8c8fc8e66d0f833271c`; these feature-branch commits are not a merged baseline or released artifact.

Implemented behavior received in this slice:

- The embedding application selects `PRE_REGISTERED` or `SPI` through deployment configuration. Its trusted Java caller supplies the caller fields; MA checks Workspace OPERATOR access and derives receipt scope before a host Source resolves input. No public preparation HTTP route is added.
- Precise input is transformed into a deterministic native Definition with revision/digest read-back. Source references, effective input and material refs are replayable through `SOURCE_DEFINITION_PREPARATION` in the existing receipt table, with no preparation/material table added.
- Bootstrap preparation authorizes the exact ref, checks the native archive by content digest, downloads only a missing artifact using bounded HTTPS staging, and saves the validated raw bytes. A settled replay reads saved references without another Source call, while a fresh operation does not bypass source authorization.
- Existing pre-registered API/update/get flows, their random IDs and existing stored-definition Session admission remain available. New SPI preparation does not silently rewrite those data models.

Verification actually performed:

- Q1: 14 focused tests plus Checkstyle.
- Q2: 32 focused tests, plus one real MySQL 8.4 case that coordinates two concurrent Java service calls into the same native identity and receipt.
- Q3: 76 focused tests, one real MySQL preparation case, and a later 28-test authorization/download/replay selection; overlaps are not counted as unique coverage.
- Q4 adds 20 focused checks, including ten real-HTTPS bootstrap cases for reuse, revoked source authorization, digest/length/content failures, timeout, expiry, redirects and coordinated concurrent missing downloads. A further 19 checks include the same bootstrap suite and nine embedded-Spring tests proving `ManagedAgentDefinitionPreparation` can be created without a host Source provider. An embedding-only string-to-Duration conversion issue was fixed using Boot 3.5.16's `DurationStyle`. Checkstyle passes on these code paths.

Review follow-up on `feature/managed-agent-definition-input-spi-clean`: duplicate and blank allowed-host entries are normalized; model-less definitions, settled replay after a resolve race, first-persisted `Current` projection convergence, resumed deadline checks, body-read timeout classification and deadline-worker shutdown are covered. The follow-up's 27 focused tests and Checkstyle passed. A real MySQL case for the `Current` race was added, but its selected run did not complete locally and is not claimed as passing.

This does not implement host-product adapters, independent MCP/credential refresh, automatic import/apply of Extension Skill/Suite refs, or Runtime activation of bootstrap artifacts. No actual Node/Worker apply, real OSS account or production host binding was exercised, and the pre-registered Admission regression is not claimed as an SPI Node execution E2E. Full unit/H2, SpotBugs and hosted/OS-process profiles belong to CI before broader acceptance. Custom storage backends supporting bootstrap lookup must provide `stat` when this path is used. Existing Source reuse/import and Session apply APIs retain their own operations and receipts; this slice does not create a second Session/Turn state machine.
