/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowText = readFileSync(
  '.github/workflows/qwen-triage-finalize.yml',
  'utf8',
);
const workflow = parse(workflowText);
const script = workflow.jobs.finalize.steps[0].run;

describe('qwen-triage-finalize workflow', () => {
  it('fires on every pull_request-triggered workflow, only for PR-caused runs', () => {
    // The deferred approval can only land on a firing that happens AFTER the
    // last PR CI run completes, so every workflow with a pull_request trigger
    // must be listed — and none without one (a dead entry just adds skipped
    // firings; E2E Tests has no pull_request trigger).
    expect(workflow.on.workflow_run.workflows).toEqual([
      'Qwen Code CI',
      'Qwen Autofix',
      'SDK Java',
      'SDK Python',
      'Serve A/B',
      'Web-shell Visuals',
    ]);
    expect(workflow.on.workflow_run.workflows).not.toContain('E2E Tests');
    expect(workflow.on.workflow_run.types).toEqual(['completed']);
    expect(workflow.jobs.finalize.if).toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
    // House convention for bot workflows: forks opt in by editing the guard.
    expect(workflow.jobs.finalize.if).toContain(
      "github.repository == 'QwenLM/qwen-code'",
    );
  });

  it('never checks out or executes repository code', () => {
    // The whole point of the split: the agent job reads, this job writes, and
    // neither ever runs PR code. No `uses:` at all — a single API-only bash
    // step, so no action can ever put PR-controlled files next to the PAT.
    expect(workflowText).not.toContain('uses:');
    expect(workflow.jobs.finalize.steps).toHaveLength(1);
  });

  it('serializes concurrent finalize runs per head SHA without cancelling', () => {
    // Two listed workflows can complete near-simultaneously; a cancelled run
    // would drop its read-modify-write, so queue instead of cancel.
    expect(workflowText).toContain(
      "group: 'qwen-triage-finalize-${{ github.event.workflow_run.head_sha }}'",
    );
    expect(workflowText).toContain('cancel-in-progress: false');
  });

  it('gates approval on pull_request workflow runs, not head-SHA check-runs', () => {
    // Check-runs on the head SHA include bot orchestration jobs
    // (pull_request_target / issue_comment) that can outlive CI; counting
    // them would silently drop the deferred approval forever, since only the
    // listed PR CI workflows re-fire this job.
    expect(script).toContain('actions/runs?head_sha=$HEAD_SHA');
    expect(script).toContain('select(.event == "pull_request")');
    expect(script).toContain('group_by(.workflow_id) | map(max_by(.id))');
    // Green is a closed set bound to the conclusion BEFORE the membership
    // test (jq `|` rebinds `.`, so the array-first form raises an error).
    expect(script).toContain(
      '(.conclusion // "") | IN("success","neutral","skipped") | not',
    );
    // A jq failure must read as "cannot attest": non-numeric counters are
    // caught and flip GATE_OK off instead of falling through to approve.
    expect(script).toContain("'' | *[!0-9]*");
    expect(script).toContain('GATE_OK=false');
    expect(script).toContain('[ "$GATE_OK" != true ] || [ "$TOTAL" -eq 0 ]');
  });

  it('treats markers as forgeable and only honors bot-authored comments', () => {
    // Marker text is public: anyone can paste it into a PR comment. Every
    // lookup that acts on a marker must filter on the bot identity first.
    expect(script).toContain("gh api user --jq '.login'");
    // Status-comment lookup: body starts with the marker (a comment that
    // merely quotes it must not be PATCHed), so startswith is the strict match.
    expect(script).toContain(
      'select(.user.login == $bot) | select((.body | startswith($m)) or (.body | startswith($legacy)))',
    );
    // CI-region, approve-marker, and new-head-marker lookups embed the marker
    // inside the body (not at the start), so contains is the correct match —
    // still author-filtered.
    const authorFiltered = script.match(
      /select\(\.user\.login == \$bot\) \| select\(\.body \| contains\(\$m\)\)/g,
    );
    expect(authorFiltered?.length).toBeGreaterThanOrEqual(3);
  });

  it('pins the deferred approval to the reviewed SHA and fails closed', () => {
    expect(script).toContain('-f commit_id="$HEAD_SHA" -f event=APPROVE');
    // Head moved / closed / draft → no approval, explicit stale note — and
    // this re-check runs BEFORE the red/deferred verdicts, so a
    // cancel-in-progress firing on a stale SHA cannot stamp a red status
    // over the new head's comment.
    expect(script).toContain('"$CURRENT_HEAD" != "$HEAD_SHA"');
    expect(script.indexOf('update_status "$PR" stale')).toBeLessThan(
      script.indexOf('update_status "$PR" red'),
    );
    // The status comment is not SHA-scoped, so a late firing for an old SHA
    // must not overwrite it once the new head's re-review (whose sha= markers
    // sit in bot comments) owns it.
    expect(script).toContain('sha=${CURRENT_HEAD}');
    expect(script.indexOf('sha=${CURRENT_HEAD}')).toBeLessThan(
      script.indexOf('update_status "$PR" stale'),
    );
    // Still-pending is visible, not silent.
    expect(script).toContain('update_status "$PR" deferred');
    // Re-running finalize must not stack approvals — and the already-approved
    // branch repairs a status comment that a later PENDING>0 firing flipped
    // back to "deferred" after the approval landed.
    expect(script).toContain('.state == "APPROVED" and .commit_id == $sha');
    expect(script).toMatch(
      /already approved at \$SHORT_SHA\."\n\s*update_status "\$PR" approved/,
    );
    // The fork-refactor guardrail is re-asserted structurally: even a marker
    // that slipped out on a cross-repository refactor PR never becomes an
    // approval, and a deleted fork (null head.repo) is treated as a fork.
    expect(script).toContain(
      `(.head.repo.full_name // "") != .base.repo.full_name`,
    );
    expect(script).toContain("grep -qiE '^[[:space:]]*refactor'");
    expect(script.indexOf('update_status "$PR" guarded')).toBeLessThan(
      script.indexOf('update_status "$PR" deferred'),
    );
  });

  it('binds every marker to the full head SHA of the triggering run', () => {
    expect(script).toContain(
      'CI_BEGIN="<!-- qwen-triage-ci sha=${HEAD_SHA} -->"',
    );
    expect(script).toContain(
      'APPROVE_MARKER="<!-- qwen-triage approve-on-green sha=${HEAD_SHA} -->"',
    );
    expect(workflowText).toContain(
      "HEAD_SHA: '${{ github.event.workflow_run.head_sha }}'",
    );
    expect(script).toContain("STATUS_MARKER='<!-- qwen-triage lifecycle -->'");
    expect(script).toContain(
      "LEGACY_STATUS_MARKER='<!-- qwen-triage stage=status -->'",
    );
  });

  it('sanitizes attacker-influenced check names before the table', () => {
    // Fork PRs can add or rename workflows that run on pull_request, so check
    // names are untrusted. Same discipline as the triage skill: & first,
    // control characters stripped, bounded, rendered in <code>.
    expect(script).toContain("sed -e 's/&/\\&amp;/g'");
    expect(script).toContain("tr -d '\\r\\n\\000'");
    expect(script).toContain('cut -c1-120');
    expect(script).toContain('<code>%s</code>');
    expect(script).toContain('MAX_ROWS=60');
    // Belt-and-braces: this job's own check name stays out of the table.
    expect(script).toContain('map(select(.name != $self))');
  });

  it('keeps the region deterministic so no-op PATCHes are skipped', () => {
    // RUN_URL carries the run id and would differ on every firing; inside the
    // region it would make the cmp always miss and every trigger PATCH.
    const start = script.indexOf(
      'table_rows /tmp/checks.json /tmp/runs.json > /tmp/rows.tsv',
    );
    expect(start).toBeGreaterThan(-1);
    const region = script.slice(start, script.indexOf('} > /tmp/region.md'));
    expect(region).not.toContain('RUN_URL');
    expect(script).toContain('cmp -s /tmp/body-in.md /tmp/body-out.md');
  });

  it('never blanks a table it cannot rebuild', () => {
    // Zero surviving rows (failed runs fetch, missing suite ids) skips the
    // rewrite instead of overwriting the agent's table with an empty one,
    // and replace_region refuses an empty region file outright.
    expect(script).toContain('REGION_OK=false');
    expect(script).toContain('[ -n "$CID" ] && [ "$REGION_OK" != true ]');
    expect(script).toContain('if [ ! -s "$2" ]; then');
  });

  it('exits quietly when no bot token or no matching PR exists', () => {
    expect(script).toContain('if [ -z "${GH_TOKEN:-}" ]');
    expect(script).toContain('No open PR for $SHORT_SHA; nothing to finalize.');
  });

  it('resolves PRs from the open-PR list by head sha, not only the commit association', () => {
    // commits/:sha/pulls returns empty for fork-branch commits (observed
    // live on the current head of an open fork PR), and
    // workflow_run.pull_requests is empty for forks too — filtering the
    // open-PR list by head.sha is the source that cannot miss the PR the
    // deferred approval belongs to. The association endpoint stays as the
    // second source (it powers the stale note when it works).
    expect(script).toContain('pulls?state=open&per_page=100');
    expect(script).toContain('select(.head.sha == $sha)');
    expect(script.indexOf('pulls?state=open')).toBeLessThan(
      script.indexOf('commits/$HEAD_SHA/pulls'),
    );
    expect(script).toContain('sort -un');
  });
});

describe('qwen-triage-finalize helpers', () => {
  const helpers = script.slice(
    script.indexOf('html_escape() {'),
    script.indexOf('# --- end triage-finalize helpers ---'),
  );

  const preamble = [
    'set -uo pipefail',
    'CI_BEGIN="<!-- qwen-triage-ci sha=abc123 -->"',
    "CI_END='<!-- /qwen-triage-ci -->'",
    'SELF_CHECK_NAME=finalize-triage-ci',
  ];

  const runHelpers = (driver) => {
    const proc = spawnSync(
      'bash',
      ['-c', [...preamble, helpers, driver].join('\n')],
      { encoding: 'utf8' },
    );
    return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
  };

  it('extracted all helper functions', () => {
    expect(helpers).toContain('html_escape() {');
    expect(helpers).toContain('replace_region() {');
    expect(helpers).toContain('gate_counts() {');
    expect(helpers).toContain('table_rows() {');
  });

  it('escapes ampersand first so entities are not double-encoded', () => {
    const { status, stdout } = runHelpers(
      `printf '%s' 'a&<>|@[]()*\`b' | html_escape`,
    );
    expect(status).toBe(0);
    expect(stdout).toBe(
      'a&amp;&lt;&gt;&#124;&#64;&#91;&#93;&#40;&#41;&#42;&#96;b',
    );
  });

  it('gate_counts: event-filtered, deduped, closed green set, no jq errors', () => {
    // Covers every conclusion class plus the two poison shapes: non-PR events
    // that must be ignored, and a re-run pair where only the latest counts.
    const runs = [
      {
        event: 'pull_request',
        workflow_id: 1,
        id: 10,
        status: 'completed',
        conclusion: 'success',
      },
      {
        event: 'pull_request',
        workflow_id: 2,
        id: 11,
        status: 'completed',
        conclusion: 'failure',
      },
      {
        event: 'pull_request',
        workflow_id: 3,
        id: 12,
        status: 'in_progress',
        conclusion: null,
      },
      {
        event: 'pull_request',
        workflow_id: 4,
        id: 13,
        status: 'completed',
        conclusion: 'cancelled',
      },
      {
        event: 'pull_request',
        workflow_id: 5,
        id: 14,
        status: 'completed',
        conclusion: 'skipped',
      },
      {
        event: 'pull_request',
        workflow_id: 6,
        id: 15,
        status: 'completed',
        conclusion: 'timed_out',
      },
      {
        event: 'pull_request',
        workflow_id: 7,
        id: 16,
        status: 'completed',
        conclusion: 'action_required',
      },
      {
        event: 'pull_request',
        workflow_id: 8,
        id: 17,
        status: 'queued',
        conclusion: null,
      },
      {
        event: 'pull_request_target',
        workflow_id: 9,
        id: 18,
        status: 'completed',
        conclusion: 'failure',
      },
      {
        event: 'workflow_run',
        workflow_id: 10,
        id: 19,
        status: 'in_progress',
        conclusion: null,
      },
      {
        event: 'pull_request',
        workflow_id: 11,
        id: 20,
        status: 'completed',
        conclusion: 'failure',
      },
      {
        event: 'pull_request',
        workflow_id: 11,
        id: 21,
        status: 'completed',
        conclusion: 'success',
      },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'triage-finalize-gate-'));
    try {
      writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs));
      const { status, stdout, stderr } = runHelpers(
        `gate_counts '${join(dir, 'runs.json')}'`,
      );
      expect(stderr).toBe('');
      expect(status).toBe(0);
      // 9 deduped pull_request runs; 2 pending (in_progress + queued); red =
      // failure + cancelled + timed_out + action_required (the deduped
      // workflow 11 resolves to success; skipped and the non-PR failure are
      // not red).
      expect(stdout.trim()).toBe('9\t2\t4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('table_rows: suite-filtered, deduped by name, skipped dropped, failures first', () => {
    // Suite 1000 belongs to the latest pull_request run; suite 900 to a
    // superseded run of the same workflow; suite 2000 to a bot
    // (pull_request_target) run. Only suite-1000 checks may render.
    const runs = [
      {
        event: 'pull_request',
        workflow_id: 1,
        id: 100,
        check_suite_id: 1000,
      },
      { event: 'pull_request', workflow_id: 1, id: 90, check_suite_id: 900 },
      {
        event: 'pull_request_target',
        workflow_id: 2,
        id: 101,
        check_suite_id: 2000,
      },
    ];
    const checks = [
      {
        name: 'Test (ubuntu-latest)',
        id: 2,
        status: 'completed',
        conclusion: 'success',
        check_suite: { id: 1000 },
      },
      {
        name: 'Test (ubuntu-latest)',
        id: 1,
        status: 'completed',
        conclusion: 'failure',
        check_suite: { id: 1000 },
      },
      {
        name: 'old-run-check',
        id: 3,
        status: 'completed',
        conclusion: 'failure',
        check_suite: { id: 900 },
      },
      {
        name: 'triage',
        id: 4,
        status: 'completed',
        conclusion: 'failure',
        check_suite: { id: 2000 },
      },
      {
        name: 'skippy',
        id: 5,
        status: 'completed',
        conclusion: 'skipped',
        check_suite: { id: 1000 },
      },
      {
        name: 'running',
        id: 6,
        status: 'in_progress',
        conclusion: null,
        check_suite: { id: 1000 },
      },
      {
        name: 'finalize-triage-ci',
        id: 7,
        status: 'in_progress',
        conclusion: null,
        check_suite: { id: 1000 },
      },
      {
        name: 'redcheck',
        id: 8,
        status: 'completed',
        conclusion: 'cancelled',
        check_suite: { id: 1000 },
      },
      {
        name: 'beta',
        id: 9,
        status: 'completed',
        conclusion: 'success',
        check_suite: { id: 1000 },
      },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'triage-finalize-table-'));
    try {
      writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks));
      writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs));
      const { status, stdout, stderr } = runHelpers(
        `table_rows '${join(dir, 'checks.json')}' '${join(dir, 'runs.json')}'`,
      );
      expect(stderr).toBe('');
      expect(status).toBe(0);
      expect(stdout.trimEnd().split('\n')).toEqual([
        'running\tin_progress\t',
        'redcheck\tcompleted\tcancelled',
        'beta\tcompleted\tsuccess',
        'Test (ubuntu-latest)\tcompleted\tsuccess',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces exactly the marked region and preserves the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-finalize-io-'));
    try {
      writeFileSync(
        join(dir, 'body.md'),
        [
          'findings prose stays',
          '<!-- qwen-triage-ci sha=abc123 -->',
          '| old | table |',
          '<!-- /qwen-triage-ci -->',
          'footer stays',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'region.md'),
        [
          '<!-- qwen-triage-ci sha=abc123 -->',
          '| new | table |',
          '<!-- /qwen-triage-ci -->',
        ].join('\n'),
      );
      const { status } = runHelpers(
        `replace_region '${join(dir, 'body.md')}' '${join(dir, 'region.md')}' '${join(dir, 'out.md')}'`,
      );
      expect(status).toBe(0);
      const out = readFileSync(join(dir, 'out.md'), 'utf8');
      expect(out).toContain('findings prose stays');
      expect(out).toContain('footer stays');
      expect(out).toContain('| new | table |');
      expect(out).not.toContain('| old | table |');
      // Markers survive so the NEXT finalize run can update again.
      expect(out).toContain('<!-- qwen-triage-ci sha=abc123 -->');
      expect(out).toContain('<!-- /qwen-triage-ci -->');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the end marker is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-finalize-noend-'));
    try {
      writeFileSync(
        join(dir, 'body.md'),
        ['<!-- qwen-triage-ci sha=abc123 -->', 'unterminated'].join('\n'),
      );
      writeFileSync(join(dir, 'region.md'), 'replacement');
      const { stdout } = runHelpers(
        [
          `replace_region '${join(dir, 'body.md')}' '${join(dir, 'region.md')}' '${join(dir, 'out.md')}'`,
          'echo "exit=$?"',
        ].join('\n'),
      );
      // Non-zero return, and no output file written: the caller leaves the
      // comment untouched rather than truncating it.
      expect(stdout).toContain('exit=1');
      expect(() => readFileSync(join(dir, 'out.md'), 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the end marker only appears before the begin marker', () => {
    // grep -qF proves both markers EXIST, not their order. Without the awk
    // END guard this shape opens the region at the begin marker, eats to
    // EOF (losing the signature and reviewed-commit footer), and exits 0.
    const dir = mkdtempSync(join(tmpdir(), 'triage-finalize-order-'));
    try {
      writeFileSync(
        join(dir, 'body.md'),
        [
          'quoted example: <!-- /qwen-triage-ci -->',
          'prose',
          '<!-- qwen-triage-ci sha=abc123 -->',
          '| old | table |',
          'FOOTER reviewed commit',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'region.md'), 'replacement');
      const { stdout } = runHelpers(
        [
          `replace_region '${join(dir, 'body.md')}' '${join(dir, 'region.md')}' '${join(dir, 'out.md')}'`,
          'echo "exit=$?"',
        ].join('\n'),
      );
      expect(stdout).toContain('exit=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
