/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAutoMemoryRootCache,
  getTeamAutoMemoryIndexPath,
  getTeamAutoMemoryRoot,
  isTeamAutoMemPath,
  TEAM_AUTO_MEMORY_DIRNAME,
} from './paths.js';
import { readTeamAutoMemoryIndex } from './store.js';

describe('team auto-memory paths', () => {
  let projectRoot: string;

  beforeEach(() => {
    // A temp dir with a .git directory so it reads as the canonical git root.
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-team-'));
    fs.mkdirSync(path.join(projectRoot, '.git'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('anchors the team root inside the repo .qwen directory', () => {
    expect(getTeamAutoMemoryRoot(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', TEAM_AUTO_MEMORY_DIRNAME),
    );
  });

  it('places MEMORY.md at the team root', () => {
    expect(getTeamAutoMemoryIndexPath(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', TEAM_AUTO_MEMORY_DIRNAME, 'MEMORY.md'),
    );
  });

  it('contains paths inside the team root and rejects escapes', () => {
    const root = getTeamAutoMemoryRoot(projectRoot);
    expect(isTeamAutoMemPath(root, projectRoot)).toBe(true);
    expect(
      isTeamAutoMemPath(path.join(root, 'feedback/x.md'), projectRoot),
    ).toBe(true);
    expect(
      isTeamAutoMemPath(path.join(root, '..', 'escape.md'), projectRoot),
    ).toBe(false);
  });

  it('clearAutoMemoryRootCache invalidates the team root cache', () => {
    // A fresh dir with no git ancestor, so the first resolution falls back to
    // the nested path itself; adding a `.git` later changes the canonical root.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cache-'));
    const nested = path.join(fresh, 'pkg');
    fs.mkdirSync(nested, { recursive: true });
    try {
      // Primes the cache with the no-git fallback (nested itself).
      expect(getTeamAutoMemoryRoot(nested)).toBe(
        path.join(nested, '.qwen', TEAM_AUTO_MEMORY_DIRNAME),
      );
      fs.mkdirSync(path.join(fresh, '.git'));
      clearAutoMemoryRootCache();
      // After clearing, it must re-resolve to the new git root.
      expect(getTeamAutoMemoryRoot(nested)).toBe(
        path.join(fresh, '.qwen', TEAM_AUTO_MEMORY_DIRNAME),
      );
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  describe('readTeamAutoMemoryIndex', () => {
    it('returns null when the index does not exist yet', async () => {
      expect(await readTeamAutoMemoryIndex(projectRoot)).toBeNull();
    });

    it('reads back the team index once written', async () => {
      const indexPath = getTeamAutoMemoryIndexPath(projectRoot);
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(indexPath, '- [Existing](x.md) — keep me.');
      expect(await readTeamAutoMemoryIndex(projectRoot)).toBe(
        '- [Existing](x.md) — keep me.',
      );
    });
  });
});
