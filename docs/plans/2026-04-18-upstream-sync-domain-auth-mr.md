# Upstream Sync Domain Auth MR Implementation Plan

> **Status: COMPLETED** — All tasks implemented and verified. See `.aoneci/scripts/upstream-sync-domain-auth.sh`.

**Goal:** Make `.aoneci/upstream-sync-merge.yml` reliably initialize a git repo in Aone CI, push the generated sync branch with domain auth, and create or reuse a GitLab MR.

**Architecture:** Keep the existing upstream fetch/merge/conflict workflow in YAML, but move repo bootstrap and MR publishing into one CI-focused shell helper under `.aoneci/scripts/`. The workflow will call the helper once before any git operations and once after the sync branch is prepared, passing status and MR metadata through environment variables and existing temp files.

**Tech Stack:** Aone CI YAML, Bash, git, curl, Node.js for URL/JSON escaping, Vitest for shell-script regression coverage.

### Task 1: Add a failing regression test for CI publish logic

**Files:**

- Create: `scripts/tests/upstream-sync-domain-auth.test.js`
- Test: `scripts/tests/vitest.config.ts`

**Step 1: Write the failing test**

Add tests that execute a future `.aoneci/scripts/upstream-sync-domain-auth.sh` helper with mocked `git` and `curl` commands. Cover:

- `prepare` initializes git metadata in a copy-only workspace and checks out the source branch from origin when it exists.
- `publish` pushes the source branch and creates an MR against the target branch using domain auth variables, then writes the MR URL to an output file.

**Step 2: Run test to verify it fails**

Run: `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/upstream-sync-domain-auth.test.js`
Expected: FAIL because `.aoneci/scripts/upstream-sync-domain-auth.sh` does not exist yet.

### Task 2: Implement the CI helper script

**Files:**

- Create: `.aoneci/scripts/upstream-sync-domain-auth.sh`
- Test: `scripts/tests/upstream-sync-domain-auth.test.js`

**Step 1: Write minimal implementation**

Implement a shell helper with subcommands:

- `prepare`: resolve repo path and credentials, `git init` when needed, configure user identity, set authenticated origin URL, fetch the source branch, and check it out.
- `publish`: push the sync branch, call the GitLab merge-request API, handle HTTP `201` and `409`, and optionally write the MR URL to a file.

**Step 2: Run targeted tests**

Run: `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/upstream-sync-domain-auth.test.js`
Expected: PASS

### Task 3: Wire the helper into the upstream sync workflow

**Files:**

- Modify: `.aoneci/upstream-sync-merge.yml`
- Modify: `docs/plans/2026-04-18-upstream-sync-domain-auth-mr.md`

**Step 1: Update workflow bootstrap**

Call the helper before any git operation, passing:

- `vars.username`
- `secrets.privateToken`
- `vars.repoPath`
- `${{git.repo.fullName}}`
- `${{git.branch}}`

Also keep the legacy token as fallback for compatibility with existing secret naming.

**Step 2: Update workflow publish step**

Replace inline `git remote set-url` and raw `curl` MR creation with the helper’s `publish` subcommand. Continue generating MR title/description from sync status in YAML, but let the helper handle authenticated push, HTTP-code validation, and MR URL extraction.

**Step 3: Re-run targeted tests**

Run: `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/upstream-sync-domain-auth.test.js`
Expected: PASS

### Task 4: Verify workflow syntax and summarize behavior changes

**Files:**

- Modify: `.aoneci/upstream-sync-merge.yml`
- Modify: `.aoneci/scripts/upstream-sync-domain-auth.sh`

**Step 1: Run shell syntax validation**

Run: `bash -n .aoneci/scripts/upstream-sync-domain-auth.sh`
Expected: PASS

**Step 2: Run workflow-adjacent regression checks**

Run: `npx vitest run --config scripts/tests/vitest.config.ts scripts/tests/upstream-sync-domain-auth.test.js`
Expected: PASS

**Step 3: Capture findings**

Document the concrete reasons the old workflow was unreliable:

- no repo bootstrap for copy-only checkout
- push/MR host and auth path tightly coupled to one token shape
- MR creation did not inspect HTTP status codes
- no idempotent handling for reruns that hit an existing MR
