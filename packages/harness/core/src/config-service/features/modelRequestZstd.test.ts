/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));
vi.mock('../../utils/runLogger.js', () => ({
  runLogger: { warn: mocks.warn, log: vi.fn() },
}));

describe('model request zstd policy', () => {
  let feature: typeof import('./modelRequestZstd.js');
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getConfigValue.mockReturnValue(undefined);
    for (const name of [
      'QWEN_ZSTD_REQUEST_BODIES',
      'QWEN_ZSTD_REQUEST_BODY_LEVEL',
      'QWEN_ZSTD_REQUEST_BODY_MIN_CHARS',
    ])
      vi.stubEnv(name, undefined);
    feature = await import('./modelRequestZstd.js');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to disabled with a 4096-code-unit threshold and level 1', () => {
    expect(feature.getModelRequestZstdConfig()).toEqual({
      enabled: false,
      transports: ['legacy'],
      minBodyChars: 4096,
      level: 1,
      source: 'default',
    });
  });

  it.each([1, 3, 10, 22])(
    'accepts zstd level %s from QCS and the environment',
    (level) => {
      mocks.getConfigValue.mockReturnValue({ enabled: true, level });
      expect(feature.getModelRequestZstdConfig()).toMatchObject({
        level,
        source: 'qcs',
      });
      vi.stubEnv('QWEN_ZSTD_REQUEST_BODY_LEVEL', String(level));
      expect(feature.getModelRequestZstdConfig()).toMatchObject({
        level,
        source: 'env',
      });
    },
  );

  it('does not enable zstd from old gzip configuration', () => {
    vi.stubEnv('QODER_GZIP_REQUEST_BODIES', '1');
    mocks.getConfigValue.mockImplementation((key) =>
      key === 'model_request_gzip' ? { enabled: true } : undefined,
    );
    expect(feature.getModelRequestZstdConfig().enabled).toBe(false);
  });

  it('reads QCS JSON and hot updates without changing an existing snapshot', () => {
    mocks.getConfigValue.mockReturnValue(
      JSON.stringify({
        enabled: true,
        transports: ['legacy'],
        min_body_chars: 8192,
        level: 3,
      }),
    );
    const snapshot = feature.getModelRequestZstdConfig();
    expect(snapshot).toMatchObject({
      enabled: true,
      transports: ['legacy'],
      minBodyChars: 8192,
      level: 3,
      source: 'qcs',
    });
    mocks.getConfigValue.mockReturnValue({ enabled: false });
    expect(feature.getModelRequestZstdConfig().enabled).toBe(false);
    expect(snapshot.enabled).toBe(true);
  });

  it('honors explicit enable for the legacy adapter and independent numeric overrides', () => {
    mocks.getConfigValue.mockReturnValue({
      enabled: false,
      transports: [],
      min_body_chars: 8192,
      level: 5,
    });
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODIES', '1');
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODY_MIN_CHARS', '1024');
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODY_LEVEL', '2');
    expect(feature.getModelRequestZstdConfig()).toEqual({
      enabled: true,
      transports: ['legacy'],
      minBodyChars: 1024,
      level: 2,
      source: 'env',
    });
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODIES', '0');
    mocks.getConfigValue.mockReturnValue({ enabled: true });
    expect(feature.getModelRequestZstdConfig().enabled).toBe(false);
  });

  it('keeps QCS numeric values when only the enable override is set', () => {
    mocks.getConfigValue.mockReturnValue({
      enabled: false,
      min_body_chars: 16384,
      level: 4,
    });
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODIES', 'true');
    expect(feature.getModelRequestZstdConfig()).toMatchObject({
      enabled: true,
      minBodyChars: 16384,
      level: 4,
    });
  });

  it.each([
    { enabled: 'bad' },
    { level: 23 },
    { level: 0 },
    { level: 1.5 },
    { min_body_chars: 0 },
    { min_body_chars: 1.5 },
    { transports: ['grpc'] },
    [],
  ])('preserves the last valid policy on invalid QCS: %j', (invalid) => {
    mocks.getConfigValue.mockReturnValue({ enabled: true, level: 2 });
    feature.getModelRequestZstdConfig();
    mocks.getConfigValue.mockReturnValue(invalid);
    expect(feature.getModelRequestZstdConfig()).toMatchObject({
      enabled: true,
      level: 2,
    });
  });

  it('ignores invalid environment values and warns only once per value', () => {
    mocks.getConfigValue.mockReturnValue({
      enabled: true,
      level: 3,
      min_body_chars: 8192,
    });
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODIES', 'bad');
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODY_LEVEL', '0');
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODY_MIN_CHARS', '-1');
    for (let i = 0; i < 2; i++)
      expect(feature.getModelRequestZstdConfig()).toMatchObject({
        enabled: true,
        level: 3,
        minBodyChars: 8192,
        source: 'qcs',
      });
    expect(mocks.warn).toHaveBeenCalledTimes(3);
  });

  it('restores disabled defaults when QCS removes the key or clears an identity', () => {
    feature.registerModelRequestZstdFeature();
    const listener = mocks.subscribeConfigValue.mock.calls[0][1];
    mocks.getConfigValue.mockReturnValue({ enabled: true, level: 3 });
    listener({ enabled: true, level: 3 });
    expect(feature.getModelRequestZstdConfig().enabled).toBe(true);
    mocks.getConfigValue.mockReturnValue(undefined);
    listener(undefined);
    expect(feature.getModelRequestZstdConfig()).toMatchObject({
      enabled: false,
      level: 1,
      source: 'default',
    });
  });

  it('resets a missing value on read even before the subscription runs', () => {
    mocks.getConfigValue.mockReturnValue({ enabled: true });
    expect(feature.getModelRequestZstdConfig().enabled).toBe(true);
    mocks.getConfigValue.mockReturnValue(undefined);
    expect(feature.getModelRequestZstdConfig().enabled).toBe(false);
    vi.stubEnv('QWEN_ZSTD_REQUEST_BODIES', '1');
    expect(feature.getModelRequestZstdConfig().enabled).toBe(true);
  });

  it('registers the gate and ignores the retired http transport', () => {
    feature.registerModelRequestZstdFeature();
    const [key, listener] = mocks.subscribeConfigValue.mock.calls[0];
    expect(key).toBe('model_request_zstd');
    const policy = { enabled: true, transports: ['legacy', 'http'] };
    mocks.getConfigValue.mockReturnValue(policy);
    listener(policy);
    mocks.getConfigValue.mockReturnValue({ level: 'bad' });
    listener({ level: 'bad' });
    expect(feature.getModelRequestZstdConfig()).toMatchObject({
      enabled: true,
      transports: ['legacy'],
    });
  });
});
