/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { prepareShellSpawn } from './shellSpawnPreparation.js';
import type { EnvironmentSanitizationConfig } from './environmentSanitization.js';
import type { SpawnParams } from '../utils/Shell.js';

const NO_REDACTION_CONFIG: EnvironmentSanitizationConfig = {
  allowedEnvironmentVariables: [],
  blockedEnvironmentVariables: [],
  enableEnvironmentVariableRedaction: false,
};

function baseParams(): SpawnParams {
  return {
    program: 'bash',
    args: ['-c', 'qwen-scan .'],
    env: {},
    cwd: process.cwd(),
  };
}

describe('prepareShellSpawn — Git environment compatibility', () => {
  it('preserves Git configuration and extension settings for Bash', async () => {
    const inherited = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'diff.external',
      GIT_CONFIG_VALUE_0: 'custom-diff',
      GIT_EXTERNAL_DIFF: 'custom-external-diff',
      GIT_OPTIONAL_LOCKS: '1',
    };
    for (const [key, value] of Object.entries(inherited))
      vi.stubEnv(key, value);
    try {
      const result = await prepareShellSpawn(baseParams(), {
        sanitizationConfig: NO_REDACTION_CONFIG,
      });
      expect(result.env).toMatchObject(inherited);
      expect(result.env['GIT_CONFIG_KEY_1']).toBeUndefined();
      expect(result.args).toEqual(baseParams().args);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});


describe('environment preparation extension', () => {
  it('cleans inherited values before sanitization and applies trusted values afterwards', async () => {
    const result = await prepareShellSpawn({ ...baseParams(), env: { OLD_CONTEXT: 'old', AUTH_TOKEN: 'inherited' } }, {
      sanitizationConfig: { ...NO_REDACTION_CONFIG, enableEnvironmentVariableRedaction: true },
      environmentPreparation: {
        beforeSanitization(env) { delete env['OLD_CONTEXT']; },
        afterSanitization(env) {
          expect(env['AUTH_TOKEN']).toBeUndefined();
          env['AUTH_TOKEN'] = 'per-command';
        },
      },
    });
    expect(result.env['OLD_CONTEXT']).toBeUndefined();
    expect(result.env['AUTH_TOKEN']).toBe('per-command');
  });
  it('resolves lazy preparation with the final invocation config', async () => {
    const environmentPreparation = vi.fn(async (config) => ({
      afterSanitization(env: Record<string, string | undefined>) {
        env['CONTEXT'] = config.modelKey;
      },
    }));
    const config = {
      sanitizationConfig: NO_REDACTION_CONFIG,
      modelKey: 'current-invocation',
      environmentPreparation,
    };
    const result = await prepareShellSpawn(baseParams(), config);
    expect(result.env['CONTEXT']).toBe('current-invocation');
    expect(environmentPreparation).toHaveBeenCalledExactlyOnceWith(config);
  });
});
