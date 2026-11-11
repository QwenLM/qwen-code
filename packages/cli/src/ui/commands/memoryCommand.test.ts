/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect } from 'vitest';
import { memoryCommand } from './memoryCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { LoadedSettings } from '../../config/settings.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...original,
    getErrorMessage: vi.fn((error: unknown) => {
      if (error instanceof Error) return error.message;
      return String(error);
    }),
  };
});

describe('memoryCommand', () => {
  let mockContext: CommandContext;

  describe('default action', () => {
    it('should open the MemoryOverview dialog when no args provided', async () => {
      mockContext = createMockCommandContext({
        services: {
          agentContext: {
            config: {
              isAutoMemoryEnabled: () => false,
            },
          },
          settings: {} as unknown as LoadedSettings,
        },
      });

      const result = await memoryCommand.action!(mockContext, '');

      expect(result).toEqual(
        expect.objectContaining({
          type: 'custom_dialog',
        }),
      );
    });
  });

  it('exposes only the manage subcommand (reload removed)', () => {
    const names = (memoryCommand.subCommands ?? []).map((c) => c.name);
    expect(names).toEqual(['manage']);
    expect(memoryCommand.requiredStartupGates).toEqual(['memory']);
    expect(memoryCommand.subCommands?.[0]?.requiredStartupGates).toEqual([
      'memory',
    ]);
  });
});
