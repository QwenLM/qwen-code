/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js';

const ENV_NAME = 'CLI_TEST_ENV_TRUTHY';

describe('envUtils', () => {
  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  it.each(['1', 'true', 'yes', 'on', ' TRUE ', ' Yes '])(
    'treats %s as truthy',
    (value) => {
      process.env[ENV_NAME] = value;

      expect(isEnvTruthy(ENV_NAME)).toBe(true);
    },
  );

  it.each(['0', 'false', 'no', 'off', ' FALSE ', ' No '])(
    'treats %s as defined falsy',
    (value) => {
      process.env[ENV_NAME] = value;

      expect(isEnvDefinedFalsy(ENV_NAME)).toBe(true);
    },
  );
});
