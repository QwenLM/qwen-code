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

function model(key: string, source = 'local'): Model {
  return {
    key,
    source,
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

function setup(
  routing: CustomProviderConfig['routing'],
  providerId = 'local',
  helper: Model = model(`${providerId}/helper`, providerId),
) {
  const main = model(`${providerId}/main`, providerId);
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
      providerId,
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
  it.each([false, true])('uses its own policy with a foreign session anchor (title routing=%s)', async (routed) => {
    const { selector, main, helper } = setup(routed ? { session_title: 'helper' } : {});
    const parentSelection = { model: main, config: { sampling: { temperature: 0.3 } } };
    const context = {
      mainModel: { ...main, key: 'other/main', source: 'other' },
      parentSelection,
    };
    expect(await selector.select({ ...context, purpose: 'task' })).toMatchObject(parentSelection);
    // 同一个父选择不意味着每种用途都必须选父模型。
    expect((await selector.select({ ...context, purpose: 'title' })).model).toBe(routed ? helper : main);
    expect(context).not.toHaveProperty('overrideSelection');
  });

  it.each(['qoder', 'qwen-subscription'])(
    '%s keeps its existing preference and inheritance rules',
    async (providerId) => {
      const { selector, main, preferences } = setup({}, providerId);
      preferences.setModelConfig(main, { context: { maxOutputTokens: 2048 } });
      expect(
        (await selector.select({ purpose: 'main', mainModel: main })).config
          .context?.maxOutputTokens,
      ).toBe(2048);
      for (const purpose of ['title', 'summary', 'auto_permission'] as const) {
        const selected = await selector.select({ purpose, mainModel: main });
        expect(selected.config.context?.maxOutputTokens).toBeUndefined();
      }
      for (const purpose of ['main', 'hook_prompt', 'task', 'compact'] as const) {
        for (const overrideSelection of [undefined, { model: main, config: {} }]) {
          const selected = await selector.select({
            purpose,
            mainModel: main,
            parentSelection: { model: main, config: {} },
            overrideSelection,
          });
          expect(selected.config).toEqual({});
        }
      }
    },
  );

  it('reads output preferences from the routed model without inheriting its other preferences', async () => {
    const { selector, main, helper, preferences } = setup({ utility: 'helper' });
    preferences.setModelConfig(main, { context: { maxOutputTokens: 2048 } });
    preferences.setModelConfig(helper, {
      context: { maxOutputTokens: 16384 },
      sampling: { temperature: 0.8 },
    });
    const result = await selector.select({
      purpose: 'auto_permission',
      mainModel: main,
    });
    expect(result.model).toBe(helper);
    expect(result.config.context?.maxOutputTokens).toBe(16384);
    expect(result.config.sampling).toBeUndefined();
  });

  it.each(['task', 'compact', 'suggestion'] as const)(
    '%s fills a missing inherited output setting but preserves an explicit inherited value',
    async (purpose) => {
      const { selector, main, preferences } = setup({});
      preferences.setModelConfig(main, { context: { maxOutputTokens: 16384 } });
      for (const maxOutputTokens of [undefined, 1024]) {
        const result = await selector.select({
          purpose,
          mainModel: main,
          parentSelection: {
            model: main,
            config: { context: { maxOutputTokens } },
          },
          overrideSelection: { model: main, config: {} },
        });
        expect(result.config.context?.maxOutputTokens).toBe(maxOutputTokens ?? 16384);
      }
    },
  );

  it('configuration-only overrides preserve default, auxiliary and parent model selection', async () => {
    const { selector, main, helper, preferences } = setup({
      utility: 'helper',
      session_title: 'helper',
    });
    preferences.setModelConfig(main, { sampling: { temperature: 0.2 } });
    const overrideSelection = { config: { context: { maxOutputTokens: 123 } } };
    const normal = await selector.select({
      mainModel: main,
      purpose: 'main',
      overrideSelection,
    });
    expect(normal.model).toBe(main);
    expect(normal.config).toMatchObject({
      sampling: { temperature: 0.2 },
      context: { maxOutputTokens: 123 },
    });
    expect(
      (
        await selector.select({
          mainModel: main,
          purpose: 'title',
          overrideSelection,
        })
      ).model,
    ).toBe(helper);
    const parentSelection = {
      model: helper,
      config: { sampling: { temperature: 0.8 } },
    };
    expect(
      await selector.select({
        mainModel: main,
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

  it('preserves the parent configuration for a forked suggestion', async () => {
    const { selector, main } = setup({});
    const result = await selector.select({
      purpose: 'suggestion',
      mainModel: main,
      parentSelection: {
        model: main,
        config: { context: { contextWindow: 8192 } },
      },
      overrideSelection: {
        model: main,
        config: { context: { maxOutputTokens: 256 } },
      },
    });
    expect(result.config).toEqual({
      context: { contextWindow: 8192, maxOutputTokens: 256 },
    });
  });

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

  it('accepts a key override regardless of its enabled flag and still rejects missing keys', async () => {
    const { selector, main, helper } = setup(
      {},
      'local',
      { ...model('local/helper'), enabled: false },
    );
    const selected = await selector.select({
      mainModel: main,
      purpose: 'task',
      overrideSelection: {
        key: helper.key,
        config: { context: { maxOutputTokens: 1234 } },
      },
    });
    expect(selected.model).toBe(helper);
    expect(selected.config.context?.maxOutputTokens).toBe(1234);
    await expect(
      selector.select({
        mainModel: main,
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
