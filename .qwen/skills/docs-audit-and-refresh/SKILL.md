---
name: docs-audit-and-refresh
description: Audit the repository's docs/ content AND skill docs (.qwen/skills/qwen-settings-config/) against the current codebase, find missing, incorrect, or stale documentation, and refresh the affected pages. Use when the user asks to review docs coverage, find outdated docs, compare docs with the current repo, or fix documentation drift across features, settings, tools, or integrations.
---

# Docs Audit And Refresh

## Overview

Audit from the repository outward: inspect the current implementation, identify documentation gaps or inaccuracies, and update the relevant pages in:

1. **Official docs**: `docs/`
2. **Skill docs**: `.qwen/skills/qwen-settings-config/references/` (for configuration-related content)

Treat code, tests, and current configuration surfaces as the authoritative source.

Read [references/audit-checklist.md](references/audit-checklist.md) before a broad audit so the scan stays focused on high-signal areas.

---

## Workflow

### 1. Build a current-state inventory

Inspect the repository areas that define user-facing or developer-facing behavior.

- Read the relevant code, tests, schemas, and package surfaces.
- Focus on shipped behavior, stable configuration, exposed commands, integrations, and developer workflows.
- Use the existing docs tree as a map of intended coverage, not as proof that coverage is complete.

**Include skill docs in the audit scope**:

- Check `.qwen/skills/qwen-settings-config/references/` for configuration documentation
- Compare against `packages/cli/src/config/settingsSchema.ts` for accuracy

### 2. Compare implementation against docs

Look for three classes of issues in BOTH official docs AND skill docs:

- Missing documentation for an existing feature, setting, tool, or workflow
- Incorrect documentation that contradicts the current codebase
- Stale documentation that uses old names, defaults, paths, or examples

**Configuration-specific checks**:

- Compare `settingsSchema.ts` against `docs/users/configuration/settings.md`
- Compare `settingsSchema.ts` against `.qwen/skills/qwen-settings-config/references/*.md`
- Verify defaults, types, descriptions, and enum options match across all three sources

Prefer proving a gap with repository evidence before editing. Use current code and tests instead of intuition.

### 3. Prioritize by reader impact

Fix the highest-cost issues first:

1. Broken onboarding, setup, auth, installation, or command flows
2. Wrong settings, defaults, paths, or feature behavior
3. Entirely missing documentation for a real surface area
4. Lower-impact clarity or organization improvements

**Dual-update priority**: If a configuration issue affects both official docs and skill docs, fix both in the same pass to prevent drift.

### 4. Refresh the docs

Update the smallest correct set of pages:

**Official docs** (`docs/`):

- Edit existing pages first
- Add new pages only for clear, durable gaps
- Update the nearest `_meta.ts` when adding or moving pages
- Keep examples executable and aligned with the current repository structure
- Remove dead or misleading text instead of layering warnings on top

**Skill docs** (`.qwen/skills/qwen-settings-config/references/`):

- Add missing settings to the appropriate category file
- Update modified settings with new defaults/descriptions
- Mark deprecated settings with ⚠️ DEPRECATED notice
- Add "Common Scenario" examples for user-facing features

### 5. Validate the refresh

Before finishing:

**Official docs**:

- Search `docs/` for old terminology and replaced config keys
- Check neighboring pages for conflicting guidance
- Confirm new pages appear in the right `_meta.ts`
- Re-read critical examples, commands, and paths against code or tests

**Skill docs**:

- Verify all settings from schema are present
- Check that defaults match `settingsSchema.ts`
- Ensure enum options are complete
- Confirm examples are usable

**Cross-validation**:

- Verify official docs and skill docs have the same settings
- Check that descriptions are consistent (skill docs can be more verbose)

---

## Audit standards

- Favor breadth-first discovery, then depth on confirmed gaps.
- Do not rewrite large areas without evidence that they are wrong or missing.
- Keep README files out of scope for edits; limit changes to `docs/` and `.qwen/skills/qwen-settings-config/`.
- Call out residual gaps if the audit finds issues that are too large to solve in one pass.

**Configuration audit heuristics**:

- Always compare against `settingsSchema.ts` as the source of truth
- Update both official docs and skill docs in the same pass
- Check related feature docs for cross-references (e.g., `docs/users/features/approval-mode.md`, `docs/users/features/mcp.md`)

---

## Deliverable

Produce a focused docs refresh that makes the current repository more accurate and complete. Summarize the audited surfaces and the concrete pages updated.

**Example summary**:

```markdown
## Docs Audit Complete

**Audited sources**:

- Code: `packages/cli/src/config/settingsSchema.ts`
- Official docs: `docs/users/configuration/`, `docs/users/features/`
- Skill docs: `.qwen/skills/qwen-settings-config/references/`

**Issues found and fixed**:

- Missing: `general.defaultFileEncoding` setting (added to both docs)
- Stale: `tools.approvalMode` enum options (updated in both docs)
- Deprecated: `tools.core` marked with migration note

**Official docs updated** (`docs/`):

- `docs/users/configuration/settings.md` (general, tools sections)

**Skill docs updated** (`.qwen/skills/qwen-settings-config/`):

- `references/general-ui.md`
- `references/tools.md`
```
