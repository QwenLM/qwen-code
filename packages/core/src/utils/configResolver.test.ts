/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveField,
  resolveOptionalField,
  layer,
  envLayer,
  cliSource,
  settingsSource,
  defaultSource,
} from './configResolver.js';

describe('configResolver', () => {
  describe('resolveField', () => {
    it('returns first present value from layers', () => {
      const result = resolveField(
        [
          layer(undefined, cliSource('--model')),
          envLayer({ MODEL: 'from-env' }, 'MODEL'),
          layer('from-settings', settingsSource('model.name')),
        ],
        'default-model',
      );

      expect(result.value).toBe('from-env');
      expect(result.source).toEqual({ kind: 'env', envKey: 'MODEL' });
    });

    it('returns default when all layers are undefined', () => {
      const result = resolveField(
        [layer(undefined, cliSource('--model')), envLayer({}, 'MODEL')],
        'default-model',
        defaultSource('default-model'),
      );

      expect(result.value).toBe('default-model');
      expect(result.source).toEqual({
        kind: 'default',
        detail: 'default-model',
      });
    });

    it('respects layer priority order', () => {
      const result = resolveField(
        [
          layer('cli-value', cliSource('--model')),
          envLayer({ MODEL: 'env-value' }, 'MODEL'),
          layer('settings-value', settingsSource('model.name')),
        ],
        'default',
      );

      expect(result.value).toBe('cli-value');
      expect(result.source.kind).toBe('cli');
    });

    it('skips empty strings', () => {
      const result = resolveField(
        [
          layer('', cliSource('--model')),
          envLayer({ MODEL: 'env-value' }, 'MODEL'),
        ],
        'default',
      );

      expect(result.value).toBe('env-value');
    });
  });

  describe('resolveOptionalField', () => {
    it('returns undefined when no value present', () => {
      const result = resolveOptionalField([
        layer(undefined, cliSource('--key')),
        envLayer({}, 'KEY'),
      ]);

      expect(result).toBeUndefined();
    });

    it('returns first present value', () => {
      const result = resolveOptionalField([
        layer(undefined, cliSource('--key')),
        envLayer({ KEY: 'found' }, 'KEY'),
      ]);

      expect(result).toBeDefined();
      expect(result!.value).toBe('found');
      expect(result!.source.kind).toBe('env');
    });
  });

  describe('envLayer', () => {
    it('creates layer from environment variable', () => {
      const env = { MY_VAR: 'my-value' };
      const result = envLayer(env, 'MY_VAR');

      expect(result.value).toBe('my-value');
      expect(result.source).toEqual({ kind: 'env', envKey: 'MY_VAR' });
    });

    it('handles missing environment variable', () => {
      const env = {};
      const result = envLayer(env, 'MISSING_VAR');

      expect(result.value).toBeUndefined();
      expect(result.source).toEqual({ kind: 'env', envKey: 'MISSING_VAR' });
    });

    it('supports transform function', () => {
      const env = { PORT: '3000' };
      const result = envLayer(env, 'PORT', (v) => parseInt(v, 10));

      expect(result.value).toBe(3000);
    });
  });

  describe('source factory functions', () => {
    it('creates CLI source', () => {
      expect(cliSource('--model')).toEqual({ kind: 'cli', detail: '--model' });
    });

    it('creates settings source', () => {
      expect(settingsSource('model.name')).toEqual({
        kind: 'settings',
        settingsPath: 'model.name',
      });
    });

    it('creates default source', () => {
      expect(defaultSource('my-default')).toEqual({
        kind: 'default',
        detail: 'my-default',
      });
    });
  });
});
