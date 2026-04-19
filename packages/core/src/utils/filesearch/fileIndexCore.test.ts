/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FileIndexCore } from './fileIndexCore.js';
import {
  cleanupTmpDir,
  createTmpDir,
} from '../../test-utils/file-system-test-helpers.js';

describe('FileIndexCore', () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanupTmpDir(tmpDir);
  });

  const baseOptions = (projectRoot: string) => ({
    projectRoot,
    ignoreDirs: [] as string[],
    useGitignore: false,
    useQwenignore: false,
    cache: false,
    cacheTtl: 0,
    enableRecursiveFileSearch: true,
    enableFuzzySearch: true,
  });

  it('streams discovered files via onChunk before resolving', async () => {
    const structure: Record<string, string> = {};
    for (let i = 0; i < 5; i++) structure[`file${i}.txt`] = '';
    tmpDir = await createTmpDir(structure);

    const core = new FileIndexCore(baseOptions(tmpDir));
    const received: string[] = [];
    await core.startCrawl((chunk) => {
      for (const p of chunk) received.push(p);
    });

    // Every file should have been streamed out; the live snapshot should
    // mirror that count.
    expect(received.length).toBeGreaterThan(0);
    expect(core.snapshotSize).toBe(received.length);
    expect(core.isReady).toBe(true);
  });

  it('returns results from the partial snapshot before buildFzfIndex is called', async () => {
    const structure: Record<string, string> = {
      'apple.txt': '',
      'banana.txt': '',
      'cherry.txt': '',
    };
    tmpDir = await createTmpDir(structure);

    const core = new FileIndexCore(baseOptions(tmpDir));
    await core.startCrawl();
    // Intentionally skip `buildFzfIndex()` — simulate the "still crawling"
    // window. Search must still work, falling through to picomatch.
    const results = await core.search('apple');
    expect(results).toContain('apple.txt');
    expect(results).not.toContain('banana.txt');
  });

  it('uses fzf after buildFzfIndex for fuzzy queries', async () => {
    tmpDir = await createTmpDir({
      src: {
        'LoadingIndicator.tsx': '',
        'Thumbnail.tsx': '',
      },
    });

    const core = new FileIndexCore(baseOptions(tmpDir));
    await core.startCrawl();
    core.buildFzfIndex();

    // 'LoInd' is a fuzzy subsequence of LoadingIndicator; picomatch would
    // never find this, fzf will.
    const results = await core.search('LoInd');
    expect(results.some((p) => p.includes('LoadingIndicator'))).toBe(true);
  });

  it('returns empty results for malformed glob patterns', async () => {
    tmpDir = await createTmpDir({ 'a.txt': '', 'b.txt': '' });
    const core = new FileIndexCore(baseOptions(tmpDir));
    await core.startCrawl();
    core.buildFzfIndex();
    // An unmatched `[` is a common interim state while the user is typing a
    // character class; picomatch throws on compile. The core should absorb
    // that and return an empty list instead of propagating the TypeError.
    // Use a wildcard path so the glob branch (not fzf) handles it.
    const results = await core.search('foo[*');
    expect(results).toEqual([]);
  });

  it('respects maxResults during snapshot-phase searches', async () => {
    const structure: Record<string, string> = {};
    for (let i = 0; i < 30; i++) structure[`match${i}.txt`] = '';
    tmpDir = await createTmpDir(structure);

    const core = new FileIndexCore(baseOptions(tmpDir));
    await core.startCrawl();
    const results = await core.search('match', { maxResults: 5 });
    expect(results).toHaveLength(5);
  });
});
