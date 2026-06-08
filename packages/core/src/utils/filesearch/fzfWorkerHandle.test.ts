/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  __resetWorkerScriptResolutionForTests,
  __setWorkerThresholdForTests,
  FzfWorkerHandle,
  installInProcessFzfTransport,
} from './fzfWorkerHandle.js';

describe('FzfWorkerHandle', () => {
  const restorers: Array<() => void> = [];

  afterEach(async () => {
    while (restorers.length > 0) {
      restorers.pop()!();
    }
  });

  describe('in-process fallback (small inputs)', () => {
    it('returns ranked find() results matching AsyncFzf semantics', async () => {
      const files = [
        'src/utils/filesearch/fileSearch.ts',
        'src/utils/filesearch/fzfWorker.ts',
        'src/utils/filesearch/fzfWorkerHandle.ts',
        'src/utils/paths.ts',
      ];
      const handle = await FzfWorkerHandle.create(files, { fuzzy: 'v2' });
      try {
        const results = await handle.find('handle');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].item).toBe('src/utils/filesearch/fzfWorkerHandle.ts');
      } finally {
        await handle.dispose();
      }
    });

    it('dispose() is idempotent', async () => {
      const handle = await FzfWorkerHandle.create(['a.ts', 'b.ts'], {
        fuzzy: 'v2',
      });
      await handle.dispose();
      await expect(handle.dispose()).resolves.toBeUndefined();
    });

    it('returns empty array when no candidates match', async () => {
      const handle = await FzfWorkerHandle.create(['a.ts', 'b.ts', 'c.ts'], {
        fuzzy: 'v2',
      });
      const results = await handle.find('xxxxxxxx-no-match');
      expect(results).toEqual([]);
      await handle.dispose();
    });

    it('respects the limit parameter', async () => {
      const files = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);
      const handle = await FzfWorkerHandle.create(files, { fuzzy: 'v2' });
      const results = await handle.find('file', 5);
      expect(results.length).toBeLessThanOrEqual(5);
      await handle.dispose();
    });
  });

  describe('installInProcessFzfTransport()', () => {
    it('forces the in-thread path even when file count exceeds the worker threshold', async () => {
      // Lower threshold so a small input would normally trip the worker path.
      restorers.push(__setWorkerThresholdForTests(1));
      restorers.push(installInProcessFzfTransport());

      // If the override leaked we'd be spawning a real worker_threads worker
      // here. Confirm the call returns synchronously enough to be a no-op
      // wrapper around AsyncFzf — no spawn, no postMessage round-trip.
      const before = Date.now();
      const handle = await FzfWorkerHandle.create(['x.ts', 'y.ts'], {
        fuzzy: 'v2',
      });
      const setupMs = Date.now() - before;
      // Worker spawn is at least ~10 ms even on a fast machine. The in-thread
      // path is tens of microseconds. Generous bound to avoid CI flake.
      expect(setupMs).toBeLessThan(50);

      const results = await handle.find('y');
      expect(results.map((r) => r.item)).toContain('y.ts');
      await handle.dispose();
    });

    it('restorer reverts the override', async () => {
      const restore = installInProcessFzfTransport();
      restore();
      // After restoring, threshold-based selection is back. With a tiny
      // input we still expect the in-thread path (below default threshold),
      // so this just verifies create() still works without a leaked override.
      const handle = await FzfWorkerHandle.create(['z.ts'], { fuzzy: 'v2' });
      const results = await handle.find('z');
      expect(results.map((r) => r.item)).toContain('z.ts');
      await handle.dispose();
    });
  });

  describe('worker transport (real worker_threads)', () => {
    let workerExists = false;
    const outfile = path.resolve(import.meta.dirname, 'fzfWorker.js');

    beforeAll(async () => {
      // Build the worker script on-the-fly so the test exercises the real
      // worker_threads code path. Uses esbuild to produce a self-contained
      // .js next to the source file (matching getWorkerScriptPath() resolution).
      const { build } = await import('esbuild');
      const workerSrc = path.resolve(import.meta.dirname, 'fzfWorker.ts');

      if (!fs.existsSync(outfile)) {
        await build({
          entryPoints: [workerSrc],
          outfile,
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node20',
          banner: {
            js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
          },
        });
      }
      workerExists = fs.existsSync(outfile);
    });

    afterAll(() => {
      // Clean up the built worker to avoid polluting the source tree.
      try {
        fs.unlinkSync(outfile);
      } catch {
        /* already gone */
      }
    });

    afterEach(() => {
      __resetWorkerScriptResolutionForTests();
    });

    it('spawn → init → find → dispose lifecycle', async () => {
      if (!workerExists) return;
      __resetWorkerScriptResolutionForTests();
      restorers.push(__setWorkerThresholdForTests(1));

      const files = [
        'src/main.ts',
        'src/utils/helper.ts',
        'src/utils/worker.ts',
        'README.md',
      ];
      const handle = await FzfWorkerHandle.create(files, { fuzzy: 'v2' });
      const results = await handle.find('worker');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].item).toBe('src/utils/worker.ts');
      await handle.dispose();
    });

    it('find() rejects after dispose()', async () => {
      if (!workerExists) return;
      __resetWorkerScriptResolutionForTests();
      restorers.push(__setWorkerThresholdForTests(1));

      const handle = await FzfWorkerHandle.create(['a.ts', 'b.ts'], {
        fuzzy: 'v2',
      });
      await handle.dispose();
      await expect(handle.find('a')).rejects.toThrow();
    });

    it('respects the limit parameter across IPC', async () => {
      if (!workerExists) return;
      __resetWorkerScriptResolutionForTests();
      restorers.push(__setWorkerThresholdForTests(1));

      const files = Array.from({ length: 200 }, (_, i) => `module${i}.ts`);
      const handle = await FzfWorkerHandle.create(files, { fuzzy: 'v2' });
      const results = await handle.find('module', 10);
      expect(results.length).toBeLessThanOrEqual(10);
      expect(results.length).toBeGreaterThan(0);
      await handle.dispose();
    });

    it('create() rejects and disposes on init failure', async () => {
      if (!workerExists) return;
      __resetWorkerScriptResolutionForTests();
      restorers.push(__setWorkerThresholdForTests(1));

      // Pass invalid options to trigger an init error in the worker.
      // AsyncFzf constructor throws on non-array input.
      await expect(
        FzfWorkerHandle.create(null as unknown as string[], {
          fuzzy: 'v2',
        }),
      ).rejects.toThrow();
    });

    it('handles concurrent find() calls', async () => {
      if (!workerExists) return;
      __resetWorkerScriptResolutionForTests();
      restorers.push(__setWorkerThresholdForTests(1));

      const files = [
        'alpha.ts',
        'beta.ts',
        'gamma.ts',
        'delta.ts',
        'epsilon.ts',
      ];
      const handle = await FzfWorkerHandle.create(files, { fuzzy: 'v2' });
      const [r1, r2, r3] = await Promise.all([
        handle.find('alpha'),
        handle.find('beta'),
        handle.find('gamma'),
      ]);
      expect(r1[0].item).toBe('alpha.ts');
      expect(r2[0].item).toBe('beta.ts');
      expect(r3[0].item).toBe('gamma.ts');
      await handle.dispose();
    });
  });
});
