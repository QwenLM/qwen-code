/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the memory → attachment pipeline.
 *
 * Uses a real MemoryContextManager against a real filesystem to verify:
 *
 *   1. First turn: startup memory is injected via prependUserContext (not
 *      attachments). seedStaticMemoryPaths seeds loadedNestedMemoryPaths.
 *      getRelevantMemoriesAttachments does not re-emit any part of startup memory.
 *
 *   2. @import children inlined into parent tier content do NOT leak into
 *      getRelevantMemoriesAttachments.
 *
 *   3. JIT discovery of an AGENTS.md outside the @import chain emits a
 *      relevant_memories attachment exactly once.
 *
 *   4. Post-compact re-seed: seedStaticMemoryPaths re-runs, but
 *      getRelevantMemoriesAttachments stays silent for already-disclosed paths.
 *
 * These are the scenarios whose breakage (commit 37838384 regression and
 * @import leak) motivated the seed logic in seedStaticMemoryPaths.
 * Keep this test on the critical path.
 */

import { createToolFileStateCache } from '../../utils/fileStateCache.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock only the global-memory lookup so the test does not touch the user's
// real ~/.qwen/AGENTS.md. Everything else (project discovery, @import,
// JIT traversal) runs for real against the temp filesystem.
vi.mock('../../utils/memoryDiscovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/memoryDiscovery.js')>();
  return {
    ...actual,
    getGlobalMemoryPaths: vi.fn().mockResolvedValue([]),
  };
});

import { MemoryContextManager } from '../../context/memoryContextManager.js';
import {
  seedStaticMemoryPaths,
  getRelevantMemoriesAttachments,
} from './memory-generators.js';
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js';
import type { Config } from '../../config/config.js';
import { CONFIG_DIR } from '../../utils/paths.js';
import type {
  AttachmentToolUseContext,
  AttachmentExternalContext,
} from '../types.js';

function makeCtx(): AttachmentToolUseContext {
  return {
    fileReadState: createToolFileStateCache(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    cwd: '/',
    loadedNestedMemoryPaths: new Set(),
    sentSkillNames: new Map(),
    pendingHookOutputs: [],
    pendingHookAttachments: [],
    postCompactCandidates: null,
    announcedMcpInstructionServers: new Set(),
    announcedLazyMcpTools: new Set(),
    announcedAgentTypes: new Set(),
    seenSessionStartHookOutputs: new Set(),
    isFirstTurnSeedDone: false,
  };
}

function makeConfig(workingDir: string): Config {
  return {
    getSessionId: vi.fn().mockReturnValue('memory-pipeline-test'),
    getWorkingDir: vi.fn().mockReturnValue(workingDir),
    getTargetDir: vi.fn().mockReturnValue(workingDir),
    getWorktreeSettings: vi.fn().mockReturnValue(undefined),
    getImportFormat: vi.fn().mockReturnValue('tree'),
    getWorkspaceContext: vi.fn().mockReturnValue({
      getDirectories: vi.fn().mockReturnValue([workingDir]),
    }),
    getMcpClientManager: vi.fn().mockReturnValue({
      getMcpInstructions: vi.fn().mockReturnValue(''),
    }),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getMemoryBoundaryMarkers: vi.fn().mockReturnValue(['.git']),
    getAllContextFileNames: vi.fn().mockReturnValue(['AGENTS.md']),
    getAllLocalContextFileNames: vi.fn().mockReturnValue(['AGENTS.local.md']),
    getAgentsMdExcludes: vi.fn().mockReturnValue([]),
    getAllowedAgentSources: vi.fn().mockReturnValue(undefined),
    getHookSystem: vi.fn().mockReturnValue(undefined),
    storage: {
      getProjectMemoryDir: vi
        .fn()
        .mockReturnValue(path.join(workingDir, '.memory')),
    },
  } as unknown as Config;
}

describe('memory → attachment pipeline (integration)', () => {
  let tmpDir: string;
  let mgr: MemoryContextManager;
  let ext: AttachmentExternalContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-pipeline-'));
    // Mark as project root for getEnvironmentMemoryPaths traversal.
    await fs.mkdir(path.join(tmpDir, '.git'));

    // Root AGENTS.md imports children/AGENTS.md
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      'root instruction\n@children/AGENTS.md',
    );
    await fs.mkdir(path.join(tmpDir, 'children'));
    await fs.writeFile(
      path.join(tmpDir, 'children', 'AGENTS.md'),
      'children instruction',
    );

    mgr = new MemoryContextManager(makeConfig(tmpDir));
    await mgr.refresh();

    ext = {
      memoryContextManager: {
        getGlobalMemory: () => mgr.getGlobalMemory(),
        getPluginMemory: () => mgr.getPluginMemory(),
        getEnvironmentMemory: () => mgr.getEnvironmentMemory(),
        getLocalMemory: () => mgr.getLocalMemory(),
        getLoadedPaths: () => mgr.getLoadedPaths(),
        getCategorizedPaths: () => mgr.getCategorizedPaths(),
      },
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('refresh discovers root AGENTS.md and its @import child', () => {
    // normalizePath lowercases on darwin, so basename is case-insensitive.
    const loadedBases = Array.from(mgr.getLoadedPaths()).map((p) =>
      path.basename(p).toLowerCase(),
    );
    // Both root and children should be in loadedPaths (children via resolvedImportPaths)
    expect(loadedBases.filter((n) => n === 'agents.md').length).toBe(2);
    expect(mgr.getEnvironmentMemory()).toContain('root instruction');
    expect(mgr.getEnvironmentMemory()).toContain('children instruction');
  });

  async function createWorktreeMemoryFixture() {
    const originalCwd = path.join(tmpDir, 'apps', 'desktop');
    const worktreePath = path.join(tmpDir, 'checkout');
    const worktreeCwd = path.join(worktreePath, 'apps', 'desktop');
    const extraRoot = path.join(tmpDir, 'checkout-extra');
    for (const [directory, label] of [
      [originalCwd, 'original'],
      [worktreeCwd, 'worktree'],
      [extraRoot, 'additional'],
    ]) {
      await fs.mkdir(path.join(directory, CONFIG_DIR, 'rules'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(directory, 'AGENTS.md'),
        `${label} instructions`,
      );
      await fs.writeFile(
        path.join(directory, CONFIG_DIR, 'rules', 'always.md'),
        `${label} always rule`,
      );
      await fs.writeFile(
        path.join(directory, CONFIG_DIR, 'rules', 'review.md'),
        `---\ntrigger: model_decision\ndescription: ${label} review rule\n---\nReview instructions`,
      );
    }
    await fs.mkdir(path.join(worktreePath, '.git'));
    await fs.mkdir(path.join(extraRoot, '.git'));
    const config = makeConfig(originalCwd);
    vi.mocked(config.getAllowedAgentSources).mockReturnValue(['project']);
    vi.mocked(config.getWorkspaceContext().getDirectories).mockReturnValue([
      originalCwd,
      extraRoot,
    ]);
    const memory = new MemoryContextManager(config);
    return {
      memory,
      originalCwd,
      worktreeCwd,
      extraRoot,
      enterWorktree: () => {
        vi.mocked(config.getWorkingDir).mockReturnValue(worktreeCwd);
        vi.mocked(config.getWorktreeSettings).mockReturnValue({
          name: 'checkout',
          path: worktreePath,
          worktreeCwd,
          originalCwd,
          baseSha: '',
          lifecycle: 'attached',
        });
        vi.mocked(config.getWorkspaceContext().getDirectories).mockReturnValue([
          worktreeCwd,
          extraRoot,
        ]);
      },
    };
  }

  it('keeps refreshed project instructions and rule indexes in originalCwd while preserving additional workspaces', async () => {
    const { memory, extraRoot, enterWorktree } = await createWorktreeMemoryFixture();
    await memory.refresh();
    expect(memory.getEnvironmentMemory()).toContain('original instructions');
    expect(memory.getEnvironmentMemory()).toContain('original always rule');
    expect(memory.getEnvironmentMemory()).toContain('additional instructions');
    expect(memory.getEnvironmentMemory()).not.toContain('additional always rule');

    enterWorktree();
    await memory.refresh('compact');

    expect(memory.getEnvironmentMemory()).toContain('original instructions');
    expect(memory.getEnvironmentMemory()).toContain('additional instructions');
    expect(memory.getEnvironmentMemory()).not.toContain('worktree instructions');
    expect(memory.getEnvironmentMemory()).toContain('original always rule');
    expect(memory.getEnvironmentMemory()).not.toContain('additional always rule');
    expect(memory.getUserContext()['modelDecisionRules']).toContain(
      'original review rule',
    );
    expect(memory.getUserContext()['modelDecisionRules']).not.toContain(
      'additional review rule',
    );
    expect(memory.getUserContext()['modelDecisionRules']).not.toContain(
      'worktree review rule',
    );

    const discovered = await memory.discoverContext(
      path.join(extraRoot, 'index.ts'),
      [extraRoot],
    );
    expect(discovered).toContain('additional always rule');
  });

  it('loads nested instructions from the original project for a worktree file access', async () => {
    const { memory, originalCwd, worktreeCwd, enterWorktree } =
      await createWorktreeMemoryFixture();
    for (const [directory, label] of [
      [originalCwd, 'original'],
      [worktreeCwd, 'worktree'],
    ]) {
      await fs.mkdir(path.join(directory, 'src'));
      await fs.writeFile(
        path.join(directory, 'src', 'AGENTS.md'),
        `${label} nested instructions`,
      );
    }
    enterWorktree();
    await memory.refresh();

    const context = await memory.discoverContext(
      path.join(worktreeCwd, 'src', 'new-file.ts'),
      [worktreeCwd],
    );
    expect(context).toContain('original nested instructions');
    expect(context).not.toContain('worktree nested instructions');
  });

  it('first turn: seed populates paths, dynamic stays silent on @import child', async () => {
    const ctx = makeCtx();

    seedStaticMemoryPaths(ctx, ext);
    const dynamic = await getRelevantMemoriesAttachments(ctx, ext);

    // Startup memory is now injected via prependUserContext, not attachments.
    // seedStaticMemoryPaths only seeds the dedup set.
    expect(ctx.isFirstTurnSeedDone).toBe(true);
    // @import child already inlined → dynamic stays silent.
    expect(dynamic).toEqual([]);
    // All tier-loaded paths (root + @import child) must be marked as seen.
    for (const p of mgr.getLoadedPaths()) {
      expect(ctx.loadedNestedMemoryPaths.has(p)).toBe(true);
    }
  });

  it('JIT discovery of a path outside @import chain emits relevant_memories once', async () => {
    // Add an out-of-import AGENTS.md + trigger file in a sibling dir.
    const otherDir = path.join(tmpDir, 'other');
    await fs.mkdir(otherDir);
    await fs.writeFile(path.join(otherDir, 'AGENTS.md'), 'other instruction');
    const triggerFile = path.join(otherDir, 'code.ts');
    await fs.writeFile(triggerFile, '// trigger');

    const ctx = makeCtx();

    // First turn: seed suppresses everything.
    seedStaticMemoryPaths(ctx, ext);
    await getRelevantMemoriesAttachments(ctx, ext);

    // Simulate tool access → JIT traversal.
    await mgr.discoverContext(triggerFile, [tmpDir]);

    const dynamic = await getRelevantMemoriesAttachments(ctx, ext);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].type).toBe('relevant_memories');
    const emitted = dynamic[0].files;
    expect(emitted).toHaveLength(1);
    expect(emitted[0].filePath.toLowerCase()).toBe(
      path.join(otherDir, 'AGENTS.md').toLowerCase(),
    );
    expect(emitted[0].content).toContain('other instruction');
    expect(emitted[0].memoryType).toBe('jit');

    // Same state again → no re-emit.
    const second = await getRelevantMemoriesAttachments(ctx, ext);
    expect(second).toEqual([]);
  });

  it('JIT discovery within @import chain does NOT emit (already inlined)', async () => {
    const ctx = makeCtx();
    seedStaticMemoryPaths(ctx, ext);
    await getRelevantMemoriesAttachments(ctx, ext);

    // Access a file under children/ — children/AGENTS.md is already part of
    // the root @import chain, so JIT should find it but identity-dedup inside
    // loadJitSubdirectoryMemory skips it.
    const triggerFile = path.join(tmpDir, 'children', 'test.js');
    await fs.writeFile(triggerFile, '// trigger');
    await mgr.discoverContext(triggerFile, [tmpDir]);

    const dynamic = await getRelevantMemoriesAttachments(ctx, ext);
    expect(dynamic).toEqual([]);
  });

  it('post-compact: seed re-runs, dynamic stays silent for tier + @import', async () => {
    const ctx = makeCtx();

    // Turn 1: seed.
    seedStaticMemoryPaths(ctx, ext);
    await getRelevantMemoriesAttachments(ctx, ext);

    // Post-compact reset — isFirstTurnSeedDone cleared, loadedNestedMemoryPaths preserved.
    ctx.isFirstTurnSeedDone = false;

    seedStaticMemoryPaths(ctx, ext);
    const dynamic = await getRelevantMemoriesAttachments(ctx, ext);

    // dynamic must not re-emit the root or @import child — they're already known
    expect(dynamic).toEqual([]);
  });
});
