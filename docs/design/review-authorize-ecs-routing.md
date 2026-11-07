# Route the /review and /resolve permission gate to the ECS pool

[English](review-authorize-ecs-routing.md) | [简体中文](review-authorize-ecs-routing.zh-CN.md)

Status: Implemented in the accompanying PR.

## Problem statement

Every `@qwen-code /review` and `@qwen-code /resolve` command first passes through
the `authorize` job in `.github/workflows/qwen-code-pr-review.yml`. That job is
the write-permission gate: it reads the triggering principal from the event
metadata and calls one read API
(`repos/{owner}/{repo}/collaborators/{principal}/permission`). It runs no agent,
checks out nothing, and processes no pull-request content.

Despite being a four-second API-only job, `authorize` was observed waiting
**3h10m** in the GitHub-hosted queue before it could start (PR #15286, run
42201221971, 2026-11-06: created 10:15:08Z, `authorize` started 13:25:52Z). The
self-hosted ECS pool was idle at the time. Because `authorize` is a hard gate,
nothing downstream — including the conflict-resolution agent — even enters the
queue until it finishes, so the hosted backlog stalls the whole command.

## Current state

The `authorize` runner routing is:

```
(github.repository == 'QwenLM/qwen-code' &&
 vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true' &&
 github.event.pull_request &&
 github.event.pull_request.head.repo.full_name == github.repository)
  && ECS || ubuntu-latest
```

The same-repo guard reads `github.event.pull_request.head.repo.full_name`. That
field exists on the PR-payload events (`pull_request_target`,
`pull_request_review`, `pull_request_review_comment`) but **not** on
`issue_comment` or `workflow_dispatch`:

- `issue_comment` payloads carry `github.event.issue` (with a `.pull_request`
  URL sub-object), never a top-level `github.event.pull_request`.
- `workflow_dispatch` payloads carry only the dispatch inputs.

So for the two command triggers the guard short-circuits to false and the job
falls through to `ubuntu-latest` on **every** `/review` and `/resolve`, regardless
of how idle the ECS pool is. This is a routing blind spot, not a deliberate
hosted pin.

## Goals

- Route the `authorize` gate to the persistent ECS pool for the command triggers
  that currently fall through to hosted, so a congested hosted queue no longer
  stalls `/review` and `/resolve` at the gate.
- Preserve the existing fork isolation for events that carry a PR payload.
- Keep the change minimal and reversible (the `MAINTAINER_ECS_RUNNER_DISABLED`
  kill switch continues to force hosted).

## Scope boundaries

- **In scope:** the `authorize` job's `runs-on` expression and its explanatory
  comment; a meta-test pinning the new routing.
- **Out of scope:** the `resolve-pr` agent job and the `publish-resolution` job.
  Both are deliberately pinned to `ubuntu-latest` for ephemerality (the agent
  runs untrusted PR content with `tools.sandbox: false`, and the publish job
  holds the push PAT on a runner that never executed the agent). Moving either
  to the persistent pool is a separate security question — see
  [autofix-gate-runner-isolation.md](autofix-gate-runner-isolation.md) and the
  `resolve-pr` settings-block rationale. This change does **not** make the whole
  `/resolve` pipeline hosted-free; it removes the multi-hour wait at the gate.

## Proposed solution

Extend the routing condition with two disjuncts for the payload-less command
events:

```
(github.repository == 'QwenLM/qwen-code' &&
 vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true' &&
 ((github.event.pull_request &&
   github.event.pull_request.head.repo.full_name == github.repository) ||
  github.event_name == 'issue_comment' ||
  github.event_name == 'workflow_dispatch'))
  && ECS || ubuntu-latest
```

Behavior by event:

| Event                                   | Before | After   |
| --------------------------------------- | ------ | ------- |
| `pull_request_target` in-repo           | ECS    | ECS     |
| `pull_request_target` fork              | hosted | hosted  |
| `pull_request_review(_comment)` in-repo | ECS    | ECS     |
| `pull_request_review(_comment)` fork    | hosted | hosted  |
| `issue_comment` (/review, /resolve)     | hosted | **ECS** |
| `workflow_dispatch`                     | hosted | **ECS** |

Only the last two rows change.

The gate step also opens with the sibling jobs' gh config pins —
`export GH_HOST=github.com` plus a private, guarded `GH_CONFIG_DIR` — so the
PAT-bearing API call cannot be rerouted through the pool's shared, writable
`~/.config/gh` (see Risks).

## Design decisions and rationale

1. **Safe on the persistent pool because no fork code reaches the job.** The
   threat that keeps fork-triggered work off persistent runners is a job
   _executing_ attacker-authored branch code and leaving a survivor that attacks
   later jobs on the same host. `authorize` executes nothing from the PR: it
   reads event metadata (a username) and calls one read API. The comment body is
   matched only in GitHub-side `if:` expressions, never passed to the shell.
   Routing it to ECS therefore does not widen the fork attack surface.

2. **Matches the repo's existing pattern.** `qwen-autofix.yml`'s `route` and
   `review-scan` jobs already apply the rule "no PR payload → no fork code →
   persistent pool" to their API-only steps: their routing sends every
   non-`pull_request`/`pull_request_review` event to ECS. `review-scan` does so
   while loading `CI_DEV_BOT_PAT` (`route` uses only the read-only
   `github.token`). `authorize` is the same shape (API-only, loads a bot PAT),
   so it follows the same rule.

3. **Surgical, not a rewrite.** The same-repo guard is retained verbatim for the
   PR-payload events; the two new disjuncts only cover events that have no
   `github.event.pull_request` to guard on. The hosted fallback and the ECS kill
   switch are unchanged.

## Constraints

- The fork guard for PR-payload events must remain byte-identical in behavior.
- `MAINTAINER_ECS_RUNNER_DISABLED=true` must still force every event to hosted.
- The repository guard (`github.repository == 'QwenLM/qwen-code'`) must remain,
  so forks of the repository do not route to a pool they cannot access.

## Risks

- **The command triggers are open to any GitHub user.** The `issue_comment`
  disjunct makes the gate fireable by anyone commenting `@qwen-code /review` or
  `@qwen-code /resolve` on a fork PR; `workflow_dispatch` still requires write
  access. The gate runs none of that PR's content, so this adds no execution
  path — but it does put `CI_BOT_PAT` and this job's `should_review` decision on
  the shared pool for a run an outsider scheduled, and `should_review` is the
  authorization fact every downstream job consumes without re-deriving it. Both
  are the same shared-host class tracked in
  [autofix-gate-runner-isolation.md](autofix-gate-runner-isolation.md); this
  bullet records the widening so it is not mistaken for an unchanged trigger
  set.
- **PAT exposure on a shared host.** `authorize` loads `CI_BOT_PAT`. On the
  persistent pool a co-resident survivor from an earlier job could in principle
  target it — in particular through the pool's shared, writable `~/.config/gh`:
  a planted `http_unix_socket` there would receive the PAT and could forge the
  permission response that downstream jobs consume as `should_review`. The
  step therefore opens with the same gh pins as `qwen-autofix.yml`'s
  `route`/`review-scan` — `export GH_HOST=github.com` plus a private, guarded
  `GH_CONFIG_DIR` (a failed `mktemp` exits 1; the gate fails closed) — and a
  meta-test pins them. **With those pins** the exposure is the one already
  accepted for `review-scan` (which loads `CI_DEV_BOT_PAT` on the same pool;
  `route` loads only the read-only `github.token`), and `authorize` is strictly
  lighter (one read API, no checkout). Without them the parity would not hold.
  The structural close for PAT-bearing steps on the shared pool is tracked
  separately in
  [autofix-gate-runner-isolation.md](autofix-gate-runner-isolation.md); this
  change does not regress it.
- **Residual hosted queue downstream.** `resolve-pr` and `publish-resolution`
  still run on hosted, so a saturated hosted pool can still delay the agent and
  the push. This change removes the gate wait only; it is not a claim that
  `/resolve` becomes queue-free.

## Validation plan

- A meta-test in `scripts/tests/qwen-pr-review-workflow.test.js` pins the exact
  `authorize` `runs-on` expression and asserts the security invariants: command
  events reach ECS; the same-repo fork guard, the hosted fallback, and the ECS
  kill switch are all still present; the job stays checkout-free (no `uses:`
  step); its step inventory is exactly the one permission step with no `${{`
  spliced into any `run:` body; and the step carries the gh config pins
  (`GH_HOST=github.com` plus a private, guarded `GH_CONFIG_DIR`).
- Mutation witnesses (verified locally): reverting the expression to the old
  same-repo-only form, adding a `uses:` step, adding a run-only second step, or
  removing the gh config preamble each makes the test fail; restoring passes.
- Full `qwen-pr-review-workflow.test.js` (271 tests) and
  `qwen-resolve-workflow.test.js` (55 tests) pass.

## Acceptance criteria

- `authorize` routes `issue_comment` and `workflow_dispatch` to the ECS pool when
  the repository guard and kill switch allow.
- PR-payload events keep their existing same-repo/fork routing.
- The gate step keeps the gh config pins and the checkout-free / no-splice
  invariants; the pinning meta-test kills a mutation of each.
- No other job's routing changes.

## Open questions

- Whether to also move the `resolve-pr` agent to ECS behind a working docker
  sandbox (with dry-run evidence) is a separate experiment; it is explicitly not
  decided here.
