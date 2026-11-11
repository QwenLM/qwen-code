import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-host-load.sh', import.meta.url));

// The gate reads two host facts, /proc/loadavg and nproc, and neither has a
// deterministic real-host trigger. nproc comes from PATH; /proc/loadavg is an
// absolute path no PATH can shadow, so the script's own reads are pinned
// through a copy that points at a fixture file. Copying, not editing: the copy
// is byte-identical but for the path, so a change to the gate's logic still
// reaches every case here.
function runGate({ loadavg, cpus = '64', env = {}, script } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-load-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(
      join(bin, 'nproc'),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${cpus}'\n`,
      { mode: 0o755 },
    );
    const loadFile = join(dir, 'loadavg');
    writeFileSync(loadFile, loadavg ?? '10.00 12.00 11.00 1/900 12345\n');
    const source = (
      script ?? spawnSync('cat', [SCRIPT], { encoding: 'utf8' }).stdout
    ).replaceAll('/proc/loadavg', loadFile);
    const copy = join(dir, 'gate.sh');
    writeFileSync(copy, source);
    return spawnSync('bash', [copy], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_NAME: 'ecs-qwen-hk1-9',
        GITHUB_RUN_ID: '43018456551',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'test',
        // The wait exists for the real pool; a test that exercises it says so.
        HOST_LOAD_WAIT_SECONDS: '1',
        ...env,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function samples(stdout) {
  return stdout.split('\n').filter((line) => line.startsWith('HOSTLOAD '));
}

describe('check-host-load', () => {
  it('admits a host below the ceiling and emits a tagged sample', () => {
    // The measured shape of a host that passed its suites: hk3-28 at load 43
    // on 64 CPUs (run 43025091256, shard 1).
    const result = runGate({ loadavg: '38.00 40.00 41.00 1/900 1\n' });

    assert.equal(result.status, 0, result.stderr);
    const sample = samples(result.stdout)[0];
    assert.match(sample, /runner\[ecs-qwen-hk1-9\]/);
    assert.match(sample, /run\[43018456551\/1\]/);
    assert.match(sample, /job\[test\]/);
    assert.match(sample, /cpus\[64\]/);
    assert.match(sample, /load\[38\.00 40\.00 41\.00\]/);
    assert.match(sample, /ratio\[0\.62\]/);
    assert.match(sample, /max_ratio\[2\.0\]/);
  });

  it('refuses a host above every reading a passing shard survived', () => {
    // Load 140 on 64 CPUs is above the 1.54 peak of every failing shard and
    // the 1.49 peak of every passing one, so no measured host is refused for
    // being merely busy.
    const result = runGate({
      loadavg: '145.00 140.00 130.00 1/900 1\n',
      env: { HOST_LOAD_MAX_WAIT_TRIES: '1' },
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::Host load gate breached/);
    // The message has to say what to do: only a re-run moves the job.
    assert.match(result.stdout, /re-run the job/);
    assert.match(result.stdout, /ratio 2\.19/);
  });

  it('admits the measured RPC-timeout hosts instead of guessing at them', () => {
    // The gate is a backstop, not a predictor. Every shard that failed on the
    // worker RPC timeout sat between 0.85 and 1.54 load per CPU, and a shard
    // that PASSED reached 1.49 — the bands overlap, so refusing this band
    // would refuse hosts that demonstrably pass. The lane's report-based retry
    // is what handles that flake.
    for (const loadavg of [
      // hk1-30 at entry, run 43018456551: already the most contended of them.
      '90.88 92.66 80.67 1/900 1\n',
      // hk1-29 at entry, run 43014476470: healthy when its suites began.
      '47.90 54.64 52.17 1/900 1\n',
      // hk1-7 peak, run 43016121622 shard 1: a host that passed.
      '95.00 95.36 92.00 1/900 1\n',
    ]) {
      const result = runGate({
        loadavg,
        env: { HOST_LOAD_MAX_WAIT_TRIES: '1' },
      });
      assert.equal(result.status, 0, result.stdout);
    }
  });

  it('reads the five-minute average, not the one-minute spike', () => {
    // A neighbour's collection phase spikes the one-minute load and is over
    // before the suites start. Refusing on it would reject healthy hosts.
    const result = runGate({
      loadavg: '200.00 32.00 30.00 1/900 1\n',
      env: { HOST_LOAD_MAX_WAIT_TRIES: '1' },
    });

    assert.equal(result.status, 0, result.stdout);
    assert.match(samples(result.stdout)[0], /ratio\[0\.50\]/);
  });

  it('scales the ceiling with the host instead of fixing a load number', () => {
    // The pool mixes host sizes. Load 140 is above the ceiling on 64 CPUs and
    // below it on 128, so the same absolute number cannot serve both.
    const small = runGate({
      loadavg: '140.00 140.00 140.00 1/900 1\n',
      cpus: '64',
      env: { HOST_LOAD_MAX_WAIT_TRIES: '1' },
    });
    const large = runGate({
      loadavg: '140.00 140.00 140.00 1/900 1\n',
      cpus: '128',
      env: { HOST_LOAD_MAX_WAIT_TRIES: '1' },
    });

    assert.equal(small.status, 1);
    assert.equal(large.status, 0, large.stdout);
  });

  it('admits as soon as a sample clears the ceiling', () => {
    // A host that idles mid-wait must not be refused for its earlier reading.
    const dir = mkdtempSync(join(tmpdir(), 'host-load-drop-'));
    try {
      const source = spawnSync('cat', [SCRIPT], { encoding: 'utf8' }).stdout;
      const loadFile = join(dir, 'loadavg');
      writeFileSync(loadFile, '140.00 140.00 140.00 1/900 1\n');
      // The gate reads the load through `cut`, so a counting stub is the
      // deterministic way to model a neighbour finishing: the first sample
      // reports the contended host, every later one reports it idle. A
      // background writer would race the first sample instead.
      const bin = join(dir, 'bin');
      spawnSync('mkdir', ['-p', bin]);
      const counter = join(dir, 'reads');
      writeFileSync(counter, '0');
      writeFileSync(
        join(bin, 'cut'),
        [
          '#!/usr/bin/env bash',
          `n=$(cat '${counter}'); n=$((n + 1)); printf '%s' "$n" > '${counter}'`,
          'if [ "$n" -ge 2 ]; then',
          "  printf '10.00 10.00 10.00\\n'",
          'else',
          "  printf '140.00 140.00 140.00\\n'",
          'fi',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'nproc'),
        "#!/usr/bin/env bash\nprintf '64\\n'\n",
        { mode: 0o755 },
      );
      const copy = join(dir, 'gate.sh');
      writeFileSync(copy, source.replaceAll('/proc/loadavg', loadFile));
      const result = spawnSync('bash', [copy], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HOST_LOAD_WAIT_SECONDS: '1',
          HOST_LOAD_MAX_WAIT_TRIES: '4',
        },
      });

      assert.equal(result.status, 0, result.stdout + result.stderr);
      const lines = samples(result.stdout);
      assert.equal(lines.length, 2, result.stdout);
      assert.match(lines[0], /ratio\[2\.19\]/);
      assert.match(lines[1], /ratio\[0\.16\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('samples the configured number of times before refusing', () => {
    const result = runGate({
      loadavg: '140.00 140.00 140.00 1/900 1\n',
      env: { HOST_LOAD_MAX_WAIT_TRIES: '3' },
    });

    assert.equal(result.status, 1);
    assert.equal(samples(result.stdout).length, 3, result.stdout);
    assert.match(result.stdout, /after 3 samples/);
  });

  it('admits without a gate when the CPU count is unreadable', () => {
    // A ratio with no denominator would refuse or admit at random. The gate is
    // an optimisation over an honest failure, never a new way to block a lane.
    const result = runGate({
      loadavg: '900.00 900.00 900.00 1/900 1\n',
      cpus: '',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::could not read the CPU count/);
    assert.match(samples(result.stdout)[0], /cpus\[unknown\]/);
  });

  it('admits without a gate when the load average is unreadable', () => {
    const result = runGate({ loadavg: '' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::could not read .*loadavg/);
  });

  it('lets an operator disable the gate without a PR', () => {
    for (const env of [
      { HOST_LOAD_MAX_RATIO: 'off' },
      { HOST_LOAD_MAX_WAIT_TRIES: 'off' },
    ]) {
      const result = runGate({
        loadavg: '900.00 900.00 900.00 1/900 1\n',
        env,
      });
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stdout, /disabled by configuration/);
    }
  });

  it('rejects a malformed threshold instead of admitting on it', () => {
    // A typo must not silently disable the gate: '2,0' or '2.0x' would
    // otherwise reach awk and compare as zero, admitting every host.
    for (const ratio of ['2,0', '2.0x', '-1', '']) {
      const result = runGate({ env: { HOST_LOAD_MAX_RATIO: ratio } });
      if (ratio === '') {
        // Unset means the default, not a malformed value.
        assert.equal(result.status, 0, result.stdout);
        continue;
      }
      assert.equal(result.status, 1, `${ratio}: ${result.stdout}`);
      assert.match(result.stdout, /HOST_LOAD_MAX_RATIO must be/);
    }
    for (const env of [
      { HOST_LOAD_MAX_WAIT_TRIES: '0' },
      { HOST_LOAD_WAIT_SECONDS: 'many' },
    ]) {
      const result = runGate({ env });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stdout, /must be a positive integer/);
    }
  });

  it('rejects a zero ceiling instead of refusing every host', () => {
    // `0` passes the number shape but makes `load < cpus * 0` false for every
    // host, so a single typo in the repo variable would refuse every
    // self-hosted Linux unit lane. It must fail as a configuration error
    // before the first sample, not after six samples report a breach.
    for (const ratio of ['0', '0.0', '00']) {
      const result = runGate({ env: { HOST_LOAD_MAX_RATIO: ratio } });
      assert.equal(result.status, 1, `${ratio}: ${result.stdout}`);
      assert.match(
        result.stdout,
        /HOST_LOAD_MAX_RATIO must be a positive number or 'off'/,
      );
      assert.deepEqual(
        samples(result.stdout),
        [],
        `${ratio}: sampled instead of rejecting the configuration`,
      );
    }
  });

  it('reads a zero-padded wait count as decimal', () => {
    // `08` passes the shape check, but `for (( ))` reads a leading zero as
    // octal, where 08 is invalid: the loop would take zero samples and the
    // script would then die on the unbound `load5` under `set -u`, refusing
    // every job on the runner with a raw bash error instead of the re-run
    // annotation.
    const result = runGate({
      loadavg: '145.00 140.00 130.00 1/900 1\n',
      env: {
        HOST_LOAD_MAX_WAIT_TRIES: '08',
        HOST_LOAD_WAIT_SECONDS: '1',
        HOST_LOAD_MAX_RATIO: '1.0',
      },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(samples(result.stdout).length, 8, result.stdout);
    assert.match(result.stdout, /after 8 samples/);
    assert.doesNotMatch(result.stdout, /value too great for base/);
    assert.doesNotMatch(result.stdout, /load5: unbound variable/);
  });

  it('keeps a custom ceiling and observes the exact boundary', () => {
    // The ceiling is the operator's only tuning knob and the comparison is
    // `<`, so an admitted host at 6.0, a refusal at 1.0, and the exact
    // `cpus * max` point all have to be observed: hardcoding 2.0 or flipping
    // `<` to `<=` otherwise stays invisible.
    const loose = runGate({
      loadavg: '300.00 300.00 300.00 1/900 1\n',
      cpus: '64',
      env: { HOST_LOAD_MAX_RATIO: '6.0', HOST_LOAD_MAX_WAIT_TRIES: '1' },
    });
    assert.equal(loose.status, 0, loose.stdout);
    assert.match(samples(loose.stdout)[0], /max_ratio\[6\.0\]/);

    const tight = runGate({
      loadavg: '70.00 70.00 70.00 1/900 1\n',
      cpus: '64',
      env: { HOST_LOAD_MAX_RATIO: '1.0', HOST_LOAD_MAX_WAIT_TRIES: '1' },
    });
    assert.equal(tight.status, 1, tight.stdout);

    // Exactly at the ceiling: 128.00 on 64 CPUs with 2.0. The comparison is
    // `avg < cpus * max` to admit, so equality refuses.
    const exact = runGate({
      loadavg: '128.00 128.00 128.00 1/900 1\n',
      cpus: '64',
      env: { HOST_LOAD_MAX_WAIT_TRIES: '1', HOST_LOAD_MAX_RATIO: '2.0' },
    });
    assert.equal(exact.status, 1, exact.stdout);
    assert.match(exact.stdout, /::error::Host load gate breached/);

    const below = runGate({
      loadavg: '127.99 127.99 127.99 1/900 1\n',
      cpus: '64',
      env: { HOST_LOAD_MAX_WAIT_TRIES: '1', HOST_LOAD_MAX_RATIO: '2.0' },
    });
    assert.equal(below.status, 0, below.stdout);
  });

  it('emits a breach the infrastructure classifiers recognise', () => {
    // A refusal is the one failure whose whole purpose is "re-run me", and
    // two workflows classify a check-run annotation as infrastructure:
    // qwen-autofix re-runs it, main-ci-failure-issue suppresses the failure
    // record. Both match on INFRA_FAILURE_SIGNATURES, and the issue workflow
    // promises the two strings stay equal, so read both here: a token added
    // to one and not the other is a silent coverage hole.
    const result = runGate({
      loadavg: '145.00 140.00 130.00 1/900 1\n',
      env: { HOST_LOAD_MAX_WAIT_TRIES: '1' },
    });
    assert.equal(result.status, 1, result.stdout);
    const readSignatures = (name) => {
      const workflow = readFileSync(
        fileURLToPath(new URL(`../workflows/${name}`, import.meta.url)),
        'utf8',
      );
      const signatures = /INFRA_FAILURE_SIGNATURES: '([^']*)'/.exec(
        workflow,
      )?.[1];
      assert.ok(signatures, `${name}: INFRA_FAILURE_SIGNATURES not found`);
      return signatures;
    };
    const signatures = readSignatures('qwen-autofix.yml');
    const issueSignatures = readSignatures('main-ci-failure-issue.yml');
    assert.match(result.stdout, /::error::Host load gate breached/);
    assert.ok(
      new RegExp(signatures, 'i').test(result.stdout),
      'the breach annotation must match qwen-autofix INFRA_FAILURE_SIGNATURES',
    );
    assert.ok(
      new RegExp(issueSignatures, 'i').test(result.stdout),
      'the breach annotation must match main-ci-failure INFRA_FAILURE_SIGNATURES',
    );
    assert.equal(issueSignatures, signatures);
  });
});
