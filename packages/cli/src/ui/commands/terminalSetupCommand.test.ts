/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { terminalSetupCommand } from './terminalSetupCommand.js';
import * as terminalSetupModule from '../utils/terminalSetup.js';
import type { CommandContext } from './types.js';

vi.mock('../utils/terminalSetup.js');

describe('terminalSetupCommand', () => {
  const context = {
    services: {
      agentContext: {
        config: { getScreenReader: () => false },
      },
    },
  } as unknown as CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(
      terminalSetupModule.formatTerminalSetupResultMessage,
    ).mockImplementation((result) =>
      result.restartNotice
        ? `${result.message}\n\n${result.restartNotice}`
        : result.message,
    );
  });

  it('should have correct metadata', () => {
    expect(terminalSetupCommand.name).toBe('terminal-setup');
    expect(terminalSetupCommand.description).toContain('terminal');
    expect(terminalSetupCommand.kind).toBe('built-in');
    expect(terminalSetupCommand.bridgeCommandType).toBe('local-jsx');
  });

  it('should return success message when terminal setup succeeds', async () => {
    vi.spyOn(terminalSetupModule, 'terminalSetup').mockResolvedValue({
      success: true,
      message: 'Terminal configured successfully',
    });

    const result = await terminalSetupCommand.action!(context, '');

    expect(result).toEqual({
      type: 'message',
      content: 'Terminal configured successfully',
      messageType: 'info',
    });
  });

  it('should append restart message when terminal setup requires restart', async () => {
    vi.spyOn(terminalSetupModule, 'terminalSetup').mockResolvedValue({
      success: true,
      message: 'Terminal configured successfully',
      restartNotice: 'Please restart the terminal.',
    });

    const result = await terminalSetupCommand.action!(context, '');

    expect(result).toEqual({
      type: 'message',
      content: 'Terminal configured successfully\n\nPlease restart the terminal.',
      messageType: 'info',
    });
  });

  it('should return error message when terminal setup fails', async () => {
    vi.spyOn(terminalSetupModule, 'terminalSetup').mockResolvedValue({
      success: false,
      message: 'Failed to detect terminal',
    });

    const result = await terminalSetupCommand.action!(context, '');

    expect(result).toEqual({
      type: 'message',
      content: 'Failed to detect terminal',
      messageType: 'error',
    });
  });

  it('should handle exceptions from terminal setup', async () => {
    vi.spyOn(terminalSetupModule, 'terminalSetup').mockRejectedValue(
      new Error('Unexpected error'),
    );

    const result = await terminalSetupCommand.action!(context, '');

    expect(result).toEqual({
      type: 'message',
      content: 'Failed to configure terminal: Error: Unexpected error',
      messageType: 'error',
    });
  });

  it('should preserve the screen-reader audible bell behavior', async () => {
    vi.spyOn(terminalSetupModule, 'terminalSetup').mockResolvedValue({
      success: true,
      message: 'Terminal configured successfully',
    });
    const screenReaderContext = {
      services: {
        agentContext: {
          config: { getScreenReader: () => true },
        },
      },
    } as unknown as CommandContext;

    await terminalSetupCommand.action!(screenReaderContext, '');

    expect(terminalSetupModule.terminalSetup).toHaveBeenCalledWith({
      screenReader: true,
    });
  });
});
