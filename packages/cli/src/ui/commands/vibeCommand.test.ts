/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { vibeCommand } from './vibeCommand.js';
import {
  CommandKind,
  type CommandContext,
  type MessageActionReturn,
} from './types.js';

describe('vibeCommand', () => {
  let mockContext: CommandContext;
  let mockSetVibeMode: ReturnType<typeof vi.fn>;
  let currentVibeMode: boolean;

  beforeEach(() => {
    currentVibeMode = false;
    mockSetVibeMode = vi.fn((value: boolean) => {
      currentVibeMode = value;
    });

    mockContext = createMockCommandContext({
      services: {
        config: {
          getVibeMode: () => currentVibeMode,
          setVibeMode: mockSetVibeMode,
        },
      },
    });
  });

  it('has expected metadata', () => {
    expect(vibeCommand.name).toBe('vibe');
    expect(vibeCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(vibeCommand.description).toBe(
      'Toggle Vibe mode safe shell auto-approval (on/off)',
    );
  });

  it('turns vibe mode on with explicit argument', async () => {
    const result = (await vibeCommand.action?.(
      mockContext,
      'on',
    )) as MessageActionReturn;

    expect(result.messageType).toBe('info');
    expect(result.content).toContain('on');
    expect(mockSetVibeMode).toHaveBeenCalledWith(true);
  });

  it('turns vibe mode off with explicit argument', async () => {
    currentVibeMode = true;

    const result = (await vibeCommand.action?.(
      mockContext,
      'off',
    )) as MessageActionReturn;

    expect(result.messageType).toBe('info');
    expect(result.content).toContain('off');
    expect(mockSetVibeMode).toHaveBeenCalledWith(false);
  });

  it('toggles vibe mode when no argument is provided', async () => {
    const result = (await vibeCommand.action?.(
      mockContext,
      '',
    )) as MessageActionReturn;

    expect(result.messageType).toBe('info');
    expect(result.content).toContain('on');
    expect(mockSetVibeMode).toHaveBeenCalledWith(true);
  });

  it('returns error for invalid argument', async () => {
    const result = (await vibeCommand.action?.(
      mockContext,
      'invalid',
    )) as MessageActionReturn;

    expect(result.messageType).toBe('error');
    expect(mockSetVibeMode).not.toHaveBeenCalled();
  });

  it('returns error when config rejects vibe mode enabling', async () => {
    mockSetVibeMode.mockImplementation(() => {
      throw new Error('Cannot enable vibe mode in an untrusted folder.');
    });

    const result = (await vibeCommand.action?.(
      mockContext,
      'on',
    )) as MessageActionReturn;

    expect(result.messageType).toBe('error');
    expect(result.content).toContain('Cannot enable vibe mode');
  });
});
