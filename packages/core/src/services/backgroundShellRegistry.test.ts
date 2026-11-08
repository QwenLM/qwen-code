/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFileSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackgroundShellRegistry,
  MAX_NOTIFICATION_OUTPUT_TAIL_BYTES,
  MAX_RETAINED_TERMINAL_SHELLS,
  settleOrphanedShellStatusFiles,
  statusFilePathFor,
  watchOrphanedShellStatusFiles,
  type ShellPidScope,
  type ShellTaskRegistration,
} from './backgroundShellRegistry.js';
import {
  promptIdContext,
  todoWorkChainContext,
} from '../utils/promptIdContext.js';
import { escapeXml } from '../utils/xml.js';
import { stripDisplayControlChars } from '../utils/terminalSafe.js';

/**
 * Builds the expected `<output-file>` element with the same
 * `stripDisplayControlChars` + `escapeXml` pipeline the registry applies.
 * Expected paths below come from `tmpdir()`, which can legally contain XML
 * metacharacters (`&` on Windows, `<` on POSIX) or bidi overrides, so
 * hand-rolling the escaping would make these cases depend on the host's TMPDIR.
 */
function expectedOutputFileElement(path: string): string {
  return `<output-file>${escapeXml(stripDisplayControlChars(path))}</output-file>`;
}

let tmpDirs: string[] = [];
let tmpFiles: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const file of tmpFiles) {
    rmSync(file, { force: true });
  }
  tmpDirs = [];
  tmpFiles = [];
});

function makeOutputFile(content: string): string {
  const file = join(makeTempDir(), 'shell.output');
  writeFileSync(file, content);
  return file;
}

function makeTempDir(prefix = 'qwen-shell-notification-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeEntry(
  overrides: Partial<ShellTaskRegistration> = {},
): ShellTaskRegistration {
  const shellId = overrides.shellId ?? 's1';
  return {
    shellId,
    command: 'sleep 60',
    cwd: '/tmp',
    status: 'running',
    startTime: 1000,
    abortController: new AbortController(),
    ...overrides,
    // Every register/complete/fail/cancel mirrors the entry into a
    // `<outputPath>.status` sidecar. A fixed `/tmp/s1.output` sent every
    // entry (across tests, workers and CI jobs) to the single path
    // `/tmp/s1.status`; `/tmp` is sticky, so once that file belongs to
    // another uid the atomic rename fails EPERM and `renameWithRetrySync`
    // burns its full 50+100+200ms backoff before the registry swallows the
    // error. A directory per entry shares no state and the write succeeds.
    outputPath:
      overrides.outputPath ?? join(makeTempDir(), `shell-${shellId}.output`),
  };
}

describe('BackgroundShellRegistry', () => {
  let reg: BackgroundShellRegistry;
  beforeEach(() => {
    reg = new BackgroundShellRegistry();
  });
  const add = (...ids: string[]) => {
    for (const shellId of ids) reg.register(makeEntry({ shellId }));
  };

  it('gives each entry a unique default outputPath', () => {
    expect(makeEntry().outputPath).not.toBe(makeEntry().outputPath);
  });

  describe('register / get / getAll', () => {
    it('captures the Todo work-chain owner at registration', () => {
      const entry = todoWorkChainContext.run('work-chain-1', () =>
        reg.register(makeEntry()),
      );

      expect(entry.todoWorkChainId).toBe('work-chain-1');
    });

    it('round-trips a registered entry by id', () => {
      const e = makeEntry({ shellId: 'a' });
      reg.register(e);
      expect(reg.get('a')).toBe(e);
    });

    it('returns undefined for unknown id', () => {
      expect(reg.get('missing')).toBeUndefined();
    });

    it('lists all entries via getAll', () => {
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
      add('a');
      reg.complete('a', 0, 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(e.exitCode).toBe(0);
      expect(e.endTime).toBe(2000);
    });

    it('is a no-op when entry is not running', () => {
      add('a');
      reg.cancel('a', 1500);
      reg.complete('a', 0, 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('cancelled');
      expect(e.exitCode).toBeUndefined();
    });

    it('is a no-op for unknown id', () => {
      expect(() => reg.complete('missing', 0, 0)).not.toThrow();
    });
  });

  describe('fail', () => {
    it('transitions running → failed with error and endTime', () => {
      add('a');
      reg.fail('a', 'spawn error', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('failed');
      expect(e.error).toBe('spawn error');
      expect(e.endTime).toBe(2000);
    });

    it('is a no-op when entry is not running', () => {
      add('a');
      reg.complete('a', 0, 1500);
      reg.fail('a', 'late error', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(e.error).toBeUndefined();
    });
  });

  describe('callbacks', () => {
    it('clears the status callback only when identities match', () => {
      const installed = vi.fn();
      const replacement = vi.fn();

      reg.setStatusChangeCallback(installed);
      reg.clearStatusChangeCallback(replacement);
      add('a');
      expect(installed).toHaveBeenCalledOnce();

      reg.setStatusChangeCallback(replacement);
      reg.clearStatusChangeCallback(installed);
      add('b');
      expect(replacement).toHaveBeenCalledOnce();

      reg.clearStatusChangeCallback(replacement);
      add('c');
      expect(replacement).toHaveBeenCalledOnce();
    });

    it('fires register callback synchronously when an entry is added', () => {
      const seen: string[] = [];
      reg.setRegisterCallback((entry) => seen.push(entry.shellId));
      add('a', 'b');
      expect(seen).toEqual(['a', 'b']);
    });

    it('fires statusChange callback on register too (mirrors BackgroundTaskRegistry)', () => {
      const seen: string[] = [];
      reg.setStatusChangeCallback((entry) => {
        if (entry) seen.push(entry.shellId);
      });
      add('a', 'b');
      expect(seen).toEqual(['a', 'b']);
    });

    it('fires statusChange callback on complete / fail / cancel', () => {
      add('a', 'b', 'c');
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
      const transitions: string[] = [];
      reg.setStatusChangeCallback((entry) => {
        if (entry) transitions.push(entry.shellId);
      });
      add('a');
      reg.complete('a', 0, 1000);
      transitions.length = 0;

      reg.complete('a', 0, 2000); // already terminal
      reg.fail('a', 'late', 2000); // already terminal
      reg.cancel('a', 2000); // already terminal
      reg.requestCancel('a'); // already terminal — also no fire

      expect(transitions).toEqual([]);
    });

    it('keeps the registry usable when a callback throws', () => {
      reg.setRegisterCallback(() => {
        throw new Error('subscriber blew up');
      });

      expect(() => add('a')).not.toThrow();
      expect(reg.get('a')!.status).toBe('running');
    });

    it('clears subscriber when set to undefined', () => {
      const seen: string[] = [];
      reg.setRegisterCallback((e) => seen.push(e.shellId));
      add('a');
      reg.setRegisterCallback(undefined);
      add('b');
      expect(seen).toEqual(['a']);
    });

    it('setNotificationCallback(undefined) clears the callback', () => {
      // useLlmStream's cleanup relies on this contract to avoid leaked
      // callbacks firing into torn-down React state on unmount; without this
      // guard a broken clearing path would fire stale callbacks silently.
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      add('a');
      reg.setNotificationCallback(undefined);
      reg.complete('a', 0, 2000);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('notifications', () => {
    // Binds a notification callback, registers one shell and settles it
    // (default: exit 0 at t=2000); returns the callback and its first call.
    function notify(
      overrides: Partial<ShellTaskRegistration> & { shellId: string },
      settle = (r: BackgroundShellRegistry, id: string) =>
        r.complete(id, 0, 2000),
      registry = reg,
    ) {
      const callback = vi.fn();
      registry.setNotificationCallback(callback);
      registry.register(makeEntry(overrides));
      settle(registry, overrides.shellId);
      const [displayText, modelText, meta] = callback.mock.calls[0] ?? [];
      return { callback, displayText, modelText, meta };
    }

    it('emits one task-notification when a shell completes', () => {
      const outputPath = makeOutputFile('first line\nfinal result\n');
      const { callback, displayText, modelText, meta } = notify({
        shellId: 'a',
        command: 'npm test',
        cwd: '/repo',
        outputPath,
        pid: 1234,
      });

      expect(callback).toHaveBeenCalledTimes(1);
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
      expect(modelText).toContain(expectedOutputFileElement(outputPath));
      expect(meta).toEqual({
        shellId: 'a',
        status: 'completed',
        exitCode: 0,
      });
    });

    it('carries the registering turn on the completion notification', () => {
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      promptIdContext.run('turn-42', () =>
        reg.register(makeEntry({ shellId: 'a' })),
      );
      reg.complete('a', 0, 2000);

      expect(callback).toHaveBeenCalledTimes(1);
      // The consumer gate (Session.#takeCurrentTurnBackgroundParts) drops any
      // queued item whose sourceTurnId is not the current turn, so a shell
      // that finishes mid-turn is only delivered mid-turn if the producer
      // stamps the registering turn here.
      expect(callback.mock.calls[0]![2].sourceTurnId).toBe('turn-42');
    });

    it('leaves the turn unattributed when registration has no turn context', () => {
      // Adjacent behaviour this fix must not break: with no turn context the
      // producer neither invents an attribution nor drops the result. The
      // item stays unattributed and the end-of-turn drain — which does not
      // filter on sourceTurnId — delivers it.
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      reg.register(makeEntry({ shellId: 'b' }));
      reg.complete('b', 0, 2000);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]![2].sourceTurnId).toBeUndefined();
    });

    it('truncates long commands for display, summary, and model XML', () => {
      const command = `node -e ${'a'.repeat(700)}`;
      const displayCommand = command.slice(0, 77) + '...';
      const modelCommand = command.slice(0, 497) + '...';
      const { displayText, modelText } = notify({ shellId: 'a', command });

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

    it('strips BIDI OVERRIDES from the OUTPUT TAIL — the biggest field', () => {
      // The sibling test below asserts modelText-wide absence, but its shell
      // has no output file, so <output-tail> renders the canned unreadable
      // form and is never exercised. The tail is the LARGEST
      // attacker-controllable field (up to 8 KiB of the shell's own output)
      // and renders through a different helper that stripped C0/C1 but
      // passed bidi overrides verbatim (probe-verified). Newlines must
      // survive the fix. The fixture holds ALL NINE codepoints of both
      // ranges: one per range let a bound typo (0x202a→0x202b,
      // 0x2066→0x2067) ship green (probe-verified).
      const outputPath = makeOutputFile(
        'line one\nharmless‪‫‬‭‮evil⁦⁧⁨⁩ two\n',
      );
      const { modelText } = notify({ shellId: 'tail-bidi', outputPath });

      expect(modelText).toContain('<output-tail');
      const bidi = '‪‫‬‭‮⁦⁧⁨⁩';
      for (const ch of bidi) {
        expect(modelText).not.toContain(ch);
      }
      // The tail keeps its line structure AND the text after the stripped
      // characters survives — the strip must not eat \n or truncate at
      // the first bidi marker.
      expect(modelText).toContain('line one\nharmlessevil two</output-tail>');
    });

    it('strips BIDI OVERRIDES from the notification, not just C0/C1', () => {
      // The shared helper this renders through strips U+202A-202E and
      // U+2066-2069 as well as C0/C1 (the registry's former copy did not).
      // They reorder how a path DISPLAYS without changing its bytes, so
      // `/tmp/a<RLO>evil<PDI>/out.log` can render as something else entirely
      // in a model-facing envelope; this pins the stronger shared behaviour.
      const outputPath = join(makeTempDir(), 'a‮evil⁩.log');
      const { modelText } = notify({
        shellId: 'bidi',
        // command and cwd render through the same shared helper — pin
        // them too, so a field-local bidi-blind sanitizer fails here.
        command: 'cat ‮fd⁩.txt',
        cwd: '/repo/‮fd⁩',
        outputPath,
      });

      expect(modelText).toContain(expectedOutputFileElement(outputPath));
      expect(modelText).not.toContain('‮');
      expect(modelText).not.toContain('⁩');
    });

    it('escapes XML and strips display control characters on failure', () => {
      const outputPath = join(makeTempDir(), 'out&err.log');
      const { displayText, modelText } = notify(
        {
          shellId: 'a&b',
          command: 'echo "<script>"',
          cwd: '/repo&work',
          outputPath,
        },
        (r, id) => r.fail(id, 'bad <thing>\x1B[31m ‮evil⁩', 2000),
      );

      expect(displayText).toBe('Background shell "echo "<script>"" failed.');
      expect(modelText).toContain('<task-id>a&amp;b</task-id>');
      expect(modelText).toContain(
        '<command>echo &quot;&lt;script&gt;&quot;</command>',
      );
      expect(modelText).toContain('<cwd>/repo&amp;work</cwd>');
      expect(modelText).toContain(
        '<result>bad &lt;thing&gt;[31m evil</result>',
      );
      // The bidi pair in the fixture pins the fourth render site: <result>
      // is the failed shell's error string and renders only on this path.
      expect(modelText).not.toContain('‮');
      expect(modelText).not.toContain('⁩');
      // Assert the whole element, not just the tail: the temp prefix is
      // random but the escaping is what this test is about.
      expect(modelText).toContain(expectedOutputFileElement(outputPath));
    });

    it('limits output-tail to the retained byte budget', () => {
      const outputPath = makeOutputFile(
        'prefix-' +
          'a'.repeat(MAX_NOTIFICATION_OUTPUT_TAIL_BYTES) +
          '\nlast line\n',
      );
      const { modelText } = notify({ shellId: 'a', outputPath });

      expect(modelText).toContain('<output-tail truncated="true">');
      expect(modelText).toContain('last line</output-tail>');
      expect(modelText).not.toContain('prefix-');
    });

    it('skips leading UTF-8 continuation bytes at the truncation boundary', () => {
      // A byte budget that cuts a multi-byte codepoint in half would make the
      // raw read produce U+FFFD. The 3-byte '€' (U+20AC → 0xE2 0x82 0xAC) is
      // placed so the truncation offset lands on its second byte.
      const file = join(makeTempDir('qwen-shell-utf8-'), 'shell.output');
      const padding = 'a'.repeat(MAX_NOTIFICATION_OUTPUT_TAIL_BYTES - 1);
      // 1 byte of 'a' + 2 continuation bytes = 3 bytes before the clean text
      writeFileSync(file, padding + '€' + '\nfinal output\n');
      const { modelText } = notify({ shellId: 'a', outputPath: file });

      expect(modelText).toContain('<output-tail truncated="true">');
      expect(modelText).toContain('final output</output-tail>');
      // Must not contain the UTF-8 replacement character
      expect(modelText).not.toContain('�');
    });

    it('strips control and bidi characters from cwd and output-file XML fields', () => {
      const dir = makeTempDir();
      const { modelText } = notify({
        shellId: 'a',
        cwd: '/repo\x01\x02/work',
        outputPath: join(dir, 'out\x03‮.log'),
      });

      expect(modelText).toContain('<cwd>/repo/work</cwd>');
      // Whole element: pins exactly which characters are stripped and that
      // the rest of the path survives intact.
      expect(modelText).toContain(
        expectedOutputFileElement(join(dir, 'out.log')),
      );
      expect(modelText).not.toContain('\x01');
      expect(modelText).not.toContain('\x02');
      expect(modelText).not.toContain('\x03');
      expect(modelText).not.toContain('‮');
    });

    // An output path that is a symlink to a secret file.
    function symlinkedOutput(): string {
      const dir = makeTempDir();
      const secretPath = join(dir, 'secret.txt');
      const outputPath = join(dir, 'shell.output');
      writeFileSync(secretPath, 'secret credentials');
      symlinkSync(secretPath, outputPath);
      return outputPath;
    }

    const itNoFollow = fsConstants.O_NOFOLLOW === undefined ? it.skip : it;

    itNoFollow('does not follow symlinked output files', () => {
      const { modelText } = notify({
        shellId: 'a',
        outputPath: symlinkedOutput(),
      });

      expect(modelText).not.toContain('secret credentials');
      expect(modelText).toContain('<output-tail error="unreadable"');
    });

    const itNoSymlink = process.platform === 'win32' ? it.skip : it;

    itNoSymlink(
      'does not follow symlinked output files when O_NOFOLLOW is unavailable (Windows flag set)',
      async () => {
        // Cross-product the test above misses: Windows has no O_NOFOLLOW
        // (the constant is `undefined` and `| (O_NOFOLLOW ?? 0)` collapses
        // to a plain open), so stub the constant away and pin that the
        // compensating check still refuses to read through the link (#8227).
        const outputPath = symlinkedOutput();

        vi.resetModules();
        vi.doMock('node:fs', async (importOriginal) => {
          const actual = await importOriginal<typeof import('node:fs')>();
          const modified = {
            ...actual,
            constants: { ...actual.constants, O_NOFOLLOW: undefined },
          };
          return { ...modified, default: modified };
        });

        try {
          const { BackgroundShellRegistry: RegistryWithoutNoFollow } =
            await import('./backgroundShellRegistry.js');
          const { modelText } = notify(
            { shellId: 'a', outputPath },
            undefined,
            new RegistryWithoutNoFollow(),
          );

          expect(modelText).not.toContain('secret credentials');
          expect(modelText).toContain('<output-tail error="unreadable"');
        } finally {
          vi.doUnmock('node:fs');
          vi.resetModules();
        }
      },
    );

    it('skips output-tail when the output file does not exist', () => {
      // Guards the catch branch in `readOutputTail`. If the try/catch
      // ever regresses to throwing, `complete()` would propagate the
      // error and the entry would never reach a terminal status.
      const { callback, modelText } = notify(
        { shellId: 'a', outputPath: join(makeTempDir(), 'no-such-file.log') },
        (r, id) => expect(() => r.complete(id, 0, 2000)).not.toThrow(),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      expect(modelText).toContain('<output-tail error="unreadable"');
      expect(reg.get('a')!.status).toBe('completed');
    });

    it('skips output-tail when outputPath is a directory (not a regular file)', () => {
      // Guards the `!stat.isFile()` early-return in `readOutputTail`.
      const dir = makeTempDir();
      // A dir outputPath gets its `<dir>.status` sidecar as a sibling of
      // the temp dir, which the dir cleanup above never removes; tracking
      // it here lets afterEach delete it even if the assertions fail.
      tmpFiles.push(statusFilePathFor(dir));
      const { callback, modelText } = notify({ shellId: 'a', outputPath: dir });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(modelText).not.toContain('<output-tail');
    });

    it('skips output-tail when the output file is empty (stat.size === 0)', () => {
      // Guards the `stat.size <= 0` early-return in `readOutputTail`.
      const { callback, modelText } = notify({
        shellId: 'a',
        outputPath: makeOutputFile(''),
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(modelText).not.toContain('<output-tail');
    });

    it('keeps the registry usable when the notification callback throws', () => {
      reg.setNotificationCallback(() => {
        throw new Error('subscriber blew up');
      });
      add('a', 'b');

      expect(() => reg.complete('a', 0, 2000)).not.toThrow();
      expect(() => reg.fail('b', 'boom', 3000)).not.toThrow();
      expect(reg.get('a')!.status).toBe('completed');
      expect(reg.get('b')!.status).toBe('failed');

      // Consume-before-invoke: a throwing subscriber must not leave the entry
      // eligible, or the next bind replays the same terminal notification.
      expect(reg.get('a')!.notified).toBe(true);
      expect(reg.get('b')!.notified).toBe(true);

      const rebound = vi.fn();
      reg.setNotificationCallback(rebound);
      expect(rebound).not.toHaveBeenCalled();
    });

    it('does not emit more than once for late terminal transitions', () => {
      const { callback } = notify({ shellId: 'a' }, (r, id) => {
        r.complete(id, 0, 2000);
        r.fail(id, 'late failure', 3000);
        r.cancel(id, 4000);
      });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('waits until cancel() to notify after requestCancel()', () => {
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      add('a');

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
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      add('a', 'b');

      reg.abortAll();

      expect(callback).not.toHaveBeenCalled();
      expect(reg.get('a')!.notified).toBe(true);
      expect(reg.get('b')!.notified).toBe(true);
    });

    it('redelivers a retained terminal notification when the same registry is rebound', () => {
      const outputPath = makeOutputFile('done\n');
      reg.register(
        makeEntry({ shellId: 'a', command: 'npm test', outputPath }),
      );

      reg.complete('a', 0, 2000);
      expect(reg.get('a')!.notified).toBe(false);

      const callback = vi.fn();
      reg.setNotificationCallback(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      const [displayText, modelText, meta] = callback.mock.calls[0];
      expect(displayText).toBe('Background shell "npm test" completed.');
      expect(modelText).toContain('<task-id>a</task-id>');
      expect(modelText).toContain('<status>completed</status>');
      expect(meta).toEqual({
        shellId: 'a',
        status: 'completed',
        exitCode: 0,
      });
      expect(reg.get('a')!.notified).toBe(true);
    });

    it('redelivers retained terminal states in settle order once and suppresses shutdown cancellations', () => {
      add('a', 'b', 'c', 'shutdown');
      reg.cancel('c', 2000);
      reg.fail('b', 'boom', 2001);
      reg.complete('a', 0, 2002);
      reg.abortAll();

      const callback = vi.fn();
      reg.setNotificationCallback(callback);

      expect(callback.mock.calls.map((call) => call[2])).toEqual([
        { shellId: 'c', status: 'cancelled' },
        { shellId: 'b', status: 'failed' },
        { shellId: 'a', status: 'completed', exitCode: 0 },
      ]);
      expect(reg.get('shutdown')!.notified).toBe(true);

      const callback2 = vi.fn();
      reg.setNotificationCallback(callback2);
      expect(callback2).not.toHaveBeenCalled();
    });

    it('does not replay a still-running shell and still delivers its real terminal notification', () => {
      add('running', 'done');
      reg.complete('done', 0, 2000);

      const callback = vi.fn();
      reg.setNotificationCallback(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][2]).toMatchObject({ shellId: 'done' });
      expect(reg.get('running')!.notified).toBe(false);

      reg.complete('running', 0, 3000);
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback.mock.calls[1][2]).toMatchObject({
        shellId: 'running',
        status: 'completed',
      });
    });
  });

  const addWithController = (shellId: string) => {
    const ac = new AbortController();
    reg.register(makeEntry({ shellId, abortController: ac }));
    return ac;
  };

  describe('requestCancel', () => {
    it('aborts the signal but leaves status running and endTime undefined', () => {
      const ac = addWithController('a');

      reg.requestCancel('a');

      const e = reg.get('a')!;
      expect(e.status).toBe('running');
      expect(e.endTime).toBeUndefined();
      expect(ac.signal.aborted).toBe(true);
      expect(reg.hasRunningEntries()).toBe(true);

      reg.cancel('a', 2000);

      expect(reg.hasRunningEntries()).toBe(false);
    });

    it('is a no-op on a terminal entry', () => {
      const ac = addWithController('a');
      reg.complete('a', 0, 1500);

      reg.requestCancel('a');

      expect(reg.get('a')!.status).toBe('completed');
      expect(ac.signal.aborted).toBe(false);
    });

    it('is a no-op for unknown id', () => {
      expect(() => reg.requestCancel('missing')).not.toThrow();
    });
  });

  describe('abortAll', () => {
    it('cancels every running entry and leaves terminal entries alone', () => {
      const acRunning1 = addWithController('a');
      const acRunning2 = addWithController('b');
      const acDone = addWithController('c');
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
      expect(() => reg.abortAll()).not.toThrow();
    });

    it('fires statusChange exactly once regardless of how many entries cancel', () => {
      // The single subscriber (`useBackgroundTaskView`) re-pulls `getAll()`
      // from inside the callback, so per-entry fires here only cause a
      // flurry of redundant React re-renders on shutdown / `/clear`. Pin the
      // batch behavior so a refactor that loops `cancel()` again doesn't
      // silently re-introduce the wakeup churn.
      const transitions: Array<{ id: string; status: string }> = [];
      add('s-0', 's-1', 's-2', 's-3', 's-4');
      reg.setStatusChangeCallback((entry) => {
        if (entry) {
          transitions.push({ id: entry.shellId, status: entry.status });
        }
      });

      reg.abortAll();

      // All five entries end up cancelled, but the callback fires only once.
      for (let i = 0; i < 5; i++) {
        expect(reg.get(`s-${i}`)!.status).toBe('cancelled');
      }
      expect(transitions).toHaveLength(1);
      expect(transitions[0].status).toBe('cancelled');
    });

    it('does not fire statusChange when no entry was cancelled', () => {
      // Empty / all-already-terminal registries shouldn't wake the
      // subscriber for a no-op transition.
      add('a');
      reg.complete('a', 0, 1500);
      const cb = vi.fn();
      reg.setStatusChangeCallback(cb);

      reg.abortAll();

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('session switch helpers', () => {
    it('reports whether any shell is still running', () => {
      add('a');
      expect(reg.hasRunningEntries()).toBe(true);
      reg.complete('a', 0, 1234);
      expect(reg.hasRunningEntries()).toBe(false);
    });

    it('reset clears all tracked entries', () => {
      add('a', 'b');

      reg.reset();

      expect(reg.getAll()).toEqual([]);
    });
  });

  describe('terminal-entry retention cap', () => {
    // Registers and completes `count` entries `<prefix>0..`, with strictly
    // increasing endTimes so eviction order is deterministic.
    const completeMany = (count: number, prefix: string, base = 0) => {
      for (let i = 0; i < count; i++) {
        const startTime = base + i * 10;
        reg.register(makeEntry({ shellId: `${prefix}${i}`, startTime }));
        reg.complete(`${prefix}${i}`, 0, startTime + 5);
      }
    };
    // Fills the cap with completed entries, then settles one more.
    const overflowWith = (settle: (id: string, endTime: number) => void) => {
      completeMany(MAX_RETAINED_TERMINAL_SHELLS, 'done-');
      const overflowStart = MAX_RETAINED_TERMINAL_SHELLS * 10 + 100;
      reg.register(
        makeEntry({ shellId: 'overflow', startTime: overflowStart }),
      );
      settle('overflow', overflowStart + 5);
      expect(reg.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_SHELLS);
      expect(reg.get('done-0')).toBeUndefined();
    };

    it('retains only a bounded number of terminal entries (oldest by endTime evicted)', () => {
      // One more entry than the cap allows.
      completeMany(MAX_RETAINED_TERMINAL_SHELLS + 2, 's-');
      expect(reg.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_SHELLS);
      // The two oldest (`s-0`, `s-1`) get pruned; the newest survives.
      expect(reg.get('s-0')).toBeUndefined();
      expect(reg.get('s-1')).toBeUndefined();
      expect(reg.get(`s-${MAX_RETAINED_TERMINAL_SHELLS + 1}`)).toBeDefined();
    });

    it('never evicts running entries even when the cap is exceeded', () => {
      // One extra terminal entry beyond the cap, after a single running
      // entry. The running entry must be retained regardless of its launch
      // order — pruning a still-running shell would lose the user's only
      // handle on a live process.
      reg.register(makeEntry({ shellId: 'live', startTime: 1 }));
      completeMany(MAX_RETAINED_TERMINAL_SHELLS + 1, 'done-', 100);
      // Cap-of-32 terminals + 1 running survivor = 33 entries kept.
      expect(reg.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_SHELLS + 1);
      expect(reg.get('live')?.status).toBe('running');
      // The oldest terminal entry (lowest endTime) is the one evicted.
      expect(reg.get('done-0')).toBeUndefined();
    });

    it('prunes after fail() too, not just complete()', () => {
      overflowWith((id, endTime) => reg.fail(id, 'boom', endTime));
      expect(reg.get('overflow')?.status).toBe('failed');
    });

    it('prunes after cancel() too, not just complete()', () => {
      overflowWith((id, endTime) => reg.cancel(id, endTime));
      expect(reg.get('overflow')?.status).toBe('cancelled');
    });
  });

  describe('cancel', () => {
    it('transitions running → cancelled and aborts the signal', () => {
      const ac = addWithController('a');
      reg.cancel('a', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('cancelled');
      expect(e.endTime).toBe(2000);
      expect(ac.signal.aborted).toBe(true);
    });

    it('is a no-op when entry is already terminal', () => {
      const ac = addWithController('a');
      reg.complete('a', 0, 1500);
      reg.cancel('a', 2000);
      const e = reg.get('a')!;
      expect(e.status).toBe('completed');
      expect(ac.signal.aborted).toBe(false);
    });

    it('is a no-op for unknown id', () => {
      expect(() => reg.cancel('missing', 0)).not.toThrow();
    });
  });

  describe('status sidecar file', () => {
    function makeDirEntry(
      overrides: Partial<ShellTaskRegistration> = {},
    ): ShellTaskRegistration & { statusPath: string } {
      const entry = makeEntry(overrides);
      return { ...entry, statusPath: statusFilePathFor(entry.outputPath) };
    }
    const addDir = (shellId: string) => {
      const e = makeDirEntry({ shellId });
      reg.register(e);
      return e;
    };

    function readStatus(statusPath: string): Record<string, unknown> {
      return JSON.parse(readFileSync(statusPath, 'utf8')) as Record<
        string,
        unknown
      >;
    }

    it('writes a running sidecar on register, with pid and ISO times', () => {
      const e = makeDirEntry({ shellId: 'a', pid: 4242, startTime: 1000 });
      reg.register(e);
      const status = readStatus(e.statusPath);
      expect(status['id']).toBe('a');
      expect(status['status']).toBe('running');
      expect(status['pid']).toBe(4242);
      expect(status['command']).toBe('sleep 60');
      expect(status['cwd']).toBe('/tmp');
      expect(status['startTime']).toBe(new Date(1000).toISOString());
      expect(typeof status['updatedAt']).toBe('string');
      expect(status['exitCode']).toBeUndefined();
    });

    it.each<[string, (r: BackgroundShellRegistry) => void, object]>([
      [
        'writes completed with exitCode and endTime on complete',
        (r) => r.complete('a', 0, 2000),
        {
          status: 'completed',
          exitCode: 0,
          endTime: new Date(2000).toISOString(),
        },
      ],
      [
        'writes failed with the error message on fail',
        (r) => r.fail('a', 'exited with code 3', 2000),
        { status: 'failed', error: 'exited with code 3' },
      ],
      [
        'writes cancelled on cancel',
        (r) => r.cancel('a', 2000),
        { status: 'cancelled' },
      ],
    ])('%s', (_title, settle, expected) => {
      const e = addDir('a');
      settle(reg);
      const status = readStatus(e.statusPath);
      for (const [key, value] of Object.entries(expected)) {
        expect(status[key]).toBe(value);
      }
    });

    it('writes cancelled for every running entry on abortAll', () => {
      const a = addDir('a');
      const b = addDir('b');
      const done = addDir('c');
      reg.complete('c', 0, 1500);
      reg.abortAll();
      expect(readStatus(a.statusPath)['status']).toBe('cancelled');
      expect(readStatus(b.statusPath)['status']).toBe('cancelled');
      expect(readStatus(done.statusPath)['status']).toBe('completed');
    });

    it('leaves no temp-file residue next to the sidecar', () => {
      const e = addDir('a');
      reg.complete('a', 0, 2000);
      const residue = readdirSync(dirname(e.statusPath)).filter(
        (name) => !/^shell-a\.(output|status)$/.test(name),
      );
      expect(residue).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')(
      'forces 0o600 even when a looser sidecar pre-exists (forceMode)',
      () => {
        const e = makeDirEntry({ shellId: 'a' });
        writeFileSync(e.statusPath, '{}');
        chmodSync(e.statusPath, 0o644); // legacy bad perms
        reg.register(e);
        expect(statSync(e.statusPath).mode & 0o777).toBe(0o600);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'replaces a pre-placed symlink instead of writing through it (noFollow)',
      () => {
        const e = makeDirEntry({ shellId: 'a' });
        const secretPath = join(dirname(e.statusPath), 'secret.txt');
        writeFileSync(secretPath, 'secret credentials');
        symlinkSync(secretPath, e.statusPath);
        reg.register(e);
        // The symlink target is untouched; the sidecar replaced the link.
        expect(readFileSync(secretPath, 'utf8')).toBe('secret credentials');
        expect(lstatSync(e.statusPath).isSymbolicLink()).toBe(false);
        expect(readStatus(e.statusPath)['status']).toBe('running');
      },
    );

    it('swallows sidecar write failures without throwing', () => {
      const e = makeEntry({
        shellId: 'a',
        outputPath: join(makeTempDir(), 'no-such-dir', 'shell-a.output'),
      });
      expect(() => reg.register(e)).not.toThrow();
      expect(() => reg.complete('a', 0, 2000)).not.toThrow();
    });
  });
});

describe('settleOrphanedShellStatusFiles', () => {
  let dir: string;
  const scope = {
    hostname: 'host-a',
    bootId: 'boot-a',
    pidNamespace: 4026531836,
  };
  const running = {
    id: 'bg_1',
    status: 'running',
    command: 'sleep 6',
    cwd: '/work',
    startTime: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    pid: 4242,
    pidScope: scope,
  };
  const dead = { isAlive: () => false, scope };
  const write = (name: string, payload: unknown) =>
    writeFileSync(
      join(dir, name),
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
  const read = (name: string) =>
    JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<
      string,
      unknown
    >;
  const cannotDenyWrites =
    process.platform === 'win32' || process.getuid?.() === 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-shell-status-'));
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it('settles a running sidecar whose process is gone and keeps its fields', () => {
    write('shell-bg_1.status', running);
    expect(settleOrphanedShellStatusFiles(dir, dead)).toEqual({
      settled: 1,
      unsettled: [],
    });
    const { updatedAt, ...kept } = running;
    const settled = read('shell-bg_1.status');
    expect(settled).toMatchObject({ ...kept, status: 'unknown' });
    expect(settled['updatedAt']).not.toBe(updatedAt);
  });

  it('keeps a running sidecar whose process is alive and reports it', () => {
    write('shell-bg_1.status', running);
    expect(
      settleOrphanedShellStatusFiles(dir, { isAlive: () => true, scope }),
    ).toEqual({
      settled: 0,
      unsettled: [{ statusPath: join(dir, 'shell-bg_1.status'), pid: 4242 }],
    });
    expect(read('shell-bg_1.status')).toEqual(running);
  });

  it('leaves a sidecar written in another pid scope, or without one, running', () => {
    const { pidScope: _pidScope, ...withoutScope } = running;
    write('shell-ns.status', {
      ...running,
      pidScope: { ...scope, pidNamespace: 4026532512 },
    });
    write('shell-boot.status', {
      ...running,
      pidScope: { ...scope, bootId: 'boot-b' },
    });
    write('shell-host.status', {
      ...running,
      pidScope: { ...scope, hostname: 'host-b' },
    });
    write('shell-legacy.status', withoutScope);
    expect(settleOrphanedShellStatusFiles(dir, dead)).toEqual({
      settled: 0,
      unsettled: [],
    });
    for (const name of [
      'shell-ns.status',
      'shell-boot.status',
      'shell-host.status',
      'shell-legacy.status',
    ]) {
      expect(read(name)['status']).toBe('running');
    }
  });

  it.each([
    { ...scope, bootId: null },
    { ...scope, pidNamespace: null },
    { ...scope, bootId: null, pidNamespace: null },
  ])(
    'does not infer a shared pid scope from missing identities: %j',
    (unknownScope) => {
      const sidecar = { ...running, pidScope: unknownScope };
      write('shell-bg_1.status', sidecar);
      const isAlive = vi.fn(() => false);
      expect(
        settleOrphanedShellStatusFiles(dir, { isAlive, scope: unknownScope }),
      ).toEqual({ settled: 0, unsettled: [] });
      expect(isAlive).not.toHaveBeenCalled();
      expect(read('shell-bg_1.status')).toEqual(sidecar);
    },
  );

  it('bounds actual reads when a sidecar grows after its size check', () => {
    const statusPath = join(dir, 'shell-bg_1.status');
    write('shell-bg_1.status', running);
    const originalFstat = fs.fstatSync;
    const originalRead = fs.readSync;
    let grew = false;
    let bytesRead = 0;
    const statSpy = vi.spyOn(fs, 'fstatSync').mockImplementation(((
      ...args: Parameters<typeof fs.fstatSync>
    ) => {
      const stats = originalFstat(...args);
      if (!grew && typeof stats.size === 'number') {
        grew = true;
        appendFileSync(statusPath, ' '.repeat(2 * 1024 * 1024));
      }
      return stats;
    }) as typeof fs.fstatSync);
    const readSpy = vi.spyOn(fs, 'readSync').mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      const count = originalRead(...args);
      bytesRead += count;
      return count;
    }) as typeof fs.readSync);
    syncBuiltinESMExports();
    try {
      expect(settleOrphanedShellStatusFiles(dir, dead)).toEqual({
        settled: 0,
        unsettled: [],
      });
      expect(bytesRead).toBe(1024 * 1024 + 1);
      expect(grew).toBe(true);
      expect(read('shell-bg_1.status')['status']).toBe('running');
    } finally {
      statSpy.mockRestore();
      readSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each([1024 * 1024, 1024 * 1024 + 1])(
    'handles a sidecar of exactly %i bytes',
    (size) => {
      const json = JSON.stringify(running);
      write(
        'shell-bg_1.status',
        json + ' '.repeat(size - Buffer.byteLength(json)),
      );
      const withinLimit = size === 1024 * 1024;
      expect(settleOrphanedShellStatusFiles(dir, dead).settled).toBe(
        withinLimit ? 1 : 0,
      );
      expect(read('shell-bg_1.status')['status']).toBe(
        withinLimit ? 'unknown' : 'running',
      );
    },
  );

  it('continues short reads through multibyte text to EOF', () => {
    const command = 'echo 你好';
    write('shell-bg_1.status', { ...running, command });
    const originalRead = fs.readSync;
    const readSpy = vi
      .spyOn(fs, 'readSync')
      .mockImplementation(((
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | bigint | null,
      ) =>
        originalRead(
          fd,
          buffer,
          offset,
          Math.min(length, 1),
          position,
        )) as typeof fs.readSync);
    syncBuiltinESMExports();
    try {
      expect(settleOrphanedShellStatusFiles(dir, dead).settled).toBe(1);
      expect(read('shell-bg_1.status')).toMatchObject({
        status: 'unknown',
        command,
      });
      expect(readSpy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('leaves settled, pid-less, invalid-pid, malformed and non-status files alone', () => {
    const { pid: _pid, ...withoutPid } = running;
    write('shell-done.status', { ...running, status: 'completed' });
    write('shell-nopid.status', withoutPid);
    const invalidPids = [0, -5, 1.5, 2 ** 53, '4242'];
    invalidPids.forEach((pid, i) =>
      write(`shell-pid${i}.status`, { ...running, pid }),
    );
    write('shell-bad.status', '{not json');
    write('shell-bg_1.output', running);
    expect(settleOrphanedShellStatusFiles(dir, dead)).toEqual({
      settled: 0,
      unsettled: [],
    });
    expect(read('shell-done.status')['status']).toBe('completed');
    expect(read('shell-nopid.status')['status']).toBe('running');
    invalidPids.forEach((_pid, i) =>
      expect(read(`shell-pid${i}.status`)['status']).toBe('running'),
    );
    expect(read('shell-bg_1.output')['status']).toBe('running');
  });

  it.skipIf(process.platform === 'win32')(
    'skips a FIFO and an oversized file without waiting on either',
    () => {
      const fifo = join(dir, 'shell-fifo.status');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      write('shell-big.status', { ...running, command: 'x'.repeat(1 << 20) });
      expect(settleOrphanedShellStatusFiles(dir, dead)).toEqual({
        settled: 0,
        unsettled: [],
      });
      expect(lstatSync(fifo).isFIFO()).toBe(true);
      expect(read('shell-big.status')['status']).toBe('running');
    },
  );

  it('keeps checking the other sidecars when one of them throws', () => {
    write('shell-a.status', { ...running, pid: 1 });
    write('shell-b.status', { ...running, id: 'bg_2', pid: 4343 });
    const isAlive = (pid: number) => {
      if (pid === 1) throw new Error('liveness check failed');
      return false;
    };
    expect(settleOrphanedShellStatusFiles(dir, { isAlive, scope })).toEqual({
      settled: 1,
      unsettled: [],
    });
    expect(read('shell-a.status')['status']).toBe('running');
    expect(read('shell-b.status')['status']).toBe('unknown');
  });

  it('returns nothing for a session without a sidecar directory', () => {
    expect(settleOrphanedShellStatusFiles(join(dir, 'missing'))).toEqual({
      settled: 0,
      unsettled: [],
    });
  });

  it('detects an exited process with the default liveness probe', () => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    write('shell-bg_1.status', { ...running, pid });
    expect(settleOrphanedShellStatusFiles(dir, { scope }).settled).toBe(1);
    expect(read('shell-bg_1.status')['status']).toBe('unknown');
  });

  it('settles a registry-written sidecar only when native scope identities are available', () => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    new BackgroundShellRegistry().register(
      makeEntry({
        shellId: 'bg_1',
        pid,
        outputPath: join(dir, 'shell-bg_1.output'),
      }),
    );
    const pidScope = read('shell-bg_1.status')['pidScope'] as ShellPidScope;
    expect(pidScope).toMatchObject({
      hostname: hostname(),
    });
    const canProveScope =
      pidScope.bootId !== null && pidScope.pidNamespace !== null;
    expect(settleOrphanedShellStatusFiles(dir)).toEqual({
      settled: canProveScope ? 1 : 0,
      unsettled: [],
    });
    expect(read('shell-bg_1.status')['status']).toBe(
      canProveScope ? 'unknown' : 'running',
    );
  });

  it('settles a watched sidecar once its process exits, until stopped', () => {
    vi.useFakeTimers();
    try {
      write('shell-a.status', running);
      write('shell-b.status', { ...running, id: 'bg_2', pid: 4343 });
      let processesAlive = true;
      const isAlive = () => processesAlive;
      const { unsettled } = settleOrphanedShellStatusFiles(dir, {
        isAlive,
        scope,
      });
      const watching = watchOrphanedShellStatusFiles(
        unsettled.filter((orphan) => orphan.pid === 4242),
        { intervalMs: 100, isAlive, scope },
      );
      const stopped = watchOrphanedShellStatusFiles(
        unsettled.filter((orphan) => orphan.pid === 4343),
        { intervalMs: 100, isAlive, scope },
      );
      vi.advanceTimersByTime(100);
      expect(read('shell-a.status')['status']).toBe('running');
      stopped();
      processesAlive = false;
      vi.advanceTimersByTime(100);
      expect(read('shell-a.status')['status']).toBe('unknown');
      expect(read('shell-b.status')['status']).toBe('running');
      watching();
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(cannotDenyWrites)(
    'retries a rewrite that failed until it lands, while a sibling settles',
    () => {
      vi.useFakeTimers();
      const sibling = mkdtempSync(join(tmpdir(), 'qwen-shell-status-'));
      try {
        write('shell-bg_1.status', running);
        writeFileSync(
          join(sibling, 'shell-bg_2.status'),
          JSON.stringify({ ...running, id: 'bg_2', pid: 4343 }),
        );
        chmodSync(dir, 0o500);
        const { settled, unsettled } = settleOrphanedShellStatusFiles(
          dir,
          dead,
        );
        expect({ settled, unsettled }).toEqual({
          settled: 0,
          unsettled: [
            { statusPath: join(dir, 'shell-bg_1.status'), pid: 4242 },
          ],
        });
        const stop = watchOrphanedShellStatusFiles(
          [
            ...unsettled,
            { statusPath: join(sibling, 'shell-bg_2.status'), pid: 4343 },
          ],
          { intervalMs: 100, ...dead },
        );
        try {
          vi.advanceTimersByTime(100);
          expect(read('shell-bg_1.status')['status']).toBe('running');
          expect(
            JSON.parse(
              readFileSync(join(sibling, 'shell-bg_2.status'), 'utf8'),
            )['status'],
          ).toBe('unknown');
          chmodSync(dir, 0o700);
          vi.advanceTimersByTime(100);
          expect(read('shell-bg_1.status')['status']).toBe('unknown');
        } finally {
          stop();
        }
      } finally {
        vi.useRealTimers();
        rmSync(sibling, { recursive: true, force: true });
      }
    },
  );

  it('does not keep the process alive while it watches', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const stop = watchOrphanedShellStatusFiles(
        [{ statusPath: join(dir, 'shell-bg_1.status'), pid: 4242 }],
        { isAlive: () => true, scope },
      );
      const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      stop();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('settles an orphan alive at takeover after it exits, with no second takeover', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)']);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    write('shell-bg_1.status', { ...running, pid: child.pid });
    const { settled, unsettled } = settleOrphanedShellStatusFiles(dir, {
      scope,
    });
    expect({ settled, watched: unsettled.length }).toEqual({
      settled: 0,
      watched: 1,
    });
    const stop = watchOrphanedShellStatusFiles(unsettled, {
      intervalMs: 20,
      scope,
    });
    try {
      await exited;
      await vi.waitFor(
        () => expect(read('shell-bg_1.status')['status']).toBe('unknown'),
        { timeout: 2000, interval: 20 },
      );
    } finally {
      stop();
    }
  });
});

describe('statusFilePathFor', () => {
  it('derives the sidecar path from the output path', () => {
    expect(statusFilePathFor('/a/b/shell-x.output')).toBe(
      '/a/b/shell-x.status',
    );
  });

  it('appends .status when the path has no .output suffix', () => {
    expect(statusFilePathFor('/a/b/custom.log')).toBe('/a/b/custom.log.status');
  });
});
