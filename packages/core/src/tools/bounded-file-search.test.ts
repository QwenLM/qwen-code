/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Config } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { getBuiltinRipgrep, runBoundedRipgrep } from '../utils/ripgrepUtils.js';
import { LSTool } from './ls.js';
import { RipGrepTool } from './ripGrep.js';

const subprocesses = vi.hoisted(() => ({
  onSpawn: undefined as (() => void) | undefined,
  active: new Set<import('node:child_process').ChildProcess>(),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      subprocesses.active.add(child);
      child.once('spawn', () => subprocesses.onSpawn?.());
      child.once('close', () => subprocesses.active.delete(child));
      return child;
    },
  };
});

const workerAssets = vi.hoisted(() => ({ directory: '', useBundle: true }));
vi.mock('../utils/bundlePaths.js', async (original) => {
  const actual = await original<typeof import('../utils/bundlePaths.js')>();
  return {
    ...actual,
    resolveBundleDir: (url: string) =>
      workerAssets.useBundle && url.endsWith('/ls.ts')
        ? workerAssets.directory
        : actual.resolveBundleDir(url),
  };
});

describe('bounded file search tools (real subprocess and worker)', () => {
  let temporary: string;
  let root: string;
  let config: Config;
  let readCache: FileReadCache;
  const signal = () => new AbortController().signal;
  const grep = (timeout = 5000) =>
    new RipGrepTool(config, {
      containmentRoot: root,
      executionTimeoutMs: timeout,
    });
  const ls = (timeout = 5000) =>
    new LSTool(config, { containmentRoot: root, executionTimeoutMs: timeout });

  beforeAll(async () => {
    workerAssets.directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ls-worker-assets-'),
    );
    const { build } = await import('esbuild');
    await build({
      entryPoints: [path.join(import.meta.dirname, 'ls-search-worker.ts')],
      outfile: path.join(workerAssets.directory, 'ls-search-worker.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    expect(getBuiltinRipgrep()).toBeTruthy();
    await fs.access(getBuiltinRipgrep()!);
  }, 30000);

  beforeEach(async () => {
    subprocesses.onSpawn = undefined;
    workerAssets.useBundle = true;
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-search-'));
    root = path.join(temporary, 'session');
    await fs.mkdir(root);
    readCache = new FileReadCache();
    const discovery = new FileDiscoveryService(root);
    config = {
      getTargetDir: () => root,
      getFileService: () => discovery,
      getWorkspaceContext: () => createMockWorkspaceContext(root),
      getTruncateToolOutputThreshold: () => 1000000,
      getTruncateToolOutputLines: () => 1000,
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      }),
      getFileReadCache: () => readCache,
      getFileReadCacheDisabled: () => false,
      getUsageStatisticsEnabled: () => false,
    } as unknown as Config;
  });

  afterEach(async () => fs.rm(temporary, { recursive: true, force: true }));
  afterAll(async () =>
    fs.rm(workerAssets.directory, { recursive: true, force: true }),
  );

  it('searches files and directories with brace and exclusion globs without rewriting match content', async () => {
    const witness = `Needle ${root}/literal-path   `;
    await fs.writeFile(path.join(root, 'a.ts'), witness);
    await fs.writeFile(path.join(root, 'b.tsx'), 'needle');
    await fs.writeFile(path.join(root, 'c.js'), 'needle');
    const result = await grep()
      .build({ pattern: 'NEEDLE', glob: '*.{ts,tsx}' })
      .execute(signal());
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(`a.ts:1:${witness}`);
    expect(result.llmContent).toContain('b.tsx:1:needle');
    expect(result.llmContent).not.toContain('c.js:');
    expect(result.collectedFilePaths?.sort()).toEqual([
      path.join(root, 'a.ts'),
      path.join(root, 'b.tsx'),
    ]);
    const file = await grep()
      .build({ pattern: 'needle', path: 'a.ts' })
      .execute(signal());
    expect(file.llmContent).toContain(`a.ts:1:${witness}`);
    const excluded = await grep()
      .build({ pattern: 'needle', glob: '!*.tsx' })
      .execute(signal());
    expect(excluded.llmContent).not.toContain('b.tsx:');
    expect(readCache.size()).toBe(0);
  });

  it('enforces relative roots, ignores and outward symlinks for both tools', async () => {
    const sibling = path.join(temporary, 'sibling');
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'secret.ts'), 'needle');
    await fs.symlink(sibling, path.join(root, 'outward'), 'dir');
    await fs.symlink(
      path.join(sibling, 'secret.ts'),
      path.join(root, 'secret-link.ts'),
    );
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.gitignore'), 'git-hidden.ts\n');
    await fs.writeFile(path.join(root, '.qwenignore'), 'qwen-hidden.ts\n');
    await fs.writeFile(path.join(root, 'git-hidden.ts'), 'needle');
    await fs.writeFile(path.join(root, 'qwen-hidden.ts'), 'needle');
    await fs.writeFile(path.join(root, 'safe.ts'), 'needle');
    for (const tool of [grep(), ls()]) {
      for (const requested of [
        '../sibling',
        'x/../sibling',
        sibling,
        'C:\\outside',
      ]) {
        expect(() =>
          tool.build({ pattern: 'needle', path: requested }),
        ).toThrow('relative');
      }
      const escaped = await tool
        .build({ pattern: 'needle', path: 'outward' })
        .execute(signal());
      expect(escaped.error).toBeDefined();
      expect(escaped.llmContent).not.toContain('secret.ts');
    }
    const found = await grep().build({ pattern: 'needle' }).execute(signal());
    expect(found.collectedFilePaths).toEqual([path.join(root, 'safe.ts')]);
    const listed = await ls().build({}).execute(signal());
    expect(listed.llmContent).toContain('[LINK] outward');
    expect(listed.llmContent).toContain('[LINK] secret-link.ts');
    expect(listed.llmContent).not.toContain('qwen-hidden.ts');
    expect(listed.llmContent).not.toContain('git-hidden.ts');
  });

  it('retains all collected grep paths beyond the display limit', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'needle');
    await fs.writeFile(path.join(root, 'b.ts'), 'needle');
    const found = await grep()
      .build({ pattern: 'needle', limit: 1 })
      .execute(signal());
    expect(found.returnDisplay).toContain('truncated');
    expect(found.resultFilePaths).toHaveLength(1);
    expect(found.collectedFilePaths?.sort()).toEqual([
      path.join(root, 'a.ts'),
      path.join(root, 'b.ts'),
    ]);
    expect(() => grep().build({ pattern: 'needle', limit: 1001 })).toThrow();
  });

  it('uses the default 200 grep limit and bounds encoded multibyte output', async () => {
    await fs.writeFile(
      path.join(root, 'many.ts'),
      Array.from({ length: 210 }, () => 'needle').join('\n'),
    );
    const limited = await grep().build({ pattern: 'needle' }).execute(signal());
    expect(String(limited.llmContent).match(/many\.ts:/g)).toHaveLength(200);
    await fs.writeFile(
      path.join(root, 'long.ts'),
      'needle' + '文'.repeat(30000),
    );
    const result = await grep()
      .build({ pattern: 'needle', path: 'long.ts' })
      .execute(signal());
    expect(result.error).toBeUndefined();
    const {
      resultFilePaths: _visible,
      collectedFilePaths: _collected,
      ...payload
    } = result;
    expect(
      Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    ).toBeLessThanOrEqual(48 * 1024);
    expect(result.llmContent).toContain('Output truncated');
    expect(result.collectedFilePaths).toEqual([path.join(root, 'long.ts')]);
  });

  it('does not turn errors or the raw output cap into no matches', async () => {
    await fs.writeFile(path.join(root, 'large.txt'), 'needle\n'.repeat(40000));
    const result = await grep().build({ pattern: 'needle' }).execute(signal());
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('1 MiB');
    expect(result.llmContent).not.toContain('No matches');
    const invalid = await grep().build({ pattern: '[' }).execute(signal());
    expect(invalid.error).toBeDefined();
    const absent = await grep()
      .build({ pattern: 'unfindable' })
      .execute(signal());
    expect(absent.error).toBeUndefined();
    expect(absent.llmContent).toContain('No matches found');
  });

  it('lists direct entries, directories first, and retains undisplayed ownership paths', async () => {
    await fs.mkdir(path.join(root, 'z-directory'));
    await fs.writeFile(path.join(root, 'z-directory', 'nested.txt'), 'nested');
    await Promise.all(
      Array.from({ length: 110 }, (_, i) =>
        fs.writeFile(
          path.join(root, `file-${String(i).padStart(3, '0')}.txt`),
          '',
        ),
      ),
    );
    const result = await ls().build({}).execute(signal());
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('---\n[DIR] z-directory\nfile-000.txt');
    expect(result.llmContent).not.toContain('nested.txt');
    expect(result.resultFilePaths).toHaveLength(100);
    expect(result.collectedFilePaths).toHaveLength(111);
    expect(result.llmContent).toContain('incomplete');
  });

  it('loads the source directory worker and preserves special file names', async () => {
    workerAssets.useBundle = false;
    const name =
      process.platform === 'win32'
        ? 'space file文.ts'
        : 'colon:file\nwith-line.ts';
    await fs.writeFile(path.join(root, name), 'needle');
    const listed = await ls().build({}).execute(signal());
    expect(listed.error).toBeUndefined();
    expect(listed.collectedFilePaths).toEqual([path.join(root, name)]);
    expect(listed.llmContent).toContain(name);
    const searched = await grep()
      .build({ pattern: 'needle' })
      .execute(signal());
    expect(searched.error).toBeUndefined();
    expect(searched.llmContent).toContain(`${name}:1:needle`);
    expect(searched.collectedFilePaths).toEqual([path.join(root, name)]);
  });

  it('caps directory collection at 1000 without claiming a complete count', async () => {
    await Promise.all(
      Array.from({ length: 1010 }, (_, i) =>
        fs.writeFile(path.join(root, `file-${i}.txt`), ''),
      ),
    );
    const result = await ls().build({}).execute(signal());
    expect(result.error).toBeUndefined();
    expect(result.collectedFilePaths).toHaveLength(1000);
    expect(result.resultFilePaths).toHaveLength(100);
    expect(result.llmContent).toContain('results are incomplete');
  });

  it('terminates a timed out directory worker and permits a subsequent call', async () => {
    await fs.writeFile(path.join(root, 'safe.txt'), 'safe');
    const timed = await ls(1).build({}).execute(signal());
    expect(timed.error).toBeDefined();
    expect(timed.llmContent).toContain('exceeded');
    const controller = new AbortController();
    const pending = ls().build({}).execute(controller.signal);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.error).toBeDefined();
    expect(cancelled.llmContent).toContain('cancelled');
    const next = await ls().build({}).execute(signal());
    expect(next.error).toBeUndefined();
    expect(next.llmContent).toContain('safe.txt');
  });

  it('terminates rg on deadline or cancellation and permits the next search', async () => {
    await fs.writeFile(
      path.join(root, 'large.txt'),
      'x'.repeat(20 * 1024 * 1024),
    );
    const args = [
      '--no-config',
      '--no-follow',
      '--json',
      '--regexp',
      'absent',
      root,
    ];
    const timed = await runBoundedRipgrep(args, signal(), 1);
    expect(timed.error?.message).toContain('exceeded');
    expect(subprocesses.active.size).toBe(0);
    const controller = new AbortController();
    subprocesses.onSpawn = () => controller.abort();
    const pending = runBoundedRipgrep(args, controller.signal, 5000);
    const cancelled = await pending;
    subprocesses.onSpawn = undefined;
    expect(cancelled.error?.message).toContain('cancelled');
    expect(subprocesses.active.size).toBe(0);
    const next = await grep().build({ pattern: 'absent' }).execute(signal());
    expect(next.error).toBeUndefined();
  });
});
