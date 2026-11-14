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
- Dedupe lives in a state file (`.qwen/tmp/verify-pr-watch-<n>.json`), owned
  by `scripts/verify-pr-watch-state.mjs` (`--start` / `--complete` /
  `--release`) since PR #17185 — rounds no longer hand-write the JSON, whose
  completion write two consecutive rounds on PR #16866 skipped, leaving the
  file two heads stale. The file holds three lists, `verifiedHeads`,
  `inFlightHeads` and `deferredHeads`, each entry carrying its own head,
  round, artifact directory and timestamp; the top-level
  `verifiedHead`/`previousHead` fields are a compatibility view over the
  most recent completions.
  Verified heads dedupe **as a list**: a fire for any sha already verified
  is ignored without a model turn, not just the most recent one, and the
  bound-delivery design dedupes redelivered head-change events against it.
  **One round runs per PR at a time**: while any round is in flight, a fire
  for a different head is refused — and **recorded as deferred**, not
  dropped. The probe's cursor advances to the new head in the very call
  that emits the transition, so no second event will arrive; the deferred
  list is that head's only delivery. `--complete` and `--release` print
  the deferred heads, and the watch prompt starts the latest one as the
  next round; starting a deferred head supersedes every head deferred no
  later than it (events arrive in push order), and a redelivery updates
  the entry in place — keeping its original `deferredAt`, so a redelivered
  older head cannot outrank a newer push — so the tail stays push order,
  not write order. A redelivery of the in-flight head itself is simply
  skipped: the running round answers it. The local recipe's clone, base copy, proxy files and
  container name are per PR, so overlapping rounds would clobber each
  other; the CI lane serialises the same way with its per-PR concurrency
  group. Every read-modify-write holds an exclusive lock file beside the
  state file, so two concurrent invocations cannot each build state from
  the same pre-existing file and erase each other's entry. The lock carries
  an ownership token and is released only by its creator, so a holder whose
  lock was manually removed and re-created cannot delete the new owner's
  lock; a killed invocation's `.lock` is removed manually, never reclaimed
  by timestamp. The state root resolves from the script's own clone (its
  main worktree), not the caller's cwd, so a round whose session directory
  is its PR clone still writes the trusted clone's state; `--state-root`
  overrides it and must be an absolute path. A default root that is not a
  git worktree — the container recipe's `/trusted-scripts` mount resolves
  it to `/` — is refused (exit 2) rather than writing a shadow state the
  host never reads; the explicit `--state-root` accepts any directory. A
  start whose `--repo` differs from the recorded one is refused too: a PR
  number is only unique within its repository.
  `--complete` must repeat the `--start` round: it removes only its own
  round's in-flight entry (matched by head **and** round) and upserts its
  verified entry. A completion whose round differs from the in-flight
  marker is refused, and a completion from a round older than the one that
  already answered for the head is refused as stale — neither strands the
  real marker nor overwrites the newer verdict and comment id.
  `inconclusive` releases the marker without filing the head as verified
  and **re-defers the head**, so the completion output names it again —
  the start call already consumed its only event. The watch prompt retries
  it once; a second inconclusive is reported under _Not covered_, not
  looped. A head that already keeps an earlier verdict is not re-deferred:
  it keeps that verdict and its dedup. A late completion for a _different_
  head changes the top-level view but erases no verification. A corrupt state body is refused (exit
  1), never silently rewritten from empty lists. `--start` writes the sha
  **before** the round begins, so a round that dies still does not replay
  the same head. A round that dies after `--start` is recovered with
  `--release --head <oid>` (the head is mandatory), which removes only the
  named head's in-flight entry without recording a verdict, names any
  deferred heads, and refuses a head with no entry — including when no
  markers exist at all, so a release aimed at the wrong state root cannot
  read as success. Under one-round-per-PR the blocking marker may belong to
  a different head than the one being started: recovery releases the head
  the refusal names. This mirrors the gate's recovery for a dead claim.

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
- `scripts/verify-pr-watch-state.mjs` — the state file's owner since PR #17185:
  per-head `verifiedHeads`/`inFlightHeads`/`deferredHeads` lists, atomic
  writes, UTC stamps, and the `--start` / `--complete` / `--release`
  contract.
- `scripts/tests/verify-pr-watch-state.test.js` — the dedup, completion,
  release and migration cases, including the concurrent-head witnesses.
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
- A head pushed while a round is in flight is refused, recorded as deferred,
  and named by the running round's `--complete` output; starting the latest
  named head verifies it without a manual probe or a second event.
- An `inconclusive` completion leaves the head startable; a release for a
  head with no marker is refused, not a silent success.
- The task is removed on `merged`/`closed`, or via `cron_delete`.
- Nothing is scheduled when the probe or `gh` is unavailable.
