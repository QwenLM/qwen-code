/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  readdirSync,
  realpathSync,
  lstatSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const script = resolve('.github/scripts/prepare-release-runner.sh');
it
  .skipIf(process.platform === 'win32')
  .each([
    'normal',
    'workspace-leaf-link',
    'workspace-parent-link',
    'workspace-contained-parent-link',
    'runner-link',
    'workspace-outside',
    'workspace-equals-runner',
  ])('release workspace cleanup: %s', (kind) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'downstream-bootstrap-')),
  );
  try {
    const runner = join(root, 'runner'),
      workspace = join(runner, 'repo'),
      outside = join(root, 'outside'),
      temp = join(root, 'temp'),
      bin = join(root, 'bin');
    for (const dir of [runner, outside, temp, bin]) mkdirSync(dir);
    writeFileSync(join(outside, 'sentinel'), 'KEEP_EXTERNAL');
    chmodSync(join(outside, 'sentinel'), 0o444);
    // Linux CI exercises GNU realpath; macOS uses a path-only compatibility shim.
    if (process.platform === 'darwin')
      writeFileSync(
        join(bin, 'realpath'),
        "#!/usr/bin/env python3\nimport os,sys\np=sys.argv[-1]\nprint(os.path.abspath(p) if '-s' in sys.argv else os.path.realpath(p))\n",
      );
    if (process.platform === 'darwin') chmodSync(join(bin, 'realpath'), 0o755);
    let workspaceInput = workspace,
      runnerInput = runner;
    if (kind === 'workspace-leaf-link') symlinkSync(outside, workspace, 'dir');
    else if (kind === 'workspace-parent-link') {
      symlinkSync(outside, join(runner, 'parent'), 'dir');
      mkdirSync(join(outside, 'repo'));
      workspaceInput = join(runner, 'parent', 'repo');
    } else if (kind === 'workspace-contained-parent-link') {
      mkdirSync(workspace);
      writeFileSync(join(workspace, 'sentinel'), 'KEEP_INTERNAL');
      symlinkSync(runner, join(runner, 'parent'), 'dir');
      workspaceInput = join(runner, 'parent', 'repo');
    } else if (kind === 'runner-link') {
      mkdirSync(workspace);
      symlinkSync(runner, join(root, 'runner-link'), 'dir');
      runnerInput = join(root, 'runner-link');
    } else if (kind === 'workspace-outside') workspaceInput = outside;
    else if (kind === 'workspace-equals-runner') workspaceInput = runner;
    else {
      mkdirSync(workspace);
      writeFileSync(join(workspace, '.npmrc'), 'STALE');
      mkdirSync(join(workspace, 'old'));
      symlinkSync(outside, join(workspace, 'old', 'external-link'), 'dir');
    }
    const envFile = join(root, 'env'),
      pathFile = join(root, 'path');
    writeFileSync(envFile, '');
    writeFileSync(pathFile, '');
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_WORKSPACE: runnerInput,
      GITHUB_WORKSPACE: workspaceInput,
      RUNNER_TEMP: temp,
      GITHUB_ENV: envFile,
      GITHUB_PATH: pathFile,
      DISK_FLOOR_MIN_FREE_KB: '0',
      DISK_FLOOR_MIN_FREE_INODES: '0',
    };
    const run = () =>
      spawnSync('bash', [script], { cwd: temp, env, encoding: 'utf8' });
    const result = run();
    const success = ['normal', 'workspace-leaf-link'].includes(kind);
    assert.equal(
      result.status === 0,
      success,
      `${kind}: ${result.stdout}\n${result.stderr}`,
    );
    assert.equal(
      readFileSync(join(outside, 'sentinel'), 'utf8'),
      'KEEP_EXTERNAL',
    );
    assert.equal(statSync(join(outside, 'sentinel')).mode & 0o777, 0o444);
    if (kind === 'workspace-contained-parent-link')
      assert.equal(
        readFileSync(join(workspace, 'sentinel'), 'utf8'),
        'KEEP_INTERNAL',
      );
    if (success) {
      assert.ok(lstatSync(workspace).isDirectory());
      assert.deepEqual(readdirSync(workspace), []);
      const parsed = Object.fromEntries(
        readFileSync(envFile, 'utf8')
          .trim()
          .split('\n')
          .map((x) => {
            const p = x.indexOf('=');
            return [x.slice(0, p), x.slice(p + 1)];
          }),
      );
      for (const key of [
        'GIT_CONFIG_GLOBAL',
        'NPM_CONFIG_USERCONFIG',
        'DOCKER_CONFIG',
        'GH_CONFIG_DIR',
      ])
        assert.ok(
          parsed[key].startsWith(temp + '/release-state.'),
          `${kind}: ${key}`,
        );
      assert.equal(parsed.GIT_CONFIG_COUNT, '0');
      assert.equal(parsed.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(parsed.GIT_CONFIG_PARAMETERS, '');
      assert.equal(readFileSync(parsed.GIT_CONFIG_GLOBAL, 'utf8'), '');
      assert.equal(readFileSync(parsed.NPM_CONFIG_USERCONFIG, 'utf8'), '');
      assert.equal(statSync(parsed.GH_CONFIG_DIR).mode & 0o077, 0);
      const second = run();
      assert.equal(second.status, 0, second.stderr);
      const states = readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((x) => x.startsWith('GIT_CONFIG_GLOBAL='));
      assert.equal(new Set(states).size, 2);
    } else assert.equal(readFileSync(envFile, 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
