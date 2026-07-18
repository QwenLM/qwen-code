/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/qwen-fleet-shepherd.yml',
  'utf8',
);

describe('fleet shepherd workflow', () => {
  it('runs checkout-free — every read goes through the API', () => {
    // The run step reads no repo files (the flake registry is gone with the
    // rerun lever), so a checkout would be pure per-tick waste.
    expect(workflow).not.toContain('actions/checkout');
  });

  it('ticks on a schedule with a manual dry-run escape hatch', () => {
    expect(workflow).toContain("cron: '*/15 * * * *'");
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('dry_run');
    expect(workflow).toContain('DRY-RUN');
  });

  it('is scoped, killable, and never self-cancels mid-action', () => {
    expect(workflow).toContain("github.repository == 'QwenLM/qwen-code'");
    // Global kill switch: flipping one repository variable stops all writes.
    expect(workflow).toContain("vars.FLEET_SHEPHERD_DISABLED != 'true'");
    // A tick performs real writes; a newer tick must queue, not cancel it.
    expect(workflow).toContain("group: 'fleet-shepherd'");
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 15');
    // The strict-mode contract the comments, if-wrappers, and the act()
    // behavioral replay all assume is DECLARED, not left to Actions'
    // default shell (which has -e but not pipefail).
    expect(workflow).toContain('set -eo pipefail');
  });

  it('walks only in-repo main-targeting bot PRs', () => {
    expect(workflow).toContain(
      'AUTOFIX_BOT: "${{ vars.AUTOFIX_BOT_LOGIN || \'qwen-code-dev-bot\' }}"',
    );
    expect(workflow).toContain('--author "${AUTOFIX_BOT}" --base main');
    expect(workflow).toContain('.isCrossRepository != true');
    // One list call carries all per-PR metadata — no N+1 gh pr view loop.
    expect(workflow).toContain(
      '--json number,headRefName,headRefOid,mergeable,isCrossRepository,statusCheckRollup',
    );
    // Per-PR metadata still rides the ONE list call — the sole gh pr view
    // is the labels-only live-skip recheck immediately before a mutation.
    expect(workflow.split('gh pr view').length - 1).toBe(1);
    expect(workflow).toContain(
      'gh pr view "${pr}" --repo "${REPO}" --json labels',
    );
    // autofix/skip is the maintainer opt-out honored at every engagement
    // path: a skip-labeled PR gets no shepherd levers and no dashboard row.
    // Replay the filter VERBATIM to prove the label actually excludes.
    expect(workflow).toContain("SKIP_LABEL: 'autofix/skip'");
    const fleetFilter = workflow.match(
      /jq --arg skip "\$\{SKIP_LABEL\}" \\\n\s+'([\s\S]*?)' \\\n\s+\/tmp\/fleet-raw\.json/,
    )?.[1];
    expect(fleetFilter).toBeTruthy();
    const kept = JSON.parse(
      execFileSync('jq', ['--arg', 'skip', 'autofix/skip', fleetFilter], {
        encoding: 'utf8',
        input: JSON.stringify([
          { number: 1, isCrossRepository: false, labels: [] },
          {
            number: 2,
            isCrossRepository: false,
            labels: [{ name: 'autofix/skip' }],
          },
          { number: 3, isCrossRepository: true, labels: [] },
        ]),
      }),
    ).map((r) => r.number);
    expect(kept).toEqual([1]);
    // The PRODUCER must request labels too — the filter replay above stays
    // green on fixtures even if a future edit drops the field and every PR
    // silently bypasses the opt-out.
    expect(workflow).toContain(
      '--limit 50 --json number,headRefName,headRefOid,mergeable,isCrossRepository,statusCheckRollup,labels',
    );
    // The snapshot filter is only tick-start state: every MUTATING lever
    // re-checks the live label first (fail closed — an unreadable label
    // state counts as skipped), so consent withdrawn mid-tick still wins
    // before a dispatch or branch sync.
    expect(workflow).toContain('live_skip() {');
    expect(workflow).toContain('return 0');
    expect(
      workflow.split('present (live) — consent withdrawn').length - 1,
    ).toBe(2);
    expect(workflow).toMatch(/elif live_skip "\$\{PR\}"; then/);
    expect(workflow).toMatch(/if live_skip "\$\{PR\}"; then/);
    // PAT identity is verified before any write.
    expect(workflow).toContain(
      "::error::CI_DEV_BOT_PAT authenticates as '${bot_actor:-unknown}'",
    );
  });

  it('splits credentials by purpose', () => {
    // Dispatches ride the workflow token (actions: write)…
    expect(workflow).toContain("actions: 'write'");
    expect(workflow).toContain(
      'env GITHUB_TOKEN="${ACTIONS_TOKEN}" gh workflow run qwen-autofix.yml',
    );
    // …while comments, update-branch, and the dashboard use the bot PAT so
    // synced branches still trigger CI and writes carry the bot identity.
    expect(workflow).toContain("GITHUB_TOKEN: '${{ secrets.CI_DEV_BOT_PAT }}'");
    expect(workflow).toContain('pulls/${PR}/update-branch');
  });

  it('applies each lever idempotently with per-tick caps', () => {
    // Conflict dispatch: once per conflicted head SHA, marker-deduped, gated
    // on quiet checks (mirroring the autofix scan's own predicate so a
    // dispatch is never wasted on a scan that will skip), and the marker is
    // posted ONLY after a successful dispatch.
    expect(workflow).toContain(
      '<!-- fleet-shepherd conflict-dispatch sha=%s -->',
    );
    expect(workflow).toContain('-f pr_number="${PR}"');
    expect(workflow).toContain('deferring conflict dispatch');
    expect(workflow).toContain('return "${rc}"');
    expect(workflow).toMatch(
      /if act "#\$\{PR\}: dispatch autofix for conflict resolution"/,
    );
    // The dispatch counts against the budget the moment it happens; a marker
    // outage only changes the note (the busy-set below absorbs a retry).
    expect(workflow).toMatch(
      /DISPATCHES=\$\(\( DISPATCHES \+ 1 \)\)[\s\S]{0,400}if act "#\$\{PR\}: post conflict notice"/,
    );
    expect(workflow).toContain(
      'marker post failed — busy-set defers duplicates while the run lives',
    );
    // The shepherd builds its OWN busy-set from live autofix runs' matrix
    // jobs (schedule/dispatch runs never surface in a PR's check rollup), so
    // marker-failure retry idempotency does not lean on any autofix-side
    // dedup that may not be merged: a PR with a review-address job running or
    // queued is deferred, and an unreadable run snapshot defers every
    // conflict dispatch because busy-state is then UNKNOWN.
    expect(workflow).toContain(
      'capture("^review-address \\\\((?<pr>[0-9]+),") | .pr',
    );
    expect(workflow).toMatch(
      /if \[\[ "\$\{BUSY_OK\}" != "true" \]\]; then[\s\S]{0,300}elif \[\[ "\$\{SHEP_BUSY\}" == \*" \$\{PR\} "\* \]\]; then/,
    );
    expect(workflow).toContain(
      'review-address already in flight — deferring dispatch',
    );
    expect(workflow).toContain(
      'busy-state unknown (runs or jobs read failed) — deferring dispatch',
    );
    // EVERY jobs read is tracked — a partial enumeration is unknown
    // busy-state, not a smaller busy-set; and BUSY_OK inherits SCAN_RUNS_OK
    // so a failed run-list read defers conflict dispatches the same way.
    expect(workflow).toContain('BUSY_OK="${SCAN_RUNS_OK}"');
    expect(workflow).toContain(
      'jobs read failed for run ${LIVE_RUN}; busy-state unknown',
    );
    // Stale-base sync: threshold-gated, self-limiting (behind_by resets),
    // never while checks are in flight, and a compare-and-swap on the head.
    expect(workflow).toContain("BEHIND_SYNC_THRESHOLD: '25'");
    expect(workflow).toContain(
      '"${BEHIND}" -ge "${BEHIND_SYNC_THRESHOLD}" && "${PENDING}" == "0"',
    );
    expect(workflow).toContain('-f expected_head_sha="${HEAD}"');
    // WAITING and REQUESTED are also not-yet-final check states.
    expect(workflow).toContain(
      'IN("QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED")',
    );
    // Markers are consumed only by the conflict lever, so the paginated
    // comments read lives inside the CONFLICTING branch: the majority of the
    // fleet never fetches it, and a failed read defers just that lever
    // (never acting on empty history) instead of dropping the PR from the
    // dashboard and the other levers.
    expect(workflow).toContain('marker read failed — deferring dispatch');
    expect(workflow).toContain('MARKS_OK=false');
    expect(workflow).not.toContain('marker read failed; skipping this tick');
    expect(workflow).toMatch(
      /if \[\[ "\$\{MERGEABLE\}" == "CONFLICTING" \]\]; then[\s\S]{0,900}gh api "repos\/\$\{REPO\}\/issues\/\$\{PR\}\/comments" --paginate/,
    );
    // A failed fleet fetch skips the walk AND preserves the previous
    // dashboard body — never an empty-table overwrite.
    expect(workflow).toContain('fleet enumeration failed; skipping this tick');
    // Per-tick blast-radius caps.
    expect(workflow).toContain("MAX_SYNCS_PER_TICK: '3'");
    expect(workflow).toContain("MAX_CONFLICT_DISPATCHES_PER_TICK: '2'");
  });

  it('leaves flaky-rerun ownership with the CI Failure Patrol', () => {
    // Two scheduled rerun owners raced each other live; the shepherd only
    // reports red CI and never reruns anything.
    expect(workflow).toContain('NON-GOAL: rerunning flaky-failed CI');
    expect(workflow).toContain('qwen-ci-flaky-rerun.yml');
    expect(workflow).toContain('reruns owned by CI Failure Patrol');
    expect(workflow).not.toContain('gh run rerun');
    expect(workflow).not.toContain('known-flakes');
    expect(workflow).not.toContain('RERUN_MAX_ATTEMPTS');
  });

  it('keeps the autofix scan alive when cron goes silent', () => {
    expect(workflow).toContain("SCAN_LIVENESS_MINUTES: '60'");
    expect(workflow).toContain('-f phase=review');
    // Never stacks a liveness scan on top of an in-flight one.
    expect(workflow).toContain('"${SCAN_INFLIGHT}" == "0"');
    // The liveness signal counts SCHEDULE runs plus the shepherd's own
    // liveness dispatch, attributed by RECORDED RUN ID (a same-tick conflict
    // dispatch sits seconds from the watermark, so timestamp proximity would
    // count its two-hour run and starve the watchdog).
    expect(workflow).toContain('[.[] | select(.event == "schedule")] | first');
    expect(workflow).toContain(
      '<!-- fleet-shepherd liveness-dispatched: ${LIVENESS_OUT} run=${LIVENESS_RUN_OUT:-none} -->',
    );
    expect(workflow).toContain("grep -oE 'run=[0-9]+'");
    // The dispatched run's id is captured right after the dispatch, while no
    // other dispatch can exist yet in the tick (conflict dispatches come
    // later in the walk).
    expect(workflow).toContain('--event workflow_dispatch --limit 5');
    expect(workflow).toContain('DISPATCH_T0=');
    // A wide window so event storms can't push schedule runs out of view;
    // databaseId feeds the busy-set walk over the same snapshot.
    expect(workflow).toContain(
      '--limit 50 --json event,createdAt,status,databaseId',
    );
    // ONE snapshot call feeds the age, in-flight, and busy-set computations
    // (the only other run-list is the post-dispatch id capture).
    expect(
      workflow.match(/--limit 50 --json event,createdAt,status,databaseId/g) ??
        [],
    ).toHaveLength(1);
    // A FAILED snapshot read is UNKNOWN, not an empty repo: no '[]' fallback
    // (which would zero in-flight AND blank the schedule signal, stacking a
    // duplicate scan); instead the lever is gated off for the tick.
    expect(workflow).not.toContain("echo '[]' > /tmp/scan-runs.json");
    expect(workflow).toContain(
      'run-list read failed; liveness lever and conflict dispatches skipped',
    );
    expect(workflow).toContain(
      '"${DASH_LOOKUP_OK}" == "true" && "${SCAN_RUNS_OK}" == "true" && "${SCAN_AGE_MIN}" -ge "${SCAN_LIVENESS_MINUTES}"',
    );
    // The watermark LIVES in the dashboard body: an unreadable body is
    // unknown watermark state, so the lever is skipped AND the body is not
    // overwritten (which would destroy the stored watermark).
    expect(workflow).toContain(
      'dashboard body read failed; dashboard write and liveness lever skipped this tick',
    );
  });

  it('behaviorally proves a failed jobs read yields unknown busy-state, not an empty busy-set', () => {
    // Extract the busy-set walk VERBATIM (drift fails the test) and replay it
    // with a PATH-stubbed gh: one live run whose jobs read fails must flip
    // BUSY_OK to false (deferring every conflict dispatch), a successful read
    // must collect the PR into the busy-set, and no live runs at all must
    // leave BUSY_OK true with an empty set.
    const busyWalk = workflow.match(
      /(SHEP_BUSY=' '\n[\s\S]*?done < <\(jq -r '\.\[\] \| select\(\.status != "completed"\) \| \.databaseId' \/tmp\/scan-runs\.json 2> \/dev\/null\))/,
    )?.[1];
    expect(busyWalk).toBeTruthy();
    const runBusyWalk = ({ runs, ghScript }) => {
      const dir = mkdtempSync(join(tmpdir(), 'shepherd-busy-'));
      try {
        const gh = join(dir, 'gh');
        writeFileSync(gh, `#!/bin/bash\n${ghScript}\n`);
        chmodSync(gh, 0o755);
        writeFileSync('/tmp/scan-runs.json', JSON.stringify(runs));
        const out = execFileSync(
          'bash',
          [
            '-c',
            `${busyWalk.replace(/\n {10}/g, '\n')}\nprintf '%s|%s' "$BUSY_OK" "$SHEP_BUSY"`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              SCAN_RUNS_OK: 'true',
              ACTIONS_TOKEN: 'x',
              REPO: 'QwenLM/qwen-code',
            },
            encoding: 'utf8',
          },
        );
        return out.split('\n').at(-1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync('/tmp/scan-runs.json', { force: true });
      }
    };
    const live = [{ databaseId: 101, status: 'in_progress' }];
    // Jobs read fails → busy-state UNKNOWN, never "nothing is busy".
    expect(runBusyWalk({ runs: live, ghScript: 'exit 1' })).toBe('false| ');
    // Jobs read succeeds → the queued/running review-address PR is busy.
    expect(
      runBusyWalk({
        runs: live,
        ghScript: `printf '%s' '{"jobs":[{"status":"queued","name":"review-address (7127, ci/autofix-concurrent-fanout)"},{"status":"completed","name":"review-address (7000, x)"}]}'`,
      }),
    ).toBe('true| 7127 ');
    // No live runs → known-empty busy-set, dispatches stay enabled.
    expect(
      runBusyWalk({
        runs: [{ databaseId: 100, status: 'completed' }],
        ghScript: 'exit 1',
      }),
    ).toBe('true| ');
  });

  it('behaviorally proves in-flight counting ignores foreign dispatches', () => {
    // Extract the SCAN_INFLIGHT jq program VERBATIM from the workflow (drift
    // fails the test) and replay it. Attribution is by RECORDED RUN ID, not
    // timestamp proximity: a conflict dispatch fired later in the same tick
    // is created seconds from the liveness watermark, so any proximity
    // window would count its two-hour address run as in-flight liveness and
    // starve the watchdog.
    const jqProgram = workflow
      .match(
        /SCAN_INFLIGHT="\$\(jq -r --arg lvrun "\$\{PREV_LIVENESS_RUN\}" '([\s\S]*?)' \/tmp\/scan-runs\.json/,
      )?.[1]
      ?.replace(/\n {12}/g, '\n');
    expect(jqProgram).toBeTruthy();
    const count = (runs, lvrun) =>
      execFileSync('jq', ['-r', '--arg', 'lvrun', lvrun, jqProgram], {
        encoding: 'utf8',
        input: JSON.stringify(runs),
      }).trim();
    const OURS = '900001';
    const run = (event, databaseId, createdAt, status = 'in_progress') => ({
      event,
      databaseId,
      createdAt,
      status,
    });
    // Live schedule run → counted (no stacking).
    expect(count([run('schedule', 900000, '2026-07-18T07:59:00Z')], OURS)).toBe(
      '1',
    );
    // Completed schedule run → not counted.
    expect(
      count(
        [run('schedule', 900000, '2026-07-18T07:59:00Z', 'completed')],
        OURS,
      ),
    ).toBe('0');
    // Our own recorded liveness dispatch, still running → counted.
    expect(
      count([run('workflow_dispatch', 900001, '2026-07-18T07:59:58Z')], OURS),
    ).toBe('1');
    // The reviewer's reachable case: a conflict dispatch fired in the SAME
    // tick, created 5 seconds after the watermark — inside any plausible
    // proximity window — must NOT be counted (its id is not ours).
    expect(
      count([run('workflow_dispatch', 900002, '2026-07-18T08:00:05Z')], OURS),
    ).toBe('0');
    // Our run finished, only the same-tick conflict run lives on → the
    // watchdog is free to dispatch once the age expires.
    expect(
      count(
        [
          run('workflow_dispatch', 900001, '2026-07-18T07:59:58Z', 'completed'),
          run('workflow_dispatch', 900002, '2026-07-18T08:00:05Z'),
        ],
        OURS,
      ),
    ).toBe('0');
    // No id recorded (pre-id marker or capture failure) → nothing
    // attributed; the failure mode is one absorbed duplicate scan, never
    // starvation.
    expect(
      count([run('workflow_dispatch', 900001, '2026-07-18T07:59:58Z')], ''),
    ).toBe('0');
  });

  it('maintains one dashboard issue edited in place', () => {
    expect(workflow).toContain("DASHBOARD_TITLE: 'Fleet Shepherd Dashboard'");
    // Exact-title equality via real jq --arg (in:title search is substring
    // based — a bystander issue containing the title must never be hijacked);
    // gh's own --jq has no --arg, so the JSON is piped to standalone jq.
    expect(workflow).not.toContain('--jq --arg');
    expect(workflow).toContain('map(select(.title == $t)) | .[0].number');
    // A FAILED lookup is not "not found" — never create-on-failure.
    expect(workflow).toContain(
      'dashboard lookup failed; dashboard update skipped this tick',
    );
    expect(workflow).toContain('gh issue edit');
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('do not edit by hand');
    // CI-red detection is platform-blind: a Windows- or macOS-only failure
    // is just as red on the health view as an Ubuntu one.
    expect(workflow).toContain('startswith("Test (")');
    expect(workflow).not.toContain('Test (ubuntu');
    // The extracted URL is surfaced as a dashboard link to the failing job —
    // extracting it just to test non-emptiness would be dead weight.
    expect(workflow).toContain('STATUS_NOTE="[ci red](${FAILED_TEST_URL})"');
    // act() propagates exit codes, so EVERY call site must be if-wrapped or a
    // failure aborts the tick under set -e — including the dashboard writes.
    expect(workflow).toMatch(/if ! act "create dashboard issue"/);
    expect(workflow).toMatch(/if ! act "update dashboard issue/);
    expect(workflow).not.toMatch(/^\s+act "/m);
  });

  it('behaviorally proves act() gates follow-up markers on success', () => {
    // Extract act() VERBATIM from the workflow (drift fails the test) and run
    // it under bash: a failing primary action must return nonzero so the
    // if-wrapper skips the marker; a succeeding one must return zero.
    const act = workflow.match(/act\(\) \{[\s\S]*?\n {10}\}/)?.[0];
    expect(act).toBeTruthy();
    const script = (cmd) =>
      [
        'set -eo pipefail',
        "DRY_RUN='false'",
        act.replace(/\n {10,12}/g, '\n'),
        `if act "primary" ${cmd}; then echo MARKER-POSTED; else echo MARKER-SKIPPED; fi`,
      ].join('\n');
    expect(
      execFileSync('bash', ['-c', script('true')], { encoding: 'utf8' }),
    ).toContain('MARKER-POSTED');
    expect(
      execFileSync('bash', ['-c', script('false')], { encoding: 'utf8' }),
    ).toContain('MARKER-SKIPPED');
    // Dry-run must return 0 WITHOUT executing the command: `false` as the
    // primary would fail if executed, so DRY-OK proves the branch short-circuits.
    const dryScript = [
      'set -eo pipefail',
      "DRY_RUN='true'",
      act.replace(/\n {10,12}/g, '\n'),
      'if act "primary" false; then echo DRY-OK; else echo DRY-FAIL; fi',
    ].join('\n');
    expect(
      execFileSync('bash', ['-c', dryScript], { encoding: 'utf8' }),
    ).toContain('DRY-OK');
  });
});
