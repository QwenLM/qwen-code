/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
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
});
