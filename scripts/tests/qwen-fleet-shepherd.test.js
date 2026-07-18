/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/qwen-fleet-shepherd.yml',
  'utf8',
);
const flakes = readFileSync('.github/known-flakes.txt', 'utf8');

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
    // PAT identity is verified before any write.
    expect(workflow).toContain(
      "::error::CI_DEV_BOT_PAT authenticates as '${bot_actor:-unknown}'",
    );
  });

  it('splits credentials by purpose', () => {
    // Dispatches and reruns ride the workflow token (actions: write)…
    expect(workflow).toContain("actions: 'write'");
    expect(workflow).toContain(
      'env GITHUB_TOKEN="${ACTIONS_TOKEN}" gh workflow run qwen-autofix.yml',
    );
    expect(workflow).toContain(
      'env GITHUB_TOKEN="${ACTIONS_TOKEN}" gh run rerun',
    );
    // …while comments, update-branch, and the dashboard use the bot PAT so
    // synced branches still trigger CI and writes carry the bot identity.
    expect(workflow).toContain("GITHUB_TOKEN: '${{ secrets.CI_DEV_BOT_PAT }}'");
    expect(workflow).toContain('pulls/${PR}/update-branch');
  });

  it('applies each lever idempotently with per-tick caps', () => {
    // Conflict dispatch: once per conflicted head SHA, marker-deduped.
    expect(workflow).toContain(
      '<!-- fleet-shepherd conflict-dispatch sha=%s -->',
    );
    expect(workflow).toContain('-f pr_number="${PR}"');
    // Stale-base sync: threshold-gated and self-limiting (behind_by resets),
    // and never while checks are in flight.
    expect(workflow).toContain("BEHIND_SYNC_THRESHOLD: '25'");
    expect(workflow).toContain(
      '"${BEHIND}" -ge "${BEHIND_SYNC_THRESHOLD}" && "${PENDING}" == "0"',
    );
    // Flake rerun: only fully-concluded runs, capped attempts, and EVERY
    // failing test must match the registry — one unknown failure aborts.
    expect(workflow).toContain("RERUN_MAX_ATTEMPTS: '2'");
    expect(workflow).toContain('<!-- fleet-shepherd rerun run=%s attempt=%s -->');
    expect(workflow).toContain('"${RUN_STATE}" != "completed"');
    expect(workflow).toContain('non-flake failure');
    // Per-tick blast-radius caps.
    expect(workflow).toContain("MAX_SYNCS_PER_TICK: '3'");
    expect(workflow).toContain("MAX_DISPATCHES_PER_TICK: '2'");
  });

  it('keeps the autofix scan alive when cron goes silent', () => {
    expect(workflow).toContain("SCAN_LIVENESS_MINUTES: '60'");
    expect(workflow).toContain('-f phase=review');
    // Never stacks a liveness scan on top of an in-flight one.
    expect(workflow).toContain('"${SCAN_INFLIGHT}" == "0"');
  });

  it('maintains one dashboard issue edited in place', () => {
    expect(workflow).toContain("DASHBOARD_TITLE: 'Fleet Shepherd Dashboard'");
    expect(workflow).toContain('gh issue edit');
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('do not edit by hand');
  });

  it('gates reruns across ALL failed jobs, with the ids from the jobs API', () => {
    // `gh run rerun --failed` reruns every failed job, so the gate must parse
    // failing tests from every failed job's logs — not just the flagging one —
    // and must not depend on parsing job ids out of a details URL at all.
    expect(workflow).toContain(
      '.jobs[] | select(.conclusion == "failure") | .databaseId',
    );
    expect(workflow).not.toContain("grep -oE '/job/[0-9]+'");
    expect(workflow).toContain('across ALL the run\'s failed jobs');
    expect(workflow).toContain(
      'no failing tests parsed from any failed job',
    );
  });

  it('behaviorally replays the log parser and the flake gate under bash', () => {
    // Extract the EXACT pipelines from the workflow so this test fails if
    // either drifts, then execute them on fixtures.
    const parse = workflow.match(
      /grep -oE 'FAIL\[\[:space:\]\]\+\[\^ \]\+\\\.test\\\.\[a-z\]\+' \| awk '\{print \$NF\}'/,
    )?.[0];
    expect(parse).toBeTruthy();
    const innerFilter = workflow.match(
      /grep -vE '\^\[\[:space:\]\]\*\(#\|\$\)' "\$\{FLAKE_FILE\}"/,
    )?.[0];
    expect(innerFilter).toBeTruthy();

    // Parser: vitest failure lines → failing test file paths.
    const log = [
      ' ❯ some progress noise',
      ' FAIL  src/utils/shell-ast-parser-lazy.test.ts > lazy runtime > loads',
      'FAIL  src/services/cronScheduler.test.ts > durable ownership',
      ' ✓ src/passing.test.ts (10 tests)',
    ].join('\n');
    const parsed = execFileSync('bash', ['-c', `${parse} | sort -u`], {
      input: log,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(parsed).toEqual([
      'src/services/cronScheduler.test.ts',
      'src/utils/shell-ast-parser-lazy.test.ts',
    ]);

    // Gate: every parsed test must match the committed registry; one unknown
    // blocks; an empty parse never green-lights.
    const gate = (fails) => {
      const f = join(tmpdir(), `shepherd-gate-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
      writeFileSync(f, fails.length ? fails.join('\n') + '\n' : '');
      const script = [
        `FLAKE_FILE='.github/known-flakes.txt';`,
        `if [[ ! -s '${f}' ]]; then echo SKIP;`,
        `elif grep -vE -f <(${innerFilter}) '${f}' > /dev/null; then echo BLOCK;`,
        `else echo RERUN; fi`,
      ].join(' ');
      return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    };
    expect(gate(['src/utils/shell-ast-parser-lazy.test.ts'])).toBe('RERUN');
    expect(
      gate([
        'src/services/cronScheduler.test.ts',
        'src/serve/workspace-registration-store.test.ts',
      ]),
    ).toBe('RERUN');
    expect(
      gate(['src/utils/shell-ast-parser-lazy.test.ts', 'src/gemini.test.tsx']),
    ).toBe('BLOCK');
    expect(gate(['packages/x/brand-new.test.ts'])).toBe('BLOCK');
    expect(gate([])).toBe('SKIP');
  });

  it('ships a non-empty flake registry of valid regexes', () => {
    const lines = flakes
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Every entry must compile as a regex and look like a test-file matcher,
      // so a stray broad pattern cannot green-light rerunning real failures.
      expect(() => new RegExp(line)).not.toThrow();
      expect(line).toMatch(/test\\?\.(ts|tsx|js|mjs)/);
    }
  });
});
