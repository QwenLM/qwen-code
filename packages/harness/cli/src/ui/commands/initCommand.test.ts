/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { initCommand } from './initCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import type { SubmitPromptActionReturn } from '@qwen-code/core';
import type { ReactElement } from 'react';

// Mock the 'fs' module
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

describe('initCommand', () => {
  let mockContext: CommandContext;
  const targetDir = '/test/dir';

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getTargetDir: () => targetDir,
            isInteractive: vi.fn(() => true),
            getCurrentContextFileName: vi.fn(() => 'AGENTS.md'),
          },
        },
      },
    });

    // Make setCustomDialog capture the element and auto-trigger onSelect with 'quick'
    vi.mocked(mockContext.ui.setCustomDialog).mockImplementation(
      (element: unknown) => {
        if (element !== null && typeof element === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const props = (element as any).props;
          if (props?.onSelect) {
            // Simulate user selecting 'quick' mode
            setTimeout(() => props.onSelect('quick'), 0);
          }
        }
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should submit enhanced prompt with multi-phase workflow', async () => {
    const result = (await initCommand.action!(
      mockContext,
      '',
    )) as SubmitPromptActionReturn;

    expect(result.type).toBe('submit_prompt');
    expect(result.content).toContain('Step 1');
    expect(result.content).toContain('AGENTS.md');
    expect(
      vi
        .mocked(fs.writeFileSync)
        .mock.calls.some(([file]) => String(file).endsWith('/AGENTS.md')),
    ).toBe(false);
  });

  it('should close without submitting a prompt when onClose is triggered', async () => {
    // Override to trigger onClose instead of onSelect
    vi.mocked(mockContext.ui.setCustomDialog).mockImplementation(
      (element: unknown) => {
        if (element !== null && typeof element === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const props = (element as any).props;
          if (props?.onClose) {
            setTimeout(() => props.onClose(), 0);
          }
        }
      },
    );

    const result = await initCommand.action!(mockContext, '');

    expect(result).toBeUndefined();
    expect(mockContext.ui.setCustomDialog).toHaveBeenCalledTimes(2);
    expect(mockContext.ui.setCustomDialog).toHaveBeenLastCalledWith(null);
  });

  it('should still submit the interactive prompt when explicitly selected', async () => {
    vi.mocked(mockContext.ui.setCustomDialog).mockImplementation((element) => {
      if (element) {
        const dialog = element as ReactElement<{
          onSelect: (mode: 'interactive') => void;
        }>;
        dialog.props.onSelect('interactive');
      }
    });

    const result = (await initCommand.action!(
      mockContext,
      '',
    )) as SubmitPromptActionReturn;

    expect(result.type).toBe('submit_prompt');
    expect(result.content).toContain('## Phase 1: Ask what to set up');
    expect(result.content).toContain('AGENTS.md');
    expect(mockContext.ui.setCustomDialog).toHaveBeenLastCalledWith(null);
  });

  it('should clear custom dialog after selection', async () => {
    await initCommand.action!(mockContext, '');

    // setCustomDialog should be called twice: once to show, once to clear (null)
    expect(mockContext.ui.setCustomDialog).toHaveBeenCalledTimes(2);
    expect(mockContext.ui.setCustomDialog).toHaveBeenLastCalledWith(null);
  });

  it.each(['AGENTS.md', 'CUSTOM.md'])(
    'should use %s in both the mode selector and init prompt',
    async (contextFileName) => {
      const config = mockContext.services.agentContext!.config;
      vi.mocked(config.getCurrentContextFileName).mockReturnValue(
        contextFileName,
      );

      const result = (await initCommand.action!(
        mockContext,
        '',
      )) as SubmitPromptActionReturn;
      const dialog = vi.mocked(mockContext.ui.setCustomDialog).mock
        .calls[0][0] as ReactElement<{ contextFileName: string }>;

      expect(dialog.props.contextFileName).toBe(contextFileName);
      expect(result.content).toContain(
        `Analyze the codebase and write a minimal ${contextFileName}.`,
      );
    },
  );

  it('should use quick mode directly outside an interactive session', async () => {
    const config = mockContext.services.agentContext?.config;
    expect(config).toBeDefined();
    vi.mocked(config!.isInteractive).mockReturnValue(false);

    const result = (await initCommand.action!(
      mockContext,
      '',
    )) as SubmitPromptActionReturn;

    expect(result).toMatchObject({
      type: 'submit_prompt',
      isMeta: true,
      content: expect.stringContaining('## Step 1: Explore the codebase'),
    });
    expect(result.content).not.toContain('AskUserQuestion');
    expect(mockContext.ui.setCustomDialog).not.toHaveBeenCalled();
  });

  it('should return an error if config is not available', async () => {
    const noConfigContext = createMockCommandContext();
    if (noConfigContext.services) {
      noConfigContext.services.agentContext = null;
    }

    const result = await initCommand.action!(noConfigContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    });
  });
});
