import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-host-load.sh', import.meta.url));

// Caller env must not reach the gate: an exported HOST_LOAD_MAX_RATIO=off
// turned ten of the cases below red (#16945 R1-4). Only HOST_LOAD_* goes, so
// an unset knob still falls through to its script default.
const INHERITED = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('HOST_LOAD_')),
);

// The gate reads two host facts, /proc/loadavg and nproc, and neither has a
// deterministic real-host trigger. nproc comes from PATH; /proc/loadavg is an
// absolute path no PATH can shadow, so every case runs its own copy of the
// script whose only edit is that path. `cut` is stubbed for the same reason:
// what the gate reads there is the case's input, not the host's.
function runGate({ loadavg, cpus = '64', env = {}, cut } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-load-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(
      join(bin, 'nproc'),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${cpus}'\n`,
      { mode: 0o755 },
    );
    // Records every gap the gate sleeps through, so the default sample count
    // and the default gap have witnesses (#16945 R2-7). SLEEP_LOG is always
    // set by the env block below, so the stub never runs without it.
    writeFileSync(
      join(bin, 'sleep'),
      `#!/usr/bin/env bash\n[ -n "\${SLEEP_LOG:-}" ] && printf '%s\\n' "$1" >> "$SLEEP_LOG"\n`,
      { mode: 0o755 },
    );
    // `cut` serves one line per read from the case's list, so a host that
    // changes between samples needs no background writer racing the first
    // sample; a status makes the read itself fail.
    if (cut) {
      const reads = join(dir, 'cut-reads');
      const stream = join(dir, 'cut-stream');
      writeFileSync(reads, '0');
      writeFileSync(stream, `${[].concat(cut.stdout ?? '').join('\n')}\n`);
      writeFileSync(
        join(bin, 'cut'),
        [
          '#!/usr/bin/env bash',
          `n=$(cat '${reads}'); n=$((n + 1)); printf '%s' "$n" > '${reads}'`,
          `sed -n "\${n}p" '${stream}'`,
          `exit ${cut.status ?? 0}`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
    }
    const loadFile = join(dir, 'loadavg');
    writeFileSync(loadFile, loadavg ?? '10.00 12.00 11.00 1/900 12345\n');
    const source = spawnSync('cat', [SCRIPT], {
      encoding: 'utf8',
    }).stdout.replaceAll('/proc/loadavg', loadFile);
    const copy = join(dir, 'gate.sh');
    writeFileSync(copy, source);
    return spawnSync('bash', [copy], {
      encoding: 'utf8',
      env: {
        ...INHERITED,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_NAME: 'ecs-qwen-hk1-9',
        GITHUB_RUN_ID: '43018456551',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'test',
        // Every case but the gap witness leaves the script's own 10s default
        // in place; the sleep stub keeps that from costing wall time, and
        // setting the log here keeps the stub off an unset variable.
        SLEEP_LOG: join(dir, 'sleeps'),
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

// A PATH with nothing but bash: awk is absent on macOS and Linux alike.
function withoutAwk() {
  const bin = mkdtempSync(join(tmpdir(), 'host-load-noawk-'));
  spawnSync('ln', ['-s', '/bin/bash', join(bin, 'bash')]);
  return bin;
}

// The two workflows promise their INFRA_FAILURE_SIGNATURES lists stay equal;
// read them from the workflows themselves instead of restating them. The
// configuration class is autofix-only: main-ci deliberately files those.
function scalarValue(workflow, key, name) {
  const match = new RegExp(
    `^([ \\t]*)${key}:[ \\t]*(.*?)[ \\t]*(?:#.*)?$`,
    'm',
  ).exec(workflow);
  assert.ok(match, `${name}: ${key} not found`);
  const [, indent, raw] = match;
  // A value opening with a block-scalar indicator, an anchor, an alias or a
  // tag keeps its text somewhere this reader cannot follow. Returning the
  // indicator would pin a one-character "pattern" that matches nothing while
  // the assertion above it still passes, so refuse instead.
  assert.ok(
    !/^[|>&*!]/.test(raw),
    `${name}: ${key} uses the \`${raw[0]}\` form, which this dependency-free reader cannot resolve`,
  );
  // A following line indented deeper than the key belongs to the same node.
  const nextLine =
    workflow.slice(match.index + match[0].length).split('\n')[1] ?? '';
  assert.ok(
    !new RegExp(`^[ \\t]{${indent.length + 1},}\\S`).test(nextLine),
    `${name}: ${key} continues on a deeper-indented line, which this reader cannot follow`,
  );
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `${name}: ${key} is a double-quoted scalar this reader could not decode (${error.message}): ${raw}`,
      );
    }
  }
  assert.ok(
    raw.length > 0,
    `${name}: ${key} is empty; an empty pattern would match every annotation`,
  );
  assert.ok(
    !/^["']/.test(raw),
    `${name}: ${key} opens a quote it does not close on the same line`,
  );
  return raw;
}

function readSignatures(name, key = 'INFRA_FAILURE_SIGNATURES') {
  // `yaml` is not importable here: this suite runs in the dependency-free helper
  // battery (`HELPER_TESTS_DEP_FREE`, before `npm ci`), whose import closure
  // must stay `node:` builtins. The value is therefore read by hand, and both
  // quoting styles are accepted because one signature contains a single quote,
  // which forces the workflow to double quotes.
  return scalarValue(
    readFileSync(
      fileURLToPath(new URL(`../workflows/${name}`, import.meta.url)),
      'utf8',
    ),
    key,
    name,
  );
}

describe('check-host-load', () => {
  it('admits a host below the ceiling and emits a tagged sample', () => {
    // A host that passed its suites: hk3-28 at load 40 on 64 CPUs, 0.62.
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
    // A host that idles mid-wait must not be refused for its earlier reading:
    // the first read reports the contended host, the second an idle one. The
    // stub serves those two lines in order, which a background writer could
    // not do without racing that first sample.
    const result = runGate({
      cut: { stdout: ['140.00 140.00 140.00', '10.00 10.00 10.00'] },
      env: { HOST_LOAD_MAX_WAIT_TRIES: '4' },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = samples(result.stdout);
    assert.equal(lines.length, 2, result.stdout);
    assert.match(lines[0], /ratio\[2\.19\]/);
    assert.match(lines[1], /ratio\[0\.16\]/);
    // The inline copy of the harness used to lose these tags.
    assert.match(lines[0], /runner\[ecs-qwen-hk1-9\]/);
    assert.match(lines[0], /job\[test\]/);
    assert.doesNotMatch(lines[0], /runner\[unknown\]/);
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
    // '' is an empty nproc, 'abc' the non-numeric branch of the sanitizer and
    // '0' the `-lt 1` guard; each admits instead of sampling.
    for (const [cpus, seen] of [
      ['', 'unknown'],
      ['abc', 'unknown'],
      ['0', '0'],
    ]) {
      const result = runGate({
        loadavg: '900.00 900.00 900.00 1/900 1\n',
        cpus,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /::warning::could not read the CPU count/);
      assert.match(samples(result.stdout)[0], new RegExp(`cpus\\[${seen}\\]`));
    }
  });

  it('admits without a gate when the load average is unreadable', () => {
    // An empty fixture is what a missing /proc/loadavg looks like; a `cut`
    // that fails outright takes the same path, error text and all.
    for (const cut of [undefined, { status: 1 }]) {
      const result = runGate({ loadavg: '', cut });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /::warning::could not read .*loadavg/);
    }
  });

  it('admits with a warning when awk is missing instead of blaming the threshold', () => {
    // A stripped image: the zero test used to go through awk, so a missing
    // tool read as a bad HOST_LOAD_MAX_RATIO, which the configuration
    // signatures claim.
    const bin = withoutAwk();
    const result = runGate({ env: { PATH: bin } });
    rmSync(bin, { recursive: true, force: true });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /::warning::.*awk/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /must be a positive number/,
    );
  });

  it('still rejects a malformed ceiling on a host without awk', () => {
    // The guard has to stay after the threshold checks: a bad repo variable
    // must not degrade to an admission just because awk is missing.
    const bin = withoutAwk();
    const result = runGate({
      env: { PATH: bin, HOST_LOAD_MAX_RATIO: '2,0' },
    });
    rmSync(bin, { recursive: true, force: true });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /must be a positive number/);
    assert.doesNotMatch(result.stdout, /::warning::awk/);
  });

  it('takes the default six samples and waits the default gap', () => {
    // #16945 R2-7: dropping the inter-sample sleep, or either script default
    // (6 tries, 10s gap) down a step, stayed green. The stub records every gap
    // the loop asked for, and this case overrides neither default.
    const dir = mkdtempSync(join(tmpdir(), 'host-load-gap-'));
    const result = runGate({
      loadavg: '145.00 140.00 130.00 1/900 1\n',
      env: { SLEEP_LOG: join(dir, 'calls') },
    });
    const gaps = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
    rmSync(dir, { recursive: true, force: true });

    assert.equal(result.status, 1, result.stdout);
    assert.equal(samples(result.stdout).length, 6, result.stdout);
    assert.match(result.stdout, /after 6 samples/);
    assert.deepEqual(gaps, ['10', '10', '10', '10', '10']);
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
    // bash writes both of these to stderr, so a stdout-only assertion can
    // never fail on the mutation it was written to catch.
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /value too great for base/,
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /load5: unbound variable/,
    );
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

  it('reads a plain or commented scalar, and refuses the forms it cannot follow', () => {
    // R2-2: the reader replaced a quote-pinned regex, so it must fail closed
    // rather than half-read a value. Each case below is a YAML form a workflow
    // author could legally reach for; the first three must throw with a message
    // naming the form (a silent truncation would pin a pattern that matches
    // nothing, which is the fail-open class this suite exists to catch), and the
    // last must return the value with the comment stripped.
    const key = 'INFRA_FAILURE_SIGNATURES';
    for (const [form, fixture] of [
      ['>', `env:\n  ${key}: >\n    lost communication with the server\n`],
      ['|', `env:\n  ${key}: |-\n    lost communication with the server\n`],
      ['&', `env:\n  ${key}: &sigs lost communication with the server\n`],
    ]) {
      assert.throws(
        () => scalarValue(fixture, key, 'fixture.yml'),
        new RegExp(`uses the .${form}. form`),
        `${form} must be refused, not read as the indicator`,
      );
    }
    // A deeper-indented continuation is the same node, and this reader stops at
    // the first line: refuse instead of reading a prefix.
    assert.throws(
      () =>
        scalarValue(
          `env:\n  ${key}: lost communication\n    with the server\n`,
          key,
          'fixture.yml',
        ),
      /continues on a deeper-indented line/,
    );
    // A trailing comment is legal YAML and is not part of the value.
    assert.equal(
      scalarValue(`env:\n  ${key}: 'a|b' # the rerun class\n`, key, 'f.yml'),
      'a|b',
    );
    assert.equal(
      scalarValue(
        `env:\n  ${key}: "a|b" # quoted the other way\n`,
        key,
        'f.yml',
      ),
      'a|b',
    );
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

  it('prints configuration errors that qwen-autofix claims without rerunning them', () => {
    // R2-1: these annotations were pinned as literals copied into another
    // file, so renaming one in the gate passed unseen. Read what the gate
    // actually prints and require one printed line per knob. R1-1 then split
    // them out of the rerun class: qwen-autofix's CONFIG_FAILURE_SIGNATURES
    // must claim every line, so the scan skips the PR instead of addressing a
    // variable typo, and neither INFRA list may claim one — a re-run cannot
    // change a repository variable, so main-ci-failure-issue files instead of
    // rerunning.
    const envs = [
      { HOST_LOAD_MAX_RATIO: '0' },
      { HOST_LOAD_MAX_RATIO: '2,0' },
      { HOST_LOAD_MAX_WAIT_TRIES: '0' },
      { HOST_LOAD_WAIT_SECONDS: 'many' },
    ];
    const emitted = envs.map((env) => {
      const result = runGate({ env });
      assert.equal(
        result.status,
        1,
        `${JSON.stringify(env)}: ${result.stdout}`,
      );
      const errors = result.stdout
        .split('\n')
        .filter((line) => line.startsWith('::error::'));
      assert.equal(
        errors.length,
        1,
        `${JSON.stringify(env)}: ${result.stdout}`,
      );
      return errors[0];
    });

    const config = new RegExp(
      readSignatures('qwen-autofix.yml', 'CONFIG_FAILURE_SIGNATURES'),
      'i',
    );
    for (const line of emitted) {
      assert.match(
        line,
        config,
        `qwen-autofix CONFIG_FAILURE_SIGNATURES does not classify: ${line}`,
      );
    }
    for (const name of ['qwen-autofix.yml', 'main-ci-failure-issue.yml']) {
      const pattern = new RegExp(readSignatures(name), 'i');
      for (const line of emitted) {
        assert.doesNotMatch(line, pattern, `${name} still reruns: ${line}`);
      }
    }

    // One printed line per knob, so dropping a token from the configuration
    // class reds here rather than leaving the knob silently unclassified.
    for (const knob of [
      'HOST_LOAD_MAX_RATIO must be a positive number',
      'HOST_LOAD_MAX_WAIT_TRIES must be a positive integer',
      'HOST_LOAD_WAIT_SECONDS must be a positive integer',
    ]) {
      assert.ok(
        emitted.some((line) => line.includes(knob)),
        `no printed error covers "${knob}": ${emitted.join(' | ')}`,
      );
    }
  });
});
