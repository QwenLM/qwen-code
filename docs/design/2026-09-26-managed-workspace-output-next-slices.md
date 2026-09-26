# Managed Workspace: Broker Context Integration (W0c-2)

[English](2026-09-26-managed-workspace-output-next-slices.md) | [简体中文](2026-09-26-managed-workspace-output-next-slices.zh-CN.md)

Status: implementation in draft PR #12730. Baseline: `main` at `342ba1bcd`, 2026-09-26. This completes the Broker slice of [W0c #12724](https://github.com/QwenLM/qwen-code/issues/12724), under [proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380).

## 1. Current state and scope

W0b #12709 and W0c-1 #12732 are merged. The Worker accepts boot v2, emits ready v2, serves attestation/context v3, and pins tool v2 execution to installed Session directories. Java still writes boot v1 and attests v2. A transient pre-ready failure can launch another process on the next warm request.

This slice adds explicit Broker opt-in, durable storage identity, strict v2/v3 protocol admission, a context installation client, and a durable one-launch guard. It does not activate bound Workspace Sessions. The existing EmbeddedRuntimeBroker product gate stays closed pending W0c-3.

## 2. Provision identity and persistence

`RuntimeScope` keeps its six fields and existing Session/execution scope hashes. An explicit `storageId` on immutable `RuntimeProvisionRequest` selects managed-context/1. Legacy constructors retain boot v1. The mount root is the scope's `canonicalCwd`, never a Session subdirectory. Existing Broker persistence limits that string to 512 UTF-16 units, within the envelope's 4096-byte limit; the stricter local limit remains documented.

`RuntimeProvisioner.createRequest` supplies the request. LocalProcess accepts an optional administrator-supplied storage resolver; enabling it requires a non-null valid storage ID for every resolved scope. The service answers a scope the provisioner cannot place with 400 `runtime_placement_invalid`, before any binding is recorded; it never falls back to boot v1. No caller-supplied path or inferred Workspace ID creates storage authority. W0c-3 supplies the production resolver after Registry/generation/authorization checks.

Persist nullable `storage_id` on both the binding slot and binding. Include it in a domain-separated managed-context request hash; retain the old request hash byte-for-byte for legacy rows. Scope hashes do not change. Reconstruct protocol choice from persisted requests for confirm, reconciliation and recovery. Do not recompute it from current resolver defaults. JDBC schema initialization upgrades existing tables additively, and tolerates another instance adding the column at the same time; server Flyway receives a new migration, without rewriting published migrations.

Older Broker binaries cannot interpret managed-context rows safely. Upgrade all Broker readers before enabling the resolver; rolling back to a legacy binary requires draining managed-context bindings first. Existing legacy rows remain readable by new binaries. Tests pin legacy hashes and reject tampered storage identity.

## 3. Wire admission and installation

Use the closed [managed-context envelope](2026-09-25-managed-context-envelope.md) and [Worker behavior](2026-09-26-managed-context-worker.md). Validate identifiers, printable storage IDs, canonical positive decimal generation, SHA-256 digests, absolute mount roots, bearer tokens and safe-integer epochs before launching or sending. Preserve Unicode; reject unpaired surrogates instead of silently replacing them. The writer would turn one into `?`, so this also holds for every Runtime Session ID and for the `sessionId`, `promptId`, `callId` and `argsDigest` of a tool v2 reference, which would otherwise reach the Worker as another Session's or call's identity.

| Surface                                     | Ownership and verification                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| boot v2 / ready v2                          | Process bootstrap; exact ready keys, managedContext, seed identity and canonical loopback origin. No boot v1 downgrade.                                                                                                                                                                                                                              |
| POST `/internal/managed-runtime/v3/attest`  | Selected Runtime; compare every persisted Workspace/storage/root and seed field, including incarnation. Expose attested storage identity to the Broker's independent admission check.                                                                                                                                                                |
| POST `/internal/managed-runtime/v3/context` | Selected Runtime and named Session: the client takes the READY binding record and the Session, and requires the record's scope and, under session isolation, its isolation key to be the Session's. Send immutable W0a binding, computed digest and operation ID; verify every receipt field against the original request and receiving incarnation. |
| tool v2                                     | Existing Session owner and original execution reference. Preserve context-unavailable/conflict refusals so they do not masquerade as Runtime identity replacement. Status/cancel remain available for the original execution.                                                                                                                        |

Context requests and responses are bounded to 16 KiB, have JSON UTF-8 and no-store response requirements, and reject redirects/incompatible peers. Installation is an explicit transport operation, not automatically invoked by acquire: W0c-2 has no authority to choose frozen Session configuration. A successful receipt proves context installation only, not activation or permission to execute.

## 4. Bounded startup and recovery

For managed-context requests, persist a resource handle before process launch. A binding with such a handle but without an attested lease may not automatically launch again. A failed or ambiguous first attempt transitions to `RECOVERY_BLOCKED`; repeated warm requests and Broker restarts cannot allocate a replacement generation. Once the block is recorded, the failing call answers 409 `runtime_broker_recovery_blocked` rather than a retryable error, including when the attempt outlives its deadline. If the block cannot be recorded, the call keeps its original answer; the next call then blocks if the resource handle was persisted. Even a crash between handle persistence and process launch blocks automatic retry. Legacy startup policy remains unchanged.

Ready and attestation incompatibility fail closed. Failed children are terminated by the provisioner. Recovery requires evidence that the original process cannot execute and an authorized lifecycle action; this slice adds no public retry endpoint. Runtime-ready reconciliation remains observational and uses the saved request/seed.

## 5. Changed components and consumers

Changes are limited to Java Runtime Broker request/provisioner, local worker bootstrap, HTTP transport, attestation, durable binding admission, JDBC binding storage/schema, server schema migration, corresponding tests and documentation. RuntimeScope, Session/tool journal keys, tool v2 payloads, Worker routes and public Session APIs remain stable. In-memory repositories use request equality and require no schema migration.

## 6. Validation and acceptance

- Keep all legacy Java Broker tests passing; build/typecheck/bundle the local Worker.
- Consume shared envelope fixtures through production validation, including fractional/unsafe numbers, unexpected keys, Unicode and receipt mismatches.
- Test explicit storage opt-in, v3 attestation and exact installation receipts with fake peers and a real Java-to-TypeScript process.
- Verify installation replay, Session conflict, missing directory refusal and unchanged legacy boot v1 against real processes.
- Pin legacy request/scope hashes; test existing-schema upgrade, storage roundtrip and tamper rejection across repository instances.
- Prove repeated warm and restart after an ambiguous launch do not spawn another process; cover the crash-before-launch marker and the deadline.
- Refuse installation on another placement's Runtime or a binding that is not READY, and ill-formed Session or reference IDs, before sending; tolerate a concurrent schema upgrade.
- Run focused tests, Java Checkstyle, and two clean self-audit passes before pushing.

The E2E plan and observations are maintained in `.qwen/e2e-tests/managed-context-broker.md`. Baseline tests use the global CLI first; final tests use the local bundle. No model credentials or external model calls are needed.

## 7. Follow-up dependencies and open questions

W0c-3 joins W0b and W0c-1/2: resolve original Session binding plus frozen config/policy, verify Registry/storage generation, install configuration separately, verify context/config receipts, and hold the Workspace turn lease before activation. Missing evidence keeps execution closed. Legacy unbound resolution stays separate.

Worker installation/receipt capacity is follow-up work; W0c-1 currently retains evidence for the incarnation without the finite capacity proposed in the earlier draft. W0c-2 does not claim capacity retirement is implemented. Arbitrary Shell confinement still requires restricted mounts or equivalent isolation, not only realpath checks.

O1a is being defined independently in [#12729](https://github.com/QwenLM/qwen-code/pull/12729): tool v3 execute/status/cancel/acknowledge, a separate streaming store, and complete-required foreground Shell capture. It supersedes this draft's earlier suggestion of a separate capability-probe route. O1b follows that reviewed contract; O1c follows O1a/O1b and W0c-1 Worker integration. Hosted enablement additionally needs W0c-3 and O2. This PR contains no O1 implementation.

[#12713](https://github.com/QwenLM/qwen-code/pull/12713) is a no-tool Hosted Harness step. The [#12358 preview](https://github.com/QwenLM/qwen-code/pull/12358) is integration research, not evidence that product gates passed. No unresolved design question blocks the scoped Broker implementation; rollout and capacity remain explicit follow-ups.
