/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BEGIN_SYNCHRONIZED_UPDATE,
  END_SYNCHRONIZED_UPDATE,
  getSynchronizedOutputStatsSnapshot,
  installSynchronizedOutput,
  resetSynchronizedOutputStats,
  terminalSupportsSynchronizedOutput,
  windowsBuildNumber,
} from './synchronizedOutput.js';
import { installTerminalRedrawOptimizer } from './terminalRedrawOptimizer.js';

const ESC = '\u001B[';
const ERASE_LINE = `${ESC}2K`;
const CURSOR_UP_ONE = `${ESC}1A`;
const CURSOR_DOWN_ONE = `${ESC}1B`;
const CURSOR_LEFT = `${ESC}G`;

function createStdout(write: NodeJS.WriteStream['write']): NodeJS.WriteStream {
  return {
    isTTY: true,
    write,
  } as NodeJS.WriteStream;
}

describe('terminalSupportsSynchronizedOutput', () => {
  it.each([
    [{ TERM_PROGRAM: 'WezTerm' }, true],
    [{ TERM_PROGRAM: 'WarpTerminal' }, true],
    [{ TERM_PROGRAM: 'ghostty' }, true],
    [{ TERM_PROGRAM: 'iTerm.app' }, true],
    [{ TERM: 'xterm-kitty' }, true],
    [{ KITTY_WINDOW_ID: '1' }, true],
    [{ TERM_PROGRAM: 'Apple_Terminal' }, false],
    [{ TERM_PROGRAM: 'JetBrains-JediTerm' }, false],
    [{ TERM_PROGRAM: 'WezTerm', TMUX: '/tmp/tmux' }, false],
    [{ TERM_PROGRAM: 'WezTerm', SSH_TTY: '/dev/pts/1' }, false],
    [{ TERM_PROGRAM: 'WezTerm', SSH_CLIENT: '127.0.0.1 1 2' }, false],
    [{ TERM_PROGRAM: 'WezTerm', QWEN_CODE_SYNCHRONIZED_OUTPUT: '0' }, false],
    [
      {
        TERM_PROGRAM: 'WezTerm',
        QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT: '1',
        QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1',
      },
      false,
    ],
    [
      {
        TERM_PROGRAM: 'Apple_Terminal',
        QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1',
      },
      true,
    ],
  ])('detects support for %j', (env, expected) => {
    expect(terminalSupportsSynchronizedOutput(env)).toBe(expected);
  });

  it.each([
    ['10.0.26100', true],
    ['10.0.22631', false],
    ['10.0.19045', false],
  ])(
    'reads the build from the native Windows release %s',
    (osRelease, expected) => {
      expect(
        terminalSupportsSynchronizedOutput(
          { WT_SESSION: 'abc' },
          osRelease,
          'win32',
        ),
      ).toBe(expected);
    },
  );

  it('does not infer a terminal version from the Windows OS build', () => {
    // #11929: Windows Terminal 1.12 on Windows 11 build 22631 flickers, and
    // the same host upgraded to 1.24 implements the mode. The OS build says
    // nothing about which terminal is painting, so it can neither grant nor
    // withhold the wrappers — the override is the way to claim support.
    expect(
      terminalSupportsSynchronizedOutput(
        { WT_SESSION: 'abc' },
        '10.0.22631',
        'win32',
      ),
    ).toBe(false);
    expect(
      terminalSupportsSynchronizedOutput(
        {
          WT_SESSION: 'abc',
          QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1',
        },
        '10.0.22631',
        'win32',
      ),
    ).toBe(true);
  });

  it('does not gate WSL sessions on WT_SESSION', () => {
    // WT_SESSION is set on the Windows side and does not reach a stock WSL
    // shell, so a WSL session carries WSL_DISTRO_NAME and no WT_SESSION.
    expect(
      terminalSupportsSynchronizedOutput(
        { WSL_DISTRO_NAME: 'Ubuntu' },
        '5.15.167.4-microsoft-standard-WSL2',
        'linux',
      ),
    ).toBe(false);
  });

  it('keeps a WSL kernel release from producing a Windows build', () => {
    // WSL2 runs a real Linux kernel; neither its shape nor the WSL1 synthetic
    // one carries a Windows build, so no kernel release may yield a number.
    for (const release of [
      '4.4.0-26100-Microsoft',
      '4.19.104-microsoft-standard',
      '5.15.167.4-microsoft-standard-WSL2',
    ]) {
      expect(windowsBuildNumber(release, 'linux')).toBeUndefined();
    }
    expect(windowsBuildNumber('10.0.26100', 'win32')).toBe(26100);
  });

  it('keeps a non-Windows-Terminal host when WT_SESSION is inherited', () => {
    // A WezTerm tab launched from Windows Terminal inherits WT_SESSION; the
    // allow-list below must still decide, or an old build would switch the
    // wrappers off for a terminal that supports them.
    expect(
      terminalSupportsSynchronizedOutput(
        { TERM_PROGRAM: 'WezTerm', WT_SESSION: 'abc' },
        '10.0.19045',
        'win32',
      ),
    ).toBe(true);
  });

  it('keeps a non-Windows-Terminal host with no build at all', () => {
    expect(
      terminalSupportsSynchronizedOutput({
        TERM_PROGRAM: 'ghostty',
        WT_SESSION: 'abc',
      }),
    ).toBe(true);
  });

  it('requires an explicit override for Windows Terminal when the build is unknown', () => {
    // Without a native release there is no way to learn the host build, so the
    // wrappers stay off rather than risk old Windows Terminal dropping them.
    expect(terminalSupportsSynchronizedOutput({ WT_SESSION: 'abc' })).toBe(
      false,
    );
    expect(
      terminalSupportsSynchronizedOutput({
        WT_SESSION: 'abc',
        QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT: '1',
      }),
    ).toBe(true);
  });

  it('keeps the wrappers off when Windows Terminal is behind tmux', () => {
    // The multiplexer in between decides whether DECSET 2026 reaches the host,
    // so the host build alone is not enough.
    expect(
      terminalSupportsSynchronizedOutput(
        {
          WT_SESSION: 'abc',
          TMUX: '/tmp/tmux-1000/default,123,0',
        },
        '10.0.26100',
        'win32',
      ),
    ).toBe(false);
  });

  it('honours the disable switch on Windows Terminal', () => {
    expect(
      terminalSupportsSynchronizedOutput(
        {
          WT_SESSION: 'abc',
          QWEN_CODE_SYNCHRONIZED_OUTPUT: '0',
        },
        '10.0.26100',
        'win32',
      ),
    ).toBe(false);
    // Positive control: the same host without the switch is granted, so the
    // case above fails for the switch and not for a stale platform default.
    expect(
      terminalSupportsSynchronizedOutput(
        { WT_SESSION: 'abc' },
        '10.0.26100',
        'win32',
      ),
    ).toBe(true);
  });

  it('detects a stock Windows Terminal session by WT_SESSION alone', () => {
    // Windows Terminal sets WT_SESSION and no TERM_PROGRAM, so a gate keyed on
    // TERM_PROGRAM is unreachable on the host #11929 was filed from.
    expect(
      terminalSupportsSynchronizedOutput(
        { WT_SESSION: 'abc' },
        '10.0.26100',
        'win32',
      ),
    ).toBe(true);
    expect(
      terminalSupportsSynchronizedOutput(
        { WT_SESSION: 'abc' },
        '10.0.22631',
        'win32',
      ),
    ).toBe(false);
  });

  it('does not take an inherited WT_SESSION inside WSL for Windows Terminal', () => {
    // A WSL shell on a Windows Terminal tab inherits WT_SESSION but runs a
    // Linux kernel, so the build gate cannot be satisfied either way.
    expect(
      terminalSupportsSynchronizedOutput(
        {
          WT_SESSION: 'abc',
          WSL_DISTRO_NAME: 'Ubuntu',
        },
        '5.15.167.4-microsoft-standard-WSL2',
        'linux',
      ),
    ).toBe(false);
  });
});

describe('installSynchronizedOutput', () => {
  afterEach(() => {
    resetSynchronizedOutputStats();
  });

  it('does not install for non-TTY stdout', () => {
    const write = vi.fn(() => true) as NodeJS.WriteStream['write'];
    const stdout = {
      isTTY: false,
      write,
    } as NodeJS.WriteStream;

    const restore = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'WezTerm',
    });

    expect(stdout.write).toBe(write);
    restore();
  });

  it('wraps one synchronous write burst in balanced BSU and ESU markers', async () => {
    const writes: string[] = [];
    const write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as NodeJS.WriteStream['write'];
    const stdout = createStdout(write);

    const restore = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'WezTerm',
    });

    stdout.write('frame-a');
    stdout.write(Buffer.from('frame-b'));
    await Promise.resolve();

    expect(writes).toEqual([
      BEGIN_SYNCHRONIZED_UPDATE,
      'frame-a',
      'frame-b',
      END_SYNCHRONIZED_UPDATE,
    ]);
    expect(getSynchronizedOutputStatsSnapshot()).toEqual({
      synchronizedOutputFrameCount: 1,
      synchronizedOutputBeginCount: 1,
      synchronizedOutputEndCount: 1,
    });

    restore();
    expect(stdout.write).toBe(write);
  });

  it('preserves write return values and callbacks', async () => {
    const callback = vi.fn();
    const write = vi.fn(
      (
        _chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      ) => {
        if (typeof encodingOrCallback === 'function') {
          encodingOrCallback();
        }
        return false;
      },
    ) as NodeJS.WriteStream['write'];
    const stdout = createStdout(write);

    const restore = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'iTerm.app',
    });

    const result = stdout.write('payload', callback);
    await Promise.resolve();

    expect(result).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
    restore();
  });

  it('composes after terminal redraw optimization without losing erase optimization', async () => {
    const writes: string[] = [];
    const write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as NodeJS.WriteStream['write'];
    const stdout = createStdout(write);
    // Pass an empty env so WSL detection does not skip the optimizer when
    // the test itself runs on WSL (#7897).
    const restoreRedrawOptimizer = installTerminalRedrawOptimizer(stdout, {});
    const restoreSynchronizedOutput = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'WezTerm',
    });

    stdout.write(
      `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}`,
    );
    await Promise.resolve();

    expect(writes).toEqual([
      BEGIN_SYNCHRONIZED_UPDATE,
      `${ESC}2A${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${ESC}2A${CURSOR_LEFT}`,
      END_SYNCHRONIZED_UPDATE,
    ]);

    restoreSynchronizedOutput();
    restoreRedrawOptimizer();
    expect(stdout.write).toBe(write);
  });

  it('closes an open frame before restore', () => {
    const writes: string[] = [];
    const write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as NodeJS.WriteStream['write'];
    const stdout = createStdout(write);
    const restore = installSynchronizedOutput(stdout, {
      TERM_PROGRAM: 'WezTerm',
    });

    stdout.write('payload');
    restore();

    expect(writes).toEqual([
      BEGIN_SYNCHRONIZED_UPDATE,
      'payload',
      END_SYNCHRONIZED_UPDATE,
    ]);
    expect(stdout.write).toBe(write);
  });
});
