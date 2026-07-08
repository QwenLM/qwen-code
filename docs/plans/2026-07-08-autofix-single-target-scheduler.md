# Autofix Single Target Scheduler Implementation Plan

**Goal:** Make the Qwen Autofix workflow run every 10 minutes, process at most one actionable autofix PR per scan, react once to submitted reviews on bot PRs, handle failed PR checks, and fall back to one existing approved issue only when no PR needs work.

**Architecture:** Keep the existing `qwen-autofix.yml` lifecycle and agent modes. Tighten the route and scan jobs so scheduled runs always scan review PRs first, issue work only proceeds when review scan has no target, and PR handling is still locked per PR.

**Tech Stack:** GitHub Actions YAML, `gh` CLI, `jq`, Vitest string guards in `scripts/tests/qwen-autofix-workflow.test.js`.

### Task 1: Add Workflow Guard Tests

**Files:**

- Modify: `scripts/tests/qwen-autofix-workflow.test.js`

**Steps:**

1. Add tests for `AUTOFIX_BOT` using `vars.AUTOFIX_BOT_LOGIN`.
2. Add tests for `*/10 * * * *` schedule and no 4-hour schedule.
3. Add tests that submitted review events route only for bot PRs.
4. Add tests that review scan emits at most one target and skips PRs with pending checks.
5. Add tests that issue phase waits for review scan to have no target and respects a WIP PR cap.
6. Run `npx vitest run scripts/tests/qwen-autofix-workflow.test.js` and confirm failure.

### Task 2: Update Workflow Routing and Scan

**Files:**

- Modify: `.github/workflows/qwen-autofix.yml`

**Steps:**

1. Change scheduled cron to 10 minutes.
2. Change `AUTOFIX_BOT` to use `vars.AUTOFIX_BOT_LOGIN`.
3. Raise `MAX_ROUNDS`.
4. Add `MAX_OPEN_AUTOFIX_PRS`.
5. Add a low-frequency `pull_request_review: submitted` trigger for bot PRs.
6. Make `issue-autofix` depend on `review-scan` for scheduled review-first fallback.
7. Make review scan pick one target, skip PRs with pending checks, and handle failed checks.
8. Gate issue candidate scan when review scan has a target or open autofix PR count exceeds the WIP cap.

### Task 3: Verify

**Files:**

- Test: `scripts/tests/qwen-autofix-workflow.test.js`

**Steps:**

1. Run `npx vitest run scripts/tests/qwen-autofix-workflow.test.js`.
2. Inspect the diff for unrelated changes.
