/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
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
import { describe, it } from 'node:test';

// This suite is the ONLY guard on .github/workflows/update-ecs-runner-qwen.yml,
// and that file routes into the dependency-free github_ci_only fast lane via
// GITHUB_CI_ONLY_FILES. A second copy under scripts/tests/ would not run on the
// PRs that change the workflow — vitest only runs under the full profile — so
// the whole guard lives here, under `node --test`, importing node: builtins
// alone (#10548 review R14-8).
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
    assert.ok(workflow.includes('cd "${RUNNER_TEMP:?}"'));
    assert.ok(
      workflow.includes('sudo env -u NPM_CONFIG_PREFIX npm install -g'),
    );
  });

  it('runs only when this workflow changes on main', () => {
    assert.ok(
      workflow.includes(
        "  push:\n    branches: ['main']\n    paths: ['.github/workflows/update-ecs-runner-qwen.yml']",
      ),
    );
  });

  it('annotates a retry and a terminal failure distinctly', () => {
    // The final attempt must not log a "retrying" warning that never
    // retries; a sustained failure ends with an explicit exhausted error.
    assert.ok(
      workflow.includes(
        'echo "::warning::npm install attempt ${attempt} failed; retrying"',
      ),
    );
    assert.ok(
      workflow.includes(
        'echo "::error::npm install of @qwen-code/qwen-code@${VERSION} failed after 3 attempts"',
      ),
    );
    assert.ok(workflow.includes('for attempt in 1 2 3; do'));
    assert.ok(workflow.includes('if [[ "${attempt}" -lt 3 ]]; then'));
    assert.ok(workflow.includes('sudo rm -rf "${PKG_DIR}"/.qwen-code-*'));
  });

  it('resolves once on a hosted runner and feeds every pool', () => {
    // One resolution shared by the matrix is what keeps pools that start
    // hours apart from installing different versions; it also keeps the
    // registry wait off the ECS runners.
    assert.ok(workflow.includes("    runs-on: 'ubuntu-latest'"));
    assert.ok(
      workflow.includes(
        "      version: '${{ steps.version.outputs.version }}'",
      ),
    );
    assert.ok(workflow.includes("    needs: 'resolve'"));
    // All three consumers (install, verify, failure report) read the job
    // output; a leftover step reference would silently expand to an empty
    // version and install `@qwen-code/qwen-code@`.
    const consumers = workflow.match(
      /VERSION: '\$\{\{ needs\.resolve\.outputs\.version \}\}'/g,
    );
    assert.equal(consumers?.length, 3);
    assert.ok(
      !workflow.includes("VERSION: '${{ steps.version.outputs.version }}'"),
    );
  });

  it('reports a failed fleet update only when a pool actually failed', () => {
    // `cancelled` is routine: the per-pool concurrency group cancels an older
    // dispatch's pending legs whenever a newer one arrives.
    const guard = workflow.match(/ {4}if: "\$\{\{ always\(\)[^"]*"/)?.[0] ?? '';
    assert.ok(guard.includes("needs.resolve.result == 'failure'"));
    assert.ok(guard.includes("needs.update.result == 'failure'"));
    assert.ok(!guard.includes('cancelled'));

    const reporter = workflow.slice(workflow.indexOf('  report_failure:'));
    // Hosted, so the report does not queue behind the pools it reports on.
    assert.ok(reporter.includes("    runs-on: 'ubuntu-latest'"));
    // A job-level permissions block REPLACES the workflow-level one, so the
    // scope actions/checkout needs has to be spelled out here; without it the
    // checkout 403s and the job that exists to break the silence never runs.
    assert.ok(reporter.includes("      contents: 'read'"));
    assert.ok(reporter.includes("      actions: 'read'"));
    assert.ok(reporter.includes("      issues: 'write'"));
    // The script lives in the repo, so the job has to check it out first.
    assert.ok(reporter.includes("uses: 'actions/checkout@"));
    assert.ok(
      reporter.includes(
        "run: 'bash .github/scripts/ecs-fleet-update-failure-issue.sh'",
      ),
    );
    assert.ok(reporter.includes("          DEDUP_LABEL: 'scope/ci-cd'"));
  });

  it('filters the run jobs by the prefix the matrix job actually uses', () => {
    // The prefix is a contract between the workflow's `name:` template and the
    // script's jq filter, with no runtime error when they disagree: a renamed
    // matrix job makes the filter match nothing, and every issue then reports
    // no stale pools — dropping the one datum this script exists to provide.
    assert.ok(updateJobName.includes('${{ matrix.runner }}'));
    assert.notEqual(poolPrefix, '');
    assert.ok(pools.length > 0);
    // Whichever way the matrix array is laid out — CI reformats it before the
    // suite runs — the pools have to come back the same.
    assert.deepEqual(parsePools("\n        runner: ['a-1', 'a-2']\n"), [
      'a-1',
      'a-2',
    ]);
    assert.deepEqual(
      parsePools(
        "\n        runner:\n          [\n            'a-1',\n            'a-2',\n          ]\n",
      ),
      ['a-1', 'a-2'],
    );
    assert.ok(reportScript.includes(`startswith("${poolPrefix}")`));
    assert.ok(reportScript.includes(`sub("^${poolPrefix}"; "")`));
  });

  it('shares one dedup lookup with the sibling failure reporter', () => {
    // Both reporters file a marker-bearing issue into the same `scope/ci-cd`
    // label space. A guard fixed in one copy and missed in the other makes the
    // other file duplicates while its own suite stays green.
    for (const caller of [
      reportScript,
      readFileSync('.github/scripts/image-build-failure-issue.sh', 'utf8'),
    ]) {
      assert.ok(
        caller.includes(
          'bash "$(dirname "${BASH_SOURCE[0]}")/find-marked-issue.sh"',
        ),
      );
      assert.ok(caller.includes('MARKER_HTML="${marker_html}"'));
    }
    // GitHub search tokenizes these markers apart, so the match must stay
    // client-side; a null body must not abort the lookup; and the listing is a
    // ceiling, not a newest-first window an immortal issue can fall out of.
    assert.ok(!lookupScript.includes('--search'));
    assert.ok(lookupScript.includes('contains($marker_html)'));
    assert.ok(lookupScript.includes('(.body // "")'));
    assert.ok(lookupScript.includes('--limit 1000'));
    // Oldest match wins: the newest-first listing puts an issue that merely
    // quotes the marker ahead of the canonical one.
    assert.ok(lookupScript.includes('last(.[]'));
  });
});

// The replays need POSIX paths, a `:`-joined PATH and extensionless bash
// stubs, none of which the Windows lane can express; the workflow-text suite
// above still runs there. Same gate as
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

describe('ECS runner qwen update replay', { skip: !replayable }, () => {
  it('waits out npm publish propagation instead of failing the race', () => {
    // `npm publish --provenance` returns before the version is resolvable
    // (~16 minutes for v0.22.3), and release.yml dispatches this workflow as
    // soon as it returns.
    const resolved = runResolve({ failures: 3 });
    assert.equal(resolved.status, 0);
    assert.equal(resolved.attempts, 4);
    assert.equal(resolved.output.trim(), 'version=0.22.3');
    assert.ok(resolved.stdout.includes('is not on the registry yet'));
    // The per-attempt 404 noise stays out of the log on the happy path.
    assert.ok(!resolved.stderr.includes('E404'));
  });

  it('fails with the registry error once the wait budget is spent', () => {
    const resolved = runResolve({
      failures: 99,
      env: { RESOLVE_TIMEOUT_SECONDS: '0' },
    });
    assert.equal(resolved.status, 1);
    assert.equal(resolved.output.trim(), '');
    // The suppressed stderr is replayed, so the log still says *why*.
    assert.ok(resolved.stderr.includes('npm error code E404'));
    // The annotation stays on stdout, where Actions parses workflow commands.
    assert.ok(
      resolved.stdout.includes(
        "::error::No published qwen version matches '0.22.3' after 0s.",
      ),
    );
  });

  it('resolves the latest dist-tag when dispatched without a version', () => {
    const resolved = runResolve({ env: { INPUT_VERSION: '' } });
    assert.equal(resolved.status, 0);
    assert.equal(resolved.output.trim(), 'version=0.22.3');
  });

  it('files an issue naming the pools left on the old CLI', () => {
    const reported = runReport({ openIssues: [] });
    assert.equal(reported.status, 0);
    // Only the failed legs, and without the job-name prefix.
    assert.ok(
      reported.body.includes(`Pools left stale: ${STALE_POOLS.join(', ')}`),
    );
    for (const healthy of HEALTHY_POOLS) {
      assert.ok(!reported.body.includes(healthy));
    }
    assert.ok(reported.body.includes('Target version: `0.22.3`'));
    assert.ok(reported.calls.includes('gh issue create'));
    assert.ok(!reported.calls.includes('gh issue comment'));
    // The dedup label must be applied at creation: a follow-up `issue edit`
    // that failed would leave an issue this script can never find again.
    assert.match(reported.calls, /gh issue create .*--label scope\/ci-cd/);
  });

  it('carries the dedup marker the next run matches on', () => {
    const reported = runReport({ openIssues: [] });
    assert.ok(reported.body.includes('<!-- ecs-fleet-update-failure -->'));
    // Listing is scoped by label, so a stray issue outside it is invisible.
    assert.ok(
      reported.calls.includes('--label scope/ci-cd --json number,body'),
    );
  });

  it('comments on the marked issue instead of opening a second one', () => {
    const reported = runReport({
      openIssues: [
        { number: 42, body: 'stale\n<!-- ecs-fleet-update-failure -->\n' },
      ],
    });
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue comment 42'));
    assert.ok(!reported.calls.includes('gh issue create'));
  });

  it('ignores an unrelated issue that shares the dedup label', () => {
    // `scope/ci-cd` is a general label; only the marker identifies our issue.
    const reported = runReport({
      openIssues: [{ number: 9, body: 'qwen update failed on my machine' }],
    });
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue create'));
    assert.ok(!reported.calls.includes('gh issue comment'));
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
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue comment 42'));
    assert.ok(!reported.calls.includes('gh issue create'));
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
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue comment 42'));

    const first = runReport({ openIssues: [{ number: 9, body: null }] });
    assert.equal(first.status, 0);
    assert.ok(first.calls.includes('gh issue create'));
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
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue create'));
    assert.ok(
      reported.body.includes(
        'failed before any pool was asked to install a release',
      ),
    );
    assert.ok(
      reported.body.includes(
        'Pools left stale: none was reached — the run failed before the pool matrix started',
      ),
    );
    assert.ok(reported.body.includes('Target version: `unresolved`'));
    assert.ok(reported.body.includes('read the `Resolve version` step'));
    assert.ok(!reported.body.includes('`Verify version`'));
  });

  it('says so when the job conclusions for the run cannot be read', () => {
    // A transient jobs-API failure must not be reported as "no pool failed",
    // and must not abort the script under `set -euo pipefail` either — that
    // is the silence this job exists to break.
    const reported = runReport({ env: { STUB_API_FAILS: '1' } });
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue create'));
    assert.ok(
      reported.body.includes(
        'Pools left stale: unknown — the job conclusions for this run could not be read',
      ),
    );
    // Which shape failed is precisely what could not be read, so the body must
    // not assert one: `resolve` may have failed before any pool ran, and
    // naming `Verify version` steps that never existed is a 3 AM detour.
    assert.ok(
      reported.body.includes('check whether the pool matrix started at all'),
    );
    assert.ok(
      !reported.body.includes('at least one ECS pool is still running'),
    );
    assert.ok(!reported.body.includes('`Verify version` step of every pool'));
  });

  it('files anyway when the dedup lookup itself fails', () => {
    // The lookup is the one call whose failure would kill the reporter before
    // it writes anything: `set -e` aborts on a failing command substitution
    // feeding an assignment. A rare duplicate issue costs less than silence.
    const reported = runReport({ env: { STUB_LIST_FAILS: '1' } });
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue create'));
    assert.match(reported.calls, /gh issue create .*--label scope\/ci-cd/);
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
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue comment 42'));
    assert.ok(!reported.calls.includes('gh issue comment 99'));
  });

  it('falls back when the legs ran but none reported a failure', () => {
    const reported = runReport({
      jobs: jobsFixture({ succeeded: pools }),
    });
    assert.equal(reported.status, 0);
    assert.ok(reported.calls.includes('gh issue create'));
    assert.ok(
      reported.body.includes(
        'Pools left stale: see the run; no pool reported a conclusion',
      ),
    );
  });
});
