/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { dreamCommand } from './dreamCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { runManagedAutoMemoryDream } from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    runManagedAutoMemoryDream: vi.fn(),
  };
});

describe('dreamCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an error when config is unavailable', async () => {
    const context = createMockCommandContext({ services: { config: null } });
    const result = await dreamCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  it('runs managed auto-memory dream and returns the summary', async () => {
    vi.mocked(runManagedAutoMemoryDream).mockResolvedValue({
      touchedTopics: ['user'],
      dedupedEntries: 2,
      systemMessage: 'Managed auto-memory dream updated: user.md',
    });
    const context = createMockCommandContext({
      services: { config: { getProjectRoot: vi.fn().mockReturnValue('/test/project') } as never },
    });

    const result = await dreamCommand.action?.(context, '');

    expect(runManagedAutoMemoryDream).toHaveBeenCalledWith('/test/project');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Managed auto-memory dream updated: user.md\nDeduplicated entries: 2',
    });
  });
});