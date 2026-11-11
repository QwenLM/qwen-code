/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { EnvConfigService } from './env-config-service.js';

describe('EnvConfigService', () => {
  it('reads raw values using QWEN_CONFIG upper-snake-case keys', () => {
    const source = new EnvConfigService({
      environment: {
        QWEN_CONFIG_CLOUD_REMOTE: 'enabled',
        QWEN_CONFIG_MODEL_STREAM_TIMEOUT: '3000',
        QWEN_CONFIG_FEATURE_FLAG: 'true',
      },
    });

    expect(source.getValue('cloud_remote')).toBe('enabled');
    expect(source.getValue('modelStreamTimeout')).toBe('3000');
    expect(source.getValue('feature.flag')).toBe('true');
    expect(source.getValue('missing')).toBeUndefined();
  });

  it('makes unsubscribe idempotent after stop', async () => {
    const source = new EnvConfigService();
    const unsubscribe = source.onValueChange('cloud_remote', vi.fn());

    await source.stop();
    unsubscribe();
    unsubscribe();
  });

  it('reads values live from the environment instead of caching at construction', () => {
    const environment: NodeJS.ProcessEnv = {};
    const source = new EnvConfigService({ environment });

    expect(source.getValue('cloud_remote')).toBeUndefined();

    environment['QWEN_CONFIG_CLOUD_REMOTE'] = 'enabled';
    expect(source.getValue('cloud_remote')).toBe('enabled');
  });

  it.each(['false', '0', '', '{"enabled":false}', 'invalid-json'])(
    'preserves an explicit feature environment value: %j',
    (value) => {
      const environment = { QWEN_CONFIG_AUTO_MEMORY_POLICY: value };
      const source = new EnvConfigService({ environment });

      expect(source.getValue('auto_memory_policy')).toBe(value);

      delete (environment as NodeJS.ProcessEnv)[
        'QWEN_CONFIG_AUTO_MEMORY_POLICY'
      ];
      expect(
        JSON.parse(source.getValue<string>('auto_memory_policy')!),
      ).toEqual({
        enabled: true,
        extraction_every_n_turns: 1,
      });
    },
  );

  it('keeps non-feature configuration and unknown keys absent', () => {
    const source = new EnvConfigService({ environment: {} });

    for (const key of [
      'agents_md_size_policy',
      'dynamic_commands',
      'prompt_policy',
      'webfetch_model_policy',
      'unknown_feature',
      'constructor',
      '__proto__',
    ]) {
      expect(source.getValue(key)).toBeUndefined();
    }
  });

  it('treats start and stop as idempotent lifecycle no-ops', async () => {
    const source = new EnvConfigService();

    await expect(source.start()).resolves.toBeUndefined();
    await expect(source.start()).resolves.toBeUndefined();
    await expect(source.stop()).resolves.toBeUndefined();
    await expect(source.stop()).resolves.toBeUndefined();
  });

  it('returns a callable no-op unsubscribe from onError', () => {
    const source = new EnvConfigService();

    const unsubscribe = source.onError(() => {});
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  it('supports unsubscribing before stop without throwing', () => {
    const source = new EnvConfigService();
    const unsubscribe = source.onValueChange('cloud_remote', vi.fn());

    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });
});
