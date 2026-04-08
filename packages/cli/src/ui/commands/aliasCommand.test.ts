/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { aliasCommand } from './aliasCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { CommandKind } from './types.js';

describe('aliasCommand', () => {
  let mockContext: CommandContext;
  const mockModeManager = {
    getAllAliases: vi.fn(),
    getCustomAliases: vi.fn(),
    addAlias: vi.fn(),
    removeAlias: vi.fn(),
    resolveAlias: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = createMockCommandContext({
      ui: {
        addItem: vi.fn(),
      },
      services: {
        config: {
          getModeManager: () => mockModeManager,
        } as unknown as import('@qwen-code/qwen-code-core').Config,
      },
    } as unknown as CommandContext);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should have the correct command properties', () => {
    expect(aliasCommand.name).toBe('alias');
    expect(aliasCommand.altNames).toContain('aliases');
    expect(aliasCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  describe('no args', () => {
    it('should list all aliases', async () => {
      if (!aliasCommand.action) {
        throw new Error('aliasCommand has no action');
      }

      mockModeManager.getAllAliases.mockReturnValue(
        new Map([['dev', 'developer']]),
      );
      mockModeManager.getCustomAliases.mockReturnValue(new Map());

      await aliasCommand.action(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Mode Aliases'),
        }),
        expect.any(Number),
      );
    });
  });

  describe('/alias list', () => {
    it('should list all aliases', async () => {
      if (!aliasCommand.action) {
        throw new Error('aliasCommand has no action');
      }

      mockModeManager.getAllAliases.mockReturnValue(
        new Map([['dev', 'developer']]),
      );

      await aliasCommand.action(mockContext, 'list');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
        }),
        expect.any(Number),
      );
    });
  });

  describe('/alias add', () => {
    it('should add a custom alias', async () => {
      if (!aliasCommand.action) {
        throw new Error('aliasCommand has no action');
      }

      mockModeManager.addAlias.mockReturnValue(true);

      await aliasCommand.action(mockContext, 'add my-dev developer');

      expect(mockModeManager.addAlias).toHaveBeenCalledWith(
        'my-dev',
        'developer',
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Added alias'),
        }),
        expect.any(Number),
      );
    });

    it('should show error for non-existent target mode', async () => {
      if (!aliasCommand.action) {
        throw new Error('aliasCommand has no action');
      }

      mockModeManager.addAlias.mockReturnValue(false);

      await aliasCommand.action(mockContext, 'add bad nonexistent');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('does not exist'),
        }),
        expect.any(Number),
      );
    });
  });

  describe('/alias remove', () => {
    it('should remove a custom alias', async () => {
      if (!aliasCommand.action) {
        throw new Error('aliasCommand has no action');
      }

      mockModeManager.removeAlias.mockReturnValue(true);

      await aliasCommand.action(mockContext, 'remove my-dev');

      expect(mockModeManager.removeAlias).toHaveBeenCalledWith('my-dev');
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Removed alias'),
        }),
        expect.any(Number),
      );
    });

    it('should not allow removing built-in aliases', async () => {
      if (!aliasCommand.action) {
        throw new Error('aliasCommand has no action');
      }

      mockModeManager.removeAlias.mockReturnValue(false);
      mockModeManager.getAllAliases.mockReturnValue(
        new Map([['dev', 'developer']]),
      );

      await aliasCommand.action(mockContext, 'remove dev');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Cannot remove built-in'),
        }),
        expect.any(Number),
      );
    });
  });

  describe('/alias show', () => {
    it('should show what an alias resolves to', async () => {
      if (!aliasCommand.action) {
        throw new Error('aliasCommand has no action');
      }

      mockModeManager.resolveAlias.mockReturnValue('developer');
      mockModeManager.getAllAliases.mockReturnValue(
        new Map([['dev', 'developer']]),
      );

      await aliasCommand.action(mockContext, 'show dev');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('developer'),
        }),
        expect.any(Number),
      );
    });
  });
});
