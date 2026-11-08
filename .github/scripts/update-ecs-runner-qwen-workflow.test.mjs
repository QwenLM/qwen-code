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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

// Three layouts, because the checked-in workflow carries a block-sequence
// `runner:` matrix, while older branches carry the reflowed or single-line
// inline array prettier produces. A parser that reads only one shape finds
// zero pools.
function parsePools(text) {
  const inline = text.match(/\n\s+runner:\s*\[([^\]]*)\]/)?.[1];
  if (inline !== undefined) {
    return inline
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
  }
  const block = text.match(/\n\s+runner:\s*\n((?:\s+- '[^']+'\n)+)/)?.[1];
  if (block !== undefined) {
    return [...block.matchAll(/- '([^']+)'/g)].map((m) => m[1]);
  }
  return [...text.matchAll(/\n\s+- runner:\s*'([^']+)'/g)].map((m) => m[1]);
}

const pools = parsePools(workflow);

// Comment lines carry no behavior: a pin that greps the raw text stays
// green when the real command is commented out (measured on this file's
// first revision). Behavioral pins read the step body with comments gone.
function codeLines(body) {
  return body
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

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
// shape that produced the v0.22.3 incident), the rest healthy. The stale
// set spans BOTH regions so the reporter's pool naming replays on an hz
// leg too, not only on the hk legs.
const firstHz = pools.findIndex((pool) => pool.includes('hz'));
const STALE_POOLS = [...pools.slice(0, 2), pools[firstHz === -1 ? 2 : firstHz]];
const HEALTHY_POOLS = pools.filter((pool) => !STALE_POOLS.includes(pool));
const DEFAULT_JOBS = jobsFixture({
  failed: STALE_POOLS.slice(0, 2),
  timedOut: STALE_POOLS.slice(2),
  succeeded: HEALTHY_POOLS,
});

describe('ECS runner qwen update workflow', () => {
  it('installs without the selected runner npm prefix', () => {
    assert.ok(workflow.includes('cd "${RUNNER_TEMP:?}"'));
    assert.ok(
      workflow.includes('sudo env -u NPM_CONFIG_PREFIX npm install -g'),
    );
  });

  it('pins the install to the /usr/local prefix', () => {
    // Clearing NPM_CONFIG_PREFIX only drops the environment variable; npm's
    // own computed default survives it, and on hk-4 and hk-5 that default is a
    // bundled Node directory rather than /usr/local. The install then succeeds
    // into a tree the runner's PATH never reads, while the verify step keeps
    // checking /usr/local/bin/qwen — which is how those pools served four
    // releases on a stale binary. This flag is the only thing making the
    // target explicit, and it was dropped once before without anything
    // objecting.
    assert.ok(workflow.includes('npm install -g --prefix /usr/local'));
    // The hz hosts also carry a legacy /usr/bin/qwen from their image build;
    // updating only /usr/local left them serving the stale copy (every hz
    // host was on 0.26.0 after 0.27.0 shipped). Both prefixes must update,
    // and verify must pin BOTH absolute paths, not just the PATH winner.
    // Behavioral pins: read the step bodies with comments stripped, so
    // commenting a command out turns these red instead of staying green.
    const update = codeLines(stepBody('Update qwen'));
    // npm exits EEXIST on a /usr/bin/qwen that is a regular file or a
    // foreign-prefix symlink; --force lets npm replace it, but only on a
    // successful install — a failed one leaves the old file untouched.
    // A pre-emptive `rm -f` must NOT come back: it deleted the binary
    // even when all attempts failed, and the next run then snapshotted
    // "no legacy copy", skipped /usr and verified green forever.
    assert.ok(update.includes('npm install -g --force --prefix /usr '));
    assert.ok(
      !update.includes('rm -f /usr/bin/qwen'),
      'the /usr install must never pre-delete the binary it may fail to restore',
    );
    // The second install is gated on the legacy copy having existed when
    // the step STARTED, not on its presence right now.
    assert.ok(
      update.includes('if [ -e /usr/bin/qwen ] || [ -L /usr/bin/qwen ]; then'),
    );
    assert.ok(update.includes('elif [ "${legacy_present}" -eq 0 ]; then'));
    assert.ok(
      !update.includes('[ ! -e /usr/bin/qwen ] && [ ! -L /usr/bin/qwen ]'),
      'the early exit must not read the current state the loop mutates',
    );
    const snapshotIndex = update.indexOf('legacy_present=1');
    const loopIndex = update.indexOf('for attempt in 1 2 3; do');
    assert.ok(snapshotIndex !== -1 && snapshotIndex < loopIndex);
    assert.ok(
      update.includes(
        'echo "LEGACY_PRESENT=${legacy_present}" >> "${GITHUB_ENV}"',
      ),
    );
    const localInstall = update.indexOf('npm install -g --prefix /usr/local');
    const usrInstall = update.indexOf('npm install -g --force --prefix /usr ');
    assert.ok(localInstall !== -1 && usrInstall > localInstall);
    const verify = codeLines(stepBody('Verify version'));
    // A legacy copy present at the start must not silently vanish: the
    // pinned loop below skips missing paths, so without this guard a
    // deleted /usr/bin/qwen would verify green.
    assert.ok(
      verify.includes(
        'if [ "${LEGACY_PRESENT:-0}" -eq 1 ] && [ ! -e /usr/bin/qwen ] && [ ! -L /usr/bin/qwen ]; then',
      ),
    );
    assert.ok(
      verify.includes('for pinned in /usr/local/bin/qwen /usr/bin/qwen'),
    );
    // The loop must actually assert, not just echo: dropping the test line
    // while keeping the loop was a green mutation on the first revision.
    const loopBody = verify.slice(verify.indexOf('for pinned in'));
    // -e || -L: the same definition of "exists" the update step uses, so a
    // dangling /usr/bin/qwen fails the pin instead of skipping it.
    assert.ok(loopBody.includes('if [ -e "${pinned}" ] || [ -L "${pinned}" ]'));
    assert.ok(loopBody.includes('test "${pinned_actual}" = "${VERSION}"'));
  });

  it('routes every leg by a dedicated per-host label, never a runner name', () => {
    // GitHub schedules jobs by runner LABEL only. A runs-on entry that is
    // a runner NAME queues forever, the leg is cancelled after 24 h, and
    // the reporter deliberately ignores `cancelled` — the exact silent
    // stale pool this workflow exists to prevent.
    for (const pool of pools) {
      assert.match(pool, /^ecs-update-(hk|hz)-\d+$/);
    }
    // hz4 and hz5 have no persistent runner — every machine there is an
    // ephemeral container runner whose image already carries the CLI, so
    // there is nothing to update and no runner to hang the label on. The
    // other four hz hosts each get a leg.
    for (const host of [1, 2, 3, 6]) {
      assert.ok(pools.includes(`ecs-update-hz-${host}`));
    }
    for (const host of [4, 5]) {
      assert.ok(
        !pools.some((pool) => pool.includes(`hz-${host}`)),
        `ecs-update-hz-${host} has no runner carrying that label`,
      );
    }
    // Name every hk leg too: the shape check above accepts any digit string,
    // so renaming one of them (and its actionlint declaration together) used
    // to survive the whole suite while the leg queued forever.
    for (const host of [1, 2, 3, 4, 5]) {
      assert.ok(
        pools.includes(`ecs-update-hk-${host}`),
        `ecs-update-hk-${host} lost its leg`,
      );
    }
    // Counted last on purpose: a re-added leg should fail on the host that has
    // no runner, not on an opaque length mismatch.
    assert.equal(
      pools.length,
      9,
      'five hk legs plus the four hz hosts that have a persistent runner',
    );
    // Static runs-on: actionlint can only check labels it can see, and an
    // expression-built label array hides typos from it.
    assert.ok(
      workflow.includes(
        "    runs-on: ['self-hosted', 'linux', '${{ matrix.runner }}']",
      ),
    );
    // Every matrix label must be declared for actionlint.
    const actionlint = readFileSync('.github/actionlint.yaml', 'utf8');
    for (const pool of pools) {
      assert.ok(
        actionlint.includes(`- '${pool}'`),
        `${pool} missing from .github/actionlint.yaml`,
      );
    }
  });

  it('pins the 90-minute resolve budget', () => {
    const resolveJob = workflow.slice(
      workflow.indexOf('  resolve:'),
      workflow.indexOf('  update:'),
    );
    assert.ok(resolveJob.includes('timeout-minutes: 100'));
    assert.ok(resolveJob.includes("RESOLVE_TIMEOUT_SECONDS: '5400'"));
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
    assert.ok(
      workflow.includes(
        'sudo rm -rf /usr/local/lib/node_modules/@qwen-code/.qwen-code-* /usr/lib/node_modules/@qwen-code/.qwen-code-*',
      ),
    );
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

// Runs the 'Update qwen' step body against stubbed `sudo`/`npm`, with the
// absolute prefixes relocated into a temp root. `usrInstallFailures` makes
// the /usr install fail its first N invocations — the transient registry
// hiccup the retry loop exists for. The stub npm creates the prefix's
// bin/qwen on success, so "the loop deleted it and never restored it" is
// observable instead of inferred.
function runUpdate({
  legacyCopy = true,
  danglingLegacy = false,
  usrInstallFailures = 0,
  keepDir = false,
  legacyPresentOverride,
  staleLegacyAfterUpdate = false,
  root: existingRoot,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-install-'));
  try {
    // An existingRoot replays a SECOND run on the tree the first run left
    // behind — the cross-run failure the per-run snapshot cannot see.
    const root = existingRoot ?? join(dir, 'root');
    if (!existingRoot) {
      for (const prefix of ['usr/local/bin', 'usr/bin', 'usr/lib']) {
        mkdirSync(join(root, prefix), { recursive: true });
      }
      if (legacyCopy) {
        writeFileSync(join(root, 'usr/bin/qwen'), '#!/bin/sh\necho 0.26.0\n', {
          mode: 0o755,
        });
      } else if (danglingLegacy) {
        symlinkSync(join(root, 'nonexistent/qwen'), join(root, 'usr/bin/qwen'));
      }
    }
    const counter = join(dir, 'usr-attempts');
    const calls = join(dir, 'npm-calls');
    const sudoStub = join(dir, 'sudo');
    writeFileSync(sudoStub, '#!/usr/bin/env bash\nexec "$@"\n', {
      mode: 0o755,
    });
    const npmStub = join(dir, 'npm');
    writeFileSync(
      npmStub,
      [
        '#!/usr/bin/env bash',
        `echo "npm $*" >> ${calls}`,
        'prefix=""',
        'force=0',
        // Capture --force before the parse loop consumes the arguments.
        'if [[ " $* " == *" --force "* ]]; then force=1; fi',
        'while [[ $# -gt 0 ]]; do',
        '  if [[ "$1" == "--prefix" ]]; then prefix="$2"; shift 2; else shift; fi',
        'done',
        // Real npm (measured on 11.16.0) refuses to replace a foreign
        // /usr/bin/qwen without --force and leaves it untouched on any
        // failure with --force. The stub mirrors both, so a regression
        // back to pre-deletion + plain install is observable here.
        // The stub root relocates /usr to <root>/usr; match the basename
        // so the /usr arm is distinguishable from /usr/local.
        'if [[ "$(basename "${prefix}")" == "usr" ]]; then',
        `  attempt=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 ))`,
        `  echo "$attempt" > ${counter}`,
        `  if (( attempt <= ${usrInstallFailures} )); then`,
        '    echo "npm error code ENOTEMPTY" >&2',
        '    exit 1',
        '  fi',
        '  if [[ -e "${prefix}/bin/qwen" || -L "${prefix}/bin/qwen" ]] && (( force == 0 )); then',
        '    echo "npm error EEXIST: file exists, use --force to overwrite" >&2',
        '    exit 1',
        '  fi',
        'fi',
        'mkdir -p "${prefix}/bin"',
        // npm unlinks a foreign bin (regular file or symlink, dangling or
        // not) before linking its own — but only once the install has
        // succeeded, which is where this stub now sits.
        'if (( force == 1 )); then rm -f "${prefix}/bin/qwen"; fi',
        `printf '#!/bin/sh\\necho 0.27.0\\n' > "\${prefix}/bin/qwen"`,
        'chmod +x "${prefix}/bin/qwen"',
      ].join('\n'),
      { mode: 0o755 },
    );
    const ghEnv = join(dir, 'github-env');
    writeFileSync(ghEnv, '');
    // Relocate via variables assigned from rewritten literals, so the bare
    // `--prefix /usr` argument (no /usr/... path suffix) is covered too —
    // a plain path replaceAll misses it and the stub would target the real
    // /usr.
    const body = [
      `LOCAL_PREFIX=${join(root, 'usr/local')}`,
      `USR_PREFIX=${join(root, 'usr')}`,
      `USR_BIN=${join(root, 'usr/bin')}`,
      stepBody('Update qwen')
        .replaceAll('/usr/local/lib', '"${LOCAL_PREFIX}/lib"')
        .replaceAll('/usr/lib', '"${USR_PREFIX}/lib"')
        .replaceAll('/usr/local/bin', '"${LOCAL_PREFIX}/bin"')
        .replaceAll('/usr/bin/qwen', '"${USR_BIN}/qwen"')
        // The lookahead keeps the /usr/local arm from matching the /usr
        // prefix (it also starts with "/usr").
        .replaceAll(/--prefix \/usr\/local/g, '--prefix "${LOCAL_PREFIX}"')
        .replaceAll(/--prefix \/usr(?= )/g, '--prefix "${USR_PREFIX}"')
        // Keep the retry wall-clock negligible; the loop shape unchanged.
        .replace('sleep $((attempt * 10))', 'sleep 0'),
    ].join('\n');
    const script = join(dir, 'update.sh');
    writeFileSync(script, body);
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: dir,
        GITHUB_ENV: ghEnv,
        VERSION: '0.27.0',
      },
    });
    // Failure-direction fixtures: mutate the tree the update left behind
    // so verify runs against a stale or vanished second copy.
    if (staleLegacyAfterUpdate) {
      rmSync(join(root, 'usr/bin/qwen'), { force: true });
      writeFileSync(join(root, 'usr/bin/qwen'), '#!/bin/sh\necho 0.26.0\n', {
        mode: 0o755,
      });
    }
    const legacyPresent =
      legacyPresentOverride ??
      (readFileSync(ghEnv, 'utf8').includes('LEGACY_PRESENT=1') ? '1' : '0');
    // The verify step against the same tree, with a `qwen` stub on PATH so
    // the PATH-winner check runs; the pinned paths are the real assertion.
    const qwenStub = join(dir, 'qwen');
    writeFileSync(qwenStub, '#!/bin/sh\necho 0.27.0\n', { mode: 0o755 });
    const verifyBody = stepBody('Verify version')
      .replaceAll('/usr/local/bin', join(root, 'usr/local/bin'))
      .replaceAll('/usr/bin/qwen', join(root, 'usr/bin/qwen'));
    const verifyScript = join(dir, 'verify.sh');
    writeFileSync(verifyScript, verifyBody);
    const verifyResult = spawnSync('bash', [verifyScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        VERSION: '0.27.0',
        LEGACY_PRESENT: legacyPresent,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ghEnv: readFileSync(ghEnv, 'utf8'),
      npmCalls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      usrQwenExists: existsSync(join(root, 'usr/bin/qwen')),
      usrQwenVersion: existsSync(join(root, 'usr/bin/qwen'))
        ? spawnSync(join(root, 'usr/bin/qwen'), [], {
            encoding: 'utf8',
          }).stdout?.trim()
        : undefined,
      localQwenExists: existsSync(join(root, 'usr/local/bin/qwen')),
      verifyStatus: verifyResult.status,
      verifyStdout: verifyResult.stdout ?? '',
      root,
      dir,
    };
  } finally {
    if (!keepDir) {
      rmSync(dir, { recursive: true, force: true });
    }
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
  it('keeps a legacy host on the retry loop after a transient /usr failure', () => {
    // The bug this pins: attempt 1 removed /usr/bin/qwen, then the /usr
    // install failed transiently. A current-state early exit saw "no
    // legacy copy" on attempt 2 and exited 0 — binary deleted, job green,
    // every later run repeating the same silent skip.
    const updated = runUpdate({ legacyCopy: true, usrInstallFailures: 1 });
    assert.equal(updated.status, 0);
    assert.ok(updated.usrQwenExists, '/usr/bin/qwen must be restored');
    assert.ok(updated.localQwenExists);
    assert.ok(updated.ghEnv.includes('LEGACY_PRESENT=1'));
    assert.ok(updated.stdout.includes('attempt 1 failed; retrying'));
    const usrInstalls = updated.npmCalls
      .split('\n')
      .filter((line) => /--prefix \S*\/usr /.test(line));
    assert.equal(usrInstalls.length, 2, 'the /usr install must be retried');
    assert.equal(updated.verifyStatus, 0, 'both pinned paths verify green');
  });

  it('fails the leg instead of reporting success when /usr never recovers', () => {
    const updated = runUpdate({ legacyCopy: true, usrInstallFailures: 99 });
    assert.equal(updated.status, 1);
    // The failed install must leave the OLD binary in place: deleting it
    // here is what let the next run snapshot "no legacy copy" and verify
    // green forever (the cross-run half of the stale-second-copy bug).
    assert.ok(updated.usrQwenExists, 'a failed /usr install must not delete');
    assert.equal(updated.usrQwenVersion, '0.26.0');
    assert.ok(updated.localQwenExists, 'one working CLI survives a failed leg');
    assert.ok(updated.stdout.includes('failed after 3 attempts'));
    // A verify against this failed tree must stay red, not skip.
    assert.notEqual(updated.verifyStatus, 0);
  });

  it('recovers the legacy copy on the run after a persistent failure', () => {
    // Cross-run replay on ONE host tree: run 1 exhausts its /usr attempts
    // and fails loudly; run 2 (no failures) must still see the legacy
    // copy, reinstall BOTH prefixes and verify green. Under the old
    // pre-deletion shape run 2 snapshotted "no legacy copy", skipped /usr
    // and reported success with /usr/bin/qwen gone for good.
    const first = runUpdate({
      legacyCopy: true,
      usrInstallFailures: 99,
      keepDir: true,
    });
    try {
      assert.equal(first.status, 1);
      assert.ok(first.usrQwenExists);
      assert.equal(first.usrQwenVersion, '0.26.0');
      const second = runUpdate({ root: first.root, usrInstallFailures: 0 });
      assert.equal(second.status, 0);
      assert.ok(second.ghEnv.includes('LEGACY_PRESENT=1'));
      assert.equal(second.usrQwenVersion, '0.27.0');
      assert.equal(second.verifyStatus, 0);
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
    }
  });

  it('verify fails on a stale second copy even when the PATH winner is current', () => {
    // Failure-direction pin: the incident shape (fresh /usr/local, stale
    // /usr/bin) must exit non-zero. A `test … || true` mutation on the
    // pinned check used to survive the whole suite.
    const updated = runUpdate({
      legacyCopy: true,
      staleLegacyAfterUpdate: true,
    });
    assert.equal(updated.status, 0);
    assert.notEqual(updated.verifyStatus, 0, 'a stale pinned copy must fail');
  });

  it('verify fails when a legacy copy vanished instead of skipping it', () => {
    // Failure-direction pin: LEGACY_PRESENT=1 with no /usr/bin/qwen must
    // exit non-zero. Disabling the guard (`exit 1` → `:`) used to survive
    // the whole suite while every later run skipped the missing path.
    const updated = runUpdate({
      legacyCopy: false,
      legacyPresentOverride: '1',
    });
    assert.equal(updated.status, 0);
    assert.notEqual(
      updated.verifyStatus,
      0,
      'a vanished legacy copy must fail',
    );
    assert.ok(
      updated.verifyStdout.includes(
        '/usr/bin/qwen existed before the update but is missing now',
      ),
    );
  });

  it('skips the second prefix entirely on a host without a legacy copy', () => {
    const updated = runUpdate({ legacyCopy: false });
    assert.equal(updated.status, 0);
    assert.ok(updated.localQwenExists);
    assert.ok(!updated.usrQwenExists, 'hk hosts must not grow a second tree');
    assert.ok(updated.ghEnv.includes('LEGACY_PRESENT=0'));
    assert.ok(!/--prefix \S*\/usr /.test(updated.npmCalls));
    assert.equal(updated.verifyStatus, 0);
  });

  it('updates through a dangling legacy symlink instead of skipping it', () => {
    // -e alone would report "no legacy copy" for a dangling symlink and
    // leave it dangling forever; the snapshot uses -e || -L.
    const updated = runUpdate({ legacyCopy: false, danglingLegacy: true });
    assert.equal(updated.status, 0);
    assert.ok(updated.ghEnv.includes('LEGACY_PRESENT=1'));
    assert.ok(updated.usrQwenExists, 'the dangling symlink is replaced');
    assert.equal(updated.verifyStatus, 0);
  });

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
