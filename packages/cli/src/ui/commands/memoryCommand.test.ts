/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { describe, expect, it, vi } from 'vitest';
import { memoryCommand } from './memoryCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('memoryCommand', () => {
  it('opens the memory dialog in interactive mode', async () => {
    const context = createMockCommandContext({
      executionMode: 'interactive',
    });

    const result = await memoryCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'memory',
    });
  });

  it('advertises the explicit team migration subcommand', () => {
    expect(memoryCommand.argumentHint).toBe('[migrate-team]');
  });

  it('starts team migration only from the explicit subcommand', async () => {
    const scheduleMetadataMigration = vi.fn().mockResolvedValue({
      status: 'scheduled',
      taskId: 'migration-1',
    });
    const config = {
      getTeamMemoryEnabled: vi.fn().mockReturnValue(true),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getProjectRoot: vi.fn().mockReturnValue('/project'),
      getMemoryManager: vi.fn().mockReturnValue({
        scheduleMetadataMigration,
      }),
    } as unknown as Config;
    const context = createMockCommandContext({
      executionMode: 'interactive',
      services: { config },
    });

    const result = await memoryCommand.action?.(context, 'migrate-team');

    expect(scheduleMetadataMigration).toHaveBeenCalledWith({
      projectRoot: '/project',
      scope: 'team',
      config,
    });
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
  });
});
