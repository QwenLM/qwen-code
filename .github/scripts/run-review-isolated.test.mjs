import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(
  new URL('./run-review-isolated.sh', import.meta.url),
);

test('hosted invocation preserves arguments and exit status', () => {
  const result = spawnSync(
    'bash',
    [script, 'bash', '-c', 'printf "%s" "$1"; exit 7', '_', 'two words'],
    {
      env: { ...process.env, RUNNER_ENVIRONMENT: 'github-hosted' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'two words');
});

test('unknown runner environment fails closed', () => {
  const result = spawnSync('bash', [script, 'echo', 'UNSAFE'], {
    env: { ...process.env, RUNNER_ENVIRONMENT: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('self-hosted review requests isolation and never falls back on bwrap failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-isolation-'));
  try {
    for (const dir of ['bin', 'workspace', 'scratch', 'home'])
      mkdirSync(join(root, dir));
    writeFileSync(join(root, 'bin/uname'), '#!/bin/sh\necho Linux\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(root, 'bin/bwrap'),
      '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 23\n',
      { mode: 0o755 },
    );
    const result = spawnSync('bash', [script, 'echo', 'UNSAFE'], {
      env: {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        RUNNER_ENVIRONMENT: 'self-hosted',
        GITHUB_WORKSPACE: join(root, 'workspace'),
        RUNNER_TEMP: join(root, 'scratch'),
        HOME: join(root, 'home'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 23, result.stderr);
    const args = result.stdout.trim().split('\n');
    for (const flag of ['--unshare-user', '--unshare-pid', '--die-with-parent'])
      assert.ok(args.includes(flag));
    assert.ok(result.stdout.includes('--proc\n/proc\n'));
    assert.ok(result.stdout.includes('--cap-drop\nALL\n'));
    assert.ok(result.stdout.includes('--tmpfs\n/run\n'));
    assert.ok(result.stdout.includes('--tmpfs\n/tmp\n'));
    assert.deepEqual(args.slice(-3), ['--', 'echo', 'UNSAFE']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
