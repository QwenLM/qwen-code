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

describe('config-service/features/autoMemoryPolicy', () => {
  let feature: typeof import('./autoMemoryPolicy.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getConfigValue.mockReset();
    mocks.subscribeConfigValue.mockReset();
    feature = await import('./autoMemoryPolicy.js');
  });

  it('registers the policy gate with a safe disabled default', () => {
    feature.registerAutoMemoryPolicyFeature();

    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      'auto_memory_policy',
      expect.any(Function),
    );
    expect(feature.getAutoMemoryExtractionEveryNTurns()).toBe(1);
    expect(feature.isAutoMemoryTurnCompleteGenerationEnabled()).toBe(false);
  });

  it('accepts object and JSON-encoded interval payloads', () => {
    mocks.getConfigValue.mockReturnValue({
      enabled: true,
      extraction_every_n_turns: 3,
    });
    expect(feature.getAutoMemoryExtractionEveryNTurns()).toBe(3);
    expect(feature.isAutoMemoryTurnCompleteGenerationEnabled()).toBe(true);

    mocks.getConfigValue.mockReturnValue(
      '{"enabled":true,"extractionEveryNTurns":"4"}',
    );
    expect(feature.getAutoMemoryExtractionEveryNTurns()).toBe(4);
  });

  it.each([
    undefined,
    {},
    { enabled: false, extraction_every_n_turns: 5 },
    { extraction_every_n_turns: 5 },
    { extraction_every_n_turns: 0 },
    { extraction_every_n_turns: -1 },
    { extraction_every_n_turns: 2.5 },
    { extraction_every_n_turns: 'invalid' },
    { text: 'test' },
    'malformed-json',
  ])('defaults malformed or invalid values to one: %#', (value) => {
    mocks.getConfigValue.mockReturnValue(value);
    expect(feature.getAutoMemoryExtractionEveryNTurns()).toBe(1);
    expect(feature.isAutoMemoryTurnCompleteGenerationEnabled()).toBe(false);
  });

  it('logs the effective interval when QCS changes', () => {
    feature.registerAutoMemoryPolicyFeature();
    const valueListener = mocks.subscribeConfigValue.mock.calls[0]?.[1] as (
      value: unknown,
    ) => void;

    valueListener({ enabled: true, extraction_every_n_turns: 5 });
    valueListener({ enabled: true, extraction_every_n_turns: 0 });

    expect(mocks.runLogger.log).toHaveBeenNthCalledWith(
      1,
      '[config-service] auto_memory_policy feature gate value received',
      { enabled: true, extractionEveryNTurns: 5 },
    );
    expect(mocks.runLogger.log).toHaveBeenNthCalledWith(
      2,
      '[config-service] auto_memory_policy feature gate value received',
      { enabled: false, extractionEveryNTurns: 1 },
    );
  });
});
