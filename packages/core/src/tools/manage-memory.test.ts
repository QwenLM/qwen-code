/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { refreshMemoryInstruction } from '../memory/refresh.js';
import { runManagedRememberByAgent } from '../memory/remember.js';
import { ManageMemoryTool } from './manage-memory.js';

vi.mock('../memory/refresh.js', () => ({
  refreshMemoryInstruction: vi.fn(),
}));

vi.mock('../memory/remember.js', () => ({
  runManagedRememberByAgent: vi.fn(),
}));

function createConfig() {
  const forget = vi.fn();
  const config = {
    getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
    getProjectRoot: vi.fn().mockReturnValue('/tmp/project'),
    getMemoryManager: vi.fn().mockReturnValue({ forget }),
  } as unknown as Config;
  return { config, forget };
}

describe('ManageMemoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a compact explicit maintenance contract', () => {
    const { config } = createConfig();
    const tool = new ManageMemoryTool(config);

    expect(tool.shouldDefer).toBe(false);
    expect(tool.schema.description).toContain('when the user asks');
    expect(tool.schema.description).toContain('Never save information merely');
    expect(JSON.stringify(tool.schema).length).toBeLessThanOrEqual(900);
    expect(tool.validateToolParams({ action: 'remember', content: '  ' })).toBe(
      'content must not be empty.',
    );
  });

  it('rejects stale calls while the legacy protocol is active', async () => {
    const { config, forget } = createConfig();
    vi.mocked(config.getMemoryRecallMode).mockReturnValue('legacy');

    const result = await new ManageMemoryTool(config)
      .build({ action: 'forget', content: 'old fact' })
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe('execution_denied');
    expect(runManagedRememberByAgent).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it('delegates creates and updates to the full-protocol remember agent', async () => {
    const { config } = createConfig();
    vi.mocked(runManagedRememberByAgent).mockResolvedValue({
      summary: 'Memory update completed.',
      filesTouched: ['/tmp/memory/user/preference.md'],
      touchedScopes: ['user'],
    });

    const result = await new ManageMemoryTool(config)
      .build({ action: 'remember', content: '  Prefer branch explanations.  ' })
      .execute(new AbortController().signal);

    expect(runManagedRememberByAgent).toHaveBeenCalledWith({
      config,
      projectRoot: '/tmp/project',
      content: 'Prefer branch explanations.',
      contextMode: 'clean',
      abortSignal: expect.any(AbortSignal),
    });
    expect(refreshMemoryInstruction).toHaveBeenCalledWith(config, {
      logContext: 'manage_memory remember',
    });
    expect(JSON.parse(String(result.llmContent))).toEqual({
      action: 'remember',
      updated: 1,
      touchedScopes: ['user'],
    });
  });

  it('delegates forget to MemoryManager and refreshes changed memory', async () => {
    const { config, forget } = createConfig();
    forget.mockResolvedValue({
      removedEntries: [{ summary: 'old fact' }],
      touchedScopes: ['project'],
    });

    const result = await new ManageMemoryTool(config)
      .build({ action: 'forget', content: 'old fact' })
      .execute(new AbortController().signal);

    expect(forget).toHaveBeenCalledWith('/tmp/project', 'old fact', {
      config,
      abortSignal: expect.any(AbortSignal),
    });
    expect(refreshMemoryInstruction).toHaveBeenCalledWith(config, {
      logContext: 'manage_memory forget',
    });
    expect(JSON.parse(String(result.llmContent))).toEqual({
      action: 'forget',
      removed: 1,
      touchedScopes: ['project'],
    });
  });

  it('does not refresh the tree for a no-op', async () => {
    const { config, forget } = createConfig();
    forget.mockResolvedValue({ removedEntries: [], touchedScopes: [] });

    await new ManageMemoryTool(config)
      .build({ action: 'forget', content: 'missing fact' })
      .execute(new AbortController().signal);

    expect(refreshMemoryInstruction).not.toHaveBeenCalled();
  });
});
