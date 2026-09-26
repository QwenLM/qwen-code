# Managed Workspace Binding Contract (W0a)

[English](2026-09-25-managed-workspace-binding-contract.md) | [简体中文](2026-09-25-managed-workspace-binding-contract.zh-CN.md)

Status: implemented as a standalone package. Since W0c-1 the worker uses its TypeScript twin through the `managed-context/1` envelope ([Managed Context Worker](2026-09-26-managed-context-worker.md)); the Broker does not use it yet. Updated: 2026-09-26. This is the first W0 slice of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). [This reply](https://github.com/QwenLM/qwen-code/issues/12380#issuecomment-5825755703) to [the W0a questions](https://github.com/QwenLM/qwen-code/issues/12380#issuecomment-5819009126) settled the placement and the timing of the boot envelope. Below, "the reference contract" is the proposal's [Workspace and Session cwd design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-context.en.md) together with the [`WorkspaceRelativePath` schema](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-public-api.openapi.yaml#L1453) of its public OpenAPI, and "the reference schema" is its [Workspace DDL](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-schema.mysql.sql), all at the commit that #12380 links.

## Problem

A hosted Managed Session must run its tools in a Workspace that an administrator registered and that the actor is allowed to use. Tools start from a relative directory chosen when the Session is created. That choice must survive retries, restarts and changes to the tenant default. Java admission, the Runtime Broker and the Runtime worker must also agree on it byte for byte.

Today no layer defines the choice. The Broker receives whatever `RuntimeScope` its caller resolves. Nothing validates a relative directory, checks the actor's access, applies a tenant default, or produces an identity that the worker can verify. If each layer later validates on its own terms, two failures become possible. A path that one layer normalizes and another rejects can put tools in the wrong directory. A default that is re-resolved on retry can move a Session to another Workspace.

## Current state

The facts below are from `main` at `73aa65a4b4`.

- **Broker scope.** `RuntimeScope` carries `tenantId`, `workspaceId`, `workspaceGeneration` (a string), `canonicalCwd`, `capabilityDigest` and `isolationClass`. `HarnessSessionResolver` resolves one scope per Harness Session, and the Broker does not authenticate these values. `LocalProcessRuntimeProvisioner` copies `workspaceId`, `workspaceGeneration` and the canonical cwd into the worker's boot document.
- **Worker contract.** The boot document is closed-key `version: 1`. The v2 attestation request repeats the tenant and Workspace fields: `workspaceId` is opaque, `workspaceGeneration` is a non-empty string (numbers are rejected), and `workspaceCwd` is only checked for being non-empty.
- **Daemon registry.** The daemon's TypeScript `WorkspaceRegistry` routes local multi-workspace traffic. Its `workspaceId` is the first 16 hex characters of SHA-256 over the canonical cwd, and its generation is an in-memory counter. It has five states and no tenant. It is not the hosted Registry, and W0a does not change it.
- **Session records.** The managed session records from #12302 live in TypeScript core. They key a Session by `{tenantId, workspaceId, sessionId}` and carry no cwd or binding fields.
- **Missing pieces.** Upstream has no Java control plane, no `managed_agent_session` table and no Managed Agent public OpenAPI. Nothing defines a Workspace selection, a relative cwd, a context revision or a ContextBinding.
- **Digests.** Java and TypeScript share no digest canonicalization. The Broker's JDBC repositories already derive keys as SHA-256 over length-prefixed UTF-8 fields (`JdbcRepositorySupport.digest`). TypeScript core session records use a private canonical-JSON encoder; the exported `managedSessionEventsDigest` covers only the ordered event identities.

## Goals

- One lexical rule for the relative working directory (`cwdRelative`), based on the `WorkspaceRelativePath` rule of the reference contract. Language-neutral fixtures pin it, so Java and TypeScript reject and normalize the same inputs.
- A Workspace Registry record and a read contract, backed first by deployment configuration.
- Actor-scoped access with three levels. It drives list visibility, the `canCreateSession` hint and creation admission.
- A pure resolver that turns an actor and an optional selection into either a resolved Workspace or exactly one typed error. It covers the tenant default for an omitted selection.
- A `ContextBinding` value whose `contextDigest` Java and TypeScript compute identically, pinned by shared fixtures.
- A normalized form of the caller's selection, including an omission marker, that W0b can fold into its request digest.

## Non-goals

- Persisting Session bindings, creation receipts or operations. That is W0b.
- Resolving storage to a mount; wiring the Broker, Harness or worker; opening an activation gate. That is W0c.
- The versioned boot envelope `managed-context/1` and any attestation version bump. See [Boot envelope](#boot-envelope).
- Public or BFF DTOs, routes and cursors, which belong to Stage D and W0d, and capability advertisement: `workspace_context` stays false until every W0 slice has passed, which W0e decides.
- Agent, Bundle and configuration compatibility checks at admission. That is W0b.
- Filesystem checks: existence, realpath, symlinks and mount identity. Those belong to the Runtime in W0c.
- JDBC tables for the Registry. The configuration-backed Registry needs none, and the Runtime Broker schema stays unchanged.
- Changes to the daemon `WorkspaceRegistry` or to daemon routes.

## Placement

The code is the package `com.alibaba.qwen.code.runtimebroker.managedworkspace` inside the existing `packages/sdk-java/runtime-broker` module, as #12380 decided. A separate Maven module was set aside: it would have needed its own pom, CI lane and workflow-guard tests before any Registry logic was reviewable. A package keeps the change to the domain code and lets W0c wire the binding through `HarnessSessionResolver` in the same module. If the Registry later needs its own schema lifecycle, or a consumer that must not pull in the Broker, it can move to a module of its own then.

The package stays framework-neutral: it uses only the JDK and no other Broker class, no Spring, no CLI internals and no scheduler, and nothing falls back to in-memory state behind a failing durable source. The shared fixtures and the TypeScript twin of the rule and the digest live under `packages/cli/src/serve`, next to the existing Runtime contracts.

## Vocabulary

Several words below already have other meanings in this repository.

| Term                 | Meaning here                                                                                                                                         | Not to be confused with                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Workspace ID         | Opaque and assigned by an administrator. It matches `[A-Za-z0-9._:-]{1,128}`, is unique within a tenant and is compared byte for byte.               | The daemon's path-hash `workspaceId`.                                                                |
| workspace generation | The Registry's replacement counter: a positive 64-bit integer that only grows for a Workspace ID. On the wire and in digests it is a decimal string. | A Runtime binding generation, the daemon's `generationId`, or the `workspace_generation` capability. |
| storage ID           | The logical identity of the Workspace's durable files.                                                                                               | A mount path.                                                                                        |
| ContextBinding       | The Session's committed Workspace context.                                                                                                           | A Runtime binding, which places a Runtime.                                                           |
| contextRevision      | The version of the Session's context. It is 1 at creation, and W2 raises it.                                                                         | The workspace generation, a configuration revision, or an activation epoch.                          |

## Workspace Registry

### Record

A Registry record has these fields. The record is immutable.

| Field                 | Rule                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `tenantId`            | `[A-Za-z0-9._:-]{1,128}`                                         |
| `workspaceId`         | `[A-Za-z0-9._:-]{1,128}`                                         |
| `workspaceGeneration` | An integer from 1 to 2^63−1                                      |
| `storageId`           | 1 to 256 printable ASCII characters (0x21 to 0x7E)               |
| `displayName`         | 1 to 512 code points, well-formed Unicode, no control characters |
| `state`               | `active`, `draining` or `removed`                                |
| `policyRef`           | 1 to 512 printable ASCII characters                              |
| `configRef`           | 1 to 512 printable ASCII characters                              |

The identifier pattern is the tenant pattern of the Java SDK's `ManagedSessionStoreConnection`, applied here to Workspace IDs as well. It is also a subset of the stable-ID rule for the TypeScript managed session key, so a hosted Workspace ID is valid in both places. ASCII identifiers also mean no Unicode normalization is ever needed before a digest.

### States

| State      | Listed | Selectable for a new Session | Can be the default |
| ---------- | ------ | ---------------------------- | ------------------ |
| `active`   | yes    | yes                          | yes                |
| `draining` | yes    | no (`workspace_unavailable`) | no                 |
| `removed`  | yes    | no (`workspace_unavailable`) | no                 |

Existing Sessions keep their binding in every state. What a draining or removed Workspace means for them belongs to W0e and W1.

### Configuration source

The read interface offers three operations:

- Find one record by tenant and Workspace ID.
- Page through a tenant's records in byte order of the Workspace ID, which matches the `ascii_bin` collation of the reference schema. A page shorter than the limit means that no records follow, and every implementation accepts limits from 1 to 1000.
- Return the tenant's configured default Workspace ID.

The first implementation is an immutable snapshot built from deployment configuration. Construction rejects the snapshot when:

- A `(tenantId, workspaceId)` pair appears twice.
- A tenant default names a Workspace that is not in that tenant.
- Any field breaks its rule.

There is no public registration API, and no Workspace ID is derived from a path.

The embedding service applies a change by replacing the snapshot. A successor check rejects a replacement that would do any of the following:

- Drop a Workspace. A Workspace is retired by moving it to `removed`, so Sessions pinned to it can still be explained later.
- Lower a Workspace's generation.
- Change its `storageId` without raising its generation.

A later JDBC Registry, backed by the reference `managed_agent_workspace` table, can implement the same interface. It must compare tenant IDs exactly, as this package does: the reference schema leaves `tenant_id` in the base table's collation, which may ignore case.

## Actor access

The embedding service authenticates the actor and passes in a tenant ID and an actor ID. W0a never reads either from a request body. The actor ID follows the `displayName` rule rather than the identifier rule, so an e-mail address works. A policy returns one of three access levels for an actor and a record:

- `NONE`
- `READ`
- `CREATE`, which implies `READ`

Lookups are always scoped to the actor's tenant. A Workspace in another tenant cannot be told apart from a missing one, whatever the policy says. The policy is evaluated on every call and is never baked into a page or a result. W0a ships one explicit-grant policy for tests and single-tenant deployments; there is no allow-all default.

Listing returns the records the actor can read, each with `canCreateSession`. That field is a permission hint only; the state is reported separately and the caller combines the two. Records come in Workspace ID order, with `hasMore` and a `defaultWorkspace`. The default is computed independently of the page and is present only when the tenant default exists, is `active`, and the actor has `CREATE`. Paging is by the last Workspace ID seen. The catalog reads the Registry in batches of 1000 whatever the page size, and a batch shorter than 1000 ends the scan. To keep `hasMore` exact, it scans past a full page until it finds one more readable record or reaches that end. A listing therefore makes at most one Registry page read for every full 1000 records it scans, plus one, however few of them the actor can read; looking up the default adds one or two more calls. Opaque cursors bound to tenant, actor and query belong to the API layer.

## Working-directory rule

`cwdRelative` is a string. The API layer turns an omitted field into `.` and rejects `null`. Every violation below is `invalid_cwd`.

1. The value must be well-formed Unicode, with no unpaired surrogate.
2. Its length must be 1 to 1024 code points, the way JSON Schema counts. The empty string is invalid; it is not `.`.
3. It must contain no control character: Unicode category Cc, which covers C0 (including NUL), DEL and C1. The reference contract names only NUL; see [Open questions](#open-questions).
4. It must contain no backslash.
5. It must not start with `/`.
6. Its normal form, described below, must not start with a drive prefix: an ASCII letter followed by `:`. Checking the normal form also rejects spellings such as `./C:x`.
7. After splitting on `/`, no segment may be exactly `..`.

Normalization then drops empty segments (from repeated or trailing `/`) and `.` segments, and joins the rest with `/`. If nothing is left, the result is `.`. Nothing else changes: spaces, case and non-ASCII characters are kept, there is no Unicode normalization, and nothing is percent-decoded. ContextBinding carries the normalized value, and W0b digests it.

| Input                | Result         |
| -------------------- | -------------- |
| `.` or `./` or `./.` | `.`            |
| `services//api/`     | `services/api` |
| `./services/./api`   | `services/api` |
| `a/ b /c`            | `a/ b /c`      |
| empty string         | `invalid_cwd`  |
| `..` or `a/../b`     | `invalid_cwd`  |
| `/srv/a`             | `invalid_cwd`  |
| `C:x` or `./C:x`     | `invalid_cwd`  |
| `a\b`                | `invalid_cwd`  |

The rule is lexical only. It does not model Windows name aliasing such as trailing dots or 8.3 names. Before any tool runs, the Runtime must still verify existence, realpath containment, symlinks and mount identity, and it rechecks them at tool boundaries (W0c). The working directory is where tools start; it is not a security boundary.

## Selection resolution

A selection is either omitted, or explicit with a Workspace ID and a `cwdRelative` (`.` when the caller left it out). The API layer rejects `null` and `{}` before resolution.

Resolution runs these checks in order and stops at the first failure. The Java API runs step 1 when the explicit selection is built, so an invalid directory fails before any lookup.

| Step                                        | Explicit selection                                           | Omitted selection                                 |
| ------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| 1. Normalize `cwdRelative`                  | `invalid_cwd`                                                | — (always `.`)                                    |
| 2. Choose the target                        | its Workspace ID                                             | the tenant default; if none, `workspace_required` |
| 3. Look up the target in the actor's tenant | missing: `workspace_not_found`                               | missing: `workspace_required`                     |
| 4. Check access                             | `NONE`: `workspace_not_found`; `READ`: `workspace_forbidden` | not `CREATE`: `workspace_required`                |
| 5. Check the state                          | not `active`: `workspace_unavailable`                        | not `active`: `workspace_required`                |

On success the result carries:

- the tenant ID, Workspace ID, workspace generation and storage ID;
- the record's `configRef` and `policyRef`;
- the normalized `cwdRelative`;
- whether the tenant default was used.

The syntax check comes first because it needs no lookup and reveals nothing. An omitted selection never yields 404, 403 or 409: an unusable default counts as no default. An explicit selection never falls back to the default.

The resolver is stateless. W0b calls it only on first admission and persists the result atomically with the creation receipt. A retry must find the original receipt first and must not call the resolver again, because a changed default would otherwise rebind the retry. For the request digest, the selection exposes a fixed omission marker, or the Workspace ID with the normalized `cwdRelative`. W0b folds these into its digest with the encoding described below.

## ContextBinding and digest

A ContextBinding has seven required fields, checked with the same rules as the Registry record:

- `tenantId`: `[A-Za-z0-9._:-]{1,128}`
- `workspaceId`: `[A-Za-z0-9._:-]{1,128}`
- `workspaceGeneration`: from 1 to 2^63−1
- `storageId`: 1 to 256 printable ASCII characters
- `cwdRelative`: already in normal form
- `contextConfigRef`: 1 to 512 printable ASCII characters
- `contextRevision`: from 1 to 2^63−1

`contextConfigRef` names the frozen configuration descriptor that W0b records at admission from the Registry's `configRef` and `policyRef`. W0a checks only its format and otherwise treats it as opaque. Nothing supplies `contextDigest`; it is always derived. A decoder that reads the two integers from text must accept only the ASCII form `[1-9][0-9]*` with a value of at most 2^63−1, as the TypeScript implementation does. `Long.parseLong` alone is not enough: it also accepts a sign, leading zeros and non-ASCII digits.

`contextDigest` is `sha256:` followed by the lowercase hex SHA-256 of a byte sequence. The sequence concatenates the items below in order. Each item is a 4-byte big-endian length followed by that many UTF-8 bytes.

1. the domain tag `qwen-managed-context-binding-v1`
2. `tenantId`
3. `workspaceId`
4. `workspaceGeneration`, as a decimal string with no sign and no leading zeros
5. `storageId`
6. `cwdRelative`
7. `contextConfigRef`
8. `contextRevision`, as a decimal string with no sign and no leading zeros

Reasons for this encoding:

- Length prefixes keep field boundaries unambiguous for any Unicode directory name.
- There is no JSON escaping or number formatting for fastjson2 and `JSON.stringify` to disagree on.
- The Broker's repository-key digests already prefix each UTF-8 item with a 4-byte big-endian length, though without a domain tag or the `sha256:` prefix. The encoding takes a few lines in TypeScript.
- Generations and revisions are decimal strings, so a JavaScript consumer never routes a 64-bit value through `Number`.
- The `sha256:` prefix matches `capabilityDigest` in the private Runtime protocol. Session-record `DurableRef` digests are bare hex; a later journal reference must convert explicitly.

The digest covers the Session's context only. The Runtime binding ID and generation, and the Harness owner generation, are bound at execution by the invocation wrapper in W0c. `displayName` does not affect execution. `policyRef` reaches execution through `contextConfigRef`.

Both languages consume shared fixtures in `packages/cli/src/serve/contracts/managed-workspace-binding-v1.fixtures.json`, validated against a schema file next to them. The file has three case lists:

- **Paths:** an input, and either the normalized result or `invalid_cwd`.
- **Bindings:** the fields, and either the hex of the encoded bytes with `contextDigest`, or a rejection.
- **Character probes:** a directory or binding-field template with one `{c}` slot, and the exact ranges of code points the rule accepts in that slot. Each probe is run with every code point of the Basic Multilingual Plane (U+0000 to U+FFFF), which holds every control character, space separator and surrogate, and with the astral blocks that mimic ASCII: the mathematical alphanumeric symbols, the enclosed alphanumeric supplement and the tag characters, plus U+10000, U+1D11E, U+1F600, U+F0000 and U+10FFFF. A class that gains or loses any of these code points fails a probe; other astral code points are not probed.

The cases cover both sides of each rule's boundaries, including non-ASCII names, a segment of spaces only, a generation above 2^53 and a generation of 2^63−1. The expected values were computed by an implementation independent of both languages.

## Boot envelope

The boot envelope is its own slice, W0a-2, and the [managed context envelope](2026-09-25-managed-context-envelope.md) now defines it: the negotiation of `managed-context/1`, boot v2 and ready v2, attestation v3, and the context installation request with its receipt. It differs from the plan first written here in three ways:

- Boot v2 carries the Workspace binding and the mount root but no Session context, because a Workspace-isolated Runtime is shared by Sessions whose `cwdRelative` differ. Each Session installs its `ContextBinding` through the installation request instead, so `cwdRelative` and `contextRevision` stay out of `RuntimeScope`.
- The daemon-style path hash is not carried at all. A worker that needs one derives it from the verified mount root.
- W0a-2 defines the contract only. The worker, the provisioner and the fake worker `fake-attestation-worker.mjs` change in W0c, which wires the protocol.

## Errors

| Code                    | HTTP | When                                                                                           |
| ----------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| `workspace_required`    | 400  | The selection is omitted and there is no usable tenant default.                                |
| `invalid_cwd`           | 400  | `cwdRelative` breaks the working-directory rule.                                               |
| `workspace_not_found`   | 404  | The explicit Workspace is missing, belongs to another tenant, or is not readable by the actor. |
| `workspace_forbidden`   | 403  | The actor can read the explicit Workspace but lacks `CREATE`.                                  |
| `workspace_unavailable` | 409  | The explicit Workspace is `draining` or `removed`.                                             |

None of these succeeds on an unchanged retry. W0a raises them as one exception type that carries the code and the HTTP status, like `RuntimeBrokerException`. The API layer maps them to its error envelope. `unsupported_feature`, `workspace_generation_conflict` and `context_revision_conflict` belong to later slices.

## Security and tenancy

- The tenant and actor come only from the embedding service's authentication.
- Errors do not distinguish another tenant's Workspace, an unreadable Workspace and a missing one: all three fail with the same code, message and throw site. The API layer must return only the status, code and message of a `WorkspaceException`, never its stack trace. Timing is not made uniform: an unreadable Workspace consults the access policy, and a missing one does not.
- Workspace generations, storage IDs and configuration references come only from the Registry. A caller supplies at most a Workspace ID and a relative directory. No absolute path, mount, storage ID or generation is accepted from a caller, and none appears in an error or a list entry. W0b must build each ContextBinding from a resolved Workspace or from its own persisted binding, never from request fields. W0a does not enforce this: ContextBinding keeps a public constructor because the restore path needs one.
- Resolution never falls back. An explicit selection gets no default, and an omitted selection never gets a launch cwd or the daemon's primary Workspace.
- Access is evaluated on every call. No result carries authorization that outlives the call.
- The working-directory rule is lexical. The Runtime still enforces containment, realpath and symlink safety at installation and at tool boundaries.

## Files affected

- The package `com.alibaba.qwen.code.runtimebroker.managedworkspace` in `packages/sdk-java/runtime-broker` (new):
  - The Registry record and state, the Registry interface and the configuration snapshot with its successor check.
  - The actor, the access levels and policy, and the explicit-grant policy.
  - The catalog that lists and resolves.
  - The selection and resolved Workspace, the working-directory rule, `ContextBinding` and the exception type.
  - Tests in the matching test package, including the fixture consumer.
- `packages/sdk-java/runtime-broker/README.md` and `QWEN.md`: a section on the package.
- `packages/cli/src/serve/contracts/managed-workspace-binding-v1.fixtures.json` and `.schema.json` (new).
- `packages/cli/src/serve/managed-workspace-binding.ts` and its test (new). This is the TypeScript twin of the working-directory rule and the digest. The worker uses it since W0c-1.
- This design document, in both languages.

No existing Broker class, the Broker schema, the daemon `WorkspaceRegistry`, the worker boot document, the attestation contract or any CI workflow changes. The SDK Java workflow already runs the `runtime-broker` tests and Checkstyle, and its path filters cover both `packages/sdk-java/**` and `packages/cli/src/serve/**`.

## Validation plan

- **Java unit tests:**
  - Record and snapshot validation, and the successor check.
  - The explicit-grant policy.
  - Listing: filtering, order, paging, and a default outside the current page.
  - Every resolution row, for both explicit and omitted selections.
  - The working-directory rule, and ContextBinding validation and digest.
- **Fixture consumers:** Java and TypeScript both run every path, binding and character-probe case. TypeScript validates the fixture file against its schema with strict Ajv.
- **Mutation check:** revert or weaken each guard. This includes widening or narrowing each character class by any probed code point; exempting one control character; adding regular-expression flags; comparing case-insensitively; dropping the type check from `equals`; and making a constructor public. A mutant that changes behavior must fail a test, and a surviving mutant must be shown to be equivalent.
- **Commands:** `mvn test` and `mvn checkstyle:check` in `packages/sdk-java/runtime-broker` on JDK 21; `npm run build && npm run typecheck`; focused Vitest runs.
- **CI:** the existing `runtime-broker` steps run the package's tests in the Java 21 jobs on Linux, macOS and Windows, and Checkstyle on Linux. The module's Checkstyle configuration checks the main sources only, not the tests.

## Acceptance criteria

- Java and TypeScript produce identical normalized paths and `contextDigest` values for every fixture. This includes non-ASCII names, a segment of spaces only and a generation above 2^53. TypeScript accepts exactly the listed code points in every character probe, and so does Java; Java carries generations and revisions as `long`, so its decimal probes check the rule its wire decoders must follow.
- An omitted selection resolves only to an active tenant default in which the actor can create Sessions. Every other omitted case is `workspace_required`.
- An explicit selection never falls back to the default.
- Another tenant's Workspace and an unreadable Workspace produce the same `workspace_not_found`.
- No caller-supplied absolute path, storage ID or generation can reach a resolved Workspace.
- A replacement snapshot cannot drop a Workspace, lower its generation, or change its storage ID without a new generation.
- The Java package uses only the JDK: no other Broker class, Spring, CLI internals or scheduler.
- The documentation does not claim persistence, wiring or capability advertisement.

## Open questions

1. Should `cwdRelative` reject every control character (C0, DEL and C1), as implemented, or only NUL, as the reference contract says? A newline or an escape sequence in a directory name reaches logs, UI and shell prompts. The same concern applies to characters that are accepted today but are invisible or break lines: format characters (category Cf) such as bidirectional controls (U+202E, U+2066) and zero-width characters (U+200B, U+FEFF), and the line and paragraph separators U+2028 and U+2029 (categories Zl and Zp). Rejecting every format character would also reject legitimate joiners such as U+200D in emoji names.
2. Should `removed` Workspaces appear in listings at all, or only in Session views?

## Follow-up work

| Slice | Scope                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0a-2 | The versioned boot envelope, attestation v3 and context installation, defined in the [managed context envelope](2026-09-25-managed-context-envelope.md).            |
| W0b   | Atomic Session binding with the creation receipt, original-key recovery, and explicitly unbound old Sessions.                                                       |
| W0c   | Session-based Broker resolution through `HarnessSessionResolver`, the storage-to-mount resolver, worker installation and attestation, and the Workspace turn lease. |
| W0d   | WebShell selection, the relative-directory field, and the default and empty states.                                                                                 |
| W0e   | Recovery and rollout.                                                                                                                                               |

Stage D generates the public and BFF DTOs from the reviewed OpenAPI. A JDBC Registry follows when a control plane persists Workspaces.
