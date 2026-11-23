# Shared project auto-memory across Git worktrees

[English](shared-worktree-project-memory.md) | [简体中文](shared-worktree-project-memory.zh-CN.md)

## Problem and scope

[#18030](https://github.com/QwenLM/qwen-code/issues/18030) describes a project lesson learned in a temporary Git worktree that a fresh session in its owning workspace cannot recall. Standalone Git sessions should share durable project auto-memory. Independently registered `qwen serve` workspaces keep separate native project memory, including workspace roots nested in the same repository. Chat transcripts, user and team memory, and checkout files retain their existing locations. Branch-specific applicability is outside this change.

## Ownership and upgrade

Standalone defaults to `git-root`. A non-symlink primary `.git` directory, linked worktree with verified registration and backlinks, submodule with a matching `core.worktree`, or bare Git directory establishes the real common Git directory as the repository identity. The checks use Git metadata only. Moved worktrees with unrepaired links, damaged metadata, symlinked `.git`, and non-Git paths use a path-local store. For a non-bare primary checkout with a separate Git directory and no backlink, the primary keeps its path-local store. Its validated linked worktrees share one repository store. Directly launching from the parent of a separately located directory named `.git` is unsupported because Git presents that parent as an ordinary primary checkout.

A repository atomically binds one active store in the memory base. If the canonical store exists, it wins initialization. Otherwise, a directly verified primary checkout can adopt its own existing store. Any other first session binds the canonical store. The first published binding wins concurrent startup and subsequent sessions use that binding. A linked checkout can flag an unverified candidate for explicit review. A primary checkout can later prove that its old store belongs to the same repository and offer it for import. A symlink alias can establish legacy ownership when it resolves to the same checkout. Existing stores stay in place.

The daemon defaults to `workspace` and uses the workspace selected at session admission. Creating, entering, branching or restoring a task worktree retains that owner. Changing the daemon session's cwd cannot select another registered workspace's memory. Standalone startup remembers the launch owner while its cwd is inside the task worktree. A standalone directory change out of that tree resolves the destination owner. Team memory continues to resolve from the live checkout.

## Concurrent writes and recall

A short cross-process commit lock per active store serializes final snapshots, version checks, atomic writes, deletes, and index publication. Dream and import lifecycle locks take the commit lock in that order. Model calls run outside the commit lock. Project writers update topic files and one runtime path generates project `MEMORY.md`. Concurrent changes to the same topic compare against their observed versions. Stale edit, forget, Dream deletion, migration, or import proposals preserve the newer content.

Background extraction queues work by store and session. Within a process, sessions run in arrival order and queued requests for the same session coalesce. An extraction lease serializes work across processes. Upgrading a single-session cursor preserves the previous session offset. Cursor commits merge the latest disk state, and successful index rebuilds clear the repair marker in the same commit. Project metadata merges field updates under the commit lock and timestamps stay monotonic.

The generated index and its standard startup view use at most 200 lines and 25,000 UTF-16 code units. Models below 128K context receive at most 100 lines and 12,500 code units. Older topics stay on disk and can be recalled through on-demand reads and structured search; Dream can consolidate overlapping topics.

## Historical import

An offline preview identifies its target by owner, scope and actual memory directory. It shows source entries, stable IDs and estimated cost. Repository scope discovers validated registered worktrees and verified legacy main or symlink paths. Workspace scope uses its own session sidecars and worktree ownership markers. Deleted or unproven checkouts can be named with CLI `--source`. The daemon uses the selected trusted workspace runtime and discovers sources inside that scope.

`qwen memory import worktree` previews by default. `--scope` takes precedence over environment scope. The user confirms a selection against the preview before model organization starts. Worktree entries import into project memory only. The target tuple is part of task identity and is rechecked on retry and restart. Model organization proposes which entries are new, duplicate, conflicting or skipped. The final publication and recovery check the target snapshot under the commit lock before publishing and rebuilding the index. Import preserves source files and existing target topics.

## Acceptance

Exercise real Git checkouts, including main-first and worktree-first upgrades, concurrent binding, symlink launch, bare and submodule worktrees, separate Git directories, malformed metadata, and an atomic replacement of a tracked file. Verify bidirectional recall in fresh sessions, daemon isolation across two registered roots through worktree creation, branching and restart, and directory changes within and outside a startup worktree. Race commits and repairs across processes, and verify both recall modes with more than 200 stored topics. Run preview, confirmation, restart and target drift checks with isolated runtime roots and inspect source and target files before and after.
