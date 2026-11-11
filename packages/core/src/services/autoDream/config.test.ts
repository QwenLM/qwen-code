/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, DreamSettings } from '../../config/config.js';
import {
  ENV_DREAM,
  ENV_MEMORY_HEADLESS,
} from '../../config/brand.js';
import { resolveDreamConfig } from './config.js';

const mocks = vi.hoisted(() => ({
  isAutoDreamFeatureGateEnabled: vi.fn(),
}));

vi.mock('../../config-service/features/autoDream.js', () => ({
  isAutoDreamFeatureGateEnabled: mocks.isAutoDreamFeatureGateEnabled,
}));

function configWithDreamSettings(
  settings: DreamSettings,
  options: {
    interactive?: boolean;
    sdkMemoryRequestActive?: boolean;
  } = {},
): Config {
  return {
    getDreamSettings: () => settings,
    isInteractive: () => options.interactive ?? true,
    isSdkMemoryRequestActive: () =>
      options.sdkMemoryRequestActive ?? false,
  } as unknown as Config;
}

describe('resolveDreamConfig', () => {
  beforeEach(() => {
    mocks.isAutoDreamFeatureGateEnabled.mockReset();
    mocks.isAutoDreamFeatureGateEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to disabled while preserving scheduling defaults', () => {
    expect(resolveDreamConfig(configWithDreamSettings({}))).toEqual({
      enabled: false,
      minHours: 24,
      minSessions: 5,
      scanThrottleMinutes: 10,
    });
  });

  it('uses the QCS gate when TUI has no explicit setting', () => {
    mocks.isAutoDreamFeatureGateEnabled.mockReturnValue(true);
    expect(
      resolveDreamConfig(
        configWithDreamSettings({
          minHours: 0.01,
          minSessions: 1,
          scanThrottleMinutes: 0.1,
        }),
      ),
    ).toEqual({
      enabled: true,
      minHours: 0.01,
      minSessions: 1,
      scanThrottleMinutes: 0.1,
    });
  });

  it('lets an explicit TUI setting override the QCS gate', () => {
    expect(
      resolveDreamConfig(configWithDreamSettings({ enabled: true })).enabled,
    ).toBe(true);

    mocks.isAutoDreamFeatureGateEnabled.mockReturnValue(true);
    expect(
      resolveDreamConfig(configWithDreamSettings({ enabled: false })).enabled,
    ).toBe(false);
  });

  it('enables Dream by default when ordinary headless master is enabled', () => {
    vi.stubEnv(ENV_MEMORY_HEADLESS, '1');

    expect(
      resolveDreamConfig(
        configWithDreamSettings(
          { enabled: false },
          { interactive: false },
        ),
      ).enabled,
    ).toBe(true);
  });

  it('lets ordinary headless disable Dream independently', () => {
    vi.stubEnv(ENV_MEMORY_HEADLESS, '1');
    vi.stubEnv(ENV_DREAM, '0');

    expect(
      resolveDreamConfig(
        configWithDreamSettings({}, { interactive: false }),
      ).enabled,
    ).toBe(false);
  });

  it('keeps ordinary headless Dream off without its master switch', () => {
    vi.stubEnv(ENV_DREAM, '1');

    expect(
      resolveDreamConfig(
        configWithDreamSettings({}, { interactive: false }),
      ).enabled,
    ).toBe(false);
  });

  it('always disables Dream for SDK Memory requests', () => {
    vi.stubEnv(ENV_MEMORY_HEADLESS, '1');
    vi.stubEnv(ENV_DREAM, '1');
    mocks.isAutoDreamFeatureGateEnabled.mockReturnValue(true);

    expect(
      resolveDreamConfig(
        configWithDreamSettings(
          { enabled: true },
          { interactive: false, sdkMemoryRequestActive: true },
        ),
      ).enabled,
    ).toBe(false);
  });

  it('falls back to defaults for invalid scheduling settings', () => {
    expect(
      resolveDreamConfig(
        configWithDreamSettings({
          enabled: false,
          minHours: 0,
          minSessions: -1,
          scanThrottleMinutes: Number.NaN,
        }),
      ),
    ).toEqual({
      enabled: false,
      minHours: 24,
      minSessions: 5,
      scanThrottleMinutes: 10,
    });
  });
});
