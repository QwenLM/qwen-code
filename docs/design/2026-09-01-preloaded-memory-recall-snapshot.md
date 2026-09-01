# Preloaded Auto-Memory Recall Snapshot

## Problem

The first model request waits at most 100 ms for deterministic auto-memory recall. Recall currently starts by recursively listing, reading, parsing, and stating every project and user memory document. On a loaded shared runner, that scan can miss the deadline even when the query has an unambiguous lexical match, so the first request is sent without the relevant memory.

Increasing the timeout would make prompt latency depend on storage tail latency and would not remove the race.

## Design

Each `MemoryManager` keeps a parsed project-and-user document snapshot keyed by project root. Hierarchical memory refresh preloads the snapshot alongside the managed memory indexes. Query-time recall selects from the in-memory snapshot and performs no filesystem work.

The existing scan path remains as a fallback when preload was unavailable. Snapshot replacement is atomic: a failed refresh leaves the previous snapshot intact, and startup continues so recall can fall back to an on-demand scan.

All managed-memory writes and workspace changes already refresh hierarchical memory, so they also refresh the snapshot. Explicit memory refresh continues to pick up manual file changes.

## Verification

A focused regression test preloads a real topic document, removes the live memory directory, and verifies that recall still returns the marker. The existing ACP integration test remains the end-to-end check that the first streamed model request contains deterministic memory while model selection is delayed beyond the 100 ms initial-turn budget.
