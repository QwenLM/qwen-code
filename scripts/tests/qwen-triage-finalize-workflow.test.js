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
  it('fires on CI completion only for PR-caused runs', () => {
    expect(workflow.on.workflow_run.workflows).toEqual([
      'Qwen Code CI',
      'E2E Tests',
    ]);
    expect(workflow.on.workflow_run.types).toEqual(['completed']);
    expect(workflow.jobs.finalize.if).toBe(
      "github.event.workflow_run.event == 'pull_request'",
    );
  });

  it('never checks out or executes repository code', () => {
    // The whole point of the split: the agent job reads, this job writes, and
    // neither ever runs PR code. A checkout here would put PR-controlled files
    // next to a write PAT.
    expect(workflowText).not.toContain('actions/checkout');
    expect(workflowText).not.toContain('npm ');
    expect(workflow.jobs.finalize.steps).toHaveLength(1);
  });

  it('serializes concurrent finalize runs per head SHA without cancelling', () => {
    // CI and E2E can complete near-simultaneously; a cancelled run would drop
    // its read-modify-write, so queue instead of cancel.
    expect(workflowText).toContain(
      "group: 'qwen-triage-finalize-${{ github.event.workflow_run.head_sha }}'",
    );
    expect(workflowText).toContain('cancel-in-progress: false');
  });

  it('excludes its own check-run from the green computation', () => {
    // This job is itself a check on the same SHA and is in_progress while it
    // runs — without the exclusion it could never see the SHA "complete".
    expect(workflow.jobs.finalize.name).toBe('finalize-triage-ci');
    expect(workflow.jobs.finalize.steps[0].env.SELF_CHECK_NAME).toBe(
      'finalize-triage-ci',
    );
    expect(script).toContain('select(.name != $self)');
  });

  it('treats markers as forgeable and only honors bot-authored comments', () => {
    // Marker text is public: anyone can paste it into a PR comment. Every
    // lookup that acts on a marker must filter on the bot identity first.
    const markerLookups = script
      .split('\n')
      .filter((line) => line.includes('--arg m'));
    expect(markerLookups.length).toBeGreaterThan(0);
    expect(script).toContain("gh api user --jq '.login'");
    const authorFiltered = script.match(
      /select\(\.user\.login == \$bot\) \| select\(\.body \| contains\(\$m\)\)/g,
    );
    // CI-region lookup, approve-marker lookup, and status-comment lookup.
    expect(authorFiltered?.length).toBeGreaterThanOrEqual(3);
  });

  it('pins the deferred approval to the reviewed SHA and fails closed', () => {
    expect(script).toContain('-f commit_id="$HEAD_SHA" -f event=APPROVE');
    // Head moved / closed / draft → no approval, explicit stale note.
    expect(script).toContain('"$CURRENT_HEAD" != "$HEAD_SHA"');
    expect(script).toContain('update_status "$PR" stale');
    // Red checks → withheld, not approved.
    expect(script).toContain('update_status "$PR" red');
    // Green is a closed set; anything unknown is not green.
    expect(script).toContain('["success","neutral","skipped"]');
    // Re-running finalize must not stack approvals.
    expect(script).toContain('.state == "APPROVED" and .commit_id == $sha');
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
  });

  it('exits quietly when no bot token or no matching PR exists', () => {
    expect(script).toContain('if [ -z "${GH_TOKEN:-}" ]');
    expect(script).toContain('No open PR for $SHORT_SHA; nothing to finalize.');
  });
});

describe('qwen-triage-finalize helpers', () => {
  const helpers = script.slice(
    script.indexOf('html_escape() {'),
    script.indexOf('# --- end triage-finalize helpers ---'),
  );

  const runHelpers = (driver) => {
    const full = [
      'set -uo pipefail',
      'CI_BEGIN="<!-- qwen-triage-ci sha=abc123 -->"',
      "CI_END='<!-- /qwen-triage-ci -->'",
      helpers,
      driver,
    ].join('\n');
    const proc = spawnSync('bash', ['-c', full], { encoding: 'utf8' });
    return { status: proc.status, stdout: proc.stdout };
  };

  it('extracted both helper functions', () => {
    expect(helpers).toContain('html_escape() {');
    expect(helpers).toContain('replace_region() {');
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
      const proc = spawnSync(
        'bash',
        [
          '-c',
          [
            'set -uo pipefail',
            'CI_BEGIN="<!-- qwen-triage-ci sha=abc123 -->"',
            "CI_END='<!-- /qwen-triage-ci -->'",
            helpers,
            `replace_region '${join(dir, 'body.md')}' '${join(dir, 'region.md')}' '${join(dir, 'out.md')}'`,
          ].join('\n'),
        ],
        { encoding: 'utf8' },
      );
      expect(proc.status).toBe(0);
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
      const proc = spawnSync(
        'bash',
        [
          '-c',
          [
            'set -uo pipefail',
            'CI_BEGIN="<!-- qwen-triage-ci sha=abc123 -->"',
            "CI_END='<!-- /qwen-triage-ci -->'",
            helpers,
            `replace_region '${join(dir, 'body.md')}' '${join(dir, 'region.md')}' '${join(dir, 'out.md')}'`,
            'echo "exit=$?"',
          ].join('\n'),
        ],
        { encoding: 'utf8' },
      );
      // Non-zero return from replace_region, and no output file written: the
      // caller leaves the comment untouched rather than truncating it.
      expect(proc.stdout).toContain('exit=1');
      expect(() => readFileSync(join(dir, 'out.md'), 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
