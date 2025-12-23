/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { contextCommand } from './contextCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

// Mock the context analysis function
vi.mock('@qwen-code/qwen-code-core/utils/contextAnalysis.js', () => ({
  analyzeContextUsage: vi.fn(),
}));

// Mock the prompts module
vi.mock('@qwen-code/qwen-code-core/core/prompts.js', () => ({
  getCoreSystemPrompt: vi.fn(() => 'Test system prompt'),
}));

describe('contextCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = createMockCommandContext();
  });

  it('should have correct metadata', () => {
    expect(contextCommand.name).toBe('context');
    expect(contextCommand.altNames).toContain('ctx');
    expect(contextCommand.description).toBeDefined();
  });

  it('should display error when config is unavailable', async () => {
    // Override the mock context to have no config
    mockContext = createMockCommandContext();
    mockContext.system.config = null;

    if (!contextCommand.action) {
      throw new Error('Command has no action');
    }

    await contextCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
      }),
      expect.any(Number),
    );
  });

  it('should display error when chat history is unavailable', async () => {
    // Mock config with no chat
    if (mockContext.system.config) {
      vi.spyOn(mockContext.system.config, 'getChat').mockReturnValue(null);
    }

    if (!contextCommand.action) {
      throw new Error('Command has no action');
    }

    await contextCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
      }),
      expect.any(Number),
    );
  });

  // Note: Full integration test with mocked analyzeContextUsage would require
  // more complex setup. This test verifies the basic command structure and error handling.
});
