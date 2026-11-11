/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Model, ModelConfig } from '../model/model.js';
import { OPENAI_CHAT_COMPLETIONS } from '../transport/modelProtocol.js';
import { CustomModelSelector } from './customModelSelector.js';
import { CustomProviderConfig } from './customProviderConfig.js';

function model(key: string): Model {
  return {
    key,
    source: 'local',
    displayName: key,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: { supported: false, supportedEfforts: [] },
      contextWindows: [],
    },
    limits: { maxContextTokens: 32000, maxOutputTokens: 4096 },
  };
}

function setup(routing: CustomProviderConfig['routing']) {
  const main = model('local/main');
  const helper = model('local/helper');
  const configs = new Map<string, ModelConfig>();
  const preferences = {
    getModelConfig: (model: Model) => configs.get(model.key),
    setModelConfig: (model: Model, patch: ModelConfig) => {
      configs.set(model.key, patch);
      return true;
    },
  };
  const selector = new CustomModelSelector(
    new CustomProviderConfig({
      providerId: 'local',
      baseUrl: 'https://unused.invalid',
      protocol: OPENAI_CHAT_COMPLETIONS,
      models: [main, helper],
      routing,
    }),
    preferences,
  );
  return { selector, main, helper, preferences };
}

describe('CustomModelSelector auto permission compatibility', () => {
  it('configuration-only overrides preserve default, auxiliary and parent model selection', async () => {
    const { selector, main, helper, preferences } = setup({
      utility: 'helper',
      session_title: 'helper',
    });
    preferences.setModelConfig(main, { sampling: { temperature: 0.2 } });
    const overrideSelection = { config: { context: { maxOutputTokens: 123 } } };
    const normal = await selector.select({ mainModel: main,
      purpose: 'main',
      overrideSelection,
    });
    expect(normal.model).toBe(main);
    expect(normal.config).toMatchObject({
      sampling: { temperature: 0.2 },
      context: { maxOutputTokens: 123 },
    });
    expect(
      (await selector.select({ mainModel: main, purpose: 'title', overrideSelection })).model,
    ).toBe(helper);
    const parentSelection = {
      model: helper,
      config: { sampling: { temperature: 0.8 } },
    };
    expect(
      await selector.select({ mainModel: main,
        purpose: 'task',
        parentSelection,
        overrideSelection,
      }),
    ).toMatchObject({
      model: helper,
      config: {
        sampling: { temperature: 0.8 },
        context: { maxOutputTokens: 123 },
      },
    });
    expect(parentSelection.config).toEqual({ sampling: { temperature: 0.8 } });
  });

  it.each(['main', 'hook_prompt'] as const)(
    '%s 从内部读取目标模型偏好，不影响辅助用途',
    async (purpose) => {
      const { selector, main, helper, preferences } = setup({
        utility: 'helper',
      });
      preferences.setModelConfig(main, { sampling: { temperature: 0.1 } });
      preferences.setModelConfig(helper, {
        sampling: { temperature: 0.8 },
      });
      expect(
        (await selector.select({ purpose, mainModel: main })).config.sampling
          ?.temperature,
      ).toBe(0.1);
      expect(
        (
          await selector.select({
            purpose,
            mainModel: main,
            overrideSelection: { model: helper, config: {} },
          })
        ).config.sampling?.temperature,
      ).toBe(0.8);
      expect(
        (await selector.select({ purpose: 'auto_permission', mainModel: main }))
          .config.sampling,
      ).toBeUndefined();
    },
  );

  it('仅覆盖辅助用途配置时保留 utility 模型，不读主模型偏好', async () => {
    const { selector, main, helper, preferences } = setup({
      utility: 'helper',
    });
    preferences.setModelConfig(main, { sampling: { temperature: 0.8 } });
    const base = await selector.select({
      purpose: 'auto_permission',
      mainModel: main,
    });
    const result = await selector.select({
      purpose: 'auto_permission',
      mainModel: main,
      overrideSelection: {
        model: base.model,
        config: { context: { maxOutputTokens: 1024 } },
      },
    });
    expect(result.model).toBe(helper);
    expect(result.config.context?.maxOutputTokens).toBe(1024);
    expect(result.config.sampling).toBeUndefined();
  });

  it('accepts a key override and still rejects unavailable keys', async () => {
    const { selector, main, helper } = setup({});
    const selected = await selector.select({ mainModel: main,
      purpose: 'task',
      overrideSelection: {
        key: helper.key,
        config: { context: { maxOutputTokens: 1234 } },
      },
    });
    expect(selected.model).toBe(helper);
    expect(selected.config.context?.maxOutputTokens).toBe(1234);
    await expect(
      selector.select({ mainModel: main,
        purpose: 'main',
        overrideSelection: { key: 'local/missing' },
      }),
    ).rejects.toThrow('is unavailable');
  });

  it('context 缺少主模型时直接拒绝选模', async () => {
    const { selector } = setup({});
    await expect(selector.select({ purpose: 'main' })).rejects.toThrow(
      'requires a main model in context',
    );
  });

  it('同一 Selector 按每次 context 的主模型选模，不保存会话锚点', async () => {
    const { selector, main, helper } = setup({});
    expect(
      (await selector.select({ purpose: 'main', mainModel: main })).model,
    ).toBe(main);
    expect(
      (await selector.select({ purpose: 'main', mainModel: helper })).model,
    ).toBe(helper);
  });

  it.each(['helper', 'local/helper'])(
    'uses the existing routing.utility target for auto_permission (%s)',
    async (target) => {
      const { selector, main, helper } = setup({ utility: target });
      expect(
        await selector.select({ purpose: 'auto_permission', mainModel: main }),
      ).toEqual({
        model: helper,
        config: {
          reasoning: { effort: 'none' },
          context: { contextWindow: 32000 },
        },
      });
    },
  );

  it.each([{}, { utility: 'missing' }])(
    'preserves the main-model fallback when routing.utility is absent or unavailable: %j',
    async (routing) => {
      const { selector, main } = setup(routing);
      const result = await selector.select({
        purpose: 'auto_permission',
        mainModel: main,
      });
      expect(result.model).toBe(main);
    },
  );
});
