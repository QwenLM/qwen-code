/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/qwen-fleet-shepherd.yml',
  'utf8',
);

describe('fleet shepherd workflow', () => {
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
    expect(workflow).not.toContain('gh pr view');
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
    // outage only changes the note (downstream dedup absorbs a retry).
    expect(workflow).toMatch(
      /DISPATCHES=\$\(\( DISPATCHES \+ 1 \)\)[\s\S]{0,400}if act "#\$\{PR\}: post conflict notice"/,
    );
    expect(workflow).toContain(
      'marker post failed — downstream dedup will absorb a retry',
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
    // A failed marker read must skip the PR, never act on empty history.
    expect(workflow).toContain('marker read failed; skipping this tick');
    // A failed fleet fetch skips the walk AND preserves the previous
    // dashboard body — never an empty-table overwrite.
    expect(workflow).toContain(
      'fleet enumeration failed; skipping this tick',
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
    // liveness dispatches (dashboard watermark) — a conflict dispatch is a
    // workflow_dispatch too and must NOT satisfy the watchdog.
    expect(workflow).toContain('[.[] | select(.event == "schedule")] | first');
    expect(workflow).toContain(
      '<!-- fleet-shepherd liveness-dispatched: ${LIVENESS_OUT} -->',
    );
    // A wide window so event storms can't push schedule runs out of view.
    expect(workflow).toContain('--limit 50 --json event,createdAt,status');
    // One run-list call feeds both the age and the in-flight computation.
    expect(
      workflow.match(
        /gh run list --repo "\$\{REPO\}" --workflow qwen-autofix\.yml/g,
      ) ?? [],
    ).toHaveLength(1);
  });

  it('maintains one dashboard issue edited in place', () => {
    expect(workflow).toContain("DASHBOARD_TITLE: 'Fleet Shepherd Dashboard'");
    // gh --jq takes a single expression (no --arg support).
    expect(workflow).not.toContain('--jq --arg');
    expect(workflow).toContain('--jq \'.[0].number // ""\'');
    expect(workflow).toContain('gh issue edit');
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('do not edit by hand');
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
