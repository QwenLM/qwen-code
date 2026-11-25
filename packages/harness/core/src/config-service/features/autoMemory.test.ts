/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
  runLogger: {
    log: vi.fn(),
  },
}));

vi.mock('../index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));

vi.mock('../../utils/runLogger.js', () => ({
  runLogger: mocks.runLogger,
}));

describe('config-service/features/autoMemory', () => {
  let feature: typeof import('./autoMemory.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.getConfigValue.mockReset();
    mocks.subscribeConfigValue.mockReset();
    feature = await import('./autoMemory.js');
  });

  it('registers the default-off auto_memory gate', () => {
    feature.registerAutoMemoryFeature();

    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      'auto_memory',
      expect.any(Function),
    );
    expect(feature.getAutoMemoryFeatureGateConfig()).toEqual({
      projectEnabled: false,
      userEnabled: false,
    });
    expect(feature.resolveAutoMemoryEnabled()).toBe(false);
  });

  it('ignores the retired value.enabled field', () => {
    mocks.getConfigValue.mockReturnValue({ enabled: true });
    expect(feature.isAutoMemoryFeatureGateEnabled()).toBe(false);
    expect(feature.isAutoMemoryProjectFeatureGateEnabled()).toBe(false);
    expect(feature.isAutoMemoryUserFeatureGateEnabled()).toBe(false);
    expect(feature.resolveAutoMemoryEnabled()).toBe(false);

    mocks.getConfigValue.mockReturnValue(undefined);
    expect(feature.resolveAutoMemoryEnabled()).toBe(false);

    mocks.getConfigValue.mockReturnValue({ enabled: false });
    expect(feature.isAutoMemoryFeatureGateEnabled()).toBe(false);
    expect(feature.resolveAutoMemoryEnabled()).toBe(false);

    mocks.getConfigValue.mockReturnValue({});
    expect(feature.resolveAutoMemoryEnabled()).toBe(false);

    mocks.getConfigValue.mockReturnValue({ text: 'test' });
    expect(feature.resolveAutoMemoryEnabled()).toBe(false);
  });

  it('resolves project and user rollout defaults independently', () => {
    mocks.getConfigValue.mockReturnValue({
      project_enabled: false,
      user_enabled: true,
      extraction_every_n_turns: 9,
    });
    expect(feature.getAutoMemoryFeatureGateConfig()).toEqual({
      projectEnabled: false,
      userEnabled: true,
    });

    mocks.getConfigValue.mockReturnValue({
      projectEnabled: true,
      userEnabled: false,
    });
    expect(feature.getAutoMemoryFeatureGateConfig()).toEqual({
      projectEnabled: true,
      userEnabled: false,
    });
  });

  it('accepts a JSON-encoded gate value', () => {
    mocks.getConfigValue.mockReturnValue(
      '{"project_enabled":true,"user_enabled":false}',
    );
    expect(feature.resolveAutoMemoryEnabled()).toBe(true);
    expect(feature.isAutoMemoryProjectFeatureGateEnabled()).toBe(true);
    expect(feature.isAutoMemoryUserFeatureGateEnabled()).toBe(false);
  });

  it('notifies the runtime only when either scope state changes', () => {
    feature.registerAutoMemoryFeature();
    const valueListener = mocks.subscribeConfigValue.mock.calls[0]?.[1] as (
      value: unknown,
    ) => void;
    const listener = vi.fn();
    feature.setAutoMemoryFeatureGateChangeHandler(listener);

    valueListener({ project_enabled: true });
    valueListener({ project_enabled: true });
    valueListener({ user_enabled: true });
    valueListener({});

    expect(listener).toHaveBeenNthCalledWith(1, {
      projectEnabled: true,
      userEnabled: false,
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      projectEnabled: false,
      userEnabled: true,
    });
    expect(listener).toHaveBeenNthCalledWith(3, {
      projectEnabled: false,
      userEnabled: false,
    });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
