import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-disk-floor.sh', import.meta.url));

function runGate({ dirs = [], env = {} } = {}) {
  return spawnSync('bash', [SCRIPT, ...dirs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_NAME: 'ecs-test-runner-1',
      GITHUB_RUN_ID: '12345',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_JOB: 'test',
      ...env,
    },
  });
}

describe('check-disk-floor', () => {
  it('passes with a tagged sample when the filesystem clears the floor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'disk-floor-'));
    try {
      const result = runGate({
        dirs: [dir],
        env: { DISK_FLOOR_MIN_FREE_KB: '1', DISK_FLOOR_MIN_FREE_INODES: '1' },
      });

      assert.equal(result.status, 0, result.stderr);
      const sample = result.stdout
        .split('\n')
        .find((line) => line.startsWith('DISKFLOOR '));
      assert.ok(sample, `expected a DISKFLOOR sample, got: ${result.stdout}`);
      assert.ok(sample.includes(`dir[${dir}]`));
      assert.ok(sample.includes('runner[ecs-test-runner-1]'));
      assert.ok(sample.includes('run[12345/2]'));
      assert.ok(!result.stdout.includes('::error::'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails before the heavy step when free space is below the floor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'disk-floor-'));
    try {
      // No CI filesystem has an exabyte free; a huge floor forces the breach
      // path deterministically without touching real usage.
      const result = runGate({
        dirs: [dir],
        env: { DISK_FLOOR_MIN_FREE_KB: '999999999999' },
      });

      assert.equal(result.status, 1);
      assert.ok(result.stdout.includes('::error::Disk floor breached'));
      assert.ok(result.stdout.includes('ecs-test-runner-1'));
      assert.ok(result.stdout.includes('KiB free'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when free inodes are below the floor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'disk-floor-'));
    try {
      const result = runGate({
        dirs: [dir],
        env: {
          DISK_FLOOR_MIN_FREE_KB: '1',
          DISK_FLOOR_MIN_FREE_INODES: '999999999999',
        },
      });

      assert.equal(result.status, 1);
      assert.ok(result.stdout.includes('free inodes'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for invalid floor overrides', () => {
    for (const [name, value] of [
      ['DISK_FLOOR_MIN_FREE_KB', '2G'],
      ['DISK_FLOOR_MIN_FREE_INODES', '9223372036854775808'],
    ]) {
      const result = runGate({ env: { [name]: value } });

      assert.equal(result.status, 1);
      assert.ok(result.stdout.includes(`::error::${name} must be`));
    }
  });

  it('warns and proceeds for a missing directory', () => {
    const missing = join(tmpdir(), `disk-floor-missing-${process.pid}`);
    const result = runGate({ dirs: [missing] });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('::warning::'));
    assert.ok(result.stdout.includes(missing));
  });

  it('defaults to GITHUB_WORKSPACE and RUNNER_TEMP with no arguments', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'disk-floor-ws-'));
    const temp = mkdtempSync(join(tmpdir(), 'disk-floor-tmp-'));
    try {
      const result = runGate({
        env: {
          GITHUB_WORKSPACE: workspace,
          RUNNER_TEMP: temp,
          DISK_FLOOR_MIN_FREE_KB: '1',
          DISK_FLOOR_MIN_FREE_INODES: '1',
        },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`dir[${workspace}]`));
      assert.ok(result.stdout.includes(`dir[${temp}]`));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('always checks the OS temp directory, deduplicated', () => {
    // The 2026-10-31 hz incident: /tmp hit 100% inodes while the workspace
    // and RUNNER_TEMP sat on a data disk, so caller directories alone were
    // green while every mkdtemp died mid-suite. The gate must add the OS
    // temp directory on its own — and not duplicate it when a caller
    // already passed it.
    const dir = mkdtempSync(join(tmpdir(), 'disk-floor-os-'));
    const osTmp = mkdtempSync(join(tmpdir(), 'disk-floor-ostmp-'));
    try {
      // Explicit dirs: the OS temp dir is still checked (huge inode floor
      // forces the breach on it deterministically).
      const breached = runGate({
        dirs: [dir],
        env: {
          TMPDIR: osTmp,
          DISK_FLOOR_MIN_FREE_KB: '1',
          DISK_FLOOR_MIN_FREE_INODES: '999999999999',
        },
      });
      assert.equal(breached.status, 1);
      assert.ok(breached.stdout.includes(`dir[${osTmp}]`));
      assert.ok(breached.stdout.includes('free inodes'));

      // Deduplication: passing the OS temp dir explicitly checks it once.
      const counted = runGate({
        dirs: [dir, osTmp],
        env: {
          TMPDIR: osTmp,
          DISK_FLOOR_MIN_FREE_KB: '1',
          DISK_FLOOR_MIN_FREE_INODES: '1',
        },
      });
      assert.equal(counted.status, 0, counted.stderr);
      const samples = counted.stdout
        .split('\n')
        .filter((line) => line.startsWith('DISKFLOOR '));
      assert.equal(samples.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(osTmp, { recursive: true, force: true });
    }
  });
});
