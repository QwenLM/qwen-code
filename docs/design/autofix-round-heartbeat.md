# Autofix round heartbeat: live progress on the PR during a round

## Problem statement

A review-address round can run for a long time: the `Triage and address`
step alone has a 130-minute timeout (120-minute agent budget), and a round
that reaches the repair path can occupy most of the job's 330 minutes.
During all of that, the PR shows exactly one static signal — the
`<!-- autofix-status -->` comment reading "🔄 AutoFix is working on this PR —
round N/M", posted by `Post autofix status comment` and not touched again
until `Finalize autofix status comment` runs at the very end.

Observed on PR #9739 (2026-08-22/23): round 2 was dispatched at 00:30 UTC
and ran ~1.5h before posting anything. To a maintainer watching the PR, a
healthy long round and a dead one were indistinguishable; the only recourse
was opening the Actions run and digging through logs. The gap: **no
liveness or progress signal reaches the PR itself between round start and
round end.**

## Current state

- `Post autofix status comment` (`qwen-autofix.yml` ~L4709) upserts the
  status comment (one per PR, PATCHed each round) and hands
  `comment_id` to finalize via step outputs. It runs in the PAT-bearing
  context (`GITHUB_TOKEN: secrets.CI_DEV_BOT_PAT`).
- `Triage and address` (~L4750) runs `run-agent.mjs`, which streams every
  model/tool event into `${WORKDIR}/agent.log`. This step deliberately
  holds **no PAT** (its own comment records that) — the agent executes
  PR-branch content and must not see the bot credential.
- `Finalize autofix status comment` (~L6008, `if: always()` minus stale /
  dry-run) PATCHes the same comment to its terminal text.
- `Clean up autofix workdir` (last step, `if: always()`) removes
  `${WORKDIR}`; `Reset autofix workspace` (~L3603) removes it again at the
  start of the next same-PR run and age-sweeps `/tmp/autofix*` dirs.
- The "Watch live progress" link points at the run
  (`actions/runs/<run_id>`), one click above the in-progress job's log.
- Trust staging (`Stage trusted schema gate and agent runner`, ~L3625):
  scripts invoked after `Prepare branch and feedback` has switched the
  working tree to the PR branch must come from staged copies in
  `RUNNER_TEMP` taken from the trusted base checkout — the working-tree
  copy at that point is fork code. Two doctrines exist: staged copy +
  sha256 digest re-verified at invocation, and content-in-`GITHUB_OUTPUT`
  heredoc for PAT-bearing steps that run after the agent.

## Proposed change

### A. Heartbeat that keeps the status comment live

At the end of `Post autofix status comment` (PAT already in env, comment id
known), start a detached background loop that every ~10 minutes PATCHes the
same status comment with the same bilingual "working" text plus one
progress line:

> ⏱ Running for 42 min · agent active 3 min ago
> (⏱ 已运行 42 分钟 · agent 最近活动在 3 分钟前)

- **Elapsed**: wall-clock since round start.
- **Agent activity**: mtime of `${WORKDIR}/agent.log` — no parsing, no
  dependency on event shape. Before the file exists: "agent starting".
  The thinking phase can legitimately go quiet for up to run-agent.mjs's
  10-minute stream-idle window; the displayed figure is honest, not
  interpreted.
- The loop survives step boundaries (stdout/stderr redirected to
  `${WORKDIR}/heartbeat.log`, stdin from `/dev/null`, launched via
  `setsid` so it owns a process group on the persistent pool).

Lifetime and kill discipline (the persistent self-hosted pool makes
orphan loops unacceptable):

1. **The heartbeat is bounded to the sandboxed agent phase.** The
   `Verification gate` step is the first one that runs branch code ON THE
   HOST (the agent phase sandboxes it in docker), so it kills the loop
   before launching the gate. The pulse covers the longest phase (the
   ≤130-minute agent step); the comment holds its last tick through
   gate/repair and finalize flips the terminal text.
2. Kill targets travel through **expression context**: the launch records
   `$!` as a `heartbeat_pid` step output, and the gate / finalize /
   cleanup kill that value — routed through each killer's step-level
   `env:` block (the `STATUS_ID` shape) so the runner sets it as data:
   a run-body interpolation would substitute a forged output BEFORE
   the shell parses, so it would execute as shell syntax in the
   consuming shell (R16-1). The kills cover the pid, its process
   group, AND its session:
   each tick's `timeout 60 gh` subtree runs in its own process group
   (coreutils `timeout` default) under the loop's setsid session, so a
   group/pid kill alone leaves it alive holding the PAT for up to 60s.
   A pid read from a WORKDIR file would be an
   untrusted kill target — the agent's docker sandbox mounts the host
   `/tmp` on the same path and runs as the same user, so branch code the
   agent executes can plant any value there. The on-disk
   `${WORKDIR}/heartbeat.pid` survives for diagnostics and the loop's own
   self-checks only. Every kill is additionally **lifecycle-confirmed**:
   the launch records the loop's start time (`heartbeat_start_ticks`,
   field 22 of `/proc/<pid>/stat`) and a killer signals only a pid whose
   stat still carries exactly that value — a pid reused between launch
   and kill carries a different start time and a dead pid has no stat,
   so a failed check kills nothing.
3. `Finalize autofix status comment` touches `heartbeat-stop`, kills
   (lifecycle-confirmed), and **drains the in-flight stamp before** its
   own PATCH: each tick stamps `heartbeat-tick-inflight` with its start
   epoch around its gh call (bounded to 60s) and removes it after, and
   finalize waits until the stamp is absent or older than the 65s
   completion bound. Killing the client cannot cancel a PATCH the server
   already accepted — the fixed 2s sleep this replaced was
   probe-refuted: a stale WORKING committed after the terminal text and
   flipped the comment back to live-looking.
4. `Clean up autofix workdir` (`always()`) kills again as belt-and-braces.
5. `Reset autofix workspace` does NOT kill: a cross-run pid would have to
   come from the untrusted file class. Wiping `WORKDIR` removes the pid
   file, and the loop self-exits at its next identity self-check when
   the next round reuses the orphan's host; cross-host, nothing rewrites
   the pid file, so a crash-leftover orphan keeps pulsing its stale body
   until the age cap — alternating with the live round's bodies and
   overwriting later rounds' terminal text within one interval of
   finalize. Worst same-host case: one stale "working" tick already past
   its identity check, re-PATCHed by the new round. The cross-host
   window is an accepted residual risk (below), bounded by the age cap.
6. Self-exit bounds inside the loop: stop if the pid file no longer holds
   the loop's OWN pid — an identity check, not an existence check,
   because `WORKDIR` is PR-scoped and the next round recreates
   `heartbeat.pid` at the same path, which an existence check would let
   the orphan pass (reading the file here is safe: the loop only
   self-identifies, it never kills anything); stop if `heartbeat-stop`
   exists, or at a hard age cap set just past the 330-minute job
   envelope (a live round's loop dies at the gate or finalize well inside
   the job, so only a crash orphan ever reaches the cap — and the cap
   bounds how long that orphan holds the PAT in `/proc/<pid>/environ`);
   each tick's `gh` call is wrapped in `timeout 60` so a
   black-holed connection cannot stall the loop past the cap.

The kill logic is inline in the yml (4-6 lines each), **not** a script
call: the killers run in PAT-bearing or post-agent steps, and executing a
script from the PR-branch working tree there is exactly the swap hazard
the staging doctrine exists to prevent.

### B. Deep-link the "Watch live progress" anchor to the job

`Post autofix status comment` resolves the numeric job id of the running
`review-address` matrix leg (jobs listing of the current run attempt,
matched by name prefix `review-address (<pr>,`) and links
`actions/runs/<run_id>/job/<job_id>` — one click straight to the live log.
Best-effort: on any lookup failure it falls back to the run URL, so the
comment is never worse than today.

### Implementation shape

- New script `.github/scripts/autofix-status-heartbeat.sh`:
  - `body` subcommand prints the full bilingual working-state comment body
    (marker, round line, progress line, collapsed Chinese), given round /
    cap / URL / progress inputs. Single source of truth for the text —
    `Post autofix status comment` uses it for the initial post and the
    loop reuses it each tick, so the two cannot drift.
  - `loop` subcommand: sleep–compose–PATCH until killed or self-exit
    bound. Interval/age-cap overrides are regex-validated (a malformed or
    zero value degrades to the default — never a sleep-less busy loop).
- The script is staged in `Stage trusted schema gate and agent runner`
  (cp from the trusted base to `RUNNER_TEMP`, sha256 recorded in
  `GITHUB_OUTPUT`), and `Post autofix status comment` verifies the digest
  before invoking — the same pattern as `resanitize-git-config.sh`. It
  runs BEFORE the agent (no check→use window across agent execution for
  the invocation; bash parses the whole script at start, so a later swap
  of the staged copy cannot alter the running loop).
- `${WORKDIR}/heartbeat.log` is added to the `Show run artifacts` echo
  list (the whole-WORKDIR artifact upload picks it up automatically), so
  a dead or silent heartbeat is diagnosable after the fact.

## Key design decisions

1. **Edit the existing status comment rather than posting new ones.** A
   managed PR can run 100 rounds; per-round comment stacks are already
   prevented by the PATCH discipline, and heartbeat posts would multiply
   that by ~13 per round. Comment edits generate no notifications and no
   `issue_comment` events (no workflow fan-out).
2. **Heartbeat lives in the review-address job, not a watcher job or the
   schedule scan.** It needs the comment id, the run/job identity, and
   `agent.log` — all local to the job. A separate job would have to poll
   for all of them. The schedule scan lands every ~40-70 min in this repo
   (not the 10 min the cron implies), too slow to be the pulse.
3. **PAT exposure trade-off, made explicit and lifetime-bounded.** The
   heartbeat holds the bot PAT in its environment — a temporal overlap the
   surrounding design otherwise avoids ("This step holds no PAT"). The
   first revision bounded this only by "the agent sandboxes fork code";
   review proved that insufficient, because the verification gate then
   runs the branch's own build/tests ON THE HOST as the runner user, and
   a same-UID `/proc/<pid>/environ` read from that code would expose the
   token. The overlap is therefore bounded to the sandboxed agent phase:
   the gate kills the loop's whole session before any host-side branch
   code runs (lifetime rule 1; the kill covers the session because an
   in-flight tick's `timeout 60 gh` subtree sits in its own process group
   under the loop's session). Within that phase the token never touches
   disk, the only concurrent host processes are trusted (run-agent.mjs,
   the bundled CLI), and the step's gh calls and every tick run under the
   af-112 hermetic pins (pinned host, planted tokens dropped, a fresh
   `GH_CONFIG_DIR` minted around every call and removed right after) — a
   planted `http_unix_socket` in the shared HOME's gh config would
   otherwise deliver the tick's Authorization header to a same-UID
   listener inside the legitimate overlap. The mint sits under the
   same-UID-writable `RUNNER_TEMP`, so the dir is created milliseconds
   before each call and removed right after; a long-lived minted dir is
   itself plantable between calls (R11-1). The alternative that
   avoids the overlap entirely —
   heartbeat from the schedule scan or a watcher job — was rejected on
   cadence and complexity (decision 2). The trade-off is recorded in the
   yml comment so future readers see it was chosen, not overlooked.
4. **Kill targets never come from WORKDIR.** The sandbox mounts the host
   `/tmp` on the same path and runs as the same user, so branch code can
   write arbitrary values into `heartbeat.pid`; a killer that read it
   would perform attacker-chosen process termination. Killers therefore
   read the pid from expression context (the launch's `$!`), and the
   on-disk file is diagnostics + the loop's own self-check only.
5. **agent.log mtime as the liveness signal.** No stream parsing, no
   coupling to event schema or prompt structure; run-agent.mjs already
   writes every event there. Coarse ("active N min ago") is exactly what
   answers "is it dead?".
6. **Inline kill, staged start.** Script execution happens once, at start,
   digest-verified, before the agent; the killers are inline `kill` calls
   so no PR-branch-controlled file is ever executed in a PAT-bearing or
   post-agent context.
7. **10-minute cadence.** ≤13 PATCHes per 130-minute round, ≤20
   concurrent legs — negligible API load. Frequent enough that a stuck
   round shows a stale "active" timestamp within one interval.

## Files affected

| File                                                | Change                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/scripts/autofix-status-heartbeat.sh`       | New: `body` + `loop` subcommands.                                                                                                                                                                                                                                                                   |
| `.github/workflows/qwen-autofix.yml`                | Stage + digest the script; `Post autofix status comment` uses it, resolves the job deep link, starts the loop and records its pid; the verification gate kills it before host-side branch code; finalize / cleanup kill again from the expression-context pid; artifact list gains `heartbeat.log`. |
| `.github/workflows/qwen-autofix.md`                 | New af-148/af-149 design records + TOC entries.                                                                                                                                                                                                                                                     |
| `.github/workflows/ci.yml`                          | Register the new behavioral suite in `HELPER_TESTS`.                                                                                                                                                                                                                                                |
| `.github/workflows/.size-baseline`                  | Ratchet line for the yml growth.                                                                                                                                                                                                                                                                    |
| `scripts/tests/qwen-autofix-workflow.test.js`       | Pin the new wiring (start/kill sites, digest verification, deep link fallback, artifact list).                                                                                                                                                                                                      |
| `.github/scripts/autofix-status-heartbeat.test.mjs` | Behavioral tests for the script (body shape, loop PATCH cadence, self-exit bounds) with a fake `gh`.                                                                                                                                                                                                |

## Scope boundaries

- Review-address lane only. The issue lane posts no status comment; the
  fork-bridge/signal lanes dispatch into the same review-address job and
  are covered automatically.
- **Out of scope (deliberately)**: repairing a "working" comment orphaned
  by a hard runner kill where even `always()` finalize never ran (scan-
  side stale-heal); richer milestone progress (findings addressed i/N);
  a live-updating commit status. Each is a separate value judgment.

## Residual risks (accepted)

- **Liveness-signal integrity.** The sandbox can delete or overwrite
  `heartbeat.pid` (ending the pulse early via the identity self-check),
  touch `heartbeat-stop`, or bump `agent.log`'s mtime to forge "agent
  active 0 min ago". It can also plant or delete
  `heartbeat-tick-inflight` — costing finalize at most the 65s drain
  bound, or reopening the cosmetic terminal-overwrite race the drain
  closes. The attacker can only mislabel or silence their own
  round's progress — no token, no execution, no kill reach — so this is
  accepted rather than engineered around.
- **Post-gate silence.** After the gate kills the loop, the comment holds
  its last tick until finalize. A round deep in gate/repair looks quieter
  than it is; the run link stays live, which is the recourse.
- **Cross-host orphan pulsing.** The identity self-check only reclaims a
  crash-leftover orphan when the next same-PR round reuses the orphan's
  host; the pool is multi-host with no per-PR runner affinity, so the
  general case leaves the orphan passing its own check and re-PATCHing
  its stale body onto the shared status comment until the age cap —
  alternating with live rounds' bodies and overwriting terminal text
  within one interval of finalize. Accepted, with its real profile: the
  orphan holds the bot PAT in `/proc/<pid>/environ` until the cap, and
  any same-UID process on that host — including another PR's round
  running its gate's host-side build/tests — reads it directly (the
  pool's ptrace scope gates ptrace attach, not this read; witnessed on
  the pool's host class). The cap therefore sits just past the
  330-minute job envelope, bounding the orphan's token window to roughly
  one job duration; the alternative — a cross-run kill keyed on a
  WORKDIR pid — reopens the untrusted-kill-target hole.

## Open questions

None blocking. Cadence (10 min) and the age cap (just past the
330-minute job envelope) are repo-variable-friendly constants but ship
as literals until a reason to configure appears.
