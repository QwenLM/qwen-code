# PR CI Failure Patrol Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Handle stale CI failures only for recently active PRs, without taking ownership of main-branch failures.

**Architecture:** A scheduled workflow prepares one eligible PR failure for a read-only project skill. The skill returns a proposed action; the JavaScript driver enforces all GitHub writes and safety limits.

**Tech Stack:** GitHub Actions, Node.js, Vitest, project skill.

### Task 1: Cover candidate eligibility

**Files:**

- Modify: `scripts/tests/ci-flaky-rerun.test.js`
- Modify: `.github/scripts/ci-flaky-rerun.mjs`

1. Add tests for the seven-day activity window and three actions per head SHA.
2. Run the focused test and confirm it fails.
3. Add the smallest selection and marker-counting logic that passes.

### Task 2: Cover skill-directed PR actions

**Files:**

- Modify: `scripts/tests/ci-flaky-rerun.test.js`
- Modify: `scripts/tests/ci-flaky-rerun-workflow.test.js`
- Modify: `.github/scripts/ci-flaky-rerun.mjs`
- Modify: `.qwen/skills/ci-flaky-patrol/SKILL.md`
- Modify: `.github/workflows/qwen-ci-flaky-rerun.yml`

1. Add failing tests for safe branch update and bilingual non-flaky comments.
2. Run the focused tests and confirm failure.
3. Implement the minimum JSON contract and deterministic guards.

### Task 3: Verify and publish

1. Run focused tests, actionlint, yamllint, formatting, and diff checks.
2. Commit the reviewed PR-only changes with a conventional commit.
3. Push the existing PR branch normally.
