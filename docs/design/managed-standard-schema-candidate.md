# Shared-catalog Managed schema handling

[English](managed-standard-schema-candidate.md) | [简体中文](managed-standard-schema-candidate.zh-CN.md)

## Discovery

`ManagedSchema.initialize` and `ManagedSchema.validate` discover only the Managed namespace.
Objects whose names are Managed stay visible to the exact expected-table comparison:

- every `ma_*` object;
- the fourteen legacy `managed_agent_*` names;
- the forty-nine explicit legacy names (`managed_*` and `qwen_*` generations), kept as a private
  catalog-discovery detail rather than a public contract;
- `flyway_schema_history`, handled separately as before.

Unrelated business tables, views and their data are not part of the comparison and are left
intact. Because the kept names are compared exactly against the thirty-nine target tables,
missing, unknown, legacy and view-backed Managed tables are rejected, as is a catalog whose only
Managed-related object is a `flyway_schema_history` table. Rejection happens before any DDL: no
table is created, migrated or repaired.

The sixty-three original inventory names map onto the target contract as thirty-nine targets
minus the five targets (`ma_extension_package`, `ma_extension_settings`, `ma_extension_operation`,
`ma_session_worktree`, `ma_session_principal`) that no original name evolves into.

The `managed_agent_*` prefix is what keeps those fourteen names in the comparison instead of
dropping them. Tolerating them the way R6-1 once did is rejected: those names were tolerated on a
validate-only API, discovery is now shared with `initialize`, and tolerating them would let a
legacy Managed catalog be silently re-created on top of its own tables.

## `initialize` on a business-only catalog

`initialize` used to create the target tables only in a dedicated catalog with no Managed objects.
It now also initializes a catalog that holds unrelated business tables but no Managed tables: the
thirty-nine target tables and their indexes are created next to the business tables. This is a
relaxation of the previous behavior and its consequence is explicit — running `initialize` against
a shared application database adds Managed tables and indexes to that database.

A catalog that already holds exactly the target tables still validates in place and `initialize`
on it stays a no-op. A catalog that holds Managed objects it cannot validate is still refused.

## No standalone shared-catalog validation API

The `ManagedSchema.validateSharedCatalog` API no longer exists. Discovery and validation are one
path through `initialize` and `validate`; there is no separate shared-catalog initializer.

Focused regression cases live in `ManagedSchemaTest`.
