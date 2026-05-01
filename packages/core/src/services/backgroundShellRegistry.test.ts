/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  BackgroundShellRegistry,
  type BackgroundShellEntry,
} from './backgroundShellRegistry.js';

function makeEntry(
  overrides: Partial<BackgroundShellEntry> = {},
): BackgroundShellEntry {
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
