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

describe('config-service/features/autoDream', () => {
  let feature: typeof import('./autoDream.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getConfigValue.mockReset();
    mocks.subscribeConfigValue.mockReset();
    feature = await import('./autoDream.js');
  });

  it('registers the default-off auto_dream gate', () => {
    feature.registerAutoDreamFeature();

    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      'auto_dream',
      expect.any(Function),
    );
    expect(feature.isAutoDreamFeatureGateEnabled()).toBe(false);
  });

  it('enables only when value.enabled is true', () => {
    mocks.getConfigValue.mockReturnValue({ enabled: true });
    expect(feature.isAutoDreamFeatureGateEnabled()).toBe(true);

    for (const value of [
      { enabled: false },
      {},
      { text: 'test' },
      true,
      undefined,
    ]) {
      mocks.getConfigValue.mockReturnValue(value);
      expect(feature.isAutoDreamFeatureGateEnabled()).toBe(false);
    }
  });

  it('accepts a JSON-encoded gate value', () => {
    mocks.getConfigValue.mockReturnValue('{"enabled":true}');
    expect(feature.isAutoDreamFeatureGateEnabled()).toBe(true);
  });

  it('applies remote changes and logs the effective state', () => {
    feature.registerAutoDreamFeature();
    const valueListener = mocks.subscribeConfigValue.mock.calls[0]?.[1] as (
      value: unknown,
    ) => void;

    valueListener({ enabled: true });
    expect(mocks.runLogger.log).toHaveBeenLastCalledWith(
      '[config-service] auto_dream feature gate value received',
      { enabled: true },
    );

    valueListener({ text: 'test' });
    expect(mocks.runLogger.log).toHaveBeenLastCalledWith(
      '[config-service] auto_dream feature gate value received',
      { enabled: false },
    );
  });
});
