# Managed Agent first-release contract cleanup

[English](2026-10-23-managed-first-release-contract.md) | [简体中文](2026-10-23-managed-first-release-contract.zh-CN.md)

## Status and scope

Implemented for local verification; release acceptance still requires the full CI
gates. Managed Agent has not had a formal release, so this
change supports fresh state and one matching Server, Broker, Harness, WebShell
and Managed SDK build. It does not migrate development databases or rewrite
recorded commands. Existing environments must keep their original artifacts and
state or start a separate fresh installation.

## Problem

The implementation retains adapters without production callers, old checkpoint
shapes, historical result backfills, mixed-version authorization paths and
multiple presentations of the same durable command. These branches complicate
the first supported contract without providing a required release guarantee.

## Decisions

Remove unused Runtime Provider wrappers while retaining the shared error and
Broker client consumers. Require a journal when opening a Session authority and
use the complete nullable checkpoint shape. MCP close requires a durable drain
receipt before releasing its original owner; a missing receipt never becomes
successful cleanup. Prompt digests use canonical wire bytes only.

Remove historical O3 backfill, permissive unstamped command receipts, old rename
states, deprecated forwarding classes and obsolete WebShell representations.
Current journal commits still atomically capture tool results. Preserve reader
leases, idempotency, writer generations and unknown-outcome reconciliation.

Public and WebShell Turn submit/cancel always expose their durable operation.
There is no admission-profile selection or deployment switch for hiding that
operation. Session creation and internal child responses keep their separate
response shapes. Session pagination uses one format bound to both archive state
and the normalized title query; the archive filter has one parameter name.

Consolidate the current schema into one first-release baseline. Until the first
formal Managed Agent release, update V1 in place without adding V2+ migrations or
incrementing the database schema version. Recreate development catalogs when the
baseline changes. Both Server and
Broker validate the same final columns, indexes and constraints. Keep support for
Broker-first initialization, and refuse foreign, partial and system catalogs
before writes. Do not retain an upgrade path from earlier development baselines.

Publication authorization uses current activation head fields. Removing journal
fallback requires validating that current activation inputs fit those fields;
invalid or stale evidence must fail closed. Preserve original intent, expiry,
scope and writer checks.

## Boundaries

Ordinary daemon execution, unbound Sessions, file/Shell/MCP/CSI capabilities and
lifecycle protocols remain supported where they have current producers. Internal
child owner fallback remains until every current writer supplies an explicit
owner. Protocol numbers from distinct namespaces are not interchangeable.
No user database, active service or stored Session is modified by this change.

## Validation and acceptance

Run the root build and typecheck, focused Core/CLI/WebShell tests and Managed
API/OpenAPI consistency checks. Verify checkpoint round trips, current cold
recovery, MCP close crash windows, replay authorization, canonical digest bytes,
durable cancellation after response loss and pagination filter isolation.

Validate fresh schema initialization and restart with both startup orders,
negative constraints and rejection of incompatible catalogs. Use real MySQL 8.4
for SQL behavior; H2 alone is insufficient. Local Java work shares the module's
ten-minute verification budget; full suites and Hosted/fault profiles remain CI
gates. Record unavailable or incomplete checks rather than claiming acceptance.

Acceptance requires no production references to the removed adapters or legacy
success paths, complete current-format consumers, preserved recovery/ownership
semantics and passing affected checks. Review the complete diff twice after the
last repair. The execution report records actual results separately from this
design.
