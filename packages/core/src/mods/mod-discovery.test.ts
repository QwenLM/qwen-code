/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverMod, readModFile, splitModHooks } from './mod-discovery.js';

let root: string;
async function write(file: string, value: unknown) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-mod-discovery-'));
  await write('qwen-extension.json', { name: 'test', version: '1' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('discoverMod', () => {
  it('reports absent without creating hooks or inspecting source', async () => {
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'absent',
      diagnostics: [],
    });
    await expect(fs.stat(path.join(root, 'hooks'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('finds canonical modules independently of inline classic hooks', async () => {
    const manifest = {
      name: 'test',
      hooks: { SessionStart: [] },
      userConfig: {
        token: {
          type: 'string',
          title: 'Token',
          description: 'Token',
          sensitive: true,
          default: '${HOME}',
        },
      },
    };
    await write('hooks/hooks.json', {
      modules: ['./entry.mjs'],
      hooks: { PostToolUse: [] },
    });
    await write('hooks/entry.mjs', 'while (true) {}');
    const result = await discoverMod(root, manifest);
    expect(result).toMatchObject({
      discovery: 'declared',
      entry: 'hooks/entry.mjs',
      userConfig: manifest.userConfig,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('selects Qwen over leftover Claude manifests', async () => {
    await write('.claude-plugin/plugin.json', {
      name: 'claude',
      hooks: { modules: ['bad.mjs'] },
    });
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'absent',
      diagnostics: [],
    });
    await fs.rm(path.join(root, 'qwen-extension.json'));
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'invalid',
      diagnostics: [
        expect.objectContaining({ code: 'MOD_UNSUPPORTED_LOCATION' }),
      ],
    });
  });

  it('does not give Agent Plugins Mod semantics', async () => {
    await write('plugin.json', {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'agent',
    });
    await write('hooks/hooks.json', { modules: ['entry.mjs'] });
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'absent',
      diagnostics: [],
    });
  });

  it('preserves Gemini and Qoder priority over a raw Claude plugin', async () => {
    await fs.rm(path.join(root, 'qwen-extension.json'));
    await write('.claude-plugin/plugin.json', { name: 'claude' });
    await write('hooks/hooks.json', { modules: ['entry.mjs'] });
    await write('hooks/entry.mjs', 'export function register() {}');
    await write('gemini-extension.json', { name: 'gemini', version: '1' });
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'absent',
      diagnostics: [],
    });
    await fs.rm(path.join(root, 'gemini-extension.json'));
    await write('.qoder-plugin/plugin.json', { name: 'qoder' });
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'absent',
      diagnostics: [],
    });
    await write('qwen-extension.json', { name: 'qwen' });
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'declared',
      entry: 'hooks/entry.mjs',
    });
  });

  it('does not bypass the Agent Plugins priority gate for an escaping root manifest', async () => {
    const external = `${root}-agent.json`;
    await fs.writeFile(
      external,
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'agent',
      }),
    );
    await fs.symlink(external, path.join(root, 'plugin.json'));
    await write('hooks/hooks.json', { modules: ['entry.mjs'] });
    await write('hooks/entry.mjs', 'export function register() {}');
    try {
      expect(await discoverMod(root)).toMatchObject({
        discovery: 'invalid',
        diagnostics: [
          expect.objectContaining({
            code: 'MOD_PATH_OUTSIDE',
            file: 'plugin.json',
          }),
        ],
      });
    } finally {
      await fs.rm(external);
    }
  });

  it.each([[], ['one.mjs', 'two.mjs'], 'one.mjs', {}, ['']])(
    'rejects invalid modules %#',
    async (modules) => {
      await write('hooks/hooks.json', { modules });
      expect((await discoverMod(root)).diagnostics).toContainEqual(
        expect.objectContaining({ code: 'MOD_MODULES_INVALID' }),
      );
    },
  );

  it('diagnoses modules in custom hook files and inline arrays', async () => {
    await write('extra/hooks.json', { modules: ['entry.mjs'] });
    const result = await discoverMod(root, {
      hooks: ['extra/hooks.json', { modules: ['entry.mjs'] }],
    });
    expect(result.discovery).toBe('invalid');
    expect(
      result.diagnostics.filter(
        (item) => item.code === 'MOD_UNSUPPORTED_LOCATION',
      ),
    ).toHaveLength(2);
  });

  it('accepts a canonical file also named by the manifest', async () => {
    await write('hooks/hooks.json', { modules: ['entry.mjs'] });
    await write('hooks/entry.mjs', 'export function register() {}');
    expect(
      await discoverMod(root, { hooks: './hooks/hooks.json' }),
    ).toMatchObject({ discovery: 'declared', diagnostics: [] });
  });

  it('rejects array forms referencing canonical modules', async () => {
    await write('hooks/hooks.json', { modules: ['entry.mjs'] });
    await write('hooks/entry.mjs', 'export function register() {}');
    expect(
      (await discoverMod(root, { hooks: ['./hooks/hooks.json'] })).diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: 'MOD_UNSUPPORTED_LOCATION' }),
    );
  });

  it('does not invent a Mod from an unreadable legacy custom hooks path', async () => {
    expect(
      await discoverMod(
        root,
        { hooks: '/not/a/local/package/hooks.json' },
        { strict: false },
      ),
    ).toMatchObject({ discovery: 'absent', diagnostics: [] });
  });

  it('cannot prove absence when explicitly validating unreadable custom hooks', async () => {
    await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
    for (const hooks of [
      '/not/a/local/package/hooks.json',
      'missing/hooks.json',
      'outside/hooks.json',
      './hooks/hooks.json',
    ]) {
      expect(await discoverMod(root, { hooks })).toMatchObject({
        discovery: 'invalid',
        diagnostics: [
          expect.objectContaining({ code: 'MOD_ANALYSIS_INCOMPLETE' }),
        ],
      });
    }
  });

  it('does not expose unsafe custom paths in diagnostics', async () => {
    await write('hooks/hooks.json', { modules: ['entry.mjs'] });
    await write('hooks/entry.mjs', 'export function register() {}');
    const result = await discoverMod(root, {
      hooks: 'https://SECRET:user@example.com/hooks.json',
    });
    expect(result.discovery).toBe('invalid');
    expect(JSON.stringify(result.diagnostics)).not.toContain('SECRET');
    expect(result.diagnostics[0]?.file).toBe('qwen-extension.json');
  });

  it('bounds nesting and final diagnostic counts', async () => {
    const nested = Array.from({ length: 140 }).reduce<unknown>(
      (hooks) => ({ hooks }),
      {},
    );
    const limited = await discoverMod(root, { hooks: nested });
    expect(limited.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MOD_ANALYSIS_LIMIT' }),
    );
    const declarations = Array.from({ length: 125 }, () => ({
      modules: ['entry.mjs'],
    }));
    expect(
      (await discoverMod(root, { hooks: declarations })).diagnostics,
    ).toHaveLength(100);
  });

  it('keeps the lexical owning-file base and supports contained parent paths', async () => {
    await write('hooks/hooks.json', { modules: ['../lib/entry.mjs'] });
    await write('lib/entry.mjs', 'export function register() {}');
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'declared',
      entry: 'lib/entry.mjs',
    });
  });

  it('reports missing entries without executing or dropping other declarations', async () => {
    await write('hooks/hooks.json', {
      modules: ['missing.mjs'],
      hooks: { SessionStart: [] },
    });
    expect(await discoverMod(root)).toMatchObject({
      discovery: 'invalid',
      diagnostics: [expect.objectContaining({ code: 'MOD_PATH_MISSING' })],
    });
  });
});

describe('splitModHooks', () => {
  it('filters module metadata from wrapped and flat classic hooks', () => {
    expect(
      splitModHooks({
        modules: ['entry.mjs'],
        description: 'mod',
        hooks: { SessionStart: [] },
      }),
    ).toEqual({ SessionStart: [] });
    expect(
      splitModHooks({
        modules: ['entry.mjs'],
        description: 'mod',
        SessionStart: [],
      }),
    ).toEqual({ SessionStart: [] });
    expect(splitModHooks({ modules: ['entry.mjs'] })).toEqual({});
    expect(splitModHooks(null)).toEqual({});
  });
});

describe('readModFile', () => {
  it.each([
    '../outside',
    '/etc/passwd',
    'https://example.com/a',
    'C:/a',
    'C:\\a',
    '//host/a',
    'entry\u0000.mjs',
  ])('rejects noncontained path forms %#', async (file) => {
    await expect(readModFile(root, file)).rejects.toMatchObject({
      code: 'MOD_PATH_OUTSIDE',
    });
  });

  it('accepts internal symlinks and a linked package root', async () => {
    await write('real/entry.mjs', 'contents');
    await fs.symlink('real/entry.mjs', path.join(root, 'entry.mjs'));
    const link = `${root}-link`;
    await fs.symlink(root, link);
    try {
      expect(await readModFile(link, 'entry.mjs')).toMatchObject({
        text: 'contents',
        realPath: path.join(await fs.realpath(root), 'real/entry.mjs'),
      });
    } finally {
      await fs.rm(link);
    }
  });

  it('rejects outside and dangling links and directories', async () => {
    await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
    await fs.symlink('missing', path.join(root, 'dangling'));
    await fs.mkdir(path.join(root, 'directory'));
    await expect(readModFile(root, 'outside')).rejects.toMatchObject({
      code: 'MOD_PATH_OUTSIDE',
    });
    await expect(readModFile(root, 'dangling')).rejects.toMatchObject({
      code: 'MOD_PATH_MISSING',
    });
    await expect(readModFile(root, 'directory')).rejects.toMatchObject({
      code: 'MOD_PATH_NOT_FILE',
    });
  });

  it('enforces a byte limit and returns safe errors', async () => {
    await write('file.mjs', 'ABCDE');
    await expect(readModFile(root, 'file.mjs', 4)).rejects.toMatchObject({
      code: 'MOD_ANALYSIS_LIMIT',
    });
    expect(await readModFile(root, 'file.mjs', 5)).toMatchObject({
      text: 'ABCDE',
    });
    await expect(readModFile(root, 'SECRET_PATH')).rejects.toThrow(
      'A Mod file is missing.',
    );
  });

  it('rejects a file replacement while the handle is being read', async () => {
    await write('entry.mjs', 'original');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      let replaced = false;
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs);
        if (!replaced) {
          replaced = true;
          await fs.rename(
            path.join(root, 'entry.mjs'),
            path.join(root, 'old.mjs'),
          );
          await write('entry.mjs', 'replacement');
        }
        return result;
      });
      return handle;
    });
    await expect(readModFile(root, 'entry.mjs')).rejects.toMatchObject({
      code: 'MOD_ANALYSIS_INCOMPLETE',
    });
  });

  it('bounds the actual read when a file grows after the size check', async () => {
    await write('entry.mjs', 'ABCD');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      let grew = false;
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs);
        if (!grew) {
          grew = true;
          await fs.appendFile(path.join(root, 'entry.mjs'), 'EFGH');
        }
        return result;
      });
      return handle;
    });
    await expect(readModFile(root, 'entry.mjs', 5)).rejects.toMatchObject({
      code: 'MOD_ANALYSIS_LIMIT',
    });
  });
});
