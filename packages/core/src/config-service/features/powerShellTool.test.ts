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
}));
vi.mock('../index.js', () => mocks);
import {
  _resetPowerShellToolFeatureGateForTesting,
  hasPowerShellToolQcsValue,
  isPowerShellToolQcsEnabled,
  POWERSHELL_TOOL_FEATURE_GATE,
  registerPowerShellToolFeature,
} from './powerShellTool.js';

vi.mock('../../utils/runLogger.js', () => ({
  runLogger: {
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('config-service/features/powerShellTool', () => {
  let onChange: (value: unknown) => void;
  beforeEach(() => {
    mocks.getConfigValue.mockReset();
    mocks.subscribeConfigValue.mockReset();
    mocks.subscribeConfigValue.mockImplementation(
      (_key: string, listener: (value: unknown) => void) => {
        onChange = listener;
        return () => {};
      },
    );
    _resetPowerShellToolFeatureGateForTesting();
  });

  it('registers disabled by default', () => {
    registerPowerShellToolFeature();
    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      POWERSHELL_TOOL_FEATURE_GATE,
      expect.any(Function),
    );
    expect(isPowerShellToolQcsEnabled()).toBe(false);
    expect(hasPowerShellToolQcsValue()).toBe(false);
  });

  it('accepts boolean, JSON, and object gate payloads', () => {
    registerPowerShellToolFeature();
    onChange(true);
    expect(isPowerShellToolQcsEnabled()).toBe(true);
    onChange('{"enabled":false}');
    expect(isPowerShellToolQcsEnabled()).toBe(false);
    onChange({ enabled: true });
    expect(isPowerShellToolQcsEnabled()).toBe(true);
    expect(hasPowerShellToolQcsValue()).toBe(true);
  });

  it('keeps the last valid value for malformed payloads', () => {
    registerPowerShellToolFeature();
    onChange(true);
    onChange('not-json');
    expect(isPowerShellToolQcsEnabled()).toBe(true);
  });

  it('keeps the last valid value for objects without a usable enabled field', () => {
    registerPowerShellToolFeature();
    onChange(true);
    onChange({ enabled: null });
    expect(isPowerShellToolQcsEnabled()).toBe(true);
    onChange({});
    expect(isPowerShellToolQcsEnabled()).toBe(true);
  });

  it('reads the current source value and retains it when unavailable', () => {
    mocks.getConfigValue.mockReturnValue(true);
    expect(isPowerShellToolQcsEnabled()).toBe(true);
    mocks.getConfigValue.mockReturnValue(undefined);
    registerPowerShellToolFeature();
    onChange(undefined);
    expect(isPowerShellToolQcsEnabled()).toBe(true);
  });

  it('treats a top-level null payload as disabled', () => {
    registerPowerShellToolFeature();
    onChange(true);
    onChange(null);
    expect(isPowerShellToolQcsEnabled()).toBe(false);
  });
});
