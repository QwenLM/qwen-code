/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildTeamAutoMemoryIndex } from './indexer.js';
import {
  clearAutoMemoryRootCache,
  getTeamAutoMemoryIndexPath,
  getTeamAutoMemoryRoot,
} from './paths.js';

describe('rebuildTeamAutoMemoryIndex', () => {
  let projectRoot: string;

  const writeMemory = (rel: string, name: string, description: string) => {
    const file = path.join(getTeamAutoMemoryRoot(projectRoot), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `---\nname: ${name}\ndescription: ${description}\ntype: feedback\n---\nbody`,
    );
  };

  beforeEach(() => {
    clearAutoMemoryRootCache();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-team-index-'));
    fs.mkdirSync(path.join(projectRoot, '.git'));
  });

  afterEach(() => {
    clearAutoMemoryRootCache();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns null and does not create the dir when team memory is absent', async () => {
    expect(await rebuildTeamAutoMemoryIndex(projectRoot)).toBeNull();
    expect(fs.existsSync(getTeamAutoMemoryRoot(projectRoot))).toBe(false);
  });

  it('generates the index from saved files and writes MEMORY.md', async () => {
    writeMemory('feedback/a.md', 'Alpha', 'desc A');
    writeMemory('feedback/b.md', 'Bravo', 'desc B');

    const content = await rebuildTeamAutoMemoryIndex(projectRoot);

    expect(content).toContain('- [Alpha](feedback/a.md) — desc A');
    expect(content).toContain('- [Bravo](feedback/b.md) — desc B');
    // The index is written to disk, not just returned.
    expect(
      fs.readFileSync(getTeamAutoMemoryIndexPath(projectRoot), 'utf-8'),
    ).toBe(content);
    // The index file never indexes itself.
    expect(content).not.toContain('MEMORY.md');
  });

  it('orders entries by path (deterministic), not by mtime', async () => {
    // a.md written first (older mtime), b.md second — an mtime-desc sort would
    // put b before a; the path sort must keep a before b on every machine.
    writeMemory('feedback/a.md', 'Alpha', 'desc A');
    writeMemory('feedback/b.md', 'Bravo', 'desc B');

    const content = (await rebuildTeamAutoMemoryIndex(projectRoot)) ?? '';
    expect(content.indexOf('Alpha')).toBeLessThan(content.indexOf('Bravo'));
  });
});
