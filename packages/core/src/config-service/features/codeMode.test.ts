/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_MODE_FEATURE_ENV,
  CODE_MODE_FEATURE_GATE,
  getCodeModeFeatureConfig,
  registerCodeModeFeature,
} from './codeMode.js';

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));
vi.mock('../../utils/runLogger.js', () => ({
  runLogger: { log: mocks.log },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv(CODE_MODE_FEATURE_ENV, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('code_mode feature gate', () => {
  const on = { enabled: true, defaultMode: 'on' };
  const off = { enabled: false, defaultMode: 'off' };
  const remoteOnly = { enabled: true, defaultMode: 'only' };

  it.each([
    { env: '1', gate: undefined, expected: on },
    { env: 'true', gate: undefined, expected: on },
    { env: ' TRUE ', gate: undefined, expected: on },
    { env: '', gate: undefined, expected: off },
    { env: '0', gate: undefined, expected: off },
    { env: 'false', gate: undefined, expected: off },
    { env: 'invalid', gate: undefined, expected: off },
    { env: '1', gate: false, expected: on },
    { env: '1', gate: { enabled: false }, expected: on },
    { env: '1', gate: '{"enabled":false}', expected: on },
    { env: '1', gate: null, expected: on },
    { env: '1', gate: {}, expected: on },
    { env: '1', gate: 'invalid', expected: on },
    {
      env: '1',
      gate: { enabled: true, defaultMode: 'off' },
      expected: { enabled: true, defaultMode: 'off' },
    },
    { env: '1', gate: { enabled: true, defaultMode: 'on' }, expected: on },
    { env: '1', gate: remoteOnly, expected: remoteOnly },
    {
      env: '1',
      gate: { enabled: true, defaultMode: 'invalid' },
      expected: { enabled: true, defaultMode: 'off' },
    },
    { env: '0', gate: remoteOnly, expected: { ...remoteOnly, enabled: false } },
    {
      env: 'false',
      gate: remoteOnly,
      expected: { ...remoteOnly, enabled: false },
    },
    {
      env: ' FALSE ',
      gate: remoteOnly,
      expected: { ...remoteOnly, enabled: false },
    },
    { env: '', gate: remoteOnly, expected: remoteOnly },
    { env: 'invalid', gate: remoteOnly, expected: remoteOnly },
  ])(
    'resolves the environment override against the remote gate: %j',
    ({ env, gate, expected }) => {
      vi.stubEnv(CODE_MODE_FEATURE_ENV, env);
      mocks.getConfigValue.mockReturnValue(gate);
      expect(getCodeModeFeatureConfig()).toEqual(expected);
    },
  );

  it.each([
    undefined,
    null,
    false,
    'false',
    { enabled: false },
    '{"enabled":false}',
    {},
    [],
    'invalid',
    { enabled: 'invalid' },
  ])('disables missing, false or malformed values: %j', (value) => {
    mocks.getConfigValue.mockReturnValue(value);
    expect(getCodeModeFeatureConfig().enabled).toBe(false);
    expect(mocks.getConfigValue).toHaveBeenCalledWith(CODE_MODE_FEATURE_GATE);
  });

  it.each([true, 'true', '1', { enabled: true }, '{"enabled":true}'])(
    'accepts enabled ConfigService values: %j',
    (value) => {
      mocks.getConfigValue.mockReturnValue(value);
      expect(getCodeModeFeatureConfig().enabled).toBe(true);
      expect(getCodeModeFeatureConfig().defaultMode).toBe('off');
    },
  );

  it.each(['off', 'on', 'only'] as const)(
    'reads the remote defaultMode %s from objects and JSON',
    (defaultMode) => {
      const config = { enabled: true, defaultMode };
      for (const value of [config, JSON.stringify(config)]) {
        mocks.getConfigValue.mockReturnValue(value);
        expect(getCodeModeFeatureConfig()).toEqual(config);
      }
    },
  );

  it.each([undefined, null, true, 1, '', 'invalid'])(
    'falls back to off for an omitted or invalid defaultMode: %j',
    (defaultMode) => {
      mocks.getConfigValue.mockReturnValue({ enabled: true, defaultMode });
      expect(getCodeModeFeatureConfig()).toEqual({
        enabled: true,
        defaultMode: 'off',
      });
    },
  );

  it('keeps the master switch disabled when only a defaultMode is supplied', () => {
    mocks.getConfigValue.mockReturnValue({ defaultMode: 'on' });
    expect(getCodeModeFeatureConfig()).toEqual({
      enabled: false,
      defaultMode: 'on',
    });
  });

  it('does not retain an enabled value after the source changes or removes it', () => {
    mocks.getConfigValue.mockReturnValue({ enabled: true });
    expect(getCodeModeFeatureConfig().enabled).toBe(true);
    mocks.getConfigValue.mockReturnValue(undefined);
    expect(getCodeModeFeatureConfig().enabled).toBe(false);
    mocks.getConfigValue.mockReturnValue({ enabled: true });
    expect(getCodeModeFeatureConfig().enabled).toBe(true);
    mocks.getConfigValue.mockReturnValue({ enabled: false });
    expect(getCodeModeFeatureConfig().enabled).toBe(false);
  });

  it('subscribes to rollout changes for diagnostics', () => {
    registerCodeModeFeature();
    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      CODE_MODE_FEATURE_GATE,
      expect.any(Function),
    );
    const listener = mocks.subscribeConfigValue.mock.calls[0][1];
    listener({ enabled: true, defaultMode: 'only' });
    expect(mocks.log).toHaveBeenLastCalledWith(
      '[config-service] code_mode feature gate value received',
      { enabled: true, defaultMode: 'only' },
    );
    listener(undefined);
    expect(mocks.log).toHaveBeenLastCalledWith(
      '[config-service] code_mode feature gate value received',
      { enabled: false, defaultMode: 'off' },
    );
  });
});
