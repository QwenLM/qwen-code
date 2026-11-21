# GitHub channel: stored replies are retried while the channel runs

Date: 2026-11-10

## Scenario

When GitHub's rate limiter refuses the final reply and the in-call retries do not get it through, the channel stores the reply in its pending-delivery file, and the task waits in `reply_pending`. Before this change, only the pass at channel start sent it again. A daemon that kept running never posted it.

Steps (scenario R1):

1. Open an issue in an allowlisted repository.
2. Make the fake GitHub answer the next three `POST .../issues/<n>/comments` for that issue with a primary rate limit: 403, `x-ratelimit-remaining: 0`, and a reset two seconds ahead.
3. `alice` comments `@qwen-bot S-R1 summarize the open bugs please`.
4. Wait for the three refused attempts. Then wait until the pending-delivery file holds the reply.
5. Keep the daemon running. Wait up to 400 s for the reply to appear on the issue.

Expected:

- The reply is posted while the channel runs, on the first poll after the five-minute minimum wait.
- The pending record is removed.
- After the later restart in R8, the issue still has exactly one reply.

## Setup

- A built worktree (`pnpm install`, `npm run build`, `npm run bundle`) runs the real `qwen serve` daemon, the channel worker, `GithubAdapter` and Octokit.
- They run against two local fakes:
  - a fake GitHub REST server (bot inbox, notifications, issue comments, reactions, issues, fault injection);
  - a scripted OpenAI-compatible model.
- No paid model is called, and nothing reaches github.com.
- The channels poll every second (`pollInterval: 1000`). The fake sends `x-poll-interval: 1`. Since #16741 the channel honours that header as a floor, and the fake's earlier `60` made every arm poll once a minute and time out.
- The run covers the basic group (B0–B12) and the reliability group (R1–R8). It ran once on `main` (`d8935039a1`) and once on the branch, on a Linux aarch64 host.
- The branch build is `d3a53acccf`. The final commit differs from it only in comments, docs, tests and the text of the stopped-pass log line.

## Results

| | `main` | this branch |
| --- | --- | --- |
| R1, reply while running | none within 400 s, pending record kept | posted 300.5 s after the refusal, pending record removed |
| R1, after the R8 restart | posted by the pass at start, one reply | still one reply |
| Other scenarios | 20 PASS, B11 FINDING (by design, #16588) | identical |

Other observations:

- R2b's reply, refused about a minute before R8 restarts the daemon, is posted by the pass at start on both arms. Its wait had not ended.
- The GitHub requests match per endpoint, including `POST .../comments` (22 on each arm). The only difference is the number of notification polls: the branch finishes R1 100 s sooner.
- The model got 19 requests on each arm.

## Unit coverage

`cd packages/channels/github && npx vitest run` passes. The tests for this change sit under `publication contract`, in `stored replies while the channel runs` and in the table tests of the stop rule. They cover:

- the schedule: the minimum wait, `retry-after`, the budget reset, the doubling and its reset, and the hour cap;
- the trigger: no pass from a poll that cannot list notifications, a pass from a poll that fails after the list, and no pass while the channel is stopped;
- the stop rule for every pass: a 401 or a refusal keeps that reply; a 5xx, a network error or a bare 429 drops it as ambiguous; a 404, a permission 403 or a 422 drops it and the pass goes on;
- no second send of a reply the running channel posted or sent ambiguously, including when the state directory stops taking writes, and after a reconnect.
