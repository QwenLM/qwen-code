# Managed Session query filters

[English](2026-10-22-managed-session-query.md) | [简体中文](2026-10-22-managed-session-query.zh-CN.md)

## Problem and scope

Issue #15077 needs server-side title search and archive filtering before pagination.
PR #15100 supplies WebShell archive views and export. This dependent slice adds the
missing public API filters and title query contract shared with the Java provider.
An independent title-search input uses this contract; the existing navigation
search continues to match Session IDs and Workspace names. Runtime/UI acceptance
remains separate from the implemented input.

## Contract and decisions

Public list accepts `archive_state=all|unarchived|archived` and `title_query`.
WebShell query accepts `archiveState` and `titleQuery`. Omitted archive filters
preserve the current `all` default. Public `include_archived=true` aliases `all`;
`false` aliases `unarchived`. Conflicting explicit filters return 400.

Title search is a case-insensitive literal substring over the stored title.
Queries have at most 512 Unicode code points. Surrounding whitespace uses the same
predicate as title blankness: Java whitespace, space characters (including NBSP),
and BOM are removed. Internal characters remain literal. Null or empty means no
title filter. `%`, `_` and backslash are literal. SQL applies both filters before the limit while retaining tenant,
Workspace grant, public Session kind and deletion predicates. Case folding follows
the database's `LOWER` behavior; locale-specific equivalence is not promised.

Ordering stays creation time and Session ID descending. Unfiltered legacy cursors
remain valid only for `all`; v2 cursors retain archive binding. Nonempty title
queries use v3 cursors bound to the archive state and SHA-256 of the stripped query.
Changing query case requires a new cursor even if the resulting matches are equal.
A cursor is not authorization; access is checked on every page. Listing is not a
snapshot across concurrent renames, archive changes or deletion.

## Risks and acceptance

No schema migration or new route is needed; both existing list routes retain
Workspace read authorization. Substring matching can scan the authorized candidate
set. This slice does not introduce an index or claim a performance benchmark.

The focused contract regression covers literal wildcard characters, case folding,
filtering before pagination, query/filter cursor rejection, both API shapes,
compatibility alias conflict and tenant isolation. Existing archive regression
retains old cursor/default coverage. Local tests, builds and checks were not run
at the user's request; CI and database-specific execution remain unverified.

## Follow-up

The Java WebShell provider now exposes an independent title-search input. It sends
the server-side `titleQuery` on the first page and every subsequent page, while
the existing navigation search remains responsible for Session IDs and Workspace
names. Other providers do not render the input. The title input is intentionally
separate from navigation search until a combined-search contract is agreed.

The issue remains open for runtime qualification and any future combined-search
decision; this UI wiring does not claim a snapshot across concurrent changes.
