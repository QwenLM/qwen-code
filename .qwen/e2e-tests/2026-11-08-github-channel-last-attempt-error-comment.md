# GitHub channel: error comment only after the last attempt

Date: 2026-11-08

## Scenario

A failed public task is run again on a later poll, up to three attempts in all. Before this change, the channel posted `⚠️ Failed to process this request. Please re-mention the bot to retry.` on the first failure. The automatic retry could then answer anyway, right after the comment that had asked the user to mention the bot again.

Steps (scenario R7):

1. Open an issue in an allowlisted repository.
2. Make the scripted model answer the first main request for this thread with HTTP 400.
3. `alice` comments `@qwen-bot S-R7 explain the retry policy`.
4. Wait for any bot comment on the issue, then 10 s more, and read the bot's comments.

Expected: the issue gets the answer only, with no error comment before it. The error comment is posted only when the last attempt fails, and that case is covered by unit tests.

## Setup

- A built worktree (`pnpm install`, `npm run build`, `npm run bundle`) runs the real `qwen serve` daemon, channel worker, `GithubAdapter` and Octokit.
- They run against a local fake GitHub REST server (bot inbox, notifications, issue comments, reactions, issues) and a scripted OpenAI-compatible model that can fail a matching request with a chosen HTTP status. No paid model is called and nothing reaches github.com.
- The channels poll every second (`pollInterval: 1000`), so the retry runs within the 10 s wait; at the default 60 s it would come a minute later.
- The run covers the basic group (B0–B12) and the reliability group (R1–R8), once on `main` (`94a1919bd1`) and once on the branch, on a Linux aarch64 host.

## Results

- `main`: R7 is a FINDING. The bot's comments are the error comment followed by `Answer S-R7: ...`; the model got the failed request, then the answer.
- Branch: R7 passes. The only bot comment is `Answer S-R7: ...`; the model requests are the same.
- The other 21 scenarios (B0–B12, R1–R6, R2b, R8) have the same result on both: 20 PASS, and B11 (an edited comment) is a FINDING by design.
- GitHub requests differ only by the missing error comment (`POST .../comments` 23 → 22), apart from the number of notification polls.

## Unit coverage

- `cd packages/channels/github && npx vitest run`: all tests pass. The tests for this change cover:
  - no comment before the last attempt;
  - one comment on the last attempt, including after a crash left that attempt running;
  - a retried attempt that succeeds;
  - a last attempt whose post fails;
  - a final-publication failure on the last attempt;
  - tasks saved by an older version (the existing `reuses an existing inbound task record instead of creating a duplicate`);
  - a gone-session fallback, which posts one public comment on its last attempt, like any public task;
  - the private paths, which post no public comment even on the last attempt (both under `bound-session delivery`).
