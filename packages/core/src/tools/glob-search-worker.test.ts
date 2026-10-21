/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
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
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { GlobTool } from './glob.js';
import { ToolErrorType } from './tool-error.js';

const globWorkerAssets = vi.hoisted(() => ({ directory: '' }));
vi.mock('../utils/bundlePaths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/bundlePaths.js')>()),
  resolveBundleDir: () => globWorkerAssets.directory,
}));

describe('bounded Glob search (real worker)', () => {
  let temporary: string;
  let root: string;
  let config: Config;

  beforeAll(async () => {
    globWorkerAssets.directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'glob-worker-asset-'),
    );
    const { build } = await import('esbuild');
    await build({
      entryPoints: [path.join(import.meta.dirname, 'glob-search-worker.ts')],
      outfile: path.join(globWorkerAssets.directory, 'glob-search-worker.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (globWorkerAssets.directory)
      await fs.rm(globWorkerAssets.directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-worker-test-'));
    root = path.join(temporary, 'session');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'safe.ts'), 'safe');
    await fs.writeFile(
      path.join(root, 'a'.repeat(32) + '.ts'),
      'matcher witness',
    );
    config = {
      getTargetDir: () => root,
      getTruncateToolOutputLines: () => 1000,
      getWorkspaceContext: () => createMockWorkspaceContext(root),
      getFileService: () => new FileDiscoveryService(root),
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      }),
    } as unknown as Config;
  });

  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const tool = (executionTimeoutMs = 10_000) =>
    new GlobTool(config, {
      containmentRoot: root,
      executionTimeoutMs,
    });

  it('finds the same files through real and symlinked search paths', async () => {
    const realRoot = await fs.realpath(root);
    const alias = path.join(temporary, 'session-alias');
    await fs.symlink(realRoot, alias, 'junction');
    const aliasTool = new GlobTool(
      {
        ...config,
        getTargetDir: () => alias,
        getWorkspaceContext: () => createMockWorkspaceContext(realRoot),
        getFileService: () => new FileDiscoveryService(alias),
      } as unknown as Config,
      { containmentRoot: alias, executionTimeoutMs: 10_000 },
    );
    for (const searchPath of [undefined, alias]) {
      const result = await aliasTool
        .build({ pattern: '**/safe.ts', path: searchPath })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(
        await Promise.all(
          (result.collectedFilePaths ?? []).map((file) => fs.realpath(file)),
        ),
      ).toEqual([path.join(realRoot, 'safe.ts')]);
    }
  });

  it.each(['+(?|?|?)Z', '*?'.repeat(20) + 'Z'])(
    'terminates expensive matching for %s and permits the next search',
    async (pattern) => {
      const controller = new AbortController();
      // Keeps a missing-deadline regression bounded while retaining its wrong outcome.
      const fallback = setTimeout(
        () => controller.abort(new Error('outer test deadline')),
        5_000,
      );
      let responded = false;
      let responsiveBeforeResult = false;
      const heartbeat = setTimeout(() => {
        responsiveBeforeResult = !responded;
      }, 50);
      try {
        const result = await tool(500)
          .build({ pattern })
          .execute(controller.signal);
        responded = true;
        expect(responsiveBeforeResult).toBe(true);
        expect(result.error?.type).toBe(ToolErrorType.GLOB_EXECUTION_ERROR);
        expect(result.llmContent).toContain(
          'Glob search exceeded 0.5 seconds.',
        );
        expect(result.llmContent).not.toContain(root);
        const next = await tool()
          .build({ pattern: 'safe.ts' })
          .execute(new AbortController().signal);
        expect(next.error).toBeUndefined();
        expect(next.collectedFilePaths).toEqual([path.join(root, 'safe.ts')]);
      } finally {
        clearTimeout(fallback);
        clearTimeout(heartbeat);
      }
    },
    15_000,
  );

  it('loads the TypeScript worker in source development mode', async () => {
    const script = `
      import { GlobTool } from ${JSON.stringify(new URL('./glob.ts', import.meta.url).href)};
      import { FileDiscoveryService } from ${JSON.stringify(new URL('../services/fileDiscoveryService.ts', import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      const config = {
        getTargetDir: () => root,
        getTruncateToolOutputLines: () => 1000,
        getWorkspaceContext: () => ({ getDirectories: () => [root] }),
        getFileService: () => new FileDiscoveryService(root),
        getFileFilteringOptions: () => ({ respectGitIgnore: true, respectQwenIgnore: true }),
      };
      const result = await new GlobTool(config, {
        containmentRoot: root, executionTimeoutMs: 10000,
      }).build({ pattern: 'safe.ts' }).execute(new AbortController().signal);
      process.stdout.write(JSON.stringify(result));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        '--input-type=module',
        '--eval',
        script,
      ],
      { timeout: 30_000, encoding: 'utf8' },
    );
    const result = JSON.parse(stdout);
    expect(result.error).toBeUndefined();
    expect(result.collectedFilePaths).toEqual([path.join(root, 'safe.ts')]);
  }, 35_000);

  it('cancels a matching worker and permits the next search', async () => {
    const controller = new AbortController();
    const cancel = setTimeout(
      () => controller.abort(new Error('test cancellation')),
      300,
    );
    try {
      const result = await tool()
        .build({ pattern: '+(?|?|?)Z' })
        .execute(controller.signal);
      expect(result.error?.type).toBe(ToolErrorType.GLOB_EXECUTION_ERROR);
      expect(result.llmContent).toContain('test cancellation');
      const next = await tool()
        .build({ pattern: 'safe.ts' })
        .execute(new AbortController().signal);
      expect(next.error).toBeUndefined();
      expect(next.collectedFilePaths).toEqual([path.join(root, 'safe.ts')]);
    } finally {
      clearTimeout(cancel);
    }
  }, 15_000);

  it('retains ignore filtering and prunes outward traversal in the worker', async () => {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.gitignore'), 'git-hidden.ts\n');
    await fs.writeFile(path.join(root, '.qwenignore'), 'qwen-hidden.ts\n');
    await fs.writeFile(path.join(root, 'git-hidden.ts'), 'hidden');
    await fs.writeFile(path.join(root, 'qwen-hidden.ts'), 'hidden');
    const sibling = path.join(temporary, 'sibling');
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'secret.ts'), 'outside');
    await fs.symlink(sibling, path.join(root, 'outside'), 'dir');
    const result = await tool()
      .build({ pattern: '{*.ts,../sibling/*.ts,outside/*.ts}' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.collectedFilePaths?.sort()).toEqual(
      [
        path.join(root, 'a'.repeat(32) + '.ts'),
        path.join(root, 'safe.ts'),
      ].sort(),
    );
    expect(result.llmContent).not.toContain('secret.ts');
  }, 15_000);
});
