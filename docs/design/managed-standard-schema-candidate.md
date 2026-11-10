# Explicit shared-catalog schema validation

[English](managed-standard-schema-candidate.md) | [简体中文](managed-standard-schema-candidate.zh-CN.md)

## Goal

Allow an embedding application to validate existing Managed Agent tables in a catalog that also contains unrelated business tables or views. This is an explicit library API; it does not change default startup behavior.

## Behavior

`ManagedSchema.validateSharedCatalog(DataSource)` and its `Connection` overload validate only the Managed namespace. All `ma_*` and legacy `managed_agent_*` objects remain visible to the exact expected-table comparison, so missing, unknown, legacy or view-backed Managed tables are rejected.

After selecting the namespace, validation reuses the existing column, generated-expression, primary/unique/index, CHECK, foreign-key and database-engine checks. Unrelated business objects and their data are left intact. The existing Flyway history-table handling and application-catalog checks remain in force.

The DataSource overload closes the connection it acquires; the Connection overload leaves the caller's connection open. Validation creates, migrates and repairs nothing. An empty or business-only catalog is rejected.

## Scope

The V1 SQL baseline, database constraints, physical keys, column names, locking, Session identity and HTTP authorization are unchanged. `initialize`, default `validate`, `schemaVersion` and CSI maintenance retain strict catalog validation. There is no shared-catalog initializer or configuration switch.

The PR retains its existing #16023 snapshot base. It does not copy the schema-conventions changes from #16143 or claim completion of a CHECK-to-Java migration.

## Acceptance

- Existing Managed tables plus unrelated business tables and views pass only the explicit shared validation; default validation and initialization still refuse that mixed catalog.
- Both overloads preserve business data and catalog objects.
- Missing/unknown Managed tables, legacy objects, Managed views and constraint drift are rejected by the same validators as dedicated catalogs.
- Empty and business-only catalogs remain unchanged after refusal.

Focused regression cases are included in `ManagedSchemaTest`. Local tests, builds and typechecks are not run for this scope reduction; runtime acceptance remains pending. Earlier validation reports belong to older revisions.
