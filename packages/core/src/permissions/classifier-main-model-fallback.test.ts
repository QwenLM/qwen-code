/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';

const { sideQuery } = vi.hoisted(() => ({ sideQuery: vi.fn() }));

vi.mock('../utils/sideQuery.js', () => ({ runSideQuery: sideQuery }));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
}));

import { classifyAction } from './classifier.js';

it('reviews a native fast-classifier deadline with the distinct session model', async () => {
  sideQuery
    .mockImplementationOnce(
      (_config: unknown, options: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          options.abortSignal.addEventListener(
            'abort',
            () => reject(options.abortSignal.reason),
            { once: true },
          );
        }),
    )
    .mockResolvedValueOnce({
      thinking: 'Synthetic independent review.',
      shouldBlock: false,
      reason: '',
    });

  const config = {
    getFastModel: () => 'synthetic-fast',
    getModel: () => 'synthetic-main',
    getAutoModeSettings: () => ({
      classifier: { timeouts: { stage1Ms: 1000, stage2Ms: 2000 } },
    }),
    getToolRegistry: () => ({ getTool: () => undefined }),
  } as unknown as Config;
  const result = await classifyAction({
    toolName: 'run_shell_command',
    toolParams: { command: 'synthetic local marker operation' },
    messages: [],
    config,
    signal: new AbortController().signal,
  });

  expect(result.shouldBlock).toBe(false);
  expect(result.unavailable).not.toBe(true);
  expect(result.stage).toBe('main');
  expect(sideQuery).toHaveBeenCalledTimes(2);
  expect(sideQuery.mock.calls[1]?.[1]).toMatchObject({
    model: 'synthetic-main',
    maxAttempts: 1,
  });
});
