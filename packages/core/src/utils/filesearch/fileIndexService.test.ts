/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FileIndexService } from './fileIndexService.js';
import {
  cleanupTmpDir,
  createTmpDir,
} from '../../test-utils/file-system-test-helpers.js';

describe('FileIndexService', () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanupTmpDir(tmpDir);
    await FileIndexService.__resetForTests();
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

  it('returns the same instance for identical options (singleton)', async () => {
    tmpDir = await createTmpDir({ 'a.txt': '' });
    const opts = baseOptions(tmpDir);
    const a = FileIndexService.for(opts);
    const b = FileIndexService.for({ ...opts });
    expect(a).toBe(b);
  });

  it('creates distinct instances for different project roots', async () => {
    tmpDir = await createTmpDir({ 'a.txt': '' });
    const other = await createTmpDir({ 'b.txt': '' });
    try {
      const a = FileIndexService.for(baseOptions(tmpDir));
      const b = FileIndexService.for(baseOptions(other));
      expect(a).not.toBe(b);
    } finally {
      await cleanupTmpDir(other);
    }
  });

  it('transitions to ready and fires whenReady', async () => {
    tmpDir = await createTmpDir({ 'a.txt': '', 'b.txt': '' });
    const svc = FileIndexService.for(baseOptions(tmpDir));
    await svc.whenReady();
    expect(svc.state).toBe('ready');
    expect(svc.snapshotSize).toBeGreaterThan(0);
  });

  it('delivers search results through the transport', async () => {
    tmpDir = await createTmpDir({
      src: { 'alpha.txt': '', 'beta.txt': '' },
    });
    const svc = FileIndexService.for(baseOptions(tmpDir));
    await svc.whenReady();
    const results = await svc.search('alpha');
    expect(results).toContain('src/alpha.txt');
  });

  it('notifies onPartial subscribers as the snapshot grows', async () => {
    const structure: Record<string, string> = {};
    for (let i = 0; i < 20; i++) structure[`f${i}.txt`] = '';
    tmpDir = await createTmpDir(structure);

    const svc = FileIndexService.for(baseOptions(tmpDir));
    const observedCounts: number[] = [];
    const unsubscribe = svc.onPartial((n) => observedCounts.push(n));
    await svc.whenReady();
    unsubscribe();

    // At least one partial notification must have fired; counts must be
    // monotonically non-decreasing; final count must match snapshotSize.
    expect(observedCounts.length).toBeGreaterThan(0);
    for (let i = 1; i < observedCounts.length; i++) {
      expect(observedCounts[i]).toBeGreaterThanOrEqual(observedCounts[i - 1]);
    }
    expect(observedCounts[observedCounts.length - 1]).toBe(svc.snapshotSize);
  });

  it('propagates AbortError when a search signal fires', async () => {
    tmpDir = await createTmpDir({ 'a.txt': '' });
    const svc = FileIndexService.for(baseOptions(tmpDir));
    await svc.whenReady();

    const controller = new AbortController();
    controller.abort();
    await expect(
      svc.search('a', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
