/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import { dreamCommand } from './dreamCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('dreamCommand', () => {
  it('declares acp in supportedModes', () => {
    expect(dreamCommand.supportedModes).toEqual(['interactive', 'acp']);
  });

  it('returns error when config is not loaded', async () => {
    const context = createMockCommandContext({ services: { config: null } });
    const result = await dreamCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Config'),
    });
  });

  it('submits a consolidation prompt in interactive mode without eager metadata write', async () => {
    const projectRoot = path.join('tmp', 'dream-project');
    const buildConsolidationPrompt = vi.fn().mockReturnValue('dream prompt');
    const writeDreamManualRun = vi.fn();
    const context = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue(projectRoot),
          getMemoryManager: vi.fn().mockReturnValue({
            buildConsolidationPrompt,
            writeDreamManualRun,
          }),
          getSessionId: vi.fn().mockReturnValue('session-1'),
        },
      },
    });

    const result = await dreamCommand.action?.(context, '');
    const expectedTranscriptDir = path.join(
      new Storage(projectRoot).getProjectDir(),
      'chats',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'dream prompt',
      onComplete: expect.any(Function),
    });
    expect(buildConsolidationPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expectedTranscriptDir,
    );
    // In interactive mode, writeDreamManualRun is deferred to onComplete
    expect(writeDreamManualRun).not.toHaveBeenCalled();
  });

  it('runs the runtime-managed dream instead of submitting a prompt in structured mode', async () => {
    // The structured session prompt forbids the main model from touching
    // managed-memory paths with the file tools the consolidation prompt
    // requires, so /dream must not submit that prompt to the main model.
    const projectRoot = path.join('tmp', 'dream-project');
    const buildConsolidationPrompt = vi.fn().mockReturnValue('dream prompt');
    const runManualDream = vi.fn().mockResolvedValue({
      touchedTopics: [],
      createdEntries: 0,
      updatedEntries: 1,
      deletedEntries: 0,
      dedupedEntries: 0,
      splitEntries: 0,
      keywordBackfilled: 0,
      systemMessage: 'Managed auto-memory dream (agent): consolidated',
    });
    const context = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue(projectRoot),
          getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
          getMemoryManager: vi.fn().mockReturnValue({
            buildConsolidationPrompt,
            runManualDream,
          }),
          getSessionId: vi.fn().mockReturnValue('session-1'),
        },
      },
    });

    const result = await dreamCommand.action?.(context, '');

    expect(runManualDream).toHaveBeenCalledWith(
      projectRoot,
      context.services.config,
      'session-1',
    );
    expect(buildConsolidationPrompt).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Managed auto-memory dream (agent): consolidated',
    });
  });

  it('calls writeDreamManualRun eagerly in ACP mode without onComplete', async () => {
    const projectRoot = path.join('tmp', 'dream-project');
    const buildConsolidationPrompt = vi.fn().mockReturnValue('dream prompt');
    const writeDreamManualRun = vi.fn();
    const context = createMockCommandContext({
      executionMode: 'acp',
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue(projectRoot),
          getMemoryManager: vi.fn().mockReturnValue({
            buildConsolidationPrompt,
            writeDreamManualRun,
          }),
          getSessionId: vi.fn().mockReturnValue('session-1'),
        },
      },
    });

    const result = await dreamCommand.action?.(context, '');
    expect(writeDreamManualRun).toHaveBeenCalledWith(projectRoot, 'session-1');
    expect(result).toEqual({ type: 'submit_prompt', content: 'dream prompt' });
    expect(result).not.toHaveProperty('onComplete');
  });

  it('silently catches writeDreamManualRun errors in ACP mode', async () => {
    const projectRoot = path.join('tmp', 'dream-project');
    const buildConsolidationPrompt = vi.fn().mockReturnValue('dream prompt');
    const writeDreamManualRun = vi
      .fn()
      .mockRejectedValue(new Error('disk full'));
    const context = createMockCommandContext({
      executionMode: 'acp',
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue(projectRoot),
          getMemoryManager: vi.fn().mockReturnValue({
            buildConsolidationPrompt,
            writeDreamManualRun,
          }),
          getSessionId: vi.fn().mockReturnValue('session-1'),
        },
      },
    });

    const result = await dreamCommand.action?.(context, '');
    expect(result).toEqual({ type: 'submit_prompt', content: 'dream prompt' });
  });
});
