# Docs Surface Map

Use this file to choose the correct destination page under `docs/`.

## Primary sections

- `docs/users/overview.md`, `quickstart.md`, `common-workflow.md`
  Good for entry points, first-run guidance, and broad user workflows.
- `docs/users/features/*.md`
  Good for user-visible features such as skills, MCP, sandbox, sub-agents, commands, checkpointing, and approval modes.
- `docs/users/configuration/*.md`
  Good for settings, auth, model providers, themes, trusted folders, `.qwen` files, and similar configuration topics.
- `docs/users/integration-*.md` and `docs/users/ide-integration/*.md`
  Good for IDEs, GitHub Actions, and editor companion behavior.
- `docs/users/extension/*.md`
  Good for extension authoring and extension usage.
- `docs/developers/*.md`
  Good for architecture, contributing workflow, roadmaps, and SDK overviews.
- `docs/developers/tools/*.md`
  Good for tool behavior, tool contracts, and implementation-facing explanations.
- `docs/developers/development/*.md`
  Good for contributor setup, deployment, tests, telemetry, and automation details.

## Navigation rules

- Root navigation lives in `docs/_meta.ts`.
- Section navigation lives in the nearest `_meta.ts`, for example:
  - `docs/users/_meta.ts`
  - `docs/users/features/_meta.ts`
  - `docs/developers/_meta.ts`
  - `docs/developers/tools/_meta.ts`
- If you create a page and do not add it to the right `_meta.ts`, the docs will be incomplete even if the markdown exists.

## Placement heuristics

- Put the change where a reader would naturally look first.
- Update multiple pages when a single feature appears in setup, reference, and workflow docs.
- Prefer adjusting a nearby existing page instead of creating a top-level page for a small delta.
- Avoid duplicating long explanations across pages; add one source page and update nearby pages with short pointers if needed.
