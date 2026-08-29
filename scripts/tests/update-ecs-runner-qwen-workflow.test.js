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

const workflow = readFileSync(
  '.github/workflows/update-ecs-runner-qwen.yml',
  'utf8',
);

function step(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(
    new RegExp(
      `\\n\\s+- name:\\s*(['"])${escaped}\\1[\\s\\S]*?(?=\\n\\s+- name:\\s*['"]|\\n\\s{2}[a-zA-Z0-9_-]+:|$)`,
    ),
  );
  return match?.[0] ?? '';
}

// The body of a step's `run: |-` block, dedented to column zero.
function stepBody(name) {
  const body = step(name).match(/run: \|-\n([\s\S]*)$/)?.[1] ?? '';
  return body.replace(/^ {10}/gm, '');
}

// Runs the 'Resolve version' step body against a stubbed `npm` that 404s for
// its first `failures` invocations and then reports `version`.
function runResolve({ failures = 0, version = '0.22.3', env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-update-'));
  try {
    const counter = join(dir, 'attempts');
    const npmStub = join(dir, 'npm');
    writeFileSync(
      npmStub,
      [
        '#!/usr/bin/env bash',
        `attempt=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 ))`,
        `echo "$attempt" > ${counter}`,
        `if (( attempt <= ${failures} )); then`,
        '  echo "npm error code E404" >&2',
        '  echo "npm error 404 No match found for version" >&2',
        '  exit 1',
        'fi',
        `echo '${version}'`,
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(npmStub, 0o755);

    const script = join(dir, 'resolve.sh');
    writeFileSync(script, stepBody('Resolve version'));
    const ghOutput = join(dir, 'github-output');
    writeFileSync(ghOutput, '');

    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: ghOutput,
        INPUT_VERSION: '0.22.3',
        RESOLVE_TIMEOUT_SECONDS: '60',
        RESOLVE_INTERVAL_SECONDS: '0',
        ...env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      output: readFileSync(ghOutput, 'utf8'),
      attempts: Number(readFileSync(counter, 'utf8').trim()),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const JOBS_FIXTURE = {
  jobs: [
    { name: 'Resolve version', conclusion: 'success' },
    { name: 'Update Qwen on ecs-update-sg', conclusion: 'failure' },
    { name: 'Update Qwen on ecs-update-64c', conclusion: 'failure' },
    { name: 'Update Qwen on ecs-update-hk-1', conclusion: 'timed_out' },
    { name: 'Update Qwen on ecs-update-hk-2', conclusion: 'success' },
    { name: 'Report a stale fleet', conclusion: null },
  ],
};

// Runs .github/scripts/ecs-fleet-update-failure-issue.sh against a stubbed
// `gh`. The stub applies the script's real `--jq` filter with real jq, so the
// pool-naming expression is exercised rather than mocked away.
function runReport({ openIssues = [], env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-report-'));
  try {
    const calls = join(dir, 'calls');
    const body = join(dir, 'captured-body.md');
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify(JOBS_FIXTURE));
    writeFileSync(join(dir, 'issues.json'), JSON.stringify(openIssues));

    const ghStub = join(dir, 'gh');
    writeFileSync(
      ghStub,
      [
        '#!/usr/bin/env bash',
        `echo "gh $*" >> ${calls}`,
        'sub="$1"; shift',
        'case "$sub" in',
        '  api)',
        '    filter=""',
        '    while [[ $# -gt 0 ]]; do',
        '      if [[ "$1" == "--jq" ]]; then filter="$2"; shift 2; else shift; fi',
        '    done',
        `    jq -r "$filter" ${join(dir, 'jobs.json')}`,
        '    ;;',
        '  issue)',
        '    action="$1"; shift',
        '    while [[ $# -gt 0 ]]; do',
        `      if [[ "$1" == "--body-file" ]]; then cp "$2" ${body}; shift 2; else shift; fi`,
        '    done',
        '    case "$action" in',
        `      list) cat ${join(dir, 'issues.json')} ;;`,
        "      create) echo 'https://github.com/o/r/issues/777' ;;",
        '    esac',
        '    ;;',
        'esac',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(ghStub, 0o755);

    const result = spawnSync(
      'bash',
      ['.github/scripts/ecs-fleet-update-failure-issue.sh'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: dir,
          GH_TOKEN: 'stub',
          REPO: 'QwenLM/qwen-code',
          RUN_ID: '33193932104',
          RUN_URL:
            'https://github.com/QwenLM/qwen-code/actions/runs/33193932104',
          VERSION: '0.22.3',
          DEDUP_LABEL: 'scope/ci-cd',
          ...env,
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      body: existsSync(body) ? readFileSync(body, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ECS runner qwen update workflow', () => {
  it('installs without the selected runner npm prefix', () => {
    expect(workflow).toContain('cd "${RUNNER_TEMP:?}"');
    expect(workflow).toContain('sudo env -u NPM_CONFIG_PREFIX npm install -g');
  });

  it('runs only when this workflow changes on main', () => {
    expect(workflow).toContain(
      "  push:\n    branches: ['main']\n    paths: ['.github/workflows/update-ecs-runner-qwen.yml']",
    );
  });

  it('annotates a retry and a terminal failure distinctly', () => {
    // The final attempt must not log a "retrying" warning that never
    // retries; a sustained failure ends with an explicit exhausted error.
    expect(workflow).toContain(
      'echo "::warning::npm install attempt ${attempt} failed; retrying"',
    );
    expect(workflow).toContain(
      'echo "::error::npm install of @qwen-code/qwen-code@${VERSION} failed after 3 attempts"',
    );
    expect(workflow).toContain('for attempt in 1 2 3; do');
    expect(workflow).toContain('if [[ "${attempt}" -lt 3 ]]; then');
    expect(workflow).toContain('sudo rm -rf "${PKG_DIR}"/.qwen-code-*');
  });

  it('resolves once on a hosted runner and feeds every pool', () => {
    // One resolution shared by the matrix is what keeps pools that start
    // hours apart from installing different versions; it also keeps the
    // registry wait off the ECS runners.
    expect(workflow).toContain("    runs-on: 'ubuntu-latest'");
    expect(workflow).toContain(
      "      version: '${{ steps.version.outputs.version }}'",
    );
    expect(workflow).toContain("    needs: 'resolve'");
    // All three consumers (install, verify, failure report) read the job
    // output; a leftover step reference would silently expand to an empty
    // version and install `@qwen-code/qwen-code@`.
    const consumers = workflow.match(
      /VERSION: '\$\{\{ needs\.resolve\.outputs\.version \}\}'/g,
    );
    expect(consumers).toHaveLength(3);
    expect(workflow).not.toContain(
      "VERSION: '${{ steps.version.outputs.version }}'",
    );
  });

  it('waits out npm publish propagation instead of failing the race', () => {
    // `npm publish --provenance` returns before the version is resolvable
    // (~16 minutes for v0.22.3), and release.yml dispatches this workflow as
    // soon as it returns.
    const resolved = runResolve({ failures: 3 });
    expect(resolved.status).toBe(0);
    expect(resolved.attempts).toBe(4);
    expect(resolved.output.trim()).toBe('version=0.22.3');
    expect(resolved.stdout).toContain('is not on the registry yet');
    // The per-attempt 404 noise stays out of the log on the happy path.
    expect(resolved.stderr).not.toContain('E404');
  });

  it('fails with the registry error once the wait budget is spent', () => {
    const resolved = runResolve({
      failures: 99,
      env: { RESOLVE_TIMEOUT_SECONDS: '0' },
    });
    expect(resolved.status).toBe(1);
    expect(resolved.output.trim()).toBe('');
    // The suppressed stderr is replayed, so the log still says *why*.
    expect(resolved.stderr).toContain('npm error code E404');
    // The annotation stays on stdout, where Actions parses workflow commands.
    expect(resolved.stdout).toContain(
      "::error::No published qwen version matches '0.22.3' after 0s.",
    );
  });

  it('reports a failed fleet update only when a pool actually failed', () => {
    // `cancelled` is routine: the per-pool concurrency group cancels an older
    // dispatch's pending legs whenever a newer one arrives.
    const guard = workflow.match(/ {4}if: "\$\{\{ always\(\)[^"]*"/)?.[0] ?? '';
    expect(guard).toContain("needs.resolve.result == 'failure'");
    expect(guard).toContain("needs.update.result == 'failure'");
    expect(guard).not.toContain('cancelled');

    const reporter = workflow.slice(workflow.indexOf('  report_failure:'));
    // Hosted, so the report does not queue behind the pools it reports on.
    expect(reporter).toContain("    runs-on: 'ubuntu-latest'");
    expect(reporter).toContain("      actions: 'read'");
    expect(reporter).toContain("      issues: 'write'");
    // The script lives in the repo, so the job has to check it out first.
    expect(reporter).toContain("uses: 'actions/checkout@");
    expect(reporter).toContain(
      "run: 'bash .github/scripts/ecs-fleet-update-failure-issue.sh'",
    );
    expect(reporter).toContain("          DEDUP_LABEL: 'scope/ci-cd'");
  });

  it('files an issue naming the pools left on the old CLI', () => {
    const reported = runReport({ openIssues: [] });
    expect(reported.status).toBe(0);
    // Only the failed legs, and without the job-name prefix.
    expect(reported.body).toContain(
      'Pools left stale: ecs-update-sg, ecs-update-64c, ecs-update-hk-1',
    );
    expect(reported.body).not.toContain('hk-2');
    expect(reported.body).toContain('Target version: `0.22.3`');
    expect(reported.calls).toContain('gh issue create');
    expect(reported.calls).not.toContain('gh issue comment');
    // The dedup label must be applied at creation: a follow-up `issue edit`
    // that failed would leave an issue this script can never find again.
    expect(reported.calls).toMatch(/gh issue create .*--label scope\/ci-cd/);
  });

  it('carries the dedup marker the next run matches on', () => {
    const reported = runReport({ openIssues: [] });
    expect(reported.body).toContain('<!-- ecs-fleet-update-failure -->');
    // Listing is scoped by label, so a stray issue outside it is invisible.
    expect(reported.calls).toContain('--label scope/ci-cd --json number,body');
  });

  it('comments on the marked issue instead of opening a second one', () => {
    const reported = runReport({
      openIssues: [
        { number: 42, body: 'stale\n<!-- ecs-fleet-update-failure -->\n' },
      ],
    });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue comment 42');
    expect(reported.calls).not.toContain('gh issue create');
  });

  it('ignores an unrelated issue that shares the dedup label', () => {
    // `scope/ci-cd` is a general label; only the marker identifies our issue.
    const reported = runReport({
      openIssues: [{ number: 9, body: 'qwen update failed on my machine' }],
    });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue create');
    expect(reported.calls).not.toContain('gh issue comment');
  });

  it('resolves the latest dist-tag when dispatched without a version', () => {
    const resolved = runResolve({ env: { INPUT_VERSION: '' } });
    expect(resolved.status).toBe(0);
    expect(resolved.output.trim()).toBe('version=0.22.3');
  });
});
