# Managed Tool Result Contract (O1a)

[English](2026-09-26-managed-tool-result-contract.md) | [简体中文](2026-09-26-managed-tool-result-contract.zh-CN.md)

Status: contract defined; no worker, store or Broker uses it yet. Updated: 2026-09-26. This is slice O1a of [#12723](https://github.com/QwenLM/qwen-code/issues/12723), stage O1 of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). Below, "the reference design" is section 11 and the sections it builds on of the proposal's [tool results and durable artifacts design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-tool-result-artifacts.md), at the commit that #12723 pins.

## Problem

A Managed Runtime can be reclaimed and a Harness can be replaced. A tool's full output then survives, at best, in a Runtime-local file, and the Tool v2 result, capped at 1 MiB, cannot carry it. O1 makes the full output durable and addressable by reference, separately from the preview the UI shows and from the message the model consumes.

O1a fixes the shapes and rules before anything implements them, as the attestation, Tool v2 and `managed-context/1` contracts did. O1b implements stream publication and range reads on the local Session resource store, and O1c captures foreground Shell output on the worker.

## Current state

The facts below are from `main` at `16496a71ec`.

- **`ToolResult`.** `packages/core/src/tools/tools.ts` separates `llmContent`, `returnDisplay`, `persistedOutputFiles`, `resultFilePaths` and `artifacts`.
- **Truncation.** `persistAndTruncateToolResult` in `packages/core/src/tools/truncation.ts` offloads oversized text to a private local file. It stops persisting above 50 MiB per file or 500 MiB per Session, and a failed write leaves only the preview. A preview therefore does not prove that the full bytes survive.
- **Session resources.** `LocalManagedSessionResourceStore` in `packages/core/src/managed-runtime/managed-session-resources.ts` publishes a whole `Buffer` and reads a whole file, and checks length and SHA-256 on read. It has no stream publication and no range read. A resource is referenced by a `DurableRef`: `resourceId`, `kind`, `schemaVersion`, `byteLength` and a bare lowercase hexadecimal SHA-256 `digest`.
- **Session receipts.** The Managed Session event `tool.receipt` carries `executionCallId`, `toolOutcomeRef`, `resultRef`, `resources` and `historyRevision`.
- **Tool v2.** `managed-runtime-tool-v2.schema.json` closes a settled `result` to `executionStatus`, `responseParts` and an optional `error`, and caps each response at 1 MiB. The worker replaces a larger result with a small terminal error.
- **Route gate.** The worker serves every route through `ownedManagedRuntimeRouteGate`, which answers any path that `OWNED_MANAGED_RUNTIME_ROUTES` does not declare with an empty 404 before a handler runs.

## Goals

- Define `ToolResultManifestV1`, the resource that describes one execution's captured output: its identity, its orthogonal states, its capture scope and its ordered content descriptors.
- Define the segment page that lists a large stream's immutable segments, and the size bounds of pages and manifests.
- Define segment identity, idempotent publication and sealing, with digests computed by the receiver.
- Define how a manifest revision may extend an open stream, and that a final revision is immutable.
- Decide how a peer opts in, and show that an old peer is refused before any side effect.
- Pin all of it with one shared schema and fixture file that TypeScript and Java both read.

## Non-goals

- **Implementation.** No store publishes segments, no worker captures output and no route is mounted. O1b and O1c do that.
- **Hosted storage.** Object-store and shared-volume adapters, quotas, backpressure, publication holds and receipt reconciliation are O2.
- **Projection.** Java result and Artifact metadata, the public range and download API, and WebShell tool cards are O3.
- **Lifecycle.** Reference-aware cleanup, background Shell and Monitor, and MCP and media adapters are O4.
- **Operating values.** The reference design's section 6 values (an 8 KiB preview, 4 MiB segments, two segments in flight) are test inputs. This contract fixes only ceilings that a receiver enforces.

## Decisions

The four questions of #12723 are answered here. The first decides the opt-in and is part of this contract; the other three are the plans for O1b and O1c.

1. **Opt-in: a new tool contract version.** A peer opts in by calling Tool v3, a new route family that carries a versioned result envelope; no field is added to Tool v2. A worker that does not implement it answers each v3 path with the gate's empty 404 before any handler runs, so an old peer is refused before any side effect. The alternatives were weaker:
   - A capability in the `managed-context` boot and ready negotiation would tie result capture to Workspace context, change boot v2 before W0c wires it, and still need new routes to carry the envelope.
   - Separate resource routes next to Tool v2 would let an old worker execute through v2 first; the Broker would learn afterwards that no capture exists.

   The routes take protocol version 3, the next version of the owned route family, which `managed-context/1` also uses for its two routes. Their paths and protocol tokens keep the two apart, and a worker serves each only when it implements that protocol.

2. **Store ownership: a separate interface.** O1b adds stream publication and range reads behind a new interface implemented by the local adapter, next to `LocalManagedSessionResourceStore` and under the same resource root. `ManagedSessionResourceStore`, which the durable Session authority of #12693 and its HTTP adapter implement, stays unchanged until O2 needs remote segments.
3. **Completeness: complete by default for foreground Shell.** O1c admits foreground Shell under `complete_required`: missing bytes block result acceptance and model continuation. `best_effort` exists in the contract, but a tool uses it only when its admission names it. Either way a partial capture is never labeled complete, and a capture failure after a side effect never executes the tool again.
4. **Order.** O1a and O1b do not touch the worker and land first. O1c changes the worker and lands after W0c.

## Value rules

| Rule        | Values                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| id          | The Managed Session stable ID rule: a non-empty string of at most 512 UTF-8 bytes, well-formed, in NFC, with no C0, DEL or C1 character.  |
| token       | `[a-z0-9_-]{1,128}`. Lowercase only, so that a case-insensitive filesystem cannot merge two tokens in the local adapter's paths.          |
| digest      | 64 lowercase hexadecimal characters, the SHA-256 of the bytes it describes, as in `DurableRef`.                                           |
| generation  | Canonical decimal text from 1 to 2^63−1, the W0a rule for `workspaceGeneration`.                                                          |
| count       | A JSON integer from 0 to 2^53−2, the Managed Session sequence rule. A revision and a history revision start at 1.                         |
| durable ref | The five `DurableRef` fields with the Session record rules: `resourceId` and `kind` are ids, `schemaVersion` and `byteLength` are counts. |

## Tool result manifest

A manifest is a Session resource of kind `managed-tool-result-manifest` and schema version 1. Its body is one UTF-8 JSON object of at most 64 KiB, the largest resource the durable Session store keeps inline, with exactly these keys.

| Key                 | Rule                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `toolResult`        | `"managed-tool-result/1"`, the protocol token                                                            |
| `type`              | `"manifest"`                                                                                             |
| `tenantId`          | id                                                                                                       |
| `sessionId`         | id: the Managed Session, not the Runtime Session                                                         |
| `turnId`            | id                                                                                                       |
| `executionCallId`   | id: the `tool.intent` identity that the Session receipt will name                                        |
| `callId`            | id: the model's call ID                                                                                  |
| `invocationDigest`  | id: the `argsDigest` of the original reference, exactly as the Runtime received it                       |
| `bindingGeneration` | generation: the Runtime binding generation that ran the call                                             |
| `captureId`         | token: one per execution capture; segments are keyed under it                                            |
| `revision`          | count from 1                                                                                             |
| `executionStatus`   | `success`, `error`, `cancelled` or `unknown`                                                             |
| `exitCode`          | an integer from −2^31 to 2^32−1, or null; null while `executionStatus` is `unknown`                      |
| `signal`            | `SIG` followed by 1 to 16 characters from `[A-Z0-9]`, or null; null while `executionStatus` is `unknown` |
| `captureScope`      | `process_pty`, `process_pipes` or `tool_native`                                                          |
| `capturePolicy`     | `complete_required` or `best_effort`                                                                     |
| `captureStatus`     | `pending`, `complete`, `partial` or `unavailable`                                                        |
| `captureReason`     | null, or `quota_exhausted`, `size_limit`, `producer_lost`, `storage_failed` or `cancelled`               |
| `upstreamTruncated` | boolean                                                                                                  |
| `contents`          | an array of at most 32 content descriptors                                                               |

- **Identity.** No field alone identifies a result; in particular a `callId` is only unique within its Session. A reader compares the whole identity with the execution it expects, and a mismatch in any field is a conflicting result, never a substitute.
- **Execution status.** It is the physical outcome, whatever happens to the capture. A call that never started has nothing to capture and no manifest, so `not_started` is not a value here. `unknown` means the capture does not know the outcome, for example while the process still runs.
- **Exit.** `tool_native` has no process, so both `exitCode` and `signal` are null. For the two process scopes at most one of them is set: a process exits with a code or is ended by a signal, and both are null while the outcome is unknown. Unsigned 32-bit codes are Windows exit statuses.
- **Scope.** `captureScope` states what "complete" promises. `process_pty` is one PTY transcript in its single order. `process_pipes` keeps standard output and standard error apart, each in its own byte order, with no order between them. `tool_native` is the tool's own result as it produced it. Complete never promises that an upstream source returned everything; `upstreamTruncated` records that the source itself reported truncation, and it never makes a capture partial by itself.
- **No source version.** The manifest has no `sourceVersion`. A producer that wants to keep a version, of its adapter or of an upstream source such as an MCP server, writes it into its `result` stream, which the manifest already describes. The manifest holds only what a reader needs to find the bytes and judge their completeness, so no later producer needs a new manifest key for it.

### Content descriptors

Each entry of `contents` is an object with exactly these keys: `streamId` (token, unique in the manifest), `role`, `mimeType`, `state`, `byteLength` (count), `digest`, `missingRanges` and `body`.

- **Role.** `stdout`, `stderr`, `pty`, `result` or `attachment`. `stdout`, `stderr`, `pty` and `result` appear at most once each. `process_pty` has no `stdout` or `stderr`; `process_pipes` has no `pty`; `tool_native` has none of the three.
- **MIME type.** A lowercase `type/subtype` of `[a-z0-9.+-]` characters, each part starting with a letter or digit, optionally followed by `;` and printable ASCII parameters, at most 255 characters. It describes the bytes; it does not promise that they decode.
- **State.** `open` while bytes may still arrive; `sealed` once the end of the stream was observed and every byte was stored; `incomplete` once capture stopped with bytes missing.
- **Stored bytes.** A stream stores the contiguous prefix `[0, byteLength)`. `digest` is the SHA-256 of exactly those bytes, for every state; for a sealed stream it is the final digest.
- **Missing ranges.** Each is an object with exactly `start` and `end`, source byte offsets, with `end` null when unknown. Because the stored bytes are a prefix, a v1 stream has at most one missing range, it starts at `byteLength`, and a known `end` is larger than `start`. Only an `incomplete` stream has one, and an empty list there means the missing part is unknown.
- **Body.** An object with exactly one key:
  - `ref`: the whole stream as one resource of kind `managed-tool-result-content` and schema version 1, whose `byteLength` and `digest` equal the descriptor's. It is not allowed for an `open` stream, since a resource cannot grow.
  - `pages`: an array of at most 64 page references. Each is an object with exactly `ref` (a resource of kind `managed-tool-result-page`, schema version 1, 1 to 262144 bytes), `segmentCount` (1 to 1024) and `byteLength` (from `segmentCount` to `segmentCount` × 16 MiB). The pages' `byteLength` values add up to the descriptor's, and the list is empty exactly when the stream is empty.

### Capture status

`captureStatus` is fixed by the descriptors, and the manifest must state the status they imply:

| Status        | Descriptors                                                                                  | `captureReason` |
| ------------- | -------------------------------------------------------------------------------------------- | --------------- |
| `pending`     | at least one is `open`                                                                       | null            |
| `complete`    | at least one, all `sealed`                                                                   | null            |
| `unavailable` | none `open`, and every one is `incomplete` with no stored byte (this includes no descriptor) | required        |
| `partial`     | any other case: none `open`, at least one `incomplete`, and something stored or sealed       | required        |

`capturePolicy` does not change these rules. It tells the Session authority whether a `partial` or `unavailable` capture blocks acceptance (`complete_required`) or may be accepted with its reason (`best_effort`).

## Segment pages

A page is a Session resource of kind `managed-tool-result-page` and schema version 1. Its body is one UTF-8 JSON object of at most 256 KiB with exactly these keys: `toolResult`, `type: "page"`, `captureId`, `streamId`, `firstOrdinal` (count), `offset` (count) and `segments`, an array of 1 to 1024 objects with exactly `byteLength` (1 to 16777216) and `digest`. Its last ordinal, `firstOrdinal` plus the segment count minus one, is at most 65535, and `offset` plus its segments' bytes is a count.

- **Position.** Page `i` of a descriptor carries the manifest's `captureId` and the descriptor's `streamId`. Its `firstOrdinal` is the sum of the earlier pages' `segmentCount`, its `offset` the sum of their `byteLength`, its segment count equals its reference's `segmentCount`, and its segments' lengths add up to its reference's `byteLength`. A reader checks the position before it trusts a page, so a page read in the wrong place is refused.
- **Bounds.** The count limits keep every page within 256 KiB. They do not keep every manifest within 64 KiB: a manifest can fill its lists only while it stays within that bound, and a producer that would exceed it uses larger segments. A stream with all 64 pages reaches 1 TiB. It fits when the store assigns short page IDs, such as UUIDs, whatever the identity fields hold. JSON can double an ID's size, so 64 page references with 512-byte IDs may not fit; a hosted store (O2) that assigns long resource IDs must allow for that.

## Segment publication

A segment is immutable and identified by `captureId`, `streamId` and `ordinal`, a count below 65536 (64 pages of 1024 segments). The store keeps segments per Session; this contract fixes three operations that the local adapter (O1b) and the hosted adapters (O2) must all answer alike. The receiver computes every length and digest from the bytes it received. A digest from the caller is only an expectation to compare against, never a value to record.

- **Publish** `{captureId, streamId, ordinal, bytes, digest?}`, with 1 to 16 MiB of bytes. The receiver checks, in order:
  1. The shape and the rules above; otherwise `managed_tool_result_invalid`.
  2. A given `digest` that differs from the received bytes' digest is `managed_tool_result_digest_mismatch`. The receiver keeps the bytes out of every read; O1b quarantines them.
  3. An identity that already holds bytes returns its original result when the length and digest are the same, and is `managed_tool_result_conflict` otherwise.
  4. An ordinal at or above the segment count of a sealed stream is `managed_tool_result_conflict`.
  5. The receiver stores the segment and returns `{ordinal, byteLength, digest}`.
- **Seal** `{captureId, streamId, segmentCount, byteLength, digest}`, with `segmentCount` from 0 to 65536.
  1. The shape; otherwise `managed_tool_result_invalid`.
  2. A sealed stream returns its original result for the same three values, and is `managed_tool_result_conflict` for any other.
  3. The stored segments must be exactly the ordinals below `segmentCount`; a missing or an extra one is `managed_tool_result_conflict`.
  4. The received segments must add up to `byteLength` and hash, concatenated, to `digest`; otherwise `managed_tool_result_digest_mismatch`.
  5. The receiver seals the stream and returns `{segmentCount, byteLength, digest}`.
- **Prefix** `{captureId, streamId}` answers `{segmentCount, byteLength, digest, sealed}` for the verified prefix: the longest run of stored segments from ordinal 0. It is the cursor a producer publishes manifest revisions from. An unknown stream answers an empty prefix.

Segments may arrive out of order; the prefix grows when a gap fills. A refused operation records nothing, so a retry after the missing segments arrive can succeed. A later publish of the same identity with the same bytes returns the original result, including after sealing.

## Manifest revisions

A producer may publish a new revision while a stream is open, so that readers see the verified prefix grow. A successor of revision `n` must satisfy all of the following; otherwise it is a conflicting result.

- It is revision `n + 1` of a `pending` manifest. A `complete`, `partial` or `unavailable` revision is final and has no successor.
- Every identity field, `captureScope` and `capturePolicy` are unchanged.
- `executionStatus`, `exitCode` and `signal` change only while `executionStatus` was `unknown`.
- `upstreamTruncated` may become true, never false again.
- The earlier descriptors keep their positions, `streamId`, `role` and `mimeType`; new descriptors may follow them.
- A descriptor that was `sealed` or `incomplete` is unchanged.
- An `open` descriptor keeps a `pages` body and keeps or grows its `byteLength`, with the same `digest` when the length is the same. Its earlier pages stay unchanged except the last, which a page with the same position, at least as many segments and at least as many bytes may replace. The replacement page must start with every segment of the page it replaces, unchanged; a reader checks that on the two pages, since the manifest holds only their references.

## Tool v3 and the result envelope

Tool v3 is Tool v2 with a token, a capture request and a versioned result envelope, plus an acknowledgement. Its routes are declared in the shared fixtures but not in `OWNED_MANAGED_RUNTIME_ROUTES`, so the gate admits none of them until O1c mounts their handlers.

| Key           | Path                                       | Request limit | Response limit |
| ------------- | ------------------------------------------ | ------------- | -------------- |
| `execute`     | `/internal/managed-runtime/v3/execute`     | 256 KiB       | 1 MiB          |
| `status`      | `/internal/managed-runtime/v3/status`      | 16 KiB        | 1 MiB          |
| `cancel`      | `/internal/managed-runtime/v3/cancel`      | 16 KiB        | 1 MiB          |
| `acknowledge` | `/internal/managed-runtime/v3/acknowledge` | 16 KiB        | 1 MiB          |

Every route is `POST` with protocol version 3, `Cache-Control: no-store` in both directions and the Tool v2 headers: the bearer token and the lease ID and epoch. Every body carries `toolResult: "managed-tool-result/1"`.

- **Requests.** Each is closed:
  - `execute`: `protocolVersion`, `toolResult`, `reference`, `toolName`, `input` and `capture`. `capture` is closed to `tenantId`, `sessionId`, `turnId`, `executionCallId` (ids), `bindingGeneration` (generation) and `capturePolicy`: the manifest identity that the Runtime cannot derive itself. The worker compares `tenantId` with its boot document.
  - `status`: `protocolVersion`, `toolResult`, `reference`, and an optional `afterSequence` count.
  - `cancel`: `protocolVersion`, `toolResult`, `reference`.
  - `acknowledge`: `protocolVersion`, `toolResult`, `reference` and `receipt`, closed to `executionCallId`, `manifest` (a manifest reference or null), `deliveryStatus` (`committed` or `blocked`) and `historyRevision` (a count from 1 when committed, null when blocked).
  - `reference`, `toolName` and `input` keep their Tool v2 rules, except that `reference.callId` and `reference.argsDigest` must also satisfy the id rule, because the manifest repeats them as `callId` and `invocationDigest`.
- **Responses.** Each is closed to `protocolVersion`, `toolResult`, `state` (the five Tool v2 states), `result` exactly when the state is `settled`, and `lastSequence` on `status` only. `acknowledge` answers only `settled`, with the acknowledged `deliveryStatus`, or `unknown`.
- **Result envelope.** A settled `result` is closed to `executionStatus` (the four Tool v2 values), `responseParts`, an optional `error` with the Tool v2 shape, and `capture`:
  - `capture` is null exactly when the call did not start. Otherwise it is closed to `captureStatus`, `captureReason`, `manifest`, `previewTruncated` and `deliveryStatus`.
  - `captureStatus` is `complete`, `partial` or `unavailable`: a call settles only after its capture concluded, so never `pending`. `captureReason` is null exactly when it is `complete`.
  - `manifest` references the final revision (kind `managed-tool-result-manifest`, schema version 1, 1 to 65536 bytes). It is required unless the capture is `unavailable`.
  - `previewTruncated` says only that `responseParts` show less than was captured. A complete 100 MiB capture can have a truncated preview.
  - `deliveryStatus` is `pending` until an acknowledgement, then the acknowledged status. Only a Session receipt makes it `committed`.
  - When a manifest is referenced, its final revision must agree: the same `executionStatus`, `captureStatus` and `captureReason`, and not `pending`.
- **Acknowledgement.** The Session authority acknowledges after it has committed or blocked the result. The worker checks the receipt against the invocation that the reference names: the call must have settled after it started, and the receipt's `executionCallId` and `manifest` reference must match it exactly. It then answers the status response with the acknowledged `deliveryStatus`. A repeated identical receipt returns the same answer. A call that has not settled or did not start, a mismatch, and any other receipt for an acknowledged call are `managed_tool_result_conflict`. A reference the worker holds no record of answers `unknown` with 200, as `status` does. Only after a `committed` acknowledgement may the Runtime discard its spool.

### Refusal before any side effect

A Broker that needs capture calls only v3 for that call, uses v3 for every later status, cancel and acknowledgement of it, and never retries it through v2. The gate of a worker without v3 answers every v3 path with an empty 404 before a handler runs, which the Broker classifies as incompatible, so nothing executes. The v2 and v3 request shapes exclude each other, so a v2 body sent to a v3 route, or a v3 body to a v2 route, is refused with 400 before a journal entry exists. A Broker also refuses a v2-shaped answer on a v3 route, because the v3 response requires the token and protocol version 3. Calls that are not admitted for capture stay on Tool v2 unchanged.

## Errors

| Status | Code                                    | Class        | When                                                                                     |
| ------ | --------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| 401    | `managed_runtime_unauthorized`          | credentials  | a missing or wrong bearer token                                                          |
| 400    | `managed_runtime_attestation_invalid`   | protocol     | a bad route body, header or protocol version                                             |
| 413    | `managed_runtime_attestation_too_large` | protocol     | a request body over its limit                                                            |
| 409    | `managed_runtime_identity_conflict`     | identity     | the lease headers or `capture.tenantId` differ from the boot, or a reused `callId`       |
| 409    | `managed_tool_result_conflict`          | identity     | an acknowledgement that disagrees with the invocation or with an earlier acknowledgement |
| 404    | none                                    | incompatible | a route that the worker does not serve                                                   |
| —      | `managed_tool_result_invalid`           | protocol     | a store operation that breaks the shape or a rule                                        |
| —      | `managed_tool_result_conflict`          | identity     | a store operation that disagrees with stored segments or a seal                          |
| —      | `managed_tool_result_digest_mismatch`   | integrity    | received bytes that do not match the expected length or digest                           |

The last three are store outcomes; O2 gives them HTTP statuses when segments cross the network. A v3 client classifies a refusal by status and code together, as a `managed-context/1` client does. A conflict or an integrity refusal is never retried with other bytes, and it never makes a Harness accept another execution's output or execute the tool again.

## Security

- The contract carries no filesystem path. A reader addresses bytes only through Session resources and segment identities, and the local adapter derives every path from tokens.
- Digests are computed by the receiver. A caller's digest is compared, never recorded.
- Raw output can contain secrets. The manifest carries none of it, and nothing here makes a resource public: public Artifact IDs and download authorization are O3's.
- Identity is compared exactly, as strings.

## Shared schema and fixtures

`packages/core/src/managed-runtime/contracts/managed-tool-result-v1.schema.json` and `.fixtures.json` hold the contract. They live in `core` because O1b's store and O1c's worker both use the module that replays them.

- The protocol token, resource kinds, limits, Tool v3 routes and error table.
- Manifest, page, page-position, manifest-revision and page-revision cases, valid and invalid, each invalid case aimed at one rule.
- Segment publication sequences with the expected result of every step, with bytes in base64.
- Result envelope cases alone and against a manifest.
- Canonical Tool v3 requests and responses, and request and response cases that the schema decides.

The schema fixes each record's shape and the rules it can state readably, including the scope rules for roles and the status that descriptors imply. It cannot state UTF-8 byte limits, NFC, well-formed UTF-16, unique stream IDs, sums across a list, a bound that depends on another field, or a comparison between two fields or two records; the TypeScript test lists every case on which the schema and the module disagree. An implementation independent of both languages built the cases and computed every digest.

- **TypeScript.** `packages/core/src/managed-runtime/managed-tool-result.ts` validates manifests, pages, page positions, revisions and result envelopes, and holds a reference segment ledger that replays the publication sequences. Nothing imports it until O1b, which keeps the ledger as the in-memory implementation of its segment store interface, as the Broker keeps its in-memory repositories beside the JDBC ones.
- **Admission.** A CLI test sends the canonical v3 requests through the shipped route gate to handlers that would record a call, and checks that each answers an empty 404 and that no handler ran. It reads the fixtures from core's source tree, as the Java test does, so that one file stays the only copy.
- **Java.** A conformance test in `runtime-broker` pins the token, kinds, limits, routes, closed key sets and error table, and recomputes every segment, seal and prefix digest from the fixture bytes.

## Files affected

- `packages/core/src/managed-runtime/contracts/managed-tool-result-v1.schema.json` and `.fixtures.json` (new).
- `packages/core/src/managed-runtime/managed-tool-result.ts` and its test (new).
- `packages/cli/src/serve/managed-tool-result-admission.test.ts` (new).
- `ManagedToolResultConformanceTest` in `packages/sdk-java/runtime-broker` (new), and the module's `README.md` and `QWEN.md`.
- This design document in both languages (new), and the Tool v2 contract document, whose note on the artifact delivery track now points here.

No worker, route manifest, store, provisioner, transport or CI workflow changes.

## Validation plan

- **TypeScript:** strict Ajv validation of the fixtures against the schema; every case and sequence replayed through the module; the schema checked against every case; the largest records measured against their limits.
- **Admission:** the shipped gate refuses every v3 route before any handler.
- **Java:** the conformance test pins the key sets, routes, constants and error table, and recomputes every digest.
- **Mutation check:** each check of the module is mutated in turn and the suite rerun.

## Acceptance criteria

- Every malformed shape in the fixtures is refused, by the module and, where it can state the rule, by the schema.
- Republishing a segment with the same bytes returns the original result, and different bytes under the same identity conflict, before and after sealing.
- A seal records the receiver's digest over the received bytes and refuses a mismatch.
- An old peer is refused at route admission before any handler runs.
- Tool v2, `managed-context/1` and every worker, store and Broker behavior are unchanged.

## Open questions

1. Should a background producer (O4) publish a revision per verified segment, or coalesce revisions? The contract allows either; the reference design coalesces progress events.
2. Should a Hook's outcome become a content role? The reference design lists it, but no O1 producer emits one, so v1 leaves it out.

## Follow-up work

| Slice | Scope                                                                                                                                                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1b   | The local segment store behind its own interface, with the ledger's operations and outcomes: publish, seal, prefix and range read; bounded memory for a 100 MiB stream; quarantine of corrupt or conflicting segments; the fixture sequences replayed against it.                                          |
| O1c   | Tool v3 on the worker after W0c: capture of foreground Shell before truncation into a bounded spool, reusing `persistedOutputFiles` when its bytes are still verified; the result envelope; the acknowledgement; a Java v3 transport; route fixtures for the header discipline; the 100 MiB survival test. |
