/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import open from 'open';
import { Storage } from '@qwen-code/qwen-code-core';
import { INSIGHT_READY_MARKER, insightCommand } from './insightCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const mockGenerateStaticInsight = vi.fn();

vi.mock('../../services/insight/generators/StaticInsightGenerator.js', () => ({
  StaticInsightGenerator: vi.fn(() => ({
    generateStaticInsight: mockGenerateStaticInsight,
  })),
}));

vi.mock('open', () => ({
  default: vi.fn(),
}));

describe('insightCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    Storage.setRuntimeBaseDir(path.resolve('runtime-output'));
    mockGenerateStaticInsight.mockResolvedValue(
      path.resolve('runtime-output', 'insights', 'insight-2026-03-05.html'),
    );
    vi.mocked(open).mockResolvedValue(undefined as never);

    mockContext = createMockCommandContext({
      services: {
        config: {} as CommandContext['services']['config'],
      },
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
        setDebugMessage: vi.fn(),
      },
    } as unknown as CommandContext);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    vi.restoreAllMocks();
  });

  it('uses runtime base dir to locate projects directory', async () => {
    if (!insightCommand.action) {
      throw new Error('insight command must have action');
    }

    await insightCommand.action(mockContext, '');

    expect(mockGenerateStaticInsight).toHaveBeenCalledWith(
      path.join(Storage.getRuntimeBaseDir(), 'projects'),
      expect.any(Function),
    );
  });

  it('streams ACP progress and report marker without opening the browser', async () => {
    mockGenerateStaticInsight.mockImplementationOnce(
      async (
        _projectsDir: string,
        onProgress?: (stage: string, progress: number, detail?: string) => void,
      ) => {
        onProgress?.('Scanning sessions', 25, 'Analyzing 1/4');
        onProgress?.('Generating personalized insights...', 80);
        return path.resolve(
          'runtime-output',
          'insights',
          'insight-2026-03-05.html',
        );
      },
    );

    const acpContext = createMockCommandContext({
      executionMode: 'acp',
      services: {
        config: {} as CommandContext['services']['config'],
      },
    });

    if (!insightCommand.action) {
      throw new Error('insight command must have action');
    }

    const result = await insightCommand.action(acpContext, '');

    expect(result).toBeDefined();
    expect(result?.type).toBe('stream_messages');

    const messages: Array<{ messageType: string; content: string }> = [];
    if (result?.type === 'stream_messages') {
      for await (const message of result.messages) {
        messages.push(message);
      }
    }

    expect(open).not.toHaveBeenCalled();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageType: 'info',
          content: 'This may take a couple minutes. Sit tight!',
        }),
        expect.objectContaining({
          messageType: 'info',
          content: 'Starting insight generation...',
        }),
        expect.objectContaining({
          messageType: 'info',
          content: expect.stringContaining('Scanning sessions'),
        }),
        expect.objectContaining({
          messageType: 'info',
          content: 'Insight report generated successfully!',
        }),
        expect.objectContaining({
          messageType: 'info',
          content: `${INSIGHT_READY_MARKER}${path.resolve('runtime-output', 'insights', 'insight-2026-03-05.html')}`,
        }),
      ]),
    );
  });
});
