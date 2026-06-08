/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  constants as fsConstants,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRegistry } from './registry.js';
import {
  _resetShellTaskModuleStateForTest,
  getAllShellTasks,
  getShellTask,
  MAX_NOTIFICATION_OUTPUT_TAIL_BYTES,
  setShellNotificationCallback,
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

let tmpDirs: string[] = [];

afterEach(() => {
  _resetShellTaskModuleStateForTest();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeOutputFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-shell-notification-'));
  tmpDirs.push(dir);
  const file = join(dir, 'shell.output');
  writeFileSync(file, content);
  return file;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-shell-notification-'));
  tmpDirs.push(dir);
  return dir;
}

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

  describe('setShellNotificationCallback(undefined) clears the callback', () => {
    it('prevents notifications after clearing', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      setShellNotificationCallback(reg, undefined);
      shellComplete(reg, 'a', 0, 2000);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('notifications', () => {
    it('emits one task-notification when a shell completes', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      const outputPath = makeOutputFile('first line\nfinal result\n');
      setShellNotificationCallback(reg, callback);
      shellRegister(
        reg,
        makeEntry({
          shellId: 'a',
          command: 'npm test',
          cwd: '/repo',
          outputPath,
          pid: 1234,
        }),
      );

      shellComplete(reg, 'a', 0, 2000);

      expect(callback).toHaveBeenCalledTimes(1);
      const [displayText, modelText, meta] = callback.mock.calls[0];
      expect(displayText).toBe('Background shell "npm test" completed.');
      expect(modelText).toContain('<task-notification>');
      expect(modelText).toContain('<task-id>a</task-id>');
      expect(modelText).toContain('<kind>shell</kind>');
      expect(modelText).toContain('<status>completed</status>');
      expect(modelText).toContain('<command>npm test</command>');
      expect(modelText).toContain('<cwd>/repo</cwd>');
      expect(modelText).toContain('<pid>1234</pid>');
      expect(modelText).toContain('<exit-code>0</exit-code>');
      expect(modelText).toContain(
        '<output-tail truncated="false">first line\nfinal result</output-tail>',
      );
      expect(modelText).toContain(`<output-file>${outputPath}</output-file>`);
      expect(meta).toEqual({
        shellId: 'a',
        status: 'completed',
        exitCode: 0,
      });
    });

    it('truncates long commands for display, summary, and model XML', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      const command = `node -e ${'a'.repeat(700)}`;
      const displayCommand = command.slice(0, 77) + '...';
      const modelCommand = command.slice(0, 497) + '...';
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a', command }));

      shellComplete(reg, 'a', 0, 2000);

      const [displayText, modelText] = callback.mock.calls[0];
      expect(displayText).toBe(
        `Background shell "${displayCommand}" completed.`,
      );
      expect(modelText).toContain(
        `<summary>Shell command "${displayCommand}" completed.</summary>`,
      );
      expect(modelText).toContain(
        `<command truncated="true">${modelCommand}</command>`,
      );
      expect(modelText).not.toContain(command);
    });

    it('escapes XML and strips display control characters on failure', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      setShellNotificationCallback(reg, callback);
      shellRegister(
        reg,
        makeEntry({
          shellId: 'a&b',
          command: 'echo "<script>"',
          cwd: '/repo&work',
          outputPath: '/tmp/out&err.log',
        }),
      );

      shellFail(reg, 'a&b', 'bad <thing>\x1B[31m', 2000);

      const [displayText, modelText] = callback.mock.calls[0];
      expect(displayText).toBe('Background shell "echo "<script>"" failed.');
      expect(modelText).toContain('<task-id>a&amp;b</task-id>');
      expect(modelText).toContain(
        '<command>echo &quot;&lt;script&gt;&quot;</command>',
      );
      expect(modelText).toContain('<cwd>/repo&amp;work</cwd>');
      expect(modelText).toContain('<result>bad &lt;thing&gt;[31m</result>');
      expect(modelText).toContain(
        '<output-file>/tmp/out&amp;err.log</output-file>',
      );
    });

    it('limits output-tail to the retained byte budget', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      const outputPath = makeOutputFile(
        'prefix-' +
          'a'.repeat(MAX_NOTIFICATION_OUTPUT_TAIL_BYTES) +
          '\nlast line\n',
      );
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a', outputPath }));

      shellComplete(reg, 'a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<output-tail truncated="true">');
      expect(modelText).toContain('last line</output-tail>');
      expect(modelText).not.toContain('prefix-');
    });

    it('skips leading UTF-8 continuation bytes at the truncation boundary', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      const dir = mkdtempSync(join(tmpdir(), 'qwen-shell-utf8-'));
      tmpDirs.push(dir);
      const file = join(dir, 'shell.output');
      const padding = 'a'.repeat(MAX_NOTIFICATION_OUTPUT_TAIL_BYTES - 1);
      const content = padding + '\u20AC' + '\nfinal output\n';
      writeFileSync(file, content);
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a', outputPath: file }));

      shellComplete(reg, 'a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<output-tail truncated="true">');
      expect(modelText).toContain('final output</output-tail>');
      expect(modelText).not.toContain('\uFFFD');
    });

    it('strips control characters from cwd and output-file XML fields', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      setShellNotificationCallback(reg, callback);
      shellRegister(
        reg,
        makeEntry({
          shellId: 'a',
          cwd: '/repo\x01\x02/work',
          outputPath: '/tmp/out\x03.log',
        }),
      );

      shellComplete(reg, 'a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<cwd>/repo/work</cwd>');
      expect(modelText).toContain('<output-file>/tmp/out.log</output-file>');
      expect(modelText).not.toContain('\x01');
      expect(modelText).not.toContain('\x02');
      expect(modelText).not.toContain('\x03');
    });

    const itNoFollow = fsConstants.O_NOFOLLOW === undefined ? it.skip : it;

    itNoFollow('does not follow symlinked output files', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      const dir = makeTempDir();
      const secretPath = join(dir, 'secret.txt');
      const outputPath = join(dir, 'shell.output');
      writeFileSync(secretPath, 'secret credentials');
      symlinkSync(secretPath, outputPath);
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a', outputPath }));

      shellComplete(reg, 'a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).not.toContain('secret credentials');
      expect(modelText).toContain('<output-tail error="unreadable"');
    });

    it('skips output-tail when the output file does not exist', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      setShellNotificationCallback(reg, callback);
      shellRegister(
        reg,
        makeEntry({
          shellId: 'a',
          outputPath: join(tmpdir(), 'qwen-shell-no-such-file-xyz.log'),
        }),
      );

      expect(() => shellComplete(reg, 'a', 0, 2000)).not.toThrow();

      expect(callback).toHaveBeenCalledTimes(1);
      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<output-tail error="unreadable"');
      expect(getShellTask(reg, 'a')!.status).toBe('completed');
    });

    it('skips output-tail when outputPath is a directory (not a regular file)', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      const dir = makeTempDir();
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a', outputPath: dir }));

      shellComplete(reg, 'a', 0, 2000);

      expect(callback).toHaveBeenCalledTimes(1);
      const [, modelText] = callback.mock.calls[0];
      expect(modelText).not.toContain('<output-tail');
    });

    it('skips output-tail when the output file is empty (stat.size === 0)', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      const outputPath = makeOutputFile('');
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a', outputPath }));

      shellComplete(reg, 'a', 0, 2000);

      expect(callback).toHaveBeenCalledTimes(1);
      const [, modelText] = callback.mock.calls[0];
      expect(modelText).not.toContain('<output-tail');
    });

    it('keeps the registry usable when the notification callback throws', () => {
      const reg = new TaskRegistry();
      setShellNotificationCallback(reg, () => {
        throw new Error('subscriber blew up');
      });
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellRegister(reg, makeEntry({ shellId: 'b' }));

      expect(() => shellComplete(reg, 'a', 0, 2000)).not.toThrow();
      expect(() => shellFail(reg, 'b', 'boom', 3000)).not.toThrow();
      expect(getShellTask(reg, 'a')!.status).toBe('completed');
      expect(getShellTask(reg, 'b')!.status).toBe('failed');
    });

    it('does not emit more than once for late terminal transitions', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a' }));

      shellComplete(reg, 'a', 0, 2000);
      shellFail(reg, 'a', 'late failure', 3000);
      shellCancel(reg, 'a', 4000);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('waits until cancel() to notify after requestCancel()', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a' }));

      shellRequestCancel(reg, 'a');

      expect(callback).not.toHaveBeenCalled();

      shellCancel(reg, 'a', 2000);

      expect(callback).toHaveBeenCalledTimes(1);
      const [displayText, modelText, meta] = callback.mock.calls[0];
      expect(displayText).toBe('Background shell "sleep 60" was cancelled.');
      expect(modelText).toContain('<status>cancelled</status>');
      expect(meta).toEqual({
        shellId: 'a',
        status: 'cancelled',
        exitCode: undefined,
      });
    });

    it('does not emit notifications from abortAll shutdown cleanup', () => {
      const reg = new TaskRegistry();
      const callback = vi.fn();
      setShellNotificationCallback(reg, callback);
      shellRegister(reg, makeEntry({ shellId: 'a' }));
      shellRegister(reg, makeEntry({ shellId: 'b' }));

      shellAbortAll(reg);

      expect(callback).not.toHaveBeenCalled();
      expect(getShellTask(reg, 'a')!.notified).toBe(false);
      expect(getShellTask(reg, 'b')!.notified).toBe(false);
    });
  });
});
