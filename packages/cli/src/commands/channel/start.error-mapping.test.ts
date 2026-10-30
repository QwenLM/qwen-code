/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetGlobalDispatcher = vi.hoisted(() => vi.fn());
const mockEnvHttpProxyAgent = vi.hoisted(() =>
  vi.fn((opts: { httpProxy: string; httpsProxy: string }) => ({
    proxyUrl: opts.httpProxy,
  })),
);
const mockNormalizeProxyUrl = vi.hoisted(() => vi.fn((url?: string) => url));
const mockStorageGetGlobalQwenDir = vi.hoisted(() =>
  vi.fn(() => '/tmp/qwen-home'),
);
const mockReadChannelMemory = vi.hoisted(() => vi.fn());
const mockGetChannelMemoryRevision = vi.hoisted(() => vi.fn());
const mockListChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockAddChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockUpdateChannelMemoryEntry = vi.hoisted(() => vi.fn());
const mockRemoveChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockClearChannelMemory = vi.hoisted(() => vi.fn());
const mockRecordChannelMemoryRecallMetrics = vi.hoisted(() => vi.fn());
const mockParseCron = vi.hoisted(() => vi.fn());
const mockNextFireTime = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockGetExtensionManager = vi.hoisted(() => vi.fn());
const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockWriteServiceInfo = vi.hoisted(() => vi.fn());
const mockRemoveServiceInfo = vi.hoisted(() => vi.fn());
const mockFindCliEntryPath = vi.hoisted(() => vi.fn());
const mockParseChannelConfig = vi.hoisted(() => vi.fn());
const mockGetPlugin = vi.hoisted(() => vi.fn());
const mockRegisterPlugin = vi.hoisted(() => vi.fn());
const mockChannelConnect = vi.hoisted(() => vi.fn());
const mockChannelDisconnect = vi.hoisted(() => vi.fn());
const mockChannelSetBridge = vi.hoisted(() => vi.fn());
const mockChannelOnToolCall = vi.hoisted(() => vi.fn());
const mockChannelDispatchToolCall = vi.hoisted(() => vi.fn());
const mockChannelOnSessionDied = vi.hoisted(() => vi.fn());
const mockChannelOnBridgeDisconnected = vi.hoisted(() => vi.fn());
const mockCreateChannel = vi.hoisted(() => vi.fn());
const mockBridgeStart = vi.hoisted(() => vi.fn());
const mockBridgeStop = vi.hoisted(() => vi.fn());
const mockBridgeOn = vi.hoisted(() => vi.fn());
const mockAcpBridge = vi.hoisted(() =>
  vi.fn(() => ({
    on: mockBridgeOn,
    start: mockBridgeStart,
    stop: mockBridgeStop,
  })),
);
const mockSanitizeLogText = vi.hoisted(() =>
  vi.fn((text: string, maxLen: number) =>
    String(text).slice(0, maxLen).replace(/\n/g, '\\n').replace(/\r/g, ' '),
  ),
);
const mockRouterClearAll = vi.hoisted(() => vi.fn());
const mockRouterGetTarget = vi.hoisted(() => vi.fn());
const mockRouterHandleSessionDied = vi.hoisted(() => vi.fn());
const mockRouterRestoreSessions = vi.hoisted(() => vi.fn());
const mockRouterSetBridge = vi.hoisted(() => vi.fn());
const mockRouterSetChannelApprovalMode = vi.hoisted(() => vi.fn());
const mockRouterSetChannelScope = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreCreate = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreCreateForTarget = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreListForTarget = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreDisable = vi.hoisted(() => vi.fn());
const mockChannelLoopStore = vi.hoisted(() =>
  vi.fn(() => ({
    create: mockChannelLoopStoreCreate,
    createForTarget: mockChannelLoopStoreCreateForTarget,
    listForTarget: mockChannelLoopStoreListForTarget,
    disable: mockChannelLoopStoreDisable,
  })),
);
const mockChannelLoopSchedulerStart = vi.hoisted(() => vi.fn());
const mockChannelLoopSchedulerStop = vi.hoisted(() => vi.fn());
const mockChannelLoopSchedulerMarkRecovery = vi.hoisted(() => vi.fn());
const mockChannelLoopScheduler = vi.hoisted(() =>
  vi.fn((_options?: unknown) => ({
    start: mockChannelLoopSchedulerStart,
    stop: mockChannelLoopSchedulerStop,
    markBridgeRecovery: mockChannelLoopSchedulerMarkRecovery,
  })),
);
const mockSessionRouter = vi.hoisted(() =>
  vi.fn(() => ({
    clearAll: mockRouterClearAll,
    getTarget: mockRouterGetTarget,
    handleSessionDied: mockRouterHandleSessionDied,
    restoreSessions: mockRouterRestoreSessions,
    setBridge: mockRouterSetBridge,
    setChannelApprovalMode: mockRouterSetChannelApprovalMode,
    setChannelScope: mockRouterSetChannelScope,
  })),
);

vi.mock('undici', () => ({
  EnvHttpProxyAgent: mockEnvHttpProxyAgent,
  setGlobalDispatcher: mockSetGlobalDispatcher,
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  addChannelMemoryEntries: mockAddChannelMemoryEntries,
  clearChannelMemory: mockClearChannelMemory,
  getChannelMemoryRevision: mockGetChannelMemoryRevision,
  listChannelMemoryEntries: mockListChannelMemoryEntries,
  nextFireTime: mockNextFireTime,
  normalizeProxyUrl: mockNormalizeProxyUrl,
  parseCron: mockParseCron,
  readChannelMemory: mockReadChannelMemory,
  recordChannelMemoryRecallMetrics: mockRecordChannelMemoryRecallMetrics,
  removeChannelMemoryEntries: mockRemoveChannelMemoryEntries,
  updateChannelMemoryEntry: mockUpdateChannelMemoryEntry,
  Storage: {
    getGlobalQwenDir: mockStorageGetGlobalQwenDir,
  },
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock('../extensions/utils.js', () => ({
  getExtensionManager: mockGetExtensionManager,
}));

vi.mock('./pidfile.js', () => ({
  readServiceInfo: mockReadServiceInfo,
  removeServiceInfo: mockRemoveServiceInfo,
  writeServiceInfo: mockWriteServiceInfo,
}));

vi.mock('./config-utils.js', () => ({
  findCliEntryPath: mockFindCliEntryPath,
  parseChannelConfig: mockParseChannelConfig,
}));

vi.mock('./channel-registry.js', () => ({
  getPlugin: mockGetPlugin,
  registerPlugin: mockRegisterPlugin,
}));

vi.mock('@qwen-code/channel-base', () => ({
  AcpBridge: mockAcpBridge,
  ChannelLoopScheduler: mockChannelLoopScheduler,
  ChannelLoopStore: mockChannelLoopStore,
  sanitizeLogText: mockSanitizeLogText,
  SessionRouter: mockSessionRouter,
}));

import { startCommand } from './start.js';

type StartCommandArgs = Parameters<NonNullable<typeof startCommand.handler>>[0];

const invokeStartHandler = async (
  args: Partial<StartCommandArgs>,
): Promise<void> => {
  const handler = startCommand.handler;
  if (!handler) {
    throw new Error('startCommand handler is missing');
  }
  await handler({ _: [], $0: 'qwen', ...args } as StartCommandArgs);
};

const mockParsedChannelConfig = {
  cwd: '/tmp/qwen-channel-test',
  model: 'qwen-test-model',
  sessionScope: 'user',
  type: 'telegram',
};

const mockChannel = {
  connect: mockChannelConnect,
  disconnect: mockChannelDisconnect,
  onSessionDied: mockChannelOnSessionDied,
  onToolCall: mockChannelOnToolCall,
  dispatchToolCall: mockChannelDispatchToolCall,
  onBridgeDisconnected: mockChannelOnBridgeDisconnected,
  setBridge: mockChannelSetBridge,
};

interface ObservedStart {
  /** Everything the handler wrote to the real stderr sink. */
  stderr: string;
  /** Everything the handler wrote to the real stdout sink. */
  stdout: string;
  /** What escaped the handler, if anything. */
  thrown: unknown;
}

/**
 * Drives one channel start whose pidfile write throws `failure`, capturing the
 * real process stdio sinks and turning `process.exit` into a throw.
 *
 * Capturing the real sinks (rather than a module mock) is what makes the
 * "exactly one operator-facing line, no usage dump, no stack trace" contract
 * observable: anything extra the handler prints lands in `stderr`/`stdout`.
 */
const startWithPidfileFailure = async (
  failure: unknown,
): Promise<ObservedStart> => {
  mockLoadSettings.mockReturnValue({
    merged: { channels: { telegram: { type: 'telegram' } } },
  });
  mockChannelConnect.mockResolvedValue(undefined);
  mockWriteServiceInfo.mockImplementationOnce(() => {
    throw failure;
  });

  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: unknown,
  ) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as never);
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
  ) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as never);
  const consoleErrorSpy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      stderrChunks.push(`${args.map((a) => String(a)).join(' ')}\n`);
    });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit: ${String(code)}`);
  });

  let thrown: unknown;
  try {
    await invokeStartHandler({ name: 'telegram' });
  } catch (error) {
    thrown = error;
  } finally {
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return {
    stderr: stderrChunks.join(''),
    stdout: stdoutChunks.join(''),
    thrown,
  };
};

/** Non-empty lines, which is the operator-visible surface. */
const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

/**
 * Asserts the whole contract for one mapped failure: exit 1, exactly one
 * stderr line carrying `Error: <reason>`, nothing on stdout, no yargs usage
 * dump and no stack frames.
 */
const expectSingleOperatorLine = (
  observed: ObservedStart,
  reason: string,
): void => {
  expect(observed.thrown).toBeInstanceOf(Error);
  expect((observed.thrown as Error).message).toBe('process.exit: 1');
  expect(linesOf(observed.stderr)).toEqual([`Error: ${reason}`]);
  expect(observed.stderr).not.toContain('at ');
  expect(observed.stderr).not.toMatch(/^\s+at\s/m);
  expect(observed.stderr).not.toContain('Usage:');
  expect(observed.stderr).not.toContain('Options:');
  expect(linesOf(observed.stdout)).toEqual([]);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockBridgeStart.mockResolvedValue(undefined);
  mockChannelConnect.mockResolvedValue(undefined);
  mockCreateChannel.mockReturnValue(mockChannel);
  mockFindCliEntryPath.mockReturnValue('/tmp/qwen-cli-entry.js');
  mockGetExtensionManager.mockResolvedValue({ getLoadedExtensions: () => [] });
  mockGetPlugin.mockResolvedValue({ createChannel: mockCreateChannel });
  mockLoadSettings.mockReturnValue({ merged: { channels: {} } });
  mockNormalizeProxyUrl.mockImplementation((url?: string) => url);
  mockNextFireTime.mockImplementation(
    () => new Date('2026-01-01T00:00:00.000Z'),
  );
  mockParseChannelConfig.mockResolvedValue(mockParsedChannelConfig);
  mockReadServiceInfo.mockReturnValue(null);
  mockRouterGetTarget.mockReturnValue(undefined);
  mockRouterRestoreSessions.mockResolvedValue({ failed: 0, restored: 0 });
  mockStorageGetGlobalQwenDir.mockReturnValue('/tmp/qwen-home');
  mockChannelLoopStoreCreate.mockResolvedValue({ id: 'job-1' });
  mockChannelLoopStoreCreateForTarget.mockResolvedValue({ id: 'job-1' });
  mockChannelLoopStoreListForTarget.mockResolvedValue([]);
  mockChannelLoopStoreDisable.mockResolvedValue(true);
  delete process.env['HTTPS_PROXY'];
  delete process.env['https_proxy'];
  delete process.env['HTTP_PROXY'];
  delete process.env['http_proxy'];
  delete process.env['QWEN_CODE_DISABLE_CRON'];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('writeServiceInfoOrExit error mapping', () => {
  it('maps a held pidfile lock to one line naming the lock and its stale recovery', async () => {
    // Mirrors pidfile-lock.ts: `code: 'ELOCKED'` plus a message that already
    // states the automatic stale-lock recovery window.
    const reason =
      'Channel pidfile lock /home/u/.qwen/channels/service.pid.lock is held; an abandoned lock recovers automatically after 30 seconds.';
    const failure = Object.assign(new Error(reason), { code: 'ELOCKED' });

    expectSingleOperatorLine(await startWithPidfileFailure(failure), reason);

    const reported = linesOf((await startWithPidfileFailure(failure)).stderr);
    expect(reported[0]).toContain('service.pid.lock is held');
    expect(reported[0]).toContain('recovers automatically after');
  });

  it('maps the process start token refusal to one line carrying the reason', async () => {
    // pidfile.ts throws this code-less, from a module-private helper, so a
    // `code`-based predicate structurally cannot catch it.
    const reason =
      'Unable to read the process start token for PID 4242; refusing to write an impersonable Channel pidfile.';
    const failure = new Error(reason);
    expect((failure as NodeJS.ErrnoException).code).toBeUndefined();

    expectSingleOperatorLine(await startWithPidfileFailure(failure), reason);
  });

  it('maps the PID namespace id refusal to one line carrying the reason', async () => {
    const reason =
      'Unable to read the PID namespace id; refusing to write an unreclaimable Channel pidfile.';
    const failure = new Error(reason);
    expect((failure as NodeJS.ErrnoException).code).toBeUndefined();

    expectSingleOperatorLine(await startWithPidfileFailure(failure), reason);
  });

  it('keeps the concurrent-start (EEXIST) mapping unchanged', async () => {
    const failure = new Error('EEXIST') as NodeJS.ErrnoException;
    failure.code = 'EEXIST';

    const observed = await startWithPidfileFailure(failure);

    expect(observed.thrown).toBeInstanceOf(Error);
    expect((observed.thrown as Error).message).toBe('process.exit: 1');
    expect(linesOf(observed.stderr)).toEqual([
      'Error: Channel service was started concurrently. Use "qwen channel status" to inspect it.',
    ]);
    expect(linesOf(observed.stdout)).toEqual([]);
  });

  it('keeps the unverifiable-pidfile mapping unchanged', async () => {
    const reason =
      'Channel service pidfile /home/u/.qwen/channels/service.pid holds a record this machine cannot verify.';
    const failure = Object.assign(new Error(reason), {
      code: 'channel_service_conflict',
    });

    expectSingleOperatorLine(await startWithPidfileFailure(failure), reason);
  });

  it('does not swallow an unrelated pidfile write failure', async () => {
    // The widening must stay a widening: an unmapped I/O failure still has to
    // reach the caller as-is instead of being disguised as an operator line.
    const failure = new Error(
      'ENOSPC: no space left on device',
    ) as NodeJS.ErrnoException;
    failure.code = 'ENOSPC';

    const observed = await startWithPidfileFailure(failure);

    expect(observed.thrown).toBe(failure);
    expect(linesOf(observed.stderr)).toEqual([]);
  });
});
