/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  '.github/workflows/qwen-fleet-shepherd.yml',
  'utf8',
);

// GNU `date -u -d` shim for the behavioral replays — on macOS hosts BSD date
// lacks `-d`, so route it through node. Shared by every date-shim replay
// (R7-4/R2-10): a fix to the shim must land once, not diverge across copies —
// so the shim keeps GNU's two traps faithfully: `date -d ""` SUCCEEDS (today
// 00:00, emulated as NOW_EPOCH - 43200 — inside the lever's age window at the
// fixtures' noon) and an unparsable date exits NON-zero. A 'NaN'-with-rc-0
// copy is not a bash number ($(( NOW_EPOCH - NaN )) reads it as 0) and would
// bless behavior no host produces. Answers ONLY the +%s call shape it
// emulates (R9-9): any other format falls through to the system date, so a
// format-string mutation cannot hide behind the shim.
const gnuDateShim = `date() { if [[ "$1" == '-u' && "$2" == '-d' && "$4" == '+%s' ]]; then node -e 'const a = process.argv[1]; const t = a === "" ? Number(process.env.NOW_EPOCH) - 43200 : Math.floor(new Date(a).getTime() / 1000); if (Number.isNaN(t)) process.exit(1); console.log(t)' "$3"; else command date "$@"; fi; }`;

// The `wedged` predicate is defined once in the workflow and reused by the
// in-flight count, the census, and the liveness re-dispatch guard; tests
// replay it VERBATIM so a drift in any of them fails here.
const zombieDef = workflow.match(/ZOMBIE_JQ='([\s\S]*?)'\n/)?.[1];

// The SCAN_INFLIGHT program is extracted once and replayed by both the
// foreign-dispatch test and the wedged-queue test — one copy, so a workflow
// edit updates one extraction instead of drifting between two.
const inflightProgram = workflow
  .match(
    /SCAN_INFLIGHT="\$\(jq -r --arg lvrun "\$\{PREV_LIVENESS_RUN\}" --arg now "\$\{NOW_EPOCH\}" --arg zmin "\$\{ZOMBIE_QUEUED_MINUTES\}" "\$\{ZOMBIE_JQ\}"'([\s\S]*?)' \/tmp\/scan-runs\.json/,
  )?.[1]
  ?.replace(/\n {12}/g, '\n');

// The `review-address (<pr>, …)` display-name contract, extracted from the
// PRODUCER (R2-7): GitHub builds a matrix job's display name from the job id
// plus the matrix values joined in the target object's key order, so the
// busy rail's prefix capture stands on (a) no job-level `name:`, (b) exactly
// one matrix dimension, (c) `pr` emitted first. Extracted once here so the
// contract test below and the rail's fixture names cannot drift apart.
const autofixTargetsKeys = [
  ...(
    readFileSync('.github/workflows/qwen-autofix.yml', 'utf8').match(
      /TARGETS="\$\(jq -c \\[\s\S]*?'\. \+ \[\{([^}]*)\}\]'/,
    )?.[1] ?? ''
  ).matchAll(/(\w+): \$/g),
].map((m) => m[1]);

// The rail fixtures' job names are BUILT from the producer's key order: a
// key reorder (or a renamed first key) on the qwen-autofix.yml side turns
// the rail replays red here instead of leaving the rail to capture nothing —
// fail-OPEN — in production.
const reviewAddressJob = (pr, status = 'in_progress') => ({
  name: `review-address (${autofixTargetsKeys
    .map((k) => (k === 'pr' ? pr : 'x'))
    .join(', ')})`,
  status,
});

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
    // Fail CLOSED on the fork field, matching the autofix workflow's
    // convention (jq's // treats false as empty; == false rejects a
    // missing field instead of passing it through).
    expect(workflow).toContain('.isCrossRepository == false');
    expect(workflow).not.toContain('.isCrossRepository != true');
    // One list call carries all per-PR metadata — no N+1 gh pr view loop.
    expect(workflow).toContain(
      '--json number,headRefName,headRefOid,mergeable,isCrossRepository,statusCheckRollup',
    );
    // Per-PR metadata still rides the list calls — the sole gh pr view is
    // live_skip's recheck immediately before a mutation, whose exported
    // payload the auto-release scope check and the no-op notice's live
    // state/head guard ride (no second read).
    expect(workflow.split('gh pr view').length - 1).toBe(1);
    expect(workflow).toContain(
      'gh pr view "${pr}" --repo "${REPO}" --json labels,state,headRefOid',
    );
    expect(workflow).toContain(
      'index($a) != null) and ([.labels[]?.name] | index($b) != null)\' <<< "${LIVE_LABELS_JSON}"',
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
          { number: 4, labels: [] },
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
    // Reason-aware notes: an API outage (fail closed) is never reported as
    // a maintainer decision, and the per-tick budget is checked BEFORE the
    // PAT-backed live read so an exhausted tick stops spending API calls.
    expect(workflow).toContain("LIVE_SKIP_REASON='unreadable'");
    expect(workflow).toContain('consent withdrawn, no %s');
    expect(workflow).toContain('fail closed, no %s');
    expect(workflow).toMatch(
      /DISPATCHES\}" -ge "\$\{MAX_CONFLICT_DISPATCHES_PER_TICK\}" \]\]; then[\s\S]{0,200}elif live_skip "\$\{PR\}"; then[\s\S]{0,800}conflict_paused "\$\{PR\}"; then/,
    );
    expect(workflow).toMatch(
      /SYNCS\}" -ge "\$\{MAX_SYNCS_PER_TICK\}" \]\]; then[\s\S]{0,160}elif live_skip "\$\{PR\}"; then/,
    );
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
    // A failed fleet fetch must not masquerade as an empty fleet — and it
    // must not exit either (B5): the takeover/needs-human processing runs
    // off its OWN enumerations, so the fleet failure degrades to a loud
    // error row and the tick falls through to the dashboard write (which
    // carries the liveness watermark). Pin the WHOLE failure branch — an
    // exit statement BEFORE the warning escapes a forward-only scan
    // (R8-11).
    const fleetFetch = workflow.match(
      /if ! gh pr list --repo "\$\{REPO\}" --state open --author "\$\{AUTOFIX_BOT\}" --base main[\s\S]*?\n {10}else\n {12}FLEET_OK=true/,
    )?.[0];
    expect(fleetFetch).toBeTruthy();
    expect(fleetFetch).not.toMatch(/\n\s*exit( 0| 1)?\s*($|;)/m);
    expect(fleetFetch).toContain(
      'fleet enumeration failed; the bot-fleet table shows an error row this tick',
    );
    expect(fleetFetch).toContain(
      '⚠️ fleet enumeration unreadable this tick | fail closed — fleet levers skipped',
    );
    expect(fleetFetch).toContain('FLEET_OK=false');
    // The fleet walk is gated on FLEET_OK so the error row is the only row
    // — the success side assigns true, and the gate CLOSES before the
    // takeover section, so a fleet fetch failure can never skip the
    // independently-fed levers (R8-14).
    expect(workflow).toContain('FLEET_OK=true');
    expect(workflow).toMatch(
      /if \[\[ "\$\{FLEET_OK\}" == "true" \]\]; then\n\s+while IFS= read -r ROW; do/,
    );
    expect(workflow).toMatch(
      /done < <\(jq -c '\.\[\]' \/tmp\/fleet\.json\)\n {10}fi # FLEET_OK\n\n {10}# ---- takeover pool/,
    );
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
    // The FULL gate, including the wedge self-limit: a still-wedged recorded
    // liveness run keeps it closed, so an ATTRIBUTED persistent wedge plants
    // one corpse per snapshot window at worst, not one per watermark cycle (a
    // run=none attribution fallback records no id the guard could see).
    expect(workflow).toContain(
      '"${DASH_LOOKUP_OK}" == "true" && "${SCAN_RUNS_OK}" == "true" && "${SCAN_AGE_MIN}" -ge "${SCAN_LIVENESS_MINUTES}" && "${SCAN_INFLIGHT}" == "0" && "${PREV_LIVENESS_WEDGED}" == "0"',
    );
    // The watermark LIVES in the dashboard body: an unreadable body is
    // unknown watermark state, so the lever is skipped AND the body is not
    // overwritten (which would destroy the stored watermark).
    expect(workflow).toContain(
      'dashboard body read failed; dashboard write and liveness lever skipped this tick',
    );
  });

  it('behaviorally proves liveness attribution refuses an ambiguous dispatch window', () => {
    // The fork-review bridge dispatches autonomously at arbitrary times, so
    // the "a dispatch since T0 is ours" window can hold TWO dispatches —
    // and GitHub may expose a foreign dispatch before our own run appears.
    // Extract the correlation loop VERBATIM (drift fails the test) and
    // replay it with a PATH-stubbed gh: a singleton is attributed only once
    // it is the sole candidate across two consecutive polls, an ambiguous
    // window records run=none instead of tracking a foreign run, and
    // dispatches older than T0 do not count.
    expect(workflow).toContain('if [[ "${COUNT}" == "1" ]]; then');
    expect(workflow).toContain('attribution ambiguous');
    expect(workflow).toContain('two consecutive polls');
    const loop = workflow.match(
      /(for _ in 1 2 3 4 5; do\n[\s\S]*?\n {16}done\n {16}LIVENESS_RUN_OUT="\$\{ATTRIBUTED:-\}")/,
    )?.[1];
    expect(loop).toBeTruthy();
    const replay = (ghScript) => {
      const dir = mkdtempSync(join(tmpdir(), 'shepherd-corr-'));
      try {
        writeFileSync(join(dir, 'gh'), `#!/bin/bash\n${ghScript}\n`);
        chmodSync(join(dir, 'gh'), 0o755);
        // The loop logs an ambiguity note to stdout; the VALUE under test
        // is the recorded run id, printed last.
        return execFileSync(
          'bash',
          [
            '-c',
            `set -eo pipefail
sleep() { :; }
${loop.replace(/\n {16}/g, '\n')}
printf '%s' "${'$'}{LIVENESS_RUN_OUT:-}"`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              ACTIONS_TOKEN: 'x',
              REPO: 'QwenLM/qwen-code',
              DISPATCH_T0: '2026-08-07T08:00:00Z',
              DRY_RUN: 'false',
            },
            encoding: 'utf8',
          },
        )
          .split('\n')
          .at(-1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const staticStub = (dispatches) =>
      `if [[ "$1" == 'run' && "$2" == 'list' ]]; then
  printf '%s' '${JSON.stringify(dispatches)}'
  exit 0
fi
exit 1`;
    const run = (databaseId, createdAt) => ({ databaseId, createdAt });
    // Exactly one dispatch in the window, stable across the polls → ours,
    // attributed by id.
    expect(replay(staticStub([run(900001, '2026-08-07T08:00:05Z')]))).toBe(
      '900001',
    );
    // Two dispatches in the window (the bridge raced us) → run=none; the
    // heuristic must not attribute a run it cannot prove is its own.
    expect(
      replay(
        staticStub([
          run(900001, '2026-08-07T08:00:05Z'),
          run(900002, '2026-08-07T08:00:06Z'),
        ]),
      ),
    ).toBe('');
    // Only dispatches older than T0 → nothing attributed.
    expect(replay(staticStub([run(899999, '2026-08-07T07:59:00Z')]))).toBe('');
    // Nothing at all → the polling loop exhausts and records nothing.
    expect(replay(staticStub([]))).toBe('');

    // STATEFUL stubs: a static stub cannot tell single-poll from five-poll,
    // so loop mutants escape it. These sequences change per call (the last
    // line repeats), proving the retry-until-appears semantics and the
    // stabilization window.
    const statefulStub = (responses) => {
      const dir = mkdtempSync(join(tmpdir(), 'shepherd-corr-seq-'));
      try {
        writeFileSync(join(dir, 'responses'), responses.join('\n'));
        const script = `if [[ "$1" == 'run' && "$2" == 'list' ]]; then
  n="$(cat '${dir}/polls' 2>/dev/null || echo 0)"
  n=$(( n + 1 )); printf '%s' "$n" > '${dir}/polls'
  line="$(sed -n "$((${responses.length} < n ? ${responses.length} : n))p" '${dir}/responses')"
  printf '%s' "$line"
  exit 0
fi
exit 1`;
        return replay(script);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // First poll empty, our run appears on the second → still attributed.
    // A loop that broke after the first empty poll would record nothing.
    expect(
      statefulStub([
        '[]',
        JSON.stringify([run(900001, '2026-08-07T08:00:05Z')]),
      ]),
    ).toBe('900001');
    // The filed defect: a FOREIGN dispatch is visible before our own run.
    // Accepting the first singleton would attribute the foreign id; the
    // stabilization window sees two candidates on the next poll and records
    // run=none instead.
    expect(
      statefulStub([
        JSON.stringify([run(900002, '2026-08-07T08:00:05Z')]),
        JSON.stringify([
          run(900002, '2026-08-07T08:00:05Z'),
          run(900001, '2026-08-07T08:00:07Z'),
        ]),
      ]),
    ).toBe('');
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
    // A run wedged by AGE is still inspected — age alone proves jobless
    // only for the wedge class that defined the threshold. When the runner
    // pool is offline, queued runs hold live review-address jobs
    // indefinitely, and the busy-set must keep deferring their PRs (the
    // marker-failure safety net), so the jobs read decides, not the birthday.
    expect(
      runBusyWalk({
        runs: [
          {
            databaseId: 102,
            status: 'queued',
            createdAt: '2026-08-19T05:01:14Z',
          },
        ],
        ghScript: `printf '%s' '{"jobs":[{"status":"queued","name":"review-address (7127, ci/autofix-concurrent-fanout)"}]}'`,
      }),
    ).toBe('true| 7127 ');
    // The wedge class that defined the threshold reads clean: zero jobs,
    // nothing collected, BUSY_OK survives.
    expect(
      runBusyWalk({
        runs: [
          {
            databaseId: 102,
            status: 'queued',
            createdAt: '2026-08-19T05:01:14Z',
          },
        ],
        ghScript: `printf '%s' '{"jobs":[]}'`,
      }),
    ).toBe('true| ');
    // And a FAILED jobs read on an old queued run stays fail-closed like any
    // other run: busy-state unknown, conflict dispatches deferred this tick.
    expect(
      runBusyWalk({
        runs: [
          {
            databaseId: 102,
            status: 'queued',
            createdAt: '2026-08-19T05:01:14Z',
          },
        ],
        ghScript: 'exit 1',
      }),
    ).toBe('false| ');
  });

  it('behaviorally proves in-flight counting ignores foreign dispatches', () => {
    // Extract the SCAN_INFLIGHT jq program VERBATIM from the workflow (drift
    // fails the test) and replay it. Attribution is by RECORDED RUN ID, not
    // timestamp proximity: a conflict dispatch fired later in the same tick
    // is created seconds from the liveness watermark, so any proximity
    // window would count its two-hour address run as in-flight liveness and
    // starve the watchdog.
    expect(inflightProgram).toBeTruthy();
    expect(zombieDef).toBeTruthy();
    const NOW = Math.floor(Date.parse('2026-07-18T08:00:05Z') / 1000);
    const count = (runs, lvrun) =>
      execFileSync(
        'jq',
        [
          '-r',
          '--arg',
          'lvrun',
          lvrun,
          '--arg',
          'now',
          String(NOW),
          '--arg',
          'zmin',
          '30',
          zombieDef + inflightProgram,
        ],
        { encoding: 'utf8', input: JSON.stringify(runs) },
      ).trim();
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

  it('behaviorally proves a run wedged in queued is not in flight', () => {
    // 2026-08-19: qwen-autofix.yml crossed GitHub's 500 KB workflow-file
    // limit, and GitHub answered by CREATING runs it never started — queued
    // forever, zero jobs, uncancellable through the API. The watchdog counted
    // one of them as its own in-flight liveness dispatch and stopped
    // dispatching for 18 hours ("last scan signal 1107m ago, in-flight: 1")
    // while the loop was dark. A queued run older than ZOMBIE_QUEUED_MINUTES
    // is wedged, not live, and must drop out of the count.
    const censusProgram = workflow
      .match(
        /SCAN_ZOMBIES="\$\(jq -r --arg now "\$\{NOW_EPOCH\}" --arg zmin "\$\{ZOMBIE_QUEUED_MINUTES\}" "\$\{ZOMBIE_JQ\}"'([\s\S]*?)' \/tmp\/scan-runs\.json/,
      )?.[1]
      ?.replace(/\n {12}/g, '\n');
    const oldestProgram = workflow
      .match(
        /SCAN_ZOMBIE_OLDEST="\$\(jq -r --arg now "\$\{NOW_EPOCH\}" --arg zmin "\$\{ZOMBIE_QUEUED_MINUTES\}" "\$\{ZOMBIE_JQ\}"'([\s\S]*?)' \/tmp\/scan-runs\.json/,
      )?.[1]
      ?.replace(/\n {12}/g, '\n');
    expect(inflightProgram).toBeTruthy();
    expect(censusProgram).toBeTruthy();
    expect(oldestProgram).toBeTruthy();

    const NOW = Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000);
    const jq = (program, runs, extra, zmin = '30') =>
      execFileSync(
        'jq',
        [
          '-r',
          ...extra,
          '--arg',
          'now',
          String(NOW),
          '--arg',
          'zmin',
          zmin,
          zombieDef + program,
        ],
        { encoding: 'utf8', input: JSON.stringify(runs) },
      ).trim();
    const inflight = (runs, zmin) =>
      jq(inflightProgram, runs, ['--arg', 'lvrun', '900001'], zmin);
    const census = (runs) => jq(censusProgram, runs, []);
    const oldest = (runs) => jq(oldestProgram, runs, []);
    const run = (event, databaseId, createdAt, status) => ({
      event,
      databaseId,
      createdAt,
      status,
    });

    // A dispatch queued for four minutes is a runner queue, not a wedge.
    expect(
      inflight([
        run('workflow_dispatch', 900001, '2026-08-19T23:56:00Z', 'queued'),
      ]),
    ).toBe('1');
    // The observed failure: our own liveness dispatch, queued for 19 hours.
    expect(
      inflight([
        run('workflow_dispatch', 900001, '2026-08-19T05:01:14Z', 'queued'),
      ]),
    ).toBe('0');
    // Schedule runs wedge the same way and must not starve the watchdog either.
    expect(
      inflight([run('schedule', 900007, '2026-08-19T05:01:14Z', 'queued')]),
    ).toBe('0');
    // Boundary: exactly ZOMBIE_QUEUED_MINUTES old is wedged, a second younger
    // is not — the cutoff is inclusive and has no dead zone.
    expect(
      inflight([
        run('workflow_dispatch', 900001, '2026-08-19T23:30:00Z', 'queued'),
      ]),
    ).toBe('0');
    expect(
      inflight([
        run('workflow_dispatch', 900001, '2026-08-19T23:30:01Z', 'queued'),
      ]),
    ).toBe('1');
    // The repository-variable override is behaviorally live: the same
    // 10-minute-old queued run is wedged at zmin=5 and in flight at zmin=15.
    // A hardcoded threshold would pass this whole suite while silently
    // ignoring a tuned variable mid-incident.
    expect(
      inflight(
        [run('workflow_dispatch', 900001, '2026-08-19T23:50:00Z', 'queued')],
        '5',
      ),
    ).toBe('0');
    expect(
      inflight(
        [run('workflow_dispatch', 900001, '2026-08-19T23:50:00Z', 'queued')],
        '15',
      ),
    ).toBe('1');
    // Only QUEUED runs wedge. A review-address run legitimately runs for
    // hours, and must keep deferring the watchdog for every one of them.
    expect(
      inflight([
        run('workflow_dispatch', 900001, '2026-08-19T02:00:00Z', 'in_progress'),
      ]),
    ).toBe('1');
    // Unknown age is not evidence of a wedge: an absent createdAt keeps the
    // run in flight rather than licensing a duplicate dispatch.
    expect(
      inflight([
        { event: 'workflow_dispatch', databaseId: 900001, status: 'queued' },
      ]),
    ).toBe('1');

    // The census counts every wedged run whatever its event or attribution —
    // it exists to make the wedge VISIBLE, which is what the incident lacked.
    expect(
      census([
        run('workflow_dispatch', 1, '2026-08-19T01:04:50Z', 'queued'),
        run('workflow_dispatch', 2, '2026-08-19T13:44:13Z', 'queued'),
        run('pull_request_review', 3, '2026-08-19T05:14:09Z', 'queued'),
        run('schedule', 4, '2026-08-19T23:55:00Z', 'queued'),
        run('schedule', 5, '2026-08-19T20:00:00Z', 'completed'),
      ]),
    ).toBe('3');
    // ...and the reported "oldest" is the EARLIEST wedged createdAt, not the
    // newest — a sort|first→last mutant would flip the banner during the
    // very incident it exists for.
    expect(
      oldest([
        run('workflow_dispatch', 1, '2026-08-19T01:04:50Z', 'queued'),
        run('workflow_dispatch', 2, '2026-08-19T13:44:13Z', 'queued'),
        run('pull_request_review', 3, '2026-08-19T05:14:09Z', 'queued'),
        run('schedule', 4, '2026-08-19T23:55:00Z', 'queued'),
        run('schedule', 5, '2026-08-19T20:00:00Z', 'completed'),
      ]),
    ).toBe('2026-08-19T01:04:50Z');
    // Nothing wedged → empty, never a bogus timestamp.
    expect(
      oldest([
        run('workflow_dispatch', 6, '2026-08-19T23:56:00Z', 'queued'),
        run('schedule', 7, '2026-08-19T20:00:00Z', 'completed'),
      ]),
    ).toBe('');
  });

  it('behaviorally proves the liveness gate refuses to stack on a wedged dispatch', () => {
    // During a PERSISTENT wedge the watermark cycle would reopen the gate
    // every 60 minutes and plant a fresh uncancellable queued dispatch per
    // hour, each refreshing the very liveness watermark whose growing age
    // exposed the incident. The guard looks at the RECORDED liveness run:
    // still wedged in the snapshot → the gate stays closed. It lengthens
    // the interval rather than blocking hard — once that run starts,
    // completes, or leaves the snapshot window, the gate reopens on its own.
    const prevWedgedProgram = workflow
      .match(
        /PREV_LIVENESS_WEDGED="\$\(jq -r --arg lvrun "\$\{PREV_LIVENESS_RUN\}" --arg now "\$\{NOW_EPOCH\}" --arg zmin "\$\{ZOMBIE_QUEUED_MINUTES\}" "\$\{ZOMBIE_JQ\}"'([\s\S]*?)' \/tmp\/scan-runs\.json/,
      )?.[1]
      ?.replace(/\n {12}/g, '\n');
    expect(prevWedgedProgram).toBeTruthy();
    const NOW = Math.floor(Date.parse('2026-08-20T00:00:00Z') / 1000);
    const prevWedged = (runs, lvrun) =>
      execFileSync(
        'jq',
        [
          '-r',
          '--arg',
          'lvrun',
          lvrun,
          '--arg',
          'now',
          String(NOW),
          '--arg',
          'zmin',
          '30',
          zombieDef + prevWedgedProgram,
        ],
        { encoding: 'utf8', input: JSON.stringify(runs) },
      ).trim();
    const run = (event, databaseId, createdAt, status) => ({
      event,
      databaseId,
      createdAt,
      status,
    });
    // Our recorded liveness run, still wedged → the gate must stay closed.
    expect(
      prevWedged(
        [run('workflow_dispatch', 900001, '2026-08-19T05:01:14Z', 'queued')],
        '900001',
      ),
    ).toBe('1');
    // The same run once GitHub starts it → the gate reopens.
    expect(
      prevWedged(
        [
          run(
            'workflow_dispatch',
            900001,
            '2026-08-19T05:01:14Z',
            'in_progress',
          ),
        ],
        '900001',
      ),
    ).toBe('0');
    // A wedged run that is NOT ours (a foreign dispatch) never blocks the
    // watchdog — attribution stays by recorded run id.
    expect(
      prevWedged(
        [run('workflow_dispatch', 900002, '2026-08-19T05:01:14Z', 'queued')],
        '900001',
      ),
    ).toBe('0');
    // No id recorded → nothing can be wedged by attribution.
    expect(
      prevWedged(
        [run('workflow_dispatch', 900001, '2026-08-19T05:01:14Z', 'queued')],
        '',
      ),
    ).toBe('0');
    // The recorded run left the snapshot window → the gate reopens; the
    // residual is the documented one absorbed duplicate scan.
    expect(prevWedged([], '900001')).toBe('0');
  });

  it('reports and routes around wedged runs everywhere they matter', () => {
    // Tunable without a deploy, and generous enough never to fire on an
    // ordinary runner queue.
    expect(workflow).toContain(
      'ZOMBIE_QUEUED_MINUTES: "${{ vars.QWEN_SHEPHERD_ZOMBIE_QUEUED_MINUTES || \'30\' }}"',
    );
    // The tunable is operator-breakable — a non-numeric repo variable falls
    // back to the default with a warning instead of failing every $zmin
    // consumer open (mirrors AUTO_RELEASE_DAYS), and the guard runs BEFORE
    // the first consumer (the census), not after.
    const guardCondition = workflow.match(
      /^ {10}(if \[\[ ! "\$\{ZOMBIE_QUEUED_MINUTES\}".*); then$/m,
    )?.[1];
    expect(guardCondition).toBeTruthy();
    expect(guardCondition).toBe(
      'if [[ ! "${ZOMBIE_QUEUED_MINUTES}" =~ ^[0-9]+$ ]] || [[ ${#ZOMBIE_QUEUED_MINUTES} -gt 3 ]] || [[ "${ZOMBIE_QUEUED_MINUTES}" =~ ^0+$ ]]',
    );
    // Replayed VERBATIM: zero is the degenerate lower bound — it wedges
    // every queued run at birth — so it falls back like a non-numeric or
    // oversized value instead of reaching the jq consumers.
    const guardVerdict = (value) =>
      spawnSync(
        'bash',
        [
          '-c',
          `ZOMBIE_QUEUED_MINUTES='${value}'; ${guardCondition}; then echo fallback; else echo keep; fi`,
        ],
        { encoding: 'utf8' },
      ).stdout.trim();
    expect(guardVerdict('0')).toBe('fallback');
    expect(guardVerdict('00')).toBe('fallback');
    expect(guardVerdict('000')).toBe('fallback');
    expect(guardVerdict('abc')).toBe('fallback');
    expect(guardVerdict('1000')).toBe('fallback');
    expect(guardVerdict('1')).toBe('keep');
    expect(guardVerdict('30')).toBe('keep');
    expect(guardVerdict('999')).toBe('keep');
    expect(workflow).toMatch(
      /is not a positive integer or is too large; using 30"\n\s+ZOMBIE_QUEUED_MINUTES=30\n[\s\S]*?SCAN_ZOMBIES="/,
    );
    // The conflict lever's busy-set deliberately does NOT share the wedged
    // exclusion: age alone proves jobless only for the wedge class that
    // defined the threshold — offline runners keep live jobs queued
    // indefinitely, so the jobs read decides, not the birthday.
    expect(workflow).toContain(
      'done < <(jq -r \'.[] | select(.status != "completed") | .databaseId\' /tmp/scan-runs.json 2> /dev/null)',
    );
    // Visible in the tick log and on the dashboard, not just in the count.
    expect(workflow).toContain('wedged-queued: ${SCAN_ZOMBIES}');
    expect(workflow).toContain(
      "autofix run(s) stuck 'queued' for over ${ZOMBIE_QUEUED_MINUTES}m",
    );
    expect(workflow).toContain(
      '${SCAN_ZOMBIES} autofix run(s) wedged in \\`queued\\`',
    );
    // The census is status+age only (no jobs read), so the banner must not
    // assert the runs are jobless: an offline runner pool keeps live jobs
    // queued just as long, and deleting them kills live work. The honest
    // phrasing points at a jobs check before any deletion.
    expect(workflow).not.toContain('GitHub never started them');
    expect(workflow).toContain('gh run view <id> --json jobs');
    // While the recorded liveness run stays wedged, the banner also names
    // the paused re-dispatch gate AND its escape hatch: recovery from a
    // persistent wedge leaves the gate closed until THAT run leaves the
    // snapshot window, and nothing else tells oncall why scans stay dark.
    // The remedy must name the ONE id whose deletion reopens the gate —
    // the gate replay above proves deleting any other wedged run leaves it
    // closed, so a generic 'delete the wedged run(s)' would be a trap.
    expect(workflow).toContain(
      'liveness re-dispatch stays paused while the recorded liveness run (id ${PREV_LIVENESS_RUN}) is among them',
    );
    expect(workflow).toContain('gh run delete ${PREV_LIVENESS_RUN}');
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

  it('covers the takeover pool: enumeration, dashboard rows, and a bounded auto-release', () => {
    // Label contract, mirroring qwen-autofix.yml.
    expect(workflow).toContain("TAKEOVER_LABEL: 'autofix/takeover'");
    expect(workflow).toContain("NEEDS_HUMAN_LABEL: 'autofix/needs-human'");
    expect(workflow).toContain(
      'AUTO_RELEASE_DAYS: "${{ vars.QWEN_SHEPHERD_AUTO_RELEASE_DAYS || \'3\' }}"',
    );
    expect(workflow).toContain("MAX_RELEASES_PER_TICK: '3'");
    expect(workflow).toContain("RESUME_COMMAND_GRACE_SEC: '7200'");
    expect(workflow).toContain("MAX_CLEANUPS_PER_TICK: '5'");
    // One list call carries the takeover row payload — forks INCLUDED (no
    // isCrossRepository filter: visibility covers fork takeovers, and the
    // release lever needs no push access). sort:updated-asc keeps the stale
    // tail in view; the saturation warnings keep truncation loud on BOTH
    // enumerations.
    expect(workflow).toContain('--state open --label "${TAKEOVER_LABEL}"');
    expect(workflow).toContain(
      '--limit 100 --json number,author,updatedAt,mergeable,statusCheckRollup,labels',
    );
    expect(workflow).toContain("--search 'sort:updated-asc'");
    expect(workflow).toContain('takeover pool at the 100-PR enumeration limit');
    expect(workflow).toContain(
      'needs-human pool at the 100-PR enumeration limit',
    );
    const takeoverEnum = workflow.match(
      /--label "\$\{TAKEOVER_LABEL\}"[\s\S]*?\/tmp\/takeover-raw\.json/,
    )?.[0];
    expect(takeoverEnum).toBeTruthy();
    expect(takeoverEnum).not.toContain('isCrossRepository');
    // R4-30: pin the stale-first sort on THIS enumeration (not just the
    // needs-human one) — over the 100 cap, unsorted order drops exactly the
    // stale tail the dashboard exists to surface.
    expect(takeoverEnum).toContain("--search 'sort:updated-asc'");
    // Enumeration failures degrade to a loud error row and FALL THROUGH to
    // the dashboard write (which carries the liveness watermark) — they
    // must not exit the tick. The release lever gets its OWN enumeration of
    // the paused population (both labels), never the long-lived needs-human
    // display window (R5-7).
    expect(workflow).toContain(
      'takeover enumeration failed; the takeover table shows an error row this tick',
    );
    expect(workflow).toContain(
      'needs-human enumeration failed; the awaiting-human table shows an error row this tick',
    );
    expect(workflow).toContain(
      'paused-takeover enumeration failed; the release lever is skipped this tick',
    );
    expect(workflow).toContain(
      '--state open --label "${TAKEOVER_LABEL}" --label "${NEEDS_HUMAN_LABEL}"',
    );
    expect(workflow).not.toMatch(
      /takeover enumeration failed[\s\S]{0,200}exit 0/,
    );
    expect(workflow).toContain('enumeration unreadable this tick');
    // The released-but-unresolved tail (needs-human WITHOUT takeover) gets
    // its own read-only section with neutral wording — capped bot PRs land
    // here too, and they never had a takeover to release.
    expect(workflow).toContain('--state open --label "${NEEDS_HUMAN_LABEL}"');
    expect(workflow).toContain("'## Awaiting human'");
    expect(workflow).toContain(
      'loop stopped — needs a human decision (merge / close / split / re-engage)',
    );
    // autofix/skip wins in the pool too — replay the filter VERBATIM. The
    // program-prefix anchor keeps this from capturing the bot-fleet filter
    // (same jq shape, different file and a leading isCrossRepository leg).
    const takeoverFilter = workflow.match(
      /jq --arg skip "\$\{SKIP_LABEL\}" \\\n\s+'(\[\.\[\] \| select\(\[\.labels[\s\S]*?)' \\\n\s+\/tmp\/takeover-raw\.json/,
    )?.[1];
    expect(takeoverFilter).toBeTruthy();
    const kept = JSON.parse(
      execFileSync('jq', ['--arg', 'skip', 'autofix/skip', takeoverFilter], {
        encoding: 'utf8',
        input: JSON.stringify([
          { number: 1, labels: [] },
          { number: 2, labels: [{ name: 'autofix/skip' }] },
          { number: 3, labels: [{ name: 'unrelated' }] },
        ]),
      }),
    ).map((r) => r.number);
    expect(kept).toEqual([1, 3]);
    // Dashboard: the takeover table is rendered (edited in place with the
    // bot-fleet table), and the header line reports releases.
    expect(workflow).toContain("'## Takeover pool'");
    expect(workflow).toContain("'| PR | Author | Updated | State | Note |'");
    expect(workflow).toContain('releases: ${RELEASES}');
    // needs-human bot PRs surface on the bot-fleet table too.
    expect(workflow).toContain("NH_PREFIX='🛑 '");
  });

  it('behaviorally proves pause detection, the re-arm guard, and the release age gate', () => {
    // Extract the three pause-detection jq programs VERBATIM (drift fails
    // the test) and replay them against comment-stream fixtures.
    const termJq = workflow.match(
      /TERM_TS="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" '([\s\S]*?)' \/tmp\/tk-ic\.json\)"/,
    )?.[1];
    const resumeJq = workflow.match(
      /local resume refusal\n\s+resume="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" '([\s\S]*?)' "\$\{ic\}"\)"/,
    )?.[1];
    const reasonJq = workflow.match(
      /REASON="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" '([\s\S]*?)' \/tmp\/tk-ic\.json\)"/,
    )?.[1];
    expect(termJq).toBeTruthy();
    expect(resumeJq).toBeTruthy();
    expect(reasonJq).toBeTruthy();
    const run = (program, comments) =>
      execFileSync('jq', ['-r', '--arg', 'ab', 'qwen-code-dev-bot', program], {
        encoding: 'utf8',
        input: JSON.stringify(comments),
      }).trim();
    const bot = (created_at, body) => ({
      user: { login: 'qwen-code-dev-bot' },
      created_at,
      body,
    });
    const human = (created_at, body) => ({
      user: { login: 'wenshao' },
      created_at,
      body,
    });
    // TERM_TS: latest bot cap notice only — a human forging the marker text
    // does not move the pause clock.
    expect(
      run(termJq, [
        bot('2026-08-01T00:00:00Z', '⏸️ … <!-- takeover-cap-reached -->'),
        bot('2026-08-05T00:00:00Z', '⏸️ … <!-- takeover-cap-reached -->'),
        human('2026-08-06T00:00:00Z', '<!-- takeover-cap-reached -->'),
      ]),
    ).toBe('2026-08-05T00:00:00Z');
    expect(run(termJq, [human('2026-08-06T00:00:00Z', 'x')])).toBe('');
    // RESUME_TS: re-arm markers and engage acks both count as a resume.
    expect(
      run(resumeJq, [
        bot('2026-08-02T00:00:00Z', '🔄 … <!-- autofix-rearm -->'),
        bot('2026-08-03T00:00:00Z', '🤝 … <!-- takeover-ack engaged -->'),
      ]),
    ).toBe('2026-08-03T00:00:00Z');
    expect(run(resumeJq, [bot('2026-08-02T00:00:00Z', '⏸️ unrelated')])).toBe(
      '',
    );
    // Resume evidence is computed by compute_resume_ts — replay the WHOLE
    // function verbatim (markers + trusted commands + labeled events +
    // permission gate + tie-break), with `gh` and GNU date stubbed. Each
    // case pins one of R4-14 / R5-4 / R5-5 / R5-9.
    const resumeFn = workflow.match(
      /(compute_resume_ts\(\) \{[\s\S]*?\n {10}\})/,
    )?.[1];
    expect(resumeFn).toBeTruthy();
    const computeResume = ({
      comments = [],
      events = [],
      perm = 'write',
      permFail = false,
      permError = 'HTTP 502',
      now = '2026-08-06T00:30:00Z',
    }) => {
      const dir = mkdtempSync(join(tmpdir(), 'resume-'));
      try {
        writeFileSync(join(dir, 'ic.json'), JSON.stringify(comments));
        writeFileSync(join(dir, 'ev.json'), JSON.stringify(events));
        writeFileSync(
          join(dir, 'gh'),
          [
            '#!/bin/bash',
            'if [[ "$1" == "api" ]]; then',
            `  if [[ "${permFail}" == "true" ]]; then echo "${permError}" >&2; exit 1; fi`,
            // Per-user permission: the collaborators path ($2) names the
            // user; `perm` is the default, `stranger` always reads `read`.
            `  case "$2" in *collaborators/stranger/*) printf '%s' "read" ;; *) printf '%s' "${perm}" ;; esac`,
            'fi',
          ].join('\n'),
        );
        chmodSync(join(dir, 'gh'), 0o755);
        // R10-2: the verbatim function carries production's shared
        // /tmp/cperm-err path — rewrite it into THIS case's temp dir so
        // concurrent suite runs on one machine (shared self-hosted
        // runners) cannot corrupt each other's classification fixtures
        // through the one global file.
        const replayFn = resumeFn
          .replace(/\n {10}/g, '\n')
          .replaceAll('/tmp/cperm-err', join(dir, 'cperm-err'));
        expect(replayFn).not.toContain('/tmp/cperm-err');
        const out = execFileSync(
          'bash',
          [
            '-c',
            `${gnuDateShim}\n${replayFn}\ncompute_resume_ts "${dir}/ic.json" "${dir}/ev.json"\necho "TS=$RESUME_OUT"\necho "PERM_FAILED=$PERM_READ_FAILED"`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              REPO: 'QwenLM/qwen-code',
              AUTOFIX_BOT: 'qwen-code-dev-bot',
              TAKEOVER_LABEL: 'autofix/takeover',
              TAKEOVER_COMMAND: '@qwen-code /takeover',
              RETRY_COMMAND: '@qwen-code /retry',
              RESUME_COMMAND_GRACE_SEC: '7200',
              NOW_EPOCH: String(Date.parse(now) / 1000),
            },
            encoding: 'utf8',
          },
        ).trim();
        const ts = out.match(/^TS=(.*)$/m)?.[1] ?? '';
        const flag = out.match(/^PERM_FAILED=(.*)$/m)?.[1] ?? '';
        return { ts, flag };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const cmd = (ts, login, body = '@qwen-code /takeover') => ({
      user: { login },
      created_at: ts,
      body,
    });
    const evt = (ts, name = 'autofix/takeover', kind = 'labeled') => ({
      event: kind,
      label: { name },
      created_at: ts,
    });
    // bot markers: newest re-arm/engage wins.
    expect(
      computeResume({
        comments: [
          bot('2026-08-02T00:00:00Z', '🔄 … <!-- autofix-rearm -->'),
          bot('2026-08-03T00:00:00Z', '🤝 … <!-- takeover-ack engaged -->'),
        ],
      }).ts,
    ).toBe('2026-08-03T00:00:00Z');
    // a fresh trusted command counts (the R1 race fix)…
    expect(
      computeResume({ comments: [cmd('2026-08-06T00:00:00Z', 'wenshao')] }).ts,
    ).toBe('2026-08-06T00:00:00Z');
    // …but a stranger's command does not (R4-14)…
    expect(
      computeResume({
        comments: [cmd('2026-08-06T00:00:00Z', 'stranger')],
        perm: 'read',
      }).ts,
    ).toBe('');
    // …and a stale command past the grace window expires (R1-1)…
    expect(
      computeResume({
        comments: [cmd('2026-08-06T00:00:00Z', 'wenshao')],
        now: '2026-08-06T03:00:00Z',
      }).ts,
    ).toBe('');
    // …a refusal ack NEWER than the command supersedes it (R1-2)…
    expect(
      computeResume({
        comments: [
          cmd('2026-08-06T00:00:00Z', 'wenshao'),
          bot(
            '2026-08-06T00:01:00Z',
            '🚫 … <!-- takeover-ack fork-refused -->',
          ),
        ],
      }).ts,
    ).toBe('');
    // …but a refusal OLDER than the fresh command does not (R4-29)…
    expect(
      computeResume({
        comments: [
          bot(
            '2026-08-06T00:01:00Z',
            '🚫 … <!-- takeover-ack fork-refused -->',
          ),
          cmd('2026-08-06T01:00:00Z', 'wenshao'),
        ],
        now: '2026-08-06T01:30:00Z',
      }).ts,
    ).toBe('2026-08-06T01:00:00Z');
    // …and a stranger's echo NEWER than the maintainer's command cannot
    // shadow it — every in-grace command is permission-checked (R5-5), so
    // the maintainer's still promotes.
    expect(
      computeResume({
        comments: [
          cmd('2026-08-06T00:00:00Z', 'wenshao'),
          cmd('2026-08-06T00:10:00Z', 'stranger'),
        ],
      }).ts,
    ).toBe('2026-08-06T00:00:00Z');
    // a labeled event counts (UI re-apply)…
    expect(computeResume({ events: [evt('2026-08-06T00:00:00Z')] }).ts).toBe(
      '2026-08-06T00:00:00Z',
    );
    // …and a same-second tie resolves toward RESUME (R5-9).
    expect(
      computeResume({
        comments: [bot('2026-08-06T00:00:00Z', '🔄 … <!-- autofix-rearm -->')],
        events: [evt('2026-08-06T00:00:00Z')],
      }).ts,
    ).toBe('2026-08-06T00:00:00Z');
    // a failed permission read sets PERM_READ_FAILED and does not promote
    // the command (R5-4).
    const permFailed = computeResume({
      comments: [cmd('2026-08-06T00:00:00Z', 'wenshao')],
      permFail: true,
    });
    expect(permFailed.ts).toBe('');
    expect(permFailed.flag).toBe('true');
    // R9-10: a 404 is GitHub's decisive "not a collaborator" answer — the
    // command is classified read-only WITHOUT PERM_READ_FAILED: failing
    // closed here would let any stranger renewably defer the release with
    // one exact command comment per grace window, reported as an outage.
    const notCollab = computeResume({
      comments: [cmd('2026-08-06T00:00:00Z', 'stranger')],
      permFail: true,
      permError: 'HTTP 404: Not Found',
    });
    expect(notCollab.ts).toBe('');
    expect(notCollab.flag).toBe('');
    // R11-1: …but the match is the exact "HTTP 404" token: a transport
    // failure embeds the request URL, which carries the commenter login —
    // a login containing "404" must classify as an outage (defer), never
    // as "not a collaborator".
    const transportErr = computeResume({
      comments: [cmd('2026-08-06T00:00:00Z', 'maintainer4041')],
      permFail: true,
      permError:
        'Get https://api.github.com/repos/QwenLM/qwen-code/collaborators/maintainer4041/permission: connection refused',
    });
    expect(transportErr.ts).toBe('');
    expect(transportErr.flag).toBe('true');
    // R8-4: budget exhaustion — with THREE distinct-author fresh commands
    // the 2-read budget runs out before the oldest is examined; that must
    // surface as PERM_READ_FAILED (defer), never as "no trusted command"
    // (fail open).
    const budgeted = computeResume({
      comments: [
        cmd('2026-08-06T00:30:00Z', 'reader-a'),
        cmd('2026-08-06T00:20:00Z', 'reader-b'),
        cmd('2026-08-06T00:10:00Z', 'reader-c'),
      ],
      perm: 'read',
    });
    expect(budgeted.ts).toBe('');
    expect(budgeted.flag).toBe('true');
    // R8-4: the grace-window boundary — at EXACTLY RESUME_COMMAND_GRACE_SEC
    // the command has expired (strict -lt; a still-unacked command that old
    // is route-ignored, so the boundary resolves toward release), and one
    // second inside the window still counts.
    expect(
      computeResume({
        comments: [cmd('2026-08-06T00:00:00Z', 'wenshao')],
        now: '2026-08-06T02:00:00Z',
      }).ts,
    ).toBe('');
    expect(
      computeResume({
        comments: [cmd('2026-08-06T00:00:01Z', 'wenshao')],
        now: '2026-08-06T02:00:00Z',
      }).ts,
    ).toBe('2026-08-06T00:00:01Z');
    // R6-15: the resume/refusal author filters — a HUMAN-forged re-arm
    // marker never counts (only the bot posts real ones)…
    expect(
      computeResume({
        comments: [
          {
            user: { login: 'wenshao' },
            created_at: '2026-08-06T00:00:00Z',
            body: 'forged <!-- autofix-rearm -->',
          },
        ],
      }).ts,
    ).toBe('');
    // …and a forged refusal ack cannot supersede a fresh maintainer
    // command.
    expect(
      computeResume({
        comments: [
          {
            user: { login: 'wenshao' },
            created_at: '2026-08-06T00:01:00Z',
            body: 'forged <!-- takeover-ack fork-refused -->',
          },
          cmd('2026-08-06T01:00:00Z', 'wenshao'),
        ],
        now: '2026-08-06T01:30:00Z',
      }).ts,
    ).toBe('2026-08-06T01:00:00Z');
    // R6-28: a command OLDER than the newest resume marker never counts —
    // the ordering guard keeps the marker (without it, a cap notice posted
    // between the command and its processing would release a PR re-armed
    // minutes earlier).
    expect(
      computeResume({
        comments: [
          cmd('2026-08-06T00:00:00Z', 'wenshao'),
          bot('2026-08-06T01:00:00Z', '🔄 … <!-- autofix-rearm -->'),
        ],
      }).ts,
    ).toBe('2026-08-06T01:00:00Z');
    // The event read fails closed, like the comment read.
    expect(workflow).toContain(
      'event read failed — evaluation deferred this tick (fail closed)',
    );
    // REASON: the terminal round's own headline beats the scan-side notice,
    // which always says "round cap" even when a breaker fired first.
    const reason = run(reasonJq, [
      bot(
        '2026-08-04T00:00:00Z',
        '🤖 AutoFix stopped: this counting window now contains 3 time-budget exhaustions …\ndetails',
      ),
    ]);
    expect(reason).toContain('time-budget exhaustions');
    expect(reason).not.toContain('details');
    // Only TERMINAL headlines count: the transient setup-failure variant
    // retries on the next scan and says nothing about why the loop stopped.
    expect(
      run(reasonJq, [
        bot(
          '2026-08-04T00:00:00Z',
          '🤖 AutoFix could not start — a setup step failed …',
        ),
      ]),
    ).toBe('');
    // R4-31: two terminal headlines (a re-armed PR stopped twice) — the
    // NEWEST is reported (pins `last`; a stale round-1 reason must not win).
    expect(
      run(reasonJq, [
        bot(
          '2026-08-01T00:00:00Z',
          '🤖 AutoFix stopped after 3 consecutive rounds that failed to push anything …',
        ),
        bot(
          '2026-08-04T00:00:00Z',
          '🤖 AutoFix stopped: this counting window now contains 3 time-budget exhaustions …',
        ),
      ]),
    ).toContain('time-budget exhaustions');
    // The re-arm guard (R7-1): the stale-label cleanup fires only when a
    // MARKER-confirmed re-arm is at-or-newer than the CURRENT pause boundary
    // (latest needs-human apply), never on command/label evidence, and a
    // cap notice NEWER than the marker (a re-pause) vetoes it (R8-10).
    // Replay the gate VERBATIM so a dropped comparison fails the test.
    const rearmGuard = workflow.match(
      /\n {16}(if \[\[ -n "\$\{PAUSE_APPLY_TS\}" && -n "\$\{MARKER_RESUME\}" && ! "\$\{PAUSE_APPLY_TS\}" > "\$\{MARKER_RESUME\}" && ! "\$\{TERM_TS\}" > "\$\{MARKER_RESUME\}" \]\]; then\n {18}STATE='managed \(re-armed\)')/,
    )?.[1];
    expect(rearmGuard).toBeTruthy();
    const guard = (marker, apply, term = '') =>
      execFileSync(
        'bash',
        [
          '-c',
          `${rearmGuard.replace(/\n {18}/g, '\n')}\necho REARMED\nelse\necho RELEASE-ELIGIBLE\nfi`,
        ],
        {
          env: {
            ...process.env,
            MARKER_RESUME: marker,
            PAUSE_APPLY_TS: apply,
            TERM_TS: term,
          },
          encoding: 'utf8',
        },
      ).trim();
    // Marker-confirmed re-arm newer than the current pause apply → re-armed
    // — also with NO cap notice: a lost notice must not make the cleanup
    // unreachable (R8-1).
    expect(guard('2026-08-06T00:00:00Z', '2026-08-05T00:00:00Z')).toBe(
      'REARMED',
    );
    // A same-second tie resolves toward REARMED (R5-9 / R7-1).
    expect(guard('2026-08-05T00:00:00Z', '2026-08-05T00:00:00Z')).toBe(
      'REARMED',
    );
    // Marker older than the pause apply (stale cycle-1 evidence) → NOT
    // re-armed; the fresh pause stands.
    expect(guard('2026-08-04T00:00:00Z', '2026-08-05T00:00:00Z')).toBe(
      'RELEASE-ELIGIBLE',
    );
    // No marker at all → not re-armed (command-grace evidence alone never
    // triggers this cleanup).
    expect(guard('', '2026-08-05T00:00:00Z')).toBe('RELEASE-ELIGIBLE');
    // No pause anchor → cannot correlate → not re-armed (fail closed).
    expect(guard('2026-08-06T00:00:00Z', '')).toBe('RELEASE-ELIGIBLE');
    // A notice OLDER than the marker does not veto the cleanup.
    expect(
      guard(
        '2026-08-06T00:00:00Z',
        '2026-08-05T00:00:00Z',
        '2026-08-04T00:00:00Z',
      ),
    ).toBe('REARMED');
    // R8-10: a cap notice NEWER than the marker means the PR re-paused
    // after the re-arm — the fresh pause wins, no cleanup.
    expect(
      guard(
        '2026-08-06T00:00:00Z',
        '2026-08-05T00:00:00Z',
        '2026-08-07T00:00:00Z',
      ),
    ).toBe('RELEASE-ELIGIBLE');
    // The release gates run in blast-radius order: per-tick budget BEFORE
    // the PAT-backed live read, then the shared live_skip veto (fail closed
    // on an unreadable read; skip wins — both worded by skip_note), then the
    // both-labels scope condition riding live_skip's exported payload — and
    // the writes are act()-wrapped so dry-run makes no mutation.
    expect(workflow).toMatch(
      /RELEASES\}" -ge "\$\{MAX_RELEASES_PER_TICK\}" \]\]; then[\s\S]{0,200}elif live_skip "\$\{PR\}"; then\n\s+NOTE="\$\(skip_note release\)"[\s\S]{0,400}labels changed since the snapshot — deferring release/,
    );
    // The summary posts FIRST (dedup'd by its own marker), then the label
    // DELETE: a failed summary leaves both labels in place and the whole
    // release retries next tick; a failed DELETE finds the marker and
    // retries only itself. Neither half can strand the other.
    expect(workflow).toMatch(
      /SUMMARY_POSTED="\$\(jq[\s\S]{0,500}fleet-shepherd auto-release/,
    );
    // R4-31: replay the dedup counter's aggregation — empty stream and a
    // stale (pre-term) marker both yield "0", a fresh one yields "1" (pins
    // `| length`; a `last` mutant would emit null and skip the summary).
    const summaryJq = workflow.match(
      /SUMMARY_POSTED="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" --arg term "\$\{TERM_TS\}" '([\s\S]*?)' \/tmp\/tk-ic\.json\)"/,
    )?.[1];
    expect(summaryJq).toBeTruthy();
    const runSummary = (comments, term) =>
      execFileSync(
        'jq',
        [
          '-r',
          '--arg',
          'ab',
          'qwen-code-dev-bot',
          '--arg',
          'term',
          term,
          summaryJq,
        ],
        { encoding: 'utf8', input: JSON.stringify(comments) },
      ).trim();
    expect(runSummary([], '2026-08-05T00:00:00Z')).toBe('0');
    expect(
      runSummary(
        [
          bot(
            '2026-08-04T00:00:00Z',
            '🔓 … <!-- fleet-shepherd auto-release -->',
          ),
        ],
        '2026-08-05T00:00:00Z',
      ),
    ).toBe('0');
    expect(
      runSummary(
        [
          bot(
            '2026-08-06T00:00:00Z',
            '🔓 … <!-- fleet-shepherd auto-release -->',
          ),
        ],
        '2026-08-05T00:00:00Z',
      ),
    ).toBe('1');
    expect(workflow).toMatch(
      /if act "#\$\{PR\}: post auto-release summary"[\s\S]{0,3200}if act "#\$\{PR\}: auto-release takeover/,
    );
    // The budget is consumed BEFORE the first external write (R4-C3): a
    // release ATTEMPT is bounded, so a DELETE outage can't mutate many PRs
    // in one tick while RELEASES stays 0.
    expect(workflow).toMatch(
      /RELEASES=\$\(\( RELEASES \+ 1 \)\)[\s\S]{0,1200}if act "#\$\{PR\}: post auto-release summary"/,
    );
    // And the DELETE removes the TAKEOVER label — never needs-human (the
    // filterable TODO must survive the release).
    expect(workflow).toMatch(
      /auto-release takeover \(paused \$\{PAUSE_D\}d\)" \\\n\s+gh api -X DELETE "repos\/\$\{REPO\}\/issues\/\$\{PR\}\/labels\/\$\(jq -rn --arg l "\$\{TAKEOVER_LABEL\}"/,
    );
    // The fail-closed deferral guards are load-bearing (a missing one runs
    // `date -d ""` under set -e and kills the tick) — pin their wording.
    expect(workflow).toContain(
      'pause timestamp unreadable — release deferred (fail closed)',
    );
    expect(workflow).toContain(
      'comment read failed — release deferred this tick',
    );
    // The release is idempotent: the summary dedups on its own marker and
    // the label side's scope condition (both labels) goes false once the
    // takeover label lands off.
    expect(workflow).toContain(
      'index($a) != null) and ([.labels[]?.name] | index($b) != null)',
    );
    expect(workflow).toContain('<!-- fleet-shepherd auto-release -->');
    // The age gate compares whole days against the tunable.
    expect(workflow).toContain('"${PAUSE_D}" -ge "${AUTO_RELEASE_DAYS}"');
    // The tunable is operator-breakable — a non-numeric repo variable falls
    // back to the default instead of dying mid-tick under set -e. Pin the
    // fallback ASSIGNMENT with the message (newline-anchored: a bare
    // toContain('AUTO_RELEASE_DAYS=3') would substring-match '=30').
    expect(workflow).toContain('=~ ^[0-9]+$');
    expect(workflow).toMatch(
      /is not numeric or is too large; using 3"\n\s+AUTO_RELEASE_DAYS=3\n/,
    );
    // The stale-label heal (R1-13): a HUMAN unlabeled event on an
    // awaiting-human PR clears the stale escalation label — budgeted,
    // skip-vetoed, never triggered by the bot's own auto-release, and (R5-10)
    // anchored to the CURRENT pause boundary (the latest needs-human
    // label-apply event), so a stale unlabel from an EARLIER cycle can't
    // heal this cycle's label, and an absent anchor skips the cleanup
    // (fail closed).
    // R8-3: BOTH cleanup levers carry the budget → live_skip veto chain
    // BEFORE their DELETE — a dropped veto would strip needs-human from a
    // skip-frozen PR that nothing manages (the R4-3 invariant, on the
    // cleanup side). R8-7: and both DELETE failure branches surface the
    // failure the same way, so the dashboard distinguishes an outage from
    // steady state.
    expect(
      workflow.match(/"\$\{CLEANUPS\}" -ge "\$\{MAX_CLEANUPS_PER_TICK\}"/g),
    ).toHaveLength(2);
    expect(workflow).toMatch(
      /NOTE='resumed; stale-label cleanup budget reached this tick'\n\s+elif live_skip "\$\{PR\}"; then\n\s+NOTE="\$\(skip_note cleanup\)"[\s\S]{0,300}clear stale \$\{NEEDS_HUMAN_LABEL\} \(re-armed\)/,
    );
    expect(workflow).toMatch(
      /NOTE='cleanup budget reached this tick'\n\s+elif live_skip "\$\{PR\}"; then\n\s+NOTE="\$\(skip_note cleanup\)"[\s\S]{0,700}clear stale \$\{NEEDS_HUMAN_LABEL\} \(manual release/,
    );
    expect(
      workflow.match(/stale-label cleanup failed — will retry next tick/g),
    ).toHaveLength(2);
    // R6-16: the heal arm's R5-8 live re-apply check sits between the skip
    // veto and the heal DELETE — a mid-tick re-engagement cancels the
    // cleanup instead of deleting a re-managed PR's escalation label.
    expect(workflow).toMatch(
      /skip_note cleanup\)"[\s\S]{0,600}takeover label re-applied since the snapshot — cleanup cancelled'[\s\S]{0,300}clear stale \$\{NEEDS_HUMAN_LABEL\} \(manual release/,
    );
    const nhApplyJq = workflow.match(
      /NH_APPLY_TS="\$\(jq -r --arg nl "\$\{NEEDS_HUMAN_LABEL\}" '([\s\S]*?)' \/tmp\/tk-ev\.json\)"/,
    )?.[1];
    const unlabelJq = workflow.match(
      /UNLABEL_ACTOR="\$\(jq -r --arg tl "\$\{TAKEOVER_LABEL\}" --arg ab "\$\{AUTOFIX_BOT\}" --arg ll "\$\{NH_APPLY_TS\}" '([\s\S]*?)' \/tmp\/tk-ev\.json\)"/,
    )?.[1];
    expect(nhApplyJq).toBeTruthy();
    expect(unlabelJq).toBeTruthy();
    // R8-19: the absent-anchor guard is pinned — without it UNLABEL_ACTOR
    // would be computed against an empty anchor and admit every human
    // takeover-unlabel in the window (a needs-human apply past the ~90-day
    // events lookback must skip the heal, not admit everything).
    expect(workflow).toMatch(
      /UNLABEL_ACTOR=''\n\s+if \[\[ -n "\$\{NH_APPLY_TS\}" \]\]; then/,
    );
    const runUnlabel = (events) => {
      const ll = execFileSync(
        'jq',
        ['-r', '--arg', 'nl', 'autofix/needs-human', nhApplyJq],
        { encoding: 'utf8', input: JSON.stringify(events) },
      ).trim();
      if (ll === '') return '';
      return execFileSync(
        'jq',
        [
          '-r',
          '--arg',
          'tl',
          'autofix/takeover',
          '--arg',
          'ab',
          'qwen-code-dev-bot',
          '--arg',
          'll',
          ll,
          unlabelJq,
        ],
        { encoding: 'utf8', input: JSON.stringify(events) },
      ).trim();
    };
    const nhLabeled = (ts) => ({
      event: 'labeled',
      label: { name: 'autofix/needs-human' },
      created_at: ts,
    });
    // Same-cycle manual release → heal fires (human unlabel newer than the
    // current pause's label-apply).
    expect(
      runUnlabel([
        nhLabeled('2026-08-01T12:00:00Z'),
        {
          event: 'unlabeled',
          label: { name: 'autofix/takeover' },
          actor: { login: 'wenshao' },
          created_at: '2026-08-02T00:00:00Z',
        },
      ]),
    ).toBe('wenshao');
    // The bot's own unlabel (the auto-release DELETE) must NOT trigger a
    // cleanup — needs-human survives auto-release by design.
    expect(
      runUnlabel([
        nhLabeled('2026-08-01T12:00:00Z'),
        {
          event: 'unlabeled',
          label: { name: 'autofix/takeover' },
          actor: { login: 'qwen-code-dev-bot' },
          created_at: '2026-08-02T00:00:00Z',
        },
      ]),
    ).toBe('');
    // R5-10's core scenario: a stale human unlabel OLDER than the current
    // pause's needs-human apply must not heal (cycle-1 human release, then
    // /retry re-arm + re-cap re-applied needs-human).
    expect(
      runUnlabel([
        {
          event: 'unlabeled',
          label: { name: 'autofix/takeover' },
          actor: { login: 'wenshao' },
          created_at: '2026-08-01T00:00:00Z',
        },
        {
          event: 'labeled',
          label: { name: 'autofix/takeover' },
          created_at: '2026-08-02T00:00:00Z',
        },
        nhLabeled('2026-08-03T00:00:00Z'),
        {
          event: 'unlabeled',
          label: { name: 'autofix/takeover' },
          actor: { login: 'qwen-code-dev-bot' },
          created_at: '2026-08-05T00:00:00Z',
        },
      ]),
    ).toBe('');
    // An absent anchor (needs-human apply beyond the ~90-day events
    // lookback) → cannot correlate → cleanup skipped (fail closed).
    expect(
      runUnlabel([
        {
          event: 'unlabeled',
          label: { name: 'autofix/takeover' },
          actor: { login: 'wenshao' },
          created_at: '2026-08-02T00:00:00Z',
        },
      ]),
    ).toBe('');
    // R6-27: a two-cycle history pins the LATEST anchor (`| max`): the
    // human unlabel healed cycle 1 — it must NOT heal cycle 2's fresh
    // label (a `min` mutant anchors on cycle 1 and admits the stale
    // unlabel).
    expect(
      runUnlabel([
        nhLabeled('2026-08-01T00:00:00Z'),
        {
          event: 'unlabeled',
          label: { name: 'autofix/takeover' },
          actor: { login: 'wenshao' },
          created_at: '2026-08-02T00:00:00Z',
        },
        nhLabeled('2026-08-03T00:00:00Z'),
      ]),
    ).toBe('');
    // A human unlabel of an UNRELATED label must not count (pins the
    // `.label.name == $tl` select).
    expect(
      runUnlabel([
        nhLabeled('2026-08-01T12:00:00Z'),
        {
          event: 'unlabeled',
          label: { name: 'autofix/skip' },
          actor: { login: 'wenshao' },
          created_at: '2026-08-02T00:00:00Z',
        },
      ]),
    ).toBe('');
    // The heal removes NEEDS_HUMAN (never takeover), act-wrapped.
    expect(workflow).toMatch(
      /clear stale \$\{NEEDS_HUMAN_LABEL\}[\s\S]{0,300}gh api -X DELETE "repos\/\$\{REPO\}\/issues\/\$\{PR\}\/labels\/\$\(jq -rn --arg l "\$\{NEEDS_HUMAN_LABEL\}"/,
    );
    // act() echoes its own DRY-RUN preview / failure warning — the two new
    // DELETE levers must not swallow that with a redirect (R2-5).
    const actDeleteSites = workflow.match(
      /act "[^\n]+" \\\n\s+gh api -X DELETE[^\n]+/g,
    );
    expect(actDeleteSites?.length).toBeGreaterThanOrEqual(2);
    for (const site of actDeleteSites ?? []) {
      expect(site).not.toContain('> /dev/null');
    }
    // A zero-padded variable must not kill the lever: base-10 normalize
    // AFTER the numeric guard (R2-6). Pin the ORDER, anchored on the
    // AUTO_RELEASE_DAYS-specific guard line — a looser regex would match the
    // unrelated COUNT guard earlier in the file, and moving the normalize
    // above the guard would let `$((10#abc))` abort the tick under set -e
    // (R3-10). R4-C5: the guard ALSO rejects over-long digit strings before
    // any arithmetic (Bash-int overflow would wrap negative and pass -ge).
    expect(workflow).toContain('is not numeric or is too large; using 3');
    expect(workflow).toMatch(
      /if \[\[ ! "\$\{AUTO_RELEASE_DAYS\}" =~ \^\[0-9\]\+\$ \]\] \|\| \[\[ \$\{#AUTO_RELEASE_DAYS\} -gt 2 \]\]; then[\s\S]*?AUTO_RELEASE_DAYS=\$\(\(10#\$\{AUTO_RELEASE_DAYS\}\)\)/,
    );
    // The summary dedup is scoped to THIS pause cycle — markers older than
    // the latest cap notice don't suppress a second release's summary
    // (R2-4).
    expect(workflow).toContain('select((.created_at // "") > $term)');
    // Tick summary and dashboard header report the same counters (R1-12).
    expect(workflow).toContain(
      '✅ tick complete (syncs=${SYNCS} dispatches=${DISPATCHES} releases=${RELEASES} cleanups=${CLEANUPS} noop_notices=${NOTICES} closes=${CLOSES} noop_probe_failures=${PROBE_FAILS})',
    );
    expect(workflow).toContain('cleanups: ${CLEANUPS}');
    expect(workflow).toContain(
      'no-op notices: ${NOTICES} · closes: ${CLOSES} · no-op probe failures: ${PROBE_FAILS}',
    );
    // Dynamic note text is sanitized before it reaches the printf '%b'
    // table: backslashes first (else %b expands them), then pipes.
    expect(workflow).toContain('SAFE_NOTE="${NOTE//\\\\/\\\\\\\\}"');
    expect(workflow).toContain('${SAFE_NOTE//|/\\\\|}');
    // Shared day-math helper (R1-10) instead of pasted epoch arithmetic.
    expect(workflow).toContain('days_since() {');
    // Loop 3 renders exactly one row per needs-human-only PR — appended
    // OUTSIDE the evaluation arms, so a fail-closed deferral (event read
    // failure) still renders instead of silently vanishing from the
    // dashboard for the tick something went wrong.
    const loop3 = workflow.match(
      /# Loop 3: needs-human-ONLY PRs[\s\S]*?done < <\(jq -c '\.\[\]' \/tmp\/human\.json\)/,
    )?.[0];
    expect(loop3).toBeTruthy();
    expect(loop3.match(/echo "🐑 #\$\{PR\} \[/g)).toHaveLength(1);
    expect(loop3.match(/HUMAN_ROWS="\$\{HUMAN_ROWS\}/g)).toHaveLength(1);
    // R2-17: …and the append is POSITIONALLY outside the evaluation arms
    // (a bare occurrence count can't tell arm-level from loop-body level).
    expect(loop3).toMatch(
      /\n {14}fi\n(?: {14}#[^\n]*\n)* {14}echo "🐑 #\$\{PR\} \[/,
    );
    // R8-15: the post-action routing — a successful release sets
    // ROUTE='awaiting' so the row lands in Awaiting human, and loop 3 both
    // defaults to awaiting and guards its append on ROUTE != none (a heal
    // drops the row entirely).
    expect(workflow).toMatch(
      /ROUTE='awaiting'\n\s+NOTE="auto-released after \$\{PAUSE_D\}d paused"/,
    );
    expect(workflow).toMatch(
      /elif \[\[ "\$\{ROUTE\}" == 'awaiting' \]\]; then\n\s+HUMAN_ROWS=/,
    );
    expect(loop3).toContain("ROUTE='awaiting'");
    expect(loop3).toContain('[[ "${ROUTE}" != \'none\' ]]');
  });

  it('pins the marker/headline contracts against qwen-autofix.yml — drift fails here, not in production', () => {
    // The resume-marker set, the trusted re-arm commands, and the terminal
    // headline formats are all PRODUCED by qwen-autofix.yml and CONSUMED by
    // the shepherd. Each side's own suite pins its own file; only a
    // cross-file assertion fails when one side moves without the other.
    const autofix = readFileSync('.github/workflows/qwen-autofix.yml', 'utf8');
    // 1. Resume markers: the scan's REARM_KEY (the write side's own idea of
    //    "management resumed") and the shepherd's RESUME_TS must name the
    //    same markers — compare the FULL sets, so a resume path added to
    //    only one file fails here, never as a wrongful auto-release (R2-10).
    const rearmKey = autofix.match(
      /REARM_KEY="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" '([\s\S]*?)'/,
    )?.[1];
    expect(rearmKey).toBeTruthy();
    const resumeTs = workflow.match(
      /local resume refusal\n\s+resume="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" '([\s\S]*?)' "\$\{ic\}"\)"/,
    )?.[1];
    expect(resumeTs).toBeTruthy();
    const markerSet = (p) =>
      new Set(
        [...p.matchAll(/contains\("(<!-- [^"]+ -->)"\)/g)].map((m) => m[1]),
      );
    expect(markerSet(rearmKey)).toEqual(markerSet(resumeTs));
    // R5-16: conflict_paused carries a THIRD copy of the resume-marker set
    // — compare its resume jq against the same resume set so a marker added
    // to only one side fails here too, never as a silent dispatch
    // suppression.
    const conflictResumeJq = workflow.match(
      /resume="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" '([\s\S]*?)' \/tmp\/cf-ic\.json\)"/,
    )?.[1];
    expect(conflictResumeJq).toBeTruthy();
    expect(markerSet(conflictResumeJq)).toEqual(markerSet(resumeTs));
    // 1b. The label constants the whole integration keys on (R2-11).
    expect(autofix).toContain("NEEDS_HUMAN_LABEL: 'autofix/needs-human'");
    expect(autofix).toContain("TAKEOVER_LABEL: 'autofix/takeover'");
    // 2. The re-arm commands the shepherd greps for are MIRRORED constants
    //    (R7-2): the shepherd env defines TAKEOVER_COMMAND/RETRY_COMMAND and
    //    passes them to the matcher via --arg, so they must equal the
    //    qwen-autofix.yml route constants exactly — a command-syntax edit on
    //    the autofix side desyncs here, not silently in production. The
    //    refusal-ack variants that supersede a refused command are exactly
    //    the ones the producer can emit.
    expect(autofix).toContain("TAKEOVER_COMMAND: '@qwen-code /takeover'");
    expect(autofix).toContain("RETRY_COMMAND: '@qwen-code /retry'");
    expect(workflow).toContain("TAKEOVER_COMMAND: '@qwen-code /takeover'");
    expect(workflow).toContain("RETRY_COMMAND: '@qwen-code /retry'");
    // R8-6: the env constant is the ONLY literal command text in this file
    // — the auto-release summary interpolates TAKEOVER_COMMAND like every
    // ack body on the producer side, so a command-syntax rename can never
    // strand a hardcoded instruction.
    expect(workflow.match(/@qwen-code \/takeover/g)).toHaveLength(1);
    expect(workflow).toContain(
      'comment `%s` to re-engage with a fresh round window',
    );
    const cmdTs = workflow.match(
      /cands="\$\(jq -r --arg tc "\$\{TAKEOVER_COMMAND\}" --arg rc "\$\{RETRY_COMMAND\}" '([\s\S]*?)' "\$\{ic\}"\)"/,
    )?.[1];
    expect(cmdTs).toBeTruthy();
    // The matcher compares against the --arg'd constants, not hardcoded
    // literals — so it can never drift from the env constants above.
    expect(cmdTs).toContain('== $tc');
    expect(cmdTs).toContain('== $rc');
    const refusalTs = workflow.match(
      /refusal="\$\(jq -r --arg ab "\$\{AUTOFIX_BOT\}" '([\s\S]*?)' "\$\{ic\}"\)"/,
    )?.[1];
    expect(refusalTs).toBeTruthy();
    // Compare the refusal-variant SET against the producer's full ack
    // taxonomy (minus engaged/released) — a one-sided addition on either
    // side fails here (R2-10).
    const producerAckVariants = new Set(
      [...autofix.matchAll(/<!-- takeover-ack ([a-z-]+) -->/g)].map(
        (m) => m[1],
      ),
    );
    // release-failed is a release-side outcome ack (posted only when the
    // release DELETE did NOT land), not a command-superseding refusal.
    const producerRefusals = [...producerAckVariants].filter(
      (v) => v !== 'engaged' && v !== 'released' && v !== 'release-failed',
    );
    expect(producerRefusals.sort()).toEqual([
      'base-refused',
      'fork-refused',
      'skip-blocked',
    ]);
    const shepherdRefusals = (
      refusalTs.match(/takeover-ack \(([^)]+)\)/)?.[1] ?? ''
    )
      .split('|')
      .filter(Boolean)
      .sort();
    expect(shepherdRefusals).toEqual(producerRefusals.sort());
    // 3. Every TERMINAL headline the address leg can print matches the
    //    shepherd's REASON regex, and the transient setup-failure headline
    //    does not. Templates are extracted from the producer and exercised
    //    against the consumer's verbatim regex — a reworded headline on
    //    either side fails this test.
    const reasonRe = workflow.match(
      /REASON="\$\(jq -r[\s\S]*?\| test\("([^"]+)"\)\)/,
    )?.[1];
    expect(reasonRe).toBeTruthy();
    const headlines = [...autofix.matchAll(/HEADLINE="(🤖 [^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(headlines.length).toBeGreaterThanOrEqual(5);
    const terminal = headlines.filter(
      (h) =>
        h.includes('stopped after') ||
        h.includes('stopped: this counting window') ||
        h.includes('could not start evaluation') ||
        h.includes('reached the round cap') ||
        h.includes('this was the last automatic attempt'),
    );
    // R4-S1: BOTH sets must be explicit and exhaustive. A headline in
    // neither list means the producer added wording nobody classified — and
    // if that wording is terminal, the dashboard reason silently degrades.
    // So unclassified must be EMPTY, not "asserted false": require every
    // producer headline to be named terminal or transient here.
    const transient = headlines.filter(
      (h) =>
        h.includes('a setup step failed') ||
        h.includes('will retry on the next scan') ||
        h.includes('Could not produce a passing fix for this feedback') ||
        h.includes('deferred this item to a human under instruction') ||
        h.includes('wrote a handoff but left a dirty workspace') ||
        h.includes('wrote a handoff but the round HAS a commit') ||
        // #10110: the report step held its stale-base update-branch because
        // a review-pr was in flight; the loop retries next scan, so the
        // shepherd must read it as a transient stop, never a terminal one.
        h.includes('deferred a stale-base refresh'),
    );
    const unclassified = headlines.filter(
      (h) => !terminal.includes(h) && !transient.includes(h),
    );
    expect(terminal.length).toBe(5);
    expect(transient).toHaveLength(8);
    expect(unclassified).toEqual([]);
    const matches = (h) =>
      execFileSync('jq', ['-rn', '--arg', 'b', h, `$b | test("${reasonRe}")`], {
        encoding: 'utf8',
      }).trim();
    for (const h of terminal) expect(matches(h)).toBe('true');
    for (const h of transient) expect(matches(h)).toBe('false');
  });

  it('pins the review-address job-name contract against qwen-autofix.yml — the busy rail’s input (R2-7)', () => {
    // The rail matches GitHub's generated matrix display name
    // `review-address (<pr>, …)`. The contract is exactly: no job-level
    // `name:` (it would replace the generated name), exactly one matrix
    // dimension (a second would append values), and `pr` FIRST in the
    // targets object (the rail's capture is prefix-anchored). A drift on the
    // producer side fails HERE, not silently in production — there the
    // rail's gh run view SUCCEEDS on a renamed job and captures nothing,
    // which reads as "nothing live": fail-OPEN onto a close under a working
    // agent.
    const autofixDoc = parse(
      readFileSync('.github/workflows/qwen-autofix.yml', 'utf8'),
    );
    const addressJob = autofixDoc.jobs['review-address'];
    expect(addressJob).toBeTruthy();
    expect(addressJob.name).toBeUndefined();
    expect(Object.keys(addressJob.strategy.matrix)).toEqual(['target']);
    expect(autofixTargetsKeys[0]).toBe('pr');
  });

  it('pins the previously mutation-tested gaps from review round 2', () => {
    // R2-7: days_since() is behaviorally replayed (the /86400 → /3600
    // mutation must fail) — the shared module-scope GNU date shim applies.
    const daysSince = workflow.match(/days_since\(\) \{[\s\S]*?\n {10}\}/)?.[0];
    expect(daysSince).toBeTruthy();
    const runDays = (now, ts) =>
      execFileSync(
        'bash',
        [
          '-c',
          `${gnuDateShim}\n${daysSince.replace(/\n {10}/g, '\n')}\ndays_since "\${TS}"`,
        ],
        {
          env: { ...process.env, NOW_EPOCH: String(now), TS: ts },
          encoding: 'utf8',
        },
      ).trim();
    const NOW = Date.parse('2026-08-10T00:00:00Z') / 1000;
    expect(runDays(NOW, '2026-08-07T01:00:00Z')).toBe('2');
    expect(runDays(NOW, '2026-08-06T23:00:00Z')).toBe('3');
    // R2-8: the 🛑 prefix must reach the bot-fleet row, not just exist.
    expect(workflow).toContain('${NH_PREFIX}${STATUS_NOTE} | ${ACTION_NOTE} |');
    // R2-18: the prefix condition's truth mapping — replay verbatim.
    const nhCond = workflow.match(
      /if \[\[ "\$\(jq -r --arg l "\$\{NEEDS_HUMAN_LABEL\}" '([^']*)' <<< "\$\{ROW\}"\)" == "true" \]\]/,
    )?.[1];
    expect(nhCond).toBeTruthy();
    const nhRun = (labels) =>
      execFileSync('jq', ['-r', '--arg', 'l', 'autofix/needs-human', nhCond], {
        encoding: 'utf8',
        input: JSON.stringify({ labels }),
      }).trim();
    expect(nhRun([{ name: 'autofix/needs-human' }])).toBe('true');
    expect(nhRun([])).toBe('false');
    // R2-9: loop 1's deferral and its HM_OK=false fallback are pinned.
    const loop1 = workflow.match(
      /# Loop 1: managed takeover PRs[\s\S]*?done < <\(jq -c '\.\[\]' \/tmp\/takeover\.json\)/,
    )?.[0];
    expect(loop1).toBeTruthy();
    expect(loop1).toContain('continue # loop 2 renders this paused PR');
    expect(loop1).toContain(
      'pause evaluation unavailable this tick (truncated or unreadable paused enumeration)',
    );
    // R2-16: the needs-human skip filter is byte-identical to the pinned
    // takeover filter (an inverted population ships red, not green). The
    // [^']+ capture cannot span across call sites (the lazy [\s\S]*? form
    // silently would).
    const humanFilter = workflow.match(
      /jq --arg skip "\$\{SKIP_LABEL\}" \\\n\s+'([^']+)' \\\n\s+\/tmp\/human-raw\.json/,
    )?.[1];
    expect(humanFilter).toBeTruthy();
    const takeoverFilterP = workflow.match(
      /jq --arg skip "\$\{SKIP_LABEL\}" \\\n\s+'([^']+)' \\\n\s+\/tmp\/takeover-raw\.json/,
    )?.[1];
    expect(humanFilter).toBe(takeoverFilterP);
    // R2-24/R2-28: the needs-human enumeration (the awaiting DISPLAY
    // population) carries the stale-first sort and the labels payload.
    const humanEnum = workflow.match(
      /--label "\$\{NEEDS_HUMAN_LABEL\}"[\s\S]*?\/tmp\/human-raw\.json/,
    )?.[0];
    expect(humanEnum).toBeTruthy();
    expect(humanEnum).toContain("--search 'sort:updated-asc'");
    expect(humanEnum).toContain(
      '--json number,author,updatedAt,mergeable,labels',
    );
    // R8-12: the release lever's OWN paused enumeration (R5-7) is pinned on
    // the same axes as its siblings: the skip filter, the stale-first sort,
    // the labels payload, the saturation warning, and loop 2's feed + gate.
    const pausedEnum = workflow.match(
      /--label "\$\{TAKEOVER_LABEL\}" --label "\$\{NEEDS_HUMAN_LABEL\}"[\s\S]*?\/tmp\/paused-raw\.json/,
    )?.[0];
    expect(pausedEnum).toBeTruthy();
    expect(pausedEnum).toContain("--search 'sort:updated-asc'");
    expect(pausedEnum).toContain(
      '--json number,author,updatedAt,mergeable,labels',
    );
    expect(workflow).toContain(
      'paused-takeover pool at the 100-PR enumeration limit',
    );
    const pausedFilter = workflow.match(
      /jq --arg skip "\$\{SKIP_LABEL\}" \\\n\s+'([^']+)' \\\n\s+\/tmp\/paused-raw\.json/,
    )?.[1];
    expect(pausedFilter).toBe(takeoverFilterP);
    expect(workflow).toMatch(
      /if \[\[ "\$\{PAUSED_OK\}" == "true" \]\]; then\n\s+while IFS= read -r ROW; do[\s\S]*?done < <\(jq -c '\.\[\]' \/tmp\/paused\.json\)/,
    );
    // R2-22: neither enumeration failure may terminate the tick — any
    // spelling of exit — because the dashboard write carries the liveness
    // watermark.
    expect(workflow).not.toMatch(
      /takeover enumeration failed[\s\S]{0,400}exit( 0| 1)?\b/,
    );
    expect(workflow).not.toMatch(
      /needs-human enumeration failed[\s\S]{0,400}exit( 0| 1)?\b/,
    );
    // R2-29: both loop-2 evidence fetches paginate (paused PRs are the
    // high-comment population — page 1 alone misses the newest notice).
    // R4-28: pin the page-MERGE program too — GitHub returns comments
    // oldest-first, so `.[0] // []` would anchor TERM_TS to a stale page-1
    // cycle while the current cycle's re-arm marker sits on page 2.
    // R8-16: the events fetch exists TWICE — loop 3's heal read shares the
    // shape; pin both occurrences, and pin loop 3's site INSIDE its own
    // extraction so dropping --paginate only there (loop 3's population is
    // the long-lived one that outgrows a page first) fails.
    expect(
      workflow.match(
        /issues\/\$\{PR\}\/events" --paginate 2> \/dev\/null \| jq -s 'add \/\/ \[\]' > \/tmp\/tk-ev\.json/g,
      ),
    ).toHaveLength(2);
    expect(workflow).toMatch(
      /issues\/\$\{PR\}\/comments" --paginate 2> \/dev\/null \| jq -s 'add \/\/ \[\]' > \/tmp\/tk-ic\.json/,
    );
    const loop3Pag = workflow.match(
      /# Loop 3: needs-human-ONLY PRs[\s\S]*?done < <\(jq -c '\.\[\]' \/tmp\/human\.json\)/,
    )?.[0];
    expect(loop3Pag).toBeTruthy();
    expect(loop3Pag).toMatch(
      /issues\/\$\{PR\}\/events" --paginate 2> \/dev\/null \| jq -s 'add \/\/ \[\]' > \/tmp\/tk-ev\.json/,
    );
    // R2-3: a re-arm landing BETWEEN the summary post and the DELETE is
    // caught by a final evidence re-fetch immediately before the removal —
    // the re-arm's label re-apply is a no-op while the label still rides
    // the PR, so no live label read can catch it. Pin the shape and the
    // veto's ordering ahead of the DELETE.
    expect(workflow).toMatch(
      /issues\/\$\{PR\}\/comments" --paginate 2> \/dev\/null \| jq -s 'add \/\/ \[\]' > \/tmp\/tk-ic3\.json[\s\S]{0,200}issues\/\$\{PR\}\/events" --paginate 2> \/dev\/null \| jq -s 'add \/\/ \[\]' > \/tmp\/tk-ev3\.json/,
    );
    expect(workflow).toContain(
      're-arm landed during the release — takeover kept',
    );
    // R6-8: the pre-write re-fetches paginate too — a page-1-only re-check
    // reads the OLDEST comments and would miss a just-landed re-arm marker
    // on exactly the high-comment paused population. R6-14: and the
    // re-check's fail-closed arm, its veto comparison, and the cancellation
    // NOTE are pinned (both re-check sites share the fail-closed wording).
    expect(workflow).toMatch(
      /issues\/\$\{PR\}\/comments" --paginate 2> \/dev\/null \| jq -s 'add \/\/ \[\]' > \/tmp\/tk-ic2\.json/,
    );
    expect(workflow).toMatch(
      /issues\/\$\{PR\}\/events" --paginate 2> \/dev\/null \| jq -s 'add \/\/ \[\]' > \/tmp\/tk-ev2\.json/,
    );
    expect(
      workflow.match(
        /evidence re-check unreadable — release deferred \(fail closed\)/g,
      ),
    ).toHaveLength(2);
    expect(workflow).toContain(
      'resume evidence appeared during evaluation — release cancelled',
    );
    expect(
      workflow.match(
        /\[\[ -n "\$\{RESUME_NOW\}" && ! "\$\{TERM_TS\}" > "\$\{RESUME_NOW\}" \]\]/g,
      ),
    ).toHaveLength(2);
    expect(workflow).toMatch(
      /re-arm landed during the release — takeover kept'[\s\S]{0,400}auto-release takeover \(paused/,
    );
    // R2-19: the release scope check requires BOTH labels — the --arg
    // bindings are the load-bearing part. R3-12: the pin runs through the
    // comparison operator, so a polarity flip (`!=` → `==`) of the scope
    // guard fails instead of silently releasing label-changed PRs.
    expect(workflow).toContain(
      'jq -r --arg a "${TAKEOVER_LABEL}" --arg b "${NEEDS_HUMAN_LABEL}" \'([.labels[]?.name] | index($a) != null) and ([.labels[]?.name] | index($b) != null)\' <<< "${LIVE_LABELS_JSON}")" != "true" ]]; then',
    );
    // R2-20: live_skip exports the payload the scope check rides.
    expect(workflow).toContain(
      'LIVE_LABELS_JSON="$(gh pr view "${pr}" --repo "${REPO}" --json labels,state,headRefOid',
    );
    // R2-12/R5-9: the labeled-event merge lives in compute_resume_ts with a
    // tie-safe comparison — an event at-or-newer than other evidence wins.
    expect(workflow).toMatch(
      /if \[\[ -n "\$\{evt\}" && ! "\$\{resume\}" > "\$\{evt\}" \]\]; then\n\s+resume="\$\{evt\}"/,
    );
    // R2-21/R8-5: the resume evidence is computed only at RELEASE time —
    // the pre-summary recompute (R5-6) and the pre-DELETE re-check (R2-3)
    // — in the global-return form (a `$(...)` subshell would drop
    // PERM_READ_FAILED, making the R5-4 defer dead code). The old
    // loop-entry call left a dead RESUME_TS store and spent discarded
    // permission reads every tick; it must not return.
    expect(workflow).toContain(
      'compute_resume_ts /tmp/tk-ic2.json /tmp/tk-ev2.json; RESUME_NOW="${RESUME_OUT}"',
    );
    expect(workflow).not.toContain('$(compute_resume_ts');
    expect(workflow).not.toContain('RESUME_TS=');
    // R8-1: the re-armed cleanup branch PRECEDES the empty-TERM_TS
    // deferral, so a lost cap notice cannot make it unreachable.
    expect(workflow).toMatch(
      /STATE='managed \(re-armed\)'[\s\S]*?elif \[\[ -z "\$\{TERM_TS\}" \]\]; then/,
    );
    // R5-4: a failed permission read defers the release (fail closed),
    // pinned at BOTH release-time evaluation points (the pre-summary veto
    // and the pre-DELETE R2-3 re-check).
    expect(
      workflow.match(/command-permission read failed — release deferred/g)
        ?.length,
    ).toBe(2);
    // R9-5: the cleanups budget counts ATTEMPTS like the release budget —
    // incremented BEFORE the act() call in both arms, so a DELETE outage
    // trips the cap instead of leaving it at 0 while every candidate burns
    // a live read plus a failing DELETE each tick.
    expect(workflow).toMatch(
      /CLEANUPS=\$\(\( CLEANUPS \+ 1 \)\)\n\s+if act "#\$\{PR\}: clear stale \$\{NEEDS_HUMAN_LABEL\} \(re-armed\)/,
    );
    expect(workflow).toMatch(
      /CLEANUPS=\$\(\( CLEANUPS \+ 1 \)\)\n\s+if act "#\$\{PR\}: clear stale \$\{NEEDS_HUMAN_LABEL\} \(manual release/,
    );
    // R2-23: both shepherd DELETEs are URI-encoded (the encoded path is the
    // addressable route).
    expect(workflow).toMatch(
      /auto-release takeover \(paused \$\{PAUSE_D\}d\)" \\\n\s+gh api -X DELETE "repos\/\$\{REPO\}\/issues\/\$\{PR\}\/labels\/\$\(jq -rn --arg l "\$\{TAKEOVER_LABEL\}" '\$l\|@uri'\)"/,
    );
    // R3-2: the takeover-enum error row must NOT claim "no release
    // evaluation ran" — the lever is fed by the paused enumeration.
    expect(workflow).toContain(
      'paused rows below still evaluated (paused pool fed)',
    );
    expect(workflow).not.toContain('fail closed — no release evaluation ran');
    // R3-8: the conflict-dispatch lever refuses a paused (needs-human) PR
    // instead of spending a dispatch slot the scan would refuse. R4-C1: the
    // check reads the LIVE label payload (after live_skip), not the
    // tick-start snapshot — a needs-human applied after enumeration is
    // still caught.
    expect(workflow).toContain(
      'paused (needs-human) — conflict stays unhandled until re-arm',
    );
    expect(workflow).toMatch(
      /elif \[\[ "\$\(jq -r --arg l "\$\{NEEDS_HUMAN_LABEL\}" '\[\.labels\[\]\?\.name\] \| index\(\$l\) != null' <<< "\$\{LIVE_LABELS_JSON\}"\)" == "true" \]\] && conflict_paused "\$\{PR\}"; then\n\s+#[\s\S]*?conflict stays unhandled until re-arm/,
    );
    // R4-6: the marker-truth helper exists and fails closed (an unreadable
    // comment history suppresses the dispatch, not wastes it).
    expect(workflow).toContain('conflict_paused() {');
    expect(workflow).toMatch(
      /conflict_paused\(\) \{[\s\S]*?return 0[\s\S]*?return 1[\s\S]*?return 0/,
    );
    // R5-14: replay conflict_paused's decision condition (a structural pin
    // alone lets `-n term &&` drop and every label-without-notice PR read as
    // "armed"). The helper reads /tmp/cf-ic.json via gh, so stub gh to write
    // it and run the extracted function verbatim.
    const conflictFn = workflow.match(
      /(conflict_paused\(\) \{[\s\S]*?\n {10}\})/,
    )?.[1];
    expect(conflictFn).toBeTruthy();
    const conflictPaused = ({ comments, failRead = false }) => {
      const dir = mkdtempSync(join(tmpdir(), 'conflict-'));
      try {
        // gh api --paginate emits the paginated array to stdout; the helper
        // itself pipes it through `jq -s 'add // []'`.
        writeFileSync(
          join(dir, 'gh'),
          [
            '#!/usr/bin/env bash',
            'if [[ "$1" == "api" ]]; then',
            `  if [[ "${failRead}" == "true" ]]; then echo "HTTP 502" >&2; exit 1; fi`,
            `  printf '%s' '${JSON.stringify(comments).replace(/'/g, `'\\''`)}'`,
            'fi',
          ].join('\n'),
        );
        chmodSync(join(dir, 'gh'), 0o755);
        // R10-2: same isolation as the compute_resume_ts replay — the
        // verbatim function writes /tmp/cf-ic.json, a path shared with
        // every concurrent run on the machine.
        const replayFn = conflictFn
          .replace(/\n {10}/g, '\n')
          .replaceAll('/tmp/cf-ic.json', join(dir, 'cf-ic.json'));
        expect(replayFn).not.toContain('/tmp/cf-ic.json');
        const res = spawnSync(
          'bash',
          [
            '-c',
            `${replayFn}\nif conflict_paused 7354; then echo PAUSED; else echo ARMED; fi`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              REPO: 'QwenLM/qwen-code',
              AUTOFIX_BOT: 'qwen-code-dev-bot',
            },
            encoding: 'utf8',
          },
        );
        return res.stdout.trim();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const bot = (ts, body) => ({
      user: { login: 'qwen-code-dev-bot' },
      created_at: ts,
      body,
    });
    // No cap notice + old engage ack → paused (fail closed, R5-3).
    expect(
      conflictPaused({
        comments: [
          bot('2026-08-01T00:00:00Z', '🤝 … <!-- takeover-ack engaged -->'),
        ],
      }),
    ).toBe('PAUSED');
    // Re-arm newer than the cap notice → armed.
    expect(
      conflictPaused({
        comments: [
          bot('2026-08-01T00:00:00Z', '⏸️ … <!-- takeover-cap-reached -->'),
          bot('2026-08-02T00:00:00Z', '🔄 … <!-- autofix-rearm -->'),
        ],
      }),
    ).toBe('ARMED');
    // Cap notice newer than the re-arm → paused.
    expect(
      conflictPaused({
        comments: [
          bot('2026-08-02T00:00:00Z', '🔄 … <!-- autofix-rearm -->'),
          bot('2026-08-03T00:00:00Z', '⏸️ … <!-- takeover-cap-reached -->'),
        ],
      }),
    ).toBe('PAUSED');
    // Unreadable comments → paused (fail closed).
    expect(conflictPaused({ comments: [], failRead: true })).toBe('PAUSED');
    // R4-9: loop 1 defers a paused PR to loop 2 ONLY when it is actually in
    // the paused enumeration (membership), so a truncated PR still renders.
    expect(workflow).toContain(
      'HUMAN_IDS=",$(jq -r \'[.[].number | tostring] | join(",")\' /tmp/paused.json),"',
    );
    expect(workflow).toContain('if [[ "${HUMAN_IDS}" == *",${PR},"* ]]; then');
    // R9-1/R9-13: loop 3 renders a both-label PR only when BOTH other
    // owners are blind — not a paused member AND the takeover enumeration
    // failed — so a paused-enum outage never duplicates the row and a
    // takeover-enum outage never drops it.
    expect(workflow).toContain(
      '[[ "${HUMAN_IDS}" == *",${PR},"* || "${TK_OK}" == "true" ]] && continue',
    );
    // R4-10: loop 1's row escapes STATE (the ci-red detailsUrl) as well as
    // NOTE — a `|` or `\c` in the URL must not break the printf '%b' table.
    expect(workflow).toContain('SAFE_STATE="${STATE//\\\\/\\\\\\\\}"');
    expect(workflow).toContain('${SAFE_STATE//|/\\\\|}');
    // R4-13: the takeover-enum error row is finalized AFTER the paused
    // result and branches on PAUSED_OK — it must not claim evaluation
    // proceeds when the paused feed also failed.
    expect(workflow).toContain(
      'paused rows NOT evaluated — paused enumeration also failed',
    );
    // R4-14: a command comment counts only after a write/maintain/admin
    // permission read on its author.
    expect(workflow).toContain(
      'gh api "repos/${REPO}/collaborators/${cauthor}/permission"',
    );
    expect(workflow).toMatch(
      /cperm}" == 'write' \|\| "\$\{cperm\}" == 'maintain' \|\| "\$\{cperm\}" == 'admin'/,
    );
    // R1-10: the CI-status classifiers are shared helpers, and NEITHER loop
    // inlines its own copy of the jq (a check-naming change must land once).
    expect(workflow).toContain('pending_checks() {');
    expect(workflow).toContain('failed_test_url() {');
    expect(
      workflow.match(/PENDING="\$\(pending_checks "\$\{ROW\}"\)/g),
    ).toHaveLength(2);
    expect(
      workflow.match(/FAILED_TEST_URL="\$\(failed_test_url "\$\{ROW\}"\)/g),
    ).toHaveLength(2);
    expect(workflow).not.toContain(
      'IN("QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"))] | length\' <<< "${ROW}"',
    );
    // R4-11: the two classifiers are replayed behaviorally (a polarity or
    // arithmetic mutation of the jq body must fail, not ship green).
    const pendingJq = workflow.match(
      /pending_checks\(\) \{\n\s+jq -r '([^']+)'/,
    )?.[1];
    const failedJq = workflow.match(
      /failed_test_url\(\) \{\n\s+jq -r '([^']+)'/,
    )?.[1];
    expect(pendingJq).toBeTruthy();
    expect(failedJq).toBeTruthy();
    const runClassifier = (prog, rollup) =>
      execFileSync('jq', ['-r', prog], {
        encoding: 'utf8',
        input: JSON.stringify({ statusCheckRollup: rollup }),
      }).trim();
    expect(runClassifier(pendingJq, [])).toBe('0');
    expect(
      runClassifier(pendingJq, [
        { status: 'QUEUED' },
        { status: 'IN_PROGRESS' },
        { status: 'COMPLETED' },
      ]),
    ).toBe('2');
    expect(
      runClassifier(failedJq, [
        { conclusion: 'FAILURE', name: 'Test (x)', detailsUrl: 'u1' },
      ]),
    ).toBe('u1');
    expect(
      runClassifier(failedJq, [
        { conclusion: 'SUCCESS', name: 'Test (x)', detailsUrl: 'u1' },
      ]),
    ).toBe('');
    expect(
      runClassifier(failedJq, [
        { conclusion: 'FAILURE', name: 'Lint', detailsUrl: 'u1' },
      ]),
    ).toBe('');
  });

  it('closes a proven no-op in two steps, on the conflict lever’s rails', () => {
    // The lever exists, is capped, timed, and documented in the header list.
    expect(workflow).toContain("MAX_NOOP_CLOSES_PER_TICK: '3'");
    expect(workflow).toContain("NOOP_NOTICE_GRACE_SEC: '600'");
    expect(workflow).toContain("NOOP_NOTICE_MAX_AGE_SEC: '86400'");
    expect(workflow).toContain('• no-op merge      → close it.');
    // The probe reads GitHub's OWN test merge (one GraphQL call, no
    // checkout) and compares its tree with its BASE parent's tree —
    // parents.nodes[0] is the base side of a test merge, and its oid names
    // the main the verdict is against. nodes[1] is the HEAD side: it must
    // equal the fleet snapshot's head, or the test merge was built from an
    // older head and its equal tree would be a verdict for a head the notice
    // does not name (R2-1 — structural, not an observation about GitHub's
    // rebuild timing). The same read says whether the PR was
    // ever closed, which is what the at-most-once guard stands on.
    expect(workflow).toContain('potentialMergeCommit {');
    // …and the head the verdict is FOR: both the live headRefOid AND the
    // head-side parent of the test merge it was built from.
    expect(workflow).toMatch(
      /pullRequest\(number: \$pr\) \{\n\s+headRefOid\n\s+potentialMergeCommit \{/,
    );
    expect(workflow).toContain('elif $p.headRefOid != $head then "head-moved"');
    expect(workflow).toContain(
      'elif ($p.potentialMergeCommit.parents.nodes[1].oid // "") != $head then "head-moved"',
    );
    expect(workflow).toContain(
      'parents(first: 2) { nodes { oid tree { oid } } }',
    );
    // filteredCount, NOT totalCount: totalCount ignores itemTypes and counts
    // the whole timeline, which would read every PR as "closed before" and
    // switch the lever off for the entire fleet.
    expect(workflow).toMatch(
      /timelineItems\(itemTypes: \[CLOSED_EVENT\], last: 1\) \{\n\s+filteredCount\n\s+\}/,
    );
    expect(workflow).toContain(
      '($p.timelineItems.filteredCount | type) != "number"',
    );
    expect(workflow).toContain(
      '-f owner="${REPO%/*}" -f name="${REPO#*/}" -F pr="${pr}"',
    );
    // gh's stderr is KEPT (R1-2): it is the only thing that tells a lost PAT
    // scope or a rate limit from the benign wait for a test merge.
    expect(workflow).toContain('}\' 2> /tmp/noop-err)"; then');
    // Lever ordering: only on a MERGEABLE snapshot (CONFLICTING has no test
    // merge; UNKNOWN is still computing) of an autofix/* branch (the bot
    // account also carries PRs a person or another agent is driving, and
    // nothing here can see that work), after the conflict lever and BEFORE the
    // stale-base sync, and it does not gate on PENDING — the close is what
    // cancels a review run spent on an empty diff. The snapshot's
    // needs-human flag rides along as the third argument.
    expect(workflow).toMatch(
      /if \[\[ "\$\{MERGEABLE\}" == "CONFLICTING" \]\]; then[\s\S]*?elif \[\[ "\$\{MERGEABLE\}" == "MERGEABLE" && "\$\{BRANCH\}" == autofix\/\* \]\] && noop_merge "\$\{PR\}" "\$\{HEAD\}"; then\n\s+STATUS_NOTE='no-op vs main'\n\s+noop_close_lever "\$\{PR\}" "\$\{HEAD\}" "\$\{NH_PREFIX:\+parked\}"\n\n\s+# 3\) stale base[\s\S]{0,400}elif \[\[ "\$\{MERGEABLE\}" == "MERGEABLE" && "\$\{BEHIND\}" -ge/,
    );
    // Markers: bot-authored, keyed by head SHA.
    expect(workflow).toContain('<!-- fleet-shepherd noop-notice sha=%s -->');
    expect(workflow).toContain('<!-- fleet-shepherd noop-close sha=%s -->');
    expect(workflow).toContain(
      '--arg m "<!-- fleet-shepherd noop-notice sha=${head} -->"',
    );
    // The comment history is paginated and its pages MERGED (R1-4): GitHub
    // returns comments oldest-first, so a page-1-only read (or `.[0] // []`)
    // never sees the bot's own notice on a long thread and would re-post it
    // every tick, forever, without ever closing.
    expect(workflow).toMatch(
      /issues\/\$\{pr\}\/comments" --paginate 2> \/dev\/null \| jq -s 'add \/\/ \[\]' > \/tmp\/noop-ic\.json/,
    );
    // Rails, in order: parked snapshot; reopened (anything but an explicit
    // "false" from the probe hands off) — both with no further read; then
    // the history and the notice's age window; the close budget BEFORE any
    // live read; and before BOTH writes, in this order, the live-runs busy
    // rail, the live label recheck and the live needs-human recheck; the
    // live head right before the close.
    expect(workflow).toMatch(
      /if \[\[ -n "\$\{parked\}" \]\]; then[\s\S]{0,200}if \[\[ "\$\{NOOP_REOPENED\}" != 'false' \]\]; then[\s\S]{0,600}issues\/\$\{pr\}\/comments" --paginate/,
    );
    // …and the notice rides live_skip's ONE read for a live state+head
    // guard (R2-4): a PR closed or pushed since the fleet snapshot gets no
    // notice. The guard sits AFTER live_parked, so an unparsable payload
    // keeps its truthful note, and BEFORE the write.
    expect(workflow).toMatch(
      /if noop_must_wait "\$\{pr\}"; then\n\s+:\n\s+elif live_skip "\$\{pr\}"; then\n\s+ACTION_NOTE="\$\(skip_note 'no-op notice'\)"\n\s+elif live_parked; then\n\s+ACTION_NOTE="\$\{LIVE_PARKED_NOTE\}"\n\s+elif \[\[ "\$\(jq -r '\.state \/\/ ""' <<< "\$\{LIVE_LABELS_JSON\}"\)" != "OPEN" \|\| "\$\(jq -r '\.headRefOid \/\/ ""' <<< "\$\{LIVE_LABELS_JSON\}"\)" != "\$\{head\}" \]\]; then\n(?:\s+#[^\n]*\n)*\s+ACTION_NOTE='PR no longer open at this head — no notice'\n\s+elif act "#\$\{pr\}: post no-op notice"/,
    );
    expect(workflow).toMatch(
      /CLOSES\}" -ge "\$\{MAX_NOOP_CLOSES_PER_TICK\}" \]\]; then\n\s+ACTION_NOTE='close budget reached this tick'\n\s+elif noop_must_wait "\$\{pr\}"; then\n\s+:\n\s+elif live_skip "\$\{pr\}"; then[\s\S]{0,120}elif live_parked; then\n\s+ACTION_NOTE="\$\{LIVE_PARKED_NOTE\}"\n\s+elif ! live="\$\(gh api "repos\/\$\{REPO\}\/pulls\/\$\{pr\}"/,
    );
    // The busy rail is the lever's OWN read of the runs that are live — never
    // the shared SHEP_BUSY, whose newest-50 window a long address run
    // scrolls out of while it is still working. Every not-yet-final run
    // status is listed, with the workflow token, and the answer starts as
    // 'unknown' so any early return fails closed.
    expect(workflow).toContain(
      'for st in in_progress queued pending waiting requested waiting pending queued in_progress; do',
    );
    // …through the Runs API, not `gh run list --status` (R2-2): gh's
    // client-side status allow-list rejects 'pending' before 2.65.0, and the
    // API filter is server-side on every gh version. The REST envelope's run
    // id field is `id`, NOT the gh CLI's `databaseId`.
    expect(workflow).toMatch(
      /env GITHUB_TOKEN="\$\{ACTIONS_TOKEN\}" gh api \\\n\s+"repos\/\$\{REPO\}\/actions\/workflows\/qwen-autofix\.yml\/runs\?status=\$\{st\}&per_page=100" \\\n\s+--jq '\.workflow_runs\[\]\.id' 2>> \/tmp\/noop-live-err/,
    );
    expect(workflow).toMatch(
      /address_runs_live\(\) \{[\s\S]{0,200}NOOP_LIVE_PRS='unknown'\n(?:\s+#[^\n]*\n)*\s+for st in/,
    );
    // Every status is listed before any jobs are read, out and back (a run
    // that changes status once mid-sweep is caught by one of the two
    // passes), the ids are de-duplicated, and a FULL page is unknown — the
    // cut drops the oldest runs, the long address jobs.
    expect(workflow).toMatch(
      /for st in in_progress queued [^\n]* queued in_progress; do[\s\S]*?-ge 100 \]\]; then\n\s+return 0\n[\s\S]*?\n {12}done\n {12}ids="\$\(sort -u <<< "\$\{ids\}"\)" \|\| return 0\n {12}while IFS= read -r id; do[\s\S]*?gh run view "\$\{id\}"/,
    );
    // A rail that cannot be read is annotated once per tick, like the probe
    // — and names gh's first stderr line, so a dead rail never reads as the
    // benign full-page case (R2-3). Both rail reads keep stderr in that file.
    expect(workflow.match(/2>> \/tmp\/noop-live-err/g)).toHaveLength(2);
    expect(workflow).toMatch(
      /if \[\[ "\$\{NOOP_LIVE_PRS\}" == 'unknown' \]\]; then\n\s+RAIL_ERR="\$\(grep -m 1 '\[\^\[:space:\]\]' \/tmp\/noop-live-err 2> \/dev\/null \| tr -d '\\r' \|\| true\)"\n\s+RAIL_ERR="\$\{RAIL_ERR:0:200\}"\n\s+echo "::warning::live autofix runs could not be read this tick \(a failed or full run listing, a failed jobs read, or a failed de-duplication step\)\$\{RAIL_ERR:\+ — last error: \$\{RAIL_ERR\}\}/,
    );
    const leverFn = workflow.match(
      /noop_close_lever\(\) \{[\s\S]*?\n {10}\}/,
    )?.[0];
    expect(leverFn).toBeTruthy();
    expect(leverFn).not.toContain('SHEP_BUSY');
    expect(leverFn).not.toContain('BUSY_OK');
    // live_parked demands a payload that really carries a labels list.
    expect(workflow).toContain(
      'if (.labels | type) == "array" then ([.labels[].name] | index($l) != null) else "unparsable" end',
    );
    // The live head rides REST — the sole `gh pr view` stays live_skip's.
    expect(workflow).toContain(
      'gh api "repos/${REPO}/pulls/${pr}" --jq \'"\\(.state) \\(.head.sha)"\'',
    );
    // Close FIRST, comment second (R1-1): a bundled `gh pr close --comment`
    // posts before closing, so a failed close would leave a false "Closed
    // as a no-op" comment behind, once per tick.
    expect(workflow).not.toContain(
      'gh pr close "${pr}" --repo "${REPO}" --comment',
    );
    expect(workflow).toMatch(
      /elif act "#\$\{pr\}: close as no-op" gh pr close "\$\{pr\}" --repo "\$\{REPO\}"; then\n\s+CLOSES=\$\(\( CLOSES \+ 1 \)\)\n\s+if act "#\$\{pr\}: post no-op close comment"/,
    );
    // Counters move only on a write that HAPPENED (act's real rc).
    expect(workflow).toMatch(
      /elif act "#\$\{pr\}: post no-op notice"[\s\S]*?; then\n\s+NOTICES=\$\(\( NOTICES \+ 1 \)\)/,
    );
    expect(workflow).toContain('NOTICES=0');
    expect(workflow).toContain('CLOSES=0');
    expect(workflow).toContain('PROBE_FAILS=0');
    expect(workflow).toContain("PROBE_FAIL_FIRST=''");
    // The probe state is reset PER PR, inside the walk — hoisted to the tick
    // prologue, one PR's failed probe would be reported on every later row,
    // including PRs that were never probed.
    expect(workflow).toMatch(
      /while IFS= read -r ROW; do[\s\S]*?STATUS_NOTE='idle'\n\s+ACTION_NOTE='—'\n\s+NOOP_STATE=''\n/,
    );
    // A probe that gave no answer is reported as deferral — never "has a
    // diff" — and the row says WHICH: the benign wait and a dead probe must
    // not read alike. Failures are also counted and warned ONCE per tick,
    // only when there are any, naming the first cause.
    expect(workflow).toMatch(
      /case "\$\{NOOP_STATE\}" in\n\s+no-test-merge\) PROBE_NOTE='no test merge yet — no-op probe deferred this tick' ;;\n\s+head-moved\) PROBE_NOTE='head moved since the fleet snapshot — no-op probe deferred this tick' ;;\n\s+api-failure \| unparsable\) PROBE_NOTE="no-op probe FAILED \(\$\{NOOP_STATE\}\) — close lever deferred this tick" ;;\n\s+esac/,
    );
    expect(workflow).toMatch(
      /ACTION_NOTE="\$\{ACTION_NOTE\} · \$\{PROBE_NOTE\}"\n\s+fi\n\s+fi\n\n\s+echo "🐑 #\$\{PR\} \[\$\{STATUS_NOTE\}\]/,
    );
    expect(workflow).toMatch(
      /if \[\[ "\$\{PROBE_FAILS\}" -gt 0 \]\]; then\n\s+echo "::warning::no-op probe failed for \$\{PROBE_FAILS\} PR\(s\) this tick \(first: \$\{PROBE_FAIL_FIRST\}\)/,
    );
  });

  it('behaviorally proves noop_merge() answers no-op ONLY for an equal-tree test merge, and names every other cause', () => {
    const fn = workflow.match(/noop_merge\(\) \{[\s\S]*?\n {10}\}/)?.[0];
    const failed = workflow.match(
      /noop_probe_failed\(\) \{[\s\S]*?\n {10}\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(failed).toBeTruthy();
    const HEAD_OID = 'a'.repeat(40);
    const probe = ({ body, rc = 0, stderr = '', script }) => {
      const dir = mkdtempSync(join(tmpdir(), 'noop-merge-'));
      try {
        writeFileSync(
          join(dir, 'gh'),
          [
            '#!/bin/bash',
            // One log line per call: fold the newlines that a multi-line
            // GraphQL query would otherwise spread over several lines.
            'printf \'%s\\n\' "${*//$\'\\n\'/ }" >> "$GH_LOG"',
            'printf \'%s\' "$PMC_BODY"',
            '[[ -n "$PMC_ERR" ]] && printf \'%b\\n\' "$PMC_ERR" >&2',
            `exit ${rc}`,
          ].join('\n'),
        );
        chmodSync(join(dir, 'gh'), 0o755);
        // Production's shared /tmp/noop-err is rewritten into THIS case's
        // temp dir (R10-2).
        const fns = [failed, fn]
          .map((f) => f.replace(/\n {10}/g, '\n'))
          .join('\n')
          .replaceAll('/tmp/noop-err', join(dir, 'noop-err'));
        expect(fns).not.toContain('/tmp/noop-err');
        const out = execFileSync(
          'bash',
          [
            '-c',
            `set -eo pipefail\n${fns}\nPROBE_FAILS=0\nPROBE_FAIL_FIRST=''\n${script ?? `if noop_merge 7 ${HEAD_OID}; then echo RC=0; else echo RC=$?; fi`}\necho "STATE=$NOOP_STATE"\necho "BASE=$NOOP_BASE"\necho "REOPENED=$NOOP_REOPENED"\necho "FAILS=$PROBE_FAILS"\necho "FIRST=$PROBE_FAIL_FIRST"\necho FIRST_END`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              REPO: 'QwenLM/qwen-code',
              GH_LOG: join(dir, 'gh.log'),
              PMC_ERR: stderr,
              PMC_BODY: typeof body === 'string' ? body : JSON.stringify(body),
            },
            encoding: 'utf8',
          },
        );
        return {
          rc: out.match(/^RC=(\d+)$/m)?.[1],
          state: out.match(/^STATE=(.*)$/m)?.[1],
          base: out.match(/^BASE=(.*)$/m)?.[1],
          reopened: out.match(/^REOPENED=(.*)$/m)?.[1],
          fails: out.match(/^FAILS=(.*)$/m)?.[1],
          // Everything up to the end marker — not `.*`: a JS dot stops at a
          // CR (hiding exactly what the CR case is about) and at a newline
          // (hiding a second stderr line, which would start a fresh log line
          // inside the ::warning:: and could be parsed as a workflow command).
          first: out.match(/^FIRST=([\s\S]*?)\nFIRST_END$/m)?.[1],
          log: readFileSync(join(dir, 'gh.log'), 'utf8'),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const BASE_OID = 'b'.repeat(40);
    const pr = (
      potentialMergeCommit,
      timelineItems = { filteredCount: 0 },
      headRefOid = HEAD_OID,
    ) => ({
      data: {
        repository: {
          pullRequest: { headRefOid, potentialMergeCommit, timelineItems },
        },
      },
    });
    // nodes[0] is the BASE side of a test merge, nodes[1] the HEAD side —
    // the binding the R2-1 check stands on.
    const merge = (mtree, btree) => ({
      tree: { oid: mtree },
      parents: {
        nodes: [{ oid: BASE_OID, tree: { oid: btree } }, { oid: HEAD_OID }],
      },
    });
    const equal = probe({ body: pr(merge('t1', 't1')) });
    expect(equal).toMatchObject({
      rc: '0',
      state: 'noop',
      fails: '0',
      // The verdict names the main it is against, and says whether the PR
      // was ever closed.
      base: 'bbbbbbbbb',
      reopened: 'false',
    });
    // ONE GraphQL read with a numeric PR variable, asking for the test
    // merge's tree, its base parent's oid and tree, its head-side parent's
    // oid (the verdict's binding to the noticed head), and the close-event
    // count.
    expect(equal.log.trim().split('\n')).toHaveLength(1);
    expect(equal.log).toMatch(
      /^api graphql .*-F pr=7 .*potentialMergeCommit[\s\S]*parents\(first: 2\)[\s\S]*CLOSED_EVENT/,
    );
    expect(probe({ body: pr(merge('t1', 't2')) })).toMatchObject({
      rc: '1',
      state: 'changes',
      fails: '0',
    });
    // Closed before — by anyone, any number of times: an OPEN PR with a
    // close event was reopened.
    for (const filteredCount of [1, 3]) {
      expect(
        probe({ body: pr(merge('t1', 't1'), { filteredCount }) }),
      ).toMatchObject({ rc: '0', state: 'noop', fails: '0', reopened: 'true' });
    }
    // A verdict for ANOTHER head is not a verdict: the PR was pushed to
    // between the fleet snapshot and this read. Benign — the next tick sees
    // the new head — even when the test merge GitHub returned is equal-tree.
    expect(
      probe({ body: pr(merge('t1', 't1'), undefined, 'c'.repeat(40)) }),
    ).toMatchObject({ rc: '1', state: 'head-moved', fails: '0', first: '' });
    // …and in its usual shape right after a push: the head has moved AND the
    // test merge is not built yet. The head is what the row should name.
    expect(probe({ body: pr(null, undefined, 'c'.repeat(40)) })).toMatchObject({
      rc: '1',
      state: 'head-moved',
      fails: '0',
    });
    // The binding is STRUCTURAL (R2-1): a test merge whose HEAD-side parent
    // is not the snapshot head was built from an older head — defer, even
    // when its tree answers equal. Removing the jq elif turns this red.
    expect(
      probe({
        body: pr({
          tree: { oid: 't1' },
          parents: {
            nodes: [
              { oid: BASE_OID, tree: { oid: 't1' } },
              { oid: 'c'.repeat(40) },
            ],
          },
        }),
      }),
    ).toMatchObject({ rc: '1', state: 'head-moved', fails: '0', first: '' });
    // …and a MISSING head-side parent fails closed the same way — a
    // deferral, never a verdict.
    expect(
      probe({
        body: pr({
          tree: { oid: 't1' },
          parents: { nodes: [{ oid: BASE_OID, tree: { oid: 't1' } }] },
        }),
      }),
    ).toMatchObject({ rc: '1', state: 'head-moved', fails: '0' });
    // The BENIGN non-answer — GitHub has not built the test merge yet —
    // defers without counting as a failure.
    expect(probe({ body: pr(null) })).toMatchObject({
      rc: '1',
      state: 'no-test-merge',
      fails: '0',
      first: '',
    });
    // Every GENUINE failure defers too (never "no-op", never "changes"), but
    // is counted and names its cause — an API failure with gh's own first
    // non-blank stderr line, even when the body it printed looks equal-tree.
    expect(
      probe({
        body: pr(merge('t1', 't1')),
        rc: 1,
        stderr:
          '\\n  \\ngh: Resource not accessible by personal access token (HTTP 403)\\nsecond line',
      }),
    ).toMatchObject({
      rc: '1',
      state: 'api-failure',
      fails: '1',
      first:
        '#7 api-failure: gh: Resource not accessible by personal access token (HTTP 403)',
    });
    expect(probe({ body: pr(merge('t1', 't1')), rc: 1 })).toMatchObject({
      rc: '1',
      state: 'api-failure',
      fails: '1',
      first: '#7 api-failure: gh exited non-zero with no message',
    });
    // gh's line is capped at 200 characters and carries no CR.
    const long = probe({
      body: pr(merge('t1', 't1')),
      rc: 1,
      stderr: `${'x'.repeat(300)}\\r`,
    });
    expect(long.first).toBe(`#7 api-failure: ${'x'.repeat(200)}`);
    // …and a CRLF-terminated line loses its CR (a short line, so the cap
    // cannot be what removed it).
    expect(
      probe({ body: pr(merge('t1', 't1')), rc: 1, stderr: 'gh: boom\\r' })
        .first,
    ).toBe('#7 api-failure: gh: boom');
    const noTimeline = pr(merge('t1', 't1'));
    delete noTimeline.data.repository.pullRequest.timelineItems;
    for (const body of [
      pr({ tree: { oid: 't1' }, parents: { nodes: [{}, { oid: HEAD_OID }] } }),
      pr({
        tree: null,
        parents: {
          nodes: [{ oid: BASE_OID, tree: { oid: 't1' } }, { oid: HEAD_OID }],
        },
      }),
      pr({
        tree: { oid: 't1' },
        parents: { nodes: [{ tree: { oid: 't1' } }, { oid: HEAD_OID }] },
      }),
      // An equal-tree answer WITHOUT a usable close-event count is not an
      // answer: the at-most-once guard would have nothing to stand on.
      noTimeline,
      pr(merge('t1', 't1'), {}),
      pr(merge('t1', 't1'), { filteredCount: null }),
      pr(merge('t1', 't1'), { filteredCount: '1' }),
      pr(merge('t1', 't1'), { totalCount: 5 }),
      // …and so is one that does not say which head it is about.
      pr(merge('t1', 't1'), undefined, null),
      { data: { repository: null } },
      [],
      'not json',
    ]) {
      expect(probe({ body })).toMatchObject({
        rc: '1',
        state: 'unparsable',
        fails: '1',
        first:
          '#7 unparsable: the response carries no pullRequest node, head or close-event count, or its test merge has no tree or no base parent',
      });
    }
    // The per-tick summary names the FIRST cause and counts them all.
    expect(
      probe({
        body: 'not json',
        script:
          'noop_merge 7 x || true\nNOOP_STATE=api-failure\nnoop_probe_failed 9 later\necho RC=1',
      }),
    ).toMatchObject({
      fails: '2',
      first:
        '#7 unparsable: the response carries no pullRequest node, head or close-event count, or its test merge has no tree or no base parent',
    });
  });

  // The lever replay shared by the cases below: the functions are
  // extracted VERBATIM and run under production's strict mode with a fake
  // `gh` whose call log is what the assertions read.
  const leverHarness = () => {
    const grab = (name) =>
      workflow.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n {10}\\}`))?.[0];
    const parts = [
      'act',
      'live_skip',
      'skip_note',
      'live_parked',
      'address_runs_live',
      'noop_must_wait',
      'noop_close_lever',
    ].map(grab);
    for (const p of parts) expect(p).toBeTruthy();
    const railWarning = workflow.match(
      / {10}if \[\[ "\$\{NOOP_LIVE_PRS\}" == 'unknown' \]\]; then\n {12}RAIL_ERR=[\s\S]*?\n {10}fi/,
    )?.[0];
    expect(railWarning).toBeTruthy();
    const HEAD = 'a'.repeat(40);
    const NOTICE = `<!-- fleet-shepherd noop-notice sha=${HEAD} -->`;
    const CLOSED = `<!-- fleet-shepherd noop-close sha=${HEAD} -->`;
    const NOW = Date.parse('2026-09-21T12:00:00Z') / 1000;
    const ago = (sec) =>
      new Date((NOW - sec) * 1000).toISOString().replace('.000Z', 'Z');
    const bot = (body, created_at = ago(1200)) => ({
      user: { login: 'qwen-code-dev-bot' },
      created_at,
      body,
    });
    const human = (body, created_at = ago(1200)) => ({
      user: { login: 'wenshao' },
      created_at,
      body,
    });
    const run = ({
      comments = [],
      pages,
      commentsFail = false,
      live = `open ${HEAD}`,
      liveFail = false,
      labels = [],
      labelsBody,
      labelsFail = false,
      parked = '',
      reopened = 'false',
      graceSec = '600',
      // Live autofix runs by status: { in_progress: [{ id, jobs }], … }.
      liveRuns = {},
      // Runs that a status listing returns only from its SECOND call on.
      liveRunsSecondPass = {},
      runsFail = '',
      jobsFail = false,
      sortFail = false,
      // Extra bash run right after the lever, in the same tick.
      after = '',
      closes = '0',
      dryRun = 'false',
      closeRc = 0,
      commentRc = 0,
    }) => {
      const dir = mkdtempSync(join(tmpdir(), 'noop-lever-'));
      try {
        // `gh api --paginate` prints one JSON array per page, back to back.
        writeFileSync(
          join(dir, 'comments.json'),
          pages
            ? pages.map((p) => JSON.stringify(p)).join('')
            : JSON.stringify(comments),
        );
        writeFileSync(
          join(dir, 'labels.json'),
          // state/headRefOid ride the same live_skip read (R2-4): the
          // notice branch refuses a PR no longer open at the head.
          labelsBody ??
            JSON.stringify({ labels, state: 'OPEN', headRefOid: HEAD }),
        );
        for (const [name, runs] of [
          ...Object.entries(liveRuns),
          ...Object.entries(liveRunsSecondPass).map(([st, rs]) => [
            `${st}.2`,
            [...(liveRuns[st] ?? []), ...rs],
          ]),
        ]) {
          // What the Runs API read `--jq '.workflow_runs[].id'` prints: one
          // id a line.
          writeFileSync(
            join(dir, `runs-${name}`),
            runs.map((r) => `${r.id}\n`).join(''),
          );
          for (const r of runs) {
            writeFileSync(
              join(dir, `jobs-${r.id}.json`),
              typeof r.jobs === 'string'
                ? r.jobs
                : JSON.stringify({ jobs: r.jobs }),
            );
          }
        }
        writeFileSync(
          join(dir, 'gh'),
          [
            '#!/bin/bash',
            // One log line per call: fold the newlines of a bilingual body.
            'printf \'%s\\n\' "${*//$\'\\n\'/ }" >> "$GH_LOG"',
            'case "$1 $2" in',
            '  "pr view") [[ "$LABELS_FAIL" == true ]] && exit 1; cat "$FIX/labels.json" ;;',
            // The two WRITES go out under the bot PAT — the marker dedup
            // stands on the notice's author being the bot (R2-11). A
            // "harmonise the credential" edit routing a write through the
            // workflow token must fail HERE, not silently 403 in production.
            '  "pr comment") [[ "$GITHUB_TOKEN" == bot-pat ]] || exit 1; exit "$COMMENT_RC" ;;',
            '  "pr close") [[ "$GITHUB_TOKEN" == bot-pat ]] || exit 1; exit "$CLOSE_RC" ;;',
            // The sweep rides the Runs API (R2-2): $2 carries
            // ?status=<st>&per_page=100. Emulate the server's documented
            // status enum — a value outside it fails the replay the way the
            // API's 422 fails production, never "no live runs".
            '  "api repos/QwenLM/qwen-code/actions/workflows/qwen-autofix.yml/runs?status="*) [[ "$GITHUB_TOKEN" == workflow-token ]] || exit 1; st="${2#*status=}"; st="${st%%&*}"; [[ " in_progress queued pending waiting requested completed action_required cancelled failure neutral skipped stale startup_failure success timed_out " == *" $st "* ]] || { echo "gh: invalid status $st" >&2; exit 1; }; [[ "$RUNS_FAIL" == "$st" ]] && { echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; }; n=$(( $(cat "$FIX/calls-$st" 2> /dev/null || echo 0) + 1 )); echo "$n" > "$FIX/calls-$st"; f="$FIX/runs-$st"; [[ "$n" -ge 2 && -f "$f.2" ]] && f="$f.2"; [[ -f "$f" ]] && cat "$f"; exit 0 ;;',
            // Failure arms carry a stderr line, like gh: the rail keeps it
            // and the tick warning names its first line (R2-3).
            '  "run view") [[ "$GITHUB_TOKEN" == workflow-token ]] || exit 1; [[ "$JOBS_FAIL" == true ]] && { echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; }; cat "$FIX/jobs-$3.json" ;;',
            '  "api repos/QwenLM/qwen-code/issues/7/comments") [[ "$COMMENTS_FAIL" == true ]] && exit 1; cat "$FIX/comments.json" ;;',
            '  "api repos/QwenLM/qwen-code/pulls/7") [[ "$LIVE_FAIL" == true ]] && exit 1; printf \'%s\\n\' "$LIVE_OUT" ;;',
            '  *) echo "unexpected gh $*" >&2; exit 99 ;;',
            'esac',
          ].join('\n'),
        );
        chmodSync(join(dir, 'gh'), 0o755);
        if (sortFail) {
          writeFileSync(join(dir, 'sort'), '#!/bin/bash\nexit 2\n');
          chmodSync(join(dir, 'sort'), 0o755);
        }
        // Production's shared /tmp/noop-ic.json is rewritten into THIS
        // case's temp dir (R10-2): concurrent suite runs on one machine
        // must not corrupt each other's comment fixtures.
        const fns = parts
          .map((f) => f.replace(/\n {10}/g, '\n'))
          .join('\n')
          .replaceAll('/tmp/noop-ic.json', join(dir, 'noop-ic.json'))
          .replaceAll('/tmp/noop-live-err', join(dir, 'noop-live-err'));
        expect(fns).not.toContain('/tmp/noop-ic.json');
        expect(fns).not.toContain('/tmp/noop-live-err');
        // The tick-level rail warning replays too (R2-3): a rail that failed
        // must name gh's first stderr line, so a dead rail never reads as
        // the benign full-page case.
        const railWarn = railWarning
          .trimStart()
          .replace(/\n {10}/g, '\n')
          .replaceAll('/tmp/noop-live-err', join(dir, 'noop-live-err'));
        const out = execFileSync(
          'bash',
          [
            '-c',
            `set -eo pipefail\n${gnuDateShim}\n${fns}\nNOOP_LIVE_PRS=''\nCLOSES=${closes}\nNOTICES=0\nNOOP_REOPENED='${reopened}'\nNOOP_BASE='abc123456'\nnoop_close_lever 7 ${HEAD} '${parked}'\n${after}\n${railWarn}\necho "NOTE=$ACTION_NOTE"\necho "NOTICES=$NOTICES CLOSES=$CLOSES"`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              REPO: 'QwenLM/qwen-code',
              AUTOFIX_BOT: 'qwen-code-dev-bot',
              SKIP_LABEL: 'autofix/skip',
              NEEDS_HUMAN_LABEL: 'autofix/needs-human',
              MAX_NOOP_CLOSES_PER_TICK: '3',
              NOOP_NOTICE_GRACE_SEC: graceSec,
              NOOP_NOTICE_MAX_AGE_SEC: '86400',
              NOW_EPOCH: String(NOW),
              ACTIONS_TOKEN: 'workflow-token',
              GITHUB_TOKEN: 'bot-pat',
              RUNS_FAIL: runsFail,
              JOBS_FAIL: String(jobsFail),
              DRY_RUN: dryRun,
              GH_LOG: join(dir, 'gh.log'),
              FIX: dir,
              LIVE_OUT: live,
              LIVE_FAIL: String(liveFail),
              COMMENTS_FAIL: String(commentsFail),
              LABELS_FAIL: String(labelsFail),
              CLOSE_RC: String(closeRc),
              COMMENT_RC: String(commentRc),
            },
            encoding: 'utf8',
          },
        );
        const log = existsSync(join(dir, 'gh.log'))
          ? readFileSync(join(dir, 'gh.log'), 'utf8').split('\n')
          : [];
        return {
          note: out.match(/^NOTE=(.*)$/m)?.[1],
          counters: out
            .match(/^NOTICES=(\d+) CLOSES=(\d+)$/m)
            ?.slice(1)
            .join('/'),
          writes: log.filter((l) => /^pr (comment|close) /.test(l)),
          calls: log.filter(Boolean).length,
          views: log.filter((l) => l.startsWith('pr view ')).length,
          out,
          warnings: [...out.matchAll(/^::warning::(.*)$/gm)].map((m) => m[1]),
          // The listings ride the Runs API (R2-2); the jobs reads stay
          // gh run view.
          runReads: log.filter(
            (l) =>
              /^run view /.test(l) ||
              l.startsWith('api repos/QwenLM/qwen-code/actions/workflows/'),
          ).length,
          runOrder: log
            .filter(
              (l) =>
                /^run view /.test(l) ||
                l.startsWith('api repos/QwenLM/qwen-code/actions/workflows/'),
            )
            .map((l) => (l.startsWith('run view ') ? 'view' : 'list'))
            .join(','),
          liveReads: log.filter((l) =>
            l.startsWith('api repos/QwenLM/qwen-code/pulls/7 '),
          ).length,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    return {
      run,
      bot,
      human,
      ago,
      HEAD,
      NOTICE,
      CLOSED,
      NOTICED:
        'no-op notice posted — closes on a later tick unless the head moves',
    };
  };

  it('behaviorally proves the no-op lever notices first, closes later as two ordered writes, and at most once', () => {
    const { run, bot, human, HEAD, NOTICE, CLOSED, NOTICED } = leverHarness();
    // Step 1: no notice on the PR → the bot posts one keyed by the head,
    // bilingual, naming the main the verdict is against and promising only
    // what the code guarantees (R1-3), and closes nothing (no live head read
    // is spent either).
    let r = run({});
    expect(r.note).toBe(NOTICED);
    expect(r.counters).toBe('1/0');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(
      /^pr comment 7 --repo QwenLM\/qwen-code --body 🫥 No-op detected/,
    );
    expect(r.writes[0]).toContain(NOTICE);
    expect(r.writes[0]).toContain('中文说明');
    expect(r.writes[0]).toContain(
      `test merge of head \`${HEAD}\` into \`main\` (as of \`abc123456\`, the \`main\` it was built against)`,
    );
    expect(r.writes[0]).toContain(
      `head \`${HEAD}\` 与 \`main\`（以 \`abc123456\` 为准`,
    );
    expect(r.writes[0]).toContain(
      'closes this PR on a later tick: no sooner than 10 minutes from now, usually within about 20.',
    );
    expect(r.writes[0]).toContain(
      'or the per-tick close cap postpones it, and the `autofix/needs-human` label parks it for a human. To keep it open, add the `autofix/skip` label — the fleet-wide opt-out: the PR leaves the dashboard and every shepherd lever until it is removed.',
    );
    expect(r.writes[0]).toContain(
      '带有 `autofix/needs-human` 标签则交由人工处理。如需保留，请添加 `autofix/skip` 标签（车队级退出开关：标签存续期间，本 PR 不出现在仪表盘上，也不经过任何 shepherd 杠杆）。',
    );
    expect(r.writes[0]).toContain(
      '会在之后的某个 tick 关闭本 PR：最早在 10 分钟之后，通常在约 20 分钟内。',
    );
    expect(r.writes[0]).not.toContain('on its next tick');
    expect(r.writes[0]).not.toContain('%s');
    expect(r.liveReads).toBe(0);
    // The floor in the text is RENDERED from the variable, in both languages.
    r = run({ graceSec: '1200' });
    expect(r.writes[0]).toContain('no sooner than 20 minutes from now');
    expect(r.writes[0]).toContain('最早在 20 分钟之后');
    // Step 2: the bot's notice for THIS head is old enough and the head is
    // still the live head of an open PR → close FIRST, then the marker
    // comment as a separate write.
    r = run({ comments: [bot(`… ${NOTICE}`)] });
    expect(r.note).toBe('closed as no-op');
    expect(r.counters).toBe('0/1');
    expect(r.writes).toHaveLength(2);
    expect(r.writes[0]).toBe('pr close 7 --repo QwenLM/qwen-code');
    expect(r.writes[1]).toMatch(
      /^pr comment 7 --repo QwenLM\/qwen-code --body 🫥 Closed as a no-op/,
    );
    expect(r.writes[1]).toContain(CLOSED);
    expect(r.writes[1]).toContain('中文说明');
    expect(r.writes[1]).toContain('into `main` (as of `abc123456`)');
    expect(r.writes[1]).toContain(
      `将 head \`${HEAD}\` 合入 \`main\`（以 \`abc123456\` 为准）`,
    );
    expect(r.writes[1]).toContain('closes a PR as a no-op only once');
    expect(r.writes[1]).toContain('只会按空壳关闭一次');
    expect(r.writes[1]).not.toContain('%s');
    expect(r.liveReads).toBe(1);
    // A failed close posts NO closing comment — it would be false text,
    // re-posted every tick.
    r = run({ comments: [bot(NOTICE)], closeRc: 1 });
    expect(r.note).toBe('no-op close FAILED — will retry next tick');
    expect(r.counters).toBe('0/0');
    expect(r.writes).toEqual(['pr close 7 --repo QwenLM/qwen-code']);
    // A lost closing comment after a real close still counts the close.
    r = run({ comments: [bot(NOTICE)], commentRc: 1 });
    expect(r.note).toBe(
      'closed as no-op — the closing comment FAILED to post (the close stands)',
    );
    expect(r.counters).toBe('0/1');
    // AT MOST ONCE per PR (R1-1): the probe read the PR's own close events;
    // a PR that was closed before — by this lever, by triage, by anyone — is
    // open again only because a human reopened it: hands off at any head,
    // spending no further read and no write. It does not depend on the
    // closing comment having been posted, and an UNKNOWN answer hands off
    // too (fail closed).
    for (const reopened of ['true', '']) {
      r = run({ comments: [bot(NOTICE)], reopened });
      expect(r.note).toBe('closed before and reopened — left to a human');
      expect(r.calls).toBe(0);
    }
    r = run({ reopened: 'true' });
    expect(r.calls).toBe(0);
    // Comments GitHub returns with a null body or a deleted author do not
    // break the history read.
    r = run({
      comments: [
        { user: null, created_at: '2026-09-01T00:00:00Z', body: null },
        {
          user: { login: 'qwen-code-dev-bot' },
          created_at: '2026-09-01T00:00:00Z',
          body: null,
        },
        bot(NOTICE),
      ],
    });
    expect(r.note).toBe('closed as no-op');
    // Only the BOT's own notice counts: a human pasting the marker cannot
    // pull the close forward.
    r = run({ comments: [human(NOTICE)] });
    expect(r.note).toBe(NOTICED);
    expect(r.writes[0]).toMatch(/^pr comment /);
    // A notice for ANOTHER head is stale: a fresh notice, never a close.
    r = run({
      comments: [
        bot(`… <!-- fleet-shepherd noop-notice sha=${'b'.repeat(40)} -->`),
      ],
    });
    expect(r.note).toBe(NOTICED);
    expect(r.writes[0]).toMatch(/^pr comment /);
    // The comment history is read across pages (R1-4): 100 older comments
    // fill page 1 and the bot's notice sits on page 2 — it must be seen.
    r = run({
      pages: [
        Array.from({ length: 100 }, (_, i) => human(`comment ${i}`)),
        [bot(NOTICE)],
      ],
    });
    expect(r.note).toBe('closed as no-op');
    // Dry-run performs no write on either step.
    r = run({ comments: [bot(NOTICE)], dryRun: 'true' });
    expect(r.writes).toHaveLength(0);
    r = run({ dryRun: 'true' });
    expect(r.writes).toHaveLength(0);
  });

  it('behaviorally proves the no-op close waits out a notice that is too new and re-posts one that is too old', () => {
    const { run, bot, ago, NOTICE, NOTICED } = leverHarness();
    // The reaction window is enforced on the notice's OWN timestamp (R1-5),
    // in both directions. Too new → defer, spending no live read.
    let r = run({ comments: [bot(NOTICE, ago(30))] });
    expect(r.note).toBe(
      'no-op notice is 30s old — closes once it is 600s old, unless the head moves',
    );
    expect(r.writes).toHaveLength(0);
    expect(r.calls).toBe(1);
    r = run({ comments: [bot(NOTICE, ago(599))] });
    expect(r.writes).toHaveLength(0);
    r = run({ comments: [bot(NOTICE, ago(600))] });
    expect(r.note).toBe('closed as no-op');
    // A notice from the future (clock skew) is "too new", never a close.
    r = run({ comments: [bot(NOTICE, ago(-3600))] });
    expect(r.writes).toHaveLength(0);
    // Too old → the warning is spent: a fresh notice, not a close…
    r = run({ comments: [bot(NOTICE, ago(30 * 86400))] });
    expect(r.note).toBe(NOTICED);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(/^pr comment /);
    r = run({ comments: [bot(NOTICE, ago(86400))] });
    expect(r.note).toBe('closed as no-op');
    r = run({ comments: [bot(NOTICE, ago(86401))] });
    expect(r.note).toBe(NOTICED);
    // …and the NEWEST notice for the head is the one that counts.
    r = run({ comments: [bot(NOTICE, ago(30 * 86400)), bot(NOTICE)] });
    expect(r.note).toBe('closed as no-op');
    r = run({ comments: [bot(NOTICE), bot(NOTICE, ago(30))] });
    expect(r.writes).toHaveLength(0);
    // A notice that exists but cannot be dated defers: never "old enough"
    // (a close), never "absent" (a duplicate notice every tick). The shim
    // keeps GNU's trap — `date -d ""` succeeds with an in-window epoch — so
    // the missing and empty shapes pass ONLY because the lever tests for
    // emptiness itself.
    for (const created_at of [undefined, '', 'garbage-date']) {
      r = run({
        comments: [
          { user: { login: 'qwen-code-dev-bot' }, created_at, body: NOTICE },
        ],
      });
      expect(r.note).toBe(
        'notice timestamp unreadable — fail closed, no close',
      );
      expect(r.writes).toHaveLength(0);
    }
  });

  it('behaviorally proves the no-op lever’s busy rail reads the autofix runs that ARE live, all of them, and fails closed', () => {
    const { run, bot, NOTICE } = leverHarness();
    let r;
    // A live review-address job for THIS PR defers BOTH writes — whatever
    // state its run is in (running, queued behind a runner, pending in a
    // concurrency group) — and the lever finds it by listing the runs that
    // ARE live, not by looking through a window of recent ones.
    const job = (name, status = 'in_progress') => ({ name, status });
    const BUSY = 'review-address in flight — deferring the no-op lever';
    for (const status of ['in_progress', 'queued', 'pending']) {
      for (const comments of [[bot(NOTICE)], []]) {
        r = run({
          comments,
          // Production is a matrix: one run holds several live address
          // jobs, more runs follow it, and other statuses hold other PRs.
          // THIS PR's job is read FIRST of all of them, so an accumulator
          // that keeps only the last job, or resets per run, cannot pass.
          liveRuns: {
            [status]: [
              { id: 900, jobs: [job('route', 'completed')] },
              {
                id: 901,
                jobs: [
                  reviewAddressJob(7, status),
                  reviewAddressJob(12117, status),
                  reviewAddressJob(11679, status),
                ],
              },
              {
                id: 906,
                jobs: [reviewAddressJob(11989)],
              },
            ],
            requested: [
              {
                id: 907,
                jobs: [reviewAddressJob(5, 'queued')],
              },
            ],
          },
        });
        expect(r.note).toBe(BUSY);
        expect(r.writes).toHaveLength(0);
        expect(r.views).toBe(0);
        // The sweep lists every status out and back (nine listings) before
        // the first jobs read, and reads each run once although the second
        // pass lists it again.
        expect(r.runOrder).toBe(`${'list,'.repeat(9)}view,view,view,view`);
      }
    }
    // …and when THIS PR's job is the LAST of its run's jobs, so stopping at a
    // run's first address job cannot pass either.
    r = run({
      comments: [bot(NOTICE)],
      liveRuns: {
        in_progress: [
          {
            id: 908,
            jobs: [
              reviewAddressJob(12117),
              reviewAddressJob(11679),
              reviewAddressJob(7),
            ],
          },
        ],
      },
    });
    expect(r.note).toBe(BUSY);
    expect(r.writes).toHaveLength(0);
    // A job for ANOTHER PR (token match, not substring: 17 is not 7), or a
    // job for this PR that already completed, does not defer.
    r = run({
      comments: [bot(NOTICE)],
      liveRuns: {
        in_progress: [
          {
            id: 902,
            jobs: [reviewAddressJob(17), reviewAddressJob(7, 'completed')],
          },
        ],
      },
    });
    expect(r.note).toBe('closed as no-op');
    // …and the rail's SUCCESSFUL answer is loud (R2-5): the tick log names
    // the PRs it defers for, like the sibling busy line — a deferral that
    // lasts days must not leave "which run holds it?" unanswerable.
    r = run({
      comments: [bot(NOTICE)],
      liveRuns: {
        in_progress: [
          { id: 911, jobs: [reviewAddressJob(7), reviewAddressJob(12)] },
        ],
      },
    });
    expect(r.note).toBe(BUSY);
    expect(r.out).toContain(
      '🫥 no-op rail: live review-address for PR(s): 7 12 ',
    );
    // A run that was nowhere on the way out — it changed status between two
    // listings — is caught on the way back.
    r = run({
      comments: [bot(NOTICE)],
      liveRunsSecondPass: {
        in_progress: [
          {
            id: 909,
            jobs: [reviewAddressJob(7)],
          },
        ],
      },
    });
    expect(r.note).toBe(BUSY);
    expect(r.writes).toHaveLength(0);
    // All five not-yet-final statuses are listed, every tick that reaches a
    // write — and ANY failed or unparsable read is unknown busy-state, which
    // defers (fail closed), never "nothing is running".
    r = run({ comments: [bot(NOTICE)] });
    expect(r.runReads).toBe(9);
    // …but only ONCE per tick: the next PR that needs the answer reuses it.
    r = run({ comments: [bot(NOTICE)], after: 'noop_must_wait 8 || true' });
    expect(r.note).toBe('closed as no-op');
    expect(r.runReads).toBe(9);
    const UNKNOWN =
      'live autofix runs unreadable — busy-state unknown, deferring the no-op lever';
    for (const broken of [
      // Even the de-duplication of the run ids: if it fails, the rail is
      // unknown, never "nothing is running".
      {
        sortFail: true,
        liveRuns: {
          in_progress: [
            {
              id: 910,
              jobs: [reviewAddressJob(7)],
            },
          ],
        },
      },
      { runsFail: 'in_progress' },
      { runsFail: 'requested' },
      {
        jobsFail: true,
        liveRuns: { queued: [{ id: 903, jobs: [] }] },
      },
      { liveRuns: { queued: [{ id: 904, jobs: '{}' }] } },
      { liveRuns: { queued: [{ id: 905, jobs: 'not json' }] } },
    ]) {
      for (const comments of [[bot(NOTICE)], []]) {
        r = run({ comments, ...broken });
        expect(r.note).toBe(UNKNOWN);
        expect(r.writes).toHaveLength(0);
        expect(r.views).toBe(0);
      }
    }
    // …and the tick-level warning names the rail's own stderr (R2-3): a
    // token that lost Actions scope must not read as the benign full-page
    // case.
    r = run({ comments: [bot(NOTICE)], runsFail: 'queued' });
    expect(r.note).toBe(UNKNOWN);
    expect(r.warnings.join('\n')).toContain(
      'live autofix runs could not be read this tick',
    );
    expect(r.warnings.join('\n')).toContain(
      'last error: gh: Resource not accessible by integration (HTTP 403)',
    );
  });

  it('behaviorally proves a full page of live runs is unknown busy-state, and one short of full is read through', () => {
    const { run, bot, NOTICE } = leverHarness();
    const UNKNOWN =
      'live autofix runs unreadable — busy-state unknown, deferring the no-op lever';
    let r;
    // A FULL page of one status may be a truncated one: unknown, with no
    // jobs read at all. One short of full is read through.
    const manyRuns = (n) =>
      Array.from({ length: n }, (_, i) => ({ id: 2000 + i, jobs: [] }));
    r = run({ comments: [bot(NOTICE)], liveRuns: { queued: manyRuns(100) } });
    expect(r.note).toBe(UNKNOWN);
    expect(r.runOrder).not.toContain('view');
    r = run({ comments: [bot(NOTICE)], liveRuns: { queued: manyRuns(99) } });
    expect(r.note).toBe('closed as no-op');
    expect(r.runReads).toBe(9 + 99);
  });

  it('behaviorally proves the no-op lever defers on every parked, unreadable, budgeted or moved state', () => {
    const { run, bot, HEAD, NOTICE, NOTICED } = leverHarness();
    // A PR parked for a human is neither noticed nor closed — not from the
    // snapshot (no read at all), and not from the LIVE labels on either
    // write path (a label applied after enumeration).
    let r = run({ comments: [bot(NOTICE)], parked: 'parked' });
    expect(r.note).toBe(
      'parked (autofix/needs-human) — a no-op, left to the human decision',
    );
    expect(r.calls).toBe(0);
    const PARKED_LIVE =
      'parked (autofix/needs-human, live) — a no-op, left to the human decision';
    r = run({
      comments: [bot(NOTICE)],
      labels: [{ name: 'autofix/needs-human' }],
    });
    expect(r.note).toBe(PARKED_LIVE);
    expect(r.writes).toHaveLength(0);
    expect(r.liveReads).toBe(0);
    r = run({ labels: [{ name: 'autofix/needs-human' }] });
    expect(r.note).toBe(PARKED_LIVE);
    expect(r.writes).toHaveLength(0);
    // The live parked check fails CLOSED, and says so truthfully: a label
    // payload that answered but cannot be parsed stops the write without
    // being worded as a maintainer's label.
    r = run({ comments: [bot(NOTICE)], labelsBody: 'not json' });
    expect(r.note).toBe('label payload unparsable — fail closed, no write');
    expect(r.writes).toHaveLength(0);
    r = run({ labelsBody: 'not json' });
    expect(r.note).toBe('label payload unparsable — fail closed, no write');
    expect(r.writes).toHaveLength(0);
    // …and so does a payload that parses but carries no labels LIST, which
    // live_skip alone would have read as "no skip label".
    for (const labelsBody of ['{}', '{"labels":null}', '[]']) {
      r = run({ comments: [bot(NOTICE)], labelsBody });
      expect(r.note).toBe('label payload unparsable — fail closed, no write');
      expect(r.writes).toHaveLength(0);
    }
    // The head moved since the notice → no close (that push would have
    // landed on a closed PR); the notice for the new head follows next tick.
    r = run({ comments: [bot(NOTICE)], live: `open ${'c'.repeat(40)}` });
    expect(r.note).toBe(
      'head moved since the notice (now ccccccccc) — re-evaluating next tick',
    );
    expect(r.writes).toHaveLength(0);
    // Closed by someone else meanwhile → nothing to close.
    r = run({ comments: [bot(NOTICE)], live: `closed ${HEAD}` });
    expect(r.note).toBe('PR no longer open (closed) — nothing to close');
    expect(r.writes).toHaveLength(0);
    // Every unreadable input defers in the fail-closed direction, with NO
    // write: the live head, and the comment history (pipefail carries the gh
    // failure through the jq merge).
    r = run({ comments: [bot(NOTICE)], liveFail: true });
    expect(r.note).toBe('live head unreadable — fail closed, no close');
    expect(r.writes).toHaveLength(0);
    // The NOTICE also guards on the live state and head riding live_skip's
    // one read (R2-4): a PR a human closed or pushed to since the fleet
    // snapshot must not get a comment promising a close that will never
    // come — and no second live read is spent.
    r = run({
      labelsBody: JSON.stringify({
        labels: [],
        state: 'CLOSED',
        headRefOid: HEAD,
      }),
    });
    expect(r.note).toBe('PR no longer open at this head — no notice');
    expect(r.writes).toHaveLength(0);
    expect(r.views).toBe(1);
    expect(r.liveReads).toBe(0);
    r = run({
      labelsBody: JSON.stringify({
        labels: [],
        state: 'OPEN',
        headRefOid: 'b'.repeat(40),
      }),
    });
    expect(r.note).toBe('PR no longer open at this head — no notice');
    expect(r.writes).toHaveLength(0);
    r = run({ comments: [bot(NOTICE)], commentsFail: true });
    expect(r.note).toBe('marker read failed — deferring the no-op lever');
    expect(r.writes).toHaveLength(0);
    expect(r.views).toBe(0);
    // A page that is not a comment array (the marks jq then fails) is the
    // same deferral — and, because the lever runs in the loop BODY under
    // errexit, the assignment must sit inside the condition or a garbled
    // page would abort the whole tick instead of deferring one PR.
    r = run({ comments: { message: 'boom' } });
    expect(r.note).toBe('marker read failed — deferring the no-op lever');
    expect(r.writes).toHaveLength(0);
    // The budget is checked BEFORE the live label read and the live head
    // read — an exhausted tick spends no more API calls…
    r = run({ comments: [bot(NOTICE)], closes: '3' });
    expect(r.note).toBe('close budget reached this tick');
    expect(r.views).toBe(0);
    expect(r.liveReads).toBe(0);
    expect(r.runReads).toBe(0);
    expect(r.writes).toHaveLength(0);
    // …and it caps CLOSES only (R1-6): notices are uncapped, so an exhausted
    // close budget still posts the first notice (and no close).
    r = run({ closes: '3' });
    expect(r.note).toBe(NOTICED);
    expect(r.counters).toBe('1/3');
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatch(/^pr comment /);
    // The live label recheck precedes BOTH writes, reason-aware, and an
    // unreadable label state fails closed.
    r = run({ comments: [bot(NOTICE)], labels: [{ name: 'autofix/skip' }] });
    expect(r.note).toBe(
      'autofix/skip present (live) — consent withdrawn, no no-op close',
    );
    expect(r.writes).toHaveLength(0);
    r = run({ labels: [{ name: 'autofix/skip' }] });
    expect(r.note).toBe(
      'autofix/skip present (live) — consent withdrawn, no no-op notice',
    );
    expect(r.writes).toHaveLength(0);
    r = run({ labelsFail: true });
    expect(r.note).toBe(
      'label state unreadable — fail closed, no no-op notice',
    );
    expect(r.writes).toHaveLength(0);
    r = run({ comments: [bot(NOTICE)], labelsFail: true });
    expect(r.note).toBe('label state unreadable — fail closed, no no-op close');
    expect(r.writes).toHaveLength(0);
    // A failed notice post never counts and is retried next tick.
    r = run({ commentRc: 1 });
    expect(r.note).toBe('no-op notice post FAILED — will retry next tick');
    expect(r.counters).toBe('0/0');
  });

  it('behaviorally proves the row says WHICH non-answer the probe gave, on an idle row and on a busy one', () => {
    const tail = workflow.match(
      /( {12}PROBE_NOTE=''\n[\s\S]*?\n {12}fi)\n\n {12}echo "🐑/,
    )?.[1];
    expect(tail).toBeTruthy();
    const note = (state, action) =>
      execFileSync(
        'bash',
        [
          '-c',
          `set -eo pipefail\nNOOP_STATE='${state}'\nACTION_NOTE='${action}'\n${tail}\nprintf '%s' "$ACTION_NOTE"`,
        ],
        { encoding: 'utf8' },
      );
    // An otherwise idle row (the placeholder dash) is REPLACED by the note…
    expect(note('no-test-merge', '—')).toBe(
      'no test merge yet — no-op probe deferred this tick',
    );
    expect(note('head-moved', '—')).toBe(
      'head moved since the fleet snapshot — no-op probe deferred this tick',
    );
    expect(note('api-failure', '—')).toBe(
      'no-op probe FAILED (api-failure) — close lever deferred this tick',
    );
    // …and a row another lever already wrote on gets it APPENDED.
    expect(note('unparsable', 'synced with main')).toBe(
      'synced with main · no-op probe FAILED (unparsable) — close lever deferred this tick',
    );
    // A probe that answered (or never ran) leaves the row alone.
    for (const state of ['', 'noop', 'changes']) {
      expect(note(state, '—')).toBe('—');
      expect(note(state, 'synced with main')).toBe('synced with main');
    }
  });
});
