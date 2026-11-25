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

vi.mock('../index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  subscribeConfigValue: mocks.subscribeConfigValue,
}));

vi.mock('../../utils/runLogger.js', () => ({
  runLogger: {
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('config-service/features/modelStreamDiagnostics', () => {
  let feature: typeof import('./modelStreamDiagnostics.js');
  let valueListener: ((value: unknown) => void) | undefined;

  beforeEach(async () => {
    vi.resetModules();
    mocks.getConfigValue.mockReset();
    mocks.subscribeConfigValue.mockReset();
    valueListener = undefined;
    mocks.subscribeConfigValue.mockImplementation(
      (_key: string, listener: (value: unknown) => void) => {
        valueListener = listener;
        return () => {};
      },
    );
    feature = await import('./modelStreamDiagnostics.js');
  });

  it('is disabled by default when the gate is missing', () => {
    mocks.getConfigValue.mockReturnValue(undefined);

    expect(feature.getModelStreamDiagnosticsConfig()).toEqual({
      enabled: false,
      progressIntervalMs: 15_000,
      progressChunkEvery: 128,
      includeResourceSnapshotOnError: true,
    });
  });

  it('supports boolean feature gate values', () => {
    mocks.getConfigValue.mockReturnValueOnce('true');

    expect(feature.getModelStreamDiagnosticsConfig()).toEqual({
      enabled: true,
      progressIntervalMs: 15_000,
      progressChunkEvery: 128,
      includeResourceSnapshotOnError: true,
    });
  });

  it('reads JSON string config values and clamps progress controls', () => {
    mocks.getConfigValue.mockReturnValueOnce(
      JSON.stringify({
        enabled: true,
        progress_interval_ms: 1,
        progress_chunk_every: 99_999,
        include_resource_snapshot_on_error: false,
      }),
    );

    expect(feature.getModelStreamDiagnosticsConfig()).toEqual({
      enabled: true,
      progressIntervalMs: 1_000,
      progressChunkEvery: 10_000,
      includeResourceSnapshotOnError: false,
    });
  });

  it('falls back to the onChange cache when the client cache has no value', () => {
    feature.registerModelStreamDiagnosticsFeature();

    expect(mocks.subscribeConfigValue).toHaveBeenCalledWith(
      'model_stream_diagnostics',
      expect.any(Function),
    );

    valueListener?.({
      enabled: true,
      progressIntervalMs: 30_000,
      progressChunkEvery: 256,
      resourceSnapshotOnError: false,
    });
    mocks.getConfigValue.mockReturnValue(undefined);

    expect(feature.getModelStreamDiagnosticsConfig()).toEqual({
      enabled: true,
      progressIntervalMs: 30_000,
      progressChunkEvery: 256,
      includeResourceSnapshotOnError: false,
    });
  });

  it('keeps the last valid value when a fresh gate value is invalid', () => {
    feature.registerModelStreamDiagnosticsFeature();

    valueListener?.({
      enabled: true,
      progress_interval_ms: 20_000,
      progress_chunk_every: 64,
    });

    mocks.getConfigValue.mockReturnValue('{bad json');

    expect(feature.getModelStreamDiagnosticsConfig()).toEqual({
      enabled: true,
      progressIntervalMs: 20_000,
      progressChunkEvery: 64,
      includeResourceSnapshotOnError: true,
    });
  });
});
