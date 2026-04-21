/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from './types.js';
import { selfEvolveCommand } from './selfEvolveCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { SelfEvolveService } from '../../services/SelfEvolveService.js';

vi.mock('../../services/SelfEvolveService.js', () => ({
  SelfEvolveService: vi.fn(),
}));

describe('selfEvolveCommand', () => {
  let mockContext: CommandContext;
  const mockRun = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SelfEvolveService).mockImplementation(
      () =>
        ({
          run: mockRun,
        }) as unknown as SelfEvolveService,
    );
    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      services: {
        config: {
          getProjectRoot: () => '/repo',
        },
      },
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);
  });

  it('returns usage error when called with arguments', async () => {
    const result = await selfEvolveCommand.action!(mockContext, 'extra');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /self-evolve',
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs the service and emits an interactive success message', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      attemptId: 'attempt-1',
      recordPath: '/tmp/result.json',
      branch: 'self-evolve/review',
      commitSha: 'abc123',
      summary: 'Prepared a small improvement.',
      selectedTask: 'Fix lint error in src/file.ts:10:2',
      validation: ['pass: npm run lint'],
      changedFiles: ['src/file.ts'],
    });

    await selfEvolveCommand.action!(mockContext, '');

    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Running self-evolve in an isolated worktree...',
      }),
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Commit: abc123'),
      }),
      expect.any(Number),
    );
    expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
  });

  it('returns a message in non-interactive mode', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {
          getProjectRoot: () => '/repo',
        },
      },
    } as unknown as CommandContext);

    mockRun.mockResolvedValue({
      ok: false,
      attemptId: 'attempt-2',
      recordPath: '/tmp/result.json',
      summary: 'No safe task was selected.',
      selectedTask: 'Address TODO in src/file.ts:10',
      validation: [],
      learnings: ['Candidate list was too risky.'],
    });

    const result = await selfEvolveCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Learnings: Candidate list was too risky.'),
    });
  });
});
