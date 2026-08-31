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
const testSteps = parse(readFileSync(workflowPath, 'utf8')).jobs.test.steps;

function step(name) {
  const value = testSteps.find((candidate) => candidate.name === name);
  assert.ok(value, `missing ${name} step`);
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
