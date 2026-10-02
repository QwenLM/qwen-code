/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookCommandCgroup } from './hook-command-cgroup.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hook-launcher-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('managed command launcher environment', () => {
  it('keeps environment values out of argv and applies them only after membership', async () => {
    const preload = join(directory, 'preload.cjs');
    const marker = join(directory, 'preloaded');
    await writeFile(
      preload,
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, fs.readFileSync(${JSON.stringify(join(directory, 'cgroup.procs'))}, 'utf8') + '\\n');`,
    );
    // This exercises the real launcher with a membership-file stand-in,
    // without claiming that the temporary directory is a cgroup.
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const env = {
      SERVICE_TOKEN: 'fake-secret-"quoted"\n非真实凭据',
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      PATH: '/deployment-command-path',
    };
    const launch = unit.launch(
      process.execPath,
      [
        '--eval',
        'process.stdout.write(JSON.stringify({ token: process.env.SERVICE_TOKEN, path: process.env.PATH }));',
      ],
      env,
    );
    expect(launch.args.join('\n')).not.toContain('fake-secret');
    expect(launch.env).not.toHaveProperty('NODE_OPTIONS');
    const result = spawnSync(launch.executable, launch.args, {
      env: launch.env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      token: env.SERVICE_TOKEN,
      path: env.PATH,
    });
    expect(await readFile(marker, 'utf8')).toBe(`${result.pid}\n`);
  });

  it('does not apply command environment when membership fails', async () => {
    const preload = join(directory, 'preload.cjs');
    const marker = join(directory, 'forbidden');
    await writeFile(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      join(directory, 'missing'),
    ]);
    const launch = unit.launch(process.execPath, ['--eval', ''], {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    });
    const result = spawnSync(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.output[3]).toBe('unavailable\n');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
