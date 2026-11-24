/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getAutoMemoryTopicPath,
  runWithProjectMemoryOwner,
  clearAutoMemoryRootCache,
} from './paths.js';
import {
  createDefaultAutoMemoryIndex,
  createDefaultAutoMemoryMetadata,
  ensureAutoMemoryScaffold,
  readAutoMemoryIndex,
  readAutoMemoryIndexWithStats,
} from './store.js';
import { Storage } from '../config/storage.js';
import { sanitizeCwd } from '../utils/paths.js';

const ENV_KEYS = [
  'QWEN_CODE_MEMORY_LOCAL',
  'QWEN_CODE_MEMORY_BASE_DIR',
  'QWEN_CODE_MEMORY_PROJECT_SCOPE',
  'QWEN_RUNTIME_DIR',
];
const originalEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);

function resetMemoryState() {
  clearAutoMemoryRootCache();
  Storage.setRuntimeBaseDir(null);
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** `<base>/projects/<sanitized dir>/memory`, the managed memory root. */
const managedRoot = (base: string, dir: string) =>
  path.join(base, 'projects', sanitizeCwd(dir), 'memory');

describe('auto-memory storage scaffold', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    resetMemoryState();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-'));
    tempDir = await fs.realpath(tempDir);
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    resetMemoryState();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  /** Drops the local-memory override and points managed memory at `name`. */
  const useRuntimeDir = (name = 'runtime-output') => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    const runtimeDir = path.join(tempDir, name);
    Storage.setRuntimeBaseDir(runtimeDir);
    return runtimeDir;
  };
  /**
   * Creates a git checkout at `<tempDir>/repo` with nested
   * `workspaces/<name>` dirs; returns `[repo, ...workspaces]`.
   */
  const makeCheckout = async (...names: string[]) => {
    const repo = path.join(tempDir, 'repo');
    const workspaces = names.map((name) => path.join(repo, 'workspaces', name));
    await fs.mkdir(repo);
    execFileSync('git', ['init', '--quiet', repo], { stdio: 'pipe' });
    for (const workspace of workspaces) {
      await fs.mkdir(workspace, { recursive: true });
    }
    return [repo, ...workspaces];
  };
  const readIndex = () =>
    fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8');
  const writeIndex = (content: string) =>
    fs.writeFile(getAutoMemoryIndexPath(projectRoot), content, 'utf-8');

  it('builds stable auto-memory paths under project .qwen directory', () => {
    expect(getAutoMemoryRoot(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', 'memory'),
    );
    expect(getAutoMemoryIndexPath(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', 'memory', 'MEMORY.md'),
    );
    expect(getAutoMemoryMetadataPath(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', 'meta.json'),
    );
    expect(getAutoMemoryExtractCursorPath(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', 'extract-cursor.json'),
    );
    expect(getAutoMemoryConsolidationLockPath(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', 'consolidation.lock'),
    );
    expect(getAutoMemoryTopicPath(projectRoot, 'feedback')).toBe(
      path.join(projectRoot, '.qwen', 'memory', 'feedback.md'),
    );
  });

  it('uses the runtime output directory for managed auto-memory', () => {
    const runtimeDir = useRuntimeDir();
    clearAutoMemoryRootCache();

    expect(getAutoMemoryRoot(projectRoot)).toBe(
      managedRoot(runtimeDir, path.resolve(projectRoot)),
    );
  });

  it.each([undefined, 'workspace', 'git-root'])(
    'keys nested workspaces by their exact path with legacy scope %s',
    async (legacyScope) => {
      vi.stubEnv('QWEN_CODE_MEMORY_PROJECT_SCOPE', legacyScope);
      const runtimeDir = useRuntimeDir();
      const [repo, workspaceA, workspaceB] = await makeCheckout(
        'agent',
        'nambz',
      );

      expect(getAutoMemoryRoot(repo)).toBe(managedRoot(runtimeDir, repo));
      expect(getAutoMemoryRoot(workspaceA)).toBe(
        managedRoot(runtimeDir, workspaceA),
      );
      expect(getAutoMemoryRoot(workspaceB)).toBe(
        managedRoot(runtimeDir, workspaceB),
      );
    },
  );

  it('applies the scoped owner and its runtime base only to managed memory', () => {
    useRuntimeDir();
    const owner = {
      cwd: path.join(tempDir, 'owner'),
      memoryBaseDir: path.join(tempDir, 'owner-runtime'),
    };
    const worktree = path.join(tempDir, 'worktree');
    runWithProjectMemoryOwner(
      () => owner,
      () => {
        expect(getAutoMemoryRoot(worktree)).toBe(
          managedRoot(owner.memoryBaseDir, owner.cwd),
        );
        process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
        expect(getAutoMemoryRoot(worktree)).toBe(
          path.join(worktree, '.qwen', 'memory'),
        );
      },
    );
  });

  it('keeps unverified linked worktrees separate from the purported main checkout', async () => {
    const runtimeDir = useRuntimeDir();
    clearAutoMemoryRootCache();

    const main = path.join(tempDir, 'main-repo');
    const worktree = path.join(tempDir, 'wt');
    const worktreeGitDir = path.join(main, '.git', 'worktrees', 'wt');
    await fs.mkdir(worktreeGitDir, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(
      path.join(worktree, '.git'),
      `gitdir: ${worktreeGitDir}`,
    );
    await fs.writeFile(path.join(worktreeGitDir, 'commondir'), '../..');
    await fs.writeFile(
      path.join(worktreeGitDir, 'gitdir'),
      path.join(worktree, '.git'),
    );

    expect(getAutoMemoryRoot(worktree)).toBe(managedRoot(runtimeDir, worktree));
    expect(getAutoMemoryRoot(worktree)).not.toBe(getAutoMemoryRoot(main));
  });

  it('uses QWEN_RUNTIME_DIR for managed auto-memory', () => {
    useRuntimeDir('settings-runtime-output');
    const envRuntimeDir = path.join(tempDir, 'env-runtime-output');
    process.env['QWEN_RUNTIME_DIR'] = envRuntimeDir;
    clearAutoMemoryRootCache();

    expect(getAutoMemoryRoot(projectRoot)).toBe(
      managedRoot(envRuntimeDir, path.resolve(projectRoot)),
    );
  });

  it('does not reuse cached roots across runtime output dirs', () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    const runtimeA = path.join(tempDir, 'runtime-a');
    const runtimeB = path.join(tempDir, 'runtime-b');

    const rootA = Storage.runWithRuntimeBaseDir(runtimeA, undefined, () =>
      getAutoMemoryRoot(projectRoot),
    );
    const rootB = Storage.runWithRuntimeBaseDir(runtimeB, undefined, () =>
      getAutoMemoryRoot(projectRoot),
    );

    expect(rootA).toBe(managedRoot(runtimeA, path.resolve(projectRoot)));
    expect(rootB).toBe(managedRoot(runtimeB, path.resolve(projectRoot)));
  });

  it('keeps QWEN_CODE_MEMORY_BASE_DIR ahead of the runtime output directory', () => {
    useRuntimeDir();
    const memoryBaseDir = path.join(tempDir, 'memory-base');
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = memoryBaseDir;
    clearAutoMemoryRootCache();

    expect(getAutoMemoryRoot(projectRoot)).toBe(
      managedRoot(memoryBaseDir, path.resolve(projectRoot)),
    );
  });

  it('resolves QWEN_CODE_MEMORY_BASE_DIR before using it', () => {
    delete process.env['QWEN_CODE_MEMORY_LOCAL'];
    const memoryBaseDir = path.join(tempDir, 'relative-memory-base');
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.relative(
      process.cwd(),
      memoryBaseDir,
    );
    clearAutoMemoryRootCache();

    expect(getAutoMemoryRoot(projectRoot)).toBe(
      managedRoot(memoryBaseDir, path.resolve(projectRoot)),
    );
  });

  it('creates a complete managed auto-memory scaffold', async () => {
    const now = new Date('2026-04-01T08:00:00.000Z');
    await ensureAutoMemoryScaffold(projectRoot, now);

    expect(await readIndex()).toBe(createDefaultAutoMemoryIndex());

    const metadata = JSON.parse(
      await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8'),
    );
    expect(metadata).toEqual(createDefaultAutoMemoryMetadata(now));

    const cursor = JSON.parse(
      await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
    );
    expect(cursor).toEqual({
      updatedAt: '2026-04-01T08:00:00.000Z',
    });

    await expect(
      fs.stat(getAutoMemoryRoot(projectRoot)),
    ).resolves.toBeDefined();
    await expect(
      fs.access(getAutoMemoryTopicPath(projectRoot, 'user')),
    ).rejects.toThrow();
  });

  it('is idempotent and preserves existing index content', async () => {
    await ensureAutoMemoryScaffold(
      projectRoot,
      new Date('2026-04-01T08:00:00.000Z'),
    );
    const customIndex = '# Existing Index\n\n- keep me\n';
    await writeIndex(customIndex);

    await ensureAutoMemoryScaffold(
      projectRoot,
      new Date('2026-04-02T08:00:00.000Z'),
    );

    await expect(readIndex()).resolves.toBe(customIndex);
  });

  it('returns null when the auto-memory index does not exist yet', async () => {
    await expect(readAutoMemoryIndex(projectRoot)).resolves.toBeNull();
  });

  it('reads the managed auto-memory index after scaffold creation', async () => {
    await ensureAutoMemoryScaffold(projectRoot);
    await expect(readAutoMemoryIndex(projectRoot)).resolves.toBe('');
  });

  it('returns content and stats for an existing auto-memory index', async () => {
    await ensureAutoMemoryScaffold(projectRoot);
    const indexContent = '# Existing Index\n\n- keep me\n';
    await writeIndex(indexContent);

    const result = await readAutoMemoryIndexWithStats(projectRoot);

    expect(result?.content).toBe(indexContent);
    expect(result?.stats.size).toBe(Buffer.byteLength(indexContent));
    expect(result?.stats.mtimeMs).toBeGreaterThan(0);
  });

  it('returns null when reading auto-memory index with stats before creation', async () => {
    await expect(readAutoMemoryIndexWithStats(projectRoot)).resolves.toBeNull();
  });
});
