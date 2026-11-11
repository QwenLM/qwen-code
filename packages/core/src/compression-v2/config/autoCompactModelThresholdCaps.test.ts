/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_COMPACT_MODEL_THRESHOLD_CAPS_GATE,
  getAutoCompactModelThresholdCap,
  registerAutoCompactModelThresholdCapsFeature,
} from './autoCompactModelThresholdCaps.js';

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  log: vi.fn(),
  subscribeConfigValue: vi.fn(),
}));

vi.mock('../../config-service/index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));
vi.mock('../../utils/runLogger.js', () => ({
  runLogger: { log: mocks.log },
}));
const payload = {
  enabled: true,
  model_threshold_caps: { qmodel_38max: 600000, qfmodel: 600000 },
};

let valueListener: ((value: unknown) => void) | undefined;

describe('auto compact model threshold caps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valueListener = undefined;
    mocks.subscribeConfigValue.mockImplementation(
      (_key: string, listener: (value: unknown) => void) => {
        valueListener = listener;
        return () => {};
      },
    );
  });

  it('subscribes to the opt-in key', () => {
    registerAutoCompactModelThresholdCapsFeature();

    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      AUTO_COMPACT_MODEL_THRESHOLD_CAPS_GATE,
      expect.any(Function),
    );
  });
  it('ignores undefined source updates', () => {
    registerAutoCompactModelThresholdCapsFeature();
    valueListener?.(undefined);

    expect(mocks.log).not.toHaveBeenCalled();
  });

  it.each([payload, JSON.stringify(payload)])(
    'reads exact model keys from the cached config: %j',
    (value) => {
      mocks.getConfigValue.mockReturnValue(value);
      expect(getAutoCompactModelThresholdCap('qmodel_38max')).toBe(600000);
      expect(getAutoCompactModelThresholdCap('qfmodel')).toBe(600000);
      expect(getAutoCompactModelThresholdCap('cmodel')).toBeUndefined();
      expect(getAutoCompactModelThresholdCap('qfmodel-custom')).toBeUndefined();
      expect(getAutoCompactModelThresholdCap('toString')).toBeUndefined();
    },
  );
  it.each([
    undefined,
    null,
    '',
    '{broken',
    [],
    true,
    { text: 'test' },
    { ...payload, enabled: false },
    { ...payload, enabled: 'true' },
    { enabled: true, model_threshold_caps: [] },
  ])('falls back with an absent or invalid config: %j', (value) => {
    mocks.getConfigValue.mockReturnValue(value);
    expect(getAutoCompactModelThresholdCap('qmodel_38max')).toBeUndefined();
  });
  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '600000',
    true,
    null,
  ])('ignores invalid caps without discarding other models: %j', (cap) => {
    mocks.getConfigValue.mockReturnValue({
      enabled: true,
      model_threshold_caps: { qmodel_38max: cap, qfmodel: 600000 },
    });
    expect(getAutoCompactModelThresholdCap('qmodel_38max')).toBeUndefined();
    expect(getAutoCompactModelThresholdCap('qfmodel')).toBe(600000);
  });
  it('observes updates and deletion without retaining a stale cap', () => {
    mocks.getConfigValue.mockReturnValue(payload);
    expect(getAutoCompactModelThresholdCap('qfmodel')).toBe(600000);
    mocks.getConfigValue.mockReturnValue({
      enabled: true,
      model_threshold_caps: { qfmodel: 500000 },
    });
    expect(getAutoCompactModelThresholdCap('qfmodel')).toBe(500000);
    mocks.getConfigValue.mockReturnValue(undefined);
    expect(getAutoCompactModelThresholdCap('qfmodel')).toBeUndefined();
  });
});
