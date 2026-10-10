/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModSource } from './discovery.js';
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
    expect(await loadModSource(root)).toContain('MUST NOT EXECUTE');
  });

  it('keeps a converted Claude custom manifest relative to its original file', async () => {
    await write('qwen-extension.json', { name: 'converted', hooks: {} });
    await write('.claude-plugin/plugin.json', {
      name: 'converted',
      hooks: './custom/hooks.json',
    });
    await write('custom/hooks.json', { modules: ['./entry.mjs'] });
    await write('custom/entry.mjs', 'export function register() {}');
    expect(await loadModSource(root)).toContain('export function register');
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

  it.each([
    [[], /one relative/],
    [['./a.js', './b.js'], /one relative/],
    [['./entry.ts'], /one relative/],
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

  it('rejects oversized files and undeclared configuration support', async () => {
    await write('hooks/hooks.json', { modules: ['./entry.js'] });
    await write('hooks/entry.js', ' '.repeat(MOD_MAX_BYTES + 1));
    await expect(loadModSource(root)).rejects.toThrow(/256 KiB/);
    await write('.claude-plugin/plugin.json', {
      name: 'config',
      userConfig: { greeting: { type: 'string' } },
    });
    await expect(loadModSource(root)).rejects.toThrow(
      /userConfig is not supported/,
    );
  });
});
