# Verify-PR watch mode

[English](verify-pr-watch.md) | [简体中文](verify-pr-watch.zh-CN.md)

Status: implementing with this change.

## Problem

A maintainer running `/verify-pr <n> --publish` has to notice a new push and
start the next round by hand. The repository already ships the two halves of an
automatic trigger — a PR probe that prints only transitions since its last run,
and a scheduled task whose gate runs a shell command outside the model — but
nothing connects them to the verification round, so every maintainer rebuilds
the same cron incantation and re-learns its failure modes.

## Current state

- `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo>` (PR #15057) keeps
  a cursor and prints only new transitions: `head_moved_externally` when the
  head moved, `ci_failed` once per attempt, comments, merged/closed. Silence
  means nothing happened.
- `cron_create` accepts `gate` (PR #15211): the scheduler runs that shell
  command before each fire, **outside the model**. No output skips the fire
  entirely; output delivers the JSON as data. The gate must be recurring, and a
  current-session task must be durable.
- Neither half knows about `/verify-pr`; the skill never mentions a watch, so
  a maintainer asking for one gets an improvised cron whose gate command may
  point at a binary that lacks the probe, whose prompt re-verifies the same
  head after a restart, and whose task outlives a merged PR.

## Proposal

Teach the skill a `--watch` mode. It is composition, not new plumbing: the
probe stays a CLI command and the trigger stays a gated scheduled task.

- `/verify-pr <n> --watch` creates one recurring gated task for that PR, then
  keeps behaving as a normal round. Triggered rounds default to `--publish`
  (the maintainer asked for a standing watch, not for one comment).
- Task shape: cron every 2 minutes; gate = `node
<clone>/scripts/verify-pr-watch-gate.mjs <n> --repo <owner>/<repo> --cli
<absolute qwen>`; `recurring: true`, `durable: true`, `sessionMode:
"current"`. The wrapper runs the probe and forwards only `resync` (head
  moved) and `stop`; a comment or a failed check yields `action: "fix"` and is
  dropped, because the scheduler hands every non-empty gate output to the
  model and the prompt cannot un-start the turn.
- The prompt consumes what the wrapper forwards: `head_moved_externally` → run
  the round for that sha; `stop` (merged/closed) → delete the task and stop.
- The wrapper's `--check` refuses to install when `.qwen/tmp` already holds
  `autofix-pr-<n>-gate.json` or `autofix-pr-<n>-state.json`: one cursor serves
  one consumer, so a second watch on the same PR would take the head moves and
  `stop` the first one needs.
- Dedupe lives in a state file (`.qwen/tmp/verify-pr-watch-<n>.json`): the last
  sha this session verified, plus an in-flight marker. A fire for a sha already
  verified, or while a round is in flight, is ignored without a model turn.
  Write the sha **before** starting the round, so a round that dies still does
  not replay the same head.

## Design decisions

1. **Skill, not a new CLI.** The probe and the gate already exist; the missing
   piece is the contract between them, and that contract is prose the agent
   follows. A new command would duplicate the scheduling half it cannot own.
2. **Absolute CLI path in the gate.** A gate runs in a fresh shell, and the
   `qwen` on `PATH` may predate the probe. The skill says to resolve the path
   from `which qwen` and verify `autofix-pr snapshot --help` succeeds; a binary
   without it means the task can never fire, and the skill must refuse rather
   than schedule a broken gate.
3. **No model turn while quiet.** Silence from the gate skips the fire. This is
   the whole point: the watch costs one `gh api` per tick, and the 110-minute
   round happens only when a head actually moved.
4. **Stop on `merged`/`closed`.** A watch outliving its PR keeps probing a dead
   endpoint and can wake the model for nothing; `stop` deletes the task.
5. **Filter in a wrapper, not in the prompt.** The gate's output decides whether
   a turn starts; by the time the prompt reads it, the turn has already begun.
   `scripts/verify-pr-watch-gate.mjs` is therefore testable code, and the skill
   points at it rather than at the raw probe.
6. **Refuse coexistence instead of pretending to multiplex.** The probe keeps
   one cursor per PR, and a prepared `autofix-pr` watch also suppresses heads
   through `knownHeads`. Verification-owned state would require a probe flag
   that does not exist, so the watch refuses instead: saying "unsupported"
   beats two watchers silently starving each other. A read-only check is racy —
   two sessions can both pass it before either probe has run — so setup takes an
   atomic claim (`.qwen/tmp/verify-pr-watch-<n>.owner.json`, created with `wx`).
   It is released on stop or a failed task creation; a claim left by a dead
   setup is released explicitly with `--release` rather than taken over, because
   judging staleness from a timestamp is itself the same race.

## Scope boundaries

- Not a GitHub Actions change: the CI verify lane stays comment-triggered.
- Not a webhook: no repository-level event subscription, no forwarder process.
- No new daemon route or setting. `cron_*` and the probe are used as shipped.
- Repo-wide watching (`qwen review watch-repo`) is documented as the way to
  watch _all_ open PRs, but `--watch` itself stays per-PR: a verify round is
  per-PR by nature.

## Files affected

- `.qwen/skills/verify-pr/SKILL.md` — the `--watch` contract and its guardrails.
- `scripts/verify-pr-watch-gate.mjs` — the gate wrapper: forwards only `resync`
  and `stop`, and refuses to install over another consumer's probe state.
- `scripts/tests/verify-pr-watch-gate.test.js` — the filter's five outcomes and
  the coexistence checks.
- `scripts/tests/qwen-triage-workflow.test.js` — assertions pinning the wrapper
  command, the filter, the ownership check, and the capable-binary refusal.
- `docs/design/verify-pr-watch.md` + `.zh-CN.md` — this document.
- `.qwen/e2e-tests/verify-pr-watch.md` — the test plan and its results.

## Risks

- A watch can outlive the session that created it (`durable`), so the state
  file and the `stop` rule are what keep it from becoming a zombie.
- The gate runs `gh` and must be authenticated; an unauthenticated runner makes
  the gate fail, which the scheduler reports once per streak. The skill says to
  confirm `gh auth status` before scheduling.
- Every fire costs one probe; a 2-minute cadence is ~720 calls/day per PR,
  well inside the API budget but not free — the skill names the tradeoff rather
  than hiding it.

## Validation plan

- Probe behavior on a real PR: quiet when unchanged, `head_moved_externally`
  after a head change, quiet again.
- Task creation on a capable build: `cron_create` accepts the gate, refuses a
  one-shot, and rejects a gate over the 2048-character cap.
- Degradation: a binary without `autofix-pr` must make the skill refuse and say
  what to upgrade.
- Stop rule: a merged PR yields `stop` and the task is deleted.

## Acceptance criteria

- `/verify-pr <n> --watch` produces a task whose gate prints nothing while the
  PR is quiet, and one JSON line when the head moves.
- A second fire for the same sha produces no second round.
- The task is removed on `merged`/`closed`, or via `cron_delete`.
- Nothing is scheduled when the probe or `gh` is unavailable.
