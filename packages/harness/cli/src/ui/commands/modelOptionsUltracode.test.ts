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
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import type { SessionHandle } from '../../session/session.js';
import { effortCommand } from './effortCommand.js';
import { contextWindowCommand } from './contextWindowCommand.js';
import {
  applyModelOptionsFromPanel,
  createModelOptionsDialog,
  type ModelOptionsState,
  type CurrentModelOptionsModel,
} from './modelOptionsCommandUtils.js';

const model: CurrentModelOptionsModel = {
  key: 'ultimate',
  display_name: 'Ultimate',
  enable: true,
  efforts: ['high', 'xhigh'],
  available_context_windows: [200_000, 400_000],
  default_context_window: 200_000,
};

describe('Ultracode model options', () => {
  let context: CommandContext;
  let config: {
    getModel: ReturnType<typeof vi.fn>;
    getUltracode: ReturnType<typeof vi.fn>;
    isUltracodeAvailable: ReturnType<typeof vi.fn>;
    isUltracodeActive: ReturnType<typeof vi.fn>;
    setModelConfig: ReturnType<typeof vi.fn>;
    setUltracode: ReturnType<typeof vi.fn>;
    getModelProviderManager: () => {
      getModel: (key: string) => Promise<core.Model | undefined>;
      getModelConfig: () => core.ModelConfig;
      setModelConfig: ReturnType<typeof vi.fn>;
    };
    getModelRequestIdentity: ReturnType<typeof vi.fn>;
    getSessionId: ReturnType<typeof vi.fn>;
    isWorkflowToolAvailable: ReturnType<typeof vi.fn>;
  };
  let listedModel: core.Model | undefined;
  const state = (ultracode = false): ModelOptionsState => ({
    reasoningEffort: 'xhigh',
    ultracode,
    contextWindow: 200_000,
  });
  const apply = (previous: ModelOptionsState, next: ModelOptionsState) =>
    applyModelOptionsFromPanel(context, {
      model,
      modelId: 'ultimate',
      sessionOnly: false,
      previous,
      next,
    });

  beforeEach(() => {
    vi.restoreAllMocks();
    listedModel = model
      ? entryToListedModel(model as unknown as ListedModelEntryFixture)
      : undefined;
    context = createMockCommandContext();
    context.ui.removeComponent = vi.fn();
    config = {
      getModel: vi.fn(() => 'ultimate'),
      getUltracode: vi.fn(() => false),
      isUltracodeActive: vi.fn(() => false),
      isUltracodeAvailable: vi.fn(() => true),
      setModelConfig: vi.fn(() => true),
      setUltracode: vi.fn(),
      getModelProviderManager: () => ({
        getModel: async () => listedModel,
        getModelConfig: () => ({
          reasoning: { effort: 'xhigh' },
          context: { contextWindow: 200_000 },
        }),
        setModelConfig: config.setModelConfig,
      }),
      getModelRequestIdentity: vi.fn(() => 'account-1'),
      getSessionId: vi.fn(() => 'session-1'),
      isWorkflowToolAvailable: vi.fn(() => true),
    };
    context.services.agentContext = {
      config,
    } as unknown as CommandContext['services']['agentContext'];
  });

  it.each([effortCommand, contextWindowCommand])(
    'keeps Ultracode when confirming the $name panel',
    async (command) => {
      config.getUltracode.mockReturnValue(true);
      config.isUltracodeActive.mockReturnValue(true);
      const result = await command.action!(context, '');
      if (!result || result.type !== 'custom_dialog')
        throw new Error('Expected model options');
      const dialog = result.component as React.ReactElement<{
        currentUltracode: boolean;
        ultracodeAvailable: boolean;
        onSelect: (
          effort: 'xhigh',
          window: number,
          ultra: boolean,
        ) => Promise<void>;
      }>;
      expect(dialog.props.currentUltracode).toBe(true);
      expect(dialog.props.ultracodeAvailable).toBe(true);
      await dialog.props.onSelect('xhigh', 200_000, true);
      expect(config.setUltracode).not.toHaveBeenCalledWith(false);
      expect(config.setModelConfig).not.toHaveBeenCalled();
    },
  );

  it.each(['local', 'local-worker', 'controller'] as const)(
    'limits the new panel option to the session owner: %s',
    async (mode) => {
      const setModelAsync = vi.fn();
      if (mode === 'controller') {
        context.services.sessionHandle = { setModel: setModelAsync } as unknown as SessionHandle;
      }
      config.getUltracode.mockReturnValue(true);
      config.isWorkflowToolAvailable.mockReturnValue(true);
      const onSelect = vi.fn();
      const dialog = createModelOptionsDialog(
        context,
        model,
        'effort',
        'xhigh',
        200_000,
        onSelect,
      ).component as React.ReactElement<{
        currentUltracode: boolean;
        ultracodeAvailable: boolean;
        onSelect: (
          effort: 'xhigh',
          window: number,
          ultra: boolean,
        ) => Promise<void>;
      }>;
      expect(dialog.props.currentUltracode).toBe(mode !== 'controller');
      expect(dialog.props.ultracodeAvailable).toBe(mode !== 'controller');
      await dialog.props.onSelect('xhigh', 200_000, true);
      expect(onSelect).toHaveBeenCalledWith(
        'xhigh',
        200_000,
        mode === 'controller' ? undefined : true,
      );
      expect(setModelAsync).not.toHaveBeenCalled();
    },
  );

  it('enters from ordinary xhigh and reports the mode-only change', async () => {
    await apply(state(), state(true));
    expect(config.setUltracode).toHaveBeenCalledWith(true);
    expect(config.setModelConfig).not.toHaveBeenCalled();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Updated Ultimate: thinking effort to Ultracode (this session only)',
      }),
    );
  });

  it('uses temporary xhigh while persisting independent options', async () => {
    await apply(
      { ...state(), reasoningEffort: 'high' },
      {
        ...state(true),
        contextWindow: 400_000,
      },
    );
    expect(config.setModelConfig.mock.calls).toEqual([
      [listedModel, { reasoning: { effort: 'xhigh' } }, false],
      [listedModel, { context: { contextWindow: 400_000 } }, true],
    ]);
    expect(config.setUltracode).toHaveBeenCalledWith(true);
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'Ultracode this session only; other changed settings persisted',
        ),
      }),
    );
  });

  it.each(['xhigh', 'high', undefined] as const)(
    'exits when explicitly selecting ordinary %s',
    async (effort) => {
      config.getUltracode.mockReturnValue(true);
      await apply(state(true), { ...state(), reasoningEffort: effort });
      expect(config.setUltracode).toHaveBeenCalledWith(false);
    },
  );

  it('keeps an unavailable request when only context changes', async () => {
    config.getUltracode.mockReturnValue(true);
    config.isUltracodeAvailable.mockReturnValue(false);
    await apply(state(true), {
      ...state(),
      ultracode: undefined,
      contextWindow: 400_000,
    });
    expect(config.setUltracode).not.toHaveBeenCalled();
    expect(config.setModelConfig.mock.calls).toEqual([
      [listedModel, { context: { contextWindow: 400_000 } }, true],
    ]);
  });

  it.each(['capability', 'model'] as const)(
    'revalidates %s before applying any setting',
    async (change) => {
      if (change === 'capability')
        config.isUltracodeAvailable.mockReturnValue(false);
      else
        listedModel = entryToListedModel({
          ...model,
          key: 'another-model',
        } as unknown as ListedModelEntryFixture);
      await apply(state(), { ...state(true), contextWindow: 400_000 });
      expect(config.setUltracode).not.toHaveBeenCalled();
      expect(config.setModelConfig).not.toHaveBeenCalled();
      expect(context.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No model settings changed'),
        }),
      );
    },
  );

  it.each(['model', 'account', 'session'] as const)(
    '面板创建后 %s 变化，不提交旧选择',
    async (change) => {
      const onSelect = vi.fn();
      const dialog = createModelOptionsDialog(
        context,
        model,
        'effort',
        'xhigh',
        200_000,
        onSelect,
      ).component as React.ReactElement<{
        onSelect: (
          effort: 'high',
          window: number,
          ultracode?: boolean,
        ) => Promise<void>;
      }>;
      if (change === 'model') config.getModel.mockReturnValue('other');
      if (change === 'account')
        config.getModelRequestIdentity.mockReturnValue('account-2');
      if (change === 'session')
        config.getSessionId.mockReturnValue('session-2');
      await dialog.props.onSelect('high', 400_000, undefined);
      expect(onSelect).not.toHaveBeenCalled();
      expect(context.ui.removeComponent).toHaveBeenCalled();
    },
  );

  it.each(['model', 'account', 'session'] as const)(
    '能力查询期间 %s 变化，不提交迟到结果',
    async (change) => {
      let resolve!: (model: core.Model | undefined) => void;
      const manager = config.getModelProviderManager();
      config.getModelProviderManager = () => ({
        ...manager,
        getModel: () =>
          new Promise((done) => {
            resolve = done;
          }),
      });
      const pending = apply(state(), {
        ...state(true),
        contextWindow: 400_000,
      });
      if (change === 'model') config.getModel.mockReturnValue('other');
      if (change === 'account')
        config.getModelRequestIdentity.mockReturnValue('account-2');
      if (change === 'session')
        config.getSessionId.mockReturnValue('session-2');
      resolve(listedModel);
      await pending;
      expect(config.setModelConfig).not.toHaveBeenCalled();
      expect(config.setUltracode).not.toHaveBeenCalled();
      expect(context.ui.addItem).not.toHaveBeenCalled();
    },
  );

  it('模型查询失败时报告错误且不部分提交', async () => {
    const manager = config.getModelProviderManager();
    config.getModelProviderManager = () => ({
      ...manager,
      getModel: async () => {
        throw new Error('query failed');
      },
    });
    await apply(state(), { ...state(true), contextWindow: 400_000 });
    expect(config.setUltracode).not.toHaveBeenCalled();
    expect(config.setModelConfig).not.toHaveBeenCalled();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ text: '模型查询失败，未更新模型设置。' }),
    );
  });

  it('explicitly selecting ordinary xhigh persists after session-only Ultracode', async () => {
    config.getUltracode.mockReturnValue(true);
    await apply(state(true), state(false));
    expect(config.setModelConfig).toHaveBeenCalledWith(
      listedModel,
      { reasoning: { effort: 'xhigh' } },
      true,
    );
  });
});
