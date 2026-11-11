/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSummaryReserveTokens,
  coreEvents,
  uiTelemetryService,
  type Config,
  type Model,
  type ReasoningEffortLevel,
} from '@qwen-code/core';
import {
  cleanup,
  renderHook,
  renderWithProviders,
} from '../../test-utils/render.js';
import { useModel } from '../contexts/ConfigContext.js';
import { testProviderModel } from '../../../../core/src/test-utils/request-model.js';
import { StatusLineDefault } from './StatusLineDefault.js';
import { createMockSettings } from '../../test-utils/settings.js';

const coreMocks = vi.hoisted(() => {
  let listedModel: Model | undefined;
  return {
    setListedModel: (
      overrides:
        | {
            source?: string;
            displayName?: string;
            supportedEfforts?: ReasoningEffortLevel[];
          }
        | undefined,
    ) => {
      listedModel = overrides
        ? ({
            source: overrides.source ?? 'qwen-provider',
            key: 'listed',
            // 缺省时让状态栏回退到 getDisplayString(model)。
            displayName: overrides.displayName,
            capabilities: {
              tools: true,
              vision: false,
              reasoning: {
                supported: (overrides.supportedEfforts ?? []).length > 0,
                supportedEfforts: overrides.supportedEfforts ?? [],
              },
              contextWindows: [],
            },
            limits: { maxContextTokens: 128_000 },
          } as Model)
        : undefined;
    },
    listModels: vi.fn(
      async () => [{ key: 'ultimate', isDefault: true }] as Model[],
    ),
    getModel: vi.fn(async () => listedModel),
    calculateTokenWarningStateForContextWindow: vi.fn(
      (tokenUsage: number, contextWindowSize: number) => {
        const autoCompactThreshold =
          contextWindowSize -
          Math.max(13_000, Math.floor(contextWindowSize * 0.05));
        const warningThreshold = autoCompactThreshold - 20_000;
        const blockingLimit = contextWindowSize - 3_000;
        return {
          percentLeft: Math.max(
            0,
            Math.round(
              ((autoCompactThreshold - tokenUsage) / autoCompactThreshold) *
                100,
            ),
          ),
          isAboveWarningThreshold: tokenUsage >= warningThreshold,
          isAboveErrorThreshold: tokenUsage >= warningThreshold,
          isAboveAutoCompactThreshold: tokenUsage >= autoCompactThreshold,
          isAtBlockingLimit: tokenUsage >= blockingLimit,
        };
      },
    ),
  };
});

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    calculateTokenWarningStateForContextWindow:
      coreMocks.calculateTokenWarningStateForContextWindow,
    getC4RepoService: () => ({
      getMergedC4RepoStatusSync: () => null,
    }),
    tokenLimit: () => 100_000,
  };
});

function makeStatusLineConfig(contextWindowSize: number): Config {
  return {
    getSessionId: () => 'test-session-id',
    getModel: () => 'ultimate',
    getModelRequestIdentity: () => 'account',
    getTargetDir: () => '/workspace',
    getEffectiveContextWindow: () => contextWindowSize,
    getModelProviderManager: () => ({
      getModel: coreMocks.getModel,
      listModels: coreMocks.listModels,
    }),
    getWorkspaceContext: () => ({
      getDirectories: () => ['/workspace'],
    }),
  } as unknown as Config;
}

describe('UI 异步模型展示状态', () => {
  afterEach(cleanup);

  it.each(['model', 'account', 'config', 'unmount', 'newer-query'])(
    '丢弃 %s 变化后的迟到模型',
    async (change) => {
      let finish!: (value: Model) => void;
      let key = 'before';
      let identity = 'account';
      const getModel = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Model>((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue(testProviderModel('after'));
      const config = {
        getModel: () => key,
        getSessionId: () => 'session',
        getModelRequestIdentity: () => identity,
        getModelProviderManager: () => ({ getModel }),
      } as unknown as Config;
      const { result, rerender, unmount, waitUntilReady } = await renderHook(
        (current: Config) => useModel(current),
        { initialProps: config },
      );
      expect(result.current).toBeUndefined();
      if (change === 'model') key = 'after';
      if (change === 'account') identity = 'after';
      if (change === 'config') rerender({ ...config } as Config);
      if (change === 'unmount') unmount();
      if (change !== 'config' && change !== 'unmount')
        coreEvents.emitModelInfoChanged();
      if (change !== 'unmount') await waitUntilReady();
      finish(testProviderModel('stale'));
      if (change !== 'unmount') await waitUntilReady();
      expect(result.current?.key).not.toBe('stale');
      if (change !== 'unmount') expect(result.current?.key).toBe('after');
    },
  );

  it('查询失败回退为空模型并在目录变化后恢复', async () => {
    const manager = {
      getModel: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(testProviderModel('restored')),
    };
    const config = {
      getModel: () => 'model',
      getSessionId: () => 'session',
      getModelRequestIdentity: () => 'account',
      getModelProviderManager: () => manager,
    } as unknown as Config;
    const { result, waitUntilReady } = await renderHook(() => useModel(config));
    expect(result.current).toBeUndefined();
    coreEvents.emitModelInfoChanged();
    await waitUntilReady();
    expect(result.current?.key).toBe('restored');
  });
});

describe('<StatusLineDefault />', () => {
  afterEach(() => {
    uiTelemetryService.setLastPromptTokenCount(0);
    coreMocks.calculateTokenWarningStateForContextWindow.mockClear();
    cleanup();
    coreMocks.listModels.mockClear();
    coreMocks.getModel.mockClear();
    coreMocks.setListedModel(undefined);
  });

  it('renders context usage above 100% without throwing', async () => {
    uiTelemetryService.setLastPromptTokenCount(261_999);

    const { lastFrame, unmount } = await renderWithProviders(
      <StatusLineDefault />,
      {
        config: makeStatusLineConfig(100_000),
        uiState: {
          currentModel: 'ultimate',
          terminalWidth: 120,
        },
        width: 120,
      },
    );

    const output = lastFrame();
    expect(output).toContain('ctx');
    expect(output).toContain('262%');

    unmount();
  });

  it('localizes fixed status labels while preserving the model display name', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await renderWithProviders(
      <StatusLineDefault />,
      {
        settings,
        config: makeStatusLineConfig(100_000),
        uiState: { currentModel: 'ultimate', terminalWidth: 120 },
        width: 120,
      },
    );

    expect(lastFrame()).toContain('Ultimate 模型');
    expect(lastFrame()).toContain('上下文');
    unmount();
  });

  it('uses the displayed context window for warning colors', async () => {
    uiTelemetryService.setLastPromptTokenCount(181_400);

    const { lastFrame, unmount } = await renderWithProviders(
      <StatusLineDefault />,
      {
        config: makeStatusLineConfig(200_000),
        uiState: {
          currentModel: 'ultimate',
          currentContextWindow: 200_000,
          terminalWidth: 120,
        },
        width: 120,
      },
    );

    const output = lastFrame();
    expect(output).toContain('ctx');
    expect(output).toContain('91%');
    expect(
      coreMocks.calculateTokenWarningStateForContextWindow,
    ).toHaveBeenCalledWith(
      181_400,
      200_000 - getSummaryReserveTokens(undefined),
    );

    unmount();
  });

  it.each([
    {
      source: 'aliyun-bailian-anthropic',
      displayName: 'Qwen 3.8 Max',
      modelId: 'qwen3.8-max',
    },
    {
      source: 'qwen-custom-740f94f4-9a7e-4961-a38e-5744f340edc4',
      displayName: 'qa-test888',
      modelId: 'qwen3.8-flash',
    },
  ])(
    '自定义模型 $source 只显示模型名，不附加 provider ID',
    async ({ source, displayName, modelId }) => {
      coreMocks.setListedModel({ displayName, source });

      const { lastFrame, unmount } = await renderWithProviders(
        <StatusLineDefault />,
        {
          config: makeStatusLineConfig(1_000_000),
          uiState: {
            currentModel: `${source}/${modelId}`,
            terminalWidth: 160,
          },
          width: 160,
        },
      );

      const output = lastFrame();
      expect(output).toContain(`${displayName} Model`);
      expect(output).not.toContain(source);

      unmount();
    },
  );

  it('hides disabled effort when the current model does not support thinking', async () => {
    coreMocks.setListedModel({ supportedEfforts: [] });

    const { lastFrame, unmount } = await renderWithProviders(
      <StatusLineDefault />,
      {
        config: makeStatusLineConfig(128_000),
        uiState: {
          currentModel: 'glm-5.2',
          currentReasoningEffort: 'none',
          terminalWidth: 120,
        },
        width: 120,
      },
    );

    const output = lastFrame();
    expect(output).toContain('Glm-5.2 Model');
    expect(output).not.toContain('Disabled');
    expect(output).not.toContain('Disabled Effort');

    unmount();
  });

  it('renders disabled effort when the current model supports disabled thinking', async () => {
    coreMocks.setListedModel({ supportedEfforts: ['none'] });

    const { lastFrame, unmount } = await renderWithProviders(
      <StatusLineDefault />,
      {
        config: makeStatusLineConfig(128_000),
        uiState: {
          currentModel: 'deepseek-v4-pro',
          currentReasoningEffort: 'none',
          terminalWidth: 120,
        },
        width: 120,
      },
    );

    const output = lastFrame();
    expect(output).toContain('Deepseek-v4-pro Model');
    expect(output).toContain('Disabled Effort');

    unmount();
  });
});
