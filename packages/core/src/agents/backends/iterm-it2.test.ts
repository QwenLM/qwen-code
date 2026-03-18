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

describe('iterm-it2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── isIt2Available ─────────────────────────────────────────

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

  // ─── ensureIt2Installed ──────────────────────────────────────

  describe('ensureIt2Installed', () => {
    it('does nothing if it2 is already available', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      await ensureIt2Installed();
      expect(hoistedExecCommand).not.toHaveBeenCalled();
    });

    it('installs via uv when uv is available', async () => {
      // isIt2Available() → false; uv available; install succeeds; recheck → true
      hoistedIsCommandAvailable
        .mockReturnValueOnce({ available: false }) // isIt2Available() initial
        .mockReturnValueOnce({ available: true }); // uv available
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
      });
      // After install, it2 is available
      hoistedIsCommandAvailable.mockReturnValueOnce({ available: true });

      await ensureIt2Installed();

      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'uv',
        ['tool', 'install', 'it2'],
        expect.any(Object),
      );
    });

    it('falls back to pipx when uv is unavailable', async () => {
      hoistedIsCommandAvailable
        .mockReturnValueOnce({ available: false }) // isIt2Available()
        .mockReturnValueOnce({ available: false }) // uv not available
        .mockReturnValueOnce({ available: true }); // pipx available
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
      });
      hoistedIsCommandAvailable.mockReturnValueOnce({ available: true }); // recheck

      await ensureIt2Installed();

      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'pipx',
        ['install', 'it2'],
        expect.any(Object),
      );
    });

    it('falls back to pip when uv and pipx are unavailable', async () => {
      hoistedIsCommandAvailable
        .mockReturnValueOnce({ available: false }) // isIt2Available()
        .mockReturnValueOnce({ available: false }) // uv
        .mockReturnValueOnce({ available: false }) // pipx
        .mockReturnValueOnce({ available: true }); // pip available
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
      });
      hoistedIsCommandAvailable.mockReturnValueOnce({ available: true }); // recheck

      await ensureIt2Installed();

      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'pip',
        ['install', '--user', 'it2'],
        expect.any(Object),
      );
    });

    it('throws if no installer succeeds', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: false });

      await expect(ensureIt2Installed()).rejects.toThrow(
        'it2 is not installed',
      );
    });
  });

  // ─── verifyITerm ──────────────────────────────────────────────

  describe('verifyITerm', () => {
    it('succeeds when session list returns code 0', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: 'session1\n',
        stderr: '',
      });

      await expect(verifyITerm()).resolves.toBeUndefined();
    });

    it('throws Python API error when stderr mentions "api"', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      hoistedExecCommand.mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: 'Python API not enabled',
      });

      await expect(verifyITerm()).rejects.toThrow('Python API not enabled');
    });

    it('throws Python API error when stderr mentions "connection refused"', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      hoistedExecCommand.mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: 'Connection refused to iTerm2',
      });

      await expect(verifyITerm()).rejects.toThrow('Python API not enabled');
    });

    it('throws generic error for unrecognized failures', async () => {
      hoistedIsCommandAvailable.mockReturnValue({ available: true });
      hoistedExecCommand.mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: 'some unknown error',
      });

      await expect(verifyITerm()).rejects.toThrow('it2 session list failed');
    });
  });

  // ─── itermSplitPane ──────────────────────────────────────────

  describe('itermSplitPane', () => {
    it('splits vertically without session ID', async () => {
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: 'Created new pane: w0t1p2\n',
        stderr: '',
      });

      const paneId = await itermSplitPane();
      expect(paneId).toBe('w0t1p2');
      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'it2',
        ['session', 'split', '-v'],
        expect.any(Object),
      );
    });

    it('passes -s flag when session ID is provided', async () => {
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: 'Created new pane: w0t1p3\n',
        stderr: '',
      });

      await itermSplitPane('sess-123');
      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'it2',
        ['session', 'split', '-v', '-s', 'sess-123'],
        expect.any(Object),
      );
    });

    it('throws if pane ID cannot be parsed from output', async () => {
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: 'Unexpected output\n',
        stderr: '',
      });

      await expect(itermSplitPane()).rejects.toThrow('Unable to parse');
    });

    it('throws on non-zero exit code', async () => {
      hoistedExecCommand.mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: 'split failed',
      });

      await expect(itermSplitPane()).rejects.toThrow('split failed');
    });
  });

  // ─── itermRunCommand ──────────────────────────────────────────

  describe('itermRunCommand', () => {
    it('calls it2 session run with correct args', async () => {
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
      });

      await itermRunCommand('sess-1', 'ls -la');
      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'it2',
        ['session', 'run', '-s', 'sess-1', 'ls -la'],
        expect.any(Object),
      );
    });
  });

  // ─── itermFocusSession ────────────────────────────────────────

  describe('itermFocusSession', () => {
    it('calls it2 session focus with correct args', async () => {
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
      });

      await itermFocusSession('sess-1');
      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'it2',
        ['session', 'focus', 'sess-1'],
        expect.any(Object),
      );
    });
  });

  // ─── itermSendText ─────────────────────────────────────────────

  describe('itermSendText', () => {
    it('calls it2 session send with correct args', async () => {
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
      });

      await itermSendText('sess-1', 'hello world');
      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'it2',
        ['session', 'send', '-s', 'sess-1', 'hello world'],
        expect.any(Object),
      );
    });
  });

  // ─── itermCloseSession ────────────────────────────────────────

  describe('itermCloseSession', () => {
    it('calls it2 session close with correct args', async () => {
      hoistedExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
      });

      await itermCloseSession('sess-1');
      expect(hoistedExecCommand).toHaveBeenCalledWith(
        'it2',
        ['session', 'close', '-s', 'sess-1'],
        expect.any(Object),
      );
    });
  });
});
