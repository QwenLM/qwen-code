/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { SettingsService } from '@qwen-code/resource';
import { ModelConfigStore } from './modelConfigStore.js';
import type { ModelPreferenceEntry } from '../../config/config.js';

function preference(
  file: ReturnType<typeof source>,
  key = 'qoder/auto',
): ModelPreferenceEntry {
  return (
    file.disk()['model'] as {
      preferences: Record<string, ModelPreferenceEntry>;
    }
  ).preferences[key]!;
}

function source(initial: Record<string, unknown>, text?: string) {
  let disk = structuredClone(initial);
  return {
    read: () => text ?? JSON.stringify(disk),
    mutate: vi.fn((mutation: (value: Record<string, unknown>) => boolean) => {
      const next = structuredClone(disk);
      if (mutation(next)) disk = next;
    }),
    disk: () => disk,
  };
}
function setup(initial: Record<string, unknown>, text?: string) {
  const file = source(initial, text);
  const settingsService = {
    peekUserSettingsSource: () => file,
  } as unknown as SettingsService;
  const store = new ModelConfigStore({
    providerId: 'qoder',
    scope: 'user',
    settingsService,
  });
  store.start();
  return { store, file };
}

describe('ModelConfigStore', () => {
  it('start 前写入先 hydration，会话覆盖不会被后续 start 覆盖', () => {
    const file = source({
      model: {
        preferences: {
          'qoder/auto': { temperature: 0.2, contextWindow: 64000 },
        },
      },
    });
    const store = new ModelConfigStore({
      providerId: 'qoder',
      scope: 'user',
      settingsService: {
        peekUserSettingsSource: () => file,
      } as unknown as SettingsService,
    });
    store.save('auto', { context: { contextWindow: 128000 } });
    store.start();
    expect(store.load('auto')).toEqual({
      sampling: { temperature: 0.2 },
      context: { contextWindow: 128000 },
    });
  });

  it('已带 provider 前缀的 key 不重复加前缀，沿用原磁盘位置', () => {
    const { store, file } = setup({
      model: { preferences: { 'qoder/auto': { contextWindow: 64000 } } },
    });
    expect(store.load('qoder/auto')).toEqual(store.load('auto'));
    store.save('qoder/auto', { context: { contextWindow: 128000 } }, true);
    expect(preference(file).contextWindow).toBe(128000);
    expect(
      (file.disk()['model'] as { preferences: object }).preferences,
    ).not.toHaveProperty('qoder/qoder/auto');
  });

  it('显式 undefined 清除指定偏好，内存与重新加载一致，保留兄弟字段', () => {
    const { store, file } = setup({
      model: {
        preferences: {
          'qoder/auto': {
            temperature: 0.2,
            topP: 0.8,
            maxTokens: 4096,
            contextWindow: 64000,
            reasoning: { effort: 'high', preserve: true },
          },
        },
      },
    });
    store.save(
      'auto',
      {
        reasoning: { effort: undefined },
        sampling: { temperature: undefined },
        context: { contextWindow: undefined, maxOutputTokens: undefined },
      },
      true,
    );
    expect(store.load('auto')).toEqual({
      reasoning: { preserve: true },
      sampling: { topP: 0.8 },
    });
    expect(preference(file)).toEqual({
      topP: 0.8,
      reasoning: { preserve: true },
    });
    store.stop();
    store.start();
    expect(store.load('auto')).toEqual({
      reasoning: { preserve: true },
      sampling: { topP: 0.8 },
    });
    store.save('auto', { reasoning: undefined, sampling: undefined }, true);
    store.stop();
    store.start();
    expect(store.load('auto')).toEqual({});
  });

  it('context 子字段恢复默认与持久化不影响兄弟字段', () => {
    const { store, file } = setup({
      model: {
        preferences: {
          'qoder/auto': { contextWindow: 64000, maxTokens: 8192 },
        },
      },
    });
    store.save('auto', { context: { maxOutputTokens: 4096 } });
    store.save('auto', { context: { contextWindow: undefined } }, true);
    expect(store.load('auto')).toEqual({ context: { maxOutputTokens: 4096 } });
    expect(preference(file)).toEqual({ maxTokens: 8192 });
    store.stop();
    store.start();
    expect(store.load('auto')).toEqual({ context: { maxOutputTokens: 8192 } });
    store.save('auto', { context: undefined }, true);
    expect(store.load('auto')).toEqual({});
    expect(preference(file)).toEqual({});
  });

  it('恢复 Default 时清除旧 disabled，改档位时不复活被清除的思考预算', () => {
    const { store } = setup({
      model: {
        preferences: {
          'qoder/auto': {
            reasoning: {
              thinking: { type: 'enabled', budgetTokens: 4096 },
              preserve: true,
            },
          },
        },
      },
    });
    store.save('auto', { reasoning: { effort: 'low', thinking: undefined } });
    expect(store.load('auto')).toEqual({
      reasoning: { effort: 'low', preserve: true },
    });
    store.save('auto', { reasoning: { effort: 'none' } });
    store.save('auto', {
      reasoning: { effort: undefined, thinking: undefined },
    });
    expect(store.load('auto')).toEqual({ reasoning: { preserve: true } });
  });

  it('settings 服务本身读取源失败时退化空表，保存失败保留内存', () => {
    const settingsService = {
      peekUserSettingsSource: () => {
        throw new Error('source unavailable');
      },
    } as unknown as SettingsService;
    const store = new ModelConfigStore({
      providerId: 'qoder',
      scope: 'user',
      settingsService,
    });
    expect(store.load('auto')).toBeUndefined();
    expect(store.save('auto', { context: { contextWindow: 64000 } }, true)).toBe(false);
    expect(store.load('auto')).toEqual({ context: { contextWindow: 64000 } });
  });
  it('读取 JSONC/BOM，按 providerId/ 前缀过滤归属', () => {
    const { store } = setup(
      {},
      '\uFEFF{ // 偏好\n "model": {"preferences": {"qoder/auto": {"reasoning": {"enabled": false}}, "local/x": {"contextWindow": 32000}, "qoder/x": {"contextWindow": 64000}}}}',
    );
    expect(store.load('auto')).toEqual({ reasoning: { effort: 'none' } });
    expect(store.load('x')).toEqual({ context: { contextWindow: 64000 } });
    expect(store.load('local/x')).toBeUndefined();
  });

  it('兼容早期无前缀的裸模型 key，新前缀 key 优先', () => {
    const { store } = setup({
      model: {
        preferences: {
          auto: { contextWindow: 1000000 },
          other: { reasoning: { effort: 'high' } },
          'qoder/auto': { contextWindow: 400000 },
        },
      },
    });
    expect(store.load('auto')).toEqual({ context: { contextWindow: 400000 } });
    expect(store.load('other')).toEqual({ reasoning: { effort: 'high' } });
  });

  it('裸 key 只归 qoder，custom provider 不认领', () => {
    const file = source({
      model: { preferences: { auto: { contextWindow: 1000000 } } },
    });
    const store = new ModelConfigStore({
      providerId: 'local',
      scope: 'user',
      settingsService: {
        peekUserSettingsSource: () => file,
      } as unknown as SettingsService,
    });
    store.start();
    expect(store.load('auto')).toBeUndefined();
  });

  it('none 与真实 effort 复用 canonical thinking 耦合，保留其他参数', () => {
    const { store, file } = setup({
      model: {
        preferences: {
          'qoder/auto': {
            temperature: 0.2,
            reasoning: {
              thinking: 'enabled',
              effort: 'high',
              budgetTokens: 123,
            },
          },
        },
      },
    });
    expect(store.save('auto', { reasoning: { effort: 'none' } }, true)).toBe(
      true,
    );
    const disabled = preference(file);
    expect(disabled.temperature).toBe(0.2);
    expect(disabled.reasoning?.enabled).toBe(false);
    expect(disabled.reasoning?.effort).toBeUndefined();
    expect(disabled.reasoning?.thinking).toBeUndefined();
    expect(store.save('auto', { reasoning: { effort: 'high' } }, true)).toBe(
      true,
    );
    expect(preference(file).reasoning).toMatchObject({
      enabled: true,
      effort: 'high',
    });
  });

  it('读出 thinking 与 preserve，改档位时内存与落盘同一套折叠', () => {
    const { store, file } = setup({
      model: {
        preferences: {
          'qoder/budget': {
            reasoning: {
              thinking: { type: 'enabled', budgetTokens: 4096 },
              preserve: true,
            },
          },
          'qoder/off': { reasoning: { thinking: { type: 'disabled' } } },
          'qoder/adaptive': {
            reasoning: { thinking: { type: 'adaptive' }, effort: 'low' },
          },
        },
      },
    });
    expect(store.load('budget')).toEqual({
      reasoning: {
        thinking: { type: 'enabled', budgetTokens: 4096 },
        preserve: true,
      },
    });
    expect(store.load('off')).toEqual({
      reasoning: { effort: 'none', thinking: { type: 'disabled' } },
    });

    // 关闭态改真实档位：思考重新打开，显式 disabled 被清掉。
    store.save('off', { reasoning: { effort: 'high' } }, true);
    expect(store.load('off')).toEqual({ reasoning: { effort: 'high' } });
    expect(preference(file, 'qoder/off').reasoning).toEqual({
      enabled: true,
      effort: 'high',
    });

    // 开启态改档位：保留 thinking 模式。
    store.save('adaptive', { reasoning: { effort: 'xhigh' } });
    expect(store.load('adaptive')).toEqual({
      reasoning: { effort: 'xhigh', thinking: { type: 'adaptive' } },
    });

    // none 关闭思考，预算一并清除，preserve 保留。
    store.save('budget', { reasoning: { effort: 'none' } });
    expect(store.load('budget')).toEqual({
      reasoning: { effort: 'none', preserve: true },
    });
  });

  it('只持久化显式 patch，不把先前 session-only 字段带到盘上', () => {
    const { store, file } = setup({
      theme: 'x',
      model: {
        preferences: {
          'qoder/auto': { contextWindow: 64000, reasoning: { effort: 'low' } },
          other: { contextWindow: 32000 },
        },
      },
    });
    store.save('auto', { context: { contextWindow: 128000 } });
    store.save('auto', { reasoning: { effort: 'high' } }, true);
    expect(preference(file)).toEqual({
      contextWindow: 64000,
      reasoning: { enabled: true, effort: 'high' },
    });
    expect(store.load('auto')?.context?.contextWindow).toBe(128000);
    expect(file.disk()['theme']).toBe('x');
  });

  it('project/local 字段合并，写入仍落 project', () => {
    const project = source({
      model: {
        preferences: {
          'local/x': {
            reasoning: { effort: 'high' },
          },
        },
      },
    });
    const local = source({
      model: {
        preferences: {
          'local/x': { contextWindow: 64000 },
        },
      },
    });
    const settingsService = {
      getProjectSettingsSources: () => ({ project, local }),
    } as unknown as SettingsService;
    const store = new ModelConfigStore({
      providerId: 'local',
      scope: 'project',
      cwd: '/model-test',
      settingsService,
    });
    store.start();
    expect(store.load('x')).toEqual({
      reasoning: { effort: 'high' },
      context: { contextWindow: 64000 },
    });
    store.save('x', { context: { contextWindow: 128000 } }, true);
    expect(project.mutate).toHaveBeenCalledOnce();
    expect(local.mutate).not.toHaveBeenCalled();
  });

  it('分组配置深合并，持久化仅保存本次 patch 并保留原磁盘格式', () => {
    const { store, file } = setup({
      model: {
        preferences: {
          'qoder/auto': {
            temperature: 0.2,
            topP: 0.8,
            maxTokens: 8192,
            reasoning: { effort: 'high', preserve: true },
          },
        },
      },
    });
    store.save('auto', {
      sampling: { temperature: 0 },
      reasoning: { preserve: false },
    });
    store.save('auto', { sampling: { topK: 20 }, context: { maxOutputTokens: 4096 } }, true);
    expect(store.load('auto')).toEqual({
      reasoning: { effort: 'high', preserve: false },
      sampling: { temperature: 0, topP: 0.8, topK: 20 },
      context: { maxOutputTokens: 4096 },
    });
    expect(preference(file)).toEqual({
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
      maxTokens: 4096,
      reasoning: { effort: 'high', preserve: true },
    });
    store.stop();
    store.start();
    expect(store.load('auto')?.sampling).toEqual({
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
    });
  });

  it('坏 project 不阻断 local 偏好读取', () => {
    const project = source({}, '{broken');
    const local = source({
      model: { preferences: { 'local/x': { contextWindow: 64000 } } },
    });
    const settingsService = {
      getProjectSettingsSources: () => ({ project, local }),
    } as unknown as SettingsService;
    const store = new ModelConfigStore({
      providerId: 'local',
      scope: 'project',
      cwd: '/model-test',
      settingsService,
    });
    store.start();
    expect(store.load('x')).toEqual({ context: { contextWindow: 64000 } });
  });

  it('未绑定或写盘失败返回 false，保留已应用内存态', () => {
    const store = new ModelConfigStore({
      providerId: 'qoder',
      scope: 'user',
      settingsService: {
        peekUserSettingsSource: () => undefined,
      } as unknown as SettingsService,
    });
    expect(store.save('auto', { reasoning: { effort: 'none' } }, true)).toBe(
      false,
    );
    expect(store.load('auto')).toEqual({ reasoning: { effort: 'none' } });
    const { store: failing, file } = setup({});
    file.mutate.mockImplementation(() => {
      throw new Error('read only');
    });
    expect(failing.save('auto', { context: { contextWindow: 64000 } }, true)).toBe(false);
    expect(failing.load('auto')?.context?.contextWindow).toBe(64000);
  });
});
