/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Hoisted mocks for shell-utils ──────────────────────────────
const hoistedExecCommand = vi.hoisted(() => vi.fn());
const hoistedIsCommandAvailable = vi.hoisted(() => vi.fn());

vi.mock('../../utils/shell-utils.js', () => ({
  execCommand: hoistedExecCommand,
  isCommandAvailable: hoistedIsCommandAvailable,
}));

vi.mock('../../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  isIt2Available,
  ensureIt2Installed,
  verifyITerm,
  itermSplitPane,
  itermRunCommand,
  itermFocusSession,
  itermSendText,
  itermCloseSession,
} from './iterm-it2.js';

const execReturns = (code: number, stdout = '', stderr = '') =>
  hoistedExecCommand.mockResolvedValue({ code, stdout, stderr });
const availableOnce = (...flags: boolean[]) =>
  flags.forEach((available) =>
    hoistedIsCommandAvailable.mockReturnValueOnce({ available }),
  );
const expectExec = (command: string, args: string[]) =>
  expect(hoistedExecCommand).toHaveBeenCalledWith(
    command,
    args,
    expect.any(Object),
  );

describe('iterm-it2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isIt2Available', () => {
    it('returns true when it2 is on PATH', () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      expect(isIt2Available()).toBe(true);
      expect(hoistedIsCommandAvailable).toHaveBeenCalledWith('it2');
    });

    it('returns false when it2 is not on PATH', () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: false });
      expect(isIt2Available()).toBe(false);
    });
  });

  describe('ensureIt2Installed', () => {
    it('does nothing if it2 is already available', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      await ensureIt2Installed();
      expect(hoistedExecCommand).not.toHaveBeenCalled();
    });

    it.each([
      [
        'installs via uv when uv is available',
        0,
        'uv',
        ['tool', 'install', 'it2'],
      ],
      [
        'falls back to pipx when uv is unavailable',
        1,
        'pipx',
        ['install', 'it2'],
      ],
      [
        'falls back to pip when uv and pipx are unavailable',
        2,
        'pip',
        ['install', '--user', 'it2'],
      ],
    ])('%s', async (_title, skipped, command, args) => {
      // isIt2Available() → false; `skipped` earlier installers (uv, pipx)
      // unavailable; this installer available; install succeeds; recheck → true
      availableOnce(false, ...Array<boolean>(skipped).fill(false), true);
      execReturns(0);
      availableOnce(true);

      await ensureIt2Installed();

      expectExec(command, args);
    });

    it('throws if no installer succeeds', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: false });

      await expect(ensureIt2Installed()).rejects.toThrow(
        'it2 is not installed',
      );
    });
  });

  describe('verifyITerm', () => {
    it('succeeds when session list returns code 0', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      execReturns(0, 'session1\n');

      await expect(verifyITerm()).resolves.toBeUndefined();
    });

    it.each([
      [
        'throws Python API error when stderr mentions "api"',
        'Python API not enabled',
        'Python API not enabled',
      ],
      [
        'throws Python API error when stderr mentions "connection refused"',
        'Connection refused to iTerm2',
        'Python API not enabled',
      ],
      [
        'throws generic error for unrecognized failures',
        'some unknown error',
        'it2 session list failed',
      ],
    ])('%s', async (_title, stderr, message) => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      execReturns(1, '', stderr);

      await expect(verifyITerm()).rejects.toThrow(message);
    });
  });

  describe('itermSplitPane', () => {
    it('splits vertically without session ID', async () => {
      execReturns(0, 'Created new pane: w0t1p2\n');

      const paneId = await itermSplitPane();
      expect(paneId).toBe('w0t1p2');
      expectExec('it2', ['session', 'split', '-v']);
    });

    it('passes -s flag when session ID is provided', async () => {
      execReturns(0, 'Created new pane: w0t1p3\n');

      await itermSplitPane('sess-123');
      expectExec('it2', ['session', 'split', '-v', '-s', 'sess-123']);
    });

    it('throws if pane ID cannot be parsed from output', async () => {
      execReturns(0, 'Unexpected output\n');

      await expect(itermSplitPane()).rejects.toThrow('Unable to parse');
    });

    it('throws on non-zero exit code', async () => {
      execReturns(1, '', 'split failed');

      await expect(itermSplitPane()).rejects.toThrow('split failed');
    });
  });

  describe('itermRunCommand', () => {
    it('calls it2 session run with correct args', async () => {
      execReturns(0);
      await itermRunCommand('sess-1', 'ls -la');
      expectExec('it2', ['session', 'run', '-s', 'sess-1', 'ls -la']);
    });
  });

  describe('itermFocusSession', () => {
    it('calls it2 session focus with correct args', async () => {
      execReturns(0);
      await itermFocusSession('sess-1');
      expectExec('it2', ['session', 'focus', 'sess-1']);
    });
  });

  describe('itermSendText', () => {
    it('calls it2 session send with correct args', async () => {
      execReturns(0);
      await itermSendText('sess-1', 'hello world');
      expectExec('it2', ['session', 'send', '-s', 'sess-1', 'hello world']);
    });
  });

  describe('itermCloseSession', () => {
    it('calls it2 session close with correct args', async () => {
      execReturns(0);
      await itermCloseSession('sess-1');
      expectExec('it2', ['session', 'close', '-s', 'sess-1']);
    });
  });
});
