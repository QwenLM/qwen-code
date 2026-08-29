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

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'ci.yml',
);
const workflow = readFileSync(workflowPath, 'utf8');
const testJobStart = workflow.indexOf('\n  test:\n');
assert.ok(testJobStart >= 0, 'missing test job');
const afterTestJob = workflow.slice(testJobStart + 9);
const nextJob = afterTestJob.match(/\n {2}[a-zA-Z0-9_-]+:\n/);
const testJob = workflow.slice(
  testJobStart,
  nextJob ? testJobStart + 9 + nextJob.index : undefined,
);

function step(name) {
  const marker = `      - name: '${name}'`;
  const start = testJob.indexOf(marker);
  assert.ok(start >= 0, `missing ${name} step`);
  const next = testJob.slice(start + marker.length).match(/\n {6}- /);
  return testJob.slice(
    start,
    next ? start + marker.length + next.index : undefined,
  );
}

function runBody(value) {
  const marker = '        run: |-\n';
  const start = value.indexOf(marker);
  assert.ok(start >= 0, 'missing run block');
  return value.slice(start + marker.length).replace(/^ {10}/gm, '');
}

describe('ci.yml disk-pressure evidence', () => {
  it('starts sampling before npm ci and preserves those samples for upload', () => {
    const install = step('Install dependencies');
    const npmCi = install.indexOf('npm ci');

    assert.ok(npmCi > install.indexOf('DISK_SAMPLES='));
    assert.ok(npmCi > install.indexOf('DFSAMPLE '));
    assert.match(install, /trap .*SAMPLER_PID.* EXIT/);

    const tests = step('Run tests and generate reports');
    assert.match(tests, /if \[ ! -s "\$DISK_SAMPLES" \]; then/);
    assert.match(tests, />> "\$DISK_SAMPLES"/);

    const upload = step('Upload disk-pressure samples');
    assert.match(upload, /if: '\$\{\{ failure\(\) \}\}'/);
    assert.match(upload, /if-no-files-found: 'ignore'/);
  });

  it('keeps install failure status while writing the pre-install sample', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-disk-pressure-'));
    const npm = join(root, 'npm');
    writeFileSync(npm, '#!/usr/bin/env bash\nexit 42\n');
    chmodSync(npm, 0o755);

    try {
      const result = spawnSync(
        'bash',
        ['-e', '-o', 'pipefail', '-c', runBody(step('Install dependencies'))],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            RUNNER_TEMP: root,
          },
        },
      );

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
