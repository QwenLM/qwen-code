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
const unregisterSession = vi.hoisted(() => vi.fn());
const registerCleanup = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    registerSession: (...args: unknown[]) => registerSession(...args),
    unregisterSession: (...args: unknown[]) => unregisterSession(...args),
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
  markSessionRegistered: ReturnType<typeof vi.fn>;
} {
  return {
    getSessionId: () => 'session-123',
    getTargetDir: () => '/work/app',
    getScreenReader: () => false,
    getChatRecordingService: () => undefined,
    isTelemetryInitializationDeferred: () => false,
    // Must exist: the production success path calls it, and a missing
    // member would throw a TypeError that the catch under test swallows —
    // leaving every assertion green while registration silently no-ops.
    markSessionRegistered: vi.fn(),
  } as unknown as Config & {
    markSessionRegistered: ReturnType<typeof vi.fn>;
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
    // Arms the mid-session /clear and /cd registry patches on this
    // Config; if this never fires, `ps` shows stale values until exit.
    expect(config.markSessionRegistered).toHaveBeenCalledTimes(1);
  });

  it('arms the unregister cleanup only when registration succeeded', async () => {
    // startInteractiveUI registers exactly one other cleanup (the UI
    // teardown) unconditionally, so the count differs by exactly one
    // depending on whether the unregister callback was armed.
    registerSession.mockResolvedValue(true);
    const successConfig = makeConfig();
    await start(successConfig);
    expect(registerCleanup).toHaveBeenCalledTimes(2);
    expect(unregisterSession).not.toHaveBeenCalled();
    expect(successConfig.markSessionRegistered).toHaveBeenCalledTimes(1);
    // Armed is not the contract — invoke the armed callback: a future
    // edit emptying its body would pass the call-count pins while every
    // session's record survives exit and `ps` lists it as running.
    const armUnregister = registerCleanup.mock
      .calls[0]?.[0] as () => Promise<void>;
    await armUnregister();
    expect(unregisterSession).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    registerSession.mockResolvedValue(false);
    const refusedConfig = makeConfig();
    await start(refusedConfig);
    expect(registerCleanup).toHaveBeenCalledTimes(1);
    expect(refusedConfig.markSessionRegistered).not.toHaveBeenCalled();
  });

  it('swallows a registration rejection without aborting startup', async () => {
    // A read-only home must not keep the TUI from launching; the
    // registration is wrapped precisely so its failure cannot propagate.
    registerSession.mockRejectedValue(new Error('read-only home'));
    const config = makeConfig();

    await expect(start(config)).resolves.toBeUndefined();
    expect(registerCleanup).toHaveBeenCalledTimes(1);
    expect(config.markSessionRegistered).not.toHaveBeenCalled();
  });
});
