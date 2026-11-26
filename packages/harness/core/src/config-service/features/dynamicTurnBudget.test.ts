/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testProviderModel } from '../../test-utils/model-resolution.js';
import { resolveDynamicTurnLimits } from './dynamicTurnBudget.js';

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  get: vi.fn(),
}));
vi.mock('../index.js', () => ({
  ensureConfigReadyForRequest: mocks.ready,
  getConfigValue: mocks.get,
  subscribeConfigValue: vi.fn(),
}));

describe('dynamic turn budget QCS policy', () => {
  const model = {
    ...testProviderModel('qmodel_38max'),
    displayName: 'Qwen3.8-Max',
  };
  beforeEach(() => vi.resetAllMocks());

  it.each(['Qwen3.8-Max', 'qwen38max', 'qwen3.8-max'])(
    'does not match a display name or backend name as the selected key: %s',
    async (name) => {
      mocks.get.mockReturnValue({
        enabled: true,
        models: { [name]: { enabled: true } },
      });
      expect(await resolveDynamicTurnLimits(model)).toBeUndefined();
    },
  );

  it('waits for current configuration and applies default cumulative limits only to listed models', async () => {
    mocks.ready.mockImplementation(async () => {
      mocks.get.mockReturnValue({
        enabled: true,
        models: { qmodel_38max: { enabled: true } },
      });
    });
    expect(await resolveDynamicTurnLimits(model)).toEqual([24, 48, 96, 192, 384]);
    expect(
      await resolveDynamicTurnLimits(testProviderModel('other')),
    ).toBeUndefined();
    expect(
      await resolveDynamicTurnLimits({ ...model, source: 'custom' }),
    ).toBeUndefined();
    expect(mocks.ready).toHaveBeenCalledTimes(2);
  });

  it('reads JSON configuration afresh without changing a previous query snapshot', async () => {
    const limits = [2, 4, 7];
    mocks.get.mockReturnValue({
      enabled: true,
      models: { qmodel_38max: { enabled: true, limits } },
    });
    const snapshot = await resolveDynamicTurnLimits(model);
    limits[0] = 1;
    expect(snapshot).toEqual([2, 4, 7]);
    mocks.get.mockReturnValue(
      JSON.stringify({
        enabled: true,
        models: { qmodel_38max: { enabled: true, limits: [3, 8] } },
      }),
    );
    expect(await resolveDynamicTurnLimits(model)).toEqual([3, 8]);
    mocks.get.mockReturnValue(undefined);
    expect(await resolveDynamicTurnLimits(model)).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    '',
    'invalid',
    true,
    [],
    {},
    { enabled: false, models: { qmodel_38max: { enabled: true } } },
    { enabled: 'true', models: { qmodel_38max: { enabled: true } } },
    { enabled: true },
    { enabled: true, models: [] },
    { enabled: true, models: ['qmodel_38max'], limits: [14, 24, 47] },
    { enabled: true, models: { ' qmodel_38max': { enabled: true } } },
    ...[null, [], {}, true, { enabled: false }, { enabled: 'true' }].map(
      (policy) => ({ enabled: true, models: { qmodel_38max: policy } }),
    ),
    ...[
      null,
      [],
      [0, 2],
      [2, 2],
      [3, 2],
      [1.5, 2],
      ['14', 24],
      [Infinity],
      [Number.MAX_SAFE_INTEGER + 1],
    ].map((limits) => ({
      enabled: true,
      models: { qmodel_38max: { enabled: true, limits } },
    })),
  ])('disables missing or malformed configuration: %j', async (config) => {
    mocks.get.mockReturnValue(config);
    expect(await resolveDynamicTurnLimits(model)).toBeUndefined();
  });

  it('isolates model switches and cumulative limits in one resolved configuration', async () => {
    const config = {
      enabled: true,
      models: {
        qmodel_38max: { enabled: true, limits: [24, 36, 60] },
        ultimate: { enabled: false, limits: [32, 48, 72] },
      },
    };
    mocks.get.mockReturnValue(config);
    const ultimate = testProviderModel('ultimate');
    expect(await resolveDynamicTurnLimits(model)).toEqual([24, 36, 60]);
    expect(await resolveDynamicTurnLimits(ultimate)).toBeUndefined();
    config.models.ultimate.enabled = true;
    expect(await resolveDynamicTurnLimits(ultimate)).toEqual([32, 48, 72]);
    expect(await resolveDynamicTurnLimits(model)).toEqual([24, 36, 60]);
    config.enabled = false;
    expect(await resolveDynamicTurnLimits(model)).toBeUndefined();
    expect(await resolveDynamicTurnLimits(ultimate)).toBeUndefined();
  });

  it('disables only the invalid model and does not match inherited property names', async () => {
    mocks.get.mockReturnValue({
      enabled: true,
      models: {
        qmodel_38max: { enabled: true, limits: [24, 36, 60] },
        ultimate: { enabled: true, limits: [48, 32] },
      },
    });
    expect(await resolveDynamicTurnLimits(model)).toEqual([24, 36, 60]);
    expect(
      await resolveDynamicTurnLimits(testProviderModel('ultimate')),
    ).toBeUndefined();
    expect(
      await resolveDynamicTurnLimits(testProviderModel('constructor')),
    ).toBeUndefined();
    expect(
      await resolveDynamicTurnLimits(testProviderModel('__proto__')),
    ).toBeUndefined();
  });

  it('replaces a gray configuration without retaining a removed model policy', async () => {
    mocks.get.mockReturnValue({
      enabled: true,
      models: { ultimate: { enabled: true, limits: [32, 48, 72] } },
    });
    const ultimate = testProviderModel('ultimate');
    const previous = await resolveDynamicTurnLimits(ultimate);
    mocks.get.mockReturnValue({
      enabled: true,
      models: { qmodel_38max: { enabled: true, limits: [24, 36, 60] } },
    });
    expect(await resolveDynamicTurnLimits(ultimate)).toBeUndefined();
    expect(await resolveDynamicTurnLimits(model)).toEqual([24, 36, 60]);
    expect(previous).toEqual([32, 48, 72]);
  });

  it('propagates cancellation while waiting for configuration', async () => {
    const signal = AbortSignal.abort();
    mocks.ready.mockRejectedValue(signal.reason);
    await expect(resolveDynamicTurnLimits(model, signal)).rejects.toBe(
      signal.reason,
    );
    expect(mocks.ready).toHaveBeenCalledWith({ signal });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('keeps existing limits when configuration readiness fails', async () => {
    mocks.ready.mockRejectedValue(new Error('Configuration unavailable'));
    mocks.get.mockReturnValue({
      enabled: true,
      models: { qmodel_38max: { enabled: true } },
    });
    expect(await resolveDynamicTurnLimits(model)).toBeUndefined();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
