# K2 canonical schema port

[English](k2-canonical-schema-port.md) | [简体中文](k2-canonical-schema-port.zh-CN.md)

## Status and problem

Implementation and compatibility verification are in progress. This document
describes the K2 port to main's fresh canonical managed-agent schema. It does
not qualify application retirement, physical release, or safe volume reuse.

Main consolidates the legacy tables into 32 `ma_*` tables with 704 columns.
K2's old table names, row ownership rules, journal keys, and component snapshot
format cannot be retained through aliases. The fresh initializer rejects a
legacy database; the additive K2 migration provides no legacy backfill or compatibility view.

## Schema and row identity

Main's published V1 remains exactly 32 tables and 704 columns. V2 adds four
private CSI authority columns; K2 V3 adds eleven application progress columns,
`ma_csi_source` (19 columns), and `ma_csi_physical` (six columns), without
rewriting V1 or V2. The effective schema has 34 tables and 744 columns.
Application inventory covers 33 tables and 738 columns; the physical companion
is inspected separately. `ma_session.csi_guard` is generated from the private
tool profile or the durable runtime request pin.

Native resource read evidence uses the existing `ma_request_receipt`, namespace
`SESSION_COMMAND`, operation `CSI_RESOURCE_READ`, and the actual
`key("csi-read", readId)` primary key. Its closed JSON has 23 admission fields
and 25 completion fields. Inventory checks the complete outer row, the initial
request digest, and the original resource/journal/writer association. OPEN and
UNKNOWN receipts block application retirement. There is no separate native
read table or synthesized compatibility row.

Identities use the canonical VARBINARY columns and strict UTF-8 decoding. Opaque
actor keys remain bytes. Hashes and primary keys follow the actual producer:
session scope is `ManagedSchemaKeys.key(tenant, session)`, resource identity is
`key(scope, resourceId)`, and the CSI retirement operation identity is
`key("CSI_RETIREMENT", tenant, retirementId)`. This last identity differs from
the generic operation-key helper used by output operations.

Retirement uses the real `ma_operation` row, with immutable request JSON and a
versioned result envelope. The decoder verifies the complete raw identity,
target, request digest, scope, kind, generation, and result data. Progress CAS
updates are scoped by the true operation key and kind. Journal resource refs
must match their actual owner kind, owner key, owner revision, resource key, and
raw identity tuple. Session-record refs keep their domain revision semantics.

## Inventory and history

Application inventory uses `qwen-csi-application-inventory/2`; the component
checkpoint snapshot uses `qwen-csi-retirement-inventory/2`. Version 1 is refused
because its table and ownership semantics differ. Readers and fixtures must
move together; changing a header alone is insufficient.

Both live inspection and retained history validate the canonical catalog on
the same JDBC Connection. They share the existing ten-second query budget,
4096-row bound, and 32 MiB whole-row bound. Historical owner lookup uses the
tenant and actual operation primary key. Repeated reads account for each
whole row once and reject changed duplicates.

Ownership is determined from actual parent and domain relationships. A row
that does not directly name the original session is not automatically an
unrelated row. Shared tenant guards, root workspace state, storage aliases,
and mode receipts have explicit context roles; strong references to the
original lineage are checked before assigning those roles. Unsupported
original activity blocks retirement. Expected images retain all row values
except the declared stage delta.

## Runtime and mutation boundaries

The port keeps main's producers for session birth, event streams, workspace
operations, captures, and resources. Native writer admission checks the
original CSI boundary before creating a session root or journal head.
Ordinary action, extension, dispatch, and output mutation paths retain their
private-session guards. Collection excludes private sessions before paging and
checks their stored target again under the claim transaction.

Native resource reads, authorization, terminal commit, and original runtime
session completion use canonical tables and keys. Application progress stays
SETTLING/1, FROZEN/2, CUT/3, and DRAINED/4. Physical RELEASED is a separate
milestone and cannot be inferred from DRAINED.

## Affected components and validation

The affected components are the runtime-broker canonical schema and JDBC
repositories, managed-agent stores and inventory/image/history readers, and
TypeScript checkpoint consumers. Tests must initialize the fresh schema and
create rows through actual producers where possible. Fault injection must
observe the current SQL boundary rather than an obsolete statement spelling.

Acceptance requires schema agreement through both initialization paths,
ordinary behavior regressions, private backlog isolation, native and
checkpoint contract checks, exact application images and rollback/retry
behavior, synchronized readers, build/typecheck, and two clean full-diff
self-audits. Pure H2/data checks do not establish Linux, CSI, or node-source
qualification. Restricted acceptance remains recorded as incomplete.

## Scope and remaining work

This port does not install a collector or create paid nodes. Source installation
and confinement qualification, atomic physical release, retained old
credential validation, monotonic safe reuse, and public selection remain
separate K2 work. Passive ownership support for remaining canonical artifact and secondary domains is still incomplete; unknown rows remain blocked. Public selection stays closed until those prerequisites
have passed their required checks.
