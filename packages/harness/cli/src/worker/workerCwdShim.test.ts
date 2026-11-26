/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCwd, getOriginalCwd, sanitizePath } from '@qwen-code/core';
import {
  ENV_WORKER_CWD,
  installWorkerCwdShim,
  resolveWorkerRuntimeCwd,
  type InstalledWorkerCwdShim,
} from './workerCwdShim.js';

describe('workerCwdShim', () => {
  const tempRoots: string[] = [];
  let shim: InstalledWorkerCwdShim | undefined;

  afterEach(() => {
    shim?.restore();
    shim = undefined;
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-cwd-'));
    tempRoots.push(dir);
    return fs.realpathSync(dir);
  }

  it('resolves cwd from workerData before env', () => {
    const workerDir = makeTempDir();
    const envDir = makeTempDir();

    expect(
      resolveWorkerRuntimeCwd({
        workerData: { workerRuntime: { cwd: workerDir } },
        env: { [ENV_WORKER_CWD]: envDir },
      }),
    ).toBe(workerDir);
  });

  it('resolves cwd from the branded environment when workerData has no cwd', () => {
    const envDir = makeTempDir();

    expect(
      resolveWorkerRuntimeCwd({
        workerData: {},
        env: { [ENV_WORKER_CWD]: envDir },
      }),
    ).toBe(envDir);
  });

  it('installs a logical cwd/chdir shim and syncs shell cwd state', () => {
    const root = makeTempDir();
    const child = path.join(root, 'child');
    fs.mkdirSync(child);

    shim = installWorkerCwdShim({ cwd: root });

    expect(process.cwd()).toBe(root);
    expect(getCwd()).toBe(root);
    expect(getOriginalCwd()).toBe(root);
    expect(process.env['PWD']).toBe(root);

    process.chdir('child');

    expect(process.cwd()).toBe(child);
    expect(getCwd()).toBe(child);
    expect(getOriginalCwd()).toBe(child);
    expect(process.env['PWD']).toBe(child);
  });

  it('preserves a logical cwd that points to a symlinked directory', () => {
    const physicalRoot = makeTempDir();
    const logicalParent = makeTempDir();
    const logicalRoot = path.join(logicalParent, 'logical-root');
    fs.symlinkSync(
      physicalRoot,
      logicalRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    shim = installWorkerCwdShim({ cwd: logicalRoot });

    expect(process.cwd()).toBe(logicalRoot);
    expect(shim.getCwd()).toBe(logicalRoot);
    expect(process.env['PWD']).toBe(logicalRoot);
  });

  it('copies missing transcript project data from the realpath bucket to the logical bucket', () => {
    const physicalRoot = makeTempDir();
    const logicalParent = makeTempDir();
    const logicalRoot = path.join(logicalParent, 'logical-root');
    fs.symlinkSync(
      physicalRoot,
      logicalRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const configHomeDir = path.join(makeTempDir(), 'config');
    const realProjectDir = path.join(
      configHomeDir,
      'projects',
      sanitizePath(physicalRoot),
    );
    const logicalProjectDir = path.join(
      configHomeDir,
      'projects',
      sanitizePath(logicalRoot),
    );
    fs.mkdirSync(realProjectDir, { recursive: true });
    fs.mkdirSync(logicalProjectDir, { recursive: true });
    fs.writeFileSync(path.join(realProjectDir, 'old-session.jsonl'), 'real');
    fs.writeFileSync(path.join(realProjectDir, 'shared-session.jsonl'), 'real');
    fs.writeFileSync(
      path.join(logicalProjectDir, 'shared-session.jsonl'),
      'logical',
    );

    shim = installWorkerCwdShim({ cwd: logicalRoot, configHomeDir });

    expect(
      fs.readFileSync(
        path.join(logicalProjectDir, 'old-session.jsonl'),
        'utf8',
      ),
    ).toBe('real');
    expect(
      fs.readFileSync(
        path.join(logicalProjectDir, 'shared-session.jsonl'),
        'utf8',
      ),
    ).toBe('logical');
    expect(process.cwd()).toBe(logicalRoot);
  });

  it('throws like process.chdir when the target does not exist', () => {
    const root = makeTempDir();
    shim = installWorkerCwdShim({ cwd: root });

    expect(() => process.chdir('missing')).toThrow(/ENOENT|no such file/i);
  });
});
