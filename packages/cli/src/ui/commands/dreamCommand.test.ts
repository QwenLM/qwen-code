/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import { dreamCommand } from './dreamCommand.js';
import {
  MANUAL_DREAM_TOOL_GUARD_MARKER,
  recoverManualDreamToolInvocationGuard,
} from '../../utils/tool-invocation-guards.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('dreamCommand', () => {
  it('supports interactive, headless, and ACP execution', () => {
    expect(dreamCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
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
      content: [
        { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
        { text: 'dream prompt' },
      ],
      onComplete: expect.any(Function),
      toolInvocationGuard: expect.any(Function),
    });
    expect(buildConsolidationPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expectedTranscriptDir,
    );
    // In interactive mode, writeDreamManualRun is deferred to onComplete
    expect(writeDreamManualRun).not.toHaveBeenCalled();
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
    expect(result).toEqual({
      type: 'submit_prompt',
      content: [
        { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
        { text: 'dream prompt' },
      ],
      toolInvocationGuard: expect.any(Function),
    });
    expect(result).not.toHaveProperty('onComplete');
  });

  it('defers writeDreamManualRun until a headless turn completes', async () => {
    const projectRoot = path.join('tmp', 'dream-project');
    const buildConsolidationPrompt = vi.fn().mockReturnValue('dream prompt');
    const writeDreamManualRun = vi.fn();
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
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
    expect(writeDreamManualRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: [
        { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
        { text: 'dream prompt' },
      ],
      onComplete: expect.any(Function),
      toolInvocationGuard: expect.any(Function),
    });
    if (result?.type === 'submit_prompt') {
      await result.onComplete?.();
    }
    expect(writeDreamManualRun).toHaveBeenCalledWith(projectRoot, 'session-1');
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
    expect(result).toEqual({
      type: 'submit_prompt',
      content: [
        { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
        { text: 'dream prompt' },
      ],
      toolInvocationGuard: expect.any(Function),
    });
  });

  it('recovers the guard from explicit provenance despite surrounding context', () => {
    const config = {
      getProjectRoot: vi
        .fn()
        .mockReturnValue(path.join('tmp', 'dream-project')),
    };

    expect(
      recoverManualDreamToolInvocationGuard(config as never, [
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\nToday is tomorrow\n</system-reminder>',
            },
            { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
            { text: 'dream prompt plus hook context' },
          ],
        },
      ]),
    ).toEqual(expect.any(Function));
    expect(
      recoverManualDreamToolInvocationGuard(config as never, [
        {
          role: 'user',
          parts: [{ text: 'dream prompt plus hook context' }],
        },
      ]),
    ).toBeUndefined();
  });

  it('recovers the owning dream policy through a tool-result chain only', () => {
    const config = {
      getProjectRoot: vi
        .fn()
        .mockReturnValue(path.join('tmp', 'dream-project')),
    };
    const dreamToolHistory = [
      {
        role: 'user' as const,
        parts: [
          { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
          { text: 'dream prompt' },
        ],
      },
      {
        role: 'model' as const,
        parts: [
          { functionCall: { id: 'read-1', name: 'read_file', args: {} } },
        ],
      },
      {
        role: 'user' as const,
        parts: [
          {
            functionResponse: {
              id: 'read-1',
              name: 'read_file',
              response: { output: 'memory' },
            },
          },
        ],
      },
      {
        role: 'model' as const,
        parts: [
          { functionCall: { id: 'write-1', name: 'write_file', args: {} } },
        ],
      },
    ];

    expect(
      recoverManualDreamToolInvocationGuard(config as never, dreamToolHistory),
    ).toEqual(expect.any(Function));
    expect(
      recoverManualDreamToolInvocationGuard(config as never, [
        ...dreamToolHistory.slice(0, 2),
        { role: 'model', parts: [{ text: 'dream complete' }] },
        { role: 'user', parts: [{ text: 'ordinary new prompt' }] },
        dreamToolHistory.at(-1)!,
      ]),
    ).toBeUndefined();
  });
});
