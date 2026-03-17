---
name: docs-update-from-diff
description: Review local code changes with git diff and update the official docs under docs/ AND skill docs under .qwen/skills/qwen-settings-config/. Use when the user asks to document current uncommitted work, sync docs with local changes, update docs after a feature or refactor, or when phrases like "git diff", "local changes", "update docs", or "official docs" appear.
---

# Docs Update From Diff

## Overview

Inspect local diffs, derive the documentation impact, and update:

1. **Official docs**: `docs/` pages
2. **Skill docs**: `.qwen/skills/qwen-settings-config/references/` (for configuration changes)

Treat the current code as the source of truth and keep changes scoped, specific, and navigable.

Read [references/docs-surface.md](references/docs-surface.md) before editing if the affected feature does not map cleanly to an existing docs section.

---

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

**Configuration changes require dual updates**:

- If the diff affects `settingsSchema.ts`, `settings.ts`, or config-related files, you MUST update both:
  - Official docs: `docs/users/configuration/settings.md`
  - Skill docs: `.qwen/skills/qwen-settings-config/references/`

Prefer updating an existing page over creating a new page. Create a new page only when the feature introduces a stable topic that would make an existing page harder to follow.

### 3. Find the right docs location

Map each change to the smallest correct documentation surface:

**Official docs** (`docs/`):

- End-user behavior: `docs/users/**`
- Developer internals, SDKs, contributor workflow, tooling: `docs/developers/**`
- Shared landing or navigation changes: root `docs/**` and `_meta.ts`

**Skill docs** (`.qwen/skills/qwen-settings-config/references/`):
| Config Category | Skill Doc File |
|-----------------|----------------|
| `permissions` | `references/permissions.md` |
| `mcp` / `mcpServers` | `references/mcp-servers.md` |
| `tools` | `references/tools.md` |
| `model` / `modelProviders` | `references/model.md` |
| `general` / `ui` / `ide` / `output` | `references/general-ui.md` |
| `context` | `references/context.md` |
| `hooks` / `hooksConfig` / `env` / `webSearch` / `security` / `privacy` / `telemetry` / `advanced` | `references/advanced.md` |

If you add a new page, update the nearest `_meta.ts` in the same docs section so the page is discoverable.

### 4. Write the update

**For official docs** (`docs/`):

- State the current behavior, not the implementation history
- Use concrete commands, file paths, setting keys, and defaults from the diff
- Remove or rewrite stale text instead of stacking caveats on top of it
- Keep examples aligned with the current CLI and repository layout
- Preserve the repository's existing docs tone and heading structure

**For skill docs** (`.qwen/skills/qwen-settings-config/references/`):

- Add the new setting to the appropriate category section
- Include a JSON example snippet
- Add a "Common Scenario" if it's a user-facing feature
- For modified settings, update defaults and descriptions
- For deprecated settings, add ⚠️ DEPRECATED notice with replacement

### 5. Cross-check before finishing

Verify that the updated docs cover the actual delta:

**Official docs**:

- Search `docs/` for old names, removed flags, or outdated examples
- Confirm links and relative paths still make sense
- Confirm any new page is included in the relevant `_meta.ts`
- Re-read the changed docs against the code diff, not against memory

**Skill docs**:

- Verify the setting is in the correct category file
- Check that defaults match the schema
- Ensure enum options are complete
- Confirm the example is usable

---

## Practical heuristics

- If a change affects commands, also check quickstart, workflows, and feature pages for drift.
- **If a change affects configuration, update BOTH**:
  - `docs/users/configuration/settings.md` (official docs)
  - `.qwen/skills/qwen-settings-config/references/*.md` (skill docs)
- If a change affects tools or agent behavior, check both `docs/users/features/**` and `docs/developers/tools/**` when relevant.
- If tests reveal expected behavior more clearly than implementation code, use tests to confirm wording.

**Configuration-specific heuristics**:

- `permissions.*` changes → Update `docs/users/configuration/settings.md` + `references/permissions.md` + check `docs/users/features/approval-mode.md`
- `mcpServers.*` or `mcp.*` changes → Update `docs/users/configuration/settings.md` + `references/mcp-servers.md` + check `docs/users/features/mcp.md`
- `tools.approvalMode` changes → Update `docs/users/configuration/settings.md` + `references/tools.md` + check `docs/users/features/approval-mode.md`
- `modelProviders.*` changes → Update `docs/users/configuration/settings.md` + `references/model.md` + check `docs/users/configuration/model-providers.md`
- `hooks.*` changes → Update `docs/users/configuration/settings.md` + `references/advanced.md` + check `docs/users/features/skills.md`

---

## Deliverable

Produce the docs edits under `docs/` AND `.qwen/skills/qwen-settings-config/` that make the current local changes understandable to a reader who has not seen the diff. Keep the final summary short and identify which pages were updated.

**Example summary**:

```markdown
## Docs Update Complete

**Official docs updated** (`docs/`):

- `docs/users/configuration/settings.md` (general, tools sections)
- `docs/users/features/approval-mode.md`

**Skill docs updated** (`.qwen/skills/qwen-settings-config/`):

- `references/general-ui.md`
- `references/tools.md`

**Changes**:

- Added `general.defaultFileEncoding` setting
- Modified `tools.approvalMode` enum options
```
