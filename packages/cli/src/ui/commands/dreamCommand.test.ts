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

  it('defers writeDreamManualRun to onComplete in ACP mode (no eager write)', async () => {
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
    // ACP fires onComplete via Session.ts's pendingSlashOnComplete, so the run
    // is recorded only after the turn succeeds — never eagerly.
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'dream prompt',
      onComplete: expect.any(Function),
    });
    expect(writeDreamManualRun).not.toHaveBeenCalled();
  });

  it('does not record a dream run in ACP mode when the turn is cancelled', async () => {
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
    if (!result || result.type !== 'submit_prompt' || !result.onComplete) {
      throw new Error('expected a submit_prompt result with onComplete');
    }
    await result.onComplete({ cancelled: true });
    expect(writeDreamManualRun).not.toHaveBeenCalled();
  });

  function setupOnComplete() {
    const writeDreamManualRun = vi.fn();
    const context = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue(path.join('tmp', 'dream')),
          getMemoryManager: vi.fn().mockReturnValue({
            buildConsolidationPrompt: vi.fn().mockReturnValue('dream prompt'),
            writeDreamManualRun,
          }),
          getSessionId: vi.fn().mockReturnValue('session-1'),
        },
      },
    });
    return { context, writeDreamManualRun };
  }

  it('records a manual dream run when the turn succeeds', async () => {
    const { context, writeDreamManualRun } = setupOnComplete();
    const result = await dreamCommand.action?.(context, '');
    if (!result || result.type !== 'submit_prompt' || !result.onComplete) {
      throw new Error('expected a submit_prompt result with onComplete');
    }
    await result.onComplete();
    expect(writeDreamManualRun).toHaveBeenCalledTimes(1);
  });

  it('does not record a dream run when the turn errored', async () => {
    const { context, writeDreamManualRun } = setupOnComplete();
    const result = await dreamCommand.action?.(context, '');
    if (!result || result.type !== 'submit_prompt' || !result.onComplete) {
      throw new Error('expected a submit_prompt result with onComplete');
    }
    await result.onComplete({ errored: true });
    expect(writeDreamManualRun).not.toHaveBeenCalled();
  });
});
