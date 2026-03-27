---
name: docs-update-from-diff
description: Review local code changes with git diff and update the official docs under docs/ to match. Use when the user asks to document current uncommitted work, sync docs with local changes, update docs after a feature or refactor, or when phrases like "git diff", "local changes", "update docs", or "official docs" appear.
---

# Docs Update From Diff

## Overview

Inspect local diffs, derive the documentation impact, and update only the repository's `docs/` pages. Treat the current code as the source of truth and keep changes scoped, specific, and navigable.

Read [references/docs-surface.md](references/docs-surface.md) before editing if the affected feature does not map cleanly to an existing docs section.

## Workflow

### 1. Build the change set

Start from local Git state, not from assumptions.

- Inspect `git status --short`, `git diff --stat`, and targeted `git diff` output.
- Focus on non-doc changes first so the documentation delta is grounded in code.
- Ignore `README.md` and other non-`docs/` content unless they help confirm intent.

### 2. Derive the docs impact

For every changed behavior, extract the user-facing or developer-facing facts that documentation must reflect.

- New command, flag, config key, default, workflow, or limitation
- Renamed behavior or removed behavior
- Changed examples, paths, or setup steps
- New feature that belongs in an existing page but is not mentioned yet

Prefer updating an existing page over creating a new page. Create a new page only when the feature introduces a stable topic that would make an existing page harder to follow.

### 3. Find the right docs location

Map each change to the smallest correct documentation surface:

- End-user behavior: `docs/users/**`
- Developer internals, SDKs, contributor workflow, tooling: `docs/developers/**`
- Shared landing or navigation changes: root `docs/**` and `_meta.ts`

If you add a new page, update the nearest `_meta.ts` in the same docs section so the page is discoverable.

### 4. Write the update

Edit documentation with the following bar:

- State the current behavior, not the implementation history
- Use concrete commands, file paths, setting keys, and defaults from the diff
- Remove or rewrite stale text instead of stacking caveats on top of it
- Keep examples aligned with the current CLI and repository layout
- Preserve the repository's existing docs tone and heading structure

### 5. Cross-check before finishing

Verify that the updated docs cover the actual delta:

- Search `docs/` for old names, removed flags, or outdated examples
- Confirm links and relative paths still make sense
- Confirm any new page is included in the relevant `_meta.ts`
- Re-read the changed docs against the code diff, not against memory

## Practical heuristics

- If a change affects commands, also check quickstart, workflows, and feature pages for drift.
- If a change affects configuration, also check `docs/users/configuration/settings.md`, feature pages, and auth/provider docs.
- If a change affects tools or agent behavior, check both `docs/users/features/**` and `docs/developers/tools/**` when relevant.
- If tests reveal expected behavior more clearly than implementation code, use tests to confirm wording.

## Deliverable

Produce the docs edits under `docs/` that make the current local changes understandable to a reader who has not seen the diff. Keep the final summary short and identify which pages were updated.
