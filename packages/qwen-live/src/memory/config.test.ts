/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_CONFIG,
  deriveMemoryBaseUrl,
  initialMemoryConfig,
  resolveMemoryConfig,
  validateMemoryBaseUrl,
} from './config.js';

const dataDir = '/tmp/qwen-memory-config-tests';
const resolve = (raw?: unknown) =>
  resolveMemoryConfig(raw, dataDir, join(dataDir, 'config.json'));

describe('memory configuration', () => {
  it('enables textual memory by default and keeps visual observation opt-in under the data directory', () => {
    const config = resolve();
    expect(config).toMatchObject({
      enabled: true,
      defaultId: 'default',
      dir: join(dataDir, 'memories'),
      updater: { enabled: true, model: 'qwen3.7-plus' },
      observer: { enabled: false, model: 'qwen3.7-plus' },
    });
    config.retrieve.topK = 15;
    expect(resolve().retrieve.topK).toBe(3);
    expect(DEFAULT_MEMORY_CONFIG.retrieve.topK).toBe(3);
  });

  it('inherits an omitted observer model without overriding an explicit model', () => {
    expect(
      resolve({ updater: { model: 'custom-updater' } }).observer.model,
    ).toBe('custom-updater');
    expect(
      resolve({
        updater: { model: 'custom-updater' },
        observer: { model: 'custom-observer' },
      }).observer.model,
    ).toBe('custom-observer');
    const initialized = initialMemoryConfig(true, 'custom-updater');
    expect(initialized.observer).not.toHaveProperty('model');
    expect(resolve(initialized).observer.model).toBe('custom-updater');
    expect(initialMemoryConfig(false).enabled).toBe(false);
  });

  it('resolves relative and tilde paths without requiring the directory to exist', () => {
    expect(resolve({ dir: 'saved' }).dir).toBe(join(dataDir, 'saved'));
    expect(resolve({ dir: '~/qwen-memory-config-tests' }).dir).toBe(
      join(homedir(), 'qwen-memory-config-tests'),
    );
    expect(resolve({ dir: '/tmp/separate-memories' }).dir).toBe(
      '/tmp/separate-memories',
    );
  });

  it.each(['retrieve', 'preload', 'updater', 'observer', 'wm', 'segment'])(
    'rejects unknown keys and malformed objects in %s',
    (group) => {
      expect(() => resolve({ [group]: { inventedOption: 1 } })).toThrow(
        /unknown key/u,
      );
      for (const value of [null, [], false, 'wrong'])
        expect(() => resolve({ [group]: value })).toThrow();
    },
  );

  it('rejects unknown root keys and non-object memory config', () => {
    expect(() => resolve({ monitor: {} })).toThrow(/unknown key/u);
    for (const raw of [null, [], false, 'true', 3])
      expect(() => resolve(raw)).toThrow();
  });

  it.each([
    '../escape',
    'bad/path',
    '.hidden',
    'has space',
    '-starts-with-dash',
    'a'.repeat(65),
    '',
  ])('rejects unsafe selected library id %j', (defaultId) => {
    expect(() => resolve({ defaultId })).toThrow();
  });

  it('keeps zero-valued idle and expiry controls meaningful rather than replacing them with defaults', () => {
    const config = resolve({
      observer: { intervalSec: 0, maxFrameAgeSec: 0 },
      updater: { shutdownWaitSec: 0 },
      segment: { silenceGapSec: 0 },
      preload: { urgentDays: 0, stmUpcomingGraceDays: 0 },
      retrieve: { minSim: 0, timeEdgeDays: 0, envMinGapSec: 0 },
    });
    expect(config.observer.intervalSec).toBe(0);
    expect(config.updater.shutdownWaitSec).toBe(0);
    expect(config.retrieve.envMinGapSec).toBe(0);
  });

  it('strictly checks every numerical and boolean parameter without coercion', () => {
    const groups = [
      'retrieve',
      'preload',
      'updater',
      'observer',
      'wm',
      'segment',
    ] as const;
    for (const group of groups) {
      for (const [key, fallback] of Object.entries(
        DEFAULT_MEMORY_CONFIG[group],
      )) {
        if (typeof fallback === 'number') {
          for (const bad of [
            -1,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            1e9,
            String(fallback),
            true,
            null,
          ]) {
            expect(
              () => resolve({ [group]: { [key]: bad } }),
              `${group}.${key} accepted ${String(bad)}`,
            ).toThrow();
          }
        } else if (typeof fallback === 'boolean') {
          for (const bad of ['true', 1, null])
            expect(() => resolve({ [group]: { [key]: bad } })).toThrow();
        }
      }
    }
    for (const bad of ['true', 1, null])
      expect(() => resolve({ enabled: bad })).toThrow();
  });

  it.each([
    ['retrieve', 'topK'],
    ['retrieve', 'timeoutMs'],
    ['retrieve', 'backfillTimeoutMs'],
    ['retrieve', 'cacheSize'],
    ['retrieve', 'rrfK'],
    ['preload', 'stmMaxItems'],
    ['wm', 'maxEntries'],
    ['wm', 'maxEntryChars'],
    ['segment', 'maxTurns'],
    ['updater', 'maxTokens'],
    ['observer', 'maxContentChars'],
  ])('requires whole numbers for %s.%s', (group, key) => {
    expect(() => resolve({ [group]: { [key]: 1.5 } })).toThrow();
  });

  it.each([
    { retrieve: { maxChars: 7000, retrievedMaxChars: 6000 } },
    { retrieve: { timeoutMs: 1000, backfillTimeoutMs: 500 } },
    { segment: { maxTurns: 2, minTurnsBeforeGapCut: 3 } },
    { updater: { apiKeyEnv: 'MEMORY_TEST_KEY' } },
    { observer: { apiKeyEnv: 'MEMORY_TEST_KEY' } },
  ])('rejects inconsistent cross-field settings %j', (raw) => {
    expect(() => resolve(raw)).toThrow();
  });

  it('accepts cross-field equality and valid per-client endpoint overrides', () => {
    const config = resolve({
      retrieve: {
        maxChars: 1000,
        retrievedMaxChars: 1000,
        timeoutMs: 500,
        backfillTimeoutMs: 500,
      },
      segment: { maxTurns: 2, minTurnsBeforeGapCut: 2 },
      updater: {
        baseUrl: 'https://updater.example/v1',
        apiKeyEnv: 'MEMORY_TEST_KEY',
      },
      observer: {
        baseUrl: 'http://127.0.0.1:9999/v1',
        apiKeyEnv: 'OBSERVER_TEST_KEY',
      },
    });
    expect(config.updater.apiKeyEnv).toBe('MEMORY_TEST_KEY');
    expect(config.observer.apiKeyEnv).toBe('OBSERVER_TEST_KEY');
  });

  it.each(['updater', 'observer'])(
    'validates the %s model and credential variable independently',
    (group) => {
      for (const model of ['', 'line\nbreak', 'x'.repeat(257), false])
        expect(() => resolve({ [group]: { model } })).toThrow();
      for (const apiKeyEnv of [
        'invalid-name',
        '1KEY',
        'key with spaces',
        'KEY\n',
      ])
        expect(() =>
          resolve({
            [group]: { baseUrl: 'https://example.test/v1', apiKeyEnv },
          }),
        ).toThrow();
    },
  );
});

describe('memory endpoint derivation', () => {
  it.each([
    [
      'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    ],
    [
      'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    ],
    [
      'ws://127.0.0.1:9000/api-ws/v1/realtime',
      'http://127.0.0.1:9000/compatible-mode/v1',
    ],
    [
      'https://proxy.example/prefix/compatible-mode/v1/realtime?model=qwen',
      'https://proxy.example/prefix/compatible-mode/v1',
    ],
  ])('derives a compatible HTTP endpoint from %s', (input, output) => {
    expect(deriveMemoryBaseUrl(input)).toBe(output);
  });

  it.each([
    'file:///tmp/a',
    'wss://example.test/v1',
    'https://name:secret@example.test/v1',
    'https://example.test/v1?key=secret',
    'https://example.test/v1#fragment',
    'relative/path',
  ])('rejects unsafe or ambiguous API base URL %s', (value) => {
    expect(() => validateMemoryBaseUrl(value)).toThrow();
  });

  it('rejects embedded credentials before deriving and normalizes a trailing slash', () => {
    expect(() =>
      deriveMemoryBaseUrl('wss://name:secret@example.test/realtime'),
    ).toThrow();
    expect(validateMemoryBaseUrl('https://example.test/v1/')).toBe(
      'https://example.test/v1',
    );
  });
});
