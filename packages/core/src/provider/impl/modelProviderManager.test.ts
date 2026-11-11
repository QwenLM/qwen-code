/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '@qwen-code/resource';
import type { Model } from '../model/model.js';
import type { ModelConfig } from '../model/model.js';
import type { ModelProvider } from '../modelProvider.js';
import { FatalAuthenticationError } from '../../utils/errors.js';
import { ModelProviderManager } from './modelProviderManager.js';
import { MainModelAnchor } from './mainModelAnchor.js';
import { CustomModelProvider } from './customModelProvider.js';
import { CustomProviderConfig } from './customProviderConfig.js';
import type { CustomClient } from '../../client/customClient.js';
import { ModelTransportManager } from '../transport/modelTransportManager.js';
import { OPENAI_CHAT_COMPLETIONS } from '../transport/modelProtocol.js';
import { tokenLimit, outputTokenLimit } from '../../core/tokenLimits.js';
import type { ModelListOptions } from '../model/modelResolver.js';
import {
  getDisplayString,
  isVisionSupportedModel,
} from '../../config/models.js';

afterEach(() => vi.restoreAllMocks());

describe('ModelProviderManager config routing', () => {
  it('keeps admission at the session boundary and rejects a reused resolution after access changes', async () => {
    const entry = { ...model('example'), displayName: 'Friendly' };
    const provider = fakeProvider(new Map());
    provider.listModels = async () => [entry];
    provider.getModel = async (key) => key === entry.key ? entry : undefined;
    provider.select = async () => ({ model: entry, config: {} });
    provider.inference = vi.fn();
    const manager = new ModelProviderManager({
      userProviders: [provider],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    let allowed = true;
    const denied = new Error('access revoked');
    manager.setModelAccessCheck(async () => {
      if (!allowed) throw denied;
    });
    manager.setMainModel(entry);
    const resolution = await manager.select({ purpose: 'main' });
    allowed = false;
    await expect(provider.getModel(entry.key)).resolves.toBe(entry);
    await expect(manager.listModels()).resolves.toEqual([]);
    await expect(manager.getModel(entry.key)).rejects.toBe(denied);
    await expect(manager.getModel('Friendly')).rejects.toBe(denied);
    await expect(manager.getModel('missing')).resolves.toBeUndefined();
    await expect(manager.select({ purpose: 'main' })).rejects.toBe(denied);
    await expect(manager.inference({ resolution, prompt: { messages: [] } })).rejects.toBe(denied);
    expect(provider.inference).not.toHaveBeenCalled();
  });

  it('preserves authentication errors when no provider resolves the requested model', async () => {
    const error = new FatalAuthenticationError('Not logged in');
    const provider = fakeProvider(new Map());
    provider.getModel = vi.fn().mockRejectedValue(error);
    const manager = new ModelProviderManager({
      userProviders: [provider],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    manager.setMainModel(model('example'));
    await expect(manager.getModel('example')).rejects.toBe(error);
    await expect(manager.select({ purpose: 'main' })).rejects.toBe(error);
  });

  it('can resolve an independent provider while another provider requires login', async () => {
    const primary = fakeProvider(new Map());
    primary.getModel = vi
      .fn()
      .mockRejectedValue(new FatalAuthenticationError('Not logged in'));
    const selected = { ...model('gateway/example'), source: 'gateway' };
    const custom = {
      ...fakeProvider(new Map()),
      providerId: 'gateway',
      getModel: async (key: string) =>
        key === selected.key ? selected : undefined,
    };
    const manager = new ModelProviderManager({
      userProviders: [primary, custom],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    await expect(manager.getModel(selected.key)).resolves.toBe(selected);
  });

  it('current 未锚定时返回 undefined，切换后读取锚点，停止后再次返回 undefined', () => {
    const anchor = new MainModelAnchor({});
    expect(anchor.current()).toBeUndefined();
    const ref = { providerId: 'qoder', modelKey: 'example' };
    anchor.switchTo(ref);
    expect(anchor.current()).toBe(ref);
    anchor.stop();
    expect(anchor.current()).toBeUndefined();
  });

  it('完整模型偏好读取不依赖锚点，必需主模型的路径仍拒绝执行', async () => {
    const provider = fakeProvider(new Map());
    provider.getModelConfig = vi.fn(provider.getModelConfig);
    provider.select = vi.fn(provider.select);
    const manager = new ModelProviderManager({
      userProviders: [provider],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    const target = model('example');
    expect(manager.getModelConfig(target)).toBeUndefined();
    expect(provider.getModelConfig).toHaveBeenCalledWith(target);
    await expect(manager.getMainModel()).rejects.toThrow(
      'no main model anchored',
    );
    await expect(manager.select({ purpose: 'main' })).rejects.toThrow(
      'no main model anchored',
    );
    expect(provider.select).not.toHaveBeenCalled();
  });

  it('初始 project custom 不能覆盖产品 provider，但可覆盖 user custom', async () => {
    const primary = fakeProvider(new Map());
    const user = fakeCustomProvider('local');
    const settingsService = new SettingsService();
    vi.spyOn(settingsService, 'getProjectSettingsSources').mockReturnValue({
      project: {
        read: () =>
          JSON.stringify({
            providers: {
              qoder: {
                baseUrl: 'https://unused.invalid',
                apiKey: '',
                model: 'shadow',
              },
              local: {
                baseUrl: 'https://unused.invalid',
                apiKey: '',
                model: 'project',
              },
            },
          }),
      },
      local: { read: () => undefined },
    } as never);
    const manager = new ModelProviderManager({
      userProviders: [primary, user],
      modelTransportManager: new ModelTransportManager([
        { protocol: OPENAI_CHAT_COMPLETIONS, stream: vi.fn() },
      ]),
      settingsService,
    });
    manager.setMainModel(model('example'));
    expect((await manager.getMainModel()).source).toBe('qoder');
    expect((await manager.listModels()).map((entry) => entry.key)).toEqual([
      'local/project',
    ]);
  });
  it('按完整 Model 委托所属 provider 读写偏好', async () => {
    const configs = new Map<string, ModelConfig>([
      ['example', { reasoning: { effort: 'high' } }],
    ]);
    const manager = new ModelProviderManager({
      userProviders: [fakeProvider(configs)],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    await manager.start();
    manager.setMainModel(model('example'));

    expect(manager.getModelConfig(model('example'))).toEqual({
      reasoning: { effort: 'high' },
    });
    manager.setModelConfig(model('example'), {
      context: { contextWindow: 100_000 },
    });
    expect(configs.get('example')).toEqual({
      reasoning: { effort: 'high' },
      context: { contextWindow: 100_000 },
    });
    await manager.stop();
  });

  it('完整 Model 精确编辑其他 owner，不改变主锚点', async () => {
    const primary = fakeProvider(new Map());
    const customConfigs = new Map<string, ModelConfig>();
    const custom = { ...fakeProvider(customConfigs), providerId: 'local' };
    const manager = new ModelProviderManager({
      userProviders: [primary, custom],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    manager.setMainModel(model('example'));
    const other = { ...model('local/x'), source: 'local' };
    manager.setModelConfig(other, { reasoning: { effort: 'none' } }, true);
    expect(manager.getModelConfig(other)).toEqual({
      reasoning: { effort: 'none' },
    });
    expect(custom.setModelConfig).toHaveBeenCalledWith(
      other,
      { reasoning: { effort: 'none' } },
      true,
    );
    expect(primary.setModelConfig).not.toHaveBeenCalled();
    expect((await manager.getMainModel()).key).toBe('example');
  });

  it('目录刷新选项透传给每个 provider', async () => {
    const provider = fakeProvider(new Map());
    provider.listModels = vi.fn(async () => [model('example')]);
    const manager = new ModelProviderManager({
      userProviders: [provider],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    const options: ModelListOptions = { skipCache: true };
    expect(await manager.listModels(options)).toHaveLength(1);
    expect(provider.listModels).toHaveBeenCalledWith(options);
  });

  it('项目集合固定于构造，新会话读取新配置且关闭旧会话不影响新实例', async () => {
    const first = lifecycleFixture('old');
    const second = lifecycleFixture('new');
    await first.manager.start();
    await second.manager.start();
    first.manager.setMainModel(model('example'));
    second.manager.setMainModel(model('example'));
    expect(await first.manager.getModel('local/old')).toBeDefined();
    expect(await first.manager.getModel('local/new')).toBeUndefined();
    expect(await second.manager.getModel('local/new')).toBeDefined();
    expect(await second.manager.getModel('local/old')).toBeUndefined();
    await first.manager.stop();
    expect(first.local.stop).toHaveBeenCalledOnce();
    expect(second.local.stop).not.toHaveBeenCalled();
    expect((await second.manager.getMainModel()).key).toBe('example');
    await second.manager.stop();
  });

  it('会话级与项目 provider 都随 manager 启停，顺序启动逆序停止且重复调用幂等', async () => {
    const { manager, user, local, other } = lifecycleFixture();
    await manager.start();
    await manager.start();
    await manager.stop();
    await manager.stop();
    expect(user.start).toHaveBeenCalledOnce();
    expect(user.stop).toHaveBeenCalledOnce();
    expect(local.start).toHaveBeenCalledOnce();
    expect(local.stop).toHaveBeenCalledOnce();
    expect(other.start).toHaveBeenCalledOnce();
    expect(other.stop).toHaveBeenCalledOnce();
    expect(user.start.mock.invocationCallOrder[0]).toBeLessThan(
      local.start.mock.invocationCallOrder[0],
    );
    expect(local.start.mock.invocationCallOrder[0]).toBeLessThan(
      other.start.mock.invocationCallOrder[0],
    );
    expect(other.stop.mock.invocationCallOrder[0]).toBeLessThan(
      local.stop.mock.invocationCallOrder[0],
    );
    expect(local.stop.mock.invocationCallOrder[0]).toBeLessThan(
      user.stop.mock.invocationCallOrder[0],
    );
  });
});

describe('ModelProviderManager 生命周期并发与失败', () => {
  it('未启动时 stop 不触及任何 provider', async () => {
    const { manager, user, local } = lifecycleFixture();
    await manager.stop();
    expect(user.stop).not.toHaveBeenCalled();
    expect(local.stop).not.toHaveBeenCalled();
  });

  it('并发 start 共享同一次启动，内部实例完成前不返回', async () => {
    const { manager, user, local, other } = lifecycleFixture();
    const gate = deferred();
    local.start.mockReturnValueOnce(gate.promise);
    const first = manager.start();
    const second = manager.start();
    expect(second).toBe(first);
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(local.start).toHaveBeenCalledOnce());
    expect(user.start).toHaveBeenCalledOnce();
    expect(other.start).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    expect(other.start).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it('启动失败共享拒绝，仅回滚已尝试的实例并允许重试', async () => {
    const { manager, user, local, other, untouched } = lifecycleFixture();
    manager.setMainModel(model('example'));
    const error = new Error('启动失败');
    const gate = deferred();
    local.start.mockReturnValueOnce(gate.promise);
    const first = manager.start();
    const second = manager.start();
    const result = Promise.allSettled([first, second]);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(local.start).toHaveBeenCalledOnce());
    gate.reject(error);
    expect(await result).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(user.stop).toHaveBeenCalledOnce();
    expect(local.stop).toHaveBeenCalledOnce();
    expect(other.stop).not.toHaveBeenCalled();
    expect(untouched.start).not.toHaveBeenCalled();
    expect(untouched.stop).not.toHaveBeenCalled();
    expect((await manager.getMainModel()).key).toBe('example');
    await manager.start();
    expect(user.start).toHaveBeenCalledTimes(2);
    expect(local.start).toHaveBeenCalledTimes(2);
    expect(other.start).toHaveBeenCalledOnce();
    expect(untouched.start).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it('多个回滚错误逆序汇总，保留启动原因且不清理未启动实例', async () => {
    const { manager, user, local, other, untouched } = lifecycleFixture();
    const error = new Error('启动失败');
    const localError = new Error('首个项目清理失败');
    const otherError = new Error('第二个项目清理失败');
    other.start.mockRejectedValueOnce(error);
    local.stop.mockRejectedValueOnce(localError);
    other.stop.mockRejectedValueOnce(otherError);
    await expect(manager.start()).rejects.toMatchObject({
      name: 'AggregateError',
      cause: error,
      errors: [error, otherError, localError],
    });
    expect(other.stop.mock.invocationCallOrder[0]).toBeLessThan(
      local.stop.mock.invocationCallOrder[0],
    );
    expect(untouched.stop).not.toHaveBeenCalled();
    expect(user.stop).toHaveBeenCalledOnce();
    await manager.start();
    await manager.stop();
  });

  it('锚点启动失败回滚所有 provider，可重试', async () => {
    const { manager, user, local, other, untouched } = lifecycleFixture();
    const error = new Error('锚点启动失败');
    vi.spyOn(MainModelAnchor.prototype, 'start').mockImplementationOnce(() => {
      throw error;
    });
    await expect(manager.start()).rejects.toBe(error);
    for (const provider of [user, local, other, untouched]) {
      expect(provider.stop).toHaveBeenCalledOnce();
    }
    await manager.start();
    expect(user.start).toHaveBeenCalledTimes(2);
    expect(local.start).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it('并发 stop 共享清理结果，等待逆序清理完成', async () => {
    const { manager, user, local, untouched } = lifecycleFixture();
    await manager.start();
    const gate = deferred();
    untouched.stop.mockReturnValueOnce(gate.promise);
    const first = manager.stop();
    const second = manager.stop();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(untouched.stop).toHaveBeenCalledOnce());
    expect(local.stop).not.toHaveBeenCalled();
    expect(user.stop).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, second]);
    expect(local.stop).toHaveBeenCalledOnce();
    expect(user.stop).toHaveBeenCalledOnce();
  });

  it('stop 汇总内部实例失败，清空锚点且不阻塞后续启动', async () => {
    const { manager, user, local, other } = lifecycleFixture();
    await manager.start();
    manager.setMainModel(model('example'));
    const localError = new Error('首个项目停止失败');
    const otherError = new Error('第二个项目停止失败');
    local.stop.mockRejectedValueOnce(localError);
    other.stop.mockRejectedValueOnce(otherError);
    const first = manager.stop();
    expect(manager.stop()).toBe(first);
    await expect(first).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [otherError, localError],
    });
    await expect(manager.getMainModel()).rejects.toThrow(
      'no main model anchored',
    );
    await manager.stop();
    expect(local.stop).toHaveBeenCalledOnce();
    expect(other.stop).toHaveBeenCalledOnce();
    expect(user.stop).toHaveBeenCalledOnce();
    await manager.start();
    expect(local.start).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it('交错 start → stop → start 保留时序，不合并跨 stop 的启动', async () => {
    const { manager, user, local } = lifecycleFixture();
    const gate = deferred();
    local.start.mockReturnValueOnce(gate.promise);
    const first = manager.start();
    const stopping = manager.stop();
    const last = manager.start();
    expect(last).not.toBe(first);
    await vi.waitFor(() => expect(local.start).toHaveBeenCalledOnce());
    expect(local.stop).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, stopping, last]);
    expect(local.start).toHaveBeenCalledTimes(2);
    expect(local.stop).toHaveBeenCalledOnce();
    expect(local.stop.mock.invocationCallOrder[0]).toBeLessThan(
      local.start.mock.invocationCallOrder[1],
    );
    expect(user.start).toHaveBeenCalledTimes(2);
    expect(user.stop).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it('失败后的排队 stop 不重复回滚，后续 start 正常执行', async () => {
    const { manager, user, local, other } = lifecycleFixture();
    const error = new Error('启动失败');
    local.start.mockRejectedValueOnce(error);
    const starting = manager.start();
    const stopping = manager.stop();
    const restarting = manager.start();
    await expect(starting).rejects.toBe(error);
    await Promise.all([stopping, restarting]);
    expect(user.stop).toHaveBeenCalledOnce();
    expect(local.stop).toHaveBeenCalledOnce();
    expect(other.stop).not.toHaveBeenCalled();
    expect(user.start).toHaveBeenCalledTimes(2);
    expect(local.start).toHaveBeenCalledTimes(2);
    expect(other.start).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it('新会话启停不等待旧会话正在启动的项目实例', async () => {
    const first = lifecycleFixture('old');
    const second = lifecycleFixture('new');
    const gate = deferred();
    first.local.start.mockReturnValueOnce(gate.promise);
    const starting = first.manager.start();
    await vi.waitFor(() => expect(first.local.start).toHaveBeenCalledOnce());
    await second.manager.start();
    await second.manager.stop();
    expect(second.local.stop).toHaveBeenCalledOnce();
    expect(first.local.stop).not.toHaveBeenCalled();
    gate.resolve();
    await starting;
    await first.manager.stop();
    expect(first.local.stop).toHaveBeenCalledOnce();
  });

  it('新会话启动失败只回滚自己的实例，旧会话查询与生命周期不变', async () => {
    const first = lifecycleFixture('old');
    const second = lifecycleFixture('new');
    await first.manager.start();
    const error = new Error('新会话启动失败');
    second.other.start.mockRejectedValueOnce(error);
    await expect(second.manager.start()).rejects.toBe(error);
    expect(second.user.stop).toHaveBeenCalledOnce();
    expect(second.other.stop).toHaveBeenCalledOnce();
    expect(second.local.stop).toHaveBeenCalledOnce();
    expect(second.untouched.stop).not.toHaveBeenCalled();
    expect(first.local.stop).not.toHaveBeenCalled();
    expect(first.user.stop).not.toHaveBeenCalled();
    expect(await first.manager.getModel('local/old')).toBeDefined();
    await second.manager.start();
    await second.manager.stop();
    await first.manager.stop();
  });

  it('旧会话清理失败不影响新会话的模型集合与资源', async () => {
    const first = lifecycleFixture('old');
    const second = lifecycleFixture('new');
    await first.manager.start();
    await second.manager.start();
    const error = new Error('旧会话停止失败');
    first.local.stop.mockRejectedValueOnce(error);
    await expect(first.manager.stop()).rejects.toMatchObject({
      errors: [error],
    });
    expect(second.local.stop).not.toHaveBeenCalled();
    expect(await second.manager.getModel('local/new')).toBeDefined();
    expect(await second.manager.getModel('local/old')).toBeUndefined();
    await second.manager.stop();
    expect(second.local.stop).toHaveBeenCalledOnce();
  });
});

describe('ModelProviderManager Custom Provider refresh', () => {
  const settings = (name = 'example') => ({
    local: {
      baseUrl: 'https://updated.invalid/v1',
      apiKey: 'updated-secret',
      model: name,
      models: [{ model: name, contextWindow: 256000 }],
    },
  });

  it('replaces custom instances while retaining the product provider, anchor and session preferences', async () => {
    const { manager, user, local, other, untouched } = lifecycleFixture();
    await manager.start();
    const main = (await manager.getModel('local/example'))!;
    manager.setMainModel(main);
    manager.setModelConfig(main, { sampling: { temperature: 0.4 } });

    await manager.replaceCustomProviders(undefined, settings());

    expect(user.start).toHaveBeenCalledOnce();
    expect(user.stop).not.toHaveBeenCalled();
    for (const old of [local, other, untouched]) {
      expect(old.stop).toHaveBeenCalledOnce();
    }
    expect(await manager.getMainModel()).toMatchObject({
      key: main.key,
      limits: { maxContextTokens: 256000 },
    });
    expect((await manager.select({ purpose: 'main' })).config).toMatchObject({
      sampling: { temperature: 0.4 },
    });
    await manager.stop();
    expect(user.stop).toHaveBeenCalledOnce();
    expect(local.stop).toHaveBeenCalledOnce();
  });

  it('keeps account providers across a settings refresh', async () => {
    const { manager } = lifecycleFixture();
    await manager.start();
    const listed = model('qoder/auto');
    const account = {
      providerId: 'account',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      listModels: async () => [listed],
      getModel: async (key: string) => (key === listed.key ? listed : undefined),
    } as unknown as ModelProvider;

    await manager.registerAccountProvider(account);
    expect(account.start).toHaveBeenCalledOnce();

    await manager.replaceCustomProviders(undefined, settings());
    const afterRefresh = await manager.listModels();
    expect(afterRefresh.some((entry) => entry.key === listed.key)).toBe(true);

    await manager.stop();
    expect(account.stop).toHaveBeenCalledOnce();
  });

  it('rolls back failed replacement startup, keeps the old route and allows retry', async () => {
    const { manager, user, local } = lifecycleFixture();
    await manager.start();
    manager.setMainModel((await manager.getModel('local/example'))!);
    const error = new Error('replacement startup failed');
    vi.spyOn(CustomModelProvider.prototype, 'start').mockRejectedValueOnce(
      error,
    );
    const cleanup = vi.spyOn(CustomModelProvider.prototype, 'stop');

    await expect(
      manager.replaceCustomProviders(undefined, settings('new')),
    ).rejects.toBe(error);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(local.stop).not.toHaveBeenCalled();
    expect(user.stop).not.toHaveBeenCalled();
    expect((await manager.getMainModel()).key).toBe('local/example');
    expect(await manager.getModel('local/new')).toBeUndefined();
    await manager.replaceCustomProviders(undefined, settings());
    expect((await manager.getMainModel()).limits.maxContextTokens).toBe(256000);
    await manager.stop();
  });

  it('serializes refresh and shutdown so replacement instances are also stopped', async () => {
    const { manager, user, local } = lifecycleFixture();
    await manager.start();
    const gate = deferred();
    const starting = vi
      .spyOn(CustomModelProvider.prototype, 'start')
      .mockReturnValueOnce(gate.promise);
    const cleanup = vi.spyOn(CustomModelProvider.prototype, 'stop');
    const refresh = manager.replaceCustomProviders(undefined, settings('new'));
    const stopping = manager.stop();
    await vi.waitFor(() => expect(starting).toHaveBeenCalledOnce());
    expect(local.stop).not.toHaveBeenCalled();
    expect(await manager.getModel('local/new')).toBeUndefined();

    gate.resolve();
    await Promise.all([refresh, stopping]);

    expect(local.stop).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(user.stop).toHaveBeenCalledOnce();
    await expect(manager.getMainModel()).rejects.toThrow(
      'no main model anchored',
    );
  });

  it('applies queued refreshes in order instead of merging distinct configurations', async () => {
    const { manager } = lifecycleFixture();
    await manager.start();
    const gate = deferred();
    const starting = vi
      .spyOn(CustomModelProvider.prototype, 'start')
      .mockReturnValueOnce(gate.promise);
    const first = manager.replaceCustomProviders(undefined, settings('first'));
    const second = manager.replaceCustomProviders(
      undefined,
      settings('second'),
    );
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(starting).toHaveBeenCalledOnce());
    gate.resolve();
    await Promise.all([first, second]);
    expect(await manager.getModel('local/first')).toBeUndefined();
    expect(await manager.getModel('local/second')).toBeDefined();
    await manager.stop();
  });
});

describe('ModelProviderManager 会话 provider 查询隔离', () => {
  it('同名模型的限额、展示名、视觉能力和默认模型始终来自各自会话', async () => {
    const firstModel = {
      ...model('shared-model'),
      displayName: 'Session A',
      isDefault: true,
      limits: { maxContextTokens: 32_000, maxOutputTokens: 1_000 },
    };
    const secondModel = {
      ...model('shared-model'),
      displayName: 'Session B',
      isDefault: true,
      capabilities: { ...firstModel.capabilities, vision: true },
      limits: { maxContextTokens: 128_000, maxOutputTokens: 4_000 },
    };
    const createSession = (listed: Model) => {
      const provider = fakeProvider(new Map());
      const listModels = vi.fn(async () => [listed]);
      provider.listModels = listModels;
      provider.getModel = async (key) =>
        (await listModels()).find((entry) => entry.key === key);
      const manager = new ModelProviderManager({
        userProviders: [provider],
        modelTransportManager: new ModelTransportManager([]),
        settingsService: new SettingsService(),
      });
      return { manager, listModels };
    };
    const first = createSession(firstModel);
    const second = createSession(secondModel);
    const firstEntry = await first.manager.getModel('shared-model');
    const secondEntry = await second.manager.getModel('shared-model');
    expect(tokenLimit(firstEntry)).toBe(32_000);
    expect(tokenLimit(secondEntry)).toBe(128_000);
    expect(outputTokenLimit(firstEntry)).toBe(1_000);
    expect(outputTokenLimit(secondEntry)).toBe(4_000);
    expect(getDisplayString(firstEntry)).toBe('Session A');
    expect(getDisplayString(secondEntry)).toBe('Session B');
    expect(isVisionSupportedModel(firstEntry)).toBe(false);
    expect(isVisionSupportedModel(secondEntry)).toBe(true);
    expect(
      (await first.manager.listModels()).find(
        (entry) => entry.isDefault && entry.enabled !== false,
      ),
    ).toBe(firstModel);
    expect(
      (await second.manager.listModels()).find(
        (entry) => entry.isDefault && entry.enabled !== false,
      ),
    ).toBe(secondModel);

    second.listModels.mockResolvedValue([
      { ...secondModel, limits: { maxContextTokens: 256_000 } },
    ]);
    expect(tokenLimit(await first.manager.getModel('shared-model'))).toBe(
      32_000,
    );
    expect(tokenLimit(await second.manager.getModel('shared-model'))).toBe(
      256_000,
    );
  });

  it('查询直接委派 provider，命中时不额外列举目录', async () => {
    const listed = model('example');
    const provider = fakeProvider(new Map());
    provider.getModel = vi.fn(async () => listed);
    provider.listModels = vi.fn(async () => []);
    const manager = new ModelProviderManager({
      userProviders: [provider],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    expect(await manager.getModel('example')).toBe(listed);
    const changed = { ...listed, displayName: 'Updated' };
    vi.mocked(provider.getModel).mockResolvedValue(changed);
    expect(await manager.getModel('example')).toBe(changed);
    expect(provider.listModels).not.toHaveBeenCalled();
  });

  it('查询在所有 provider 中优先精确匹配，再忽略大小写匹配', async () => {
    const upper = model('EXAMPLE');
    const exact = { ...model('example'), source: 'local' };
    const first = fakeProvider(new Map());
    first.listModels = async () => [upper];
    first.getModel = async (key) => (key === upper.key ? upper : undefined);
    const second = fakeCustomProvider('local');
    second.listModels = async () => [exact];
    second.getModel = async (key) => (key === exact.key ? exact : undefined);
    const manager = new ModelProviderManager({
      userProviders: [first, second],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });

    expect(await manager.listModels()).toEqual([upper, exact]);
    expect(await manager.getModel('example')).toBe(exact);
    expect(await manager.getModel('ExAmPlE')).toBe(upper);
    expect(await manager.getModel('missing')).toBeUndefined();
  });

  it('默认模型从列举结果中跳过不可用条目，并反映 provider 内存变更', async () => {
    const disabled = { ...model('disabled'), isDefault: true, enabled: false };
    const regular = model('regular');
    const available = {
      ...model('local/default'),
      source: 'local',
      isDefault: true,
    };
    const first = fakeProvider(new Map());
    first.listModels = async () => [disabled, regular];
    const second = fakeCustomProvider('local');
    second.listModels = async () => [available];
    const manager = new ModelProviderManager({
      userProviders: [first, second],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });

    expect(
      (await manager.listModels()).find(
        (entry) => entry.isDefault && entry.enabled !== false,
      ),
    ).toBe(available);
    second.listModels = async () => [];
    expect(
      (await manager.listModels()).find(
        (entry) => entry.isDefault && entry.enabled !== false,
      ),
    ).toBeUndefined();
  });

  it('外部渠道列举视图由 provider 管理，manager 不缓存', async () => {
    const cached = model('cached');
    const external = model('external');
    const provider = fakeProvider(new Map());
    provider.getModel = async (key) =>
      key === cached.key ? cached : undefined;
    provider.listModels = vi.fn(async (options?: ModelListOptions) =>
      options?.outerProviders ? [external] : [cached],
    );
    const manager = new ModelProviderManager({
      userProviders: [provider],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });

    expect(await manager.listModels()).toEqual([cached]);
    const options = { outerProviders: ['openai'] };
    expect(await manager.listModels(options)).toEqual([external]);
    expect(provider.listModels).toHaveBeenLastCalledWith(options);
    expect(await manager.listModels()).toEqual([cached]);
    expect(await manager.getModel('external')).toBeUndefined();
  });

  it('getModel 聚合其他 provider 的查询，无需主模型锚点', async () => {
    const first = fakeProvider(new Map());
    first.getModel = vi.fn(async () => undefined);
    const listed = { ...model('local/other'), source: 'local' };
    const second = fakeCustomProvider('local');
    second.getModel = vi.fn(async (key) =>
      key === listed.key ? listed : undefined,
    );
    const manager = new ModelProviderManager({
      userProviders: [first, second],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    expect(await manager.getModel(listed.key)).toBe(listed);
    expect(first.getModel).toHaveBeenCalledWith(listed.key);
    expect(second.getModel).toHaveBeenCalledWith(listed.key);
    expect(await manager.getModel('missing')).toBeUndefined();
  });

  it('项目 settings 变化只影响新建的 manager，旧会话不读入新集合', async () => {
    const settingsService = new SettingsService();
    let key = 'old';
    vi.spyOn(settingsService, 'getProjectSettingsSources').mockReturnValue({
      project: {
        read: () =>
          JSON.stringify({
            providers: {
              local: {
                baseUrl: 'https://unused.invalid',
                apiKey: '',
                model: key,
              },
            },
          }),
      },
      local: { read: () => undefined },
    } as never);
    const modelTransportManager = new ModelTransportManager([
      { protocol: OPENAI_CHAT_COMPLETIONS, stream: vi.fn() },
    ]);
    const first = new ModelProviderManager({
      userProviders: [],
      modelTransportManager,
      settingsService,
    });
    key = 'new';
    const second = new ModelProviderManager({
      userProviders: [],
      modelTransportManager,
      settingsService,
    });
    expect(await first.getModel('local/old')).toBeDefined();
    expect(await first.getModel('local/new')).toBeUndefined();
    expect(await second.getModel('local/old')).toBeUndefined();
    expect(await second.getModel('local/new')).toBeDefined();
  });

  it('CustomModelProvider 的异步查询直接读取配置模型', async () => {
    const listed = { ...model('local/custom'), source: 'local' };
    const config = new CustomProviderConfig({
      providerId: 'local',
      baseUrl: 'https://unused.invalid',
      protocol: OPENAI_CHAT_COMPLETIONS,
      models: [listed],
    });
    const provider = new CustomModelProvider({
      config,
      client: {} as CustomClient,
      transportManager: {
        resolve: () => ({}),
      } as unknown as ModelTransportManager,
      settingsService: new SettingsService(),
      scope: 'user',
    });
    const models = await provider.listModels();
    expect(models).not.toBe(config.models);
    expect(models[0]).toBe(listed);
    expect(await provider.getModel(listed.key)).toBe(listed);
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function lifecycleFixture(modelKey = 'example') {
  const user = {
    ...fakeProvider(new Map()),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const settingsService = new SettingsService();
  vi.spyOn(settingsService, 'getProjectSettingsSources').mockReturnValue({
    project: {
      read: () =>
        JSON.stringify({
          providers: Object.fromEntries(
            ['local', 'other', 'untouched'].map((id) => [
              id,
              {
                baseUrl: 'https://unused.invalid',
                apiKey: '',
                model: modelKey,
              },
            ]),
          ),
        }),
    },
    local: { read: () => undefined },
  } as never);
  const manager = new ModelProviderManager({
    userProviders: [user],
    modelTransportManager: new ModelTransportManager([
      { protocol: OPENAI_CHAT_COMPLETIONS, stream: vi.fn() },
    ]),
    settingsService,
  });
  // 检查 manager 真正自建的实例，不以外部贡献伪装内部生命周期。
  const providers = Reflect.get(
    manager,
    'localProviders',
  ) as CustomModelProvider[];
  const [local, other, untouched] = providers.map((provider) =>
    Object.assign(provider, {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }),
  );
  return { manager, user, local: local!, other: other!, untouched: untouched! };
}

/** 保留 instanceof 身份，显式定义只读 getter，避免给原型访问器赋值。 */
function fakeCustomProvider(providerId: string): CustomModelProvider {
  const provider = Object.create(
    CustomModelProvider.prototype,
  ) as CustomModelProvider;
  Object.defineProperties(
    provider,
    Object.getOwnPropertyDescriptors({
      ...fakeProvider(new Map()),
      providerId,
    }),
  );
  return provider;
}

/** 内存版 owner provider：偏好存 Map，getModel 按 key 回落 mainModel 桩。 */
function fakeProvider(configs: Map<string, ModelConfig>): ModelProvider {
  return {
    providerId: 'qoder',
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    listModels: () => Promise.resolve([]),
    getModel: (key: string) =>
      Promise.resolve(key === 'example' ? model(key) : undefined),
    getModelConfig: (model: Model) => configs.get(model.key),
    setModelConfig: vi.fn((model: Model, patch: ModelConfig) => {
      configs.set(model.key, { ...configs.get(model.key), ...patch });
      return true;
    }),
    select: () => {
      throw new Error('not used in this suite');
    },
    inference: () => {
      throw new Error('not used in this suite');
    },
  } as unknown as ModelProvider;
}

const model = (key: string): Model => ({
  source: 'qoder',
  key,
  displayName: key,
  capabilities: {
    tools: true,
    vision: false,
    reasoning: { supported: true, supportedEfforts: ['low', 'high'] },
    contextWindows: [],
  },
  limits: { maxContextTokens: 200_000 },
});

/** 内存版 user settings：mutate 语义与 settings 服务一致（返回 true 才落盘）。 */
function settingsStore(initial: Record<string, unknown> | undefined) {
  let disk = initial ? structuredClone(initial) : undefined;
  const mutate = vi.fn(
    (mutation: (latest: Record<string, unknown>) => boolean) => {
      const latest = structuredClone(disk ?? {});
      if (mutation(latest)) disk = latest;
    },
  );
  const settingsService = {
    peekUserSettingsSource: () =>
      initial === undefined ? undefined : { mutate },
  } as unknown as SettingsService;
  return { settingsService, mutate, read: () => disk };
}

describe('ModelProviderManager settings write-back', () => {
  it('settings 源读取异常返回保存失败，不影响已切换锚点', async () => {
    const store = settingsStore({});
    vi.spyOn(
      store.settingsService,
      'peekUserSettingsSource',
    ).mockImplementation(() => {
      throw new Error('source unavailable');
    });
    const manager = new ModelProviderManager({
      userProviders: [fakeProvider(new Map())],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: store.settingsService,
    });
    expect(manager.setMainModel(model('example'), true)).toBe(false);
    expect((await manager.getMainModel()).key).toBe('example');
  });
  it('未绑定保存返回失败，主锚点仍立即生效', async () => {
    const manager = new ModelProviderManager({
      userProviders: [fakeProvider(new Map())],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: settingsStore(undefined).settingsService,
    });
    expect(manager.setMainModel(model('example'), true)).toBe(false);
    expect((await manager.getMainModel()).key).toBe('example');
  });
  it('keeps selection session-only without persist', async () => {
    const store = settingsStore({});
    const configs = new Map<string, ModelConfig>();
    const manager = new ModelProviderManager({
      userProviders: [fakeProvider(configs)],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: store.settingsService,
    });

    const expected = model('example');
    manager.setMainModel(expected);

    expect(await manager.getMainModel()).toEqual(expected);
    expect(store.mutate).not.toHaveBeenCalled();
  });

  it('persists main model key to model.name', () => {
    const store = settingsStore({ model: { preferences: {} }, theme: 'x' });
    const manager = new ModelProviderManager({
      userProviders: [],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: store.settingsService,
    });

    expect(manager.setMainModel(model('ultimate'), true)).toBe(true);

    expect(store.read()).toEqual({
      model: { name: 'ultimate', preferences: {} },
      theme: 'x',
    });
  });

  it('将完整 Model 与 persist 原样转发到所属 provider', () => {
    const configs = new Map<string, ModelConfig>();
    const provider = fakeProvider(configs);
    const manager = new ModelProviderManager({
      userProviders: [provider],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: settingsStore(undefined).settingsService,
    });
    manager.setMainModel(model('example'));

    manager.setModelConfig(
      model('example'),
      { reasoning: { effort: 'high' }, context: { contextWindow: 200_000 } },
      true,
    );

    expect(provider.setModelConfig).toHaveBeenCalledWith(
      model('example'),
      { reasoning: { effort: 'high' }, context: { contextWindow: 200_000 } },
      true,
    );
    expect(manager.getModelConfig(model('example'))).toEqual({
      reasoning: { effort: 'high' },
      context: { contextWindow: 200_000 },
    });
  });

  it('按 Model 能力校验写入，不支持时抛错且不落到 owner', () => {
    const provider = fakeProvider(new Map());
    const onModelConfigChange = vi.fn();
    const manager = new ModelProviderManager({
      userProviders: [provider],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
      onModelConfigChange,
    });
    const target = model('example');

    expect(() =>
      manager.setModelConfig(target, { reasoning: { effort: 'xhigh' } }),
    ).toThrow("does not support reasoning effort 'xhigh'");
    expect(() =>
      manager.setModelConfig(target, { context: { contextWindow: 300_000 } }),
    ).toThrow('does not support context window 300000');
    expect(provider.setModelConfig).not.toHaveBeenCalled();
    expect(onModelConfigChange).not.toHaveBeenCalled();

    manager.setModelConfig(target, {
      reasoning: { effort: 'none' },
      context: { contextWindow: undefined },
    });
    expect(onModelConfigChange).toHaveBeenCalledWith(
      target,
      { reasoning: { effort: 'none' }, context: { contextWindow: undefined } },
      undefined,
    );
  });
});
