/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type * as core from '@qwen-code/core';
import { entryToListedModel } from '../../../../core/src/test-utils/listed-model.js';
import type { ListedModelEntryFixture } from '../../../../core/src/test-utils/listed-model-entry.js';
import type { ReasoningEffortLevel } from '@qwen-code/core';
import { contextWindowCommand } from './contextWindowCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { ModelOptionsSelector } from '../components/ModelSelector.js';

describe('contextWindowCommand', () => {
  let mockContext: CommandContext;

  const runContextWindowCommand = async (args: string) => {
    if (!contextWindowCommand.action) {
      throw new Error('contextWindowCommand.action is not defined');
    }
    return contextWindowCommand.action(mockContext, args);
  };

  let listedModel: core.Model | undefined;

  const mockCatalogModel = (
    model: Record<string, unknown> | undefined = {
      key: 'glm-5.2',
      display_name: 'GLM-5.2',
      enable: true,
      efforts: [],
      supports_disabled: true,
      available_context_windows: [200_000, 400_000],
      default_context_window: 200_000,
    },
  ) => {
    listedModel = model
      ? entryToListedModel(model as unknown as ListedModelEntryFixture)
      : undefined;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    listedModel = undefined;
    mockContext = createMockCommandContext();
    mockContext.ui.removeComponent = vi.fn();
  });

  it('opens model options focused on context window and applies selected settings', async () => {
    const setModelConfig = vi.fn(() => true);
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => ({
          getModel: async () => listedModel,
          getModelConfig: () => ({
            reasoning: { effort: 'none' },
            context: { contextWindow: 200_000 },
          }),
          setModelConfig,
        }),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        isWorkflowToolAvailable: () => true,
        getUltracode: () => false,
        setUltracode: vi.fn(),
        getModel: () => 'glm-5.2',
      },
    } as unknown as CommandContext['services']['agentContext'];

    const result = await runContextWindowCommand('');

    expect(result?.type).toBe('custom_dialog');
    expect(setModelConfig).not.toHaveBeenCalled();
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom_dialog');
    }

    const dialog = result.component as React.ReactElement<{
      initialFocusKey?: string;
      onSelect: (
        effort: ReasoningEffortLevel | undefined,
        contextWindow: number | undefined,
        ultracode?: boolean,
      ) => Promise<void>;
    }>;
    expect(dialog.type).toBe(ModelOptionsSelector);
    expect(dialog.props.initialFocusKey).toBe('context-window');

    await dialog.props.onSelect(undefined, 400_000);

    expect(setModelConfig.mock.calls).toEqual([
      [listedModel, { reasoning: { effort: undefined } }, true],
      [listedModel, { context: { contextWindow: 400_000 } }, true],
    ]);
    expect(mockContext.ui.removeComponent).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Updated GLM-5.2: thinking effort to default, context window to 400K (persisted)',
        transcriptSubtype: 'local_command_output',
      }),
    );
  });

  it('does not rewrite unchanged generation settings when only context window changes', async () => {
    const setModelConfig = vi.fn(() => true);
    mockCatalogModel({
      key: 'glm-5.2',
      display_name: 'GLM-5.2',
      enable: true,
      efforts: ['high', 'xhigh'],
      supports_disabled: true,
      available_context_windows: [200_000, 400_000],
      default_context_window: 200_000,
    });
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => ({
          getModel: async () => listedModel,
          getModelConfig: () => ({
            reasoning: { effort: 'xhigh' },
            context: { contextWindow: 200_000 },
          }),
          setModelConfig,
        }),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        isWorkflowToolAvailable: () => true,
        getUltracode: () => false,
        setUltracode: vi.fn(),
        getModel: () => 'glm-5.2',
      },
    } as unknown as CommandContext['services']['agentContext'];

    const result = await runContextWindowCommand('');
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom_dialog');
    }
    const dialog = result.component as React.ReactElement<{
      onSelect: (
        effort: ReasoningEffortLevel | undefined,
        contextWindow: number | undefined,
        ultracode?: boolean,
      ) => Promise<void>;
    }>;

    await dialog.props.onSelect('xhigh', 400_000);

    expect(setModelConfig.mock.calls).toEqual([
      [listedModel, { context: { contextWindow: 400_000 } }, true],
    ]);
  });

  it('rejects unexpected arguments', async () => {
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => ({ getModel: async () => listedModel }),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        isWorkflowToolAvailable: () => true,
        getUltracode: () => false,
        getModel: () => 'glm-5.2',
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runContextWindowCommand('400K');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Usage: /context-window [--session-only]',
        transcriptSubtype: 'local_command_output',
      }),
    );
  });
});
