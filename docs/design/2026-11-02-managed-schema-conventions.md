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

- Give every table an unsigned auto-increment, unique `id`. Use it as the primary
  key except on `ma_session` and `ma_tenant_guard`, which retain their original
  business primary keys `(tenant_id, session_id)` and `(tenant_key, guard_domain)`.
  These two tables coordinate existing records through upserts. With `id` as
  their clustered primary key, native MySQL captured `PRIMARY` supremum locks
  blocking unrelated Sessions, tenants and guard domains during acquisition.
  Keep their business clustering and a separate unique `id` index to preserve
  the existing creation and locking-read protocol. The other 36 tables keep `id`
  primary keys and unique business keys. Business identities, tenant scoping,
  idempotency, and fencing continue to use the original business keys.
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
  required. Retain the nonnegative CHECK constraints for H2. MySQL and MariaDB
  require `STRICT_TRANS_TABLES` or `STRICT_ALL_TABLES` in each connection's session
  `sql_mode` to reject ordinary out-of-range unsigned writes instead of clamping
  them; `IGNORE` writes can downgrade these errors to warnings.
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
Shared Server/Broker admission and validation refuse non-strict MySQL or MariaDB
sessions before schema writes. They accept non-strict global defaults because
the session mode controls writes. The embedded default Managed Agent pool adds
`STRICT_TRANS_TABLES` to every new physical MySQL or MariaDB connection, including
replacement connections, while preserving other session modes. This removes the
need for an embedded application to change a shared instance's global settings.
Standalone, maintenance and custom DataSource callers remain responsible for
initializing every connection with strict mode. Connections must retain it
throughout operation; a startup check does not police later mode changes. No
global SQL settings, schema objects or database versions change. MariaDB's
existing global and session CHECK-enforcement requirements remain in force.

## Verification and acceptance

- Exercise Broker and Flyway initialization, repeated validation, row ID
  generation on fresh H2 and disposable MySQL 8.4 databases.
- Independently verify all 38 generated IDs are unique, both coordination tables
  retain their ordered business primary keys, and the other 36 retain `id`
  primary keys. Native concurrency checks must preserve same-key exclusion,
  independent guard domains/tenants/Sessions, concurrent first creation,
  committed migration-fence visibility, SSH overlap arbitration, publication
  ordering and bounded lifecycle completion. Existing failures remain unresolved
  until the corrected revision passes the required native gates.
- Verify that duplicate business identities still fail, flags retain their
  values and nullability, and representative Server/Broker stores still read and
  write the renamed columns.
- Check snapshot/projection contracts, schema drift rejection, and relevant
  queue, publication, scheduling, Workspace and Runtime consumers.
- Reject non-strict session modes before initialization or validation, without
  querying global SQL defaults. Verify ordinary negative unsigned writes fail
  under both supported strict modes on MySQL.
- On a disposable MySQL 8.4 instance started with an empty global mode, verify
  simultaneous pooled connections and replacements after physical connection
  termination are strict, preserve other modes and leave global settings
  unchanged. Disable Connector/J automatic truncation handling in this test so
  only the pool initialization can supply strict mode. Verify H2 embedding and
  existing MariaDB CHECK-enforcement rejection remain intact.
- Run focused local Maven checks within the module's shared validation budget;
  report full-suite and native-process gaps for CI.

Acceptance remains pending until the checks above and the required CI gates
pass. Changing row layout, removing foreign keys, and updating CSI field names
requires a fresh development installation under the existing pre-release policy.
