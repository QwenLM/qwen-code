import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
  it('starts sampling before npm ci and preserves those samples for upload', () => {
    const install = step('Install dependencies').run;
    const npmCi = install.indexOf('npm ci');

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
    // a bare > would truncate the install-window samples — and must sit
    // before the collector.
    const dump = lintStep('Dump disk state on failure');
    assert.equal(dump.if, '${{ failure() }}');
    assert.match(dump.run, />> "\$DISK_SAMPLES"/);
    assert.doesNotMatch(dump.run, /[^>]> "\$DISK_SAMPLES"/);
    assert.ok(
      names.indexOf('Dump disk state on failure') <
        names.indexOf('Upload disk-pressure samples'),
    );
  });

  it('keeps install failure status while writing the pre-install sample', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-disk-pressure-'));
    const npm = join(root, 'npm');
    writeFileSync(npm, '#!/usr/bin/env bash\nexit 42\n');
    chmodSync(npm, 0o755);

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
