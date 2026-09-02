# Pinned Managed-Memory Protection

## Problem

Managed auto-memory recursively discovers valid markdown topics below the
project and user memory roots, subject to the existing index limits. Automatic
extraction and Dream consolidation agents can write or edit paths inside their
allowed memory roots, so a hand-curated file can be overwritten or consolidated
like an automatically generated memory.

The recursive scanner already discovers valid files below `pinned/`; the
missing behavior is deterministic mutation protection during automated memory
maintenance.

## Chosen design

Treat a top-level `pinned/` directory inside a managed-memory root as protected
from automatic-extraction mutation and excluded from Dream consolidation:

- Keep valid pinned documents readable to normal memory recall and discoverable
  by the existing indexer under its normal limits.
- Deny automatic extraction and forked Dream `write_file` and `edit` operations
  when the requested path is lexically below `pinned/`.
- Match the reserved top-level directory name case-insensitively so the
  deny-list cannot fail open on case-insensitive filesystems.
- Also deny aliases that resolve through a symlink into `pinned/`.
- Keep the existing read-only shell gate, which already rejects `rm` and every
  other mutating shell command.
- Teach the automatic extraction and Dream prompts to leave pinned documents
  unchanged and avoid intentionally removing their existing index entries,
  subject to normal index limits.

The path check compares both literal and resolved paths case-insensitively.
Literal containment protects `pinned/` even when that directory is itself a
symlink. Resolved containment prevents a writable-looking path elsewhere in
memory from symlinking back into `pinned/`.

Protection is an explicit option on the existing memory-scoped agent
configuration and is enabled by the automatic extraction and forked Dream
planners. This covers post-session extraction, scheduled Dream, and callers of
the workspace-memory Dream endpoint. Explicit remember operations retain their
current behavior.

## Scope boundaries

- No scanner or indexer production change: recursive discovery already handles
  project and user `pinned/` documents with the existing frontmatter schema.
- No new frontmatter field and no automatic creation of the directory.
- No `/memory` UI indicator.
- Explicit `/forget` requests keep their current behavior.
- This path-based boundary does not detect pre-existing hard-link aliases to
  pinned files. Automatic memory workers cannot create them with `write_file`
  or `edit`, and their read-only shell policy blocks `ln`; a stronger threat
  model would require a separate inode-based policy.
- The visible `/dream` slash-command turn receives the shared skip prompt rule,
  but does not gain a deterministic tool gate in this change. The slash command
  executes on the main Agent, which has no existing per-turn permission
  override; adding one would be a separate cross-surface permission design.
- Forked Dream remains project-memory-only because its existing scoped
  configuration excludes the global user-memory root.
- Automatic extraction continues to cover both project and global user-memory
  roots, so both top-level `pinned/` directories receive the same protection.

## Files affected

- `packages/core/src/memory/paths.ts`
- `packages/core/src/memory/memory-scoped-agent-config.ts`
- `packages/core/src/memory/dreamAgentPlanner.ts`
- `packages/core/src/memory/extractionAgentPlanner.ts`
- Collocated memory permission, prompt, and index tests
- `docs/users/features/memory.md`

## Open question

Whether the visible `/dream` slash command must receive the same deterministic
gate remains a maintainer scope decision. If required, it should be implemented
as a general per-turn permission override rather than by mutating the
session-wide permission manager around one asynchronous tool loop.
