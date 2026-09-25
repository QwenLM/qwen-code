# Managed Workspace Session Admission (W0b)

[English](2026-09-26-managed-workspace-admission.md) | [简体中文](2026-09-26-managed-workspace-admission.zh-CN.md)

Status: implementation in progress on top of the staged Spring control plane in [#12692](https://github.com/QwenLM/qwen-code/pull/12692). This slice depends on the W0a [Workspace binding contract](2026-09-25-managed-workspace-binding-contract.md). It does not enable bound Turn execution.

## Decision and boundary

The public and WebShell creation routes accept an explicit registered Workspace ID and an optional relative directory. Requests without a Workspace selection retain the existing unbound Session behavior; the internal creation API may resolve an omitted selection against the tenant default. This avoids silently moving legacy callers onto a new execution engine. An explicit `null`, malformed object, invalid directory, or Workspace ID with an unpaired Unicode surrogate is rejected before request digest or persistence. A selected Workspace requires a trusted Servlet principal implementing `AuthenticatedTenantActor`; the tenant header or request body cannot assert the actor. A non-empty initial input is rejected for bound creation until W0c can execute it safely.

The Registry is administrator-populated SQL, scoped by tenant and keyed by an exact Workspace ID. It stores the W0a generation, storage ID, display name, state, `configRef`, and `policyRef`; a separate grant table stores actor read/create permissions and a default table stores tenant defaults. There is no public Registry writer or caller-supplied host path. Resolution and insertion of the Session and creation receipt occur in one transaction. Explicit selection never falls back to the default; an unusable omitted default returns `workspace_required`.

## Persisted binding and retry

A bound Session stores W0a's seven-field `ContextBinding`: tenant ID, Workspace ID, generation, storage ID, normalized relative directory, frozen context configuration reference, and context revision 1. The binding digest is derived by W0a code, never accepted from a caller. At admission, `configRef` and `policyRef` are frozen in the Session row. Its `contextConfigRef` is the SHA-256 of their UTF-8 values separated by a NUL byte, prefixed with `sha256:`. W0a validation disallows NUL in either reference. Loading the Session checks that the stored pair still yields this reference. A future execution slice must resolve the frozen pair rather than current Registry values.

The creation command is keyed by tenant, authenticated actor bytes, and idempotency key. The request digest covers caller intent, including whether selection was omitted or explicit and the normalized directory; it does not cover the current default. A retry checks the original command before Registry resolution, verifies the current read grant, and returns the original Session and binding even if the default, generation, or state changed. A conflicting request digest returns `idempotency_conflict`.

## Access and execution gate

A current read grant is required for bound Session GET/list, events, items, transcript, and SSE. List filtering precedes pagination; SSE rechecks access before delivery. Without a read grant, direct requests return 404. Bound Turn submission/cancellation and Session lifecycle mutations remain unavailable, with no command written or Hosted Harness/Broker call. The Store rejects direct bound Turn and lifecycle writes; recovery fails any already-persisted bound Turn before calling the Hosted Harness, and the embedded Broker refuses to resolve a bound Session to its global Workspace. An actor without read access receives 404 even on those unavailable HTTP operations. Unbound legacy behavior remains unchanged.

This is an admission and read slice only. It does not install a context in a worker, verify a node mount, provide physical cross-Workspace isolation, or prove Runtime stop/unmount/handover. W0c must keep `cwdRelative` and `contextRevision` out of Workspace Runtime placement identity and must not remove the execution gate until those physical and protocol checks pass.

## Verification and remaining gates

H2 tests cover public admission, seven-field persistence and derived digest, original-binding retry after Registry changes, actor revocation, Store bypass prevention, and legacy behavior. Coordinator and Broker tests cover fail-closed recovery and global Runtime resolution. MySQL must verify exact-case tenant/actor/Workspace keys and a cross-JVM retry after the default changes. Build, typecheck, SQL migration checks, and open-ended diff review are required before review. The standalone Spring server does not provide a production trusted-actor adapter; real authenticated ingress and end-to-end bound execution are separate deployment gates. Java unit tests cannot satisfy them.
