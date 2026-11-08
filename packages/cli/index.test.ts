/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const wrapper = transformSync(
  readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'esm' },
).code;

describe.each([
  { label: 'CLI', args: [], module: 'src/cli.js', entry: 'runCliEntryPoint' },
  {
    label: 'worker',
    args: ['--workspace-recovery-worker'],
    module: 'src/serve/workspace-recovery-worker.js',
    entry: 'runWorkspaceRecoveryWorker',
  },
])('$label wrapper startup', ({ label, args, module, entry }) => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'qwen-wrapper-startup-'));
    mkdirSync(path.join(directory, 'src', 'serve'), { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(directory, 'index.js'), wrapper);
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it.each(['throw', 'warn', 'none'])(
    'fails a missing import under %s rejection handling',
    (mode) => {
      const result = spawnSync(
        process.execPath,
        [`--unhandled-rejections=${mode}`, 'index.js', ...args],
        {
          cwd: directory,
          env: { ...process.env, NODE_OPTIONS: '' },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Cannot find module');
    },
  );

  it.each(['throw', 'warn', 'none'])(
    'fails module evaluation under %s rejection handling',
    (mode) => {
      writeFileSync(
        path.join(directory, module),
        "throw new Error('fixture module failed');",
      );
      const result = spawnSync(
        process.execPath,
        [`--unhandled-rejections=${mode}`, 'index.js', ...args],
        {
          cwd: directory,
          env: { ...process.env, NODE_OPTIONS: '' },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('fixture module failed');
    },
  );

  it('runs the selected entry successfully', () => {
    writeFileSync(
      path.join(directory, module),
      `export async function ${entry}() { process.stdout.write('${label}'); }`,
    );
    const result = spawnSync(process.execPath, ['index.js', ...args], {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(label);
    expect(result.stderr).toBe('');
  });

  it('terminates failed module evaluation with active handles', () => {
    writeFileSync(
      path.join(directory, module),
      "setInterval(() => {}, 1000); throw new Error('fixture module failed');",
    );
    const result = spawnSync(process.execPath, ['index.js', ...args], {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('fixture module failed');
  });
});
