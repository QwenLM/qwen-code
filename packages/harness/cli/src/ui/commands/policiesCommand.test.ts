/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { policiesCommand } from './policiesCommand.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  type Config,
  AutoClassifier,
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '@qwen-code/core';

/**
 * The dialog is handed the session's permission module and the session's auto
 * mode, so a config stub has to carry both. Only the two rule readers are
 * reached before the dialog renders; the classifier is there so the stub is
 * honest about what the component receives.
 */
function permissionStub() {
  return {
    autoClassifier: new AutoClassifier(),
    getRules: () => ({ allow: {}, deny: {}, ask: {} }),
    getAdditionalDirectories: () => [],
  };
}

describe('policiesCommand (now /permissions)', () => {
  let mockContext: ReturnType<typeof createMockCommandContext>;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should have correct command definition', () => {
    expect(policiesCommand.name).toBe('permissions');
    expect(policiesCommand.description).toBe('Manage permissions');
    expect(policiesCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(policiesCommand.subCommands).toHaveLength(1);
    expect(policiesCommand.subCommands![0].name).toBe('list');
  });

  describe('list subcommand', () => {
    it('should show error if config is missing', async () => {
      mockContext.services.agentContext = null;
      const listCommand = policiesCommand.subCommands![0];

      await listCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: 'Error: Config not available.',
        }),
        expect.any(Number),
      );
    });

    it('should return custom_dialog with PermissionRuleList when rules exist', async () => {
      mockContext.services.agentContext = {
        getFolderTrust: vi.fn().mockReturnValue(true),
        permission: permissionStub(),
        get config() {
          return this;
        },
      } as unknown as Config;

      const listCommand = policiesCommand.subCommands![0];
      const result = await listCommand.action!(mockContext, '');

      expect(result).toMatchObject({ type: 'custom_dialog' });
      expect((result as { component: unknown }).component).toBeDefined();
    });

    it('should return custom_dialog even when no rules exist', async () => {
      mockContext.services.agentContext = {
        getFolderTrust: vi.fn().mockReturnValue(false),
        permission: permissionStub(),
        get config() {
          return this;
        },
      } as unknown as Config;

      const listCommand = policiesCommand.subCommands![0];
      const result = await listCommand.action!(mockContext, '');

      // Even with empty rules, we show the interactive panel (with "No active policies" message)
      expect(result).toMatchObject({ type: 'custom_dialog' });
    });

    it('queues a retry the auto-mode review reads as the user deciding', async () => {
      clearCommandQueue();
      mockContext.services.agentContext = {
        getFolderTrust: vi.fn().mockReturnValue(true),
        permission: permissionStub(),
        get config() {
          return this;
        },
      } as unknown as Config;

      const result = await policiesCommand.subCommands![0].action!(
        mockContext,
        '',
      );
      const { onRetryDenials } = (
        result as {
          component: { props: { onRetryDenials(commands: string[]): void } };
        }
      ).component.props;
      onRetryDenials(['rm -rf build']);

      expect(getCommandQueueSnapshot()).toEqual([
        expect.objectContaining({ isMeta: true, isUserDecision: true }),
      ]);
      clearCommandQueue();
    });
  });
});
