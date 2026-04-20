/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  FileIndexService,
  __setIndexTransportFactory,
} from './fileIndexService.js';
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

  it('rejects whenReady() waiters on dispose', async () => {
    tmpDir = await createTmpDir({ 'a.txt': '' });
    const svc = FileIndexService.for(baseOptions(tmpDir));
    const readyPromise = svc.whenReady();
    // Dispose before whenReady could resolve.
    await svc.dispose();
    await expect(readyPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('yields a fresh instance after a previous one was disposed', async () => {
    tmpDir = await createTmpDir({ 'a.txt': '' });
    const a = FileIndexService.for(baseOptions(tmpDir));
    await a.dispose();
    const b = FileIndexService.for(baseOptions(tmpDir));
    expect(b).not.toBe(a);
    await b.whenReady();
    expect(b.state).toBe('ready');
  });

  it('rejects whenReady() called after the transport has exited', async () => {
    // Regression: an 'exit' event before any `whenReady()` call used to leave
    // `_state` stuck at 'crawling', so a later `whenReady()` parked in
    // `readyWaiters` and never settled. With the fix, handleExit transitions
    // the service to 'error' and future `whenReady()` calls reject
    // synchronously.
    tmpDir = await createTmpDir({ 'a.txt': '' });

    // Fake transport that captures the exit callback so the test can fire an
    // early exit deterministically — before any `whenReady()` call subscribes.
    const exitListeners: Array<(code: number) => void> = [];
    const restore = __setIndexTransportFactory(() => ({
      post: () => {},
      onMessage: () => () => {},
      onExit: (cb) => {
        exitListeners.push(cb);
        return () => {
          const i = exitListeners.indexOf(cb);
          if (i >= 0) exitListeners.splice(i, 1);
        };
      },
      terminate: async () => {},
    }));
    try {
      const svc = FileIndexService.for(baseOptions(tmpDir));
      // Fire the exit before any `whenReady()` caller subscribes.
      for (const cb of exitListeners) cb(1);
      await expect(svc.whenReady()).rejects.toThrow(/File index worker/i);
      expect(svc.state).toBe('error');
    } finally {
      restore();
    }
  });

  it('invalidates the singleton when ignore rules change', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    tmpDir = await createTmpDir({ 'a.txt': '' });

    const a = FileIndexService.for({
      ...baseOptions(tmpDir),
      useGitignore: true,
    });
    await a.whenReady();

    // Write a .gitignore after the service was created; a subsequent `.for()`
    // call must see a different options key and spawn a fresh worker rather
    // than returning the memoised instance with stale ignore rules.
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'ignored/\n', 'utf8');

    const b = FileIndexService.for({
      ...baseOptions(tmpDir),
      useGitignore: true,
    });
    expect(b).not.toBe(a);
    // And — regression test — the stale instance must have been disposed, so
    // its worker doesn't linger in INSTANCES keyed under the old fingerprint.
    // Post-dispose search throws a plain Error (not AbortError) so that
    // callers like useAtCompletion, which silently swallow AbortError, don't
    // accidentally hide this caller-misuse signal.
    await expect(a.search('a')).rejects.toThrow(/disposed/i);
  });
});
