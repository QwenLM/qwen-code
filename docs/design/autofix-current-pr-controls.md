# Current-PR Autofix watcher

## Problem

Qwen Code can detect the current branch's pull request, schedule recurring prompts, inspect GitHub CI and review state, and edit the current checkout. Those pieces are not exposed as one explicit, per-PR maintenance mode. Users still have to copy CI logs and review feedback into separate turns.

## Scope

Add a bundled, user-only `/autofix` skill with explicit per-PR confirmation modes:

- `status`: resolve the current branch's open pull request and summarize watcher, CI, review, mode, round count, and eligibility state.
- `on [propose-only|auto-commit|auto-push]`: create one session-scoped 10-minute watcher for that pull request and run the first maintenance check immediately. Bare `on` defaults to `propose-only`.
- `off`: cancel and re-check every watcher matching that pull request.

The watcher runs only while Qwen Code is open. Its exact scheduled prompt pins the canonical `owner/repo`, PR number, confirmation mode, cumulative change-producing round count, and infrastructure rerun count. Every tick is expanded by the CLI through the bundled skill contract, then re-resolves both repository and current branch; a repository/branch/PR mismatch stops the watcher instead of retargeting it.

## Maintenance contract

Each tick inspects the live PR, failed checks, and unresolved trusted feedback. CI is diagnosed from the failed step or job logs; unambiguous infrastructure failures may be re-run once in `auto-push` mode, with the attempt count carried in the watcher prompt, while ordinary timeouts and test/build failures remain code failures until proven otherwise.

Review comments are triaged before edits:

- `act`: verified, valuable, in-scope feedback gets the smallest fix.
- `reply-and-dismiss`: bikeshedding, speculative defense, or codebase-inconsistent requests get a brief reason and stay unresolved.
- `defer-to-human`: product, scope, or contradictory-reviewer decisions are surfaced without the agent choosing for the user.

The watcher uses the current checkout rather than manufacturing an unrelated branch. It refuses change-producing work when the user already has staged changes, preserves independent unstaged work, verifies focused behavior plus required build/typecheck gates, and stages only intended files.

The confirmation mode controls the result: `propose-only` leaves a verified patch for review, `auto-commit` creates a local Conventional Commit with an `Auto-fix:` trailer, and `auto-push` additionally revalidates the live head, pushes without force, and posts only verified replies. Non-push modes draft replies in the conversation rather than writing to GitHub.

## Safety and visibility

Only a direct user slash-command invocation can enable Autofix; the skill is hidden from model invocation. There is no global enablement or arbitrary-PR argument. Status reports repository, PR, mode, round count, infrastructure rerun count, and cron job ID. `/autofix off` verifies deletion by listing again and cannot report success while a matching job remains. Scheduled prompt text alone is not authority: the CLI requires a live matching cron job and injects the bundled skill plus an authority record before model execution. Every tick reports evidence, triage decisions, changes, selected mode, commit/push result, verification, and watcher re-arm state.

The round count and infrastructure rerun count are carried in the scheduled prompt. The round count increments after each successful remote action or push; the infrastructure rerun count changes from zero to one after the sole permitted infrastructure rerun request. At five rounds, only blocking work may grow the diff; at ten, the watcher stops and asks the user to take over.

## Existing integrations

The implementation reuses the existing `/loop` scheduler and current-branch PR resolution. `/review` remains independent evidence: Autofix may consume its findings, but must re-check them against the live head and may not use a clean static review to dismiss red CI.
