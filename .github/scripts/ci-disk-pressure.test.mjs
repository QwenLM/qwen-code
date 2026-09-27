import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'ci.yml',
);
const ciJobs = parse(readFileSync(workflowPath, 'utf8')).jobs;
const testSteps = ciJobs.test.steps;

function step(name) {
  const value = testSteps.find((candidate) => candidate.name === name);
  assert.ok(value, `missing ${name} step`);
  return value;
}

// lint_and_static duplicates the sampling install step; it must also carry
// its own failure()-gated collector, or the lane produces the #10035
// telemetry and destroys it with the runner temp dir on the exact ENOSPC
// death the sampler exists to explain.
function lintStep(name) {
  const value = ciJobs.lint_and_static.steps.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(value, `missing ${name} step in lint_and_static`);
  return value;
}

describe('ci.yml disk-pressure evidence', () => {
  it('starts sampling before the install and preserves those samples for upload', () => {
    const install = step('Install dependencies').run;
    const npmCi = install.indexOf('pnpm install');
    assert.ok(npmCi !== -1, 'the install step must run pnpm install');

    assert.match(
      install,
      /DISK_SAMPLES="\$\{RUNNER_TEMP\}\/disk-pressure-samples\.log"/,
    );
    assert.ok(npmCi > install.indexOf('DFSAMPLE '));
    assert.match(install, /\( while sleep 10; do sample_disk; done \) &/);
    assert.ok(npmCi > install.indexOf('( while sleep 10'));
    assert.match(install, /trap .*SAMPLER_PID.* EXIT/);

    const tests = step('Run tests and generate reports').run;
    assert.match(
      tests,
      /DISK_SAMPLES="\$\{RUNNER_TEMP\}\/disk-pressure-samples\.log"\nif \[ ! -s "\$DISK_SAMPLES" \]; then\n {2}echo "DISKCONTEXT .*" > "\$DISK_SAMPLES" 2>\/dev\/null \|\| true\nfi/,
    );
    assert.ok(tests.indexOf('export TMPDIR=') > tests.indexOf('DISK_SAMPLES='));

    // The samples carry host occupancy, not just this job's disk. A shard of
    // identical work measures 6.7min or 36min on this fleet depending only on
    // which host it lands on (#10490), and nothing in the logs said how busy
    // that host was. `cpus` sizes the machine, `load` shows the pressure, and
    // `hosttests` counts how many vitest processes were running on the host
    // at each 10-second tick — this job's own vitest tree included, not only
    // neighbours. The pattern is bracketed so the sampler's own shell — whose
    // command line contains this very script — does not match itself and
    // inflate the count on every runner; the job's own test tree has `vitest`
    // in its command line, so its churn is part of the measured occupancy.
    assert.match(tests, /echo "DISKCONTEXT [^"]*cpus\[\$\(nproc /);
    assert.match(tests, /load\[\$\(cut -d' ' -f1-3 \/proc\/loadavg /);
    // Capture-then-default, not `$(pgrep ... || echo 0)`: procps pgrep
    // prints 0 AND exits 1 on zero matches, so the double fallback
    // captures "0\n0" and splits the record after `hosttests[0`,
    // orphaning the disk fields on a continuation line. The `:-unknown`
    // default labels lanes without pgrep (Windows Git-Bash) instead of
    // fabricating a measured zero — the honest sentinel `cpus[...]`
    // uses one field over.
    assert.match(
      tests,
      /hosttests=\$\(pgrep -fc '\[v\]itest' 2>\/dev\/null \|\| true\)/,
    );
    assert.match(tests, /hosttests\[\$\{hosttests:-unknown\}\]/);

    // test_macos and test_windows inline the same sampler (plain echo, no
    // DISK_SAMPLES append), and no equality pin reaches them: the cross-leg
    // byte-identity in no-ak-integration-ci.test.js stops at the `( while
    // true` sentinel by design. Pin the sampler expression per leg, or an
    // edit that only touches the pinned test-job copy ships green while
    // these nightly-only lanes silently drop `load`/`hosttests`.
    for (const jobName of ['test_macos', 'test_windows']) {
      const leg = ciJobs[jobName].steps.find(
        (candidate) => candidate.name === 'Run tests and generate reports',
      );
      assert.ok(leg, `missing run-tests step in ${jobName}`);
      assert.match(leg.run, /load\[\$\(cut -d' ' -f1-3 \/proc\/loadavg /);
      assert.match(
        leg.run,
        /hosttests=\$\(pgrep -fc '\[v\]itest' 2>\/dev\/null \|\| true\)/,
      );
      assert.match(leg.run, /hosttests\[\$\{hosttests:-unknown\}\]/);
    }

    const sampleFormat = (script) => {
      const match = script.match(
        /sample="DFSAMPLE .*\/proc\/meminfo 2>\/dev\/null(?: \|\| true)?\)\]"/,
      );
      assert.ok(match);
      return match[0]
        .replaceAll('${RUNNER_TEMP:-/tmp}', '${TMPDIR}')
        .replace(
          ' /proc/meminfo 2>/dev/null || true)]',
          ' /proc/meminfo 2>/dev/null)]',
        );
    };
    const headerLine = (script) =>
      script
        .split('\n')
        .find((line) => line.trimStart().startsWith('echo "DISKCONTEXT '))
        ?.trim();
    assert.equal(headerLine(install), headerLine(tests));
    assert.equal(sampleFormat(install), sampleFormat(tests));

    const upload = step('Upload disk-pressure samples');
    assert.equal(upload.if, '${{ failure() }}');
    assert.equal(upload.with['if-no-files-found'], 'ignore');
    assert.equal(
      upload.with.path,
      '${{ runner.temp }}/disk-pressure-samples.log',
    );
  });

  it('gives lint_and_static the same sampler and its own collector', () => {
    // The install step is pinned byte-identical to test's by
    // ci-platform-lanes.test.js's shared-prelude equality; what that pin
    // cannot see is the collector, which deliberately diverges by artifact
    // name (upload-artifact v4+ rejects duplicate names when both jobs fail
    // in one run). Pin the collector's contract here.
    const install = lintStep('Install dependencies').run;
    assert.match(
      install,
      /DISK_SAMPLES="\$\{RUNNER_TEMP\}\/disk-pressure-samples\.log"/,
    );
    const upload = lintStep('Upload disk-pressure samples');
    assert.equal(upload.if, '${{ failure() }}');
    assert.equal(upload.with['if-no-files-found'], 'ignore');
    assert.equal(
      upload.with.path,
      '${{ runner.temp }}/disk-pressure-samples.log',
    );
    assert.notEqual(
      upload.with.name,
      step('Upload disk-pressure samples').with.name,
      'artifact names must differ or the second failing job cannot upload',
    );

    // Position is the collector's contract: failure() is evaluated when the
    // step is reached and never revisited, so a collector parked just after
    // install has already been passed (and skipped — nothing yet failed) by
    // the time any lint/static step can die. It must be the job's last step.
    const names = ciJobs.lint_and_static.steps.map((s) => s.name);
    assert.equal(
      names.indexOf('Upload disk-pressure samples'),
      names.length - 1,
      'the collector must be the last step of lint_and_static',
    );
    assert.ok(
      names.indexOf('Upload disk-pressure samples') >
        names.indexOf('Run .github/scripts helper tests'),
    );

    // The install sampler dies with that step's trap … EXIT, so the 19
    // substantive steps after it write no samples; the failure-gated dump
    // is what puts state-at-failure into the artifact. It must APPEND —
    // a bare > would truncate the install-window samples — must sit
    // before the collector, and must mirror to the job log, because the
    // file it appends to is the one whose writability is under
    // investigation. `tee -a` carries all three; the executed case below
    // is what proves the mirroring actually survives a failed write.
    const dump = lintStep('Dump disk state on failure');
    assert.equal(dump.if, '${{ failure() }}');
    assert.match(dump.run, /tee -a "\$DISK_SAMPLES"/);
    assert.doesNotMatch(dump.run, /[^>]> "\$DISK_SAMPLES"/);
    assert.ok(
      names.indexOf('Dump disk state on failure') <
        names.indexOf('Upload disk-pressure samples'),
    );
  });

  it('keeps the failure dump in the job log when the samples file is unwritable', () => {
    // The dump exists to explain an ENOSPC death, so it cannot depend on the
    // filesystem being writable: redirected straight into the samples file, a
    // failed write loses the dump and its own diagnostic together and the step
    // still exits 0, leaving oncall unable to tell "dumped, nothing
    // interesting" from "could not write". Occupy the target path with a
    // directory so tee's append fails the way a full disk would.
    const root = mkdtempSync(join(tmpdir(), 'ci-disk-pressure-'));
    mkdirSync(join(root, 'disk-pressure-samples.log'));

    try {
      const result = spawnSync(
        'bash',
        [
          '-e',
          '-o',
          'pipefail',
          '-c',
          lintStep('Dump disk state on failure').run,
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, RUNNER_TEMP: root },
        },
      );

      assert.equal(result.error, undefined);
      // `|| true` keeps a failed dump from failing the job it is diagnosing.
      assert.equal(
        result.status,
        0,
        `signal: ${result.signal}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      // The data survives in the job log even though the file write failed.
      assert.match(result.stdout, /^DISKCONTEXT failure-dump /m);
      // And tee's reason is not swallowed by the block's own 2>/dev/null,
      // which redirects the brace group only.
      assert.ok(
        result.stderr.length > 0,
        `tee's write failure reached neither the file nor the log\nstdout: ${result.stdout}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps install failure status while writing the pre-install sample', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-disk-pressure-'));
    // The install step runs `corepack pnpm install`; stub corepack so the
    // failing exit comes from the install command itself.
    const corepack = join(root, 'corepack');
    writeFileSync(corepack, '#!/usr/bin/env bash\nexit 42\n');
    chmodSync(corepack, 0o755);

    try {
      const result = spawnSync(
        'bash',
        ['-e', '-o', 'pipefail', '-c', step('Install dependencies').run],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            RUNNER_TEMP: root,
          },
        },
      );

      assert.equal(result.error, undefined);
      assert.equal(
        result.status,
        42,
        `signal: ${result.signal}\nerror: ${result.error}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      const samples = readFileSync(
        join(root, 'disk-pressure-samples.log'),
        'utf8',
      );
      assert.match(samples, /^DISKCONTEXT /m);
      assert.match(samples, /^DFSAMPLE /m);
      // Every record must fit exactly one physical line: with zero vitest
      // matches pgrep prints 0 AND exits 1, so a `|| echo 0` fallback
      // would capture "0\n0" and split the record after hosttests[0] —
      // space/inodes/memavail would land on an orphan continuation line
      // that line-oriented (^DFSAMPLE) triage of the artifact loses, for
      // exactly the install window this sampler exists to cover.
      const lines = samples.split('\n').filter((line) => line !== '');
      for (const line of lines) {
        assert.match(line, /^(DISKCONTEXT|DFSAMPLE) /);
      }
      for (const line of lines.filter((l) => l.startsWith('DFSAMPLE '))) {
        assert.match(
          line,
          /^DFSAMPLE \S+ tmpdir\[[^\]]*\] load\[[^\]]*\] hosttests\[[^\]]+\] space\[/,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ci.yml helper-tests retry', () => {
  // #12772 retries the battery once against pool contention. The shape
  // assertions in scripts/tests/ci-platform-lanes.test.js cannot observe
  // the two shell mechanics the retry stands on, so these replay the
  // extracted run block against a stub `node` that counts invocations:
  // pipefail must come from the block itself, and a failed tee write must
  // never drive control flow.
  const helperRetryRun = lintStep(
    'Run .github/scripts helper tests',
  ).run.replaceAll('${{ env.HELPER_TESTS }}', 'stub-battery');

  function replay(shellArgs, stubBody, occupyLogPath) {
    const root = mkdtempSync(join(tmpdir(), 'ci-helper-retry-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const node = join(bin, 'node');
    writeFileSync(node, `#!/usr/bin/env bash\n${stubBody}\n`);
    chmodSync(node, 0o755);
    // A directory at the log path fails tee's write the way a full disk
    // would — and, unlike a chmod 555, keeps failing under the root-run
    // ECS lanes.
    if (occupyLogPath) {
      mkdirSync(join(root, 'helper-attempt1.log'));
    }
    try {
      const result = spawnSync('bash', [...shellArgs, '-c', helperRetryRun], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: root,
        },
      });
      assert.equal(result.error, undefined);
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        runs: (result.stdout.match(/^STUB-NODE-RUN$/gm) ?? []).length,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('fails without ambient pipefail when the battery fails', () => {
    // Replay under a bare `bash -e` — what the step gets if the
    // workflow-level defaults.run.shell is ever dropped or narrowed. The
    // block's own `set -o pipefail` is then the only thing carrying node's
    // status through the tee pipe; without it tee's 0 masks the failure,
    // the `||` arm never runs, and the lane goes green on a real break.
    const result = replay(['-e'], 'echo STUB-NODE-RUN\nexit 1', false);
    assert.notEqual(
      result.status,
      0,
      `a failing battery must fail the step\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.equal(result.runs, 2, 'the retry must re-run the battery once');
  });

  it('never lets a failed attempt-1 log write drive the retry', () => {
    // tee fails while the battery passes. An unguarded pipefail pipeline
    // reads tee's failure as the battery's: a spurious serial re-run on a
    // host that just reported a write failure, then — when the retry
    // passes — an absorbed-flake ::warning:: naming NOTHING, polluting the
    // #12772 recurrence count with a disk event. The step must stay green,
    // run the battery exactly once, and emit no warning.
    const result = replay(
      ['-e', '-o', 'pipefail'],
      'echo STUB-NODE-RUN\nexit 0',
      true,
    );
    assert.equal(
      result.status,
      0,
      `signal/status must stay green\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.equal(result.runs, 1);
    assert.doesNotMatch(result.stdout, /::warning::/);
    // tee's own diagnostic stays on stderr, as the dump step's documents.
    assert.match(result.stderr, /tee:/);
  });

  it('says when the attempt-1 log yields no failure names', () => {
    // A killed or harness-dead attempt 1 leaves a log without `^not ok`
    // lines; the absorbed-flake warning must say the capture came up empty
    // instead of asserting a suite flake with a blank list — the warning
    // feeds a human-maintained recurrence count.
    const result = replay(
      ['-e', '-o', 'pipefail'],
      'echo STUB-NODE-RUN\nif [ -f "$RUNNER_TEMP/attempt1" ]; then exit 0; fi\ntouch "$RUNNER_TEMP/attempt1"\necho "harness crash"\nexit 1',
      false,
    );
    assert.equal(
      result.status,
      0,
      `an absorbed flake must stay green\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.equal(result.runs, 2);
    assert.match(
      result.stdout,
      /::warning::.*no failing test lines captured in the attempt-1 log/,
    );
  });
});
