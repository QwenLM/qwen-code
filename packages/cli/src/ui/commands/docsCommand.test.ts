/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import open from 'open';
import { docsCommand } from './docsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

// Mock the 'open' library
vi.mock('open', () => ({
  default: vi.fn(),
}));

describe('docsCommand', () => {
  let mockContext: CommandContext;
  beforeEach(() => {
    // Create a fresh mock context before each test
    mockContext = createMockCommandContext();
    // Reset the `open` mock
    vi.mocked(open).mockClear();
  });

  afterEach(() => {
    // Restore any stubbed environment variables
    vi.unstubAllEnvs();
  });

  it("should add an info message and call 'open' in a non-sandbox environment", async () => {
    if (!docsCommand.action) {
      throw new Error('docsCommand must have an action.');
    }

    const docsUrl = 'https://qwenlm.github.io/qwen-code-docs/en';

    await docsCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: `Opening documentation in your browser: ${docsUrl}`,
      },
      expect.any(Number),
    );

    expect(open).toHaveBeenCalledWith(docsUrl);
  });

  it('should only add an info message in a sandbox environment', async () => {
    if (!docsCommand.action) {
      throw new Error('docsCommand must have an action.');
    }

    // Simulate a sandbox environment
    vi.stubEnv('SANDBOX', 'gemini-sandbox');
    const docsUrl = 'https://qwenlm.github.io/qwen-code-docs/en';

    await docsCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: `Please open the following URL in your browser to view the documentation:\n${docsUrl}`,
      },
      expect.any(Number),
    );

    // Ensure 'open' was not called in the sandbox
    expect(open).not.toHaveBeenCalled();
  });

  it("should not open browser for 'sandbox-exec'", async () => {
    if (!docsCommand.action) {
      throw new Error('docsCommand must have an action.');
    }

    // Simulate the specific 'sandbox-exec' environment
    vi.stubEnv('SANDBOX', 'sandbox-exec');
    const docsUrl = 'https://qwenlm.github.io/qwen-code-docs/en';

    await docsCommand.action(mockContext, '');

    // The logic should fall through to the 'else' block
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: `Opening documentation in your browser: ${docsUrl}`,
      },
      expect.any(Number),
    );

    // 'open' should be called in this specific sandbox case
    expect(open).toHaveBeenCalledWith(docsUrl);
  });

  describe('non-interactive mode', () => {
    it('should return docs URL without opening browser', async () => {
      if (!docsCommand.action) throw new Error('Command has no action');

      const nonInteractiveContext = createMockCommandContext({
        executionMode: 'non_interactive',
      });

      const result = await docsCommand.action(nonInteractiveContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('qwenlm.github.io'),
      });
      expect(open).not.toHaveBeenCalled();
      expect(nonInteractiveContext.ui.addItem).not.toHaveBeenCalled();
    });
  });
});
