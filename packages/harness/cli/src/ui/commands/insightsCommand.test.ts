/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { generateInsights } from '@qwen-code/core';
import { insightsCommand } from './insightsCommand.js';
import type { CommandContext } from './types.js';

vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/core')>()),
  generateInsights: vi.fn(),
}));

function makeContext(workingDir: string): CommandContext {
  return {
    services: {
      agentContext: {
        config: {
          getWorkingDir: () => workingDir,
          getSessionArtifactProjectRoot: () => '/repo',
        },
      },
    },
    ui: {
      registerCancellable: () => vi.fn(),
      setPendingItem: vi.fn(),
      addItem: vi.fn(),
    },
  } as unknown as CommandContext;
}

describe('insightsCommand', () => {
  it.each(['/repo', '/repo/.qwen/worktrees/feature'])(
    'scans the original project history when running in %s',
    async (workingDir) => {
      // 在扫描接口边界停止，避免测试发起模型请求或打开报告浏览器。
      vi.mocked(generateInsights).mockRejectedValueOnce(
        new Error('Stop before generating the report'),
      );
      const context = makeContext(workingDir);

      await insightsCommand.action!(context, '');

      expect(generateInsights).toHaveBeenLastCalledWith(
        expect.objectContaining({ cwd: '/repo' }),
      );
    },
  );

  it('reports the generated report path', async () => {
    vi.mocked(generateInsights).mockResolvedValueOnce({
      htmlPath: '/repo/.qwen/usage-data/report.html',
    } as never);
    const context = makeContext('/repo');

    await insightsCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Insights report generated:'),
      }),
      expect.any(Number),
    );
  });

  it('surfaces generation failures as an error item', async () => {
    vi.mocked(generateInsights).mockRejectedValueOnce(
      new Error('No sessions found'),
    );
    const context = makeContext('/repo');

    await insightsCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: 'Insights generation failed: No sessions found',
      }),
      expect.any(Number),
    );
  });

  it('returns an error message when there is no agent context', async () => {
    vi.mocked(generateInsights).mockClear();
    const context = {
      services: {},
      ui: { registerCancellable: vi.fn(), setPendingItem: vi.fn(), addItem: vi.fn() },
    } as unknown as CommandContext;

    await expect(insightsCommand.action!(context, '')).resolves.toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Agent context is not available.',
    });
    expect(generateInsights).not.toHaveBeenCalled();
  });
});
