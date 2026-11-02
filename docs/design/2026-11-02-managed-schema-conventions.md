# Managed schema conventions

[English](2026-11-02-managed-schema-conventions.md) | [简体中文](2026-11-02-managed-schema-conventions.zh-CN.md)

## Scope

Align the shared pre-release V1 database baseline with the MySQL conventions in
Alibaba's Java Development Manual (Huangshan edition). Server and Broker must
continue to initialize and validate the same catalog on MySQL 8.4 and H2.
Physical deletion and retention policies are outside this change.

Reference: the MySQL chapter, printed pages 32–35, in the
[official Huangshan manual](<https://github.com/alibaba/p3c/blob/6c59c8c36ecd8722c712d5685b8c3822c1c8b030/Java开发手册(黄山版).pdf>).

## Decisions

- Give every table an unsigned auto-increment `id` primary key. Preserve each
  previous business primary key as a unique constraint. Business
  identities, tenant scoping, idempotency, and fencing continue to use those keys.
- Keep the existing `gmt_create` and `gmt_modified` names and all
  epoch-millisecond timestamp fields. Application clocks, lease deadlines, and
  ordered pagination depend on the current timestamp contracts.
  Do not add duplicate timestamps. Database row IDs are excluded from domain
  projections and CSI evidence.
- Use `is_` names and unsigned tiny integers for boolean columns. Keep nullable
  flags nullable and generated flags generated. Update SQL consumers and boolean
  row decoding together; serialized API and journal payload names stay intact.
  Range checks retain the 0/1 domain on both engines without H2's connection-bound
  optimization of constant `IN` lists.
- Use unsigned integer declarations for nonnegative counters, versions,
  generations, sizes, and ordinals. Validate signedness for every integer type on
  MySQL. H2 ignores unsigned storage ranges, so native MySQL evidence remains
  required.
- Name ordinary indexes with `idx_` and unique constraints with `uk_`. MySQL
  always exposes the primary index as `PRIMARY`; the DDL gives its constraint a
  table-specific `pk_` name where supported.
- Remove database foreign keys. Existing application admission, ownership, and
  transaction checks continue to govern related writes. Preserve all former
  parent and child identity indexes and business uniqueness constraints.
- Store fixed-width SHA-256 strings in `CHAR`. Keep shared receipt and operation
  digest columns variable-width when their namespaces store different digest
  formats.
- Keep full indexes for short discriminator strings: their complete values are
  needed by covering and ordered queries, and shortening them loses information.
  Use a bounded prefix for the longer host identity lookup. MySQL executable
  comments express its prefix while H2 uses the full-column equivalent.

## Catalog validation

The canonical resource remains V1. Existing development catalogs must be
recreated; no repair, migration, or history rewrite is introduced. Validation
must reject missing row IDs, incorrect primary or business keys, missing
auto-increment behavior, changed integer types or signedness, and changed index
prefixes. It must continue rejecting legacy, partial, and foreign catalogs.

## Verification and acceptance

- Exercise Broker and Flyway initialization, repeated validation, row ID
  generation on fresh H2 and disposable MySQL 8.4 databases.
- Verify that duplicate business identities still fail, flags retain their
  values and nullability, and representative Server/Broker stores still read and
  write the renamed columns.
- Check snapshot/projection contracts, schema drift rejection, and relevant
  queue, publication, scheduling, Workspace and Runtime consumers.
- Run focused local Maven checks within the module's shared validation budget;
  report full-suite and native-process gaps for CI.

Acceptance remains pending until the checks above and the required CI gates
pass. Changing row layout, removing foreign keys, and updating CSI field names
requires a fresh development installation under the existing pre-release policy.
