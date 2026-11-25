/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionModelInfo } from '../../session/sessionModels.js';
import type { SessionHandle } from '../../session/session.js';
import {
  getPreferredContextWindow,
  getPreferredReasoningEffort,
} from '../../utils/modelPreference.js';
import { sessionModelToOptionsModel } from './modelOptionsCommandUtils.js';
import { createSessionConfig } from '../session/sessionConfig.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type React from 'react';
import type * as core from '@qwen-code/core';
import { entryToListedModel } from '../../../../core/src/test-utils/listed-model.js';
import type { ListedModelEntryFixture } from '../../../../core/src/test-utils/listed-model-entry.js';
import type { ReasoningEffortLevel } from '@qwen-code/core';
import { effortCommand } from './effortCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { ModelOptionsSelector } from '../components/ModelSelector.js';

describe('effortCommand', () => {
  let mockContext: CommandContext;
  let controllerFixture: {
    setModel?: SessionHandle['setModel'];
    applySettings?: SessionHandle['applySettings'];
    getAvailableModels?: () => SessionModelInfo[];
  } | undefined;

  const runEffortCommand = async (args: string) => {
    const fixture = controllerFixture;
    if (fixture?.setModel) {
      const config = mockContext.services.agentContext?.config;
      const entry = fixture
        .getAvailableModels?.()
        .find((model) => model.modelId === config?.getModel());
      const preferenceModel = entry
        ? sessionModelToOptionsModel(entry).preferenceModel
        : listedModel;
      const reasoningEffort = config
        ? getPreferredReasoningEffort(config, preferenceModel)
        : undefined;
      const contextWindow = config
        ? getPreferredContextWindow(config, preferenceModel)
        : undefined;
      mockContext.services.sessionHandle = {
        getState: () => ({
          model: config?.getModel(),
          reasoningEffort,
          contextWindow,
          models: fixture.getAvailableModels?.() ?? [],
          access: {
            status: 'connected',
            sessionId: 'session-test',
            error: null,
          },
        }),
        setModel: vi.fn(
          async (
            ...args: Parameters<NonNullable<typeof fixture.setModel>>
          ) => {
            await fixture.setModel!(...args);
          },
        ),
        applySettings:
          fixture.applySettings ??
          vi.fn(async () => {
            throw new TypeError('Session settings are not supported');
          }),
      } as unknown as SessionHandle;
      const session = mockContext.services.sessionHandle;
      mockContext.services.agentContext = createSessionConfig(
        config!,
        {
          current: {
            session,
            settings: {
              model: config?.getModel() ?? '',
              reasoningEffort,
              contextWindow,
              permissionMode: config?.getPermissionMode?.() ?? 'default',
            },
          },
        },
        (text) => mockContext.ui.addItem({ type: MessageType.ERROR, text }),
      );
      controllerFixture = undefined;
    }
    if (!effortCommand.action) {
      throw new Error('effortCommand.action is not defined');
    }
    return effortCommand.action(mockContext, args);
  };

  let listedModel: core.Model | undefined;
  const setModelConfig = vi.fn(() => true);
  const modelManager = (
    effort?: ReasoningEffortLevel,
    contextWindow?: number,
  ) => ({
    getModel: async () => listedModel,
    getModelConfig: () => ({
      reasoning: { effort },
      context: { contextWindow },
    }),
    setModelConfig,
  });

  const mockCatalogModel = (
    model: Record<string, unknown> | undefined = {
      key: 'ultimate',
      display_name: 'Ultimate',
      enable: true,
      efforts: ['low', 'high', 'xhigh'],
    },
  ) => {
    listedModel = model
      ? entryToListedModel(model as unknown as ListedModelEntryFixture)
      : undefined;
  };

  beforeEach(() => {
    controllerFixture = undefined;
    vi.restoreAllMocks();
    listedModel = undefined;
    setModelConfig.mockClear();
    mockContext = createMockCommandContext();
    mockContext.ui.removeComponent = vi.fn();
  });

  it('sets local reasoning effort for the current model', async () => {
    const setUltracode = vi.fn();
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('high');

    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: 'high' } },
      true,
    );
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Reasoning effort set to high for Ultimate (persisted)',
        transcriptSubtype: 'local_command_output',
      }),
    );
  });

  it('sets local reasoning effort for this session only', async () => {
    const setUltracode = vi.fn();
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('xhigh --session-only');

    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: 'xhigh' } },
      false,
    );
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Reasoning effort set to xhigh for Ultimate (this session only)',
      }),
    );
  });

  it('enables UltraCode as xhigh session-only state', async () => {
    const setUltracode = vi.fn();
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        setUltracode,
        isWorkflowToolAvailable: () => true,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('ultracode');

    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: 'xhigh' } },
      undefined,
    );
    expect(setUltracode).toHaveBeenCalledWith(true);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'UltraCode enabled for Ultimate (xhigh + dynamic workflow orchestration; this session only)',
      }),
    );
  });

  it('does not partially enable UltraCode when Workflow is unavailable', async () => {
    const setUltracode = vi.fn();
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        setUltracode,
        isWorkflowToolAvailable: () => false,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('ultracode');

    expect(setModelConfig).not.toHaveBeenCalled();
    expect(setUltracode).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('Workflow tool is not enabled'),
      }),
    );
  });

  it('normalizes disabled aliases to none when supported', async () => {
    mockCatalogModel({
      key: 'ultimate',
      display_name: 'Ultimate',
      enable: true,
      efforts: ['high'],
      supports_disabled: true,
    });
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('off');

    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: 'none' } },
      true,
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Reasoning effort set to disabled for Ultimate (persisted)',
      }),
    );
  });

  it('resets local reasoning effort to the model default with auto', async () => {
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('high'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('auto');

    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: undefined } },
      true,
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Reasoning effort set to default for Ultimate (persisted)',
      }),
    );
  });

  it('opens model options focused on reasoning effort when no argument is provided', async () => {
    const setUltracode = vi.fn();
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('low'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        getUltracode: () => false,
        isWorkflowToolAvailable: () => true,
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    const result = await runEffortCommand('');

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
    expect(dialog.props.initialFocusKey).toBe('effort');
    await dialog.props.onSelect('high', 200_000);

    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: 'high' } },
      true,
    );
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { context: { contextWindow: 200_000 } },
      true,
    );
    expect(mockContext.ui.removeComponent).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Updated Ultimate: thinking effort to high (persisted)',
      }),
    );
  });

  it('shows the active UltraCode state before opening model options', async () => {
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('xhigh'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        getUltracode: () => true,
        isWorkflowToolAvailable: () => true,
      },
    } as unknown as CommandContext['services']['agentContext'];

    const result = await runEffortCommand('');

    expect(result?.type).toBe('custom_dialog');
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Current effort: UltraCode'),
      }),
    );
  });

  it('exits UltraCode when the effort panel reapplies xhigh', async () => {
    const setUltracode = vi.fn();
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('xhigh'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        getUltracode: () => true,
        isWorkflowToolAvailable: () => true,
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    const result = await runEffortCommand('');
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

    await dialog.props.onSelect('xhigh', undefined, false);

    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: 'xhigh' } },
      true,
    );
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Updated Ultimate: thinking effort to xhigh (persisted; UltraCode off for this session)',
      }),
    );
  });

  it('opens model options instead of erroring when the current model has no reasoning effort row', async () => {
    mockCatalogModel({
      key: 'kmodel',
      display_name: 'Kimi-K2.7-Code',
      enable: true,
      efforts: [],
      available_context_windows: [200_000, 400_000],
      default_context_window: 200_000,
    });
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'kmodel',
        getUltracode: () => false,
        isWorkflowToolAvailable: () => true,
      },
    } as unknown as CommandContext['services']['agentContext'];

    const result = await runEffortCommand('');

    expect(result?.type).toBe('custom_dialog');
    expect(mockContext.ui.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('does not support reasoning effort'),
      }),
    );
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom_dialog');
    }
    const dialog = result.component as React.ReactElement<{
      initialFocusKey?: string;
    }>;
    expect(dialog.type).toBe(ModelOptionsSelector);
    expect(dialog.props.initialFocusKey).toBe('effort');
  });

  it('rejects efforts unsupported by the current model metadata', async () => {
    mockCatalogModel({
      key: 'flash',
      display_name: 'Flash',
      enable: true,
      efforts: ['low'],
    });
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'flash',
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('high');

    expect(setModelConfig).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Current model "Flash" does not support reasoning effort "high". Supported efforts: low',
        transcriptSubtype: 'local_command_output',
      }),
    );
  });

  it('uses remote setModelAsync while preserving the current context window', async () => {
    const setModelAsync = vi.fn().mockResolvedValue(undefined);
    const applyFlagSettingsAsync = vi.fn().mockResolvedValue(undefined);
    const setUltracode = vi.fn();
    controllerFixture = {
      setModel: setModelAsync,
      applySettings: applyFlagSettingsAsync,
      getAvailableModels: () => [
        {
          modelId: 'ultimate',
          displayName: 'Ultimate',
          source: 'system',
          efforts: ['low', 'high'],
        },
      ],
    };
    const manager = {
      ...modelManager(undefined, 400_000),
      getModel: vi.fn(async () => undefined),
      getModelConfig: vi.fn(() => ({ context: { contextWindow: 400_000 } })),
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => manager,
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        getUltracode: () => true,
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('high');

    expect(setModelAsync).toHaveBeenCalledWith('ultimate', 'high', 400_000);
    expect(manager.getModel).not.toHaveBeenCalled();
    expect(manager.getModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'ultimate',
        source: 'qoder',
        capabilities: expect.objectContaining({
          reasoning: { supported: true, supportedEfforts: ['low', 'high'] },
        }),
      }),
    );
    expect(applyFlagSettingsAsync).toHaveBeenCalledWith({
      ultracode: false,
    });
    expect(applyFlagSettingsAsync.mock.invocationCallOrder[0]).toBeLessThan(
      setModelAsync.mock.invocationCallOrder[0],
    );
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Changes apply to this session only; reasoning effort set to high for Ultimate (this session only)',
      }),
    );
  });

  it('does not send UltraCode control for an ordinary remote effort change', async () => {
    const setModelAsync = vi.fn().mockResolvedValue(undefined);
    const applyFlagSettingsAsync = vi.fn();
    controllerFixture = {
      setModel: setModelAsync,
      applySettings: applyFlagSettingsAsync,
      getAvailableModels: () => [
        {
          modelId: 'ultimate',
          displayName: 'Ultimate',
          source: 'system',
          efforts: ['low', 'high'],
        },
      ],
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('low'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        isWorkflowToolAvailable: () => true,
        getUltracode: () => false,
        setUltracode: vi.fn(),
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('high');

    expect(applyFlagSettingsAsync).not.toHaveBeenCalled();
    expect(setModelAsync).toHaveBeenCalledWith('ultimate', 'high', undefined);
  });

  it('warns when a connected remote cannot disable server-side UltraCode', async () => {
    const setModelAsync = vi.fn().mockResolvedValue(undefined);
    const setUltracode = vi.fn();
    controllerFixture = {
      setModel: setModelAsync,
      getAvailableModels: () => [
        {
          modelId: 'ultimate',
          displayName: 'Ultimate',
          source: 'system',
          efforts: ['low', 'xhigh'],
        },
      ],
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('xhigh'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        getUltracode: () => true,
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('xhigh');

    expect(setModelAsync).toHaveBeenCalledWith('ultimate', 'xhigh', undefined);
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'this session does not support changing UltraCode',
        ),
      }),
    );
  });

  it('still applies ordinary effort when an older remote rejects apply_flag_settings', async () => {
    const setModelAsync = vi.fn().mockResolvedValue(undefined);
    const applyFlagSettingsAsync = vi
      .fn()
      .mockRejectedValue(new TypeError('Session settings are not supported'));
    const setUltracode = vi.fn();
    controllerFixture = {
      setModel: setModelAsync,
      applySettings: applyFlagSettingsAsync,
      getAvailableModels: () => [
        {
          modelId: 'ultimate',
          displayName: 'Ultimate',
          source: 'system',
          efforts: ['low', 'high', 'xhigh'],
        },
      ],
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('xhigh'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        getUltracode: () => true,
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('high');

    expect(setModelAsync).toHaveBeenCalledWith('ultimate', 'high', undefined);
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining(
          'this session does not support changing UltraCode',
        ),
      }),
    );
  });

  it('reports a partial remote change when effort update fails after disabling UltraCode', async () => {
    const setModelAsync = vi.fn().mockRejectedValue(new Error('model failed'));
    const applyFlagSettingsAsync = vi.fn().mockResolvedValue(undefined);
    const setUltracode = vi.fn();
    controllerFixture = {
      setModel: setModelAsync,
      applySettings: applyFlagSettingsAsync,
      getAvailableModels: () => [
        {
          modelId: 'ultimate',
          displayName: 'Ultimate',
          source: 'system',
          efforts: ['low', 'high'],
        },
      ],
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('xhigh'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        getUltracode: () => true,
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('high');

    expect(applyFlagSettingsAsync).toHaveBeenCalledWith({
      ultracode: false,
    });
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'UltraCode was disabled, but the reasoning effort change was rejected: model failed',
      }),
    );
  });

  it('uses apply_flag_settings when a connected remote supports UltraCode control', async () => {
    const applyFlagSettingsAsync = vi.fn().mockResolvedValue(undefined);
    const setUltracode = vi.fn();
    mockCatalogModel();
    controllerFixture = {
      setModel: vi.fn(),
      applySettings: applyFlagSettingsAsync,
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        setUltracode,
        isWorkflowToolAvailable: () => true,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('ultracode');

    expect(applyFlagSettingsAsync).toHaveBeenCalledWith({ ultracode: true });
    expect(setModelConfig).not.toHaveBeenCalled();
    expect(mockContext.services.sessionHandle?.setModel).not.toHaveBeenCalled();
    expect(setUltracode).toHaveBeenCalledWith(true);
  });

  it('treats a connected local worker as the owner of UltraCode state', async () => {
    const applyFlagSettingsAsync = vi.fn();
    const setUltracode = vi.fn();
    mockCatalogModel();
    controllerFixture = {
      applySettings: applyFlagSettingsAsync,
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        setUltracode,
        isWorkflowToolAvailable: () => true,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('ultracode');

    expect(applyFlagSettingsAsync).not.toHaveBeenCalled();
    expect(setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: 'xhigh' } },
      undefined,
    );
    expect(setUltracode).toHaveBeenCalledWith(true);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'UltraCode enabled for Ultimate (xhigh + dynamic workflow orchestration; this session only)',
      }),
    );
  });

  it('keeps local preferences untouched when session settings are unsupported', async () => {
    const applyFlagSettingsAsync = vi
      .fn()
      .mockRejectedValue(new TypeError('Session settings are not supported'));
    const setUltracode = vi.fn();
    mockCatalogModel();
    controllerFixture = {
      setModel: vi.fn(),
      applySettings: applyFlagSettingsAsync,
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        setUltracode,
        isWorkflowToolAvailable: () => true,
      },
    } as unknown as CommandContext['services']['agentContext'];

    await runEffortCommand('ultracode');

    expect(setModelConfig).not.toHaveBeenCalled();
    expect(mockContext.services.sessionHandle?.setModel).toHaveBeenCalledWith(
      'ultimate',
      'xhigh',
      undefined,
    );
    expect(setUltracode).toHaveBeenCalledWith(true);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining(
          'this session does not support changing UltraCode',
        ),
      }),
    );
  });

  it('opens remote model options with context_config-derived context windows', async () => {
    const setModelAsync = vi.fn().mockResolvedValue(undefined);
    controllerFixture = {
      setModel: setModelAsync,
      getAvailableModels: () => [
        {
          modelId: 'auto',
          displayName: 'Auto',
          source: 'system',
          efforts: ['medium'],
          maxInputTokens: 1_000_000,
          context_config: {
            '1M': { token_count: 1_000_000 },
            '400K': { token_count: 400_000 },
          },
        },
      ],
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'auto',
        getUltracode: () => false,
        isWorkflowToolAvailable: () => true,
      },
    } as unknown as CommandContext['services']['agentContext'];

    const result = await runEffortCommand('');

    expect(result?.type).toBe('custom_dialog');
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom_dialog');
    }

    const dialog = result.component as React.ReactElement<{
      model: {
        availableContextWindows?: number[];
        defaultContextWindow?: number;
      };
    }>;
    expect(dialog.type).toBe(ModelOptionsSelector);
    expect(dialog.props.model.availableContextWindows).toEqual([
      400_000, 1_000_000,
    ]);
    expect(dialog.props.model.defaultContextWindow).toBeUndefined();
  });

  it('warns from remote model options when UltraCode control is unavailable', async () => {
    const setModelAsync = vi.fn().mockResolvedValue(undefined);
    const setUltracode = vi.fn();
    controllerFixture = {
      setModel: setModelAsync,
      getAvailableModels: () => [
        {
          modelId: 'ultimate',
          displayName: 'Ultimate',
          source: 'system',
          efforts: ['low', 'high'],
        },
      ],
    };
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager('low'),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        isWorkflowToolAvailable: () => true,
        getUltracode: () => true,
        setUltracode,
      },
    } as unknown as CommandContext['services']['agentContext'];

    const result = await runEffortCommand('');
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom_dialog');
    }
    const dialog = result.component as React.ReactElement<{
      onSelect: (
        reasoningEffort: ReasoningEffortLevel | undefined,
        contextWindow: number | undefined,
        ultracode?: boolean,
      ) => Promise<void>;
    }>;

    await dialog.props.onSelect('high', undefined, undefined);

    expect(setModelAsync).toHaveBeenCalledWith('ultimate', 'high', undefined);
    expect(setUltracode).toHaveBeenCalledWith(false);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'this session does not support changing UltraCode',
        ),
      }),
    );
  });

  it('completes supported efforts for the current model', async () => {
    mockCatalogModel({
      key: 'ultimate',
      display_name: 'Ultimate',
      enable: true,
      efforts: ['high'],
      supports_disabled: true,
    });
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        isWorkflowToolAvailable: () => false,
      },
    } as unknown as CommandContext['services']['agentContext'];

    expect(await effortCommand.completion?.(mockContext, '')).toEqual([
      'auto',
      'high',
      'off',
    ]);
  });

  it('offers ultracode completion only when Workflow and xhigh are available', async () => {
    mockCatalogModel();
    mockContext.services.agentContext = {
      config: {
        getModelProviderManager: () => modelManager(),
        getModelRequestIdentity: () => 'account-1',
        getSessionId: () => 'session-1',
        getModel: () => 'ultimate',
        isWorkflowToolAvailable: () => true,
      },
    } as unknown as CommandContext['services']['agentContext'];

    expect(await effortCommand.completion?.(mockContext, 'ultra')).toEqual([
      'ultracode',
    ]);
  });
});
