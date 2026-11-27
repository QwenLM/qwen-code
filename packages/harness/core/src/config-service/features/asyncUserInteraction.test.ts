/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EnvConfigService } from '../env-config-service.js';
import { installConfigService, stopConfigService } from '../index.js';
import { isAsyncUserInteractionFeatureGateEnabled } from './asyncUserInteraction.js';

afterEach(() => stopConfigService());

describe('async_user_interaction feature gate', () => {
  it('defaults to enabled before a config source is installed', () => {
    expect(isAsyncUserInteractionFeatureGateEnabled()).toBe(true);
  });

  it.each([
    [undefined, true],
    ['{"enabled":true}', true],
    ['{"enabled":false}', false],
    ['false', false],
    ['0', false],
    ['', false],
    ['invalid-json', true],
  ] as const)('resolves environment value %s to %s', (value, expected) => {
    installConfigService(
      new EnvConfigService({
        environment: { QWEN_CONFIG_ASYNC_USER_INTERACTION: value },
      }),
    );
    expect(isAsyncUserInteractionFeatureGateEnabled()).toBe(expected);
  });
});
