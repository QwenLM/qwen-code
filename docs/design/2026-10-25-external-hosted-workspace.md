# External Hosted Workspace Runtime (phase 2)

[English](2026-10-25-external-hosted-workspace.md) | [简体中文](2026-10-25-external-hosted-workspace.zh-CN.md)

Status: **step 3a (provisioning prerequisite) implemented; the product feature is not.** Builds on `docs/design/2026-10-23-external-runtime-provider.md` (phase 1, `external-scratch`, accepted contract) and the verified Aone operator‑adapter rehearsal. Nothing here weakens `external-scratch` invariants: deterministic logical handle before the first remote call, no replacement after a lost reply, no release‑to‑kill, Broker‑side independent attestation, provider deduplication by `provisionRequestId`.

## 1. Why this phase exists

Phase 1 allocates and attests a session‑isolated worker but ships no tool consumer: an unbound Session has no Hosted tool profile, so the model receives no tool declarations while the worker runs idle until provider TTL. The product goal of this phase:

- A Hosted Session bound to an external Workspace provisioned on a vendor sandbox platform accepts file tools (`read_file`, `write_file`, `edit`, `glob`) and foreground shell (`run_shell_command`, `monitor`) delivered to a worker the central service does not run, under the same visibility, approval, and durability semantics as the local‑process path.
- Recovery after Broker process loss or adapter process loss preserves storage ownership and session binding semantics exactly. Ambiguous outcomes retain ownership and never silently replace a worker or rekey storage.

Explicitly out of scope for this design (moves to later phases on request): public browsing, MCP tools, directory import, child workspaces, snapshots, migration, and fully dynamic Workspace creation (allocate‑storage‑on‑demand is item 7 of [phase 1's required Workspace extension](2026-10-23-external-runtime-provider.md#required-hosted-workspace-extension); §7 below is foreground shell publication).

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
3. The provider adapter receives a `storage:provision` carry operation that tells a fresh worker where the prepared storage tree lives (path = alias mount root), and a corresponding `storage:observe` for run‑state and continuity probing (v1 returns the phase‑1 observe state set unchanged plus a `storage` evidence object carrying `continuity: "confirms"|"denies"|"unknown"` — a cheap truth‑telling witness the Broker uses before claiming writes; wire schema and state mapping below).

In one sentence: durable registrations survive server restarts; sandbox rotation (new sandbox placing the same alias+physicalKey) maps to a new worker and does NOT create a new workspace lineage.

**`storage:observe` wire schema (this profile).** The request is the unchanged phase‑1 observe request (`protocolVersion: 1`, `provisionRequestId`, `identity`, `handle`, 64 KiB body bound, no redirects, `Cache‑Control: no-store`). The response keeps the phase‑1 `state`/`endpoint` members (the endpoint appears only with `RUNNING`) and adds one `storage` object of storage evidence:

```json
{
  "protocolVersion": 1,
  "state": "RUNNING",
  "endpoint": "https://worker.example/",
  "storage": {
    "storageRef": "sha256-of-canonical-storage-identity",
    "mountRoot": "/workspace/storage",
    "continuity": "confirms"
  }
}
```

**Implemented shape (step 3a).** The members above are the whole set step 3a
verifies, and the set is closed: `storageRef`, `mountRoot` and `continuity`, all
three required, nothing else accepted. `mountNonce` belongs to this design's wider
set, but it cannot be verified yet — the persisted registration record has no nonce
column, so a worker-reported nonce would be an unverified claim. A response that
carries `mountNonce` is therefore **refused** (`external_storage_registration_mismatch`)
rather than accepted with the member ignored; adding it to the record is step 3b
work, because the registration REST/write path is a shipped Phase-1 surface.
`storageRef` is the canonical-JSON SHA-256 (members sorted by name, the revision as
a JSON integer, lowercase hex) of exactly `{providerId, physicalKey,
registrationRevision}` — the registered identity tuple, with no wrapper member.

`state` is the phase‑1 observe member and takes exactly four values — `RUNNING`, `STARTING`, `UNKNOWN`, `GONE` — because this profile answers on `protocolVersion: 1` and must not expose a second status vocabulary; any other value blocks adoption exactly as in phase 1. `storage` carries storage‑specific evidence and never a state of its own: it is present only with `RUNNING`, and `RUNNING` without it is evidence‑free and cannot authorize writes. `READY`, used elsewhere in this document for this profile, is the Broker‑local predicate defined below and is never a wire value.

| `state`    | Phase‑1 meaning                                                                          | Evidence this profile requires                                                                                                                                  | Permitted action                                                                        |
| ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `RUNNING`  | Worker HTTP(S) origin answers; adoption still needs the Broker's independent attestation | `storage` present: registered tree materialized at `storage.mountRoot`, its marker matching the registration record, and the publication readiness probe passed | Claim writes only with `continuity: "confirms"`; the only state that may report `READY` |
| `STARTING` | Allocated, not serving yet                                                               | No `storage` evidence; provision accepted, tree or publication surface not ready                                                                                | No writes, no replacement; retry `storage:observe`                                      |
| `UNKNOWN`  | Indeterminate (timeout, ambiguous or unparsable reply)                                   | Nothing established                                                                                                                                             | Retain ownership, no writes, no replacement; retry                                      |
| `GONE`     | Absent; blocks adoption and never triggers replacement                                   | Worker and its sandbox are gone                                                                                                                                 | Never adopt, never replace; storage ownership and its fences persist (§8)               |

`READY` is the Broker‑local predicate `state == "RUNNING"` plus `continuity: "confirms"` plus publication readiness. It gates claiming writes and advertising the Hosted tool profile, it never substitutes for independent attestation, and no other state reports it. `continuity: "denies"` blocks claiming writes in every state, including `RUNNING`, and never authorizes replacement.

## 5. Guard, store, resolver ownership extension

- `WorkspaceStorageGuard` admits kind `EXTERNAL` with the same physical‑path classes: tenant‑root containment check runs against the worker's mount root **as registered**, not via central `Files` calls against a local path. All file operations stay inside the worker where containment is enforceable.
- `WorkspaceExecutionStore` accepts the `EXTERNAL` kind with identical fencing semantics, driving authorization through the SQL fence the existing kinds use. The guard's storage version bumps on registration/retirement updates.
- `WorkspaceRuntimeResolver` binds an external alias to the new kind's provider only when the bound alias resolves to the whole `ExternalStorageIdentity` tuple — `providerId` **and** `physicalKey` **and** `registrationRevision` — all three read from the durable registration record, never from the alias text or the request payload. `registrationRevision` is a per‑instance counter, so `(providerId, registrationRevision)` is not unique across storage instances: matching only that pair lets a second physical key claim the sessions bound to the first. A mismatch on any member is the same hard conflict as §4 (409, never adopt) — never a partial match, never a fallback to the alias.

All three changes are small, tabled extensions; reachability of a remote worker is checked only during `provision`/`activate`/`verify` boundaries, never per file operation.

## 6. Worker admission: boot‑v2 in container mode (CLI)

Today the container boot path refuses boot‑v2. This phase adds `ManagedRuntimeWorkerBoot` v2 in container mode with **storage‑side paranoia**:

- This phase introduces a **new closed boot document** — `managed-runtime-boot/2` — rather than widening the shipped `ManagedContextBoot` boot‑v2 key set. That document is parsed by an exact key‑list check (`readClosed` rejects any document whose sorted keys are not the expected sixteen), so adding a member to it would reject every shipped boot‑v2 document and every CSI v3–v6 envelope that wraps one. The new document has its own version and its own closed key list; shipped boot‑v2 parsing is unchanged, which is what makes this step inert for existing workers.
- The new document carries one provider‑neutral storage member, `externalStorage: {kind: "external", storageRef, mountNonce, aliasPath, mountRoot}`, inside which `aliasPath` and `mountRoot` are members of this object rather than a second top‑level mount root. The member is named `externalStorage`, not `storage`, because the shipped `ManagedCsiBoot.storage` already carries provider‑specific fields (`physicalKey`, `registrationRevision`, `driver`): reusing the name would put two incompatible definitions of one key in the same envelope family. `storageRef` is the canonical‑JSON sha256 of the registered `ExternalStorageIdentity` (§3 digest discipline) and `mountNonce` is an opaque control‑plane value, so **this document** names neither `physicalKey` nor a provider ID — the phase‑1 rule against provider‑specific boot fields holds for it, and the CSI document’s own provider fields are untouched. Revision drift is committed inside `storageRef`, so a re‑registration changes the only storage identifier this worker ever sees.
- Binding proof, which the worker must complete before it serves anything (invariant: never mount a tree other than the one the Broker bound):
  1. Path properties: absolute, normalized, within its permitted root, `0700`, owner‑only writable.
  2. Materialized by the control plane, not created by the worker: the control plane creates the mount root and writes the binding marker to a **control‑plane‑only sibling path outside the containment root** — `<aliasPath>/../.qwen-storage/<alias>.json` (`0600`, worker uid, never group‑or‑other writable) — never inside the tree the session’s file tools and shell can reach. The containments in §5 root at the mount root, so the marker is not writable or deletable through `write_file`/`edit`/`run_shell_command`: the tenant workload owns the tree, not its parent. The worker never creates a mount root, so the earlier "exists or is creatable" shortcut is replaced: an absent or empty directory is refused, never repaired.
  3. Marker match: the marker's `storageRef` and `mountNonce` must equal the boot assertion, which travels inside the existing closed, token‑signed boot envelope. A stale boot document replayed against a later materialization fails on the freshly issued `mountNonce`, and a foreign or empty directory has no marker to present.
  4. Receipt: the worker records the mount root's device and inode and returns `{storageRef, mountNonce, mountRoot, rootDevice, rootInode}` with its publication endpoints. Those coordinates corroborate the binding; the marker remains the proof.
  5. No fallback: any failed check refuses the boot closed before the publication service starts or a tool call is served, and never degrades to a local directory or to an unmaterialized alias path. A marker that is missing or does not match on a **rotated** worker refuses this boot and asks the control plane to re‑materialize the marker; it is not the operator‑gated re‑registration conflict below, and it does not brick the alias.
- The Broker re‑reads `storageRef`/`mountNonce` from the registration record — the control plane minted the nonce when it materialized the tree — and compares them with the boot receipt and with `storage:observe` before reporting `READY` or claiming writes; the receipt's `rootDevice`/`rootInode` are stored with the binding so a later re‑attestation or `storage:observe` can show it is still the same materialization. A receipt that disagrees with the **registration record** is a hard conflict for operator re‑registration, never a retry against another root and never a replacement worker; a marker-only mismatch after rotation is the re‑materialization case above.
- The worker runs a small publication service (`/internal/managed-runtime/v2/publication:*`) for foreground shell capture (§7) once v2 boot succeeds. It registers its publication endpoints in the boot receipt; the Broker learns the reachability from `observe` (which now runs a publication readiness probe before reporting `READY` for this profile).
- The sessions' `isolationClass: session` already pins 1 worker/session; dynamic aliases activate the storage context in this worker only.

The worker is trusted code in the closed boot path: these checks refuse a missing, foreign or empty root, and they do not make a compromised worker honest — worker identity stays the phase‑1 attestation's job.

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
3. Launch worker with a `managed-runtime-boot/2` document; publication readiness probed over ingress pre‑READY.
4. Extend TTL handling: adapters surface sandbox `remaining_seconds` in observe; central close calls `stopDrained` first on expired experiments for evidence hygiene.

The upstream never learns the word Aone for these APIs; auth/token/wire shape stays phase‑1.

## 10. Verification matrix

| Layer                     | Required witness                                                                                                                                                                                                     | Established by                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Storage registration unit | register/reject conflicting alias/tenant/revision; precommit folder; renewal identity                                                                                                                                | new guard/store/resolver unit suites            |
| Worker admission unit     | `managed-runtime-boot/2` accepted while shipped boot‑v2 documents still parse; marker outside the containment root neither writable nor deletable through a tool call; missing, foreign or mismatched marker refused | CLI container tests                             |
| Publication/capture       | begin/read/receipt semantics; byte bound; stale lease refusal                                                                                                                                                        | worker unit suites                              |
| stopDrained proof         | drained/undrained/unknown and close gating                                                                                                                                                                           | worker+Broker IT                                |
| Broker + real worker      | storage over Aone: register → place → attest → write/read/edit/shell foreground → close with drain                                                                                                                   | full‑tier fault suite (extends phase‑1 fixture) |
| Public Hosted E2E         | Session workflow with visible tools; approval cards reconstruct captured input; restartBroker + restartAdapter preserve storage lineage                                                                              | full Public Hosted validation                   |

## 11. Sequencing

1. Guard/store/resolver extension and registration REST, no wiring (compat‑only).
2. CLI `managed-runtime-boot/2` container admission and publication service (no consumers yet, and shipped boot‑v2 parsing untouched — inert in that sense).
3. Provider profile `external-workspace` with `storage:*` (adapter and provisioner), low‑visibility activation.
4. stopDrained + close gating; then turn tools on with the Hosted profile only under explicit flag.
5. Public Hosted E2E in full‑tier CI; only at this point documents the profile as deployable for Hosted tools.

Each step is independently revertible. The phase‑1 contract and its fault‑gate evidence stay as the base — this design adds semantics only.

## 12. Implemented step 3a: the provisioning prerequisite

The first slice of step 3 landed as a Broker/adapter prerequisite, not as the product
feature. It adds the `external-workspace` provisioner kind and nothing a user can reach
yet:

- **Kind and transport.** `ExternalWorkspaceProvisioner` extends the shipped
  `external-scratch` provisioner, so placement, durable handle, idempotency by
  `provisionRequestId`, startup recovery, attestation and no-op `release` are the same
  code paths rather than a copy. `ExternalRuntimeKinds` names the family once; the
  configuration validator, the provisioner factory, the preflight broker check and the
  retry/recovery classification all use it, so the new kind cannot silently fall into a
  zero-validation or permanent-recovery-block branch.
- **Storage identity comes only from the durable registration.** `ExternalStorageRegistry`
  is a read-only view over `ma_storage`/`ma_storage_owner`; the provisioner resolves
  `(tenant, alias)` on every admission and refuses with permanent codes
  (`external_storage_registration_not_found`, `external_storage_registration_mismatch`,
  `external_storage_continuity_denied`). Provider identity, physical key, revision, alias
  path and mount root are compared against the registration, never against the request or
  the provider reply. The lookup uses the registration's primary key (the same alias key
  the write path inserts), joins the owner row on the owner's primary key, admits only a
  `REGISTERED` row — a `RETIRING` or `RETIRED` row resolves as no registration — and
  bounds the revision to 2^53-1, the largest integer both sides of the wire represent
  exactly. `storageRef` is the canonical-JSON SHA-256 of that identity tuple, and a
  revision bump makes an existing handle unadoptable instead of silently re-binding it.
  A lookup that cannot be read to completion is retryable (`runtime_external_unavailable`)
  so the Broker keeps the placement adoptable; a row that was read but disagrees with
  itself is a permanent refusal.
- **The boot document is unchanged.** The Broker mints the shipped `managed-context/1`
  document and adds the already-admitted `storage` member
  (`kind/physicalKey/aliasPath/mountRoot/registrationRevision`), which the shipped worker
  admits under `session` isolation and the Workspace capability digest. This slice
  therefore makes **no** CLI or worker change and does not supersede
  `2026-10-25-external-container-publication.md`: the `storage` extension and the adapter
  written `registration.json` descriptor keep their meaning, and the worker still creates
  a missing mount root as `0700`.
- **Optional storage evidence.** A provider may report
  `storage: {storageRef, mountRoot, continuity}` on `RUNNING`. `confirms` is adopted,
  `unknown` keeps ownership but loses readiness, `denies` is a permanent refusal, and
  absent evidence keeps the phase-1 meaning because this slice authorizes no writes.

Deliberately **not** in this slice: Hosted tool profiles and EXTERNAL execution admission
(§5), foreground shell publication consumption (§7), `stopDrained` (§8) and close gating.
`supportsDrainedStop()` therefore stays `false`, a Session placed here could not be
closed, and the configuration validator still refuses every managed Workspace feature for
both external kinds. The provisioner is therefore **configurable, but no Session can be
placed yet, and every placement fails closed**: the profile is opt-in through
configuration, preflight reports a prerequisite warning saying exactly that, and only
component and contract tests drive a placement.

**#15512 is not complete.** Files execution (`read_file`/`write_file`/`edit`/`glob`),
foreground shell, approval, capture, and a verified close/drain remain unimplemented; the
profile is not deployable for Hosted tools until those land and are verified.

Recorded deviations from §6, for the follow-up slices: no new
`managed-runtime-boot/2` document, no reversal of mount-root ownership, and no
`rootDevice`/`rootInode` receipt. Those are worker-contract changes, and the shipped
`storage` contract is already a published adapter surface; a repository with no producer
of a document is not evidence that no consumer exists.
