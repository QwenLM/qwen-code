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
import {
  BackgroundShellRegistry,
  MAX_NOTIFICATION_OUTPUT_TAIL_BYTES,
  MAX_RETAINED_TERMINAL_SHELLS,
  type ShellTaskRegistration,
} from './backgroundShellRegistry.js';

let tmpDirs: string[] = [];

afterEach(() => {
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

    it('setNotificationCallback(undefined) clears the callback', () => {
      // useGeminiStream's cleanup relies on this contract to avoid
      // leaked callbacks firing into torn-down React state on unmount.
      // If a future refactor breaks the clearing path, stale callbacks
      // would fire silently — no test would catch it without this guard.
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a' }));
      reg.setNotificationCallback(undefined);
      reg.complete('a', 0, 2000);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('notifications', () => {
    it('emits one task-notification when a shell completes', () => {
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      const outputPath = makeOutputFile('first line\nfinal result\n');
      reg.setNotificationCallback(callback);
      reg.register(
        makeEntry({
          shellId: 'a',
          command: 'npm test',
          cwd: '/repo',
          outputPath,
          pid: 1234,
        }),
      );

      reg.complete('a', 0, 2000);

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
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      const command = `node -e ${'a'.repeat(700)}`;
      const displayCommand = command.slice(0, 77) + '...';
      const modelCommand = command.slice(0, 497) + '...';
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a', command }));

      reg.complete('a', 0, 2000);

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
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      reg.register(
        makeEntry({
          shellId: 'a&b',
          command: 'echo "<script>"',
          cwd: '/repo&work',
          outputPath: '/tmp/out&err.log',
        }),
      );

      reg.fail('a&b', 'bad <thing>\x1B[31m', 2000);

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
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      const outputPath = makeOutputFile(
        'prefix-' +
          'a'.repeat(MAX_NOTIFICATION_OUTPUT_TAIL_BYTES) +
          '\nlast line\n',
      );
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a', outputPath }));

      reg.complete('a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<output-tail truncated="true">');
      expect(modelText).toContain('last line</output-tail>');
      expect(modelText).not.toContain('prefix-');
    });

    it('skips leading UTF-8 continuation bytes at the truncation boundary', () => {
      // When the byte budget cuts a multi-byte UTF-8 codepoint in half,
      // the raw read would produce a U+FFFD replacement character.
      // Place a 3-byte '€' (U+20AC → 0xE2 0x82 0xAC) so that the
      // truncation offset lands on its second byte.
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      const dir = mkdtempSync(join(tmpdir(), 'qwen-shell-utf8-'));
      tmpDirs.push(dir);
      const file = join(dir, 'shell.output');
      const padding = 'a'.repeat(MAX_NOTIFICATION_OUTPUT_TAIL_BYTES - 1);
      // 1 byte of 'a' + 2 continuation bytes = 3 bytes before the clean text
      const content = padding + '\u20AC' + '\nfinal output\n';
      writeFileSync(file, content);
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a', outputPath: file }));

      reg.complete('a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<output-tail truncated="true">');
      expect(modelText).toContain('final output</output-tail>');
      // Must not contain the UTF-8 replacement character
      expect(modelText).not.toContain('\uFFFD');
    });

    it('strips control characters from cwd and output-file XML fields', () => {
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      reg.register(
        makeEntry({
          shellId: 'a',
          cwd: '/repo\x01\x02/work',
          outputPath: '/tmp/out\x03.log',
        }),
      );

      reg.complete('a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<cwd>/repo/work</cwd>');
      expect(modelText).toContain('<output-file>/tmp/out.log</output-file>');
      expect(modelText).not.toContain('\x01');
      expect(modelText).not.toContain('\x02');
      expect(modelText).not.toContain('\x03');
    });

    const itNoFollow = fsConstants.O_NOFOLLOW === undefined ? it.skip : it;

    itNoFollow('does not follow symlinked output files', () => {
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      const dir = makeTempDir();
      const secretPath = join(dir, 'secret.txt');
      const outputPath = join(dir, 'shell.output');
      writeFileSync(secretPath, 'secret credentials');
      symlinkSync(secretPath, outputPath);
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a', outputPath }));

      reg.complete('a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).not.toContain('secret credentials');
      expect(modelText).toContain('<output-tail error="unreadable"');
    });

    it('skips output-tail when the output file does not exist', () => {
      // Guards the catch branch in `readOutputTail`. If the try/catch
      // ever regresses to throwing, `complete()` would propagate the
      // error and the entry would never reach a terminal status.
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      reg.register(
        makeEntry({
          shellId: 'a',
          outputPath: join(tmpdir(), 'qwen-shell-no-such-file-xyz.log'),
        }),
      );

      expect(() => reg.complete('a', 0, 2000)).not.toThrow();

      expect(callback).toHaveBeenCalledTimes(1);
      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<output-tail error="unreadable"');
      expect(reg.get('a')!.status).toBe('completed');
    });

    it('skips output-tail when outputPath is a directory (not a regular file)', () => {
      // Guards the `!stat.isFile()` early-return in `readOutputTail`.
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      const dir = makeTempDir();
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a', outputPath: dir }));

      reg.complete('a', 0, 2000);

      expect(callback).toHaveBeenCalledTimes(1);
      const [, modelText] = callback.mock.calls[0];
      expect(modelText).not.toContain('<output-tail');
    });

    it('skips output-tail when the output file is empty (stat.size === 0)', () => {
      // Guards the `stat.size <= 0` early-return in `readOutputTail`.
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      const outputPath = makeOutputFile('');
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a', outputPath }));

      reg.complete('a', 0, 2000);

      expect(callback).toHaveBeenCalledTimes(1);
      const [, modelText] = callback.mock.calls[0];
      expect(modelText).not.toContain('<output-tail');
    });

    it('keeps the registry usable when the notification callback throws', () => {
      const reg = new BackgroundShellRegistry();
      reg.setNotificationCallback(() => {
        throw new Error('subscriber blew up');
      });
      reg.register(makeEntry({ shellId: 'a' }));
      reg.register(makeEntry({ shellId: 'b' }));

      expect(() => reg.complete('a', 0, 2000)).not.toThrow();
      expect(() => reg.fail('b', 'boom', 3000)).not.toThrow();
      expect(reg.get('a')!.status).toBe('completed');
      expect(reg.get('b')!.status).toBe('failed');
    });

    it('does not emit more than once for late terminal transitions', () => {
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a' }));

      reg.complete('a', 0, 2000);
      reg.fail('a', 'late failure', 3000);
      reg.cancel('a', 4000);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('waits until cancel() to notify after requestCancel()', () => {
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a' }));

      reg.requestCancel('a');

      expect(callback).not.toHaveBeenCalled();

      reg.cancel('a', 2000);

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
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'a' }));
      reg.register(makeEntry({ shellId: 'b' }));

      reg.abortAll();

      expect(callback).not.toHaveBeenCalled();
      expect(reg.get('a')!.notified).toBe(false);
      expect(reg.get('b')!.notified).toBe(false);
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
