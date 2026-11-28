/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROMPT_SUGGESTION_FEATURE_GATE,
  isPromptSuggestionFeatureGateEnabled,
  getPromptSuggestionFeatureConfig,
  registerPromptSuggestionFeature,
  subscribePromptSuggestionFeatureGate,
} from './promptSuggestion.js';

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  getConfigService: vi.fn(),
  subscribeConfigValue: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  getConfigService: mocks.getConfigService,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));
vi.mock('../../utils/runLogger.js', () => ({
  runLogger: { log: mocks.log },
}));

beforeEach(() => vi.resetAllMocks());

describe('prompt_suggestion feature gate', () => {
  it.each([
    undefined,
    null,
    {},
    [],
    'invalid',
    '{',
    { enabled: 'invalid' },
    { enabled: null },
  ])(
    'preserves existing behavior for missing or malformed values: %j',
    (value) => {
      mocks.getConfigValue.mockReturnValue(value);
      expect(isPromptSuggestionFeatureGateEnabled()).toBe(true);
      expect(mocks.getConfigValue).toHaveBeenCalledWith(
        PROMPT_SUGGESTION_FEATURE_GATE,
      );
    },
  );

  it.each([true, 'true', '1', { enabled: true }, '{"enabled":true}'])(
    'accepts enabled rollout values: %j',
    (value) => {
      mocks.getConfigValue.mockReturnValue(value);
      expect(isPromptSuggestionFeatureGateEnabled()).toBe(true);
    },
  );

  it.each([false, 'false', '0', '', { enabled: false }, '{"enabled":false}'])(
    'disables explicit rollout values: %j',
    (value) => {
      mocks.getConfigValue.mockReturnValue(value);
      expect(isPromptSuggestionFeatureGateEnabled()).toBe(false);
    },
  );

  it.each([
    { enabled: true, mode: 'shared' },
    '{"enabled":true,"mode":"shared"}',
    { mode: 'shared' },
  ])('still accepts the original shared mode: %j', (value) => {
    mocks.getConfigValue.mockReturnValue(value);
    expect(getPromptSuggestionFeatureConfig()).toEqual({
      enabled: true,
      mode: 'shared',
      forkEnabled: false,
    });
  });

  it.each([
    undefined,
    {},
    true,
    { mode: 'legacy' },
    { mode: 'unknown' },
    { mode: null },
    { mode: 'SHARED' },
  ])('defaults missing or unsupported modes to legacy: %j', (value) => {
    mocks.getConfigValue.mockReturnValue(value);
    expect(getPromptSuggestionFeatureConfig()).toEqual({
      enabled: true,
      mode: 'legacy',
      forkEnabled: false,
    });
  });

  it('keeps explicit disabling authoritative in shared mode', () => {
    mocks.getConfigValue.mockReturnValue({ enabled: false, mode: 'shared' });
    expect(getPromptSuggestionFeatureConfig()).toEqual({
      enabled: false,
      mode: 'shared',
      forkEnabled: false,
    });
  });

  it.each([
    [{ unifiedRulesEnabled: true }, 'shared', false],
    [{ unifiedRulesEnabled: true, forkEnabled: true }, 'shared', true],
    ['{"unifiedRulesEnabled":true,"forkEnabled":true}', 'shared', true],
    [{ unifiedRulesEnabled: false, forkEnabled: true }, 'legacy', true],
    [{ unifiedRulesEnabled: false, mode: 'shared' }, 'legacy', false],
    [{ unifiedRulesEnabled: true, mode: 'legacy' }, 'shared', false],
    [{ unifiedRulesEnabled: false, mode: 'fork' }, 'legacy', true],
    [{ unifiedRulesEnabled: 'true' }, 'legacy', false],
    [{ unifiedRulesEnabled: null, mode: 'shared' }, 'shared', false],
    [{ mode: 'shared', forkEnabled: true }, 'shared', true],
    ['{"mode":"shared","forkEnabled":true}', 'shared', true],
    [{ mode: 'shared', forkEnabled: false }, 'shared', false],
    [{ mode: 'legacy', forkEnabled: true }, 'legacy', true],
    [{ forkEnabled: true }, 'legacy', true],
    [{ mode: 'shared', forkEnabled: 'true' }, 'shared', false],
    [{ mode: 'fork' }, 'shared', true],
    [{ mode: 'fork', forkEnabled: false }, 'shared', false],
  ] as const)(
    'selects prompt rules and fork independently for %j',
    (value, mode, forkEnabled) => {
      mocks.getConfigValue.mockReturnValue(value);
      expect(getPromptSuggestionFeatureConfig()).toEqual({
        enabled: true,
        mode,
        forkEnabled,
      });
    },
  );

  it('keeps the kill switch authoritative with shared rules and fork both configured', () => {
    mocks.getConfigValue.mockReturnValue({
      unifiedRulesEnabled: true,
      enabled: false,
      forkEnabled: true,
    });
    expect(isPromptSuggestionFeatureGateEnabled()).toBe(false);
  });

  it('does not retain another identity’s shared rollout', () => {
    mocks.getConfigValue.mockReturnValue({ mode: 'shared' });
    expect(getPromptSuggestionFeatureConfig().mode).toBe('shared');
    mocks.getConfigValue.mockReturnValue(undefined);
    expect(getPromptSuggestionFeatureConfig()).toEqual({
      enabled: true,
      mode: 'legacy',
      forkEnabled: false,
    });
  });

  it('reads the current source instead of retaining another identity’s switch', () => {
    mocks.getConfigValue.mockReturnValue({ enabled: false });
    expect(isPromptSuggestionFeatureGateEnabled()).toBe(false);
    mocks.getConfigValue.mockReturnValue(undefined);
    expect(isPromptSuggestionFeatureGateEnabled()).toBe(true);
    mocks.getConfigValue.mockReturnValue({ enabled: true });
    expect(isPromptSuggestionFeatureGateEnabled()).toBe(true);
  });

  it('registers rollout diagnostics including removals', () => {
    registerPromptSuggestionFeature();
    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      PROMPT_SUGGESTION_FEATURE_GATE,
      expect.any(Function),
    );
    const listener = mocks.subscribeConfigValue.mock.calls[0][1];
    listener({ enabled: false });
    expect(mocks.log).toHaveBeenLastCalledWith(
      '[config-service] prompt_suggestion feature gate value received',
      { enabled: false, mode: 'legacy', forkEnabled: false },
    );
    listener(undefined);
    expect(mocks.log).toHaveBeenLastCalledWith(
      '[config-service] prompt_suggestion feature gate value received',
      { enabled: true, mode: 'legacy', forkEnabled: false },
    );
  });

  it('subscribes consumers to parsed changes and returns source cleanup', () => {
    const unsubscribe = vi.fn();
    const onValueChange = vi.fn().mockReturnValue(unsubscribe);
    mocks.getConfigService.mockReturnValue({ onValueChange });
    const listener = vi.fn();
    expect(subscribePromptSuggestionFeatureGate(listener)).toBe(unsubscribe);
    expect(onValueChange).toHaveBeenCalledWith(
      PROMPT_SUGGESTION_FEATURE_GATE,
      expect.any(Function),
    );
    const onChange = onValueChange.mock.calls[0][1];
    onChange({ enabled: false });
    onChange('{"enabled":true}');
    onChange('{"enabled":true,"mode":"shared"}');
    onChange({ enabled: true, unifiedRulesEnabled: true, forkEnabled: true });
    onChange(undefined);
    expect(listener.mock.calls).toEqual([
      [{ enabled: false, mode: 'legacy', forkEnabled: false }],
      [{ enabled: true, mode: 'legacy', forkEnabled: false }],
      [{ enabled: true, mode: 'shared', forkEnabled: false }],
      [{ enabled: true, mode: 'shared', forkEnabled: true }],
      [{ enabled: true, mode: 'legacy', forkEnabled: false }],
    ]);
  });

  it('works before a configuration source is installed', () => {
    expect(isPromptSuggestionFeatureGateEnabled()).toBe(true);
    expect(subscribePromptSuggestionFeatureGate(vi.fn())).toBeUndefined();
  });
});
