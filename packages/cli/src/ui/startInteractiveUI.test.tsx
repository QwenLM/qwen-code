/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pins the session-registry wiring in startInteractiveUI: registration
 * arguments, cleanup armed only on success, and failures swallowed.
 * Deleting the import or the registration block keeps every other test
 * green — without this file, interactive sessions could silently stop
 * appearing in `qwen sessions ps` (or never disappear from it).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { InitializationResult } from '../core/initializer.js';

const registerSession = vi.hoisted(() => vi.fn());
const registerCleanup = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    registerSession: (...args: unknown[]) => registerSession(...args),
  };
});

vi.mock('ink', () => ({
  render: vi.fn(() => ({ unmount: vi.fn() })),
}));

vi.mock('../utils/cleanup.js', () => ({
  registerCleanup: (...args: unknown[]) => registerCleanup(...args),
  runExitCleanup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/version.js', () => ({
  getCliVersion: vi.fn(() => Promise.resolve('9.9.9')),
}));

vi.mock('../startup/startup-prefetch.js', () => ({
  startPostRenderPrefetches: vi.fn(),
}));

vi.mock('../utils/earlyInputCapture.js', () => ({
  stopAndGetCapturedInput: vi.fn(() => ''),
}));

const { startInteractiveUI } = await import('./startInteractiveUI.js');

function makeConfig(): Config & {
  trackSessionRegistration: ReturnType<typeof vi.fn>;
  unregisterSessionRegistry: ReturnType<typeof vi.fn>;
} {
  const trackSessionRegistration = vi.fn((registration: Promise<boolean>) => {
    void registration.catch(() => undefined);
  });
  return {
    getSessionId: () => 'session-123',
    getTargetDir: () => '/work/app',
    getScreenReader: () => false,
    getChatRecordingService: () => undefined,
    isTelemetryInitializationDeferred: () => false,
    trackSessionRegistration,
    unregisterSessionRegistry: vi.fn().mockResolvedValue(undefined),
  } as unknown as Config & {
    trackSessionRegistration: ReturnType<typeof vi.fn>;
    unregisterSessionRegistry: ReturnType<typeof vi.fn>;
  };
}

const settings = {
  merged: { ui: { hideWindowTitle: true } },
} as unknown as LoadedSettings;

const initializationResult = {
  authError: null,
  themeError: null,
  shouldOpenAuthDialog: false,
  geminiMdFileCount: 0,
} as InitializationResult;

async function start(config: Config = makeConfig()): Promise<void> {
  await startInteractiveUI(
    config,
    settings,
    [],
    '/work/app',
    initializationResult,
  );
}

describe('startInteractiveUI session registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the session with its id, target dir, and CLI version', async () => {
    registerSession.mockResolvedValue(true);
    const config = makeConfig();

    await start(config);

    expect(registerSession).toHaveBeenCalledWith({
      sessionId: 'session-123',
      cwd: '/work/app',
      qwenVersion: '9.9.9',
    });
    expect(config.trackSessionRegistration).toHaveBeenCalledTimes(1);
    await expect(
      config.trackSessionRegistration.mock.calls[0]?.[0],
    ).resolves.toBe(true);
  });

  it('arms teardown before serialized registry cleanup', async () => {
    registerSession.mockResolvedValue(true);
    const config = makeConfig();
    await start(config);

    expect(registerCleanup).toHaveBeenCalledTimes(2);
    const armUnregister = registerCleanup.mock
      .calls[1]?.[0] as () => Promise<void> | void;
    await armUnregister();
    expect(config.unregisterSessionRegistry).toHaveBeenCalledTimes(1);
  });

  it('does not await a stalled registration before returning startup', async () => {
    registerSession.mockReturnValue(new Promise<boolean>(() => undefined));
    const config = makeConfig();

    const result = await Promise.race([
      start(config).then(() => 'started'),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('timed-out'), 50),
      ),
    ]);

    expect(result).toBe('started');
    expect(registerCleanup).toHaveBeenCalledTimes(2);
  });

  it('tracks a registration rejection without aborting startup', async () => {
    registerSession.mockRejectedValue(new Error('read-only home'));
    const config = makeConfig();

    await expect(start(config)).resolves.toBeUndefined();
    expect(config.trackSessionRegistration).toHaveBeenCalledTimes(1);
  });
});
