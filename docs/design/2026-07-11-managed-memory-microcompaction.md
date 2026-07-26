# Managed Memory Microcompaction Preservation

## Problem

Managed-memory topic files are loaded lazily with `read_file`. Microcompaction currently treats those results like ordinary tool output and replaces older content with `[Old tool result content cleared]`. The memory index remains available, and recent fixes let a later `read_file` return real bytes again, but the active model is not guaranteed to notice that it must reload the memory.

Issue #6487 also reports a stale index after `/remember`; PR #6497 already owns that part. This design only addresses managed-memory content removed by microcompaction.

## Chosen design

Add a narrow `MicrocompactOptions` callback that identifies `read_file` paths whose successful results must be preserved. Before building idle, forced, or size-based clearing plans, microcompaction correlates each response with its request-side `file_path` and removes protected results from the compactable set. Other tools, ordinary file reads, errors, and responses whose path cannot be resolved retain the current behavior.

Every production microcompaction entry point supplies the same predicate:

- pre-send idle and size-based compaction
- `/compress-fast`
- memory-pressure history compaction

The predicate recognizes project, user, and team managed-memory roots using realpath-aware containment. Symlinks that escape a managed root are not protected.

## Why this level

Injecting every loaded memory body into the system instruction would make memory permanently consume context and would replace the existing index-plus-lazy-read design. Reattaching every memory file after full compaction needs a separate token budget and restoration policy. Preserving only managed-memory reads from microcompaction directly fixes the reproduced clearing behavior with a bounded change and leaves full compaction as the existing hard context-reduction boundary.

Full compaction is therefore intentionally not byte-preserving. Its summary sees the pre-compaction memory content, `MEMORY.md` indexes remain in the system instruction, and the file-read cache is cleared so the model can reload exact bytes. This change guarantees preservation only across microcompaction.

## Risk and tests

Repeated reads of managed-memory files can retain multiple copies until full compaction. That is an intentional tradeoff: durable guidance is more important than reclaiming those tool-result tokens, while full compaction remains available as the hard cap.

Tests cover project, user, and team roots; ordinary reads; symlink escapes; idle, forced, and size-based paths; mixed protected and compactable results; ambiguous or missing response IDs; and eviction metadata.
