/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { listDescendantPids, sigtermPids } from './pid-descendants.js';

describe('pid-descendants', () => {
  describe('listDescendantPids (input validation)', () => {
    it('returns [] for non-positive pid', async () => {
      expect(await listDescendantPids(0)).toEqual([]);
      expect(await listDescendantPids(-1)).toEqual([]);
    });

    it('returns [] for non-integer pid', async () => {
      expect(await listDescendantPids(1.5)).toEqual([]);
      expect(await listDescendantPids(Number.NaN)).toEqual([]);
    });

    it('returns [] for a pid with no children (current test process leaf)', async () => {
      // The vitest worker forks happen at the test runner level; a
      // freshly-spawned no-child process should reliably have no
      // descendants. Use process.pid only if the worker has no child
      // — fallback to a real spawn for robustness.
      const child = spawn(process.execPath, [
        '-e',
        'setTimeout(() => {}, 200)',
      ]);
      try {
        // Give the child a moment to settle.
        await new Promise((r) => setTimeout(r, 50));
        const descendants = await listDescendantPids(child.pid!);
        expect(descendants).toEqual([]);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });

  describe('sigtermPids', () => {
    it('returns 0 for empty input', () => {
      expect(sigtermPids([])).toBe(0);
    });

    it('tolerates already-exited pids (ESRCH swallowed)', () => {
      // Pick a pid almost certainly not in use. process.kill with
      // SIGTERM to a non-existent pid throws ESRCH which sigtermPids
      // catches.
      const result = sigtermPids([999999, 999998]);
      // The function returns the count of "successfully signaled" pids
      // (where process.kill didn't throw). For non-existent pids,
      // it throws ESRCH which is caught, so the count is 0.
      expect(result).toBe(0);
    });
  });

  // Cross-platform integration test: spawn a wrapper that itself
  // spawns a child, verify listDescendantPids finds both levels.
  //
  // F2 (#4175 commit 6 review fix — wenshao R10 / R23 T7 / PR A):
  // Pre-fix gate skipped on `CI === '1'` (pgrep not always available
  // on minimal CI runners). Post-fix the snapshot path uses
  // `ps -A -o pid=,ppid=` (POSIX standard, available on every
  // non-distroless Linux/macOS), so we keep only the Windows skip;
  // the snapshot's per-pid pgrep fallback covers the rare BusyBox
  // <v1.28 case but isn't tested here.
  describe(
    'integration: spawn-and-enumerate',
    { skip: process.platform === 'win32' },
    () => {
      it('enumerates one level of children via process-tree snapshot', async () => {
        // Parent process spawns a node child with `--eval` that sleeps.
        // Use spawn directly so we control the lifecycle.
        const parent = spawn('/bin/sh', [
          '-c',
          'node -e "setTimeout(() => {}, 5000)" & wait',
        ]);
        try {
          // Give the shell time to spawn the node grandchild.
          await new Promise((r) => setTimeout(r, 500));
          const descendants = await listDescendantPids(parent.pid!);
          // We expect at least one descendant (the `node` process
          // spawned by the shell).
          expect(descendants.length).toBeGreaterThanOrEqual(1);
        } finally {
          try {
            parent.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }, 10_000);
    },
  );
});
