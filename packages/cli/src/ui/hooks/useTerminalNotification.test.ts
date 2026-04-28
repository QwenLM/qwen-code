/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildTerminalNotification } from './useTerminalNotification.js';

describe('buildTerminalNotification', () => {
  const originalEnv = { ...process.env };
  const writeRaw = vi.fn();

  afterEach(() => {
    writeRaw.mockReset();
    process.env = { ...originalEnv };
  });

  it('notifyITerm2 writes OSC 9 sequence', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    delete process.env['TERM'];
    const terminal = buildTerminalNotification(writeRaw);
    terminal.notifyITerm2({ message: 'Hello', title: 'Test' });
    expect(writeRaw).toHaveBeenCalledTimes(1);
    const written = writeRaw.mock.calls[0]![0] as string;
    expect(written).toContain('Test:\nHello');
    expect(written).toContain('\x1b]9;');
  });

  it('notifyKitty writes three OSC 99 sequences', () => {
    process.env['TERM'] = 'xterm-kitty';
    delete process.env['TERM_PROGRAM'];
    const terminal = buildTerminalNotification(writeRaw);
    terminal.notifyKitty({ message: 'Body', title: 'Title', id: 7 });
    expect(writeRaw).toHaveBeenCalledTimes(3);
    const calls = writeRaw.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain('i=7:d=0:p=title');
    expect(calls[1]).toContain('i=7:p=body');
    expect(calls[2]).toContain('i=7:d=1:a=focus');
  });

  it('notifyGhostty writes OSC 777 sequence', () => {
    process.env['TERM_PROGRAM'] = 'ghostty';
    delete process.env['TERM'];
    const terminal = buildTerminalNotification(writeRaw);
    terminal.notifyGhostty({ message: 'Body', title: 'Title' });
    expect(writeRaw).toHaveBeenCalledTimes(1);
    const written = writeRaw.mock.calls[0]![0] as string;
    expect(written).toContain('777;notify;Title;Body');
  });

  it('notifyBell writes raw BEL without wrapping', () => {
    process.env['TMUX'] = '/tmp/tmux';
    const terminal = buildTerminalNotification(writeRaw);
    terminal.notifyBell();
    expect(writeRaw).toHaveBeenCalledWith('\x07');
    // BEL should NOT be wrapped in DCS passthrough
    expect(writeRaw.mock.calls[0]![0]).not.toContain('\x1bPtmux');
  });
});
