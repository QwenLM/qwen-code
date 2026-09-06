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
    // The sudo mode drops the runner user's custom npm prefix, and
    // `--prefix` pins the install to /usr/local: on hk-4/hk-5 root's global
    // prefix is a custom Node directory, so without the pin the update lands
    // somewhere the pool never resolves.
    assert.ok(workflow.includes('sudo -n env -u NPM_CONFIG_PREFIX'));
    assert.ok(workflow.includes('npm install -g --prefix /usr/local'));
  });

  it('picks the install mode by running it, not by proxy-probing sudo', () => {
    // hk-1/hk-2 carry command-specific sudoers: they reject a generic
    // `sudo -n true` probe and allow the real npm install. A probe-selected
    // mode therefore lands on the runner user on exactly the pools that
    // could have installed as root, and that mode EACCESes against the
    // root-owned package dir on all three attempts — those two pools can
    // never update. Only the real command can answer for itself.
    const update = stepBody('Update qwen');
    // Comments narrate the old probe, so every assertion here reads the
    // comment-stripped code.
    const updateCode = update
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.ok(!updateCode.includes('sudo -n true'));
    assert.ok(
      updateCode.includes('install_qwen sudo -n env -u NPM_CONFIG_PREFIX'),
    );
    // The runner-user fallback has to survive: deleting it strands any pool
    // with no passwordless sudo at all, and making every mode sudo strands
    // it the same way.
    assert.ok(updateCode.includes('install_qwen env'));
    // hk-1/hk-2's sudoers names one exact argv and it carries no --prefix,
    // so the pinned line can never be the one that installs there. A second
    // sudo mode running the authorized shape is what keeps those two pools
    // updatable: run 33754421601 (pinned only) rejected hk-1 and hk-2 with
    // `sudo: a password is required` on all three attempts while hk-3/4/5
    // went green.
    assert.ok(
      updateCode.includes(
        'install_qwen_named_spec sudo -n env -u NPM_CONFIG_PREFIX',
      ),
    );
    // Order is the whole fix. Pinned first: on hk-4/hk-5 root's global
    // prefix is a custom Node directory, so the unpinned argv is *allowed*
    // there and installs where the pool never resolves. Named spec second,
    // runner user last: any earlier runner-user attempt is a wasted EACCES
    // against the root-owned package dir on every pool that could have
    // installed as root, which is the regression this step came back from.
    const pinnedAt = updateCode.indexOf('install_qwen sudo -n');
    const namedSpecAt = updateCode.indexOf('install_qwen_named_spec sudo -n');
    const runnerAt = updateCode.indexOf('install_qwen env');
    assert.ok(pinnedAt > -1);
    assert.ok(namedSpecAt > pinnedAt);
    assert.ok(runnerAt > namedSpecAt);
    // The order above is only worth what the advance condition is: a `||`
    // chain advances on ANY non-zero exit, so a transient npm failure of the
    // pinned mode falls through to the unpinned arm — which hk-4/hk-5's
    // generic sudoers allows, turning a retryable npm blip into a root
    // install into the prefix the pool never resolves. Only a sudo refusal
    // may advance, and it has to be one the arm positively identifies: an
    // npm failure — including one npm dies without announcing, which is what
    // classifying by the absence of `npm ` output would misread as a
    // refusal — goes back to the retry loop. Asserted here too because the
    // replay arm below is skipped on the Windows lane.
    assert.ok(!updateCode.includes('NPM_CONFIG_PREFIX ||'));
    assert.ok(updateCode.includes('arm_ran_npm'));
    assert.ok(updateCode.includes("grep -q '^sudo:'"));
    assert.ok(!updateCode.includes("grep -q '^npm '"));
    // Presence of the prefix is not the refusal, though: sudo prints
    // non-fatal diagnostics under that same program-name prefix while still
    // running the command, so advancement requires the refusal to be the
    // arm's whole story — nothing else on stderr, nothing on stdout. Pinned
    // as strings too, because the replay arm below is skipped on Windows.
    assert.ok(updateCode.includes("! grep -qv '^sudo:'"));
    assert.ok(updateCode.includes('[[ ! -s "${out}" ]]'));
    // Each install argv appears exactly once: the pin cannot drift between
    // the two modes that share it, and neither mode can lose the registry
    // pin or grow a flag the authorized spec does not name.
    assert.equal(
      updateCode.match(/npm install -g --prefix \/usr\/local/g)?.length,
      1,
    );
    assert.equal(
      updateCode.match(
        /npm install -g --registry=https:\/\/registry\.npmjs\.org/g,
      )?.length,
      1,
    );
    // Same class the Verify step is held to: a bare `sudo` blocks on a
    // password prompt until `timeout-minutes: 10` kills the step, on the
    // pools the fallback exists for.
    assert.doesNotMatch(updateCode, /sudo\s+(?!-n\b)/);
  });

  it('keeps the verify diagnostics usable without passwordless sudo', () => {
    // The diagnostics exist for the pools where the install step fell back
    // to the runner user; on those pools an interactive `sudo` blocks on a
    // password prompt until the job timeout kills the step, so every sudo
    // probe must be non-interactive and the package dir must also be
    // probed as the runner user sees it.
    const verify = stepBody('Verify version');
    assert.ok(verify.includes('npm prefix (user): $(npm prefix -g'));
    assert.match(
      verify,
      /^\s*cat \/usr\/local\/lib\/node_modules\/@qwen-code\/qwen-code\/package\.json/m,
    );
    // Assert the class documented above — every sudo probe must be
    // non-interactive — instead of enumerating the verbs used today: a bare
    // `sudo` with any other verb passes an enumeration and blocks on a
    // password prompt until the job timeout on exactly the pools these
    // diagnostics exist for. The probe comment mentions `sudo` in prose, so
    // the comment lines stay out of the check.
    const verifyCode = verify
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(verifyCode, /sudo\s+(?!-n\b)/);
  });

  it('captures the installed version tolerantly', () => {
    // Under `set -e`, a failing `--version` feeding a bare assignment
    // aborts the step before the mismatch branch — and the diagnostics
    // this step exists to print — ever runs. The capture stays stdout-only:
    // any stderr byte would fold into the strict-matched version and fail a
    // healthy install on one runtime warning.
    assert.ok(
      stepBody('Verify version').includes(
        'actual="$("${qwen_path}" --version)" || actual=',
      ),
    );
  });

  it('keeps the resolve job timeout above the shipped wait budget', () => {
    // The replay harness injects its own timeout values, so nothing else
    // guards the shipped budget: a merge resolution that lowered the job
    // timeout below the wait would let GitHub kill the poll while the
    // registry is still propagating, silently restoring the v0.23.0
    // failure this PR fixes.
    const resolveJob = workflow.slice(
      workflow.indexOf('\n  resolve:'),
      workflow.indexOf('\n  update:'),
    );
    assert.ok(resolveJob.includes("RESOLVE_TIMEOUT_SECONDS: '5400'"));
    const timeoutMinutes = Number(
      resolveJob.match(/timeout-minutes: (\d+)/)?.[1] ?? 0,
    );
    const budgetSeconds = Number(
      resolveJob.match(/RESOLVE_TIMEOUT_SECONDS: '(\d+)'/)?.[1] ?? 0,
    );
    assert.equal(budgetSeconds, 5400);
    // The job must outlive the whole wait plus the final poll's npm call.
    assert.ok(timeoutMinutes * 60 >= budgetSeconds + 600);
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
    // `-n` like every other sudo in this step: the trash cleanup runs on the
    // pools with no passwordless sudo too, where a bare `sudo` would block on
    // a password prompt instead of falling through to the `|| true`.
    assert.ok(workflow.includes('sudo -n rm -rf "${PKG_DIR}"/.qwen-code-*'));
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

// Runs the 'Verify version' step body against a stubbed `qwen` whose
// `--version` prints `output` (stdout), optionally `stderrOutput` (stderr),
// and exits with `exitCode`.
function runVerify({
  output = '',
  stderrOutput = '',
  exitCode = 0,
  target = '0.22.3',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-verify-'));
  try {
    const qwenStub = join(dir, 'qwen');
    const stubLines = ['#!/usr/bin/env bash'];
    if (stderrOutput) {
      stubLines.push(`echo '${stderrOutput}' >&2`);
    }
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

// Runs the 'Update qwen' step body against stubbed `sudo`, `npm` and `sleep`
// modelling one pool's sudoers policy and prefix ownership:
//   sudoers: 'generic'          — passwordless sudo for anything (hk-3/4/5)
//            'command-specific' — sudo only for the npm install itself, while
//                                 a generic `sudo -n true` probe is rejected
//                                 (hk-1/hk-2, the shape that regressed)
//            'none'             — no passwordless sudo at all
//   prefixOwner: who can write /usr/local/lib/node_modules
//   npmFailures: fail this many install invocations with npm's own error
//                output before letting them succeed — a transient npm failure
//                (the ENOTEMPTY rename race this step retries through), which
//                is NOT a sudo refusal and must not advance the mode chain.
//   npmFailureStyle: 'npm'    — failures speak with npm's own prefix (default)
//                    'signal' — every install dies without announcing itself,
//                               the way an OOM-killer SIGKILL or V8 heap
//                               exhaustion does. A separate axis from
//                               npmFailures, whose premise is that npm always
//                               speaks for itself.
//   sudoWarning: true — sudo prints a NON-FATAL diagnostic under its own
//                       program-name prefix (`unable to resolve host <host>`,
//                       routine when the machine's hostname is missing from
//                       /etc/hosts) while still running the command. Emitted
//                       during startup, before the policy check, so a refused
//                       arm carries it too. Orthogonal to both npm axes: it
//                       is not a failure and it is not a refusal.
// The npm stub records every install it is asked to run tagged with the
// effective user, so a test can assert *which mode* installed rather than
// only that the step exited 0 — a fallback that succeeds after a wasted
// runner-user EACCES attempt against a root-owned prefix is the regression.
function runUpdate({
  sudoers = 'generic',
  prefixOwner = 'root',
  version = '0.22.3',
  npmFailures = 0,
  npmFailureStyle = 'npm',
  sudoWarning = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-install-'));
  try {
    const calls = join(dir, 'npm-calls');
    writeFileSync(calls, '');
    const installAttempts = join(dir, 'install-attempts');

    const sudoStub = join(dir, 'sudo');
    writeFileSync(
      sudoStub,
      [
        '#!/usr/bin/env bash',
        '# A `sudo` without `-n` blocks on a password prompt until the job',
        '# timeout kills the step; fail it distinctly so a dropped `-n` reds.',
        'if [[ "${1:-}" != "-n" ]]; then',
        '  echo "sudo: a terminal is required to read the password" >&2',
        '  exit 1',
        'fi',
        'shift',
        '# Real sudo prints this during startup, before it evaluates the',
        '# policy, and still runs the command afterwards — so it lands on the',
        '# stderr of an authorized arm and a refused one alike.',
        `if [[ "${sudoWarning}" == 'true' ]]; then`,
        '  echo "sudo: unable to resolve host hk-4: Name or service not known" >&2',
        'fi',
        'case ' + `"${sudoers}"` + ' in',
        '  generic) ;;',
        '  command-specific)',
        '    # Modelled on `sudo -n -l` on a live hk-2 pool member, which names',
        '    # two exact argv and nothing else. Matching a substring such as',
        '    # ` npm install -g ` instead would also accept that install with',
        '    # --prefix wedged between -g and --registry= -- the one argv the',
        '    # real machines reject (run 33754421601: hk-1/hk-2 `sudo: a',
        '    # password is required` x3, hk-3/4/5 green) -- so the replay would',
        "    # keep measuring this stub's assumption rather than the fleet.",
        '    case " $* " in',
        "      ' rm -rf /usr/local/lib/node_modules/@qwen-code/.qwen-code-'* | ' env -u NPM_CONFIG_PREFIX npm install -g --registry=https://registry.npmjs.org @qwen-code/qwen-code@'*)",
        '        ;;',
        '      *)',
        '        echo "sudo: a password is required" >&2',
        '        exit 1',
        '        ;;',
        '    esac',
        '    ;;',
        '  *)',
        '    echo "sudo: a password is required" >&2',
        '    exit 1',
        '    ;;',
        'esac',
        '# Only the `env ... npm install` form is actually run, as root. The',
        '# trash-cleanup `rm -rf` is authorized but not executed: a replay',
        "# must never touch the host's real /usr/local.",
        'if [[ "${1:-}" == "env" ]]; then',
        '  STUB_EFFECTIVE_USER=root exec "$@"',
        'fi',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(sudoStub, 0o755);

    const npmStub = join(dir, 'npm');
    writeFileSync(
      npmStub,
      [
        '#!/usr/bin/env bash',
        '# The prefix the runner user exports is recorded too: the sudo mode',
        '# must not carry it into the install.',
        'echo "${STUB_EFFECTIVE_USER:-runner}|NPM_CONFIG_PREFIX=${NPM_CONFIG_PREFIX:-UNSET}|$*" >> ' +
          calls,
        'if [[ " $* " == *" install -g "* ]]; then',
        `  install_attempt=$(( $(cat ${installAttempts} 2>/dev/null || echo 0) + 1 ))`,
        `  echo "$install_attempt" > ${installAttempts}`,
        '  # npm reached this point, so sudo authorized the argv. A failure',
        "  # npm reports for itself always carries npm's own prefix:",
        `  if (( install_attempt <= ${npmFailures} )); then`,
        "    echo 'npm error code ENOTEMPTY' >&2",
        "    echo 'npm error syscall rename' >&2",
        '    exit 1',
        '  fi',
        `  if [[ "${npmFailureStyle}" == 'signal' ]]; then`,
        '    # The other axis: a death npm never announces. SIGKILL from the',
        '    # OOM killer on a machine every runner job of the region shares,',
        '    # or V8 exhausting its heap while unpacking the tarball. Neither',
        '    # leaves an `npm `-prefixed line behind, so a discriminator keyed',
        '    # on that absence misreads it as a sudo refusal and escalates.',
        '    kill -KILL $$',
        '    exit 137',
        '  fi',
        '  if [[ "${STUB_EFFECTIVE_USER:-runner}" == "root" ]]; then',
        "    echo 'changed 16 packages in 5s'",
        '    exit 0',
        '  fi',
        `  if [[ "${prefixOwner}" == "runner" ]]; then`,
        "    echo 'changed 16 packages in 5s'",
        '    exit 0',
        '  fi',
        '  echo "npm error code EACCES" >&2',
        '  echo "npm error path /usr/local/lib/node_modules/@qwen-code" >&2',
        '  exit 1',
        'fi',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(npmStub, 0o755);

    // The retry backoff is 10s + 20s; a replay must not sit through it.
    const sleepStub = join(dir, 'sleep');
    writeFileSync(sleepStub, '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755,
    });
    chmodSync(sleepStub, 0o755);

    const script = join(dir, 'update.sh');
    writeFileSync(script, stepBody('Update qwen'));

    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: dir,
        VERSION: version,
        // What a runner user's shell profile exports on the pools the
        // `-u NPM_CONFIG_PREFIX` drop exists for.
        NPM_CONFIG_PREFIX: '/home/runner/.npm-global',
      },
    });
    const recorded = readFileSync(calls, 'utf8');
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      // Effective user of each npm install invocation, in order.
      modes: recorded
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|')[0]),
      calls: recorded,
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

  // The fleet splits into three sudoers classes and the install step has to
  // serve all three. The mode assertions read the effective user npm actually
  // ran as, not just the exit code: a fallback that eventually succeeds after
  // a wasted runner-user EACCES attempt against a root-owned prefix is the
  // shape that lost hk-1/hk-2.

  it('installs as root on a pool whose sudoers allows only the npm install', () => {
    // hk-1/hk-2. A generic `sudo -n true` probe is rejected here while the
    // real install is allowed, so a probe-selected mode picks the runner user
    // and every attempt EACCESes against the root-owned package dir — the
    // pool can never update. Trying the real command is what saves it.
    //
    // The stub above rejects every argv the real spec does not name, so this
    // is also the assertion that bites when a flag is wedged into the install
    // the spec authorizes: with `--prefix /usr/local` back in that argv, sudo
    // refuses it, the step falls through to the runner user, and all three
    // attempts EACCES against the root-owned prefix.
    const updated = runUpdate({ sudoers: 'command-specific' });
    assert.equal(updated.status, 0);
    assert.deepEqual(updated.modes, ['root']);
    assert.ok(!updated.stderr.includes('EACCES'));
    // The install that ran is exactly the authorized argv, unpinned and
    // without the runner user's custom npm prefix. The pinned sudo attempt
    // is rejected before npm starts, so nothing else is recorded.
    assert.ok(
      updated.calls.includes(
        'root|NPM_CONFIG_PREFIX=UNSET|install -g --registry=https://registry.npmjs.org @qwen-code/qwen-code@0.22.3',
      ),
    );
    assert.ok(!updated.calls.includes('--prefix'));
    assert.equal(updated.calls.trim().split('\n').length, 1);
  });

  it('installs as root on a pool with passwordless sudo for anything', () => {
    // hk-3/4/5 today: the sudo mode must stay the one that runs, pinned to
    // /usr/local and without the runner user's custom npm prefix.
    const updated = runUpdate({ sudoers: 'generic' });
    assert.equal(updated.status, 0);
    assert.deepEqual(updated.modes, ['root']);
    assert.ok(updated.calls.includes('install -g --prefix /usr/local'));
    assert.ok(updated.calls.includes('--registry=https://registry.npmjs.org'));
    assert.ok(updated.calls.includes('NPM_CONFIG_PREFIX=UNSET'));
  });

  it('retries the pinned mode through a transient npm failure instead of escalating', () => {
    // hk-3/4/5 authorize ANY argv, so the unpinned spec arm is *allowed*
    // there too and installs into root's custom Node prefix the pool never
    // resolves. A `||` chain advances on any non-zero exit and cannot tell
    // that from "npm ran and failed", so one transient npm failure of the
    // pinned mode — the ENOTEMPTY rename race the retry loop exists for —
    // used to reach it, as root, on the pool class that needed the pin.
    const updated = runUpdate({ sudoers: 'generic', npmFailures: 1 });
    assert.equal(updated.status, 0);
    assert.deepEqual(updated.modes, ['root', 'root']);
    // Both invocations are the pinned argv: the retry stayed in mode 1 and
    // never handed the pool the unpinned one.
    const installs = updated.calls.trim().split('\n');
    assert.equal(installs.length, 2);
    for (const install of installs) {
      assert.ok(install.includes('install -g --prefix /usr/local'));
    }
    // The retry loop absorbed it, and says so.
    assert.ok(
      updated.stdout.includes(
        '::warning::npm install attempt 1 failed; retrying',
      ),
    );
  });

  it('retries the same mode when npm dies without announcing it', () => {
    // The other half of the advance condition, and why its polarity is the
    // property rather than the instance: a SIGKILL from the OOM killer, or V8
    // exhausting its heap while unpacking the tarball, leaves no `npm `-
    // prefixed line behind. Keying the discriminator on that absence reads
    // the death as a sudo refusal and escalates to the unpinned arm, which
    // generic sudoers allows — root installs into the custom Node prefix the
    // pool never resolves, and the step exits 0 certifying an update that did
    // not happen, having spent the retry that would have absorbed it and left
    // a root-owned tree the PKG_DIR cleanup glob never reaches. Only a
    // refusal the arm can positively identify may advance.
    const updated = runUpdate({
      sudoers: 'generic',
      npmFailureStyle: 'signal',
    });
    assert.equal(updated.status, 1);
    // Every attempt stayed in mode 1: no escalation to the unpinned argv.
    assert.deepEqual(updated.modes, ['root', 'root', 'root']);
    for (const install of updated.calls.trim().split('\n')) {
      assert.ok(install.includes('install -g --prefix /usr/local'));
    }
    // Announced and retried, not certified as a success.
    assert.ok(
      updated.stdout.includes(
        '::warning::npm install attempt 1 failed; retrying',
      ),
    );
  });

  it('does not read a non-fatal sudo warning as a refusal to advance', () => {
    // `^sudo:` is sudo's program-name prefix, not a refusal marker: real sudo
    // prints `unable to resolve host <host>` under it — routine when the
    // machine's own hostname is missing from /etc/hosts, and observed on a
    // live hk pool member, where it resolved only through mDNS — while still
    // running the command. On an hk-4/hk-5-class pool that warning therefore
    // shares ${err} with the pinned arm's transient npm failure, the ENOTEMPTY
    // rename race the retry loop exists for. Keying the discriminator on the
    // prefix merely being present classifies that as a refusal: the chain
    // escalates to the unpinned `named-spec` argv generic sudoers also allows,
    // root installs into /usr/local/lib/nodejs/node-v22.23.2-linux-x64, that
    // arm returns 0 and `esac && exit 0` certifies the update without ever
    // printing the retry warning — leaving a root-owned tree the PKG_DIR
    // cleanup glob never reaches, and a Verify leg that reds. The warning is a
    // persistent host condition, so every later transient npm failure on that
    // pool escalates the same way. The refusal has to be the arm's whole story.
    const updated = runUpdate({
      sudoers: 'generic',
      npmFailures: 1,
      sudoWarning: true,
    });
    assert.equal(updated.status, 0);
    // Retried its own mode instead of escalating to the unpinned one.
    assert.deepEqual(updated.modes, ['root', 'root']);
    const installs = updated.calls.trim().split('\n');
    assert.equal(installs.length, 2);
    for (const install of installs) {
      assert.ok(install.includes('install -g --prefix /usr/local'));
    }
    // The retry was spent as a retry, and said so.
    assert.ok(
      updated.stdout.includes(
        '::warning::npm install attempt 1 failed; retrying',
      ),
    );
    // The warning is still surfaced; only its meaning as a refusal is gone.
    assert.ok(updated.stderr.includes('sudo: unable to resolve host'));
  });

  it('still advances past a refusal on a pool whose sudo also warns', () => {
    // The negative half, so the tightening cannot strand hk-1/hk-2: their real
    // refusal leaves stderr holding nothing but `^sudo:` lines and stdout
    // empty, which the conjunction still reads as a refusal. The warning
    // arrives during sudo startup, before the policy check, so the rejected
    // arm carries both lines and the chain still moves on to the authorized
    // spec.
    const updated = runUpdate({
      sudoers: 'command-specific',
      sudoWarning: true,
    });
    assert.equal(updated.status, 0);
    assert.deepEqual(updated.modes, ['root']);
    const installs = updated.calls.trim().split('\n');
    assert.equal(installs.length, 1);
    // Mode 2 installed: the spec hk-1/hk-2's sudoers names, unpinned.
    assert.ok(
      installs[0].includes('install -g --registry=https://registry.npmjs.org'),
    );
    assert.ok(!installs[0].includes('--prefix'));
    assert.ok(updated.stderr.includes('sudo: unable to resolve host'));
  });

  it('still advances on a sudo refusal, then retries the authorized spec', () => {
    // The property the unpinned arm was added for has to survive the advance
    // condition: hk-1/hk-2 refuse the pinned argv, and that refusal — npm
    // never ran — is still what moves the chain on to the spec they name.
    // Once that spec is authorized its own transient npm failure retries
    // itself instead of dropping the pool to the runner user, which EACCESes
    // against the root-owned prefix on all three attempts.
    const updated = runUpdate({ sudoers: 'command-specific', npmFailures: 1 });
    assert.equal(updated.status, 0);
    assert.deepEqual(updated.modes, ['root', 'root']);
    const installs = updated.calls.trim().split('\n');
    assert.equal(installs.length, 2);
    for (const install of installs) {
      assert.ok(
        install.includes('install -g --registry=https://registry.npmjs.org'),
      );
      assert.ok(!install.includes('--prefix'));
    }
    assert.ok(!updated.stderr.includes('EACCES'));
  });

  it('falls back to the runner user on a pool with no sudo at all', () => {
    // The mode the fallback exists for. Deleting it — or making both modes
    // sudo — leaves these pools with no way to install at all.
    const updated = runUpdate({ sudoers: 'none', prefixOwner: 'runner' });
    assert.equal(updated.status, 0);
    assert.deepEqual(updated.modes, ['runner']);
  });

  it('never runs an interactive sudo in the install step', () => {
    // On a pool where the runner user owns the prefix the install succeeds
    // either way, so the exit code cannot see a dropped `-n`; the marker and
    // the mode can. Without `-n` sudo blocks on a password prompt until
    // `timeout-minutes: 10` kills the step instead of failing fast into the
    // next mode, which silently loses the sudo mode on every class.
    const updated = runUpdate({ sudoers: 'generic', prefixOwner: 'runner' });
    assert.equal(updated.status, 0);
    assert.ok(!updated.stderr.includes('a terminal is required'));
    assert.deepEqual(updated.modes, ['root']);
  });

  it('fails the leg when no mode can write the prefix', () => {
    // No sudo and a root-owned prefix has no working mode: the step must
    // exhaust its retries and fail loudly rather than report success.
    const updated = runUpdate({ sudoers: 'none', prefixOwner: 'root' });
    assert.equal(updated.status, 1);
    assert.deepEqual(updated.modes, ['runner', 'runner', 'runner']);
    assert.ok(updated.stderr.includes('EACCES'));
    assert.ok(
      updated.stdout.includes(
        '::error::npm install of @qwen-code/qwen-code@0.22.3 failed after 3 attempts',
      ),
    );
  });

  it('verifies a healthy install without diagnostics', () => {
    const verified = runVerify({ output: '0.22.3', target: '0.22.3' });
    assert.equal(verified.status, 0);
    assert.ok(verified.stdout.includes('qwen version: 0.22.3'));
    assert.ok(!verified.stdout.includes('--- diagnostics ---'));
  });

  it('ignores stderr noise on a successful --version', () => {
    // The capture is stdout-only: one stderr line during `--version` (a Node
    // runtime warning, a future startup notice) must not fail a healthy
    // install on every pool and file a stale-fleet issue against a correctly
    // updated fleet.
    const verified = runVerify({
      output: '0.22.3',
      stderrOutput: '(node:1234) ExperimentalWarning: some future warning',
      target: '0.22.3',
    });
    assert.equal(verified.status, 0);
    assert.ok(verified.stdout.includes('qwen version: 0.22.3'));
    assert.ok(!verified.stdout.includes('--- diagnostics ---'));
  });

  it('prints the diagnostics when the installed qwen is stale', () => {
    const verified = runVerify({ output: '0.22.2', target: '0.22.3' });
    assert.equal(verified.status, 1);
    assert.ok(verified.stdout.includes('--- diagnostics ---'));
    assert.ok(verified.stdout.includes('--- end diagnostics ---'));
  });

  it('prints the diagnostics when the installed qwen cannot run at all', () => {
    // A crashed install can leave `command -v qwen` resolving to a broken
    // entrypoint whose `--version` exits non-zero; the tolerant capture is
    // what keeps the step failing at the version test with diagnostics
    // instead of dying at the bare assignment under `set -e`.
    const verified = runVerify({ exitCode: 127, target: '0.22.3' });
    assert.equal(verified.status, 1);
    assert.ok(
      verified.stdout.includes(
        'qwen version: (qwen --version failed, exit 127)',
      ),
    );
    assert.ok(verified.stdout.includes('--- diagnostics ---'));
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
