/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackgroundShellRegistry,
  MAX_NOTIFICATION_OUTPUT_TAIL_BYTES,
  MAX_RETAINED_TERMINAL_SHELLS,
  statusFilePathFor,
  type ShellTaskRegistration,
} from './backgroundShellRegistry.js';
import { todoWorkChainContext } from '../utils/promptIdContext.js';
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
    // `<outputPath>.status` sidecar, so the default outputPath decides where
    // that write lands. A fixed `/tmp/s1.output` pointed every entry in this
    // file — across tests, across workers, across CI jobs — at the single
    // path `/tmp/s1.status`. `/tmp` is sticky, so once that file belongs to
    // another uid the atomic rename fails EPERM, and `renameWithRetrySync`
    // burns its full 50+100+200ms backoff before the registry swallows the
    // error. Give each entry its own directory instead: no shared state, and
    // the sidecar write actually succeeds.
    outputPath:
      overrides.outputPath ?? join(makeTempDir(), `shell-${shellId}.output`),
  };
}

describe('BackgroundShellRegistry', () => {
  it('gives each entry a unique default outputPath', () => {
    expect(makeEntry().outputPath).not.toBe(makeEntry().outputPath);
  });

  describe('register / get / getAll', () => {
    it('captures the Todo work-chain owner at registration', () => {
      const reg = new BackgroundShellRegistry();
      const entry = todoWorkChainContext.run('work-chain-1', () =>
        reg.register(makeEntry()),
      );

      expect(entry.todoWorkChainId).toBe('work-chain-1');
    });

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
    it('clears the status callback only when identities match', () => {
      const reg = new BackgroundShellRegistry();
      const installed = vi.fn();
      const replacement = vi.fn();

      reg.setStatusChangeCallback(installed);
      reg.clearStatusChangeCallback(replacement);
      reg.register(makeEntry({ shellId: 'a' }));
      expect(installed).toHaveBeenCalledOnce();

      reg.setStatusChangeCallback(replacement);
      reg.clearStatusChangeCallback(installed);
      reg.register(makeEntry({ shellId: 'b' }));
      expect(replacement).toHaveBeenCalledOnce();

      reg.clearStatusChangeCallback(replacement);
      reg.register(makeEntry({ shellId: 'c' }));
      expect(replacement).toHaveBeenCalledOnce();
    });

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
      // useLlmStream's cleanup relies on this contract to avoid
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
      expect(modelText).toContain(expectedOutputFileElement(outputPath));
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

    it('strips BIDI OVERRIDES from the OUTPUT TAIL — the biggest field', () => {
      // The sibling test below asserts modelText-wide absence, which reads
      // as whole-envelope coverage but is not: its fixture shell has no
      // output file, so <output-tail> renders the canned unreadable form
      // and is never exercised. The tail is the LARGEST
      // attacker-controllable field — up to 8 KiB of a background shell's
      // own output — and it renders through a different helper, which
      // stripped C0/C1 but passed bidi overrides through verbatim
      // (probe-verified). Newlines must survive the fix.
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      // ALL NINE codepoints of both stripped ranges: pinning one per
      // range let a one-character bound typo (0x202a→0x202b,
      // 0x2066→0x2067) ship green (probe-verified).
      const outputPath = makeOutputFile(
        'line one\nharmless\u202A\u202B\u202C\u202D\u202Eevil\u2066\u2067\u2068\u2069 two\n',
      );
      reg.register(makeEntry({ shellId: 'tail-bidi', outputPath }));

      reg.complete('tail-bidi', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<output-tail');
      const bidi = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069';
      for (const ch of bidi) {
        expect(modelText).not.toContain(ch);
      }
      // The tail keeps its line structure AND the text after the stripped
      // characters survives — the strip must not eat \n or truncate at
      // the first bidi marker.
      expect(modelText).toContain('line one\nharmlessevil two</output-tail>');
    });

    it('strips BIDI OVERRIDES from the notification, not just C0/C1', () => {
      // The shared helper this renders through removes U+202A-202E and
      // U+2066-2069 as well as C0/C1 — the registry's own former copy did
      // not. Those characters reorder how a path DISPLAYS without changing
      // its bytes, so `/tmp/a<RLO>evil<PDI>/out.log` can render as
      // something else entirely in a model-facing envelope. This pins the
      // stronger behaviour that came with the shared helper.
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      const outputPath = join(makeTempDir(), 'a\u202Eevil\u2069.log');
      reg.register(
        makeEntry({
          shellId: 'bidi',
          // command and cwd render through the same shared helper — pin
          // them too, so a field-local bidi-blind sanitizer fails here.
          command: 'cat \u202Efd\u2069.txt',
          cwd: '/repo/\u202Efd\u2069',
          outputPath,
        }),
      );

      reg.complete('bidi', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain(expectedOutputFileElement(outputPath));
      expect(modelText).not.toContain('\u202E');
      expect(modelText).not.toContain('\u2069');
    });

    it('escapes XML and strips display control characters on failure', () => {
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      const outputPath = join(makeTempDir(), 'out&err.log');
      reg.register(
        makeEntry({
          shellId: 'a&b',
          command: 'echo "<script>"',
          cwd: '/repo&work',
          outputPath,
        }),
      );

      reg.fail('a&b', 'bad <thing>\x1B[31m \u202Eevil\u2069', 2000);

      const [displayText, modelText] = callback.mock.calls[0];
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
      expect(modelText).not.toContain('\u202E');
      expect(modelText).not.toContain('\u2069');
      // Assert the whole element, not just the tail: the temp prefix is
      // random but the escaping is what this test is about.
      expect(modelText).toContain(expectedOutputFileElement(outputPath));
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

    it('strips control and bidi characters from cwd and output-file XML fields', () => {
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      reg.setNotificationCallback(callback);
      const dir = makeTempDir();
      reg.register(
        makeEntry({
          shellId: 'a',
          cwd: '/repo\x01\x02/work',
          outputPath: join(dir, 'out\x03\u202e.log'),
        }),
      );

      reg.complete('a', 0, 2000);

      const [, modelText] = callback.mock.calls[0];
      expect(modelText).toContain('<cwd>/repo/work</cwd>');
      // Whole element: pins exactly which characters are stripped and that
      // the rest of the path survives intact.
      expect(modelText).toContain(
        expectedOutputFileElement(join(dir, 'out.log')),
      );
      expect(modelText).not.toContain('\x01');
      expect(modelText).not.toContain('\x02');
      expect(modelText).not.toContain('\x03');
      expect(modelText).not.toContain('\u202e');
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

    const itNoSymlink = process.platform === 'win32' ? it.skip : it;

    itNoSymlink(
      'does not follow symlinked output files when O_NOFOLLOW is unavailable (Windows flag set)',
      async () => {
        // Cross-product the test above misses: Windows has no O_NOFOLLOW
        // (the constant is `undefined` and `| (O_NOFOLLOW ?? 0)` collapses
        // to a plain open), so stub the constant away and pin that the
        // compensating check still refuses to read through the link (#8227).
        const dir = makeTempDir();
        const secretPath = join(dir, 'secret.txt');
        const outputPath = join(dir, 'shell.output');
        writeFileSync(secretPath, 'secret credentials');
        symlinkSync(secretPath, outputPath);

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
          const reg = new RegistryWithoutNoFollow();
          const callback = vi.fn();
          reg.setNotificationCallback(callback);
          reg.register(makeEntry({ shellId: 'a', outputPath }));

          reg.complete('a', 0, 2000);

          const [, modelText] = callback.mock.calls[0];
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
      const reg = new BackgroundShellRegistry();
      const callback = vi.fn();
      const dir = makeTempDir();
      reg.setNotificationCallback(callback);
      reg.register(
        makeEntry({
          shellId: 'a',
          outputPath: join(dir, 'no-such-file.log'),
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
      // A dir outputPath gets its `<dir>.status` sidecar as a sibling of
      // the temp dir, which the dir cleanup above never removes; tracking
      // it here lets afterEach delete it even if the assertions fail.
      tmpFiles.push(statusFilePathFor(dir));
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
      expect(reg.hasRunningEntries()).toBe(true);

      reg.cancel('a', 2000);

      expect(reg.hasRunningEntries()).toBe(false);
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

  describe('status sidecar file', () => {
    function makeDirEntry(
      overrides: Partial<ShellTaskRegistration> = {},
    ): ShellTaskRegistration & { statusPath: string } {
      const entry = makeEntry(overrides);
      return { ...entry, statusPath: statusFilePathFor(entry.outputPath) };
    }

    function readStatus(statusPath: string): Record<string, unknown> {
      return JSON.parse(readFileSync(statusPath, 'utf8')) as Record<
        string,
        unknown
      >;
    }

    it('writes a running sidecar on register, with pid and ISO times', () => {
      const reg = new BackgroundShellRegistry();
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

    it('writes completed with exitCode and endTime on complete', () => {
      const reg = new BackgroundShellRegistry();
      const e = makeDirEntry({ shellId: 'a' });
      reg.register(e);
      reg.complete('a', 0, 2000);
      const status = readStatus(e.statusPath);
      expect(status['status']).toBe('completed');
      expect(status['exitCode']).toBe(0);
      expect(status['endTime']).toBe(new Date(2000).toISOString());
    });

    it('writes failed with the error message on fail', () => {
      const reg = new BackgroundShellRegistry();
      const e = makeDirEntry({ shellId: 'a' });
      reg.register(e);
      reg.fail('a', 'exited with code 3', 2000);
      const status = readStatus(e.statusPath);
      expect(status['status']).toBe('failed');
      expect(status['error']).toBe('exited with code 3');
    });

    it('writes cancelled on cancel', () => {
      const reg = new BackgroundShellRegistry();
      const e = makeDirEntry({ shellId: 'a' });
      reg.register(e);
      reg.cancel('a', 2000);
      expect(readStatus(e.statusPath)['status']).toBe('cancelled');
    });

    it('writes cancelled for every running entry on abortAll', () => {
      const reg = new BackgroundShellRegistry();
      const a = makeDirEntry({ shellId: 'a' });
      const b = makeDirEntry({ shellId: 'b' });
      const done = makeDirEntry({ shellId: 'c' });
      reg.register(a);
      reg.register(b);
      reg.register(done);
      reg.complete('c', 0, 1500);
      reg.abortAll();
      expect(readStatus(a.statusPath)['status']).toBe('cancelled');
      expect(readStatus(b.statusPath)['status']).toBe('cancelled');
      expect(readStatus(done.statusPath)['status']).toBe('completed');
    });

    it('leaves no temp-file residue next to the sidecar', () => {
      const reg = new BackgroundShellRegistry();
      const e = makeDirEntry({ shellId: 'a' });
      reg.register(e);
      reg.complete('a', 0, 2000);
      const residue = readdirSync(dirname(e.statusPath)).filter(
        (name) => !/^shell-a\.(output|status)$/.test(name),
      );
      expect(residue).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')(
      'forces 0o600 even when a looser sidecar pre-exists (forceMode)',
      () => {
        const reg = new BackgroundShellRegistry();
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
        const reg = new BackgroundShellRegistry();
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
      const reg = new BackgroundShellRegistry();
      const e = makeEntry({
        shellId: 'a',
        outputPath: join(makeTempDir(), 'no-such-dir', 'shell-a.output'),
      });
      expect(() => reg.register(e)).not.toThrow();
      expect(() => reg.complete('a', 0, 2000)).not.toThrow();
    });
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
