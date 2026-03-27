---
name: docs-audit-and-refresh
description: Audit the repository's docs/ content against the current codebase, find missing, incorrect, or stale documentation, and refresh the affected pages. Use when the user asks to review docs coverage, find outdated docs, compare docs with the current repo, or fix documentation drift across features, settings, tools, or integrations.
---

# Docs Audit And Refresh

## Overview

Audit `docs/` from the repository outward: inspect the current implementation, identify documentation gaps or inaccuracies, and update the relevant pages. Keep the work inside `docs/` and treat code, tests, and current configuration surfaces as the authoritative source.

Read [references/audit-checklist.md](references/audit-checklist.md) before a broad audit so the scan stays focused on high-signal areas.

## Workflow

### 1. Build a current-state inventory

Inspect the repository areas that define user-facing or developer-facing behavior.

- Read the relevant code, tests, schemas, and package surfaces.
- Focus on shipped behavior, stable configuration, exposed commands, integrations, and developer workflows.
- Use the existing docs tree as a map of intended coverage, not as proof that coverage is complete.

### 2. Compare implementation against `docs/`

Look for three classes of issues:

- Missing documentation for an existing feature, setting, tool, or workflow
- Incorrect documentation that contradicts the current codebase
- Stale documentation that uses old names, defaults, paths, or examples

Prefer proving a gap with repository evidence before editing. Use current code and tests instead of intuition.

### 3. Prioritize by reader impact

Fix the highest-cost issues first:

1. Broken onboarding, setup, auth, installation, or command flows
2. Wrong settings, defaults, paths, or feature behavior
3. Entirely missing documentation for a real surface area
4. Lower-impact clarity or organization improvements

### 4. Refresh the docs

Update the smallest correct set of pages under `docs/`.

- Edit existing pages first
- Add new pages only for clear, durable gaps
- Update the nearest `_meta.ts` when adding or moving pages
- Keep examples executable and aligned with the current repository structure
- Remove dead or misleading text instead of layering warnings on top

### 5. Validate the refresh

Before finishing:

- Search `docs/` for old terminology and replaced config keys
- Check neighboring pages for conflicting guidance
- Confirm new pages appear in the right `_meta.ts`
- Re-read critical examples, commands, and paths against code or tests

## Audit standards

- Favor breadth-first discovery, then depth on confirmed gaps.
- Do not rewrite large areas without evidence that they are wrong or missing.
- Keep README files out of scope for edits; limit changes to `docs/`.
- Call out residual gaps if the audit finds issues that are too large to solve in one pass.

## Deliverable

Produce a focused docs refresh that makes the current repository more accurate and complete. Summarize the audited surfaces and the concrete pages updated.
