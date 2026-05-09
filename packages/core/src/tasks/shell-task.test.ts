/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TaskRegistry } from './registry.js';
import {
  getAllShellTasks,
  getShellTask,
  shellAbortAll,
  shellCancel,
  shellComplete,
  shellFail,
  shellHasRunningEntries,
  shellRegister,
  shellRequestCancel,
  shellReset,
  type ShellTaskRegistration,
} from './shell-task.js';

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

describe('shell-task helpers', () => {
  describe('register / get / getAll', () => {
    it('round-trips a registered entry by id', () => {
      const reg = new TaskRegistry();
      const e = makeEntry({ shellId: 'a' });
      shellRegister(reg, e);
      expect(getShellTask(reg, 'a')).toBe(e);
    });

    it('returns undefined for unknown id', () => {
      const reg = new TaskRegistry();
      expect(getShellTask(reg, 'missing')).toBeUndefined();
    });

    it('lists all entries via getAllShellTasks', () => {
      const reg = new TaskRegistry();
      const a = makeEntry({ shellId: 'a' });
      const b = makeEntry({ shellId: 'b' });
      shellRegister(reg, a);
      shellRegister(reg, b);
      const all = getAllShellTasks(reg);
      expect(all).toHaveLength(2);
      expect(all).toContain(a);
      expect(all).toContain(b);
    });
  });

  describe('shellComplete', () => {
    it('transitions running → completed with exitCode and endTime', () => {
      const reg = new TaskRegistry();
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellComplete(reg, 'a', 0, 2000);
      const e = getShellTask(reg, 'a')!;
      expect(e.status).toBe('completed');
      expect(e.exitCode).toBe(0);
      expect(e.endTime).toBe(2000);
    });

    it('is a no-op when entry is not running', () => {
      const reg = new TaskRegistry();
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellCancel(reg, 'a', 1500);
      shellComplete(reg, 'a', 0, 2000);
      const e = getShellTask(reg, 'a')!;
      expect(e.status).toBe('cancelled');
      expect(e.exitCode).toBeUndefined();
    });

    it('is a no-op for unknown id', () => {
      const reg = new TaskRegistry();
      expect(() => shellComplete(reg, 'missing', 0, 0)).not.toThrow();
    });
  });

  describe('shellFail', () => {
    it('transitions running → failed with error and endTime', () => {
      const reg = new TaskRegistry();
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellFail(reg, 'a', 'spawn error', 2000);
      const e = getShellTask(reg, 'a')!;
      expect(e.status).toBe('failed');
      expect(e.error).toBe('spawn error');
      expect(e.endTime).toBe(2000);
    });

    it('is a no-op when entry is not running', () => {
      const reg = new TaskRegistry();
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellComplete(reg, 'a', 0, 1500);
      shellFail(reg, 'a', 'late error', 2000);
      const e = getShellTask(reg, 'a')!;
      expect(e.status).toBe('completed');
      expect(e.error).toBeUndefined();
    });
  });

  describe('subscribe (collapsed register + statusChange)', () => {
    it('fires once on register and again on each terminal transition', () => {
      const reg = new TaskRegistry();
      const transitions: Array<{ id: string; status: string }> = [];
      reg.subscribe((entry) => {
        if (entry?.kind === 'shell') {
          transitions.push({ id: entry.shellId, status: entry.status });
        }
      });

      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellRegister(reg, makeEntry({ shellId: 'b' }));
      shellRegister(reg, makeEntry({ shellId: 'c' }));
      shellComplete(reg, 'a', 0, 1000);
      shellFail(reg, 'b', 'boom', 1100);
      shellCancel(reg, 'c', 1200);

      expect(transitions).toEqual([
        { id: 'a', status: 'running' },
        { id: 'b', status: 'running' },
        { id: 'c', status: 'running' },
        { id: 'a', status: 'completed' },
        { id: 'b', status: 'failed' },
        { id: 'c', status: 'cancelled' },
      ]);
    });

    it('does not fire when a transition is a no-op', () => {
      const reg = new TaskRegistry();
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellComplete(reg, 'a', 0, 1000);

      const transitions: string[] = [];
      reg.subscribe((entry) => {
        if (entry?.kind === 'shell') transitions.push(entry.shellId);
      });

      shellComplete(reg, 'a', 0, 2000); // already terminal
      shellFail(reg, 'a', 'late', 2000); // already terminal
      shellCancel(reg, 'a', 2000); // already terminal
      shellRequestCancel(reg, 'a'); // already terminal — also no fire

      expect(transitions).toEqual([]);
    });

    it('keeps the registry usable when a subscriber throws', () => {
      const reg = new TaskRegistry();
      reg.subscribe(() => {
        throw new Error('subscriber blew up');
      });

      expect(() =>
        shellRegister(reg, makeEntry({ shellId: 'a' })),
      ).not.toThrow();
      expect(getShellTask(reg, 'a')!.status).toBe('running');
    });

    it('unsubscribe handle removes the listener', () => {
      const reg = new TaskRegistry();
      const seen: string[] = [];
      const unsubscribe = reg.subscribe((entry) => {
        if (entry?.kind === 'shell') seen.push(entry.shellId);
      });
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      unsubscribe();
      shellRegister(reg, makeEntry({ shellId: 'b' }));
      expect(seen).toEqual(['a']);
    });
  });

  describe('shellRequestCancel', () => {
    it('aborts the signal but leaves status running and endTime undefined', () => {
      const reg = new TaskRegistry();
      const ac = new AbortController();
      shellRegister(reg, makeEntry({ shellId: 'a', abortController: ac }));

      shellRequestCancel(reg, 'a');

      const e = getShellTask(reg, 'a')!;
      expect(e.status).toBe('running');
      expect(e.endTime).toBeUndefined();
      expect(ac.signal.aborted).toBe(true);
    });

    it('is a no-op on a terminal entry', () => {
      const reg = new TaskRegistry();
      const ac = new AbortController();
      shellRegister(reg, makeEntry({ shellId: 'a', abortController: ac }));
      shellComplete(reg, 'a', 0, 1500);

      shellRequestCancel(reg, 'a');

      expect(getShellTask(reg, 'a')!.status).toBe('completed');
      expect(ac.signal.aborted).toBe(false);
    });

    it('is a no-op for unknown id', () => {
      const reg = new TaskRegistry();
      expect(() => shellRequestCancel(reg, 'missing')).not.toThrow();
    });
  });

  describe('shellAbortAll', () => {
    it('cancels every running entry and leaves terminal entries alone', () => {
      const reg = new TaskRegistry();
      const acRunning1 = new AbortController();
      const acRunning2 = new AbortController();
      const acDone = new AbortController();
      shellRegister(
        reg,
        makeEntry({ shellId: 'a', abortController: acRunning1 }),
      );
      shellRegister(
        reg,
        makeEntry({ shellId: 'b', abortController: acRunning2 }),
      );
      shellRegister(reg, makeEntry({ shellId: 'c', abortController: acDone }));
      shellComplete(reg, 'c', 0, 1500);

      shellAbortAll(reg);

      expect(getShellTask(reg, 'a')!.status).toBe('cancelled');
      expect(getShellTask(reg, 'b')!.status).toBe('cancelled');
      expect(getShellTask(reg, 'c')!.status).toBe('completed');
      expect(acRunning1.signal.aborted).toBe(true);
      expect(acRunning2.signal.aborted).toBe(true);
      expect(acDone.signal.aborted).toBe(false);
    });

    it('is a no-op when registry is empty', () => {
      const reg = new TaskRegistry();
      expect(() => shellAbortAll(reg)).not.toThrow();
    });
  });

  describe('session switch helpers', () => {
    it('reports whether any shell is still running', () => {
      const reg = new TaskRegistry();
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      expect(shellHasRunningEntries(reg)).toBe(true);
      shellComplete(reg, 'a', 0, 1234);
      expect(shellHasRunningEntries(reg)).toBe(false);
    });

    it('reset clears all tracked shell entries (other kinds untouched)', () => {
      const reg = new TaskRegistry();
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellRegister(reg, makeEntry({ shellId: 'b' }));

      shellReset(reg);

      expect(getAllShellTasks(reg)).toEqual([]);
    });
  });

  describe('shellCancel', () => {
    it('transitions running → cancelled and aborts the signal', () => {
      const reg = new TaskRegistry();
      const ac = new AbortController();
      shellRegister(reg, makeEntry({ shellId: 'a', abortController: ac }));
      shellCancel(reg, 'a', 2000);
      const e = getShellTask(reg, 'a')!;
      expect(e.status).toBe('cancelled');
      expect(e.endTime).toBe(2000);
      expect(ac.signal.aborted).toBe(true);
    });

    it('is a no-op when entry is already terminal', () => {
      const reg = new TaskRegistry();
      const ac = new AbortController();
      shellRegister(reg, makeEntry({ shellId: 'a', abortController: ac }));
      shellComplete(reg, 'a', 0, 1500);
      shellCancel(reg, 'a', 2000);
      const e = getShellTask(reg, 'a')!;
      expect(e.status).toBe('completed');
      expect(ac.signal.aborted).toBe(false);
    });

    it('is a no-op for unknown id', () => {
      const reg = new TaskRegistry();
      expect(() => shellCancel(reg, 'missing', 0)).not.toThrow();
    });
  });
});
