/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeLogText } from '@qwen-code/channel-base';
import {
  describeDwsCommandFailure,
  DWS_CALLER_HEAD_BUDGET,
  DwsClient,
  DwsCommandError,
} from './dws-client.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('DWS command process', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(execFile).mockReset();
  });

  it('escalates a timed-out command to SIGKILL', async () => {
    vi.useFakeTimers();
    let callback!: (
      error: NodeJS.ErrnoException | null,
      stdout: string,
      stderr: string,
    ) => void;
    const child = {
      exitCode: null as number | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL') {
          child.exitCode = 1;
          callback(Object.assign(new Error('killed'), { code: null }), '', '');
        }
        return true;
      }),
    };
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      receivedCallback,
    ) => {
      callback = receivedCallback;
      return child;
    }) as typeof execFile);

    const result = new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50_000);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(result).resolves.toBeInstanceOf(DwsCommandError);
  });

  it('names the failing subcommand and its stderr instead of only the exit code', async () => {
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      callback,
    ) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('Command failed'), { code: 1 }),
          '',
          'error: conversation is not open\n',
        ),
      );
      return { exitCode: 1, kill: vi.fn() };
    }) as unknown as typeof execFile);

    const error = (await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught)) as DwsCommandError;

    expect(error).toBeInstanceOf(DwsCommandError);
    expect(error.message).toContain('`dws version`');
    expect(error.message).toContain('(exit 1)');
    expect(error.message).toContain('error: conversation is not open');
    expect(error.outcome).toBe('unknown');
  });

  it('keeps a long stderr tail so the actual reason survives truncation', async () => {
    const banner = `${'progress line\n'.repeat(100)}error: sender is not in the conversation\n`;
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      callback,
    ) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('Command failed'), { code: 1 }),
          '',
          banner,
        ),
      );
      return { exitCode: 1, kill: vi.fn() };
    }) as unknown as typeof execFile);

    const error = (await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught)) as DwsCommandError;

    expect(error.message).toContain('sender is not in the conversation');
    expect(error.message.startsWith('…')).toBe(false);
    expect(error.message.length).toBeLessThan(800);
  });

  it('survives the callers 300-code-point head truncation', async () => {
    const banner = `${'progress line\n'.repeat(100)}error: sender is not in the conversation\n`;
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      callback,
    ) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('Command failed'), { code: 1 }),
          '',
          banner,
        ),
      );
      return { exitCode: 1, kill: vi.fn() };
    }) as unknown as typeof execFile);

    const error = (await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught)) as DwsCommandError;

    expect(sanitizeLogText(error.message, 300)).toContain(
      'sender is not in the conversation',
    );
    expect(sanitizeLogText(error.message, 200)).toContain(
      'sender is not in the conversation',
    );
  });

  it.each([
    ['ENOENT', '(ENOENT)'],
    ['ABORT_ERR', '(ABORT_ERR)'],
  ])('does not label the errno %s as an exit status', (code, expected) => {
    const message = describeDwsCommandFailure(['version'], code, '');

    expect(message).toContain(expected);
    expect(message).not.toContain('exit');
  });

  it('does not label a timeout kill as an exit status', () => {
    const message = describeDwsCommandFailure(['version'], null, '');

    expect(message).toContain('(null)');
    expect(message).not.toContain('exit');
  });

  it('omits the code entirely when the process never reported one', () => {
    expect(describeDwsCommandFailure(['version'], undefined, '')).toBe(
      'DWS command failed: `dws version`.',
    );
  });

  it('strips control characters before they reach a raw stderr write', () => {
    // `qwen channel start` prints this message through `writeStderrLine`
    // without sanitizing, so a carriage return or an escape sequence in the
    // child's stderr would repaint the operator's terminal.
    const message = describeDwsCommandFailure(
      ['version'],
      1,
      'error:\u001b[31mnot authenticated\u001b[0m\rspoofed line',
    );

    expect(message).not.toContain('\r');
    expect(message).not.toContain('\u001b');
    expect(message).toContain('not authenticated');
  });

  it('strips the C1, line- and bidi-separator class from the stderr reason', () => {
    // Repaint is not the only way to lie about a failure line: C1 controls,
    // U+2028/U+2029 and the bidi overrides/isolates re-split and reorder the
    // text after an escape sequence has already been removed.
    const message = describeDwsCommandFailure(
      ['version'],
      1,
      'error: \u009b2J‮evil‬ second⁦third⁩﻿​ text',
    );

    for (const unsafe of [
      '\u009b',
      '\u202e',
      '\u202c',
      '\u2028',
      '\u2066',
      '\u2069',
      '\ufeff',
      '\u200b',
    ]) {
      expect(message).not.toContain(unsafe);
    }
    expect(message).toContain('evil');
    expect(message).toContain('second');
  });

  it('does not leak flag values from a send-shaped argv', () => {
    const message = describeDwsCommandFailure(
      [
        '--profile',
        'corp:user',
        'chat',
        'message',
        'send',
        '--group',
        'cid-1',
        '--text',
        'the entire generated reply',
        '--uuid',
        'idem-1',
        '--format',
        'json',
      ],
      1,
      'error: conversation is not open',
    );

    expect(message).toContain('`dws chat message send`');
    expect(message).toContain('error: conversation is not open');
    expect(message).not.toContain('generated reply');
    expect(message).not.toContain('cid-1');
    expect(message).not.toContain('idem-1');
    expect(message.length).toBeLessThan(300);
  });

  it('keeps the cut marker inside the narrowest caller budget', () => {
    const message = describeDwsCommandFailure(
      ['chat', 'message', 'remove-emoji', '--group', 'cid-1'],
      1,
      `error: ${'x'.repeat(400)}`,
    );

    // logReactionFailure sanitizes at DWS_CALLER_HEAD_BUDGET and keeps the
    // head, so a reason that overruns it pushes the `…` past the cut and the
    // operator sees a full-looking line that was actually truncated.
    const logged = sanitizeLogText(message, DWS_CALLER_HEAD_BUDGET);
    expect(logged.endsWith('…')).toBe(true);
    expect(logged.length).toBeLessThanOrEqual(DWS_CALLER_HEAD_BUDGET);
  });

  it('never cuts a surrogate pair in half', () => {
    // The composed message fits DWS_CALLER_HEAD_BUDGET minus the 55 code points
    // this argv's prefix and ellipsis reserve, so the reason is cut at 144 code
    // points. 143 `a`s put the 144th on the high half of the first pair, which
    // is where a code-unit cut leaves a lone surrogate — sanitizeLogText then
    // blanks it to a space exactly where the reason was cut.
    const message = describeDwsCommandFailure(
      ['chat', 'message', 'send'],
      1,
      `${'a'.repeat(143)}${'\u{1f389}'.repeat(20)}`,
    );

    expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(message).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it.each([
    [['version'], 'dws version'],
    [['profile', 'list'], 'dws profile list'],
    [['auth', 'status', '--format', 'json'], 'dws auth status'],
    [
      ['--profile', 'p', 'todo', 'comment', 'add', '--task-id', 't'],
      'dws todo comment add',
    ],
  ])('names %j as %s', (args, expected) => {
    expect(describeDwsCommandFailure(args, 1, '')).toContain(expected);
  });
});
