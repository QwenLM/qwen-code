# AI Release Notes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate readable stable release highlights and PR summaries while preserving a complete, auditable change list and a non-blocking GitHub fallback.

**Architecture:** A standalone Node.js script obtains GitHub's authoritative generated-notes body, enriches its PR entries with metadata, optionally summarizes them through an OpenAI-compatible endpoint, validates exact PR identity, and renders Markdown. The release workflow uses that Markdown for stable releases, while the changelog generator reuses marked curated bodies and preserves its historical parser.

**Tech Stack:** Node.js ESM, built-in `fetch`, GitHub CLI, Vitest, GitHub Actions.

### Task 1: Define the pure release-note model and renderer

**Files:**

- Create: `scripts/generate-release-notes.js`
- Create: `scripts/tests/generate-release-notes.test.js`

1. Write failing tests for parsing GitHub-generated PR entries, deterministic category mapping, exact PR-set validation, and complete Markdown rendering.
2. Run `npx vitest run scripts/tests/generate-release-notes.test.js` and confirm failures are caused by missing exports.
3. Implement the smallest pure functions that satisfy the tests.
4. Re-run the focused test and confirm it passes.

### Task 2: Add model prompting and fallback

**Files:**

- Modify: `scripts/generate-release-notes.js`
- Modify: `scripts/tests/generate-release-notes.test.js`

1. Write failing tests for successful structured responses, missing PR summaries, unknown/duplicate PR numbers, invalid JSON, and highlight validation.
2. Run the focused test and confirm the expected failures.
3. Add injected completion support, bounded PR context, response validation, and original-title fallback.
4. Re-run the focused test and confirm it passes.

### Task 3: Reuse curated bodies in the changelog

**Files:**

- Modify: `scripts/generate-changelog.js`
- Modify: `scripts/tests/generate-changelog.test.js`

1. Write a failing test showing that a marked curated body is preserved and its headings are demoted beneath the version heading.
2. Run both release-note and changelog tests and confirm the new test fails.
3. Add marker detection and curated-body formatting without changing historical parsing.
4. Re-run both focused test files and confirm they pass.

### Task 4: Connect the stable release workflow

**Files:**

- Modify: `.github/workflows/release.yml`
- Create: `scripts/tests/ai-release-notes-workflow.test.js`

1. Write a failing workflow-content test for stable generation, model secrets, `--notes-file`, and preview/nightly/failure `--generate-notes` fallback.
2. Run the workflow test and confirm it fails.
3. Add a non-blocking stable-generation step and select the appropriate release-note arguments in the publish step.
4. Re-run the workflow and release-note tests.

### Task 5: Verify with real release data

**Files:**

- No tracked fixture required; write output under `.qwen/` or `/tmp`.

1. Run focused tests for the generator, changelog, and workflow.
2. Run formatting, build, and typecheck checks required by the repository.
3. Fetch a recent stable release's generated notes and PR metadata, run the generator in dry-run mode, and inspect PR completeness and Markdown structure.
4. If local model credentials are available, run the actual model path; otherwise use a captured model response and report that credential limitation explicitly.
5. Review the final diff for accidental generated or user-owned changes.
