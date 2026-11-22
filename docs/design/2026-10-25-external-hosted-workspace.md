# External Hosted Workspace Runtime (phase 2)

[English](2026-10-25-external-hosted-workspace.md) | [简体中文](2026-10-25-external-hosted-workspace.zh-CN.md)

Status: **A / step 3a / B0 / B1 / B2 implemented for the exact public external-files profile; selected files/default-approval/safe-close E2E passed. C's worker profile/capture routes and control-plane publication producer are implemented and partly verified locally (§15); the Broker dispatch/close wiring and control-plane profile selection land in the follow-up half, so the lane is not selectable end to end. #15512 is not complete.** §14 records the files milestone and remaining gates; §15 records slice C's implemented boundary and its deviation from §6. Builds on [phase 1](2026-10-23-external-runtime-provider.md) (`external-scratch`, accepted contract) and the earlier Aone operator-adapter rehearsal; that rehearsal is not evidence for this milestone. Nothing here weakens `external-scratch` invariants: deterministic logical handle before the first remote call, no replacement after a lost reply, no release-to-kill, Broker-side independent attestation, provider deduplication by `provisionRequestId`.

**Reading order:** the A amendment and §§12–13 retain their historical slice boundaries, not current blanket admission refusals. §§1–11 retain the wider phase-2 goals and proposals; where they differ, the implemented contracts in §§12–15 take precedence. In particular, the new boot document and nonce/marker changes are still proposals, not shipped behavior: §15 explains why slice C deliberately keeps the shipped boot contract.

## Amendment: bounded slice A (2026-10-27)

This standalone increment uses the existing external storage registration on main; it does not depend on #15654 or copy its registry/provisioner. `POST /internal/managed-workspaces/v1/workspace:materialize-external` materializes metadata for an existing `REGISTERED` `EXTERNAL` alias. Its closed, 16 KiB JSON body accepts only `registeredAliasId`, `displayName`, `ownerActorId`, `idempotencyKey`, and optional trace-only `requestId`. `registeredAliasId` is the registered `tenantWorkspaceId`, not a path or registration receipt ID.

The existing exact loopback listener/local-peer checks and Broker bearer credential authenticate the operator's authority to delegate a grant. The validated `ownerActorId` is the **grantee**, not the authenticated caller or evidence of tenant membership. The operator must choose the correct tenant and grantee; the validated tenant header scopes registration lookup, Workspace, grant and receipt keys. Public signature and trusted-actor filters are unchanged. A tenant header alone cannot invoke this route.

A fresh transaction takes the tenant placement-domain lock, checks the stored registration and owner agree on tenant, alias identity/keys, full provider/physical identity, revision and mount root, and refuses existing Workspaces, Runtime bindings, holders or maintenance. The registration JSON remains authoritative: alias-path validation uses the existing registration value rules; this is not detection of arbitrary out-of-band database tampering. The operation creates only `ma_workspace` (`workspaceId = storageId = tenantWorkspaceId`, generation 1, `ACTIVE`, `ROOT`, fixed `WorkspaceExecutionProfile.CONFIG_REF`/`POLICY_REF`, no default), one `OWNER` grant, and a completed `EXTERNAL_WORKSPACE` receipt atomically. Storage and its `UNVERIFIED` owner remain unchanged. No central filesystem, storage allocation, provider HTTP or worker operation occurs.

An exact retry returns the original receipt, even after grant revocation, rename or removal; it never restores a grant, name or active state. The receipt records the creation outcome, not live state or execution authority. Changing alias, display name or grantee under the same tenant/idempotency key conflicts. At the A-only checkpoint, discovery stayed readable to the grantee, but `canCreateSession` and WebShell `canSelectDirectory` were false for EXTERNAL storage, including batch-readable grants. Both empty and prompted Session creation were denied by the existing storage-kind guard. A included no resolver, transport, execution or tool-profile activation; §14 supersedes that admission limit for the exact files profile.

The distinct receipt namespace requires extending the existing enum and V1 CHECK. This follows the pre-release fresh-catalog policy: source reversion is independent, but does **not** promise an old binary can open the changed catalog. Recreate task/development catalogs; no V2 migration or schema-version bump is added.

Verification for A consists of operator/tenant/closed-body tests, exact receipt replay and no-resurrection tests, persisted tuple and busy-owner refusal, honest public/WebShell discovery and real Session-service denial, plus MySQL same-key/different-key concurrency. These tests are not evidence of external Hosted execution. At that checkpoint, full tools, drain/ACK safety, recovery and public worker E2E were later increments; §14 records the bounded progress since then. The older execution proposals below must be reconciled with the shipped boot/publication contracts before implementation; A neither implements nor endorses a second wire protocol.

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

The current profile is selected by `QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=external-workspace` with `workspaceFilesEnabled=true` and the closed configuration/negotiation gates in §14. Shell must remain disabled. The table describes the wider target, not the admitted tool set; `external-scratch` still refuses Workspace features.

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

> **Slice C deviation (option A).** §6 below is still a proposal, and slice C deliberately does **not** implement it: the external foreground-Shell profile ships on the **already published** `managed-context/1` boot document and its existing `storage` member, unchanged. The new `managed-runtime-boot/2` document, `storageRef`, `mountNonce`, the control-plane-only marker and the device/inode receipt remain a later slice. Consequences are stated honestly in §15: this slice inherits the shipped boot binding proof, and does **not** add the marker/nonce defence against a stale boot replayed onto a re-materialized tree. See §15 for what that costs and what still fences it.

The original proposal assumed the container boot path refused boot-v2 and proposed `ManagedRuntimeWorkerBoot` v2 admission with **storage-side checks**. This is not the implemented boot contract (see §12):

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

Foreground shell and `monitor` remain targets, not capabilities of §14's files milestone. Background shell execution (`is_background`) is a later phase with its own evidence story.

§15 implements the foreground half of this section and corrects one detail: the Broker is not a reader that also writes the control-plane publication. It is that publication's **producer**, and the two roles need different credentials — the worker holds none for the control plane. See §15.

## 8. Exact‑worker `stopDrained` and storage ownership fences

Automatic close/recovery requires proof the ORIGINAL worker can no longer write:

- The Broker asks the worker (lease/domain/revision headers) for `publication:stop-drained?channel=all`. A truthful answer takes one of three forms:
  - `drained` — durable read‑only surface verified write‑locked by the worker's own per‑channel receipts; Broker can close storage and retire the binding.
  - `undrained(channel seq)` — close must remain deferred; replay‑only reads are OK.
  - `unknown` — never close, never replace; the sandbox TTL may reclaim CPU but storage fences stay.
- A sandbox expiry/GONE is NOT a drain proof. A worker crash is NOT a drain proof. `release` continues to be a no‑op for this profile (phase‑1 rule — kill authority belongs to the storage's owner‑fenced stop path only).

The supervisor process writes task‑lifetime receipts inside the worker's private publication directory (path bounded, secrets never inside release payloads), so an adapter restart can re‑attest drain by re‑stating receipts, not by trusting a crash.

§15 implements this fence for the foreground-Shell profile and adds the one gate the files profile did not need: a Shell still in flight blocks the close before any of the three answers is consulted, because an unsettled execution cannot yet have produced its final receipt.

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

This section records the historical step-3a checkpoint, before B0–B2. It added the
`external-workspace` provisioner kind as a Broker/adapter prerequisite, not yet a
user-reachable product feature; its admission limits below are superseded by §14:

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

Deliberately **not** in step 3a: Hosted tool profiles and EXTERNAL execution admission
(§5), foreground shell publication consumption (§7), `stopDrained` (§8) and close gating.
At that checkpoint, `supportsDrainedStop()` was `false`, a Session placed here could not
be closed, and configuration refused every managed Workspace feature for both external
kinds. The provisioner was **configurable, but no Session could be placed, and every
placement failed closed**: preflight reported that prerequisite limit, and only
component and contract tests drove a placement. This is not the current §14 behavior.

**Historical step-3a verdict:** #15512 was not complete; files execution, foreground
shell, approval, capture and verified close/drain were unimplemented. Files, default
approval and selected safe-close E2E have since landed (§14), but full-goal acceptance
and deployment readiness remain pending.

Recorded deviations from §6, for the follow-up slices: no new
`managed-runtime-boot/2` document, no reversal of mount-root ownership, and no
`rootDevice`/`rootInode` receipt. Those are worker-contract changes, and the shipped
`storage` contract is already a published adapter surface; a repository with no producer
of a document is not evidence that no consumer exists.

## 13. B0 amendment: inert same-origin native drain

This section records the B0-only checkpoint: it supplied the drain primitive, not Hosted admission or complete close orchestration. Its inert boundary below is historical; B1/B2 connect it in §14. The following B0 decisions supersede the proposed separate-ingress and drain-proof assumptions in §§3, 6 and 8; §12 records the earlier step 3a scope.

- **One saved origin, existing routes.** External boot registers the existing publication object and executor on the main worker application and adds its routes to the owned-route gate. The separate publication listener and ready advertisement remain compatible; both listeners share retirement and channel state. Express registration escapes the literal colon in `publication:*` paths, preventing a parameterized route from matching a different operation. Wire paths do not change. The Broker uses the persisted `RuntimeLease.endpoint` for independent context attestation, then `POST /internal/managed-runtime/v2/publication:stop-drained` with exactly `{"protocolVersion":2,"channel":"all"}`. There is no second endpoint or port derivation.
- **Original identity before I/O.** The provisioner reuses base validation for the saved request, seed, credentials and canonical storage-bound handle, checks the current registration tuple and any retained endpoint, and requires `external-workspace`, managed context, session isolation and the exact Workspace capability digest. Missing or conflicting originals yield no receipt; a restarted adapter uses complete saved identity without allocation or provider observation. Transport rejects redirects and a substituted resolved origin before attestation. Stop sends Bearer, lease ID/epoch, `X-Qwen-Managed-Storage-Revision`, `X-Qwen-Managed-Runtime-Incarnation`, JSON and `Cache-Control: no-store`; the boot header values are fixed before attestation. Stop does not require a response-incarnation header, which publication does not emit. The stop envelope is bounded to 64 KiB, and deadline/cancellation closes the active HTTP exchange.
- **Narrow evidence, not proof retrieval.** Only HTTP 200 with JSON/no-store and exact `{protocolVersion:2,state:'drained',proof,receipts}` is accepted. Strict parsing rejects duplicate keys, trailing tokens, malformed UTF-8 and non-integer numeric tokens. The proof has exactly `resourceId/kind/schemaVersion/byteLength/digest`: a producer-shaped UUID, `external-publication`, integer `1`, positive integer length at most 64 MiB, and raw lowercase 64-hex SHA-256. Each receipt must carry channelId and a manifest reference of the same shape. Unknown or undrained states produce no receipt; nonempty channels on an undrained reply stays retryable. Malformed receipts or replies produce no receipt. The Broker trusts the authenticated worker's assertion after attestation; it does **not** fetch or hash the private proof bytes, claim atomic attest-and-stop, or resist a malicious clone behind a compromised trusted ingress. Same-origin routing must reach the original worker.
- **Retirement is not process exit.** Successful drain seals managed writer admission and retires execution resources; the HTTP process may remain alive. The native receipt uses the existing five-field binding/generation/provision-request/handle/time constructor, with Broker observation time as `stoppedAt`, no extension mode or scope. Binding-state and operation-claim authority belong to the Broker calling chain, not duplicated provisioner predicates; the primitive requires the drain request and validated original identity.
- **Inert at the B0-only checkpoint (superseded by §14).** Per-binding `supportsDrainedStop(binding)` could recognize a valid original, but no-argument `supportsDrainedStop()` stayed false. The SQL-backed `WorkspaceExecutionStore.canStopDrained` guard still refused EXTERNAL. ACK replay, receipt-before-owner-release orchestration and EXTERNAL execution ownership were follow-up work. No public tools, Hosted profile or admission switch was enabled, and `release` remained a no-op. #15512 was not complete.

Focused mechanism checks cover shared listener state and literal routes; original headers and success without a response-incarnation echo; identity/registration rejection; strict malformed and bounded replies; redirect sinks receiving no request; active-socket cancellation/deadline; and restart from saved identity without allocation. Those B0 checks alone did not establish public Hosted execution, SQL owner release or a real-provider end-to-end close. §14 adds the selected public-files evidence, not real-provider or full-goal acceptance.

## 14. Public external-files milestone: A / B0 / B1 / B2

### Implemented boundary

A materializes metadata/grants; step 3a supplies registered placement; B0 supplies original-worker native drain; B1 connects lifecycle close and SQL ownership; B2 enables public files/default approval. The exact profile is `hosted-workspace-external-files/1`, with `read_file`, `write_file`, `edit` and `glob`, plus a content-only `skill` tool on a Turn whose Session pins a skill catalog. Public discovery and Session creation now admit that profile when its gates pass, rather than rejecting every EXTERNAL placement.

Admission requires the selected `external-workspace` kind, `workspaceFilesEnabled=true`, enabled Harness/session store/Broker, valid external-provider configuration, session isolation without create-warm, and the negotiated feature token `hosted-workspace-external-files/1` with lifecycle protocol `1` and supported Workspace close. Registration, provider and root binding must still match. Configuration eligibility alone is not negotiated readiness or worker proof. The selected E2E used `default` approval; it does not certify every approval mode.

The options stay closed: no shell, `monitor`, capture, hooks/extensions, MCP, child agents/workspaces/snapshots, plan mode, rewind or input attachments. Session skills are the one lane this milestone admits: creation carries the caller catalog into the immutable receipt, the Session's pinned catalog is published as a resource reference, and a Turn with one declares the `skill` tool, which only injects the pinned content and writes nothing to the Workspace. Local mounts/import, SSH and verified/operator/trusted-local-reboot recovery switches remain disabled. This is not the full Hosted tool profile. See [configuration](../../packages/managed-agent-server/server/src/main/java/com/alibaba/qwen/code/managedagent/config/ManagedAgentProperties.java), [admission](../../packages/managed-agent-server/contracts/src/main/java/com/alibaba/qwen/code/managedagent/repository/ManagedWorkspaceRegistry.java) and [closed Harness options](../../packages/cli/src/serve/hosted-workspace-profiles.ts).

### Close and ownership

Lifecycle protocol `1` can legitimately persist `storeSynthesized=true` with empty `effects`: the store derives the receipt from the idle journal and verified committed `definitionRef` under this no-hooks profile. This is **not** a Harness wire-settle response and is **not** native drain proof. The close chain separately detaches the Harness, requires no live journal writer, and drains the original binding/generation/handle through B0 before releasing physical ownership.

The SQL physical holder survives tool completion and Runtime member/mount release; it is not a per-tool lock. Member execution claims can be released/reclaimed without freeing that holder. Only the original-generation stopped-release checks and durable drain receipt permit clearing its runtime holder fields. Storage metadata and grants remain. Retirement need not terminate the worker process, and provider `release` remains a no-op. See [lifecycle orchestration](../../packages/managed-agent-server/control-plane/src/main/java/com/alibaba/qwen/code/managedagent/session/SessionLifecycleCoordinator.java), [journal receipt](../../packages/managed-agent-server/contracts/src/main/java/com/alibaba/qwen/code/managedagent/repository/WorkspaceLifecycleStore.java) and [SQL ownership](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/runtimebroker/persistence/JdbcExternalWorkspaceOwnership.java).

### Observed acceptance and provenance

On remote191, the selected public files/close E2E (`ExternalPublicFilesE2E`, carried by the step-5 full-tier E2E PR, not this branch) completed **1 test, 0 failures, 0 errors, 0 skipped**, including final summary and cleanup. It used real Spring public APIs, isolated MySQL 8.4.13, built Hosted Harness, external Runtime worker, filesystem and journal; the allocator and OpenAI model were controlled local fixtures, **not a cloud-provider or real-model acceptance run**.

Observed: authorized/idempotent registration and materialization; owner-only discovery; four real tools in order write → read → edit → glob; two approved Actions, five model requests and one allocation; untouched decoy root; terminal public events, Items/tool details and verified same-session history resources. Close reached Session `CLOSED` / binding `RELEASED`, cleared holder runtime fields, retained metadata/grants/history and left no live writer. The original native drain receipt persisted; main/legacy stop endpoints agreed. Authenticated late writes returned `409` without creating a file; late public input and idempotent close added no effects or allocation. The original worker stayed alive until cleanup.

The retained evidence packet matched all 47 recorded runtime source hashes to checkpoint `dd5c2d2fb2e2665dd593b27fffa50e2cf4dc510d` and verified the artifact manifest before/after execution; copied Core commit metadata was separately disclosed. This establishes the selected scenario through source/artifact provenance, **not that every checkpoint test or latest full CI is certified**. Earlier failed attempts remain evidence, not erased by this pass.

### Changes after the recorded checkpoint

The acceptance packet above is historical evidence for `dd5c2d2fb2e2665dd593b27fffa50e2cf4dc510d`; #15685 was integrated as `0f7b8c006d77527a3a4555caf8d8ec41e998ffca`. Later repairs moved Agent pin validation before Workspace resolution and permitted a legitimately claimed LOST binding to retain its state until stop proof commits. Subsequent review repairs also change registration error handling and execution eligibility checks. These changes are **outside that recorded end-to-end run**. Focused regression tests are separate evidence, not a replay of the public-files/close acceptance on the latest head.

### Remaining goal and gates

**C is partly implemented and partly verified:** the worker-side external-Shell profile and capture routes, and the control-plane publication producer with its HTTP transport, have a local implementation (§15). The Broker dispatch/cancel/reconcile/close wiring and the control-plane Session profile selection are the follow-up half ([17357 B/2], #17474); until it lands no Session can select the profile through the control plane, which is also why no runtime flag gates it yet. Local verification covers the worker capture protocol over real HTTP and the producer's publication writes against the real control-plane stores on H2; see §15 "Locally verified so far" for the exact list. `monitor` and background Shell are **not** implemented; `monitor` was in the initial §1 goal and remains a target, not a silently dropped requirement. True `LOST` recovery, Broker/adapter process-restart recovery, real concurrent ownership/recovery scenarios and real-provider acceptance remain open work, not completed or verified by this run. Full CI/fault suites, human review and acceptance/deployment gates remain pending. UI verification is pending; no viewer or screenshot success is claimed here. This closes the documentation comparison of user impact against the goal, not #15512 or the full phase-2 goal.

## 15. Slice C: external foreground Shell (`hosted-workspace-external-shell/1`)

Status: **the worker profile/capture routes and the control-plane publication producer are implemented and verified by the local evidence listed under "Locally verified so far" at the end of this section. This PR targets `main`, so the main-filtered CI and managed-agent gates run on it. The Broker dispatch/close fences and the control-plane profile selection described below are the follow-up half (#17474); until it lands, no Session can select this profile through the control plane.** Everything below describes the code as written across the two halves, plus the local test observations explicitly enumerated there.

### Boundary

A new, separate profile — `hosted-workspace-external-shell/1` — declares `read_file`, `write_file`, `edit`, `glob` and a **foreground-only** `run_shell_command`, plus a content-only `skill` tool on a Turn whose Session pins a skill catalog. It is never a reinterpretation of `hosted-workspace-external-files/1`: that profile keeps rejecting every Shell call, and the two are distinguished by their capability digests and never share a part/handle version.

Its capability is its own: `sha256("managed-workspace-execution/1;external-shell/1")`, derived from the canonical string exactly as the terminal capability is, and pinned as the same hex on both sides. Both external placements still mint resource-handle version **1** today; the Shell lane is distinguished by its capability digest, which the binding and every attestation compare exactly. A separate handle version (`EXTERNAL_SHELL_HANDLE_VERSION = 2`) is declared for the follow-up half to mint; nothing mints or accepts it yet.

Admission requires the `external-workspace` kind, session isolation, durable registered external storage (an ephemeral sandbox directory is refused: it cannot produce a drain proof), `captureBytes` explicitly reserved, and the negotiated feature token. There is no runtime flag for this lane yet: the Harness advertises the profile unconditionally, and the placement stays unreachable end to end because the control plane cannot select it until the follow-up half (#17474) registers it. `QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED` is the local `hosted-workspace-shell/1` switch and does not gate this profile.

Still closed on this profile: background Shell (`is_background`), `monitor`, `web_fetch`, hooks/extensions, MCP, child agents/workspaces/snapshots, teams, messages, session commands, plan mode, rewind, memory, automations and channels. The Harness refuses them at Session admission, the Broker refuses them again per dispatch, and the worker's own foreground-only ledger gate refuses them a third time. The three refusals are independent on purpose: any one of them alone keeps the placement honest. Session skills are the sole exception: a Turn that pins a skill catalog declares the same content-only `skill` tool the files profile declares, and the pinned catalog is served from the Session's definition reference.

`READY` remains a Broker-local predicate — `state == RUNNING`, continuity `confirms`, **and** a publication readiness probe that reaches the worker's own publication protocol under the exact lease, storage revision and incarnation. The wire still carries only `RUNNING`/`STARTING`/`UNKNOWN`/`GONE`. The probe names a channel that cannot exist, so the worker's closed-lane refusal is the positive answer; a transport or identity failure is absence of evidence, never evidence that the worker is gone. Continuity `denies` is a permanent refusal; `unknown` keeps ownership and drops readiness; `GONE` is neither adopted nor replaced; provider `release` stays a no-op.

### The Broker is the publication's producer

This is the shape §7 assumed but did not state, and it is the reason no grant is ever installed on this worker.

The external worker keeps its own capture store — it is a full `LocalShellResultCapture` over its private directory — and exposes it over `publication:begin`, `publication:read`, `publication:renew` and `publication:stop-drained`. It holds **no control-plane credential**. So the Broker takes the producer role:

1. **Before dispatch**, `publication:begin` opens a worker channel and returns its channel id. The grant's own horizon bounds that channel; the binding is already reserved, so its `captureId` is fixed and the worker adopts it rather than minting one. That horizon comes from the same locked read that verifies the dispatch grant, never a second unlocked one.
2. The Shell runs on the worker, which settles its own capture and final manifest locally.
3. **After the result, before the execution settles**, the Broker reads the worker's blocks and publishes them into the original publication as its producer: one control-plane segment per block, sealed per stream, then a rebuilt manifest and its pages, then `finish`.
4. Only then does it acknowledge the worker's sequences, **including each stream's empty EOF sequence**.
5. Only a fully acknowledged channel lets `stop-drained` answer `drained`.

Step 3 must precede the settle because the producer lane requires a live, non-draining binding and an unsettled execution; a retry after the settle could never publish those bytes. A failure anywhere leaves the channel unacknowledged, so the close keeps refusing instead of releasing storage whose bytes never arrived. The Harness-side result session, receipt chain and `ToolPublicationDataStore` are unchanged — the control plane's own `validateFinished` is what proves the rebuild faithful, comparing the manifest identity field by field against the reserved binding.

Three contract details this lane depends on, all easy to get wrong:

- **`captureId` is the reserved binding's token**, not a worker-chosen UUID. The control plane compares every finished manifest against it verbatim, and it must match `[a-z0-9_-]{1,128}`. The manifest's `invocationDigest` is likewise the binding's own **prefixed** `sha256:` wire digest; stripping the prefix would refuse every finished capture.
- **EOF is its own empty sequence.** `acknowledgedSequence` may equal the sequence being read (that is how the last one is acknowledged) but never exceed it, so an EOF that coincided with a data block could never be acknowledged and every drain would report `undrained`.
- **The channel horizon is renewable, the captured input is not.** The grant's horizon is `min(writer lease, activation)`, which the Harness renews, while a foreground Shell may run for up to 600 s — far longer than one lease. Each dispatch renewal therefore re-verifies the grant and pushes its current horizon on `publication:renew`, which only ever moves the horizon forward. A channel frozen at its opening horizon would close mid-command and no drain could ever complete; a renewal refusal is not claim loss, because the drain re-reads the channel and refuses honestly if it really closed. `publication:begin` stays idempotent on the captured input alone, so a recovered dispatch may offer its own current horizon.

Two different bounds apply, and the binding's reservation is the tighter one. The publication reserves `captureBytes` for the whole execution, and the control-plane store refuses the first segment beyond it; that is the budget this lane actually has. Segment and page counts are structural ceilings on top of it — 1024 segments per page and 64 pages per stream. A capture that exceeds either refuses the drain rather than silently truncating, and the close then keeps refusing too.

### Close and recovery

The §8 fence now also runs before the three answers: a Shell execution still in flight, a `LOST` binding, or a proven absence all refuse the close when no drain receipt exists — an unsettled execution cannot have produced its final receipt, and neither an expired sandbox nor a crashed worker proves the captured bytes arrived. Recovery of the original worker is the only exit. A recovered dispatch re-runs `begin`, which is idempotent per execution, so it gets the same channel and can still move the bytes before settling.

A failed drain leaves the execution `UNKNOWN`, and on this lane that state must not be settled from the worker's status. The worker's own settled envelope names its **local** manifest, so absorbing it would settle a result whose bytes never reached the control plane and let the close release storage. Reconciliation therefore refuses while the original publication is unfinished; only a finished publication (the drain's own outcome) or a recovered dispatch that completes the drain may settle the execution.

That one rule has to hold on **every** arm that can settle this lane, not just reconciliation:

- **The settle carries the published envelope, not the worker's.** Once the drain finishes, the execution settles with the control plane's own `/finished` result — the rebuilt manifest over the bytes actually moved. The worker's envelope names its private manifest ref, and the Harness compares the settled result against `/finished` verbatim, so settling the worker's copy would refuse every completed call.
- **Cancel is physical, never a settle.** A cancel always reaches the worker, but its answer may not settle this lane while the publication is unfinished — a cancelled process may still have written output before the abort. The record keeps its claim and the dispatcher's move is what finishes the turn, exactly as for an uncancelled call. If the drain finished between the cancel and its answer, the settle uses the durable envelope rather than the worker's copy, for the same reason as above.
- **The worker's proof of no start owes no drain.** A `not_started` answer with no capture is the one exception, on both the cancel and the reconciliation arm. No process ran, so no channel holds bytes and no publication will ever finish; fencing that answer would strand the record with no exit at all, because a dispatch refuses an `UNKNOWN` row and the close refuses an unsettled one. A **started** call is never exempt, whatever its capture status — only the drain's own finished publication proves those bytes arrived. The reconciliation arm reads this from the same status answer it settles with, so the exemption costs no extra worker call.
- **A finished publication settles without the worker.** When the drain already finished but its settle did not land, reconciliation settles from that durable envelope directly instead of asking the worker for a status. That arm runs precisely when the original worker may be gone, and the worker's answer could only name its own local manifest anyway.
- **A started call with an incomplete capture refuses instead of settling.** `finish` admits only a complete capture, so no retry can ever publish those bytes. Settling it would leave the worker reporting `capture_incomplete` for ever while the settled row let the close reach a stop it can never prove; refusing keeps the execution recoverable.
- **A recovered dispatch whose drain already finished does not move again.** Publishing over a `FINISHED` lane would refuse, so the durable envelope already is the outcome and the settle simply lands.

The worker's status is also this lane's only result path for a long command: it publishes nothing itself, so a foreground Shell that outlives the execute call's own request timeout arrives through the result poll and is then moved like any other result.

### What option A costs

Keeping the published boot contract means slice C inherits the shipped binding proof and does **not** add §6's `storageRef`/`mountNonce` marker defence against a stale boot document replayed onto a re-materialized tree. What still fences that case is unchanged from the files milestone: the full `ExternalStorageIdentity` tuple (provider id, physical key, registration revision) read from the durable registration record, the exact handle version, the Broker's independent attestation before every publication exchange, and the SQL physical holder. Closing the marker gap is later work, not something this slice claims.

### Not done

Background Shell and `monitor` are out of this slice and remain #15512 goals, not silently dropped requirements. §6's boot-v2 document, marker and nonce are not implemented.

Locally verified so far:

- The worker half of the capture protocol **against a real worker process over HTTP**, driven through the real attesting transport: `begin` idempotent per execution, every block read and acknowledged through its own empty EOF, an empty stderr still bounded by its EOF, a multi-block capture neither lost nor reordered (including a multi-byte character straddling a block boundary), `renew` moving the horizon only forward and outliving the original lease, the drained stop — validated by the transport's own closed-body check — refusing an unacknowledged EOF, `pending` never read as an empty block or advancing a cursor, and a foreign lease or stale incarnation never reaching the capture.
- The producer end to end **against the real control-plane publication stores on H2** with the full reservation chain committed: a worker capture becomes a finished, read-back publication whose rebuilt manifest the store's own `validateFinished` proves faithful; multi-block captures publish segment by segment; a renewed grant extends the same channel; a failed exit code is published as the result's own outcome; an incomplete capture is refused before any block is moved; a capture beyond its reserved bytes refuses instead of publishing a short stream; a vanished worker or foreign lease never finishes a publication.

The dispatch/cancel/reconciliation fences and the close/recovery arms described above belong to the follow-up half (#17474) and are verified there, not by this PR's suites.

Still unrun: SpotBugs, real concurrent ownership on MySQL, and the full `mysql-integration` and Hosted/fault profiles (CI owns those). The worker stand-in implements the shipped worker's channel rules, but it is not the shipped worker: the two halves have not been run against each other in one process tree. Real-provider acceptance, UI verification, human review and deployment gates are all pending. This section records an implementation boundary and the evidence above, not full acceptance.
