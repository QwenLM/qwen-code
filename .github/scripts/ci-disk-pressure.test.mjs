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

  it('pins the infra-flake gate that reads the tee capture', () => {
    const runTests = step('Run tests and generate reports');
    const tests = runTests.run;

    // PIPESTATUS is reset by any statement between the pipeline and the
    // capture, so adjacency is the property: inserting one line there leaves
    // RC=0 and the required Test check goes green on any workspaces failure,
    // with no other pin in the repo noticing. Comments are allowed on either
    // side of the capture; a statement is not.
    assert.match(
      tests,
      /\| tee "\$WORKSPACES_LOG"\n(?:#[^\n]*\n)*RC=\$\{PIPESTATUS\[0\]\} TEE_RC=\$\{PIPESTATUS\[1\]\}\n(?:#[^\n]*\n)*if /,
    );

    // tee's own status must gate the verdict: a sink that hit a write error on
    // this TMPDIR leaves a truncated capture, and "no FAIL line" measured over
    // a prefix of the run is not evidence. The switch is compared against '1'
    // rather than '!= 0' so an operator's 'off' or a typo disables the
    // tolerance instead of silently leaving it on.
    //
    // The producer side of the same truncation: RC is compared against 1 —
    // npm's "a workspace lifecycle script failed" — rather than non-zero, so a
    // top-level npm or cross-env wrapper OOM-killed (137) or heap-aborted (134)
    // skips the classifier instead of certifying the prefix of the walk it
    // managed to print. Widening this back to `-ne 0` is the mutation.
    assert.match(
      tests,
      /if \[ "\$RC" -eq 1 \] && \[ "\$TEE_RC" -eq 0 \] && \[ "\$\{QWEN_CI_TOLERATE_RPC_TIMEOUT:-1\}" = '1' \]; then\n {2}node \.github\/scripts\/ci\/classify-infra-flake\.mjs/,
    );
    assert.ok(
      !tests.includes('[ "$RC" -ne 0 ] && [ "$TEE_RC" -eq 0 ]'),
      'the classifier gate must not run on a producer that died by signal',
    );

    // The tokens that make the tolerance *conditional*, which the match above
    // stops short of: `&& RC=0` is the only thing keeping a refused verdict
    // red, and `--log "$WORKSPACES_LOG"` is what binds that verdict to the
    // capture the tee gate just validated. Three mutations survive a pin that
    // ends at the script name — `&& RC=0` becoming `; RC=0`, an unconditional
    // `RC=0`, and `--log /dev/null` — and two of them green the required Test
    // check on every workspaces failure, real assertion failures included. The
    // argument list is matched around, not literally, so adding a harmless flag
    // does not red this.
    assert.match(
      tests,
      /node \.github\/scripts\/ci\/classify-infra-flake\.mjs[^\n]*--log "\$WORKSPACES_LOG"[^\n]*&& RC=0\n/,
    );
    // Counted, not only matched: `RC=0` unconditional, or hoisted past the
    // `fi`, leaves the line above intact while making the tolerance
    // unconditional — which is the false green this whole `it` exists to
    // prevent. One assignment, inside the guard, is the contract.
    assert.equal(
      tests.match(/\bRC=0\b/g)?.length,
      1,
      'RC=0 must be assigned only by the classifier line inside the gate',
    );

    // Executed, because the adjacency match above pins text and this pins what
    // that text yields: bash resets PIPESTATUS on the next command, so both
    // statuses have to be captured in ONE statement. The statement is taken
    // from the workflow itself, so a rewrite that keeps its shape but loses a
    // status (`RC=$?`, or the two-statement form) reds here rather than only
    // in a lane. Mirrors the PIPESTATUS probe in
    // scripts/tests/qwen-triage-workflow.test.js.
    const capture = tests
      .split('\n')
      .find((line) => line.startsWith('RC=${PIPESTATUS[0]}'));
    assert.ok(capture, 'the one-statement PIPESTATUS capture is gone');
    const probe = spawnSync(
      'bash',
      [
        '-c',
        `(exit 3) | tee /dev/null\n${capture}\necho "RC=$RC TEE_RC=$TEE_RC"`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), 'RC=3 TEE_RC=0');

    // The gate being false is a third outcome, and the only one that emits
    // nothing: a refusal writes its reason, a tolerance writes its warning, and
    // GitHub never echoes a step `env:` value. Without this branch a red step
    // whose producer died by signal — or whose switch an operator turned off —
    // is indistinguishable in the log from a classifier that looked and refused.
    assert.match(
      tests,
      /elif \[ "\$RC" -ne 0 \]; then\n(?: {2}#[^\n]*\n)* {2}echo "::notice::infra-flake classifier skipped[^\n]*RC=\$RC TEE_RC=\$TEE_RC tolerate='\$\{QWEN_CI_TOLERATE_RPC_TIMEOUT:-1\}'"\nfi/,
    );

    // The reader's `:-1` default keeps the tolerance on if this binding is
    // dropped or renamed, so pin the binding beside the shell comparison.
    assert.equal(
      runTests.env['QWEN_CI_TOLERATE_RPC_TIMEOUT'],
      "${{ vars.QWEN_CI_TOLERATE_RPC_TIMEOUT || '1' }}",
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
