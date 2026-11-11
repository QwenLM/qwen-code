/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuiltinPluginContext } from '@qwen-code/core';
import { QwenInstallationPlugin } from './plugin.js';
import { AUTO_UPDATE_DELAY_MS } from './update/updateTypes.js';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  update: vi.fn(),
  paused: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('./qwen/operations.js', () => ({
  createQwenInstallation: () => ({
    check: mocks.check,
    update: mocks.update,
    isPaused: mocks.paused,
  }),
}));
vi.mock('../utils/updateEventEmitter.js', () => ({
  updateEventEmitter: { emit: mocks.emit },
}));

function host(mode: 'interactive' | 'headless' = 'interactive') {
  const abort = new AbortController();
  let ready!: () => void;
  const permission = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const settings = vi.fn(async () => ({
    enableAutoUpdate: true,
    enableAutoUpdateNotification: true,
  }));
  const value: BuiltinPluginContext = {
    mode,
    signal: abort.signal,
    localSession: true,
    runtime: { prepare: vi.fn(async () => {}), getSetting: settings },
    whenReady: () => permission,
    getLaunchSetting: () => undefined,
    isSettingSourceAllowed: () => true,
    notifyChanged: async () => {},
  };
  return { value, ready, abort, settings };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('QWEN_CODE_RELEASE_BASE_URL', 'https://qwen.example.test/1.x');
  vi.stubEnv('DEV', false);
  mocks.paused.mockResolvedValue(false);
  mocks.check.mockResolvedValue({
    current: '1.0.0',
    latest: '1.0.1',
    available: true,
  });
  mocks.update.mockResolvedValue({ version: '1.0.1', changed: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function start(
  plugin: QwenInstallationPlugin,
  context: ReturnType<typeof host>,
) {
  await plugin.initialize(context.value);
  context.ready();
  // Let readiness and the lazy release-configuration import settle before the timer.
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
}
describe('Qwen installation plugin', () => {
  it('declares local commands without starting background work', () => {
    expect(
      new QwenInstallationPlugin()
        .getTerminalCommands()
        .map(({ command, startup }) => [command.name(), startup]),
    ).toEqual([
      ['install', 'local'],
      ['update', 'local'],
      ['rollback', 'local'],
      ['configure-path', 'local'],
    ]);
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it('waits for readiness and pins the checked release when updating', async () => {
    const plugin = new QwenInstallationPlugin('/workspace');
    const context = host();
    await plugin.initialize(context.value);
    expect(vi.getTimerCount()).toBe(0);
    await start(plugin, context);
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      version: '1.0.1',
      automatic: true,
    });
    expect(context.settings).toHaveBeenCalledWith('/workspace', 'general');
    expect(context.value.runtime?.prepare).not.toHaveBeenCalled();
    await plugin.dispose();
  });
  it('supports notification-only settings without installing', async () => {
    const plugin = new QwenInstallationPlugin();
    const context = host();
    context.settings.mockResolvedValue({
      enableAutoUpdate: false,
      enableAutoUpdateNotification: true,
    });
    await start(plugin, context);
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith(
      'update-received',
      expect.not.objectContaining({ isUpdating: true }),
    );
    await plugin.dispose();
  });
  it('does not check during the rollback pause', async () => {
    mocks.paused.mockResolvedValue(true);
    const plugin = new QwenInstallationPlugin();
    await start(plugin, host());
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(mocks.check).not.toHaveBeenCalled();
    await plugin.dispose();
  });
  it('cancels pending work on abort', async () => {
    const plugin = new QwenInstallationPlugin();
    const context = host();
    await start(plugin, context);
    context.abort.abort();
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS);
    expect(mocks.check).not.toHaveBeenCalled();
    await plugin.dispose();
  });
  it('does not start for headless entries or an unconfigured build', async () => {
    for (const mode of ['headless', 'interactive'] as const) {
      vi.stubEnv('QWEN_CODE_RELEASE_BASE_URL', '');
      const plugin = new QwenInstallationPlugin();
      const context = host(mode);
      await plugin.initialize(context.value);
      context.ready();
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_DELAY_MS * 2);
      await plugin.dispose();
    }
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
