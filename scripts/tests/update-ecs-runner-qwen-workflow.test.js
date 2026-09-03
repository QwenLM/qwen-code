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
const reportScript = readFileSync(
  '.github/scripts/ecs-fleet-update-failure-issue.sh',
  'utf8',
);
const lookupScript = readFileSync(
  '.github/scripts/find-marked-issue.sh',
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

// The pool names and the job-name prefix come out of the workflow, never
// hand-copied: the failure script filters this run's jobs by that prefix, so a
// fixture that carries its own copy would agree with the script long after the
// workflow stopped agreeing with either.
const updateJobName =
  workflow.match(/\n {2}update:\n {4}name: '([^']*)'/)?.[1] ?? '';
const poolPrefix = updateJobName.replace(/\$\{\{.*\}\}$/, '');

// Both layouts, because CI runs `prettier --write .` before this suite and
// prettier reflows the inline matrix array onto its own lines. A parser that
// reads only the checked-in layout passes locally and finds zero pools there.
function parsePools(text) {
  return (text.match(/\n\s+runner:\s*\[([^\]]*)\]/)?.[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

const pools = parsePools(workflow);

function jobsFixture({
  failed = [],
  timedOut = [],
  succeeded = [],
  skipped = [],
  resolve = 'success',
} = {}) {
  return {
    jobs: [
      { name: 'Resolve version', conclusion: resolve },
      ...failed.map((pool) => ({
        name: `${poolPrefix}${pool}`,
        conclusion: 'failure',
      })),
      ...timedOut.map((pool) => ({
        name: `${poolPrefix}${pool}`,
        conclusion: 'timed_out',
      })),
      ...succeeded.map((pool) => ({
        name: `${poolPrefix}${pool}`,
        conclusion: 'success',
      })),
      // A skipped matrix leg is still listed by the jobs API, under its fully
      // expanded name — which is exactly what a `resolve` failure produces.
      ...skipped.map((pool) => ({
        name: `${poolPrefix}${pool}`,
        conclusion: 'skipped',
      })),
      { name: 'Report a stale fleet', conclusion: null },
    ],
  };
}

// Two failed pools, one timed out (a pool wedged on a slow npm fetch is the
// shape that produced the v0.22.3 incident), the rest healthy.
const STALE_POOLS = pools.slice(0, 3);
const HEALTHY_POOLS = pools.slice(3);
const DEFAULT_JOBS = jobsFixture({
  failed: pools.slice(0, 2),
  timedOut: pools.slice(2, 3),
  succeeded: HEALTHY_POOLS,
});

describe('ECS runner qwen update workflow', () => {
  it('installs without the selected runner npm prefix', () => {
    expect(workflow).toContain('cd "${RUNNER_TEMP:?}"');
    expect(workflow).toContain('INSTALL=(sudo env -u NPM_CONFIG_PREFIX)');
    expect(workflow).toContain(
      '"${INSTALL[@]}" npm install -g --prefix /usr/local',
    );
  });

  it('keeps the verify diagnostics usable without passwordless sudo', () => {
    // The diagnostics exist for the pools where the install step fell back
    // to the runner user; on those pools an interactive `sudo` blocks on a
    // password prompt until the job timeout kills the step, so every sudo
    // probe must be non-interactive and the package dir must also be
    // probed as the runner user sees it.
    const verify = stepBody('Verify version');
    expect(verify).toContain('npm prefix (user): $(npm prefix -g');
    expect(verify).toMatch(
      /^\s*cat \/usr\/local\/lib\/node_modules\/@qwen-code\/qwen-code\/package\.json/m,
    );
    expect(verify).not.toMatch(/sudo (cat|ls|env)/);
  });

  it('captures the installed version tolerantly', () => {
    // Under `set -e`, a failing `--version` feeding a bare assignment
    // aborts the step before the mismatch branch — and the diagnostics
    // this step exists to print — ever runs.
    expect(stepBody('Verify version')).toContain(
      'actual="$("${qwen_path}" --version 2>&1)" || actual=',
    );
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
    // A job-level permissions block REPLACES the workflow-level one, so the
    // scope actions/checkout needs has to be spelled out here; without it the
    // checkout 403s and the job that exists to break the silence never runs.
    expect(reporter).toContain("      contents: 'read'");
    expect(reporter).toContain("      actions: 'read'");
    expect(reporter).toContain("      issues: 'write'");
    // The script lives in the repo, so the job has to check it out first.
    expect(reporter).toContain("uses: 'actions/checkout@");
    expect(reporter).toContain(
      "run: 'bash .github/scripts/ecs-fleet-update-failure-issue.sh'",
    );
    expect(reporter).toContain("          DEDUP_LABEL: 'scope/ci-cd'");
  });

  it('filters the run jobs by the prefix the matrix job actually uses', () => {
    // The prefix is a contract between the workflow's `name:` template and the
    // script's jq filter, with no runtime error when they disagree: a renamed
    // matrix job makes the filter match nothing, and every issue then reports
    // no stale pools — dropping the one datum this script exists to provide.
    expect(updateJobName).toContain('${{ matrix.runner }}');
    expect(poolPrefix).not.toBe('');
    expect(pools.length).toBeGreaterThan(0);
    // Whichever way the matrix array is laid out — CI reformats it before the
    // suite runs — the pools have to come back the same.
    expect(parsePools("\n        runner: ['a-1', 'a-2']\n")).toEqual([
      'a-1',
      'a-2',
    ]);
    expect(
      parsePools(
        "\n        runner:\n          [\n            'a-1',\n            'a-2',\n          ]\n",
      ),
    ).toEqual(['a-1', 'a-2']);
    expect(reportScript).toContain(`startswith("${poolPrefix}")`);
    expect(reportScript).toContain(`sub("^${poolPrefix}"; "")`);
  });

  it('shares one dedup lookup with the sibling failure reporter', () => {
    // Both reporters file a marker-bearing issue into the same `scope/ci-cd`
    // label space. A guard fixed in one copy and missed in the other makes the
    // other file duplicates while its own suite stays green.
    for (const caller of [
      reportScript,
      readFileSync('.github/scripts/image-build-failure-issue.sh', 'utf8'),
    ]) {
      expect(caller).toContain(
        'bash "$(dirname "${BASH_SOURCE[0]}")/find-marked-issue.sh"',
      );
      expect(caller).toContain('MARKER_HTML="${marker_html}"');
    }
    // GitHub search tokenizes these markers apart, so the match must stay
    // client-side; a null body must not abort the lookup; and the listing is a
    // ceiling, not a newest-first window an immortal issue can fall out of.
    expect(lookupScript).not.toContain('--search');
    expect(lookupScript).toContain('contains($marker_html)');
    expect(lookupScript).toContain('(.body // "")');
    expect(lookupScript).toContain('--limit 1000');
    // Oldest match wins: the newest-first listing puts an issue that merely
    // quotes the marker ahead of the canonical one.
    expect(lookupScript).toContain('last(.[]');
  });
});

// The replays need POSIX paths, a `:`-joined PATH and extensionless bash
// stubs, none of which the Windows lane can express; the YAML suite above
// still runs there. Same gate as
// scripts/tests/build-and-publish-image-workflow.test.js.
const replayable =
  process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;

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

// Runs the 'Verify version' step body against a stubbed `qwen` whose
// `--version` prints `output` and exits with `exitCode`.
function runVerify({ output = '', exitCode = 0, target = '0.22.3' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-verify-'));
  try {
    const qwenStub = join(dir, 'qwen');
    const stubLines = ['#!/usr/bin/env bash'];
    if (output) {
      stubLines.push(`echo '${output}'`);
    }
    stubLines.push(`exit ${exitCode}`);
    writeFileSync(qwenStub, stubLines.join('\n'), { mode: 0o755 });
    chmodSync(qwenStub, 0o755);

    const script = join(dir, 'verify.sh');
    writeFileSync(script, stepBody('Verify version'));

    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        VERSION: target,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs .github/scripts/ecs-fleet-update-failure-issue.sh against a stubbed
// `gh`. The stub applies the script's real `--jq` filter with real jq, so the
// pool-naming expression is exercised rather than mocked away, and it honours
// `--limit` on `issue list` so the dedup window is testable rather than
// vacuously wide.
function runReport({ openIssues = [], jobs = DEFAULT_JOBS, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-report-'));
  try {
    const calls = join(dir, 'calls');
    const body = join(dir, 'captured-body.md');
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobs));
    // Not open-issues.json: the lookup redirects `gh issue list` into
    // ${RUNNER_TEMP}/open-issues.json, which would truncate this fixture.
    writeFileSync(join(dir, 'fixture-issues.json'), JSON.stringify(openIssues));

    const ghStub = join(dir, 'gh');
    writeFileSync(
      ghStub,
      [
        '#!/usr/bin/env bash',
        `echo "gh $*" >> ${calls}`,
        'sub="$1"; shift',
        'case "$sub" in',
        '  api)',
        '    if [[ -n "${STUB_API_FAILS:-}" ]]; then',
        '      echo "gh: HTTP 502 (api.github.com)" >&2',
        '      exit 1',
        '    fi',
        '    filter=""',
        '    while [[ $# -gt 0 ]]; do',
        '      if [[ "$1" == "--jq" ]]; then filter="$2"; shift 2; else shift; fi',
        '    done',
        `    jq -r "$filter" ${join(dir, 'jobs.json')}`,
        '    ;;',
        '  issue)',
        '    action="$1"; shift',
        '    limit=0',
        '    while [[ $# -gt 0 ]]; do',
        '      case "$1" in',
        `        --body-file) cp "$2" ${body}; shift 2 ;;`,
        '        --limit) limit="$2"; shift 2 ;;',
        '        *) shift ;;',
        '      esac',
        '    done',
        '    case "$action" in',
        '      list)',
        '        if [[ -n "${STUB_LIST_FAILS:-}" ]]; then',
        '          echo "gh: HTTP 502 (api.github.com)" >&2',
        '          exit 1',
        '        fi',
        `        jq --argjson limit "$limit" '.[:$limit]' ${join(dir, 'fixture-issues.json')} ;;`,
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

describe.skipIf(!replayable)('ECS runner qwen update replay', () => {
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

  it('resolves the latest dist-tag when dispatched without a version', () => {
    const resolved = runResolve({ env: { INPUT_VERSION: '' } });
    expect(resolved.status).toBe(0);
    expect(resolved.output.trim()).toBe('version=0.22.3');
  });

  it('verifies a healthy install without diagnostics', () => {
    const verified = runVerify({ output: '0.22.3', target: '0.22.3' });
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain('qwen version: 0.22.3');
    expect(verified.stdout).not.toContain('--- diagnostics ---');
  });

  it('prints the diagnostics when the installed qwen is stale', () => {
    const verified = runVerify({ output: '0.22.2', target: '0.22.3' });
    expect(verified.status).toBe(1);
    expect(verified.stdout).toContain('--- diagnostics ---');
    expect(verified.stdout).toContain('--- end diagnostics ---');
  });

  it('prints the diagnostics when the installed qwen cannot run at all', () => {
    // A crashed install can leave `command -v qwen` resolving to a broken
    // entrypoint whose `--version` exits non-zero; the tolerant capture is
    // what keeps the step failing at the version test with diagnostics
    // instead of dying at the bare assignment under `set -e`.
    const verified = runVerify({ exitCode: 127, target: '0.22.3' });
    expect(verified.status).toBe(1);
    expect(verified.stdout).toContain(
      'qwen version: (qwen --version failed, exit 127)',
    );
    expect(verified.stdout).toContain('--- diagnostics ---');
  });

  it('files an issue naming the pools left on the old CLI', () => {
    const reported = runReport({ openIssues: [] });
    expect(reported.status).toBe(0);
    // Only the failed legs, and without the job-name prefix.
    expect(reported.body).toContain(
      `Pools left stale: ${STALE_POOLS.join(', ')}`,
    );
    for (const healthy of HEALTHY_POOLS) {
      expect(reported.body).not.toContain(healthy);
    }
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

  it('still finds the marker issue once it is no longer a recent one', () => {
    // This issue is opened once and only ever commented on, so it drifts to
    // the oldest slot of a newest-first listing while same-label issues keep
    // being created. Under a 200-issue window it silently falls out and the
    // next failure files a duplicate.
    const openIssues = [
      ...Array.from({ length: 250 }, (_, index) => ({
        number: 1000 + index,
        body: `unrelated ci/cd issue ${index}`,
      })),
      { number: 42, body: 'stale\n<!-- ecs-fleet-update-failure -->\n' },
    ];
    const reported = runReport({ openIssues });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue comment 42');
    expect(reported.calls).not.toContain('gh issue create');
  });

  it('survives a labeled issue that has no body at all', () => {
    // GitHub types an issue body as `string or null`; jq's contains() errors
    // out on null, which would abort the script before anything is filed.
    const reported = runReport({
      openIssues: [
        { number: 9, body: null },
        { number: 42, body: 'stale\n<!-- ecs-fleet-update-failure -->\n' },
      ],
    });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue comment 42');

    const first = runReport({ openIssues: [{ number: 9, body: null }] });
    expect(first.status).toBe(0);
    expect(first.calls).toContain('gh issue create');
  });

  it('reports a resolve failure without inventing a pool-level state', () => {
    // The job gate also fires on `needs.resolve.result == 'failure'`, and then
    // no pool was ever asked to install anything: pointing the operator at a
    // `Verify version` step that never ran is a 3 AM detour.
    const reported = runReport({
      // The real shape: `resolve` fails, the whole matrix is skipped, and the
      // jobs API still lists every leg under its fully expanded name. A
      // fixture with no legs at all would pin a shape the API never produces.
      jobs: jobsFixture({ resolve: 'failure', skipped: pools }),
      env: { VERSION: '' },
    });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue create');
    expect(reported.body).toContain(
      'failed before any pool was asked to install a release',
    );
    expect(reported.body).toContain(
      'Pools left stale: none was reached — the run failed before the pool matrix started',
    );
    expect(reported.body).toContain('Target version: `unresolved`');
    expect(reported.body).toContain('read the `Resolve version` step');
    expect(reported.body).not.toContain('`Verify version`');
  });

  it('says so when the job conclusions for the run cannot be read', () => {
    // A transient jobs-API failure must not be reported as "no pool failed",
    // and must not abort the script under `set -euo pipefail` either — that
    // is the silence this job exists to break.
    const reported = runReport({ env: { STUB_API_FAILS: '1' } });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue create');
    expect(reported.body).toContain(
      'Pools left stale: unknown — the job conclusions for this run could not be read',
    );
    // Which shape failed is precisely what could not be read, so the body must
    // not assert one: `resolve` may have failed before any pool ran, and
    // naming `Verify version` steps that never existed is a 3 AM detour.
    expect(reported.body).toContain(
      'check whether the pool matrix started at all',
    );
    expect(reported.body).not.toContain(
      'at least one ECS pool is still running',
    );
    expect(reported.body).not.toContain('`Verify version` step of every pool');
  });

  it('files anyway when the dedup lookup itself fails', () => {
    // The lookup is the one call whose failure would kill the reporter before
    // it writes anything: `set -e` aborts on a failing command substitution
    // feeding an assignment. A rare duplicate issue costs less than silence.
    const reported = runReport({ env: { STUB_LIST_FAILS: '1' } });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue create');
    expect(reported.calls).toMatch(/gh issue create .*--label scope\/ci-cd/);
  });

  it('is not hijacked by a newer issue that merely quotes the marker', () => {
    // The listing is newest-first and the match is a substring, so a bug
    // report *about* this reporter would otherwise outrank the canonical
    // issue forever and every recurrence would land on the wrong one.
    const reported = runReport({
      openIssues: [
        {
          number: 99,
          body: 'the reporter writes <!-- ecs-fleet-update-failure --> into the body it files',
        },
        { number: 42, body: 'stale\n<!-- ecs-fleet-update-failure -->\n' },
      ],
    });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue comment 42');
    expect(reported.calls).not.toContain('gh issue comment 99');
  });

  it('falls back when the legs ran but none reported a failure', () => {
    const reported = runReport({
      jobs: jobsFixture({ succeeded: pools }),
    });
    expect(reported.status).toBe(0);
    expect(reported.calls).toContain('gh issue create');
    expect(reported.body).toContain(
      'Pools left stale: see the run; no pool reported a conclusion',
    );
  });
});
