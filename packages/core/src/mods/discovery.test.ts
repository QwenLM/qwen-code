/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModSource, loadModDependencies } from './discovery.js';
import { MOD_MAX_BYTES } from './types.js';

describe('Mod discovery', () => {
  let root: string;
  const write = async (file: string, value: unknown) => {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-mod-discovery-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads the source without executing module code', async () => {
    await write('hooks/hooks.json', { modules: ['./register.js'], hooks: {} });
    await write('hooks/register.js', 'throw new Error("MUST NOT EXECUTE");');
    expect((await loadModSource(root))?.source).toContain('MUST NOT EXECUTE');
  });

  it('keeps a converted Claude custom manifest relative to its original file', async () => {
    await write('qwen-extension.json', { name: 'converted', hooks: {} });
    await write('.claude-plugin/plugin.json', {
      name: 'converted',
      hooks: './custom/hooks.json',
    });
    await write('custom/hooks.json', { modules: ['./entry.mjs'] });
    await write('custom/entry.mjs', 'export function register() {}');
    expect((await loadModSource(root))?.source).toContain(
      'export function register',
    );
  });

  it('ignores ordinary extensions without modules', async () => {
    expect(await loadModSource(root)).toBeUndefined();
    await write('hooks/hooks.json', { hooks: { SessionStart: [] } });
    expect(await loadModSource(root)).toBeUndefined();
  });

  it.each(['absolute', 'relative-outside'])(
    'leaves %s Qwen hook manifests to the classic hook loader',
    async (kind) => {
      await write('qwen-extension.json', {
        name: 'classic',
        hooks:
          kind === 'absolute'
            ? path.join(root, 'classic-hooks.json')
            : '../classic-hooks.json',
      });
      await write('classic-hooks.json', { hooks: { SessionStart: [] } });
      expect(await loadModSource(root)).toBeUndefined();
    },
  );

  it.each(['absolute', 'relative-outside'])(
    'skips ignored %s Claude hook manifests without probing outside files',
    async (kind) => {
      const outside = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-mod-outside-')),
      );
      const realRoot = await fs.realpath(root);
      const hooks = path.join(outside, 'classic-hooks.json');
      const probe = vi.spyOn(fs, 'lstat');
      try {
        await fs.writeFile(hooks, 'Not JSON; this file must not be read.');
        await write('qwen-extension.json', { name: 'classic' });
        await write('.claude-plugin/plugin.json', {
          name: 'classic',
          hooks: kind === 'absolute' ? hooks : path.relative(realRoot, hooks),
        });
        await expect(loadModSource(root)).resolves.toBeUndefined();
        expect(probe).not.toHaveBeenCalledWith(hooks);
      } finally {
        probe.mockRestore();
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('uses the Qwen hooks path ahead of an ignored Claude hooks path', async () => {
    await write('qwen-extension.json', {
      name: 'mixed',
      hooks: './custom/hooks.json',
    });
    await write('.claude-plugin/plugin.json', {
      name: 'mixed',
      hooks: '../classic-hooks.json',
    });
    await write('custom/hooks.json', { modules: ['./entry.js'] });
    await write('custom/entry.js', 'export function register() {}');
    expect((await loadModSource(root))?.source).toBe(
      'export function register() {}',
    );
  });

  it.each([
    [[], /one relative/],
    [['./a.js', './b.js'], /one relative/],
    [['./entry.tsx'], /one relative/],
    [['/tmp/entry.js'], /one relative/],
    [['../../escape.js'], /inside/],
  ])('rejects invalid modules %j', async (modules, error) => {
    await write('hooks/hooks.json', { modules });
    await expect(loadModSource(root)).rejects.toThrow(error);
  });

  it('rejects directory and symlink entries', async () => {
    await write('hooks/hooks.json', { modules: ['./entry.js'] });
    await fs.mkdir(path.join(root, 'hooks/entry.js'));
    await expect(loadModSource(root)).rejects.toThrow(/regular file/);
    await fs.rmdir(path.join(root, 'hooks/entry.js'));
    await write('other.js', 'export function register() {}');
    await fs.symlink(
      path.join(root, 'other.js'),
      path.join(root, 'hooks/entry.js'),
    );
    await expect(loadModSource(root)).rejects.toThrow(/symbolic links/);
  });

  it('rejects oversized files', async () => {
    await write('hooks/hooks.json', { modules: ['./entry.js'] });
    await write('hooks/entry.js', ' '.repeat(MOD_MAX_BYTES + 1));
    await expect(loadModSource(root)).rejects.toThrow(/256 KiB/);
  });

  it('reads ordinary provider dependencies without probing an external hooks path', async () => {
    await write('qwen-extension.json', {
      hooks: '../outside/hooks.json',
      dependencies: ['base.v2'],
    });
    expect(await loadModSource(root)).toBeUndefined();
    expect(await loadModDependencies(root)).toEqual([{ name: 'base.v2' }]);
  });

  it('preserves configuration and parses dependencies without executing TypeScript', async () => {
    await write('hooks/hooks.json', { modules: ['./entry.ts'] });
    await write('hooks/entry.ts', 'throw new Error("MUST NOT EXECUTE");');
    const userConfig = {
      greeting: { type: 'string', title: 'Greeting', description: 'Greeting' },
    };
    await write('.claude-plugin/plugin.json', {
      userConfig,
      dependencies: ['base@market', { name: 'other', version: '^1.0.0' }],
    });
    const definition = await loadModSource(root);
    expect(definition?.userConfig).toEqual(userConfig);
    expect(definition?.dependencies).toEqual([
      { name: 'base', marketplace: 'market' },
      { name: 'other', version: '^1.0.0' },
    ]);
    expect(definition?.entry).toBe(
      path.join(await fs.realpath(root), 'hooks/entry.ts'),
    );
  });
});
