/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendNotification } from './notificationService.js';
import type { TerminalNotification } from '../ui/hooks/useTerminalNotification.js';

vi.mock('../utils/osc.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/osc.js')>();
  return {
    ...original,
    detectTerminal: vi.fn(() => 'unknown'),
    generateKittyId: vi.fn(() => 42),
  };
});

const { detectTerminal: mockedDetectTerminal } = await import(
  '../utils/osc.js'
);

function createMockTerminal(): TerminalNotification {
  return {
    notifyITerm2: vi.fn(),
    notifyKitty: vi.fn(),
    notifyGhostty: vi.fn(),
    notifyBell: vi.fn(),
  };
}

describe('sendNotification', () => {
  let terminal: TerminalNotification;

  const origIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    terminal = createMockTerminal();
    vi.mocked(mockedDetectTerminal).mockReturnValue('unknown');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: origIsTTY,
      configurable: true,
    });
  });

  it('returns disabled when not enabled', () => {
    const result = sendNotification({ message: 'test' }, terminal, false);
    expect(result).toBe('disabled');
    expect(terminal.notifyBell).not.toHaveBeenCalled();
  });

  it('sends iTerm2 notification for iTerm.app', () => {
    vi.mocked(mockedDetectTerminal).mockReturnValue('iTerm.app');
    const result = sendNotification(
      { message: 'test', title: 'Title' },
      terminal,
      true,
    );
    expect(result).toBe('iterm2');
    expect(terminal.notifyITerm2).toHaveBeenCalledWith({
      message: 'test',
      title: 'Title',
    });
  });

  it('sends kitty notification for kitty', () => {
    vi.mocked(mockedDetectTerminal).mockReturnValue('kitty');
    const result = sendNotification(
      { message: 'test', title: 'Title' },
      terminal,
      true,
    );
    expect(result).toBe('kitty');
    expect(terminal.notifyKitty).toHaveBeenCalledWith({
      message: 'test',
      title: 'Title',
      id: 42,
    });
  });

  it('sends ghostty notification for ghostty', () => {
    vi.mocked(mockedDetectTerminal).mockReturnValue('ghostty');
    const result = sendNotification(
      { message: 'test', title: 'Title' },
      terminal,
      true,
    );
    expect(result).toBe('ghostty');
    expect(terminal.notifyGhostty).toHaveBeenCalledWith({
      message: 'test',
      title: 'Title',
    });
  });

  it('falls back to bell for Apple_Terminal', () => {
    vi.mocked(mockedDetectTerminal).mockReturnValue('Apple_Terminal');
    const result = sendNotification({ message: 'test' }, terminal, true);
    expect(result).toBe('terminal_bell');
    expect(terminal.notifyBell).toHaveBeenCalled();
  });

  it('falls back to bell for unknown terminal', () => {
    vi.mocked(mockedDetectTerminal).mockReturnValue('unknown');
    const result = sendNotification({ message: 'test' }, terminal, true);
    expect(result).toBe('terminal_bell');
    expect(terminal.notifyBell).toHaveBeenCalled();
  });

  it('uses default title when not provided', () => {
    vi.mocked(mockedDetectTerminal).mockReturnValue('iTerm.app');
    sendNotification({ message: 'test' }, terminal, true);
    expect(terminal.notifyITerm2).toHaveBeenCalledWith({
      message: 'test',
      title: 'Qwen Code',
    });
  });

  it('returns error when notification method throws', () => {
    vi.mocked(mockedDetectTerminal).mockReturnValue('iTerm.app');
    vi.mocked(terminal.notifyITerm2).mockImplementation(() => {
      throw new Error('write failed');
    });
    const result = sendNotification({ message: 'test' }, terminal, true);
    expect(result).toBe('error');
  });

  it('returns disabled when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    const result = sendNotification({ message: 'test' }, terminal, true);
    expect(result).toBe('disabled');
    expect(terminal.notifyBell).not.toHaveBeenCalled();
  });
});
