/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { hooksCommand } from './hooksCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('hooksCommand', () => {
  let mockContext: ReturnType<typeof createMockCommandContext>;
  let mockConfig: {
    getHookSystem: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock config with hook system
    mockConfig = {
      getHookSystem: vi.fn().mockReturnValue({
        getRegistry: vi.fn().mockReturnValue({
          getAllHooks: vi.fn().mockReturnValue([]),
        }),
      }),
    };

    mockContext = createMockCommandContext({
      services: {
        config: mockConfig,
      },
    });
  });

  describe('basic functionality', () => {
    it('should open hooks management dialog in interactive mode', async () => {
      const result = await hooksCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
    });

    it('should open hooks management dialog even if config is not available', async () => {
      const contextWithoutConfig = createMockCommandContext({
        services: {
          config: null,
        },
      });

      const result = await hooksCommand.action!(contextWithoutConfig, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
    });

    it('should open hooks management dialog even if hook system is not available', async () => {
      mockConfig.getHookSystem = vi.fn().mockReturnValue(null);

      const result = await hooksCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
    });
  });
});
