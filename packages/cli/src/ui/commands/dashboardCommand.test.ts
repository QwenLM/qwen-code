/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { CommandKind } from './types.js';

// Mock the core module
vi.mock('@qwen-code/qwen-code-core', () => ({
  ParallelTaskRunner: class {
    constructor(_config: unknown) {}
    getActiveGroups() {
      return new Map();
    }
  },
}));

// Import after mocking
const { dashboardCommand } = await import('./dashboardCommand.js');

describe('dashboardCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      ui: {
        addItem: vi.fn(),
      },
    } as unknown as CommandContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('command properties', () => {
    it('should have the correct name', () => {
      expect(dashboardCommand.name).toBe('dashboard');
    });

    it('should have altNames', () => {
      expect(dashboardCommand.altNames).toContain('dash');
    });

    it('should have correct kind', () => {
      expect(dashboardCommand.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should have a description', () => {
      expect(dashboardCommand.description).toBeTruthy();
    });
  });

  describe('main action', () => {
    it('should show dashboard when run with no args', async () => {
      if (!dashboardCommand.action) {
        throw new Error('Dashboard command has no action');
      }

      await dashboardCommand.action(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('**📊 Mode Dashboard**'),
        }),
        expect.any(Number),
      );
    });

    it('should show dashboard with refresh arg', async () => {
      if (!dashboardCommand.action) {
        throw new Error('Dashboard command has no action');
      }

      await dashboardCommand.action(mockContext, 'refresh');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('**📊 Mode Dashboard**'),
        }),
        expect.any(Number),
      );
    });
  });

  describe('subCommands', () => {
    describe('refresh subcommand', () => {
      it('should refresh the dashboard display', async () => {
        const refreshCmd = dashboardCommand.subCommands?.find(
          (sc) => sc.name === 'refresh',
        );
        if (!refreshCmd?.action) {
          throw new Error('Refresh subcommand has no action');
        }

        await refreshCmd.action(mockContext, '');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.TEXT,
            text: expect.stringContaining('**📊 Mode Dashboard**'),
          }),
          expect.any(Number),
        );
      });
    });

    describe('modes subcommand', () => {
      it('should show mode statistics when config is available', async () => {
        const modesCmd = dashboardCommand.subCommands?.find(
          (sc) => sc.name === 'modes',
        );
        if (!modesCmd?.action) {
          throw new Error('Modes subcommand has no action');
        }

        // With null config, it should show "Config not available"
        await modesCmd.action(mockContext, '');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.TEXT,
            text: expect.stringContaining('Config not available'),
          }),
          expect.any(Number),
        );
      });
    });

    describe('tasks subcommand', () => {
      it('should show parallel task status', async () => {
        const tasksCmd = dashboardCommand.subCommands?.find(
          (sc) => sc.name === 'tasks',
        );
        if (!tasksCmd?.action) {
          throw new Error('Tasks subcommand has no action');
        }

        await tasksCmd.action(mockContext, '');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.TEXT,
            text: expect.stringContaining('**Parallel Tasks**'),
          }),
          expect.any(Number),
        );
      });
    });
  });
});
