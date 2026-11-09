# Recent sessions refresh and preview

[English](2026-11-08-recent-sessions-refresh.md) | [简体中文](2026-11-08-recent-sessions-refresh.zh-CN.md)

## Status and scope

Refresh and pagination fixes pass 16 focused component tests and the isolated HTTP verification. Full build, bundle and workspace typecheck remain blocked by missing or mismatched dependencies in the new worktree. Preview interaction below is a proposal only. No daemon API or settings changes.

## Problem

An expanded Recent list polls while the document is hidden. Sparse catalogs repeatedly filter and sort the entire accumulated prefix on each page. Reading enough pages to obtain 20 eligible records is necessary under the existing API; silently imposing a page cap would change completeness.

## Implementation

Observe document visibility. Hidden pages do not begin refreshes. Visibility changes invalidate in-flight results and stop subsequent pagination; already-issued HTTP requests may finish. Returning to visible starts a fresh load. Collapse, pause, scope changes and unmount also invalidate old work. Keep displayed entries while refreshing.

Filter each incoming page and accumulate eligible entries by session identity. Stop at 20 unique eligible entries or cursor exhaustion, preserving latest eligible duplicate replacement, source isolation, ordering and result limits. Sort once per source at completion and once for the combined result. This bounds retained excluded data and removes repeated prefix scans; it does not cap foreground request count or claim measured latency improvements.

## Preview proposal

Treat Show all as temporary disclosure: initial preview shows up to 5 rows, Show all reveals up to the existing 20. Collapsing resets disclosure; reopening shows 5. A daemon/source scope change also resets it. Ordinary polling, selecting a session, visibility changes and updates within the same scope preserve disclosure. Do not add persistence or a new setting. Reset the preview state in the collapse handler rather than coupling it to polling.

This matches sibling list behavior but changes a defensible existing preference. It is not a correctness fix and is not implemented in this change. Acceptance: 5 → Show all → 20 → collapse → reopen → 5; refresh while expanded remains 20; no changes to requests, selection, keyboard semantics or saved section-collapse preference.

## Validation and risks

Use component tests for hidden initial mount, visible/hidden/visible transitions, pending pages, pause, unmount, duplicate entries and sparse catalogs. Preserve fetching beyond excluded pages to reach valid records. Re-run the independent HTTP reproduction. Check build, bundle and typecheck; record environmental failures separately from passing focused tests. Browser visibility is simulated in the reproduction, so real-browser throttling, battery use and server latency are not established.

## Acceptance

No new automatic catalog request while hidden; pending pages cannot append stale state or request the next page. Returning to visible refreshes. Eligible results and deterministic ordering match baseline. No unconditional page cap. Preview proposal remains documentation-only.
