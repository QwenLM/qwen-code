# GitHub channel: comments of the poll cursor's own second

Date: 2026-11-08

Issue: QwenLM/qwen-code#16227

## Scenario

GitHub stamps comments and notifications to the second. The channel's poll cursor is the `updated_at` of the newest notification of the last window that was marked read. Before this change, a comment created in that same second, on a thread whose notification arrived only after that window was marked read, never entered the comment window (`created_at > cursor`) and was never answered.

Steps:

1. Open issue X (by `alice`) and issue Y (by `bob`) in an allowlisted repository and wait until the channel has read X.
2. Start a fresh wall-clock second T. In it, `alice` comments `@qwen-bot ...` on X (notified normally) and `bob` comments `@qwen-bot ...` on Y with the notification held back.
3. Wait until the channel marks notifications read with `last_read_at = T`, so the cursor is T.
4. Release Y's notification with `updated_at = T`, as a late GitHub delivery would.
5. Wait 8 s and check the replies on Y.

Expected: Y's comment is answered once, and the cursor file records the comments of second T that the window read and the threads whose notification of second T it listed.

## Setup

- A built worktree (`pnpm install`, `npm run build`, `npm run bundle`) runs the real `qwen serve` daemon, channel worker, `GithubAdapter` and Octokit.
- A local fake GitHub REST server stands in for GitHub. It models the bot's inbox (unread state, `reason`, `updated_at`, `last_read_at`), `GET /notifications` with `since`, `PUT /notifications`, issue comments with `since` on `updated_at`, reactions and issues. It also lets the test hold a notification back and release it later. Timestamps have whole seconds, like GitHub's.
- An OpenAI-compatible scripted model makes the replies, so no paid model is called.
- The daemon gets an isolated `HOME`/`QWEN_HOME`, a stub `gh`, and no proxy variables, so nothing reaches github.com.
- The run covers the basic group B0–B12 and this scenario (B13), once on `main` (`cbc6164c26`) as the baseline and once on the branch. It ran on a Linux aarch64 host.

## Results

- `main`: B13 is a FINDING. Y is never answered: its notification is listed again on every poll, but the comment stays out of the window. Of the other basic scenarios, 12 pass and B11 (a mention added by editing an older comment) is a FINDING by design.
- Branch: B13 passes. Y is answered once, and the cursor saves `boundaryComments {at: T, keys: [X's comment], threads: [X]}`. The other basic scenarios match `main`.

GitHub requests on the branch differ from `main` only by:

- the reply on Y and its 👀 reaction;
- `listComments` for Y starting a second before the cursor;
- eight fewer `GET /issues/N`: Y's notification was never read before (`last_read_at` is null), so on `main` every poll that finds no comment to take falls through to the first-contact body read, while on the branch Y's comment is taken.

The channel events show one more `duplicate` skip. Y's notification stays unread until a newer window is marked read, so Y is read again, and the dedupe ring stops its comment.

## Unit coverage

- `cd packages/channels/github && npx vitest run`: all tests pass. The new cases are under `comments created in the cursor second`, `validateCursor` and `transient per-thread GitHub errors`.
