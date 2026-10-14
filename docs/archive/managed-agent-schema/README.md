# Archived Managed Agent database migrations

[中文版](README.zh-CN.md)

These files describe the retired 63-table database at source commit `18f80f56666a347a2b67b2ef98099cc58356b253`. They are historical references and are outside the runtime and test classpaths. The archived Java migrations and upgrade witnesses are not executed by the new environment.

The only active baseline is [`V1__managed_schema.sql`](../../../packages/sdk-java/runtime-broker/src/main/resources/db/managed-schema/V1__managed_schema.sql). Managed Server and Runtime Broker consume that same versioned resource and require an empty database or a structurally verified complete 32-table baseline. A legacy, partial, foreign, or history-only catalog is rejected before initialization writes. Reinitialization validates the catalog; it does not backfill or repair it.

There is no old-data migration or in-place upgrade. Keep the old environment and database for historical reads, stop its new admissions and settle in-flight work before cutover, and create new Sessions only in the new environment. A rollback after new data exists must preserve and serve those records from the new database.

The archived tests preserve the retired migration algorithm's evidence. Active replacements verify fresh initialization, immutable existing rows, typed variant columns, Hook uniqueness and indexed admission, and rejection of old catalogs. The duplicated Broker `schema.sql` was removed rather than retained as another schema authority.
