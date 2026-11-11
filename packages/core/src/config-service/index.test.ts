/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigKey, ConfigService, ConfigReadiness } from './config-service.js';

const mocks = vi.hoisted(() => ({
  registerBuiltInFeatures: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./features/index.js', () => ({
  registerBuiltInFeatures: mocks.registerBuiltInFeatures,
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    debug: mocks.debug,
    log: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
  },
}));

import {
  initializeConfigService,
  installConfigService,
  stopConfigService,
} from './index.js';

describe('config-service source lifecycle', () => {
  it('registers features before start and registers again after stop', async () => {
    const events: string[] = [];
    const source: ConfigService = {
      start: async () => {
        events.push('start');
      },
      stop: async () => {
        events.push('stop');
      },
      getValue: () => undefined,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    mocks.registerBuiltInFeatures.mockImplementation(() => {
      events.push('register');
    });
    installConfigService(source);

    await initializeConfigService();
    await initializeConfigService();

    expect(events).toEqual(['register', 'start', 'start']);

    await stopConfigService();
    // 最终释放解除全局安装；新的应用显式安装它要使用的来源。
    installConfigService(source);
    await initializeConfigService();

    expect(events).toEqual([
      'register',
      'start',
      'start',
      'stop',
      'register',
      'start',
    ]);
  });
});

// Regression guard: startup paths (fetch diagnostics, experiments) read gates
// before a source is installed, because bringing the source up itself requires
// network requests. Throwing there failed the in-flight request and surfaced as
// a network error, so reads must degrade to "no value yet".
describe('config-service reads before a source is installed', () => {
  beforeEach(() => {
    mocks.warn.mockReset();
  });

  /** A pristine copy of the module, so the installed source stays undefined. */
  async function importWithoutSource() {
    vi.resetModules();
    return await import('./index.js');
  }

  it('getConfigValue returns undefined instead of throwing', async () => {
    const fresh = await importWithoutSource();

    expect(() => fresh.getConfigValue('echo')).not.toThrow();
    expect(fresh.getConfigValue('echo')).toBeUndefined();
  });

  it('subscribeConfigValue warns and returns a callable no-op', async () => {
    const fresh = await importWithoutSource();

    const unsubscribe = fresh.subscribeConfigValue('echo', () => {});

    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(mocks.warn).toHaveBeenCalledWith(
      '[config-service] Dropped subscribeConfigValue before a source was installed',
      { key: 'echo' },
    );
  });

  it('reads through to the source once one is installed', async () => {
    const fresh = await importWithoutSource();
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>(key: ConfigKey): T | undefined =>
        (key === 'echo' ? { enabled: true } : undefined) as T | undefined,
      onValueChange: () => () => {},
      onError: () => () => {},
    };

    fresh.installConfigService(source);

    expect(fresh.getConfigValue('echo')).toEqual({ enabled: true });
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe('request configuration readiness', () => {
  async function createSource() {
    vi.resetModules();
    const service = await import('./index.js');
    let finish!: (result: ConfigReadiness) => void;
    const pending = new Promise<ConfigReadiness>((resolve) => {
      finish = resolve;
    });
    const source: ConfigService = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getValue: () => undefined,
      onValueChange: () => () => {},
      onError: () => () => {},
      ensureReady: vi.fn(() => pending),
    };
    service.installConfigService(source);
    return { service, source, finish };
  }

  it('does not mistake a completed transport start for request readiness', async () => {
    const { service, source, finish } = await createSource();
    await service.initializeConfigService();
    let settled = false;
    const request = service.ensureConfigReadyForRequest().then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(source.start).toHaveBeenCalledOnce();
    finish({
      status: 'degraded',
      source: 'defaults',
      reason: 'offline',
      revision: '1',
    });
    await expect(request).resolves.toMatchObject({ status: 'degraded' });
  });

  it('cancels only one waiter while another still receives the shared result', async () => {
    const { service, source, finish } = await createSource();
    const controller = new AbortController();
    const cancelled = service.ensureConfigReadyForRequest({
      signal: controller.signal,
    });
    const active = service.ensureConfigReadyForRequest();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.stop).not.toHaveBeenCalled();
    finish({ status: 'ready', source: 'remote', revision: '2' });
    await expect(active).resolves.toMatchObject({
      status: 'ready',
      revision: '2',
    });
  });

  it('joins concurrent initialization for sources without a readiness capability', async () => {
    vi.resetModules();
    const service = await import('./index.js');
    let finish!: () => void;
    const source: ConfigService = {
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      stop: vi.fn(async () => {}),
      getValue: () => undefined,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    service.installConfigService(source);
    const prewarm = service.initializeConfigService();
    const request = service.ensureConfigReadyForRequest();
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.start).toHaveBeenCalledOnce();
    finish();
    await prewarm;
    await expect(request).resolves.toMatchObject({
      status: 'ready',
      source: 'local',
    });
  });
});
