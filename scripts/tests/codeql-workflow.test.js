/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
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

const yml = parse(readFileSync('.github/workflows/codeql.yml', 'utf8'));

describe('CodeQL workflow failure reporting', () => {
  const report = yml.jobs.report_failure;

  it('reports a scheduled scan that was cancelled, not only one that failed', () => {
    // A `timeout-minutes` overrun reports `cancelled`: `failure()` alone
    // missed 57 of 59 dead nightlies (#13249).
    expect(report.needs).toEqual(['codeql']);
    expect(report.if).toContain('always()');
    expect(report.if).toContain("needs.codeql.result != 'success'");
    // Scheduled runs are the ones on main; a dispatch must not file issues.
    expect(report.if).toContain("github.event_name == 'schedule'");
    expect(report.if).toContain("github.repository == 'QwenLM/qwen-code'");
  });

  it('files a plain issue with the workflow token, never the autofix route', () => {
    // A timeout has no failing test to hand the autofix agent.
    const rendered = JSON.stringify(report);
    expect(rendered).not.toContain('CI_DEV_BOT_PAT');
    expect(rendered).not.toContain('autofix');
    expect(report.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      issues: 'write',
    });
    expect(report['runs-on']).toBe('ubuntu-latest');
  });

  it('names legs by the prefix the scan job name renders to', () => {
    // The script selects legs with startswith("CodeQL ("); renaming the job
    // template on one side only would silently name no legs.
    expect(yml.jobs.codeql.name).toMatch(/^CodeQL \(/);
    expect(
      readFileSync('.github/scripts/codeql-failure-issue.sh', 'utf8'),
    ).toContain('startswith("CodeQL (")');
  });
});

// POSIX paths and an extensionless gh stub; skipped on Windows like the
// sibling replay in build-and-publish-image-workflow.test.js.
const replayable =
  process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;

describe.skipIf(!replayable)('codeql-failure-issue script behavior', () => {
  const jobs = {
    jobs: [
      { name: 'CodeQL (javascript)', conclusion: 'cancelled' },
      { name: 'CodeQL (java)', conclusion: 'success' },
    ],
  };

  const runScript = ({ issues }) => {
    const dir = mkdtempSync(join(tmpdir(), 'codeql-failure-issue-'));
    try {
      const calls = join(dir, 'calls.log');
      const body = join(dir, 'captured-body.md');
      writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobs));
      // Not open-issues.json: the lookup redirects into that name.
      writeFileSync(join(dir, 'fixture-issues.json'), JSON.stringify(issues));
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/usr/bin/env bash',
          `echo "gh $*" >> ${calls}`,
          'prev=""',
          'for arg in "$@"; do',
          `  if [[ "$prev" == "--body-file" ]]; then cp "$arg" ${body}; fi`,
          '  if [[ "$prev" == "--jq" ]]; then filter="$arg"; fi',
          '  prev="$arg"',
          'done',
          'case "$1 $2" in',
          `  "issue list") cat ${join(dir, 'fixture-issues.json')} ;;`,
          `  api*) jq -r "$filter" ${join(dir, 'jobs.json')} ;;`,
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(join(dir, 'gh'), 0o755);
      const result = spawnSync(
        'bash',
        ['.github/scripts/codeql-failure-issue.sh'],
        {
          encoding: 'utf8',
          env: {
            PATH: dir + ':' + (process.env.PATH ?? ''),
            RUNNER_TEMP: dir,
            REPO: 'QwenLM/qwen-code',
            RUN_ID: '1',
            RUN_URL: 'https://github.com/QwenLM/qwen-code/actions/runs/1',
            DEDUP_LABEL: 'scope/ci-cd',
          },
        },
      );
      return {
        status: result.status,
        stderr: result.stderr,
        calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
        body: existsSync(body) ? readFileSync(body, 'utf8') : '',
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('opens a labelled issue naming the leg that did not finish', () => {
    const r = runScript({ issues: [] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain('gh issue create');
    expect(r.calls).toContain('--label type/bug --label scope/ci-cd');
    expect(r.body).toContain('<!-- codeql-nightly-failure -->');
    expect(r.body).toContain('CodeQL (javascript): cancelled');
    expect(r.body).not.toContain('CodeQL (java)');
  });

  it('comments on the open issue instead of filing a duplicate', () => {
    const r = runScript({
      issues: [{ number: 42, body: '<!-- codeql-nightly-failure -->\nold' }],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain('gh issue comment 42');
    expect(r.calls).not.toContain('gh issue create');
  });
});
