# Release Workflow Parallelization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the GitHub release workflow so release validation runs in parallel jobs while publish remains serialized.

**Architecture:** Replace the single `release` job in `.github/workflows/release.yml` with a small DAG: `prepare`, `quality`, `integration-none`, `integration-docker`, and `publish`. Reuse `prepare` outputs to drive publish, avoid duplicate `npm ci` inside release validation, and build the sandbox once per docker validation job.

**Tech Stack:** GitHub Actions workflow YAML, npm workspaces, existing release scripts, actionlint for workflow validation.

### Task 1: Establish the workflow shape

**Files:**

- Modify: `.github/workflows/release.yml`

**Step 1: Rewrite the job graph**

- Replace the current single `release` job with:
  - `prepare`
  - `quality`
  - `integration-none`
  - `integration-docker`
  - `publish`
- Keep publish gated on all validation jobs succeeding.

**Step 2: Preserve release metadata outputs**

- Keep the current version-calculation logic in `prepare`.
- Emit outputs for:
  - `release_tag`
  - `release_version`
  - `npm_tag`
  - `previous_release_tag`
  - nightly, preview, and dry-run flags

**Step 3: Keep permission boundaries explicit**

- Use read-only permissions on validation jobs.
- Keep write permissions only on `publish`.

### Task 2: Remove repeated validation work

**Files:**

- Modify: `.github/workflows/release.yml`
- Reference: `package.json`

**Step 1: Replace `preflight` in release validation**

- In `quality`, run the release-safe validation sequence explicitly:
  - `npm run clean`
  - format check
  - `npm run lint:ci`
  - `npm run build`
  - `npm run typecheck`
  - `npm run test:ci`
- Do not call `npm run preflight`.

**Step 2: Avoid a second dependency install**

- Ensure release validation does not run an extra `npm ci` after the initial install for that runner.

**Step 3: Build sandbox once for docker validation**

- In `integration-docker`, run `npm run build:sandbox` once.
- Then run docker CLI and interactive integration tests without nested sandbox rebuilds.

### Task 3: Keep publish behavior intact

**Files:**

- Modify: `.github/workflows/release.yml`

**Step 1: Recreate the current publish sequence under `publish`**

- Configure git user
- Create release branch
- Run version bump
- Commit and optionally push
- Bundle and prepare package
- Publish both npm packages
- Create the GitHub release

**Step 2: Keep failure reporting**

- Preserve the failure issue creation path in the publish job.

### Task 4: Validate and commit

**Files:**

- Modify: `.github/workflows/release.yml`
- Add: `docs/plans/2026-04-11-release-workflow-parallelization-implementation.md`

**Step 1: Run workflow validation**

Run: `actionlint .github/workflows/release.yml`

Expected: no workflow validation errors

**Step 2: Review the diff**

Run: `git diff -- .github/workflows/release.yml docs/plans/2026-04-11-release-workflow-parallelization-implementation.md`

Expected: workflow split plus plan document only

**Step 3: Commit**

Run:

```bash
git add .github/workflows/release.yml docs/plans/2026-04-11-release-workflow-parallelization-implementation.md
git commit -m "ci(release): parallelize release validation"
```

Expected: one conventional commit containing the workflow refactor and implementation plan
