# Managed Context Envelope (W0a-2)

[English](2026-09-25-managed-context-envelope.md) | [简体中文](2026-09-25-managed-context-envelope.zh-CN.md)

Status: contract defined. The worker serves it since W0c-1 ([Managed Context Worker](2026-09-26-managed-context-worker.md)); no Broker writes boot v2 yet. Updated: 2026-09-26. This is the second W0 slice of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). It builds on the [Workspace binding contract](2026-09-25-managed-workspace-binding-contract.md) (W0a, #12681). [This reply](https://github.com/QwenLM/qwen-code/issues/12380#issuecomment-5825755703) asked for the envelope shape to be decided now, contract first: "envelope shape + shared schema/fixtures first, handlers after". Below, "the reference design" is the proposal's [Workspace and Session cwd design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-context.en.md), [contract closure](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-contract-closure.en.md) and [attestation design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-runtime-attestation.md), all at the commit that #12380 links.

## Problem

The Managed Runtime worker learns who it is from a boot document and proves it through attestation. Both describe the Runtime's Workspace by one directory, `workspaceCwd`, and treat `workspaceId` as an opaque label.

W0 replaces that directory with a Registry Workspace: a tenant, a Workspace ID, a generation and a storage ID, whose files the Broker mounts at a root. It also adds per-Session context: a relative directory, a configuration reference and a revision. W0a binds these seven values into a `ContextBinding` and its `contextDigest`.

The worker cannot receive either today. Adding fields to the boot document, attestation or Tool v2 in place would break their closed shapes, and an old worker handed a W0 Session could run tools in the wrong directory. W0 therefore needs a negotiated protocol, `managed-context/1`, with new strict versions, so that an old worker refuses a W0 Session before anything runs.

## Current state

The facts below are from `main` at `ab61e04161`.

- **Boot v1.** `LocalProcessRuntimeProvisioner` writes one JSON object to the worker's standard input and closes it. The object has 14 keys: the Runtime identity, `tenantId`, `workspaceId`, `workspaceGeneration`, `workspaceCwd`, `capabilityDigest`, `isolationClass`, `token`, `type: "boot"` and `version: 1`. The worker accepts exactly that key set within 32 KiB and 30 seconds, then checks the field types through the attestation identity. A boot it rejects makes it exit before the ready line, and Java reports a retryable `runtime_provision_failed`.
- **Ready v1.** The worker answers with one standard-output line: `type`, `version: 1`, `runtimeInstanceId`, `runtimeIncarnation`, `leaseId`, `epoch` and a loopback `url`. Java compares the echoed values but ignores extra keys.
- **Attestation v2.** `POST /internal/managed-runtime/v2/attest` takes a request closed to 8 keys and answers with 12. Every scope field, `workspaceCwd` included, is compared exactly with the boot document; a mismatch is 409 `managed_runtime_identity_conflict`.
- **Tool v2.** The execute, status and cancel routes are bound to the Runtime by the lease headers only. Each call's reference carries a `sessionId`, but no Workspace, directory or context field. Since #12671 the worker serves them through one tool executor rooted at the boot's `workspaceCwd`, and its raw route gate admits exactly the declared v2 routes. The executor does not confine tool paths or shell commands to that directory; the tool contract requires the Harness to decide the Workspace boundary when it admits a call, and that admission is still to be wired.
- **Placement.** The six `RuntimeScope` fields feed the Broker's request and scope keys. A Workspace-isolated Runtime is shared by every Session that resolves to the same scope.
- **Contracts.** Attestation v2 and Tool v2 have shared schemas and fixtures. The boot document and the ready record have none, and the fake worker that Java tests start, `fake-attestation-worker.mjs`, validates nothing.
- **W0a.** `ContextBinding` has seven fields: `tenantId`, `workspaceId`, `workspaceGeneration`, `storageId`, `cwdRelative`, `contextConfigRef` and `contextRevision`. Java and TypeScript compute the same `contextDigest`, pinned by shared fixtures.

## Goals

- Define how a Broker and a worker agree on `managed-context/1`, and how either side refuses it.
- Define boot v2, a closed shape that carries the Workspace binding and the mount root, and ready v2, the closed record that accepts it.
- Define attestation v3, so that W0c reuses the existing gate instead of inventing a separate Workspace attestation.
- Define the context installation request and its receipt, which bind one Session's `ContextBinding` to a Runtime.
- Pin all of it with one shared schema and fixture file that both languages run.
- Leave boot v1, ready v1, attestation v2 and Tool v2 unchanged.

## Non-goals

- **Wiring.** In this slice no worker accepts boot v2 or mounts a v3 route, and no Broker writes boot v2. W0c does that on top of the worker that #12671 completed.
- **Mounting and filesystem checks.** Resolving storage to a mount root, and verifying existence, realpath, symlinks and mount identity, belong to the storage resolver and the installation handler in W0c.
- **Later bindings.** Configuration installation from `contextConfigRef`, activation gates, the per-invocation binding around Tool v2 calls, and receipts in journals and checkpoints belong to W0c and later slices.
- **Placement.** `RuntimeScope`, the Broker's request and scope keys, and its schema do not change.

## Negotiation

`managed-context/1` is a capability token, named in the style of `qwen-hosted-harness/1`; below it is called the protocol token, to keep it apart from the bearer `token`. A later incompatible change takes a new protocol token.

- **Offer.** The Broker offers the protocol by writing boot v2, which carries the protocol token. It writes boot v2 only for a Runtime binding whose Sessions have a Workspace context; every other binding keeps boot v1.
- **Acceptance.** A worker that implements the protocol answers with ready v2, which repeats the protocol token. It then serves attestation v3 and the installation route, and answers 404 to attestation v2, so one Runtime never presents two identities. The Tool v2 routes keep their shapes, but under boot v2 a tool call runs only for a Session with an installed context, in that context's effective directory. W0c implements this with the per-invocation binding.
- **Refusal before any side effect.**
  - A worker that implements only boot v1 rejects boot v2 through its closed key set and exits before the ready line.
  - A ready v1 record, a ready record without the protocol token, or a 404 from a v3 route means the peer is incompatible.
- **No downgrade.** The Broker never provisions a W0 Session with boot v1, and never retries a refused boot v2 as boot v1. A binding without W0 context never receives boot v2.

## Boot document v2

The transport is unchanged: one UTF-8 JSON object on standard input, at most 32 KiB, closed within 30 seconds. The object has exactly these keys.

| Key                                                                        | Rule                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `type`                                                                     | `"boot"`                                                                                 |
| `version`                                                                  | `2`                                                                                      |
| `managedContext`                                                           | `"managed-context/1"`                                                                    |
| `runtimeInstanceId`, `runtimeIncarnation`, `leaseId`, `provisionRequestId` | the W0a identifier rule, `[A-Za-z0-9._:-]{1,128}`                                        |
| `token`                                                                    | a bearer credential of 1 to 512 characters in the token68 syntax, `[A-Za-z0-9._~+/-]+=*` |
| `epoch`                                                                    | an integer from 1 to 2^53−1                                                              |
| `capabilityDigest`                                                         | a string matching `sha256:[0-9a-f]{64}`                                                  |
| `isolationClass`                                                           | `"session"` or `"workspace"`                                                             |
| `tenantId`, `workspaceId`                                                  | the W0a identifier rule, `[A-Za-z0-9._:-]{1,128}`                                        |
| `workspaceGeneration`                                                      | the W0a decimal rule: canonical decimal text from 1 to 2^63−1                            |
| `storageId`                                                                | the W0a storage rule: 1 to 256 printable ASCII characters                                |
| `mountRoot`                                                                | an absolute path of 1 to 4096 UTF-8 bytes, well-formed, with no control character        |

- **Mount root.** `mountRoot` replaces v1's `workspaceCwd`. It is the root at which the Broker's storage resolver mounted this Workspace. An absolute path starts with `/`, with a drive letter and a separator (`C:\` or `C:/`), or with two backslashes (`\\`, a UNC path). The limit counts UTF-8 bytes and bounds the value on the wire; whether the path exists is for the installation handler to verify. The worker treats it as data until the installation handler verifies it.
- **No path hash.** The daemon's path hash, the first 16 hexadecimal characters of SHA-256 over a path, is not carried. Where the worker needs a daemon-compatible local ID, it derives the hash from the verified mount root, so the public `workspaceId` is never a path hash.
- **No Session context.** A Workspace-isolated Runtime serves many Sessions, and `cwdRelative`, `contextConfigRef` and `contextRevision` must stay out of the placement identity. Each Session installs its context separately, as described below, whatever the isolation class.
- **Bounded identifiers.** v1 accepts identifiers of any length and refuses, at startup, a boot whose attestation response would exceed 16 KiB. v2 bounds the four Runtime identifiers instead, because attestation responses and receipts repeat them; with every repeated field bounded, those records always fit their limits (see [Sizes](#sizes)). It also bounds the token to the syntax that an `Authorization` header carries, and to 512 characters, the Broker's own limit, well within the header size that the worker's HTTP server accepts.
- **The Broker's values.** The Broker's identifiers today are UUIDs, or a UUID binding ID followed by `:` and its generation, and its tokens are unpadded base64url; all of them satisfy these rules. `BrokerValues.requireId` itself allows up to 512 characters of any kind except NUL, so W0c keeps the values it writes into boot v2 within these rules.

## Ready record v2

The worker answers with one line on standard output. The line is a JSON object with exactly these keys: `type: "ready"`, `version: 2`, `managedContext: "managed-context/1"`, `runtimeInstanceId`, `runtimeIncarnation`, `leaseId`, `epoch` and `url`.

- The four identity values repeat the boot document.
- `url` is `http://127.0.0.1:<port>`, with a port from 1 to 65535 in canonical decimal (no leading zero) and no path, query, fragment or user information.
- Unlike v1, the Broker checks the exact key set.

## Attestation v3

Attestation v3 keeps the v2 gate and changes only the identity fields.

- **Route.** `POST /internal/managed-runtime/v3/attest`, with protocol version 3, the v2 size limits of 16 KiB for the request and the response, and `Cache-Control: no-store`. The new path makes a worker booted with v1 answer 404.
- **Headers.** As in v2: the bearer token, `Cache-Control: no-store`, a JSON content type, `X-Qwen-Managed-Lease-Id` and `X-Qwen-Managed-Lease-Epoch`.
- **Request.** Closed to `protocolVersion`, `managedContext`, `provisionRequestId`, `tenantId`, `workspaceId`, `workspaceGeneration`, `storageId`, `mountRoot`, `capabilityDigest` and `isolationClass`, with the boot v2 rules.
- **Response.** Closed to the request fields plus `runtimeInstanceId`, `runtimeIncarnation`, `leaseId` and `epoch`.
- **Checks.** The worker first checks the request against the rules above; a request that breaks one is 400 `managed_runtime_attestation_invalid`. It then compares the eight attested fields, every request field except `protocolVersion` and `managedContext`, with its boot document exactly, as strings, without normalizing paths. Any mismatch is 409 `managed_runtime_identity_conflict`. The attestation cases repeat every single-field boot case on an attested field, valid and invalid: an invalid value answers 400, and a valid value that differs from the boot document reaches the comparison and answers 409. The fixtures also repeat every malformed request object with each attested field it leaves valid changed to another valid value, so a worker that compares any field before checking the shape fails them.

## Context installation

One request installs one Session's context on a Runtime and returns a receipt. W0c implements the handler; this slice fixes the shapes and the order of the checks.

- **Route.** `POST /internal/managed-runtime/v3/context`, with protocol version 3, 16 KiB limits, `no-store` and the v2 headers.
- **Request.** Closed to these keys:

| Key               | Rule                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `protocolVersion` | `3`                                                                                                        |
| `managedContext`  | `"managed-context/1"`                                                                                      |
| `operationId`     | the W0a identifier rule; the Broker's idempotency key for this installation                                |
| `sessionId`       | the Runtime Session ID that Tool v2 references carry: 1 to 512 UTF-16 code units, well-formed, with no NUL |
| `binding`         | an object closed to the seven `ContextBinding` fields, each with its W0a rule, as W0a's wire strings       |
| `contextDigest`   | a string matching `sha256:[0-9a-f]{64}`                                                                    |

The worker checks the request in this order and stops at the first failure:

1. A request that breaks the shape is 400 `managed_runtime_attestation_invalid`.
2. A `contextDigest` that is not the W0a digest of `binding` is also 400 `managed_runtime_attestation_invalid`.
3. A `binding` whose `tenantId`, `workspaceId`, `workspaceGeneration` or `storageId` differs from the boot document is 409 `managed_runtime_identity_conflict`. A Runtime therefore never installs another Workspace's context.
4. An `operationId` already used with a different `sessionId` or `contextDigest` is 409 `managed_context_conflict`. Repeating an installation with the same three values returns the original receipt and changes nothing.
5. An installation for a Session that already has a different context is 409 `managed_context_conflict`.
6. In W0c, the handler resolves the effective directory by joining `mountRoot` and `cwdRelative`, and verifies it. If it cannot, it answers 409 `managed_context_unavailable` and installs nothing.
7. The worker records the installation and answers 200 with the receipt.

The fixtures pin this order:

- Every malformed request object is repeated after a successful installation, and again with each Workspace field of its binding that it leaves valid changed to another valid value.
- A binding that breaks a rule carries the digest of its raw fields, so only the rule refuses it.
- For each of the four Workspace fields, three sequences check that the Workspace part answers before the operation check, before the Session check, and before the check of an operation that another Session reuses.

A worker that checks the shape, the binding rules or the digest later, or the Workspace part after the operation or the Session, fails them.

- **Receipt.** Closed to `protocolVersion`, `managedContext`, `operationId`, `sessionId`, `runtimeInstanceId`, `runtimeIncarnation`, `epoch`, `contextDigest`, `contextRevision` and `workspaceGeneration`. The last three let the Broker check which context, revision and generation the Runtime installed.
- **Session IDs.** The Broker's own check for a Runtime Session ID allows unpaired surrogates, which its JSON encoder replaces with `?`; two different IDs would then reach the worker as one. The installation rule refuses an unpaired surrogate that arrives escaped, but it cannot see a collision that the encoder has already made. Only the Broker can prevent that, so W0c must tighten the Broker's check to this rule before it writes a Session ID into an installation request.
- **One context per Session.** A Session's installed context changes only through a later protocol for directory changes (W2); until then, step 5 refuses a different one. The same Session and context under a new `operationId` succeed with a new receipt.

## Sizes

Every field that a response repeats is bounded. So the attestation response and every receipt built from a valid boot document and a valid request fit within 16 KiB, and so do the largest valid attestation and installation requests. The TypeScript test builds the largest of each: about 9.9 KB for the attestation response and 9.4 KB for the installation request. These sizes count UTF-8 JSON that leaves non-ASCII characters unescaped, as `JSON.stringify` and the Broker's fastjson2 encoder write it. An encoder that escapes every non-ASCII character could push the largest installation request past its limit, so neither side may use one.

## Errors

| Status | Code                                    | Class        | When                                                                                                                    |
| ------ | --------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 401    | `managed_runtime_unauthorized`          | credentials  | missing or wrong bearer token                                                                                           |
| 400    | `managed_runtime_attestation_invalid`   | protocol     | a bad shape, header or protocol version, or a wrong `contextDigest`                                                     |
| 413    | `managed_runtime_attestation_too_large` | protocol     | a request body over its limit                                                                                           |
| 409    | `managed_runtime_identity_conflict`     | identity     | the lease headers, the attestation or the binding differ from the boot                                                  |
| 409    | `managed_context_conflict`              | identity     | an `operationId` or a Session reused with other values                                                                  |
| 409    | `managed_context_unavailable`           | recovery     | the effective directory cannot be verified, or, for `execute` under boot v2, the Session has no installed context (W0c) |
| 404    | none                                    | incompatible | a route that this worker's boot version does not serve                                                                  |

The first four are the codes that attestation v2 and Tool v2 already use. A Broker keeps its current classification for them. Unlike v2, a 409 here carries one of three codes, and today's transport classifies a refusal by its status alone. A v3 client therefore classifies a refusal by its status and code together, and treats a 409 with a code it does not know as an identity conflict. The shared fixtures carry this table. `managed_context_conflict` is not retryable. `managed_context_unavailable` keeps the Session's tool gate closed and marks its context `recovery_blocked`, as the reference design requires; it never falls back to another directory.

## Security

- The token stays on standard input and in the bearer header. It is never in arguments, the environment, a response or an error message.
- `mountRoot` and the effective directory stay inside the private protocol. They never appear in a public DTO, a public error or a log line that leaves the Broker.
- The worker never takes identity from a request. Attestation compares the request with the boot document, and installation compares the Workspace part of the binding with the boot document and recomputes the digest.
- Paths are compared exactly. Canonicalization and containment are the installation handler's job, not the comparison's.
- The effective directory is where a Session's tools start, not a sandbox. As the Tool v2 contract requires, the Harness decides the Workspace boundary when it admits a call.

## Shared schema and fixtures

`packages/cli/src/serve/contracts/managed-context-v1.schema.json` and `.fixtures.json` hold the whole contract:

- the protocol token, the boot and ready versions, and the two v3 routes;
- valid and invalid boot documents and ready records;
- attestation requests and installation requests, each with its expected status and code, replayed against one canonical boot document;
- installation sequences that exercise idempotency and conflicts;
- the expected attestation response and receipts;
- the error table with each code's classification.

The schema fixes each record's shape and the rules it can state readably. JSON Schema cannot state UTF-8 byte or UTF-16 unit limits, a digest over a binding, or a comparison with the boot document, and patterns could state the 2^63−1 bound and the segment rules of a directory's normal form only unreadably. The schema does state a directory's characters and that it starts neither with `/` nor with a drive letter. Fixture cases pin those rules, and the TypeScript test checks that the schema and the module disagree on no other case.

Some cases carry unpaired surrogates as `\uXXXX` escapes, because the rules refuse them. A consumer must read the file with a parser that keeps such escapes, as `JSON.parse`, Jackson and Python's `json` do. Rust's `serde_json` rejects the file by default. `jq` rejects an unpaired high surrogate and replaces an unpaired low one with U+FFFD, so it cannot read the file either, and Go's `encoding/json` silently replaces every unpaired surrogate with U+FFFD.

An implementation independent of both languages computed the expected values and every `contextDigest`, as for W0a.

- **TypeScript.** `packages/cli/src/serve/managed-context-envelope.ts` validates boot documents, ready records, attestation requests and installation requests, builds ready records, attestation responses and receipts, and keeps installations idempotent. The ready check is the reference for the Broker's check in W0c. It reuses W0a's validation and digest. The worker does not import it until W0c.
- **Java.** A conformance test in `runtime-broker` reads the schema and fixtures, pins every closed key set, route and constant, recomputes each installation digest with `ContextBinding`, and checks that the attestation response and each receipt repeat the boot document and the binding. The Java builders for boot v2 and the v3 client come with the wiring in W0c, where they have callers.
- **Fake worker.** It serves only v1 and is unchanged here. W0c extends it to v2 and makes it enforce the closed key sets of both versions.

## Files affected

- `packages/cli/src/serve/contracts/managed-context-v1.schema.json` and `.fixtures.json` (new).
- `packages/cli/src/serve/managed-context-envelope.ts` and its test (new).
- A conformance test in `packages/sdk-java/runtime-broker/src/test/java/com/alibaba/qwen/code/runtimebroker/managedworkspace/` (new).
- `packages/cli/src/serve/managed-workspace-binding.ts` exports three of its W0a checks for reuse; their behavior does not change.
- This design document in both languages (new), and the "Boot envelope" section and follow-up table of the W0a document, which now point here.
- The runtime-broker `README.md` and `QWEN.md`, whose maintenance rule for the digest now names these fixtures too.

The worker, the attestation contract, the provisioner, the transport, the fake worker and the CI workflows do not change.

## Validation plan

- **TypeScript:** strict Ajv validation of the fixtures against the schema; every case replayed through the module, including the installation sequences; the schema checked against every case; and the largest records measured against their limits.
- **Java:** the conformance test pins the closed key sets, routes, constants and error table, and recomputes every installation digest with `ContextBinding`.
- **Independence:** the expected values come from an implementation written from this document, not from either language.
- **Mutation check:** each check of the TypeScript module is mutated in turn and the suite rerun; the PR reports the results.

## Acceptance criteria

- TypeScript agrees with every fixture, and Java with every key set, route, constant, error and installation digest in them. The Java checks of boot documents, ready records and attestation responses come with W0c.
- Every record built from valid input fits within its request or response body limit.
- Boot v1, ready v1, attestation v2 and Tool v2 are unchanged, and no worker or Broker behavior changes.
- An installation whose Workspace part differs from the boot document is refused, and so is one whose digest does not match its binding.
- Repeating an installation is idempotent, and reusing its `operationId` or its Session with other values is refused.

## Open questions

1. Should a worker that refuses a boot document write a refusal line before it exits? That would let the Broker tell a refusal, which it must never retry, from a crash, which it may retry. A worker that implements only v1 cannot write one, so the Broker still needs a retry bound for boot v2. Today the Broker cannot tell the two apart: it discards the worker's standard error, and a v1 worker that refuses boot v2 and one that crashes both end as the same retryable `runtime_provision_failed`.
2. Should the installation request also carry the configuration installation for `contextConfigRef`, or should that take a later version of the route?
3. W0a's open question on control characters in `cwdRelative` (every Cc character or only NUL) still applies; the installation handler inherits the W0a rule.
4. How long does a Runtime keep its installations? The contract keeps every operation and every Session's context for the Runtime's lifetime, and installing the same context under a new `operationId` succeeds, so a long-lived Workspace-isolated Runtime accumulates entries. W0c must set a retention rule, for example releasing a Session's entries when the Session ends, without breaking the idempotent replay the Broker relies on.

W0c-1 answered questions 1, 3 and 4 for the worker: it writes no refusal line, applies the W0a rule for `cwdRelative` unchanged, and keeps installations for the Runtime's lifetime. See [Managed Context Worker](2026-09-26-managed-context-worker.md#open-questions-of-the-envelope). Question 2 stays open.

## Follow-up work

| Slice | Scope                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0c-1 | Done in [Managed Context Worker](2026-09-26-managed-context-worker.md): the worker accepts boot v2 and serves attestation v3 and installation; the fake worker for v2; the activation gate, which binds each Tool v2 call to its Session's installed context. |
| W0c-2 | The provisioner writes boot v2; the v3 transport client; the Broker's identifier and Session ID checks tightened to these rules before it writes them; a test that the Broker's JSON writer leaves non-ASCII characters unescaped.                            |
| W0c-3 | The storage resolver, and Session resolution in the control plane.                                                                                                                                                                                            |
| W0e   | Capability advertisement (`workspace_context`) after the whole W0 chain passes.                                                                                                                                                                               |
