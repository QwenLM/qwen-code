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
 *
 * The opentui-branch suites pin the R1-126/127/128 startup wiring: the
 * remote-input watcher outlives mount and shuts down in the exit drain,
 * the session registry is announced after mount, and JSON-output flags
 * never boot a renderer with no DualOutputBridge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { InitializationResult } from '../core/initializer.js';

const registerSession = vi.hoisted(() => vi.fn());
const registerCleanup = vi.hoisted(() => vi.fn());
const rendererState = vi.hoisted(() => ({
  id: 'ink' as 'ink' | 'opentui',
  explicit: false,
}));
const probeSupported = vi.hoisted(() => ({ value: true }));
const startOpenTuiUI = vi.hoisted(() => vi.fn(async () => undefined));
const watcherState = vi.hoisted(() => ({
  instances: [] as Array<{ inputFile: string; shutdownCount: number }>,
}));
const dualOutputState = vi.hoisted(() => ({ count: 0 }));

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

vi.mock('./render/dispatch.js', () => ({
  pickRenderer: () => rendererState.id,
  isExperimentalRenderer: (id: string) => id === 'opentui',
  rendererExplicitlyRequested: () => rendererState.explicit,
}));

vi.mock('./render/runtime-gate.js', () => ({
  probeOpenTuiRuntime: () => ({
    runtime: 'node',
    supported: probeSupported.value,
    reason: 'test probe',
  }),
  ensureOpenTuiRuntimeSupported: vi.fn(),
}));

vi.mock('./render/opentui-entry.js', () => ({
  startOpenTuiUI: (...args: unknown[]) => startOpenTuiUI(...args),
}));

vi.mock('../remoteInput/RemoteInputWatcher.js', () => ({
  RemoteInputWatcher: class {
    readonly inputFile: string;
    shutdownCount = 0;
    constructor(inputFile: string) {
      this.inputFile = inputFile;
      watcherState.instances.push(this);
    }
    shutdown(): void {
      this.shutdownCount += 1;
    }
  },
}));

// The real bridge would open the raw fd/file — in a vitest worker fd 3 is
// the tinypool IPC channel, and writing session_start through it kills the
// worker. The stub only needs to exist for the ink path to construct it.
vi.mock('../dualOutput/DualOutputBridge.js', () => ({
  DualOutputBridge: class {
    constructor() {
      dualOutputState.count += 1;
    }
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  },
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
    rendererState.id = 'ink';
    rendererState.explicit = false;
    probeSupported.value = true;
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

describe('startInteractiveUI opentui branch (R1-126/127/128)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rendererState.id = 'opentui';
    rendererState.explicit = false;
    probeSupported.value = true;
    startOpenTuiUI.mockReset();
    startOpenTuiUI.mockResolvedValue(undefined);
    watcherState.instances.length = 0;
    dualOutputState.count = 0;
  });

  it('registers the session and arms unregister after mount (R1-127)', async () => {
    registerSession.mockResolvedValue(true);
    const config = makeConfig();

    await start(config);

    expect(startOpenTuiUI).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledWith({
      sessionId: 'session-123',
      cwd: '/work/app',
      qwenVersion: '9.9.9',
    });
    expect(config.trackSessionRegistration).toHaveBeenCalledTimes(1);
    // Mount succeeded: the exit drain arms both the (here no-op) watcher
    // shutdown and the unregister cleanup.
    expect(registerCleanup).toHaveBeenCalledTimes(2);
    const unregister = registerCleanup.mock
      .calls[1]?.[0] as () => Promise<void>;
    await unregister();
    expect(config.unregisterSessionRegistry).toHaveBeenCalledTimes(1);
  });

  it('keeps the remote-input watcher alive past mount, shutdown only in the exit drain (R1-126)', async () => {
    const config = makeConfig();
    (config as { getInputFile?: () => string }).getInputFile = () =>
      '/tmp/in.jsonl';

    await start(config);

    expect(watcherState.instances).toHaveLength(1);
    expect(watcherState.instances[0]?.inputFile).toBe('/tmp/in.jsonl');
    // Mount resolved — the watcher must still be alive (the old finally
    // clause killed it at mount time, cutting remote input for the whole
    // session).
    expect(watcherState.instances[0]?.shutdownCount).toBe(0);
    expect(registerCleanup).toHaveBeenCalledTimes(2);
    const shutdownWatcher = registerCleanup.mock.calls[0]?.[0] as () => void;
    shutdownWatcher();
    expect(watcherState.instances[0]?.shutdownCount).toBe(1);
  });

  it('shuts the watcher down when the opentui mount itself fails (R1-126)', async () => {
    startOpenTuiUI.mockRejectedValue(new Error('mount failed'));
    const config = makeConfig();
    (config as { getInputFile?: () => string }).getInputFile = () =>
      '/tmp/in.jsonl';

    await expect(start(config)).rejects.toThrow('mount failed');

    // The exit drain never armed, so the watcher must have been released
    // in the catch path — and no session registration happened.
    expect(watcherState.instances[0]?.shutdownCount).toBe(1);
    expect(registerCleanup).not.toHaveBeenCalled();
    expect(registerSession).not.toHaveBeenCalled();
  });

  it('routes JSON-output launches back to ink (R1-128)', async () => {
    registerSession.mockResolvedValue(true);
    const config = makeConfig();
    (config as { getJsonFd?: () => number }).getJsonFd = () => 3;

    await start(config);

    expect(startOpenTuiUI).not.toHaveBeenCalled();
    // ink owns the DualOutputBridge (constructed for the JSON fd); its
    // session registration still runs.
    expect(dualOutputState.count).toBe(1);
    expect(registerSession).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when an explicit opentui request contradicts JSON output flags (R1-128)', async () => {
    rendererState.explicit = true;
    const config = makeConfig();
    (config as { getJsonFile?: () => string }).getJsonFile = () =>
      '/tmp/out.jsonl';
    // A mocked exit that returns would let the run continue into the ink
    // path (constructing a REAL DualOutputBridge over the test worker's IPC
    // channel); throwing mirrors exit's real never-return semantics.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('simulated process.exit(1)');
    }) as never);
    try {
      await expect(start(config)).rejects.toThrow('simulated process.exit');
      // Assert before mockRestore — restoring clears the spy's call log.
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }

    expect(startOpenTuiUI).not.toHaveBeenCalled();
    expect(registerSession).not.toHaveBeenCalled();
  });
});
