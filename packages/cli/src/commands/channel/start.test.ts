import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChannelBaseOptions } from '@qwen-code/channel-base';

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
const mockNextFireTime = vi.hoisted(() =>
  vi.fn((cron: string) => {
    if (cron === '0 0 31 2 *') {
      throw new Error('No next fire time');
    }
    return new Date('2026-01-01T00:00:00.000Z');
  }),
);
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockGetExtensionManager = vi.hoisted(() => vi.fn());
const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockWriteServiceInfo = vi.hoisted(() => vi.fn());
const mockRemoveServiceInfo = vi.hoisted(() => vi.fn());
const mockChannelStateStoreReadAll = vi.hoisted(() => vi.fn(() => ({})));
const mockChannelStateStoreSet = vi.hoisted(() => vi.fn());
const mockChannelStateStoreSetMany = vi.hoisted(() => vi.fn());
const mockChannelStateStorePrune = vi.hoisted(() =>
  vi.fn(() => mockChannelStateStoreReadAll()),
);
const mockChannelStateStore = vi.hoisted(() =>
  vi.fn(() => ({
    readAll: mockChannelStateStoreReadAll,
    set: mockChannelStateStoreSet,
    setMany: mockChannelStateStoreSetMany,
    prune: mockChannelStateStorePrune,
    // Mirror the real best-effort wrappers so throwing `set`/`setMany`
    // mocks still exercise "persistence failure never blocks startup".
    // Return the persistence boolean like the real store: callers surface a
    // failed write (#8975).
    trySet: (name: string, state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSet(name, state);
        return true;
      } catch {
        // best-effort
        return false;
      }
    },
    trySetMany: (names: string[], state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSetMany(names, state);
        return true;
      } catch {
        // best-effort
        return false;
      }
    },
  })),
);
const mockSelectActiveChannels = vi.hoisted(
  () =>
    (
      names: readonly string[],
      states: Record<string, 'active' | 'stopped'>,
      onSkipped?: (message: string) => void,
    ): string[] =>
      names.filter((name) => {
        if (states[name] === 'stopped') {
          // Route the name through the SAME sanitizer mock the module
          // under test uses (R14): the real helper embeds
          // sanitizeLogText(name, 128), so a hand-copied message here
          // would keep asserting the old format if the production
          // sanitization (or its arguments) ever changed.
          onSkipped?.(
            `[Channel] "${mockSanitizeLogText(name, 128)}" skipped (stopped before restart)`,
          );
          return false;
        }
        return true;
      }),
);
const mockChannelRuntimeStatePath = vi.hoisted(() =>
  // Argument-sensitive on purpose: with a constant mock, a split
  // derivation (one call for the assertion, another for the store) would
  // coincide by accident and ship green — the two real derivations are
  // DIFFERENT files (`channels/channel-state.json` vs
  // `channels/standalone/<hash>/channel-state.json`) (#8975). The return
  // is derived FROM the argument (not collapsed to one constant for every
  // defined argument): the real helper hashes the workspace, so two
  // DIFFERENT defined arguments are two different files — a
  // defined-vs-defined split (store derived from another directory than
  // stop.ts addresses) must fail the constructor-path pin (R9-15).
  vi.fn((cwd?: string) =>
    cwd === undefined
      ? '/tmp/qwen-home/channels/channel-state.json'
      : `/tmp/qwen-home/channels/standalone/${cwd}/channel-state.json`,
  ),
);
const mockAdoptLegacyChannelState = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStdoutLineBestEffort = vi.hoisted(() => vi.fn());
const mockWriteStderrLineBestEffort = vi.hoisted(() => vi.fn());
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

vi.mock('./channel-state-store.js', () => ({
  adoptLegacyChannelState: mockAdoptLegacyChannelState,
  ChannelStateStore: mockChannelStateStore,
  channelRuntimeStatePath: mockChannelRuntimeStatePath,
  selectActiveChannels: mockSelectActiveChannels,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: mockWriteStdoutLine,
  // OWN mock, de-aliased from the loud sink (R12-3): with a shared mock,
  // swapping a best-effort diagnostic (the prune-fallback warning, the
  // skip notices, the active-record loss warning) back to the loud
  // `writeStdoutLine` ships every pin green, while in production a
  // failing stdout target raises the async stdout 'error' event and kills
  // the start mid-flight. The EPIPE-crash resilience of the real helper
  // itself is pinned in stdioHelpers.test (R11-13).
  writeStdoutLineBestEffort: mockWriteStdoutLineBestEffort,
  // R14-28: the unmocked runtime.ts loaded into this test's graph (via
  // start.ts — no vi.mock('./runtime.js') here) calls
  // writeStderrLineBestEffort in loadChannelsConfig's reserved-name
  // branch. Without the export a reserved-channel-key regression test
  // rejects with `No "writeStderrLineBestEffort" export is defined on
  // the mock` instead of exercising skip-and-warn.
  writeStderrLineBestEffort: mockWriteStderrLineBestEffort,
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

import {
  BRIDGE_SESSION_RESTORE_TIMEOUT_MS,
  resolveExtensionChannelEntrySpecifier,
  resolveProxy,
  startCommand,
} from './start.js';
import { resetReservedNameWarningsForTesting } from './runtime.js';

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
  setBridge: mockChannelSetBridge,
};

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset (not just clearAllMocks/mockClear): clearAllMocks does NOT
  // drain queued mockImplementationOnce/mockReturnValueOnce entries, so an
  // unconsumed once-entry — exactly what a regression in a pinned path
  // leaves behind — leaks into the NEXT test's first call, mislocalizing
  // the failure or silently flipping results (R15-30). These eight mocks
  // receive the PR's once-entries; reset drains the queue. Their defaults
  // are re-applied below (mockRouterRestoreSessions, mockChannelConnect,
  // the three store mocks) or they are plain recorders (the rest).
  mockWriteServiceInfo.mockReset();
  mockChannelDisconnect.mockReset();
  mockBridgeStop.mockReset();
  mockRouterRestoreSessions.mockReset();
  mockChannelLoopSchedulerStart.mockReset();
  // The store prune/set and connect mocks ALSO queue throwing
  // once-entries (the prune-failure, set-failure and connect-failure
  // tests); clearAllMocks leaves those queued (only mockReset drains
  // onceImplementations — verified against @vitest/spy). The sibling
  // channel-management-service.test.ts drains fully (R15-18); match it.
  mockChannelStateStorePrune.mockReset();
  mockChannelConnect.mockReset();
  mockBridgeStart.mockResolvedValue(undefined);
  mockChannelConnect.mockRejectedValue(new Error('stop after channel setup'));
  mockChannelStateStoreReadAll.mockReturnValue({});
  // mockReset wiped prune's default implementation — re-apply it (mockReset
  // empties the queue AND the implementation, R15-30).
  mockChannelStateStorePrune.mockImplementation(() =>
    mockChannelStateStoreReadAll(),
  );
  mockChannelStateStoreSet.mockReset();
  mockChannelStateStoreSet.mockImplementation(() => undefined);
  mockChannelStateStoreSetMany.mockImplementation(() => undefined);
  mockCreateChannel.mockReturnValue(mockChannel);
  mockFindCliEntryPath.mockReturnValue('/tmp/qwen-cli-entry.js');
  mockGetExtensionManager.mockResolvedValue({ getLoadedExtensions: () => [] });
  mockGetPlugin.mockResolvedValue({ createChannel: mockCreateChannel });
  mockLoadSettings.mockReturnValue({ merged: { channels: {} } });
  mockNormalizeProxyUrl.mockImplementation((url?: string) => url);
  mockNextFireTime.mockImplementation((cron: string) => {
    if (cron === '0 0 31 2 *') {
      throw new Error('No next fire time');
    }
    return new Date('2026-01-01T00:00:00.000Z');
  });
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

describe('resolveProxy', () => {
  it('prefers the CLI proxy over settings and environment proxies', async () => {
    process.env['HTTPS_PROXY'] = 'http://env.example.com:8080';

    const proxy = await resolveProxy(
      'http://cli.example.com:8080',
      'http://settings.example.com:8080',
    );

    expect(proxy).toBe('http://cli.example.com:8080');
    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://cli.example.com:8080',
      httpsProxy: 'http://cli.example.com:8080',
    });
    expect(mockSetGlobalDispatcher).toHaveBeenCalledWith({
      proxyUrl: 'http://cli.example.com:8080',
    });
  });

  it('prefers settings.proxy over environment proxies', async () => {
    process.env['HTTPS_PROXY'] = 'http://env.example.com:8080';

    const proxy = await resolveProxy(
      undefined,
      'http://settings.example.com:8080',
    );

    expect(proxy).toBe('http://settings.example.com:8080');
    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://settings.example.com:8080',
      httpsProxy: 'http://settings.example.com:8080',
    });
  });

  it('falls back to proxy environment variables', async () => {
    process.env['HTTP_PROXY'] = 'http://env.example.com:8080';

    const proxy = await resolveProxy();

    expect(proxy).toBe('http://env.example.com:8080');
    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://env.example.com:8080',
      httpsProxy: 'http://env.example.com:8080',
    });
  });
});

describe('resolveExtensionChannelEntrySpecifier', () => {
  it('returns a file URL for extension channel entry paths', () => {
    const extensionPath = join('/tmp', 'qwen extension');
    const entry = join('dist', 'channel.js');

    expect(resolveExtensionChannelEntrySpecifier(extensionPath, entry)).toBe(
      pathToFileURL(join(extensionPath, entry)).href,
    );
  });
});

describe('startCommand.handler', () => {
  it('refuses to start when channels are managed by qwen serve', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      workerPid: 5678,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('managed by qwen serve'),
    );
    expect(mockBridgeStart).not.toHaveBeenCalled();
    // Serve-owned twin of the standalone abort pins (R14-12): the
    // serve-owned pidfile belongs to the live serve process and the
    // daemon owns the state files — the refused start must touch
    // neither.
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteServiceInfo).not.toHaveBeenCalled();
    expect(mockAdoptLegacyChannelState).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // prune is the one state-mutating store call the set/setMany
    // negatives cannot cover — a refused start must not prune the LIVE
    // service's state file either (R16-28).
    expect(mockChannelStateStorePrune).not.toHaveBeenCalled();
  });

  it('refuses to start when a standalone service is already running (#8975)', async () => {
    // The standalone branch of checkDuplicateInstance, twin of the
    // serve-owned test above: its guidance is the only place users learn
    // the #8975 stop-then-skip semantics on this error path, so the
    // rewritten lines must be pinned — a mangled or dropped guidance
    // ships green otherwise (R12-16).
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Channel service is already running'),
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'A standalone service hosts the channels it was started with; exit it (Ctrl+C, or "qwen channel stop") before starting a different channel set.',
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Note: "qwen channel stop" records the running channels as stopped, so a later "qwen channel start" skips them until each is started again by name.',
    );
    // The duplicate-instance abort must precede full setup: no bridge
    // child may be spawned on this path (R12-16).
    expect(mockBridgeStart).not.toHaveBeenCalled();
    // …and it must leave the RUNNING service's pidfile and the state
    // store untouched (R14-12): a "cleanup" removeServiceInfo() in the
    // abort branch would unlink a live service's pidfile on every
    // refused start — stop then reports "No channel service is running."
    // while the service lives, and the next start passes both the
    // duplicate check and the 'wx' guard (two services on the same
    // channels, duplicate delivery). Adoption / an active-record write
    // moved ahead of the check would overwrite the user's explicit
    // stopped record (resurrection).
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteServiceInfo).not.toHaveBeenCalled();
    expect(mockAdoptLegacyChannelState).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // prune negative, twin of the serve-owned refusal test (R16-28).
    expect(mockChannelStateStorePrune).not.toHaveBeenCalled();
  });

  it('refuses an UNNAMED start when a standalone service is already running (R16-28)', async () => {
    // The two refusal tests above both invoke the NAMED path
    // (startSingle, which never prunes). startAll is the only startup
    // path calling state-mutating prune, and a refactor hoisting its
    // state setup (adoption + store construction + prune) ahead of or
    // around checkDuplicateInstance() would prune the LIVE service's
    // workspace state file on a refused start — dropping `stopped`
    // records of removed-but-stopped channels (resurrection) and bumping
    // the adoption watermark — with every named-path pin green. Pin the
    // duplicate-check-first ordering for the unnamed path too.
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Channel service is already running'),
    );
    expect(mockBridgeStart).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteServiceInfo).not.toHaveBeenCalled();
    expect(mockAdoptLegacyChannelState).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(mockChannelStateStorePrune).not.toHaveBeenCalled();
  });

  it('skips a reserved channel key with a best-effort warning and keeps the rest (R14-28)', async () => {
    // The natural regression test for this PR's own skip-and-warn
    // behavior was unrunnable in this suite: the stdioHelpers mock
    // factory omitted writeStderrLineBestEffort, so this shape rejected
    // with `[vitest] No "writeStderrLineBestEffort" export is defined on
    // the mock` instead of exercising loadChannelsConfig's reserved-name
    // branch (the unmocked runtime.ts reaches it via start.ts). The
    // factory now carries the export; pin the behavior end-to-end.
    resetReservedNameWarningsForTesting();
    mockLoadSettings.mockReturnValue({
      merged: {
        channels: {
          all: { type: 'telegram' },
          telegram: { type: 'telegram' },
        },
      },
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    let keepAlive: NodeJS.Timeout | undefined;

    try {
      void invokeStartHandler({});
      await new Promise((resolve) => setImmediate(resolve));

      keepAlive = setIntervalSpy.mock.results.at(-1)?.value as
        | NodeJS.Timeout
        | undefined;

      // The reserved entry is skipped with a best-effort warning…
      expect(mockWriteStderrLineBestEffort).toHaveBeenCalledWith(
        expect.stringContaining(
          'the name is reserved for the whole-channel selection',
        ),
      );
      // …and dropped before channel creation: only the configured
      // sibling is created.
      expect(mockCreateChannel).toHaveBeenCalledTimes(1);
      // Pin the CREATED name (R15-52): a count-only assertion lets an
      // inverted reserved-name filter (keeping only reserved keys) pass —
      // it would still warn once and call createChannel exactly once, but
      // for the reserved `'all'` entry, connecting the placeholder the
      // filter exists to prevent.
      expect(mockCreateChannel).toHaveBeenCalledWith(
        'telegram',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      if (keepAlive) clearInterval(keepAlive);
      exitSpy.mockRestore();
      processOnSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });

  it('rejects named sessions in standalone single-channel mode', async () => {
    mockLoadSettings.mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    });
    mockParseChannelConfig.mockResolvedValue({
      ...mockParsedChannelConfig,
      multiSession: true,
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('only for daemon-managed Channels'),
    );
    expect(mockAcpBridge).not.toHaveBeenCalled();
  });

  it('rejects named sessions in standalone all-channel mode', async () => {
    mockLoadSettings.mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    });
    mockParseChannelConfig.mockResolvedValue({
      ...mockParsedChannelConfig,
      multiSession: true,
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('only for daemon-managed Channels'),
    );
    expect(mockAcpBridge).not.toHaveBeenCalled();
  });

  it('loads settings.merged.proxy when no CLI proxy is provided', async () => {
    const settingsProxy = 'http://settings.example.com:8080';
    const envProxy = 'http://env.example.com:8080';
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({
      merged: { channels, proxy: settingsProxy },
    });
    process.env['HTTPS_PROXY'] = envProxy;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockLoadSettings).toHaveBeenCalledWith(process.cwd());
    expect(mockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: settingsProxy,
      httpsProxy: settingsProxy,
    });
    expect(mockEnvHttpProxyAgent).not.toHaveBeenCalledWith({
      httpProxy: envProxy,
      httpsProxy: envProxy,
    });
    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      mockParsedChannelConfig,
      expect.any(Object),
      expect.objectContaining({
        proxy: settingsProxy,
        loopController: expect.objectContaining({
          create: expect.any(Function),
          createForTarget: expect.any(Function),
          listForTarget: expect.any(Function),
          disable: expect.any(Function),
          validateCron: expect.any(Function),
          nextFireTime: expect.any(Function),
        }),
      }),
    );

    const options = mockCreateChannel.mock.calls[0]?.[3] as
      | ChannelBaseOptions
      | undefined;
    const input = {
      channelName: 'telegram',
      target: {
        channelName: 'telegram',
        senderId: 'alice',
        chatId: 'chat-1',
        isGroup: false,
      },
      cwd: '/tmp/qwen-channel-test',
      cron: '0 9 * * *',
      prompt: 'post summary',
      recurring: true,
      createdBy: 'Alice',
    };
    expect(options?.loopController?.createForTarget).toBeDefined();
    await options!.loopController!.createForTarget!(input, 3);
    expect(mockChannelLoopStoreCreateForTarget).toHaveBeenCalledWith(input, 3);
  });

  it('uses available env-var resolution for single-channel config', async () => {
    const channels = { telegram: { type: 'telegram', token: '$BOT_TOKEN' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockParseChannelConfig).toHaveBeenCalledWith(
      'telegram',
      channels.telegram,
      process.cwd(),
      { resolveEnvVars: 'available' },
    );
  });

  it('rejects cron expressions that cannot fire', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const options = mockCreateChannel.mock.calls[0]?.[3] as
      | ChannelBaseOptions
      | undefined;
    expect(() => options?.loopController?.validateCron('0 0 31 2 *')).toThrow();
  });

  it('does not expose channel loops when cron is disabled', async () => {
    const channels = { telegram: { type: 'telegram' } };
    process.env['QWEN_CODE_DISABLE_CRON'] = '1';
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
      delete process.env['QWEN_CODE_DISABLE_CRON'];
    }

    const options = mockCreateChannel.mock.calls[0]?.[3] as
      | ChannelBaseOptions
      | undefined;
    expect(options?.loopController).toBeUndefined();
    expect(mockChannelLoopStore).not.toHaveBeenCalled();
    expect(mockChannelLoopScheduler).not.toHaveBeenCalled();
  });

  it('does not expose channel loops when starting all channels with cron disabled', async () => {
    const channels = {
      telegram: { type: 'telegram' },
      feishu: { type: 'feishu' },
    };
    process.env['QWEN_CODE_DISABLE_CRON'] = '1';
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
    } finally {
      exitSpy.mockRestore();
      delete process.env['QWEN_CODE_DISABLE_CRON'];
    }

    expect(mockCreateChannel).toHaveBeenCalledTimes(2);
    for (const call of mockCreateChannel.mock.calls) {
      const options = call[3] as ChannelBaseOptions;
      expect(options.loopController).toBeUndefined();
    }
    expect(mockChannelLoopStore).not.toHaveBeenCalled();
    expect(mockChannelLoopScheduler).not.toHaveBeenCalled();
  });

  it('does not expose channel loops when cron is disabled in settings', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({
      merged: { channels, experimental: { cron: false } },
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const options = mockCreateChannel.mock.calls[0]?.[3] as
      | ChannelBaseOptions
      | undefined;
    expect(options?.loopController).toBeUndefined();
    expect(mockChannelLoopStore).not.toHaveBeenCalled();
    expect(mockChannelLoopScheduler).not.toHaveBeenCalled();
  });

  it('cleans up a single channel when pidfile creation races', async () => {
    const channels = { telegram: { type: 'telegram' } };
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockChannelConnect.mockResolvedValue(undefined);
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockWriteServiceInfo).toHaveBeenCalledWith(
      ['telegram'],
      process.cwd(),
    );
    expect(mockChannelDisconnect).toHaveBeenCalled();
    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockRouterClearAll).toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('started concurrently'),
    );
  });

  it('continues pidfile race cleanup when teardown steps throw', async () => {
    const channels = { telegram: { type: 'telegram' } };
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockChannelConnect.mockResolvedValue(undefined);
    mockChannelDisconnect.mockImplementationOnce(() => {
      throw new Error('disconnect boom');
    });
    mockBridgeStop.mockImplementationOnce(() => {
      throw new Error('stop boom');
    });
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockChannelDisconnect).toHaveBeenCalled();
    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockRouterClearAll).toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('started concurrently'),
    );
  });

  it('cleans up all connected channels when pidfile creation races', async () => {
    const channels = {
      telegram: { type: 'telegram' },
      feishu: { type: 'feishu' },
    };
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockChannelConnect.mockResolvedValue(undefined);
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockWriteServiceInfo).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      process.cwd(),
    );
    expect(mockChannelDisconnect).toHaveBeenCalledTimes(2);
    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockRouterClearAll).toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('started concurrently'),
    );
  });

  it('starts a standalone AcpBridge before creating the channel', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const bridge = mockAcpBridge.mock.results[0]!.value;
    const router = mockSessionRouter.mock.results[0]!.value;
    expect(mockAcpBridge).toHaveBeenCalledWith({
      cliEntryPath: '/tmp/qwen-cli-entry.js',
      cwd: mockParsedChannelConfig.cwd,
      model: mockParsedChannelConfig.model,
    });
    expect(mockBridgeStart.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateChannel.mock.invocationCallOrder[0]!,
    );
    expect(mockSessionRouter).toHaveBeenCalledWith(
      bridge,
      mockParsedChannelConfig.cwd,
      mockParsedChannelConfig.sessionScope,
      expect.any(String),
    );
    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      mockParsedChannelConfig,
      bridge,
      expect.objectContaining({ router }),
    );
  });

  it('removes router sessions when the bridge reports session death', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const sessionDiedListener = mockBridgeOn.mock.calls.find(
      ([eventName]) => eventName === 'sessionDied',
    )?.[1] as
      | ((event: { sessionId: string; reason?: string }) => void)
      | undefined;
    expect(sessionDiedListener).toBeDefined();

    sessionDiedListener!({
      sessionId: 'dead\nsession',
      reason: 'boom\nreason',
    });

    expect(mockSanitizeLogText).toHaveBeenCalledWith('dead\nsession', 128);
    expect(mockSanitizeLogText).toHaveBeenCalledWith('boom\nreason', 512);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] Session dead\\nsession died (boom\\nreason), updating routing state',
    );
    expect(mockRouterHandleSessionDied).toHaveBeenCalledWith('dead\nsession');
    expect(mockChannelOnSessionDied).not.toHaveBeenCalled();
  });

  it('dispatches bridge tool calls to the routed channel', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const toolCallListener = mockBridgeOn.mock.calls.find(
      ([eventName]) => eventName === 'toolCall',
    )?.[1] as
      | ((event: {
          sessionId: string;
          toolCallId: string;
          kind: string;
          title: string;
          status: string;
        }) => void)
      | undefined;
    expect(toolCallListener).toBeDefined();

    const event = {
      sessionId: 's-1',
      toolCallId: 'tool-1',
      kind: 'function',
      title: 'Read file',
      status: 'running',
    };
    mockRouterGetTarget.mockReturnValue({
      channelName: 'telegram',
      senderId: 'alice',
      chatId: 'chat1',
    });

    toolCallListener!(event);

    expect(mockRouterGetTarget).toHaveBeenCalledWith('s-1');
    expect(mockChannelDispatchToolCall).toHaveBeenCalledWith(event);
    expect(mockChannelOnToolCall).not.toHaveBeenCalled();
  });

  it('dispatches session death to the owning channel when the route is known', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockRouterGetTarget.mockReturnValue({
      channelName: 'telegram',
      senderId: 'alice',
      chatId: 'chat1',
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const sessionDiedListener = mockBridgeOn.mock.calls.find(
      ([eventName]) => eventName === 'sessionDied',
    )?.[1] as ((event: { sessionId: string }) => void) | undefined;
    expect(sessionDiedListener).toBeDefined();

    sessionDiedListener!({ sessionId: 'dead-session' });

    expect(mockChannelOnSessionDied).toHaveBeenCalledWith('dead-session');
    expect(mockRouterHandleSessionDied).not.toHaveBeenCalled();
  });

  it('registers session cleanup on the replacement bridge before restoring sessions', async () => {
    mockChannelConnect.mockResolvedValue(undefined);
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      void invokeStartHandler({ name: 'telegram' });
      await new Promise((resolve) => setImmediate(resolve));

      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => Promise<void>) | undefined;
      expect(disconnectedListener).toBeDefined();

      vi.useFakeTimers();
      const restart = disconnectedListener!();
      await vi.advanceTimersByTimeAsync(3000);
      await restart;

      const restartedBridge = mockAcpBridge.mock.results[1]!.value;
      expect(mockRouterSetBridge).toHaveBeenCalledWith(restartedBridge);
      expect(mockChannelSetBridge).toHaveBeenCalledWith(restartedBridge);
      expect(mockChannelConnect).toHaveBeenCalledTimes(1);

      const sessionDiedCalls = mockBridgeOn.mock.calls.filter(
        ([eventName]) => eventName === 'sessionDied',
      );
      expect(sessionDiedCalls).toHaveLength(2);
      const restartedSessionDiedListener = sessionDiedCalls[1]![1] as (event: {
        sessionId: string;
      }) => void;
      expect(mockBridgeOn.mock.invocationCallOrder.at(-2)).toBeLessThan(
        mockRouterRestoreSessions.mock.invocationCallOrder[0]!,
      );
      expect(mockChannelConnect.mock.invocationCallOrder[0]).toBeLessThan(
        mockRouterRestoreSessions.mock.invocationCallOrder[0]!,
      );

      restartedSessionDiedListener({ sessionId: 'dead-after-restart' });

      expect(mockRouterHandleSessionDied).toHaveBeenCalledWith(
        'dead-after-restart',
      );
    } finally {
      processOnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('recovers a standalone bridge without reconnecting the channel adapter', async () => {
    mockChannelConnect.mockResolvedValue(undefined);
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      void invokeStartHandler({ name: 'telegram' });
      await new Promise((resolve) => setImmediate(resolve));

      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => Promise<void>) | undefined;
      expect(disconnectedListener).toBeDefined();

      vi.useFakeTimers();
      const restart = disconnectedListener!();
      await vi.advanceTimersByTimeAsync(3000);
      await restart;

      expect(mockChannelConnect).toHaveBeenCalledTimes(1);
      expect(mockChannelDisconnect).not.toHaveBeenCalled();
      expect(mockChannelLoopSchedulerMarkRecovery).toHaveBeenCalled();
      expect(mockChannelLoopSchedulerStop).not.toHaveBeenCalled();
    } finally {
      processOnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('coalesces duplicate standalone disconnect events into one recovery', async () => {
    mockChannelConnect.mockResolvedValue(undefined);
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      void invokeStartHandler({ name: 'telegram' });
      await new Promise((resolve) => setImmediate(resolve));

      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => Promise<void>) | undefined;
      expect(disconnectedListener).toBeDefined();

      vi.useFakeTimers();
      disconnectedListener!();
      disconnectedListener!();
      await vi.advanceTimersByTimeAsync(6000);
      disconnectedListener!();

      expect(mockAcpBridge).toHaveBeenCalledTimes(2);
      expect(mockRouterRestoreSessions).toHaveBeenCalledTimes(1);
    } finally {
      processOnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the readiness gate blocked and coalesces replacement disconnects', async () => {
    mockChannelConnect.mockResolvedValue(undefined);
    let resolveFirstRestore:
      | ((value: { failed: number; restored: number }) => void)
      | undefined;
    let resolveSecondRestore:
      | ((value: { failed: number; restored: number }) => void)
      | undefined;
    mockRouterRestoreSessions
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRestore = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondRestore = resolve;
          }),
      );
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      void invokeStartHandler({ name: 'telegram' });
      await new Promise((resolve) => setImmediate(resolve));
      const options = mockCreateChannel.mock.calls[0]?.[3] as
        | ChannelBaseOptions
        | undefined;
      const firstDisconnect = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => void) | undefined;
      expect(firstDisconnect).toBeDefined();

      vi.useFakeTimers();
      firstDisconnect!();
      const recoveryGate = options?.bridgeRecovery?.();
      let gateReleased = false;
      void recoveryGate?.then(() => {
        gateReleased = true;
      });
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() =>
        expect(mockRouterRestoreSessions).toHaveBeenCalledTimes(1),
      );

      const disconnectListeners = mockBridgeOn.mock.calls.filter(
        ([eventName]) => eventName === 'disconnected',
      );
      expect(disconnectListeners).toHaveLength(2);
      const replacementDisconnect = disconnectListeners[1]![1] as () => void;
      replacementDisconnect();
      replacementDisconnect();

      resolveFirstRestore!({ failed: 0, restored: 0 });
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() =>
        expect(mockRouterRestoreSessions).toHaveBeenCalledTimes(2),
      );

      expect(gateReleased).toBe(false);
      expect(mockAcpBridge).toHaveBeenCalledTimes(3);

      resolveSecondRestore!({ failed: 0, restored: 0 });
      await vi.waitFor(() => expect(gateReleased).toBe(true));

      expect(mockRouterRestoreSessions).toHaveBeenCalledTimes(2);
    } finally {
      processOnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cleans up standalone service state when replacement startup fails', async () => {
    mockChannelConnect.mockResolvedValue(undefined);
    mockBridgeStart
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('replacement failed'));
    mockChannelDisconnect.mockImplementationOnce(() => {
      throw new Error('disconnect failed');
    });
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    try {
      void invokeStartHandler({ name: 'telegram' });
      await new Promise((resolve) => setImmediate(resolve));
      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => void) | undefined;

      vi.useFakeTimers();
      disconnectedListener!();
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => expect(mockRemoveServiceInfo).toHaveBeenCalled());

      expect(mockRouterClearAll).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops the replacement bridge when session restore fails', async () => {
    mockChannelConnect.mockResolvedValue(undefined);
    mockRouterRestoreSessions.mockRejectedValueOnce(
      new Error('restore failed'),
    );
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    try {
      void invokeStartHandler({ name: 'telegram' });
      await new Promise((resolve) => setImmediate(resolve));
      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => void) | undefined;

      vi.useFakeTimers();
      disconnectedListener!();
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => expect(mockRemoveServiceInfo).toHaveBeenCalled());

      expect(mockBridgeStart).toHaveBeenCalledTimes(2);
      expect(mockBridgeStop).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('times out a wedged session restore and stops the replacement bridge', async () => {
    mockChannelConnect.mockResolvedValue(undefined);
    mockRouterRestoreSessions.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    try {
      void invokeStartHandler({ name: 'telegram' });
      await new Promise((resolve) => setImmediate(resolve));
      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => void) | undefined;

      vi.useFakeTimers();
      disconnectedListener!();
      await vi.advanceTimersByTimeAsync(
        3000 + BRIDGE_SESSION_RESTORE_TIMEOUT_MS,
      );
      await vi.waitFor(() => expect(mockRemoveServiceInfo).toHaveBeenCalled());

      expect(mockBridgeStop).toHaveBeenCalledOnce();
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('Session restore timed out'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('starts all channels with one shared bridge and router', async () => {
    const channels = {
      first: { type: 'telegram' },
      second: { type: 'telegram' },
    };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockParseChannelConfig.mockImplementation(async (name: string) => ({
      ...mockParsedChannelConfig,
      cwd: `/tmp/${name}`,
      model: 'shared-model',
      sessionScope: name === 'first' ? 'thread' : 'single',
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
    } finally {
      exitSpy.mockRestore();
    }

    const bridge = mockAcpBridge.mock.results[0]!.value;
    const router = mockSessionRouter.mock.results[0]!.value;
    expect(mockAcpBridge).toHaveBeenCalledTimes(1);
    expect(mockAcpBridge).toHaveBeenCalledWith({
      cliEntryPath: '/tmp/qwen-cli-entry.js',
      cwd: process.cwd(),
      model: 'shared-model',
    });
    expect(mockSessionRouter).toHaveBeenCalledWith(
      bridge,
      process.cwd(),
      'user',
      expect.any(String),
    );
    expect(mockRouterSetChannelScope).toHaveBeenCalledWith('first', 'thread');
    expect(mockRouterSetChannelScope).toHaveBeenCalledWith('second', 'single');
    expect(mockCreateChannel).toHaveBeenNthCalledWith(
      1,
      'first',
      expect.objectContaining({ cwd: '/tmp/first' }),
      bridge,
      expect.objectContaining({ router }),
    );
    expect(mockCreateChannel).toHaveBeenNthCalledWith(
      2,
      'second',
      expect.objectContaining({ cwd: '/tmp/second' }),
      bridge,
      expect.objectContaining({ router }),
    );
  });

  it('passes channel memory callbacks when starting a named channel', async () => {
    mockLoadSettings.mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      mockParsedChannelConfig,
      expect.any(Object),
      expect.objectContaining({
        channelMemory: {
          readChannelMemory: mockReadChannelMemory,
          getChannelMemoryRevision: mockGetChannelMemoryRevision,
          listChannelMemoryEntries: mockListChannelMemoryEntries,
          addChannelMemoryEntries: mockAddChannelMemoryEntries,
          updateChannelMemoryEntry: mockUpdateChannelMemoryEntry,
          removeChannelMemoryEntries: mockRemoveChannelMemoryEntries,
          clearChannelMemory: mockClearChannelMemory,
        },
        memoryIntentClassifier: expect.objectContaining({
          classifyChannelMemoryIntent: expect.any(Function),
        }),
        channelMemoryRecallObserver: mockRecordChannelMemoryRecallMetrics,
      }),
    );
  });

  it('passes channel memory callbacks when starting all channels', async () => {
    mockLoadSettings.mockReturnValue({
      merged: {
        channels: {
          discord: { type: 'telegram' },
          telegram: { type: 'telegram' },
        },
      },
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockCreateChannel).toHaveBeenCalledTimes(2);
    expect(mockCreateChannel).toHaveBeenNthCalledWith(
      1,
      'discord',
      mockParsedChannelConfig,
      expect.any(Object),
      expect.objectContaining({
        channelMemory: {
          readChannelMemory: mockReadChannelMemory,
          getChannelMemoryRevision: mockGetChannelMemoryRevision,
          listChannelMemoryEntries: mockListChannelMemoryEntries,
          addChannelMemoryEntries: mockAddChannelMemoryEntries,
          updateChannelMemoryEntry: mockUpdateChannelMemoryEntry,
          removeChannelMemoryEntries: mockRemoveChannelMemoryEntries,
          clearChannelMemory: mockClearChannelMemory,
        },
        memoryIntentClassifier: expect.objectContaining({
          classifyChannelMemoryIntent: expect.any(Function),
        }),
        channelMemoryRecallObserver: mockRecordChannelMemoryRecallMetrics,
      }),
    );
    expect(mockCreateChannel).toHaveBeenNthCalledWith(
      2,
      'telegram',
      mockParsedChannelConfig,
      expect.any(Object),
      expect.objectContaining({
        channelMemory: {
          readChannelMemory: mockReadChannelMemory,
          getChannelMemoryRevision: mockGetChannelMemoryRevision,
          listChannelMemoryEntries: mockListChannelMemoryEntries,
          addChannelMemoryEntries: mockAddChannelMemoryEntries,
          updateChannelMemoryEntry: mockUpdateChannelMemoryEntry,
          removeChannelMemoryEntries: mockRemoveChannelMemoryEntries,
          clearChannelMemory: mockClearChannelMemory,
        },
      }),
    );
  });

  it('starts the scheduler with connected channels only', async () => {
    const channels = {
      first: { type: 'telegram' },
      second: { type: 'telegram' },
    };
    const firstChannel = {
      ...mockChannel,
      connect: vi.fn().mockRejectedValue(new Error('first down')),
    };
    const secondChannel = {
      ...mockChannel,
      connect: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateChannel.mockImplementation((name: string) =>
      name === 'first' ? firstChannel : secondChannel,
    );
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockParseChannelConfig.mockImplementation(async (name: string) => ({
      ...mockParsedChannelConfig,
      cwd: `/tmp/${name}`,
      model: 'shared-model',
    }));
    mockChannelLoopSchedulerStart.mockImplementationOnce(() => {
      throw new Error('stop after scheduler setup');
    });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      await expect(invokeStartHandler({})).rejects.toThrow(
        'stop after scheduler setup',
      );
    } finally {
      processOnSpy.mockRestore();
    }

    const schedulerOptions = mockChannelLoopScheduler.mock.calls[0]?.[0] as
      | { channels: Map<string, unknown> }
      | undefined;
    expect([...schedulerOptions!.channels.keys()]).toEqual(['second']);
    expect(mockChannelLoopSchedulerStart).toHaveBeenCalledOnce();
  });
  it('restarts all channels on shared bridge crash before restoring sessions', async () => {
    const channels = {
      first: { type: 'telegram' },
      second: { type: 'telegram' },
    };
    const firstChannel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      onSessionDied: vi.fn(),
      onToolCall: vi.fn(),
      setBridge: vi.fn(),
    };
    const secondChannel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      onSessionDied: vi.fn(),
      onToolCall: vi.fn(),
      setBridge: vi.fn(),
    };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockParseChannelConfig.mockImplementation(async (name: string) => ({
      ...mockParsedChannelConfig,
      cwd: `/tmp/${name}`,
      model: 'shared-model',
      sessionScope: 'user',
    }));
    mockCreateChannel
      .mockReturnValueOnce(firstChannel)
      .mockReturnValueOnce(secondChannel);
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      void invokeStartHandler({});
      await new Promise((resolve) => setImmediate(resolve));

      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => Promise<void>) | undefined;
      expect(disconnectedListener).toBeDefined();

      vi.useFakeTimers();
      const restart = disconnectedListener!();
      await vi.advanceTimersByTimeAsync(3000);
      await restart;

      const restartedBridge = mockAcpBridge.mock.results[1]!.value;
      expect(mockRouterSetBridge).toHaveBeenCalledWith(restartedBridge);
      expect(firstChannel.setBridge).toHaveBeenCalledWith(restartedBridge);
      expect(secondChannel.setBridge).toHaveBeenCalledWith(restartedBridge);
      expect(
        mockBridgeOn.mock.calls.filter(
          ([eventName]) => eventName === 'toolCall',
        ),
      ).toHaveLength(2);
      expect(
        mockBridgeOn.mock.calls.filter(
          ([eventName]) => eventName === 'sessionDied',
        ),
      ).toHaveLength(2);
      expect(mockRouterRestoreSessions).toHaveBeenCalledTimes(1);
    } finally {
      processOnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
  it('recovers a shared bridge without reconnecting channel adapters', async () => {
    const channels = {
      first: { type: 'telegram' },
      second: { type: 'telegram' },
    };
    const firstChannel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      onSessionDied: vi.fn(),
      onToolCall: vi.fn(),
      setBridge: vi.fn(),
    };
    const secondChannel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      onSessionDied: vi.fn(),
      onToolCall: vi.fn(),
      setBridge: vi.fn(),
    };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockParseChannelConfig.mockImplementation(async (name: string) => ({
      ...mockParsedChannelConfig,
      cwd: `/tmp/${name}`,
      model: 'shared-model',
      sessionScope: 'user',
    }));
    mockCreateChannel
      .mockReturnValueOnce(firstChannel)
      .mockReturnValueOnce(secondChannel);
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      void invokeStartHandler({});
      await new Promise((resolve) => setImmediate(resolve));

      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => Promise<void>) | undefined;
      expect(disconnectedListener).toBeDefined();

      vi.useFakeTimers();
      const restart = disconnectedListener!();
      await vi.advanceTimersByTimeAsync(3000);
      await restart;

      expect(firstChannel.connect).toHaveBeenCalledTimes(1);
      expect(secondChannel.connect).toHaveBeenCalledTimes(1);
      expect(firstChannel.disconnect).not.toHaveBeenCalled();
      expect(secondChannel.disconnect).not.toHaveBeenCalled();
      expect(mockChannelLoopSchedulerStop).not.toHaveBeenCalled();
    } finally {
      processOnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  describe('empty effective channel set (#8975)', () => {
    it('keeps serving instead of exiting when no channels are configured', async () => {
      mockLoadSettings.mockReturnValue({ merged: { channels: {} } });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });
      const processOnSpy = vi
        .spyOn(process, 'on')
        .mockImplementation(() => process);
      // Spy the timer like the twins so the keep-alive handle is
      // capturable: an assertion failure before the signal call must not
      // leak a ref'd 24.8-day interval into the vitest worker (R10-30).
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      let keepAlive: NodeJS.Timeout | undefined;

      try {
        void invokeStartHandler({});
        await new Promise((resolve) => setImmediate(resolve));

        // Capture the keep-alive handle BEFORE any fallible assertion: if
        // one throws, the finally block must still clear the ref'd
        // ~24.8-day interval or it leaks past this test (#8975).
        keepAlive = setIntervalSpy.mock.results.at(-1)?.value as
          | NodeJS.Timeout
          | undefined;

        expect(mockWriteStdoutLine).toHaveBeenCalledWith(
          '[Channel] No channels configured; serving with 0 channels.',
        );
        expect(mockWriteServiceInfo).toHaveBeenCalledWith([], process.cwd());
        // Write-COUNT pin (R14-29): membership alone cannot stop an
        // additional writeServiceInfo(configuredNames) on the
        // empty-effective-set path landing AFTER the `[]` write — the
        // final pidfile would then list explicitly-stopped channels as
        // running (the hazard this test's own comment names).
        expect(mockWriteServiceInfo).toHaveBeenCalledTimes(1);
        expect(mockAcpBridge).not.toHaveBeenCalled();
        expect(mockCreateChannel).not.toHaveBeenCalled();
        // The empty-effective-set path must not write state either (twin
        // of the all-stopped pin, #8975).
        expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
        expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
        // Startup no longer exits on an empty channel set.
        expect(exitSpy).not.toHaveBeenCalled();
        expect(keepAlive).toBeDefined();

        const sigint = processOnSpy.mock.calls.find(
          ([eventName]) => eventName === 'SIGINT',
        )?.[1] as (() => void) | undefined;
        expect(sigint).toBeDefined();
        // The exit mock throws instead of terminating the process.
        expect(() => sigint!()).toThrow('process.exit: 0');
        expect(mockRemoveServiceInfo).toHaveBeenCalled();
      } finally {
        if (keepAlive) clearInterval(keepAlive);
        setIntervalSpy.mockRestore();
        processOnSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it('keeps serving when every configured channel is stopped', async () => {
      mockLoadSettings.mockReturnValue({
        merged: {
          channels: {
            telegram: { type: 'telegram' },
            feishu: { type: 'feishu' },
          },
        },
      });
      mockChannelStateStoreReadAll.mockReturnValue({
        telegram: 'stopped',
        feishu: 'stopped',
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });
      const processOnSpy = vi
        .spyOn(process, 'on')
        .mockImplementation(() => process);
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      // Hoisted above the try and captured BEFORE any fallible assertion:
      // an assertion failure must not leak the ref'd keep-alive timer
      // into the vitest worker — the finally clears it unconditionally
      // (R10-30).
      let keepAlive: NodeJS.Timeout | undefined;

      try {
        void invokeStartHandler({});
        await new Promise((resolve) => setImmediate(resolve));

        keepAlive = setIntervalSpy.mock.results.at(-1)?.value as
          | NodeJS.Timeout
          | undefined;

        // Sink pins (R12-3): the skip notices ride the best-effort sink —
        // a dead stdout reader must not kill the start (R11-13).
        expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
          '[Channel] "telegram" skipped (stopped before restart)',
        );
        expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
          '[Channel] "feishu" skipped (stopped before restart)',
        );
        // Pin the FULL message: the recovery-guidance suffix is the only
        // user-visible way back out of the zero-channel serving state
        // (otherwise indistinguishable from a hang), and a `--channel`
        // style pointer would be rejected by the standalone parser
        // (#8975).
        expect(mockWriteStdoutLine).toHaveBeenCalledWith(
          '[Channel] All configured channels are stopped; serving with 0 channels. Exit this process, then restart individual channels with "qwen channel start <name>".',
        );
        expect(mockCreateChannel).not.toHaveBeenCalled();
        // Sibling hazards of the zero-channel funnel, each twin-pinned on
        // the no-config entry: the pidfile must carry the EMPTY channel
        // set (threading the configured names here would make `qwen
        // channel status` report stopped channels as running), no bridge
        // child may be spawned on this path, and the keep-alive timer
        // must hold the event loop open (#8975).
        expect(mockWriteServiceInfo).toHaveBeenCalledWith([], process.cwd());
        // Write-COUNT pin, twin of the no-config test (R14-29).
        expect(mockWriteServiceInfo).toHaveBeenCalledTimes(1);
        expect(mockAcpBridge).not.toHaveBeenCalled();
        expect(keepAlive).toBeDefined();
        expect(keepAlive!.hasRef()).toBe(true);
        // The state file holds every channel as 'stopped' here: a state
        // write added or hoisted on the empty-effective-set path would
        // flip those records to active and resurrect exactly the channels
        // the user explicitly stopped — the #8975 regression class.
        expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
        expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
        // prune IS called — and pin it: pruning stale entries against the
        // configured set is a read-side cleanup, not a state flip, and a
        // refactor skipping prune exactly in this branch would strand stale
        // `stopped` entries for channels removed from settings (#8975).
        // Adopted legacy stops are exempt from that cleanup (#8975,
        // R12-47 fix); pin the option so a plain prune() call here fails.
        expect(mockChannelStateStorePrune).toHaveBeenCalledWith(
          ['telegram', 'feishu'],
          { preserveAdopted: true },
        );
        // Uniqueness pin, mirroring the daemon-worker suite (R12-15): an
        // additional wrong-path prune call alongside the right one ships
        // green against the membership pin alone.
        expect(mockChannelStateStorePrune).toHaveBeenCalledTimes(1);
        // Startup no longer exits when every channel is stopped.
        expect(exitSpy).not.toHaveBeenCalled();

        const sigterm = processOnSpy.mock.calls.find(
          ([eventName]) => eventName === 'SIGTERM',
        )?.[1] as (() => void) | undefined;
        expect(sigterm).toBeDefined();
        // The exit mock throws instead of terminating the process.
        expect(() => sigterm!()).toThrow('process.exit: 0');
        expect(mockRemoveServiceInfo).toHaveBeenCalled();
        // Shutdown releases the keep-alive handle it installed.
        expect(clearIntervalSpy).toHaveBeenCalledWith(keepAlive);
      } finally {
        if (keepAlive) clearInterval(keepAlive);
        clearIntervalSpy.mockRestore();
        setIntervalSpy.mockRestore();
        processOnSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it("holds a ref'd keep-alive timer so the zero-channel service survives (#8975)", async () => {
      mockLoadSettings.mockReturnValue({ merged: { channels: {} } });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });
      const processOnSpy = vi
        .spyOn(process, 'on')
        .mockImplementation(() => process);
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      // Hoisted above the try so the finally can clear it unconditionally
      // (R10-30).
      let keepAlive: NodeJS.Timeout | undefined;

      try {
        void invokeStartHandler({});
        await new Promise((resolve) => setImmediate(resolve));

        // Signal listeners plus a pending promise cannot keep the Node event
        // loop alive; a ref'd timer must hold it open or the zero-channel
        // service exits on its own and leaves a dangling pidfile.
        keepAlive = setIntervalSpy.mock.results.at(-1)?.value as
          | NodeJS.Timeout
          | undefined;
        expect(keepAlive).toBeDefined();
        expect(keepAlive!.hasRef()).toBe(true);
        // Pin the delay too: the load-bearing value is TIMEOUT_MAX
        // (2^31 - 1 ms ≈ 24.8 days). A cleanup refactor 'simplifying' the
        // odd-looking literal to a small delay ships green against the
        // hasRef/clearInterval pins alone, then ticks an empty callback
        // thousands of times a second in the long-lived zero-channel
        // steady state, burning a CPU core (R10-44).
        expect(setIntervalSpy).toHaveBeenCalledWith(
          expect.any(Function),
          2_147_483_647,
        );

        const sigterm = processOnSpy.mock.calls.find(
          ([eventName]) => eventName === 'SIGTERM',
        )?.[1] as (() => void) | undefined;
        expect(sigterm).toBeDefined();
        expect(() => sigterm!()).toThrow('process.exit: 0');
        // Shutdown releases the handle it installed.
        expect(clearIntervalSpy).toHaveBeenCalledWith(keepAlive);
      } finally {
        if (keepAlive) clearInterval(keepAlive);
        clearIntervalSpy.mockRestore();
        setIntervalSpy.mockRestore();
        processOnSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it('falls back to the recorded states when prune fails (#8975)', async () => {
      mockLoadSettings.mockReturnValue({
        merged: {
          channels: {
            telegram: { type: 'telegram' },
            feishu: { type: 'feishu' },
          },
        },
      });
      mockChannelStateStorePrune.mockImplementationOnce(() => {
        throw new Error('EACCES');
      });
      mockChannelStateStoreReadAll.mockReturnValue({ feishu: 'stopped' });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });

      try {
        // Default connect rejection ends startAll at the connectedCount check.
        await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
      } finally {
        exitSpy.mockRestore();
      }

      // The fallback read still drives the restore filter. Sink pin
      // (R12-3): the skip notice rides the best-effort sink.
      expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
        '[Channel] "feishu" skipped (stopped before restart)',
      );
      // A silent fallback would hide that persistence is broken: stale
      // entries survive and a re-added channel is skipped forever with
      // no diagnostic tracing the cause — the daemon-side twin asserts
      // this warning too (#8975). Sink pin (R12-3): the warning rides
      // the best-effort sink — it fires exactly when the disk is
      // failing.
      expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
        '[Channel] Warning: failed to update channel state; falling back to recorded states.',
      );
      expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
        '[Channel] Warning: failed to update channel state; falling back to recorded states.',
      );
      expect(mockCreateChannel).toHaveBeenCalledTimes(1);
      expect(mockCreateChannel).toHaveBeenCalledWith(
        'telegram',
        mockParsedChannelConfig,
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('treats all channels as active when prune fails and nothing is readable (R12-13)', async () => {
      // prune throws on ANY store failure — a transient READ failure as
      // well as a write failure — and the fallback readAll() can then
      // return an EMPTY map while channels are explicitly stopped. The
      // warning must say so: selecting from an empty map treats every
      // configured channel as active, including the stopped ones, and
      // claiming 'falling back to recorded states' there would be a lie
      // (#8975). Mirror of the daemon-worker twin.
      mockLoadSettings.mockReturnValue({
        merged: {
          channels: {
            telegram: { type: 'telegram' },
            feishu: { type: 'feishu' },
          },
        },
      });
      mockChannelStateStorePrune.mockImplementationOnce(() => {
        throw new Error('EBUSY');
      });
      mockChannelStateStoreReadAll.mockReturnValue({});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });

      try {
        // Default connect rejection ends startAll at the connectedCount check.
        await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
      } finally {
        exitSpy.mockRestore();
      }

      expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
        '[Channel] Warning: no recorded channel state readable; treating all channels as active.',
      );
      // Mirror-pin the ternary's other half: with an empty fallback the
      // recorded-states wording must NOT appear (#8975).
      expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
        '[Channel] Warning: failed to update channel state; falling back to recorded states.',
      );
      // Nothing is skipped: ALL configured channels are selected.
      expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
        expect.stringContaining('skipped (stopped before restart)'),
      );
      expect(mockCreateChannel).toHaveBeenCalledTimes(2);
      expect(mockCreateChannel).toHaveBeenCalledWith(
        'telegram',
        mockParsedChannelConfig,
        expect.any(Object),
        expect.any(Object),
      );
      expect(mockCreateChannel).toHaveBeenCalledWith(
        'feishu',
        mockParsedChannelConfig,
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('skips stopped channels but still starts the rest', async () => {
      mockLoadSettings.mockReturnValue({
        merged: {
          channels: {
            telegram: { type: 'telegram' },
            feishu: { type: 'feishu' },
          },
        },
      });
      mockChannelStateStoreReadAll.mockReturnValue({ feishu: 'stopped' });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });

      try {
        // Default connect rejection ends startAll at the connectedCount check.
        await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
      } finally {
        exitSpy.mockRestore();
      }

      // Sink pin (R12-3): the skip notice rides the best-effort sink.
      expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
        '[Channel] "feishu" skipped (stopped before restart)',
      );
      // One-sided warning pin: the prune-fallback warning is pinned on the
      // failure path above; a prune-success startup must NOT emit it —
      // emitting it on every normal startup drowns the genuine warning
      // the test above says must stay traceable (R9-14). Sink twin
      // (R12-3): the real warning sink is the best-effort one.
      expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
        '[Channel] Warning: failed to update channel state; falling back to recorded states.',
      );
      expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
        '[Channel] Warning: failed to update channel state; falling back to recorded states.',
      );
      // prune receives every configured name, including the skipped one: a
      // post-selection list would wipe the skipped channel's stopped record
      // and resurrect it on the next start (#8975). Adopted legacy stops
      // are exempt from that cleanup (#8975, R12-47 fix).
      expect(mockChannelStateStorePrune).toHaveBeenCalledWith(
        ['telegram', 'feishu'],
        { preserveAdopted: true },
      );
      // Uniqueness pin, mirroring the daemon-worker suite (R12-15).
      expect(mockChannelStateStorePrune).toHaveBeenCalledTimes(1);
      expect(mockCreateChannel).toHaveBeenCalledTimes(1);
      expect(mockCreateChannel).toHaveBeenCalledWith(
        'telegram',
        mockParsedChannelConfig,
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('writes only the connected channels to the pidfile after a partial connect (#8975)', async () => {
      mockLoadSettings.mockReturnValue({
        merged: {
          channels: {
            telegram: { type: 'telegram' },
            feishu: { type: 'feishu' },
          },
        },
      });
      mockChannelConnect
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('feishu connect failed'));
      const err = new Error('EEXIST') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      mockWriteServiceInfo.mockImplementationOnce(() => {
        throw err;
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });

      try {
        await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
      } finally {
        exitSpy.mockRestore();
      }

      // The pidfile lists the CONNECTED set: `qwen channel stop` persists
      // these names as explicitly stopped, so a channel whose connect()
      // failed (never ran) must not be recorded, or every later
      // `--channel all` start skips it (#8975).
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect "feishu"'),
      );
      // The restore filter reads the STATE file, not the pidfile: the
      // pidfile pins the connected set above; startAll itself performs no
      // state write for the connected names (the file already holds
      // active-or-nothing for every selected name — R9-19), and a write
      // recording the connect-failed channel would skip it on every later
      // `--channel all` start (#8975).
      expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
      expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
      expect(mockWriteServiceInfo).toHaveBeenCalledWith(
        ['telegram'],
        process.cwd(),
      );
    });

    it('keeps the partial-connect pidfile at the connected set for the whole lifecycle (R16-47)', async () => {
      // The EEXIST-abort twin above exits at the FIRST pidfile write, so
      // a second writeServiceInfo carrying the attempted/configured set
      // (a hoisted pre-connect write left in place, or a later
      // "refresh") never executes in-test — the membership assertion
      // matches the first call and the regression ships green. In
      // production the FINAL pidfile would then list `feishu` (whose
      // connect() failed, never ran) as running; `qwen channel stop`
      // persists the pidfile names as explicitly stopped, so `feishu`
      // acquires a `stopped` record and every later `--channel all`
      // skips it (#8975). Let the write succeed and exit through the
      // captured SIGTERM handler — the zero-channel twins' lifecycle
      // shape (R14-29) — so a later wrong-set rewrite is observable via
      // the write COUNT.
      mockLoadSettings.mockReturnValue({
        merged: {
          channels: {
            telegram: { type: 'telegram' },
            feishu: { type: 'feishu' },
          },
        },
      });
      mockChannelConnect
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('feishu connect failed'));
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });
      const processOnSpy = vi
        .spyOn(process, 'on')
        .mockImplementation(() => process);

      try {
        void invokeStartHandler({});
        await new Promise((resolve) => setImmediate(resolve));

        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          expect.stringContaining('Failed to connect "feishu"'),
        );
        // The pidfile lists the CONNECTED set...
        expect(mockWriteServiceInfo).toHaveBeenCalledWith(
          ['telegram'],
          process.cwd(),
        );
        // ...exactly ONCE: no later rewrite with the attempted/configured
        // set anywhere in the lifecycle (this is the only startAll path
        // where the connected set differs from the configured set).
        expect(mockWriteServiceInfo).toHaveBeenCalledTimes(1);
        expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
        expect(mockChannelStateStoreSet).not.toHaveBeenCalled();

        const sigterm = processOnSpy.mock.calls.find(
          ([eventName]) => eventName === 'SIGTERM',
        )?.[1] as (() => void) | undefined;
        expect(sigterm).toBeDefined();
        // The exit mock throws instead of terminating the process.
        expect(() => sigterm!()).toThrow('process.exit: 0');
        expect(mockRemoveServiceInfo).toHaveBeenCalled();
        // Shutdown cleans up the pidfile but does not rewrite it.
        expect(mockWriteServiceInfo).toHaveBeenCalledTimes(1);
      } finally {
        processOnSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it('stops the bridge when no channel connects (#8975)', async () => {
      // The connectedCount === 0 exit path calls bridge.stop() before
      // process.exit(1); deleting that call ships green without this pin
      // and orphans the started bridge's CLI child on every all-failed
      // startup (#8975).
      mockLoadSettings.mockReturnValue({
        merged: {
          channels: {
            telegram: { type: 'telegram' },
            feishu: { type: 'feishu' },
          },
        },
      });
      mockChannelConnect.mockRejectedValue(new Error('connect failed'));
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });

      try {
        await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
      } finally {
        exitSpy.mockRestore();
      }

      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect "telegram"'),
      );
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect "feishu"'),
      );
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        '[Channel] No channels connected. Exiting.',
      );
      expect(mockBridgeStop).toHaveBeenCalled();
      // Nothing connected: no state write at all (R9-19) and no pidfile
      // is written (#8975).
      expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
      expect(mockWriteServiceInfo).not.toHaveBeenCalled();
    });

    it('reads the workspace-scoped state file without rewriting it for the connected set (R9-19)', async () => {
      // Two channels on purpose: with a single channel, batched and
      // per-channel writes are observationally identical (#8975).
      mockLoadSettings.mockReturnValue({
        merged: {
          channels: {
            telegram: { type: 'telegram' },
            feishu: { type: 'feishu' },
          },
        },
      });
      mockChannelConnect.mockResolvedValue(undefined);
      const err = new Error('EEXIST') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      mockWriteServiceInfo.mockImplementationOnce(() => {
        throw err;
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });

      try {
        await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
      } finally {
        exitSpy.mockRestore();
      }

      // The connect loop must not write the state file: every connected
      // name was selected by selectActiveChannels, which excludes exactly
      // the `stopped` entries — the file already holds active-or-nothing
      // for each of them and no reader distinguishes those, so the old
      // batched `active` write (and its false skip-consequence warning)
      // was pure noise on the startup critical path (R9-19).
      expect(mockAdoptLegacyChannelState).toHaveBeenCalledWith(process.cwd());
      expect(mockAdoptLegacyChannelState).toHaveBeenCalledTimes(1);
      expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith(process.cwd());
      // ...and the store is constructed with the path the helper returns
      // for THAT argument — a split here reads/writes a different file
      // than stop.ts addresses. The path mock derives its return from the
      // argument, so this fails unless both derivations use the same
      // workspace form (R9-15).
      expect(mockChannelStateStore).toHaveBeenCalledWith(
        `/tmp/qwen-home/channels/standalone/${process.cwd()}/channel-state.json`,
      );
      // Uniqueness pins, mirroring the daemon-worker suite (R12-15): the
      // membership pins above are satisfied by an additional wrong-path
      // store construction or path derivation alongside the right one —
      // a read/write store split ships green against membership alone.
      expect(mockChannelRuntimeStatePath).toHaveBeenCalledTimes(1);
      expect(mockChannelStateStore).toHaveBeenCalledTimes(1);
      // prune receives the FULL configured set: a partial list would wipe
      // the stopped records of exactly the skipped channels (#8975).
      // Adopted legacy stops are exempt from that cleanup (#8975, R12-47
      // fix).
      expect(mockChannelStateStorePrune).toHaveBeenCalledWith(
        ['telegram', 'feishu'],
        { preserveAdopted: true },
      );
      expect(mockChannelStateStorePrune).toHaveBeenCalledTimes(1);
      // Adoption must run before the state read, or startAll reads the
      // still-empty workspace file and overwrites the legacy stops (#8975).
      expect(
        mockAdoptLegacyChannelState.mock.invocationCallOrder[0],
      ).toBeLessThan(mockChannelStateStorePrune.mock.invocationCallOrder[0]!);
      // No write after the read: the restore filter is the only consumer
      // of the file on this path (R9-19).
      expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
      expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
      // One-sided warning pin: the removed batched write's warning must
      // not fire on a successful startup — a false data-loss alarm on
      // every normal start (R9-18). Sink twin (R12-3): the real warning
      // sink is the best-effort one.
      expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
        '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
      );
      expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
        '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
      );
      expect(mockWriteServiceInfo).toHaveBeenCalledWith(
        ['telegram', 'feishu'],
        process.cwd(),
      );
    });
  });

  it('force-starts a named channel even when its state is stopped', async () => {
    mockLoadSettings.mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    });
    mockChannelStateStoreReadAll.mockReturnValue({ telegram: 'stopped' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      mockParsedChannelConfig,
      expect.any(Object),
      expect.any(Object),
    );
    // This named start's connect fails (default rejection): a failed
    // connect must NOT overwrite the `stopped` record — recording active
    // here would resurrect the channel on every later `--channel all`
    // start (#8975).
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // The connect-failure exit path must tear down the already-started
    // bridge, or its CLI child is orphaned on every failed startup (bad
    // credentials, network down — the routine failure paths) (#8975).
    expect(mockBridgeStop).toHaveBeenCalled();
  });

  it('records a named channel as active after a successful connect', async () => {
    mockLoadSettings.mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    });
    mockChannelConnect.mockResolvedValue(undefined);
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('telegram', 'active');
    // Scoped write only (doudouOUC C2): the legacy global write is GATED
    // on a differing record, and this test's legacy file carries none
    // (default readAll `{}`). Absence already means active to adoption,
    // so the fsync'd legacy write is skipped for a first-ever named
    // start. The R16-30 flip direction — legacy record `stopped` →
    // legacy write — is pinned by the `overwrites a prior stopped
    // record` test below.
    expect(mockChannelStateStoreSet).toHaveBeenCalledTimes(1);
    // The gate still constructs a legacy store to READ the record: the
    // path helper and store counts stay two each (scoped write + legacy
    // gate read), the write count drops to one.
    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith();
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
    expect(mockChannelStateStoreReadAll).toHaveBeenCalled();
    // Cardinality pin (the startAll twins pin it; the named path did not):
    // a refactor generalizing recordChannelActive to write every configured
    // name would flip other channels' `stopped` records to `active` while
    // the any-call assertion above still matches (#8975).
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // One-sided warning pin: the persistence-failure warning is pinned on
    // the failure twin below; a successful named start must NOT fire it —
    // a false data-loss alarm on every successful restart-by-name (R9-18).
    // Sink twin (R12-3): the real warning sink is the best-effort one.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
    // The named path adopts legacy stops too, and BEFORE the first
    // workspace-scoped write: a named start must not create a
    // snapshot-less workspace file first, or the next adoption treats it
    // as predating snapshot recording, baselines without merging, and
    // drops the legacy stops (#8975).
    expect(mockAdoptLegacyChannelState).toHaveBeenCalledWith(process.cwd());
    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith(process.cwd());
    // The store is constructed with the workspace-scoped path the helper
    // returns for THAT argument — the mock derives its return from the
    // argument, so a split derivation here writes to a different file
    // than stop.ts addresses (R9-16).
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      `/tmp/qwen-home/channels/standalone/${process.cwd()}/channel-state.json`,
    );
    // Uniqueness pins, mirroring the daemon-worker suite (R12-15): an
    // additional wrong-path adoption/store construction alongside the
    // right one ships green against the membership pins alone. The path
    // helper and store counts are two each since the dual-write (scoped +
    // legacy, R16-30); adoption stays a single call.
    expect(mockAdoptLegacyChannelState).toHaveBeenCalledTimes(1);
    expect(mockChannelRuntimeStatePath).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStore).toHaveBeenCalledTimes(2);
    expect(
      mockAdoptLegacyChannelState.mock.invocationCallOrder[0],
    ).toBeLessThan(mockChannelStateStoreSet.mock.invocationCallOrder[0]!);
  });

  it('overwrites a prior stopped record when a named channel connects (#8975)', async () => {
    // Positive half of the restore contract: the only stopped-seed named
    // test fails the connect and asserts NO write, leaving the overwrite
    // direction untested. A future "don't overwrite an explicit stop"
    // guard would leave `stopped` persisted after an explicit restart, so
    // the next `--channel all` skips the channel the user just restarted.
    mockLoadSettings.mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    });
    mockChannelStateStoreReadAll.mockReturnValue({ telegram: 'stopped' });
    mockChannelConnect.mockResolvedValue(undefined);
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    // Two writes (R16-30 flip, doudouOUC C2 gate FIRES): the legacy file
    // records `stopped` for the name (readAll seed above), so the gated
    // legacy write runs and BOTH files flip the explicitly restarted
    // name to `active`.
    expect(mockChannelStateStoreSet).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('telegram', 'active');
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
  });

  it('skips the legacy active write when the legacy record is already active (doudouOUC C2)', async () => {
    // The C2 gate's third arm: a legacy record that already matches the
    // restart (`active`) needs no fsync'd rewrite — only a differing
    // `stopped` record does (pinned by the test above). A restart-by-name
    // loop on a warm legacy file pays one scoped write per restart.
    mockLoadSettings.mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    });
    mockChannelStateStoreReadAll.mockReturnValue({ telegram: 'active' });
    mockChannelConnect.mockResolvedValue(undefined);
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    // Scoped write only; the legacy gate read happens (readAll) but the
    // legacy write is skipped.
    expect(mockChannelStateStoreSet).toHaveBeenCalledTimes(1);
    expect(mockChannelStateStoreSet).toHaveBeenCalledWith('telegram', 'active');
    expect(mockChannelStateStoreReadAll).toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // No loss warning: nothing was lost — the legacy record already
    // matches.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
  });

  it('still finishes a named start when state persistence fails (#8975)', async () => {
    mockLoadSettings.mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    });
    mockChannelConnect.mockResolvedValue(undefined);
    mockChannelStateStoreSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    // The connect already succeeded; a persistence failure must not abort
    // the start before the pidfile write, or the connected channel is left
    // stranded without a pidfile (#8975).
    expect(mockWriteServiceInfo).toHaveBeenCalledWith(
      ['telegram'],
      process.cwd(),
    );
    // The loss must still be surfaced like the stop direction does: a
    // stale `stopped` record would re-skip the explicitly restarted
    // channel on the next `--channel all` restore (#8975). Sink pin
    // (R12-3): the warning rides the best-effort sink — it fires exactly
    // when the disk is failing.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
  });
});
