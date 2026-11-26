# Settle historical external bindings

[English](2026-11-21-external-binding-settlement.md) | [简体中文](2026-11-21-external-binding-settlement.zh-CN.md)

## Problem and scope

Historical EPHEMERAL bindings can block placement after their platform resource terminated or their original request was rejected before allocation. Current executable profile admission cannot reconstruct historical boot bytes. This change settles original bindings; it does not admit historical profiles for execution or replace live Workers.

## Decisions

Terminal retirement validates the saved provider, seed, request and handle identity structurally. The trusted host must independently reobserve the exact original allocation as terminated. Existing workspace-wide idle, ownership, version, slot and storage fences remain in place.

Never-allocated cancellation is separate. Under the same allocation mutex the host persists an immutable REJECTED cancellation tombstone for the exact original request. Every later allocation checks that tombstone before contacting the platform. An existing allocation receipt, including an unknown result, prevents cancellation.

MAS accepts a trusted cancellation verifier, not client evidence. It checks OWNER, registered EPHEMERAL storage, exact workspace and binding generations/version, PROVISIONING or RECOVERY_BLOCKED state, no lease, no attestation, no live binding operation, no runtime-session/tool history and no storage holder owned by this binding. It releases only the original binding and its exact slot. A newer binding/slot, foreign holder, workspace state and business sessions remain unchanged.

Both paths store immutable, distinct proof types in the existing WORKSPACE_RETIREMENT audit. Cancellation uses a version 2 plan and NEVER_ALLOCATED_AND_CANCELLED proof; it never fabricates a Sandbox or Terminated observation. No schema migration is needed. Host tombstone commit precedes MAS release; failure between commits safely leaves the request cancelled and supports retry.

## Risks and validation

Absence of a receipt is insufficient without a durable future-allocation fence. Unknown platform results refuse cancellation. Stale versions, wrong identities, active execution and wrong ownership refuse all native release writes. Executable profile admission remains unchanged.

Focused regressions cover historical terminal identity without executable admission, idempotent cancellation, stale/invalid proofs, execution/attestation refusal and preservation of a different READY binding. Host integration verification must demonstrate that cancellation is durable before native release, delayed allocation of the cancelled request is refused, the original binding reaches RELEASED, and unrelated READY bindings remain unchanged. A subsequent Worker must reach actual READY; accepting a creation request alone does not satisfy this check.

## Status

Implemented with focused retirement/cancellation and provider regression coverage. The 27 retirement/cancellation cases and 39 provider cases passed. Full repository verification remains a separate CI gate; these focused results do not claim complete suite coverage.
