---
name: openwork-desktop-sync
description: Sync qwen-code packages/desktop with modelstudioai/openwork using commit-by-commit path migration, not subtree split or tree overwrite. Use when exporting qwen-code desktop changes to OpenWork, importing OpenWork desktop changes into qwen-code, preserving target-owned overlay files such as README.md, resolving sync conflicts, or preparing sync PR branches between the two repositories.
---

# OpenWork Desktop Sync

Use this skill to sync desktop changes between this qwen-code repo and an
OpenWork checkout. The repository script owns the Git mechanics:

```bash
OPENWORK_DIR=/path/to/openwork bun run desktop-openwork-sync --mode export
```

Default overlay is `README.md`. Overlay paths are excluded from migrated
commits and stay target-owned.

```bash
OPENWORK_OVERLAY_PATHS='README.md'
```

## Contract

This is commit-by-commit path migration, not snapshot replacement. The script
walks source commits from `source-base..source-head`, rewrites paths between
qwen-code `packages/desktop` and the OpenWork repository root, then applies each
commit with `git apply -3`.

Commits that already came from the receiving repository are skipped by their
sync trailers. During import, qwen-code-origin export commits are skipped;
during export, OpenWork-origin import commits are skipped.

Merge commits are not migrated as merge commits. The script migrates the regular
commits inside the merged branch; when it later sees the merge wrapper, it
checks that the regular commits were already handled and that the merge tree
matches Git's automatic merge result. If the merge wrapper contains manual
resolution changes, the sync stops so the agent can convert that resolution into
a normal follow-up commit.

Target-side changes are preserved unless a migrated source commit touches the
same hunk. If that happens, Git leaves a normal conflict for the agent to
resolve. Do not use `git subtree split` or full tree replacement for normal
sync.

Successful sync commits include trailers such as `Qwen-Code-Commit` or
`OpenWork-Commit`. Later syncs can use the latest trailer as the next source
base. The first sync needs an explicit source base when no previous sync trailer
exists:

```bash
bun run desktop-openwork-sync --mode export --source-base <qwen-code-ref>
bun run desktop-openwork-sync --mode import --source-base <openwork-ref>
```

## Modes

- `--mode export`: qwen-code `packages/desktop` commits -> OpenWork.
- `--mode import`: OpenWork commits -> qwen-code `packages/desktop`.
- `--mode auto`: guardrail only; use explicit directions for real sync.

## Workflow

1. Confirm repo paths and clean worktrees:

   ```bash
   git rev-parse --show-toplevel
   git -C /path/to/openwork rev-parse --show-toplevel
   git status --short
   git -C /path/to/openwork status --short
   ```

2. Run the requested direction:

   ```bash
   OPENWORK_DIR=/path/to/openwork \
   OPENWORK_OVERLAY_PATHS='README.md' \
   bun run desktop-openwork-sync --mode export --source-base <qwen-code-ref>
   ```

3. If Git reports conflicts, resolve only the conflicted hunks, preserving
   target-owned repository metadata unless the source change intentionally
   updates that same behavior.

4. After sync, verify:

   ```bash
   git status --short
   git diff --check HEAD
   git diff --name-status <target-base>..HEAD
   ```

5. If the user asked to publish, push the branch and create a PR after the
   branch is clean.

## Rules

- Keep only `README.md` as the default overlay unless the user adds paths to
  `OPENWORK_OVERLAY_PATHS`.
- OpenWork-specific files not touched by source commits must remain unchanged.
- Prefer PR branches. The script prints the push command for export branches.
- Do not manually import PR merge commits. Let the script migrate regular
  commits and treat merge commits as wrappers.
