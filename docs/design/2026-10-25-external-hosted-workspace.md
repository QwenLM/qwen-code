# External Hosted Workspace Runtime (phase 2)

Status: **design proposal, unimplemented**. Builds on `docs/design/2026-10-23-external-runtime-provider.md` (phase 1, `external-scratch`, accepted contract) and the verified Aone operator‑adapter rehearsal. Nothing here weakens `external-scratch` invariants: deterministic logical handle before the first remote call, no replacement after a lost reply, no release‑to‑kill, Broker‑side independent attestation, provider deduplication by `provisionRequestId`.

## 1. Why this phase exists

Phase 1 allocates and attests a session‑isolated worker but ships no tool consumer: an unbound Session has no Hosted tool profile, so the model receives no tool declarations while the worker runs idle until provider TTL. The product goal of this phase:

- A Hosted Session bound to an external Workspace provisioned on a vendor sandbox platform accepts file tools (`read_file`, `write_file`, `edit`, `glob`) and foreground shell (`run_shell_command`, `monitor`) delivered to a worker the central service does not run, under the same visibility, approval, and durability semantics as the local‑process path.
- Recovery after Broker process loss or adapter process loss preserves storage ownership and session binding semantics exactly. Ambiguous outcomes retain ownership and never silently replace a worker or rekey storage.

Explicitly out of scope for this design (moves to later phases on request): public browsing, MCP tools, directory import, child workspaces, snapshots, migration, and fully dynamic Workspace creation (allocate‑storage‑on‑demand, §7).

## 2. Relationship to `external-scratch`

| Aspect                    | `external-scratch` (phase 1, shipped) | `external-workspace` (this design, phase 2)                                                  |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Tools the model sees      | none                                  | full Hosted Workspace v1 profile                                                             |
| Worker boot               | boot‑v1 (container)                   | boot‑v2 (new container admission, §6)                                                        |
| Worker lifetime ends by   | provider TTL                          | explicit `stopDrained` proof or TTL; storage owners fence release (§8)                       |
| Storage identity          | n/a (scratch cwd only)                | registered, revisioned, fenced (§4)                                                          |
| Provisioner handle family | `external`, version 1                 | `external-workspace`, version 1 (distinct kind, never reinterpreted)                         |
| Provider HTTP additions   | `provision`, `observe`                | + `storage:provision`, `storage:observe`, publication/capture (§5, §7 reuse wire discipline) |
| Workspace state machine   | —                                     | same state machine as LOCAL/SSH_LOCAL with new ownership kind `EXTERNAL`                     |

The profile is selected by `QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=external-workspace` in a deployment where Workspace files and/or shell are explicitly enabled. The phase‑1 scratch profile and its validation (`validateExternalRuntime`) remain untouched.

## 3. Identity and wire contract (shared transport discipline)

Reuse phase 1 for the channel: authenticated HTTPS, POST, no redirects, 64 KiB request/response bounds, `Cache‑Control: no-store`, `protocolVersion: 1`, sanitized errors. Additions:

- **Worker ingress for API** runs on one additional forwarded port (worker's publication service, §7) with bearer + lease/domain header checks; never on the attest port's identity surface.
- A **durable registration operation** must precede any workspace binding. Like provision, registration writes its durable logical handle before the first HTTP call, deduplicates by request ID, and rejects a late conflicting reply.
- All identity digests stay canonical‑JSON sha256, token‑free. No worker may be started by a registration call; registration only registers.

## 4. External storage registration (the "Workspace" a session binds)

A remote Workspace is storage, not a sandbox. Registration is issued by the operator's control plane (not by user code):

1. Operator registers two tuples with the Managed Agent server, via the public registration REST (loopback‑secured):
   - `ExternalStorageIdentity = {providerId, physicalKey, registrationRevision}` — provider‑assigned, immutable, unique per logical tenant‑storage instance; NOT a sandbox ID (sandboxes are lost after TTL).
   - `StorageAlias = {tenantWorkspaceId, aliasPath, mountRoot}` — the user‑visible Workspace identity and the absolute worker‑side mount root under which files materialize (path must be canonical, non‑root, owner‑only writable, `0700`).
2. The server records a NEW ownership kind `EXTERNAL` in `WorkspaceStorageGuard` / `WorkspaceExecutionStore`, with:
   - SQL writer/generation fences identical to the ones LOCAL/SSH_LOCAL use (guard lease row duplicated on activation changes only).
   - Tenant‑storage‑alias uniqueness across external registrations (cross‑tenant alias collision = hard conflict 409, never adopt).
   - `boundTenant` nail‑down: an external storage tuple is single‑tenant. A sandbox's physical key registered for tenant A cannot be bound to tenant B without an operator‑signed re‑registration event.
3. The provider adapter receives a `storage:provision` carry operation that tells a fresh worker where the prepared storage tree lives (path = alias mount root), and a corresponding `storage:observe` for run‑state and continuity probing (v1 returns `READY/STARTING/UNKNOWN/GONE` plus `continuity: "confirms"|"denies"|"unknown"` — a cheap truth‑telling witness the Broker uses before claiming writes).

`readme` result: durable registrations survive server restarts; sandbox rotation (new sandbox placing the same alias+physicalKey) maps to a new worker and does NOT create a new workspace lineage.

## 5. Guard, store, resolver ownership extension

- `WorkspaceStorageGuard` admits kind `EXTERNAL` with the same physical‑path classes: tenant‑root containment check runs against the worker's mount root **as registered**, not via central `Files` calls against a local path. All file operations stay inside the worker where containment is enforceable.
- `WorkspaceExecutionStore` accepts the `EXTERNAL` kind with identical fencing semantics, driving authorization through the SQL fence the existing kinds use. The guard's storage version bumps on registration/retirement updates.
- `WorkspaceRuntimeResolver` binds an external alias to the new kind's provider when the workspace identity matches `providerId` AND `registrationRevision`, never by alias alone — this keeps workspace ID re‑assignment (operator misconfiguration) from silently redirecting sessions.

All three changes are small, tabled extensions; reachability of a remote worker is checked only during `provision`/`activate`/`verify` boundaries, never per file operation.

## 6. Worker admission: boot‑v2 in container mode (CLI)

Today the container boot path refuses boot‑v2. This phase adds `ManagedRuntimeWorkerBoot` v2 in container mode with **storage‑side paranoia**:

- The boot document adds `storage: {kind: "external", physicalKey, aliasPath, mountRoot, registrationRevision}`. The worker verifies it at boot: mount root exists or is creatable by it, ownership owner‑only‑writable, absolute, normalized, and within its permitted root. A boot asserting a missing physicalKey/ref mismatch is refused closed (never mount a different key than the one the Broker bound).
- The worker runs a small publication service (`/internal/managed-runtime/v2/publication:*`) for foreground shell capture (§7) once v2 boot succeeds. It registers its publication endpoints in the boot receipt; the Broker learns the reachability from `observe` (which now runs a publication readiness probe before reporting `READY` for this profile).
- The sessions' `isolationClass: session` already pins 1 worker/session; dynamic aliases activate the storage context in this worker only.

Boot rejection strings never name physical paths to an unauthenticated caller, matching boot‑v1 parity.

## 7. Foreground shell publication and capture

The hardest gap for remote foreground shell is evidence — who saw what, and whether a close leaves untraceable effects:

- Worker hosts a bounded publication endpoint: request `publication:begin` channels with a per‑execution captured‑input identity. Streams (stdout/stderr/pty) carry durable per‑sequence receipts; the endpoint enforces byte bounds equal to the local shell's and writes raw output only to its own `0700` publication directory (secrets/natural‑language filtering is a later concern, parity with local behavior out of scope of this statement).
- The Broker consumes via `publication:read` exactly like its local consumer. An unrecognized channel or stale lease = closed error; no graceful degradation to "no capture".
- `stopDrained` (§8) publishes a final receipt for each channel. The close path requires all captured queues drained to end‑of‑stream sequence, otherwise close stays blocked/cancelled.

Foreground only in this design; background shell execution (`is_background`) is a later phase with its own evidence story.

## 8. Exact‑worker `stopDrained` and storage ownership fences

Automatic close/recovery requires proof the ORIGINAL worker can no longer write:

- The Broker asks the worker (lease/domain/revision headers) for `publication:stop-drained?channel=all`. A truthful answer takes one of three forms:
  - `drained` — durable read‑only surface verified write‑locked by the worker's own per‑channel receipts; Broker can close storage and retire the binding.
  - `undrained(channel seq)` — close must remain deferred; replay‑only reads are OK.
  - `unknown` — never close, never replace; the sandbox TTL may reclaim CPU but storage fences stay.
- A sandbox expiry/GONE is NOT a drain proof. A worker crash is NOT a drain proof. `release` continues to be a no‑op for this profile (phase‑1 rule — kill authority belongs to the storage's owner‑fenced stop path only).

The supervisor process writes task‑lifetime receipts inside the worker's private publication directory (path bounded, secrets never inside release payloads), so an adapter restart can re‑attest drain by re‑stating receipts, not by trusting a crash.

## 9. Operator adapter evolution (Aone, private repo)

Deltas under `scripts/qwen-runtime-provider/`:

1. Reuse everything rehearsal‑proven: durable create‑only journal, writer lock, boot upload, run‑up wait, mode‑free upload, single‑shot launch, request‑ID dedupe, attest probe. No changes to provision/observe semantics.
2. Add `storage:provision`/`storage:observe` implementations that bind aliases (for v1, operator‑managed: register physical keys up‑front; auto‑allocate physical storage pools behind a durable allocator comes only after phase‑2 v1).
3. Launch worker with boot‑v2 v2 boot doc; publication readiness probed over ingress pre‑READY.
4. Extend TTL handling: adapters surface sandbox `remaining_seconds` in observe; central close calls `stopDrained` first on expired experiments for evidence hygiene.

The upstream never learns the word Aone for these APIs; auth/token/wire shape stays phase‑1.

## 10. Verification matrix

| Layer                     | Required witness                                                                                                                        | Established by                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Storage registration unit | register/reject conflicting alias/tenant/revision; precommit folder; renewal identity                                                   | new guard/store/resolver unit suites            |
| Worker admission unit     | boot‑v2 accepted + key mismatch rejected; mount root containment                                                                        | CLI container tests                             |
| Publication/capture       | begin/read/receipt semantics; byte bound; stale lease refusal                                                                           | worker unit suites                              |
| stopDrained proof         | drained/undrained/unknown and close gating                                                                                              | worker+Broker IT                                |
| Broker + real worker      | storage over Aone: register → place → attest → write/read/edit/shell foreground → close with drain                                      | full‑tier fault suite (extends phase‑1 fixture) |
| Public Hosted E2E         | Session workflow with visible tools; approval cards reconstruct captured input; restartBroker + restartAdapter preserve storage lineage | full Public Hosted validation                   |

## 11. Sequencing

1. Guard/store/resolver extension and registration REST, no wiring (compat‑only).
2. CLI boot‑v2 container admission and publication service (both without consumers = inert).
3. Provider profile `external-workspace` with `storage:*` (adapter and provisioner), low‑visibility activation.
4. stopDrained + close gating; then turn tools on with the Hosted profile only under explicit flag.
5. Public Hosted E2E in full‑tier CI; only at this point documents the profile as deployable for Hosted tools.

Each step is independently revertible. The phase‑1 contract and its fault‑gate evidence stay as the base — this design adds semantics only.
