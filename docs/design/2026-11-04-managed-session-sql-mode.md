# Managed Agent session SQL mode

[English](2026-11-04-managed-session-sql-mode.md) | [简体中文](2026-11-04-managed-session-sql-mode.zh-CN.md)

## Problem and scope

The upstream schema admission at `2f56b6b5ef3298782ff7de19730dbba9bda84274`
requires both global and session strict SQL mode. An embedded deployment with
its own catalog on a shared MySQL instance cannot change the global default
using its application account. SQL write behavior is controlled by the
connection's session mode. This private SNAPSHOT changes admission and the
embedded default Managed pool; standalone, maintenance and custom DataSource
lifecycle configuration remains caller-owned.

## Decision

Admission requires `STRICT_TRANS_TABLES` or `STRICT_ALL_TABLES` in the current
session. The embedded default Druid pool appends `STRICT_TRANS_TABLES` to the
inherited session modes through connection initialization SQL for every new
physical MySQL or MariaDB connection. It never changes global mode. H2 remains
unaffected. Callers that provide another DataSource must configure strict mode
on every connection. MariaDB global and session CHECK enforcement requirements
remain unchanged.

Catalog, column, key, CHECK, generated-column and foreign-key validation remains
unchanged. External database initialization remains disabled by the embedding
host. Strict mode prevents ordinary negative writes to unsigned counters from
silently clamping; applications must not disable it after admission. No bypass
switch or new database migration is introduced.

## Verification and delivery

Focused catalog tests refuse empty and misleading session modes without querying
global SQL defaults. A real MySQL test starts raw connections in non-strict mode
with Connector/J automatic truncation handling disabled, then verifies
simultaneous pooled connections and replacements after physical connection
termination. Every pooled connection preserves other modes and rejects negative
unsigned writes with error 1264 while preserving the old value. CI runs this
test on a disposable MySQL instance with an empty global mode and verifies it
stays unchanged. H2 embedding and Hosted isolation mocks remain covered.

Package the exact source as a separate private SNAPSHOT before host adoption.
Producer CI owns builds and the remaining native verification because this
task's local native validation budget is exhausted. A producer pass does not
prove preproduction startup or business acceptance. Deployment must use the
matching prebuilt 39-table catalog and a read-only schema check before the
declared preproduction single-turn acceptance.
