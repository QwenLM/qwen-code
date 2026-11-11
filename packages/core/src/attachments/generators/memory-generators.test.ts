/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for memory attachment generators.
 *
 * Covers the deduplication logic:
 *
 *   1. First-turn: seedStaticMemoryPaths seeds loadedNestedMemoryPaths from
 *      getLoadedPaths() (tier roots + @import children). getRelevantMemoriesAttachments
 *      must not re-emit any of those.
 *
 *   2. Post-compact: isFirstTurnSeedDone is reset to false, so
 *      seedStaticMemoryPaths re-seeds. loadedNestedMemoryPaths is kept, so
 *      getRelevantMemoriesAttachments does not re-emit previously disclosed paths.
 */

import { createToolFileStateCache } from '../../utils/fileStateCache.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  seedStaticMemoryPaths,
  getRelevantMemoriesAttachments,
} from './memory-generators.js';
import { getChangedFiles } from './file-generators.js';
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js';
import type {
  AttachmentToolUseContext,
  AttachmentExternalContext,
} from '../types.js';
import type { ScopedMemoryIndexFileState } from '../../memory/memory-index.js';
import type { RuleFileState } from '../../utils/memoryDiscovery.js';

// ── fixtures ─────────────────────────────────────────────────────────────

function makeCtx(): AttachmentToolUseContext {
  return {
    fileReadState: createToolFileStateCache(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    cwd: '/project',
    loadedNestedMemoryPaths: new Set<string>(),
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

interface MockMgrOptions {
  global?: string;
  plugin?: string;
  project?: string;
  local?: string;
  loadedPaths?: string[];
  categorized?: {
    global?: string[];
    plugin?: string[];
    project?: string[];
    local?: string[];
  };
  autoMemoryIndexFileStates?: ScopedMemoryIndexFileState[];
  ruleFileStates?: RuleFileState[];
}

function makeExternalCtx(opts: MockMgrOptions): AttachmentExternalContext {
  const {
    global = '',
    plugin = '',
    project = '',
    local = '',
    loadedPaths = [],
    categorized,
    autoMemoryIndexFileStates = [],
    ruleFileStates = [],
  } = opts;

  return {
    memoryContextManager: {
      getGlobalMemory: () => global,
      getPluginMemory: () => plugin,
      getEnvironmentMemory: () => project,
      getLocalMemory: () => local,
      getLoadedPaths: () => new Set(loadedPaths),
      getCategorizedPaths: () =>
        categorized
          ? {
              global: categorized.global ?? [],
              plugin: categorized.plugin ?? [],
              project: categorized.project ?? [],
              local: categorized.local ?? [],
            }
          : null,
      getAutoMemoryIndexFileStates: () => autoMemoryIndexFileStates,
      getRuleFileStates: () => ruleFileStates,
    },
  };
}

// ── seedStaticMemoryPaths ───────────────────────────────────────────────

describe('seedStaticMemoryPaths()', () => {
  let ctx: AttachmentToolUseContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it('seeds @import dedup set on first call and sets isFirstTurnSeedDone', () => {
    const ext = makeExternalCtx({
      global: 'global content',
      project: 'project content\n<!-- Imported from: /child.md -->\nchild',
      loadedPaths: ['/agents.md', '/child.md'],
      categorized: { project: ['/agents.md'] },
    });

    seedStaticMemoryPaths(ctx, ext);

    expect(ctx.isFirstTurnSeedDone).toBe(true);
    // Seed must include @import children (via getLoadedPaths) so
    // getRelevantMemoriesAttachments doesn't re-emit them.
    expect(ctx.loadedNestedMemoryPaths.has('/agents.md')).toBe(true);
    expect(ctx.loadedNestedMemoryPaths.has('/child.md')).toBe(true);
  });

  it('re-absorbs categorized tier paths on subsequent calls (protects @import children)', () => {
    const ext = makeExternalCtx({
      global: 'global',
      project: 'project',
      loadedPaths: ['/agents.md'],
      categorized: { project: ['/agents.md'], global: ['/.qwen/AGENTS.md'] },
    });

    // First call seeds
    seedStaticMemoryPaths(ctx, ext);
    expect(ctx.isFirstTurnSeedDone).toBe(true);

    // Clear paths to simulate external modification
    ctx.loadedNestedMemoryPaths.clear();

    // Second call uses categorized paths branch
    seedStaticMemoryPaths(ctx, ext);

    expect(ctx.loadedNestedMemoryPaths.has('/agents.md')).toBe(true);
    expect(ctx.loadedNestedMemoryPaths.has('/.qwen/AGENTS.md')).toBe(true);
  });

  it('re-seeds after isFirstTurnSeedDone is reset (post-compact)', () => {
    const ext = makeExternalCtx({
      global: 'global',
      project: 'project',
      loadedPaths: ['/agents.md'],
      categorized: { project: ['/agents.md'] },
    });

    // First call
    seedStaticMemoryPaths(ctx, ext);
    expect(ctx.isFirstTurnSeedDone).toBe(true);

    // Simulate post-compact reset
    ctx.isFirstTurnSeedDone = false;
    ctx.loadedNestedMemoryPaths.clear();

    seedStaticMemoryPaths(ctx, ext);
    expect(ctx.isFirstTurnSeedDone).toBe(true);
    expect(ctx.loadedNestedMemoryPaths.has('/agents.md')).toBe(true);
  });

  it('is a no-op when memoryContextManager is absent', () => {
    seedStaticMemoryPaths(ctx, {});
    expect(ctx.isFirstTurnSeedDone).toBe(false);
    expect(ctx.loadedNestedMemoryPaths.size).toBe(0);
  });

  it('seeds auto-memory MEMORY.md files into readFileState', () => {
    const indexPath = '/project/.qwen/memory/MEMORY.md';
    const ext = makeExternalCtx({
      loadedPaths: [],
      autoMemoryIndexFileStates: [
        {
          scope: 'project',
          indexPath,
          content: '- [Prefs](prefs.md) - collaboration preferences\n',
          timestamp: 123,
        },
      ],
    });

    seedStaticMemoryPaths(ctx, ext);

    expect(ctx.readFileState.get(indexPath)).toMatchObject({
      content: '- [Prefs](prefs.md) - collaboration preferences\n',
      timestamp: 123,
      offset: undefined,
      limit: undefined,
    });
    expect(ctx.fileReadState.get(indexPath)).toMatchObject({
      content: '- [Prefs](prefs.md) - collaboration preferences\n',
      timestamp: 123,
    });
  });

  it('emits SDK memory file changes as edited_text_file attachments', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-memory-delta-'));
    try {
      const memoryPath = path.join(tmpDir, 'MEMORY.md');
      await fs.writeFile(memoryPath, '- editor: Vim\n');
      const initialStats = await fs.stat(memoryPath);
      const ext: AttachmentExternalContext = {
        sdkMemoryFileStates: [
          {
            filePath: memoryPath,
            content: '- editor: Vim\n',
            timestamp: Math.floor(initialStats.mtimeMs),
          },
        ],
      };

      seedStaticMemoryPaths(ctx, ext);
      expect(await getChangedFiles(ctx)).toEqual([]);

      await fs.writeFile(memoryPath, '- editor: VSCode\n');
      const changedAt = new Date(Date.now() + 2_000);
      await fs.utimes(memoryPath, changedAt, changedAt);

      const changed = await getChangedFiles(ctx);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        type: 'edited_text_file',
        filename: memoryPath,
      });
      expect(changed[0]?.type === 'edited_text_file' && changed[0].snippet).toContain(
        'VSCode',
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps missing auto-memory MEMORY.md watch state so first creation is detected', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-gen-test-'));
    try {
      const indexPath = path.join(tmpDir, 'MEMORY.md');
      const ext = makeExternalCtx({
        loadedPaths: [],
        autoMemoryIndexFileStates: [
          {
            scope: 'project',
            indexPath,
            content: '',
            timestamp: 0,
            retainIfMissing: true,
          },
        ],
      });

      seedStaticMemoryPaths(ctx, ext);

      expect(await getChangedFiles(ctx)).toEqual([]);
      expect(ctx.readFileState.has(indexPath)).toBe(true);

      await fs.writeFile(
        indexPath,
        '- [Prefs](prefs.md) - collaboration preferences\n',
      );

      const changed = await getChangedFiles(ctx);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        type: 'edited_text_file',
        filename: indexPath,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('seeds project rule files into readFileState (raw bytes + isPartialView)', () => {
    const rulePath = '/project/.qwen/rules/style.md';
    const ext = makeExternalCtx({
      loadedPaths: [],
      ruleFileStates: [
        {
          rulePath,
          content: '---\nglobs: ["**/*.ts"]\n---\nUse tabs.\n',
          timestamp: 456,
          isPartialView: true,
        },
      ],
    });

    seedStaticMemoryPaths(ctx, ext);

    expect(ctx.readFileState.get(rulePath)).toMatchObject({
      content: '---\nglobs: ["**/*.ts"]\n---\nUse tabs.\n',
      timestamp: 456,
      isPartialView: true,
      offset: undefined,
      limit: undefined,
    });
    expect(ctx.fileReadState.get(rulePath)).toMatchObject({
      content: '---\nglobs: ["**/*.ts"]\n---\nUse tabs.\n',
      timestamp: 456,
    });
  });

  it('detects mid-session edits to a rule file as edited_text_file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rule-gen-test-'));
    try {
      const rulePath = path.join(tmpDir, 'style.md');
      await fs.writeFile(rulePath, 'Use tabs.\n');
      const { mtimeMs } = await fs.stat(rulePath);

      const ext = makeExternalCtx({
        loadedPaths: [],
        ruleFileStates: [
          {
            rulePath,
            content: 'Use tabs.\n',
            timestamp: Math.floor(mtimeMs),
          },
        ],
      });

      seedStaticMemoryPaths(ctx, ext);
      expect(await getChangedFiles(ctx)).toEqual([]);

      // Bump mtime forward so change detection fires deterministically.
      const later = new Date(mtimeMs + 2000);
      await fs.writeFile(rulePath, 'Use spaces.\n');
      await fs.utimes(rulePath, later, later);

      const changed = await getChangedFiles(ctx);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        type: 'edited_text_file',
        filename: rulePath,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── getRelevantMemoriesAttachments ─────────────────────────────────────────

describe('getRelevantMemoriesAttachments()', () => {
  let ctx: AttachmentToolUseContext;
  let tmpDir: string;

  beforeEach(async () => {
    ctx = makeCtx();
    ctx.isFirstTurnSeedDone = true;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-gen-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('does NOT emit paths already seeded by first-turn seed (tier + @import)', async () => {
    const tierPath = path.join(tmpDir, 'AGENTS.md');
    const childPath = path.join(tmpDir, 'child.md');
    await fs.writeFile(tierPath, 'tier content');
    await fs.writeFile(childPath, 'child content');

    ctx.loadedNestedMemoryPaths.add(tierPath);
    ctx.loadedNestedMemoryPaths.add(childPath);

    const ext = makeExternalCtx({ loadedPaths: [tierPath, childPath] });

    const result = await getRelevantMemoriesAttachments(ctx, ext);
    expect(result).toEqual([]);
  });

  it('emits new JIT path once, suppresses on subsequent calls', async () => {
    const tierPath = path.join(tmpDir, 'AGENTS.md');
    const jitPath = path.join(tmpDir, 'subdir', 'AGENTS.md');
    await fs.writeFile(tierPath, 'tier content');
    await fs.mkdir(path.dirname(jitPath));
    await fs.writeFile(jitPath, 'subdir memory content');

    // Tier already seeded; JIT discovers a new subdir AGENTS.md.
    ctx.loadedNestedMemoryPaths.add(tierPath);

    const ext = makeExternalCtx({ loadedPaths: [tierPath, jitPath] });

    const first = await getRelevantMemoriesAttachments(ctx, ext);
    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe('relevant_memories');
    expect(first[0]?.files).toHaveLength(1);
    expect(first[0]?.files[0]?.filePath).toBe(jitPath);
    expect(first[0]?.files[0]?.content).toBe('subdir memory content');
    expect(first[0]?.files[0]?.memoryType).toBe('jit');
    expect(ctx.loadedNestedMemoryPaths.has(jitPath)).toBe(true);

    const second = await getRelevantMemoriesAttachments(ctx, ext);
    expect(second).toEqual([]);
  });

  it('skips empty-content files (deleted / unreadable)', async () => {
    const vanished = path.join(tmpDir, 'vanished.md');
    // Don't create the file — readFile should throw ENOENT.

    const ext = makeExternalCtx({ loadedPaths: [vanished] });

    const result = await getRelevantMemoriesAttachments(ctx, ext);
    expect(result).toEqual([]);
    // Path still added to tracking set so we don't retry endlessly
    expect(ctx.loadedNestedMemoryPaths.has(vanished)).toBe(true);
  });

  it('strips frontmatter from a JIT rule and seeds readFileState for change detection', async () => {
    const rulesDir = path.join(tmpDir, '.qwen', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    const rulePath = path.join(rulesDir, 'cond.md');
    const raw = '---\npaths:\n  - src/x/**\n---\n# Rule\nBody v1\n';
    await fs.writeFile(rulePath, raw);

    const ext = makeExternalCtx({ loadedPaths: [rulePath] });

    const first = await getRelevantMemoriesAttachments(ctx, ext);
    expect(first).toHaveLength(1);
    // Injected content has the frontmatter block removed, body preserved.
    expect(first[0]?.files[0]?.content).toBe('# Rule\nBody v1\n');
    expect(first[0]?.files[0]?.content).not.toContain('paths:');

    // readFileState seeded with RAW disk bytes + isPartialView (injected ≠ disk).
    expect(ctx.readFileState.get(rulePath)).toMatchObject({
      content: raw,
      isPartialView: true,
      offset: undefined,
      limit: undefined,
    });

    // Mid-session edit is detected as edited_text_file.
    const { mtimeMs } = await fs.stat(rulePath);
    const later = new Date(mtimeMs + 2000);
    await fs.writeFile(
      rulePath,
      '---\npaths:\n  - src/x/**\n---\n# Rule\nBody v2\n',
    );
    await fs.utimes(rulePath, later, later);

    const changed = await getChangedFiles(ctx);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      type: 'edited_text_file',
      filename: rulePath,
    });
  });

  it('returns [] when no new paths', async () => {
    const ext = makeExternalCtx({ loadedPaths: [] });
    const result = await getRelevantMemoriesAttachments(ctx, ext);
    expect(result).toEqual([]);
  });

  it('returns [] when memoryContextManager is absent', async () => {
    const result = await getRelevantMemoriesAttachments(ctx, {});
    expect(result).toEqual([]);
  });
});

// ── integration: seed + dynamic interplay ───────────────────────────────

describe('seed + dynamic memory deduplication', () => {
  it('first-turn → seed populates paths, dynamic stays silent on @import children', async () => {
    const ctx = makeCtx();
    const ext = makeExternalCtx({
      global: 'global',
      project: 'project with imported children',
      loadedPaths: ['/agents.md', '/children/AGENTS.md'],
      categorized: { project: ['/agents.md'] },
    });

    seedStaticMemoryPaths(ctx, ext);
    const dynamic = await getRelevantMemoriesAttachments(ctx, ext);

    // All paths seeded → dynamic has nothing new
    expect(dynamic).toEqual([]);
    // All tier-loaded paths must be marked as seen
    expect(ctx.loadedNestedMemoryPaths.has('/agents.md')).toBe(true);
    expect(ctx.loadedNestedMemoryPaths.has('/children/AGENTS.md')).toBe(true);
  });

  it('post-compact → seed re-seeds, dynamic stays silent for tier/@import', async () => {
    const ctx = makeCtx();
    const ext = makeExternalCtx({
      global: 'global',
      project: 'project',
      loadedPaths: ['/agents.md', '/children/AGENTS.md'],
      categorized: { project: ['/agents.md'] },
    });

    // First turn: seed.
    seedStaticMemoryPaths(ctx, ext);
    await getRelevantMemoriesAttachments(ctx, ext);

    // Simulate post-compact: isFirstTurnSeedDone cleared, paths preserved.
    ctx.isFirstTurnSeedDone = false;

    seedStaticMemoryPaths(ctx, ext);
    const dynamic = await getRelevantMemoriesAttachments(ctx, ext);

    expect(dynamic).toEqual([]); // no new paths
  });

  it('post-compact + new JIT → dynamic emits only the new JIT path', async () => {
    const ctx = makeCtx();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-gen-test-'));
    try {
      const tierPath = path.join(tmpDir, 'AGENTS.md');
      const jitPath = path.join(tmpDir, 'sub', 'AGENTS.md');
      await fs.writeFile(tierPath, 'tier file');
      await fs.mkdir(path.dirname(jitPath));
      await fs.writeFile(jitPath, 'sub content');

      const seedExt = makeExternalCtx({
        global: 'global',
        project: 'project',
        loadedPaths: [tierPath],
        categorized: { project: [tierPath] },
      });
      seedStaticMemoryPaths(ctx, seedExt);
      await getRelevantMemoriesAttachments(ctx, seedExt);

      // Post-compact: isFirstTurnSeedDone cleared, paths preserved.
      ctx.isFirstTurnSeedDone = false;

      // Re-seed uses only tier paths (JIT not yet discovered at seed time).
      seedStaticMemoryPaths(ctx, seedExt);

      // Now JIT discovers subdir file mid-turn — mgr.getLoadedPaths() grows.
      const postExt = makeExternalCtx({
        global: 'global',
        project: 'project',
        loadedPaths: [tierPath, jitPath],
        categorized: { project: [tierPath] },
      });

      const dynamic = await getRelevantMemoriesAttachments(ctx, postExt);
      expect(dynamic).toHaveLength(1);
      expect(dynamic[0]?.files[0]?.filePath).toBe(jitPath);
      expect(dynamic[0]?.files[0]?.content).toBe('sub content');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
