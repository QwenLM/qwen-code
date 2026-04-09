/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getAutoMemoryTopicPath,
} from './paths.js';
import {
  createDefaultAutoMemoryIndex,
  createDefaultAutoMemoryMetadata,
  ensureAutoMemoryScaffold,
  readAutoMemoryIndex,
} from './store.js';

describe('auto-memory storage scaffold', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

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

  it('creates a complete managed auto-memory scaffold', async () => {
    const now = new Date('2026-04-01T08:00:00.000Z');
    await ensureAutoMemoryScaffold(projectRoot, now);

    const index = await fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8');
    expect(index).toBe(createDefaultAutoMemoryIndex());

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

    await expect(fs.stat(getAutoMemoryRoot(projectRoot))).resolves.toBeDefined();
    await expect(fs.access(getAutoMemoryTopicPath(projectRoot, 'user'))).rejects.toThrow();
  });

  it('is idempotent and preserves existing index content', async () => {
    await ensureAutoMemoryScaffold(projectRoot, new Date('2026-04-01T08:00:00.000Z'));
    const customIndex = '# Existing Index\n\n- keep me\n';
    await fs.writeFile(getAutoMemoryIndexPath(projectRoot), customIndex, 'utf-8');

    await ensureAutoMemoryScaffold(projectRoot, new Date('2026-04-02T08:00:00.000Z'));

    await expect(fs.readFile(getAutoMemoryIndexPath(projectRoot), 'utf-8')).resolves.toBe(
      customIndex,
    );
  });

  it('returns null when the auto-memory index does not exist yet', async () => {
    await expect(readAutoMemoryIndex(projectRoot)).resolves.toBeNull();
  });

  it('reads the managed auto-memory index after scaffold creation', async () => {
    await ensureAutoMemoryScaffold(projectRoot);
    await expect(readAutoMemoryIndex(projectRoot)).resolves.toBe('');
  });
});