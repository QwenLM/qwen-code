/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { approvalModeCommand } from './approvalModeCommand.js';
import {
  type CommandContext,
  CommandKind,
  type OpenDialogActionReturn,
} from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { LoadedSettings } from '../../config/settings.js';

describe('approvalModeCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getApprovalMode: () => 'default',
          setApprovalMode: () => {},
        },
        settings: {
          merged: {},
          setValue: () => {},
          forScope: () => ({}),
        } as unknown as LoadedSettings,
      },
    });
  });

  it('should have correct metadata', () => {
    expect(approvalModeCommand.name).toBe('approval-mode');
    expect(approvalModeCommand.description).toBe(
      'View or change the approval mode for tool usage',
    );
    expect(approvalModeCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should open approval mode dialog when invoked', async () => {
    const result = (await approvalModeCommand.action?.(
      mockContext,
      '',
    )) as OpenDialogActionReturn;

    expect(result.type).toBe('dialog');
    expect(result.dialog).toBe('approval-mode');
  });

  it('should open approval mode dialog with arguments (ignored)', async () => {
    const result = (await approvalModeCommand.action?.(
      mockContext,
      'some arguments',
    )) as OpenDialogActionReturn;

    expect(result.type).toBe('dialog');
    expect(result.dialog).toBe('approval-mode');
  });

  it('should not have subcommands', () => {
    expect(approvalModeCommand.subCommands).toBeUndefined();
  });

  it('should not have completion function', () => {
    expect(approvalModeCommand.completion).toBeUndefined();
  });
});
