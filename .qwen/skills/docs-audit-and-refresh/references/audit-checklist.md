# Audit Checklist

Use this checklist to keep repository-wide documentation audits focused and
repeatable.

## High-signal repository surfaces

- `packages/cli/**` Inspect commands, flows, prompts, flags, and CLI-facing
  behavior.
- `packages/core/**` Inspect shared behavior, settings, tools, provider
  integration, and feature semantics.
- `packages/sdk-typescript/**` and `packages/sdk-java/**` Inspect SDK setup,
  usage, and examples that may affect developer docs.
- `packages/vscode-ide-companion/**`, `packages/zed-extension/**`, and related
  integration packages Inspect IDE and extension behavior that should be
  reflected in user docs.
- `docs/**/_meta.ts` Inspect navigation completeness after creating or moving
  pages.
- `packages/core/src/skills/bundled/qc-helper/SKILL.md` Inspect the topic-to-
  doc-path index tables. This bundled skill ships with the CLI and uses these
  tables at runtime to locate docs for `/qc-helper` invocations. Stale or
  missing entries cause the skill to miss the right documentation or point at
  nonexistent files.
- `.qwen/skills/*/SKILL.md` and `.qwen/skills/*/references/*.md` Inspect any
  hardcoded `docs/users/` or `docs/developers/` paths in project-level
  skills. These are not shipped but are used during development workflows.

## Gap detection prompts

Ask these questions while comparing the repo to `docs/`:

- Does a visible feature exist in code but have no page or section in `docs/`?
- Does a docs page mention a command, setting, provider, or path that no longer
  exists?
- Do examples still match the current repository layout and command syntax?
- Is a page present but hidden or missing from `_meta.ts`?
- Do multiple pages describe the same feature inconsistently?

## Common drift patterns

- Renamed settings keys or changed defaults
- Updated authentication or provider configuration flow
- New or removed CLI commands and flags
- New tool behavior or approval/sandbox semantics
- IDE integration changes that never reached the docs
- Features documented in the wrong section, making them hard to find
- New, moved, or renamed docs pages not reflected in bundled skill doc
  indices (especially `qc-helper`'s topic-to-path tables)

## Output standard

- Prefer a small number of precise edits over a speculative docs rewrite.
- Leave a clear summary of what was missing, wrong, or stale.
- If the audit uncovers a larger docs reorganization, fix the highest-impact
  inaccuracies first and note the remaining work.
