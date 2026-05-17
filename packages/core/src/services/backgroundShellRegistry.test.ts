/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundShellRegistry,
  MAX_RETAINED_TERMINAL_SHELLS,
  type ShellTaskRegistration,
} from './backgroundShellRegistry.js';

function makeEntry(
  overrides: Partial<ShellTaskRegistration> = {},
): ShellTaskRegistration {
  return {
    shellId: 's1',
    command: 'sleep 60',
    cwd: '/tmp',
    status: 'running',
    startTime: 1000,
    outputPath: '/tmp/s1.output',
    abortController: new AbortController(),
    ...overrides,
  };
}

describe('BackgroundShellRegistry', () => {
  describe('register / get / getAll', () => {
    it('round-trips a registered entry by id', () => {
      const reg = new BackgroundShellRegistry();
      const e = makeEntry({ shellId: 'a' });
      reg.register(e);
      expect(reg.get('a')).toBe(e);
    });

    it('returns undefined for unknown id', () => {
      const reg = new BackgroundShellRegistry();
      expect(reg.get('missing')).toBeUndefined();
    });

    it('lists all entries via getAll', () => {
      const reg = new BackgroundShellRegistry();
      const a = makeEntry({ shellId: 'a' });
      const b = makeEntry({ shellId: 'b' });
      reg.register(a);
      reg.register(b);
      const all = reg.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(a);
      expect(all).toContain(b);
    });
  });

  describe('complete', () => {
    it('transitions running → completed with exitCode and endTime', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.complete('a', 0, 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(e.exitCode).toBe(0);
      expect(e.endTime).toBe(2000);
    });

    it('is a no-op when entry is not running', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.cancel('a', 1500);
      reg.complete('a', 0, 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('cancelled');
      expect(e.exitCode).toBeUndefined();
    });

    it('is a no-op for unknown id', () => {
      const reg = new BackgroundShellRegistry();
      expect(() => reg.complete('missing', 0, 0)).not.toThrow();
    });
  });

  describe('fail', () => {
    it('transitions running → failed with error and endTime', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.fail('a', 'spawn error', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('failed');
      expect(e.error).toBe('spawn error');
      expect(e.endTime).toBe(2000);
    });

    it('is a no-op when entry is not running', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.complete('a', 0, 1500);
      reg.fail('a', 'late error', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(e.error).toBeUndefined();
    });
  });

  describe('callbacks', () => {
    it('fires register callback synchronously when an entry is added', () => {
      const reg = new BackgroundShellRegistry();
      const seen: string[] = [];
      reg.setRegisterCallback((entry) => seen.push(entry.shellId));

      reg.register(makeEntry({ shellId: 'a' }));
      reg.register(makeEntry({ shellId: 'b' }));

      expect(seen).toEqual(['a', 'b']);
    });

    it('fires statusChange callback on register too (mirrors BackgroundTaskRegistry)', () => {
      const reg = new BackgroundShellRegistry();
      const seen: string[] = [];
      reg.setStatusChangeCallback((entry) => {
        if (entry) seen.push(entry.shellId);
      });
      reg.register(makeEntry({ shellId: 'a' }));
      reg.register(makeEntry({ shellId: 'b' }));
      expect(seen).toEqual(['a', 'b']);
    });

    it('fires statusChange callback on complete / fail / cancel', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.register(makeEntry({ shellId: 'b' }));
      reg.register(makeEntry({ shellId: 'c' }));
      const transitions: Array<{ id: string; status: string }> = [];
      reg.setStatusChangeCallback((entry) => {
        if (entry) {
          transitions.push({ id: entry.shellId, status: entry.status });
        }
      });

      reg.complete('a', 0, 1000);
      reg.fail('b', 'boom', 1100);
      reg.cancel('c', 1200);

      expect(transitions).toEqual([
        { id: 'a', status: 'completed' },
        { id: 'b', status: 'failed' },
        { id: 'c', status: 'cancelled' },
      ]);
    });

    it('does not fire statusChange when a transition is a no-op', () => {
      const reg = new BackgroundShellRegistry();
      const transitions: string[] = [];
      reg.setStatusChangeCallback((entry) => {
        if (entry) transitions.push(entry.shellId);
      });
      reg.register(makeEntry({ shellId: 'a' }));
      reg.complete('a', 0, 1000);
      transitions.length = 0;

      reg.complete('a', 0, 2000); // already terminal
      reg.fail('a', 'late', 2000); // already terminal
      reg.cancel('a', 2000); // already terminal
      reg.requestCancel('a'); // already terminal — also no fire

      expect(transitions).toEqual([]);
    });

    it('keeps the registry usable when a callback throws', () => {
      const reg = new BackgroundShellRegistry();
      reg.setRegisterCallback(() => {
        throw new Error('subscriber blew up');
      });

      expect(() => reg.register(makeEntry({ shellId: 'a' }))).not.toThrow();
      expect(reg.get('a')!.status).toBe('running');
    });

    it('clears subscriber when set to undefined', () => {
      const reg = new BackgroundShellRegistry();
      const seen: string[] = [];
      reg.setRegisterCallback((e) => seen.push(e.shellId));
      reg.register(makeEntry({ shellId: 'a' }));
      reg.setRegisterCallback(undefined);
      reg.register(makeEntry({ shellId: 'b' }));
      expect(seen).toEqual(['a']);
    });
  });

  describe('requestCancel', () => {
    it('aborts the signal but leaves status running and endTime undefined', () => {
      const reg = new BackgroundShellRegistry();
      const ac = new AbortController();
      reg.register(makeEntry({ shellId: 'a', abortController: ac }));

      reg.requestCancel('a');

      const e = reg.get('a')!;
      expect(e.status).toBe('running');
      expect(e.endTime).toBeUndefined();
      expect(ac.signal.aborted).toBe(true);
    });

    it('is a no-op on a terminal entry', () => {
      const reg = new BackgroundShellRegistry();
      const ac = new AbortController();
      reg.register(makeEntry({ shellId: 'a', abortController: ac }));
      reg.complete('a', 0, 1500);

      reg.requestCancel('a');

      expect(reg.get('a')!.status).toBe('completed');
      expect(ac.signal.aborted).toBe(false);
    });

    it('is a no-op for unknown id', () => {
      const reg = new BackgroundShellRegistry();
      expect(() => reg.requestCancel('missing')).not.toThrow();
    });
  });

  describe('abortAll', () => {
    it('cancels every running entry and leaves terminal entries alone', () => {
      const reg = new BackgroundShellRegistry();
      const acRunning1 = new AbortController();
      const acRunning2 = new AbortController();
      const acDone = new AbortController();
      reg.register(makeEntry({ shellId: 'a', abortController: acRunning1 }));
      reg.register(makeEntry({ shellId: 'b', abortController: acRunning2 }));
      reg.register(makeEntry({ shellId: 'c', abortController: acDone }));
      reg.complete('c', 0, 1500);

      reg.abortAll();

      expect(reg.get('a')!.status).toBe('cancelled');
      expect(reg.get('b')!.status).toBe('cancelled');
      expect(reg.get('c')!.status).toBe('completed');
      expect(acRunning1.signal.aborted).toBe(true);
      expect(acRunning2.signal.aborted).toBe(true);
      expect(acDone.signal.aborted).toBe(false);
    });

    it('is a no-op when registry is empty', () => {
      const reg = new BackgroundShellRegistry();
      expect(() => reg.abortAll()).not.toThrow();
    });

    it('fires statusChange exactly once regardless of how many entries cancel', () => {
      // The single subscriber (`useBackgroundTaskView`) re-pulls
      // `getAll()` from inside the callback, so per-entry statusChange
      // fires here just produce a flurry of redundant React re-renders
      // on shutdown / `/clear`. Pin the batch behavior so a future
      // refactor that loops `cancel()` again doesn't silently
      // re-introduce the wakeup churn.
      const reg = new BackgroundShellRegistry();
      const transitions: Array<{ id: string; status: string }> = [];
      for (let i = 0; i < 5; i++) {
        reg.register(makeEntry({ shellId: `s-${i}` }));
      }
      reg.setStatusChangeCallback((entry) => {
        if (entry) {
          transitions.push({ id: entry.shellId, status: entry.status });
        }
      });

      reg.abortAll();

      // All five entries must end up cancelled, but the callback
      // fires only once.
      for (let i = 0; i < 5; i++) {
        expect(reg.get(`s-${i}`)!.status).toBe('cancelled');
      }
      expect(transitions).toHaveLength(1);
      expect(transitions[0].status).toBe('cancelled');
    });

    it('does not fire statusChange when no entry was cancelled', () => {
      // Empty / all-already-terminal registries shouldn't wake the
      // subscriber for a no-op transition.
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.complete('a', 0, 1500);
      const cb = vi.fn();
      reg.setStatusChangeCallback(cb);

      reg.abortAll();

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('session switch helpers', () => {
    it('reports whether any shell is still running', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      expect(reg.hasRunningEntries()).toBe(true);
      reg.complete('a', 0, 1234);
      expect(reg.hasRunningEntries()).toBe(false);
    });

    it('reset clears all tracked entries', () => {
      const reg = new BackgroundShellRegistry();
      reg.register(makeEntry({ shellId: 'a' }));
      reg.register(makeEntry({ shellId: 'b' }));

      reg.reset();

      expect(reg.getAll()).toEqual([]);
    });
  });

  describe('terminal-entry retention cap', () => {
    it('retains only a bounded number of terminal entries (oldest by endTime evicted)', () => {
      const reg = new BackgroundShellRegistry();
      // Register and complete one more entry than the cap allows. Use
      // strictly increasing endTimes so eviction order is deterministic.
      for (let i = 0; i < MAX_RETAINED_TERMINAL_SHELLS + 2; i++) {
        reg.register(makeEntry({ shellId: `s-${i}`, startTime: i * 10 }));
        reg.complete(`s-${i}`, 0, i * 10 + 5);
      }
      expect(reg.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_SHELLS);
      // The two oldest (`s-0`, `s-1`) get pruned; the newest survives.
      expect(reg.get('s-0')).toBeUndefined();
      expect(reg.get('s-1')).toBeUndefined();
      expect(reg.get(`s-${MAX_RETAINED_TERMINAL_SHELLS + 1}`)).toBeDefined();
    });

    it('never evicts running entries even when the cap is exceeded', () => {
      const reg = new BackgroundShellRegistry();
      // Register one extra terminal entry beyond the cap, then a single
      // running entry. The running entry must be retained regardless of
      // its launch order — pruning a still-running shell would lose the
      // user's only handle on a live process.
      reg.register(makeEntry({ shellId: 'live', startTime: 1 }));
      for (let i = 0; i < MAX_RETAINED_TERMINAL_SHELLS + 1; i++) {
        reg.register(
          makeEntry({ shellId: `done-${i}`, startTime: 100 + i * 10 }),
        );
        reg.complete(`done-${i}`, 0, 100 + i * 10 + 5);
      }
      // Cap-of-32 terminals + 1 running survivor = 33 entries kept.
      expect(reg.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_SHELLS + 1);
      expect(reg.get('live')?.status).toBe('running');
      // The oldest terminal entry (lowest endTime) is the one evicted.
      expect(reg.get('done-0')).toBeUndefined();
    });

    it('prunes after fail() too, not just complete()', () => {
      const reg = new BackgroundShellRegistry();
      for (let i = 0; i < MAX_RETAINED_TERMINAL_SHELLS; i++) {
        reg.register(makeEntry({ shellId: `done-${i}`, startTime: i * 10 }));
        reg.complete(`done-${i}`, 0, i * 10 + 5);
      }
      const overflowStart = MAX_RETAINED_TERMINAL_SHELLS * 10 + 100;
      reg.register(
        makeEntry({ shellId: 'overflow', startTime: overflowStart }),
      );
      reg.fail('overflow', 'boom', overflowStart + 5);
      expect(reg.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_SHELLS);
      expect(reg.get('done-0')).toBeUndefined();
      expect(reg.get('overflow')?.status).toBe('failed');
    });

    it('prunes after cancel() too, not just complete()', () => {
      const reg = new BackgroundShellRegistry();
      for (let i = 0; i < MAX_RETAINED_TERMINAL_SHELLS; i++) {
        reg.register(makeEntry({ shellId: `done-${i}`, startTime: i * 10 }));
        reg.complete(`done-${i}`, 0, i * 10 + 5);
      }
      const overflowStart = MAX_RETAINED_TERMINAL_SHELLS * 10 + 100;
      reg.register(
        makeEntry({ shellId: 'overflow', startTime: overflowStart }),
      );
      reg.cancel('overflow', overflowStart + 5);
      expect(reg.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_SHELLS);
      expect(reg.get('done-0')).toBeUndefined();
      expect(reg.get('overflow')?.status).toBe('cancelled');
    });
  });

  describe('cancel', () => {
    it('transitions running → cancelled and aborts the signal', () => {
      const reg = new BackgroundShellRegistry();
      const ac = new AbortController();
      reg.register(makeEntry({ shellId: 'a', abortController: ac }));
      reg.cancel('a', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('cancelled');
      expect(e.endTime).toBe(2000);
      expect(ac.signal.aborted).toBe(true);
    });

    it('is a no-op when entry is already terminal', () => {
      const reg = new BackgroundShellRegistry();
      const ac = new AbortController();
      reg.register(makeEntry({ shellId: 'a', abortController: ac }));
      reg.complete('a', 0, 1500);
      reg.cancel('a', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(ac.signal.aborted).toBe(false);
    });

    it('is a no-op for unknown id', () => {
      const reg = new BackgroundShellRegistry();
      expect(() => reg.cancel('missing', 0)).not.toThrow();
    });
  });
});
