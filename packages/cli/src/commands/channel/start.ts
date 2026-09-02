import type { CommandModule } from 'yargs';
import {
  addChannelMemoryEntries,
  clearChannelMemory,
  getChannelMemoryRevision,
  listChannelMemoryEntries,
  nextFireTime,
  readChannelMemory,
  recordChannelMemoryRecallMetrics,
  removeChannelMemoryEntries,
  updateChannelMemoryEntry,
} from '@qwen-code/qwen-code-core';
import { loadSettings } from '../../config/settings.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  AcpBridge,
  ChannelLoopScheduler,
  ChannelLoopStore,
  SessionRouter,
} from '@qwen-code/channel-base';
import type {
  AcpBridgeOptions,
  ChannelBase,
  ChannelBaseOptions,
} from '@qwen-code/channel-base';
import { findCliEntryPath, parseChannelConfig } from './config-utils.js';
import { resolveProxy } from './proxy.js';
import {
  readServiceInfo,
  writeServiceInfo,
  removeServiceInfo,
} from './pidfile.js';
import {
  createChannel,
  channelLoopPath,
  loadChannelsConfig,
  loadChannelsFromExtensions,
  parseConfiguredChannels,
  registerBackgroundResponseRelay,
  registerPermissionRelay,
  registerSessionCleanup,
  registerToolCallDispatch,
  selectFirstModel,
  sessionsPath,
} from './runtime.js';
import { BridgeChannelMemoryIntentClassifier } from './memory-intent-classifier.js';
import {
  createChannelLoopController,
  isChannelCronEnabled,
} from './loop-runtime.js';

export { resolveExtensionChannelEntrySpecifier } from './runtime.js';
export { resolveProxy } from './proxy.js';

const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 5 * 60 * 1000; // 5-minute window for counting crashes
const RESTART_DELAY_MS = 3000;
export const BRIDGE_SESSION_RESTORE_TIMEOUT_MS = 60 * 1000;

function isFileExistsError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function channelMemoryOptions(
  getBridge: () => AcpBridge,
  cwd: string,
): Pick<
  ChannelBaseOptions,
  'channelMemory' | 'memoryIntentClassifier' | 'channelMemoryRecallObserver'
> {
  return {
    channelMemory: {
      readChannelMemory,
      getChannelMemoryRevision,
      listChannelMemoryEntries,
      addChannelMemoryEntries,
      updateChannelMemoryEntry,
      removeChannelMemoryEntries,
      clearChannelMemory,
    },
    memoryIntentClassifier: new BridgeChannelMemoryIntentClassifier(
      getBridge,
      cwd,
    ),
    channelMemoryRecallObserver: recordChannelMemoryRecallMetrics,
  };
}

function isUnverifiablePidfileError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === 'channel_service_conflict'
  );
}

function writeServiceInfoOrExit(channels: string[], cleanup: () => void): void {
  try {
    writeServiceInfo(channels);
  } catch (err) {
    cleanup();
    if (isFileExistsError(err)) {
      writeStderrLine(
        'Error: Channel service was started concurrently. Use "qwen channel status" to inspect it.',
      );
      process.exit(1);
    }
    if (isUnverifiablePidfileError(err)) {
      // Retrying cannot clear a record this side can never verify, so the
      // pidfile's own recovery step replaces the concurrent-startup advice.
      writeStderrLine(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function cleanupStartedChannels(
  channels: Iterable<ChannelBase>,
  bridge: AcpBridge,
  router: SessionRouter,
): void {
  for (const channel of channels) {
    try {
      channel.disconnect();
    } catch {
      // best-effort
    }
  }
  try {
    bridge.stop();
  } catch {
    // best-effort
  }
  try {
    router.clearAll();
  } catch {
    // best-effort
  }
}

function createBridgeReadinessGate(): {
  current: () => Promise<void> | undefined;
  block: () => void;
  release: () => void;
} {
  let pending: Promise<void> | undefined;
  let releasePending: (() => void) | undefined;
  return {
    current: () => pending,
    block: () => {
      if (pending) return;
      pending = new Promise<void>((resolve) => {
        releasePending = resolve;
      });
    },
    release: () => {
      const release = releasePending;
      pending = undefined;
      releasePending = undefined;
      release?.();
    },
  };
}

async function restoreBridgeSessions(
  router: SessionRouter,
): ReturnType<SessionRouter['restoreSessions']> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(
            `Session restore timed out after ${BRIDGE_SESSION_RESTORE_TIMEOUT_MS}ms`,
          ),
        ),
      BRIDGE_SESSION_RESTORE_TIMEOUT_MS,
    );
    timeout.unref?.();
  });
  try {
    return await Promise.race([router.restoreSessions(), expired]);
  } finally {
    clearTimeout(timeout);
  }
}

interface BridgeRecoveryOptions {
  bridgeOpts: AcpBridgeOptions;
  router: SessionRouter;
  channels: Map<string, ChannelBase>;
  scheduler: ChannelLoopScheduler | undefined;
  bridgeReadiness: ReturnType<typeof createBridgeReadinessGate>;
  isShuttingDown: () => boolean;
  getBridge: () => AcpBridge;
  setBridge: (bridge: AcpBridge) => void;
}

/**
 * Rebuild the ACP bridge after a disconnect while keeping channel adapters
 * connected. Shared by the standalone and all-channel start paths; the only
 * per-path state comes in through the accessors.
 */
function createBridgeRecovery(options: BridgeRecoveryOptions): {
  attachDisconnectHandler: (bridge: AcpBridge) => void;
} {
  const {
    bridgeOpts,
    router,
    channels,
    scheduler,
    bridgeReadiness,
    isShuttingDown,
    getBridge,
    setBridge,
  } = options;
  const crashTimestamps: number[] = [];
  let recoveryTask: Promise<void> | undefined;
  let recoveryRequested = false;
  let recoverySourceBridge: AcpBridge | undefined;

  const attachDisconnectHandler = (failedBridge: AcpBridge): void => {
    failedBridge.on('disconnected', () => {
      if (isShuttingDown() || failedBridge !== getBridge()) return;
      if (recoveryTask) {
        if (failedBridge !== recoverySourceBridge) recoveryRequested = true;
        return;
      }
      recoverBridge();
    });
  };

  const recoverBridge = (): void => {
    bridgeReadiness.block();
    scheduler?.markBridgeRecovery();
    const task = (async () => {
      do {
        recoveryRequested = false;
        recoverySourceBridge = getBridge();
        const now = Date.now();
        crashTimestamps.push(now);
        while (now - crashTimestamps[0]! >= CRASH_WINDOW_MS) {
          crashTimestamps.shift();
        }
        const recentCrashCount = crashTimestamps.length;

        if (recentCrashCount > MAX_CRASH_RESTARTS) {
          writeStderrLine(
            `[Channel] Bridge crashed ${recentCrashCount} times in ${CRASH_WINDOW_MS / 1000}s. Giving up.`,
          );
          scheduler?.stop();
          cleanupStartedChannels(channels.values(), getBridge(), router);
          removeServiceInfo();
          process.exit(1);
        }

        writeStderrLine(
          `[Channel] Bridge crashed (${recentCrashCount}/${MAX_CRASH_RESTARTS} in window). Restarting in ${RESTART_DELAY_MS / 1000}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));

        const bridge = new AcpBridge(bridgeOpts);
        setBridge(bridge);
        attachDisconnectHandler(bridge);
        await bridge.start();
        router.setBridge(bridge);
        for (const channel of channels.values()) {
          channel.setBridge(bridge);
        }
        registerToolCallDispatch(bridge, router, channels);
        registerBackgroundResponseRelay(bridge, router, channels);
        registerPermissionRelay(bridge, router, channels);
        registerSessionCleanup(bridge, router, channels);

        const result = await restoreBridgeSessions(router);
        writeStdoutLine(
          `[Channel] Bridge restarted. Sessions restored: ${result.restored}, failed: ${result.failed}`,
        );
      } while (recoveryRequested && !isShuttingDown());
    })()
      .catch((err) => {
        writeStderrLine(
          `[Channel] Failed to restart bridge: ${err instanceof Error ? err.message : String(err)}`,
        );
        scheduler?.stop();
        cleanupStartedChannels(channels.values(), getBridge(), router);
        removeServiceInfo();
        process.exit(1);
      })
      .finally(() => {
        if (recoveryTask === task) {
          recoveryTask = undefined;
          recoverySourceBridge = undefined;
          bridgeReadiness.release();
        }
      });
    recoveryTask = task;
  };

  return { attachDisconnectHandler };
}

/** Check for duplicate instance and abort if one is already running. */
function checkDuplicateInstance(): void {
  const existing = readServiceInfo();
  if (existing) {
    if (existing.owner === 'serve') {
      writeStderrLine(
        `Error: Channel service is managed by qwen serve (PID ${existing.pid}, started ${existing.startedAt}).`,
      );
      writeStderrLine('Stop the qwen serve process to stop managed channels.');
      process.exit(1);
    }
    writeStderrLine(
      `Error: Channel service is already running (PID ${existing.pid}, started ${existing.startedAt}).`,
    );
    writeStderrLine('Use "qwen channel stop" to stop it first.');
    process.exit(1);
  }
}

/** Start a single channel with its own bridge + crash recovery. */
async function startSingle(
  name: string,
  proxy: string | undefined,
  cronEnabled: boolean,
): Promise<void> {
  checkDuplicateInstance();
  const channelsConfig = loadChannelsConfig();

  await loadChannelsFromExtensions();

  if (!channelsConfig[name]) {
    writeStderrLine(
      `Error: Channel "${name}" not found in settings. Add it to channels.${name} in settings.json.`,
    );
    process.exit(1);
  }

  let config;
  try {
    config = await parseChannelConfig(
      name,
      channelsConfig[name] as Record<string, unknown>,
      process.cwd(),
      { resolveEnvVars: 'available' },
    );
    if (config.multiSession) {
      throw new Error(
        'multiSession is available only for daemon-managed Channels started by qwen serve.',
      );
    }
  } catch (err) {
    writeStderrLine(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const cliEntryPath = findCliEntryPath();
  let shuttingDown = false;

  const bridgeReadiness = createBridgeReadinessGate();

  const bridgeOpts = { cliEntryPath, cwd: config.cwd, model: config.model };
  let bridge = new AcpBridge(bridgeOpts);
  await bridge.start();

  const router = new SessionRouter(
    bridge,
    config.cwd,
    config.sessionScope,
    sessionsPath(),
  );
  router.setChannelApprovalMode(name, config.approvalMode);
  const loopStore = cronEnabled
    ? new ChannelLoopStore({ filePath: channelLoopPath() })
    : undefined;
  const loopController = loopStore
    ? createChannelLoopController(loopStore)
    : undefined;
  const channels: Map<string, ChannelBase> = new Map();

  const channel = await createChannel(name, config, bridge, {
    router,
    proxy,
    ...channelMemoryOptions(() => bridge, config.cwd),
    ...(loopController ? { loopController } : {}),
    bridgeRecovery: bridgeReadiness.current,
  });
  channels.set(name, channel);
  const scheduler = loopStore
    ? new ChannelLoopScheduler({
        store: loopStore,
        channels,
        nextFireTime,
      })
    : undefined;
  registerToolCallDispatch(bridge, router, channels);
  registerBackgroundResponseRelay(bridge, router, channels);
  registerPermissionRelay(bridge, router, channels);
  registerSessionCleanup(bridge, router, channels);

  try {
    await channel.connect();
  } catch (err) {
    writeStderrLine(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    bridge.stop();
    process.exit(1);
  }
  writeServiceInfoOrExit([name], () =>
    cleanupStartedChannels([channel], bridge, router),
  );
  // Keep scheduled loops active; their prompt paths wait on bridgeReadiness.
  scheduler?.start();
  writeStdoutLine(`[Channel] "${name}" is running. Press Ctrl+C to stop.`);

  const { attachDisconnectHandler } = createBridgeRecovery({
    bridgeOpts,
    router,
    channels,
    scheduler,
    bridgeReadiness,
    isShuttingDown: () => shuttingDown,
    getBridge: () => bridge,
    setBridge: (next) => {
      bridge = next;
    },
  });
  attachDisconnectHandler(bridge);

  const shutdown = () => {
    shuttingDown = true;
    writeStdoutLine('\n[Channel] Shutting down...');
    scheduler?.stop();
    channel.disconnect();
    bridge.stop();
    router.clearAll();
    removeServiceInfo();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>(() => {});
}

/** Start all configured channels with a shared bridge + crash recovery. */
async function startAll(
  proxy: string | undefined,
  cronEnabled: boolean,
): Promise<void> {
  checkDuplicateInstance();
  const channelsConfig = loadChannelsConfig();

  await loadChannelsFromExtensions();

  if (Object.keys(channelsConfig).length === 0) {
    writeStderrLine(
      'Error: No channels configured in settings.json. Add entries under "channels".',
    );
    process.exit(1);
  }

  // Parse all configs upfront — fail fast on bad config
  let parsed;
  try {
    parsed = await parseConfiguredChannels(
      channelsConfig,
      Object.keys(channelsConfig),
    );
    if (parsed.some(({ config }) => config.multiSession)) {
      throw new Error(
        'multiSession is available only for daemon-managed Channels started by qwen serve.',
      );
    }
  } catch (err) {
    writeStderrLine(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const cliEntryPath = findCliEntryPath();
  const defaultCwd = process.cwd();
  let shuttingDown = false;

  const bridgeReadiness = createBridgeReadinessGate();

  const bridgeOpts = {
    cliEntryPath,
    cwd: defaultCwd,
    model: selectFirstModel(parsed, 'Shared bridge'),
  };
  let bridge = new AcpBridge(bridgeOpts);
  await bridge.start();

  const router = new SessionRouter(bridge, defaultCwd, 'user', sessionsPath());
  const loopStore = cronEnabled
    ? new ChannelLoopStore({ filePath: channelLoopPath() })
    : undefined;
  const loopController = loopStore
    ? createChannelLoopController(loopStore)
    : undefined;
  // Register per-channel routing overrides.
  for (const { name, config } of parsed) {
    router.setChannelScope(name, config.sessionScope);
    router.setChannelApprovalMode(name, config.approvalMode);
  }
  const channels: Map<string, ChannelBase> = new Map();

  writeStdoutLine(
    `[Channel] Starting ${parsed.length} channel(s): ${parsed.map((p) => p.name).join(', ')}`,
  );

  for (const { name, config } of parsed) {
    channels.set(
      name,
      await createChannel(name, config, bridge, {
        router,
        proxy,
        ...channelMemoryOptions(() => bridge, config.cwd),
        ...(loopController ? { loopController } : {}),
        bridgeRecovery: bridgeReadiness.current,
      }),
    );
  }
  registerToolCallDispatch(bridge, router, channels);
  registerBackgroundResponseRelay(bridge, router, channels);
  registerPermissionRelay(bridge, router, channels);
  registerSessionCleanup(bridge, router, channels);

  // Connect all channels
  let connectedCount = 0;
  const connectedChannels: Map<string, ChannelBase> = new Map();
  for (const [name, channel] of channels) {
    try {
      await channel.connect();
      connectedChannels.set(name, channel);
      connectedCount++;
      writeStdoutLine(`[Channel] "${name}" connected.`);
    } catch (err) {
      writeStderrLine(
        `[Channel] Failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (connectedCount === 0) {
    writeStderrLine('[Channel] No channels connected. Exiting.');
    bridge.stop();
    process.exit(1);
  }
  const scheduler = loopStore
    ? new ChannelLoopScheduler({
        store: loopStore,
        channels: connectedChannels,
        nextFireTime,
      })
    : undefined;
  writeServiceInfoOrExit(
    parsed.map((p) => p.name),
    () => cleanupStartedChannels(channels.values(), bridge, router),
  );
  // Keep scheduled loops active; their prompt paths wait on bridgeReadiness.
  scheduler?.start();
  writeStdoutLine(
    `[Channel] Running ${connectedCount} channel(s). Press Ctrl+C to stop.`,
  );

  const { attachDisconnectHandler } = createBridgeRecovery({
    bridgeOpts,
    router,
    channels,
    scheduler,
    bridgeReadiness,
    isShuttingDown: () => shuttingDown,
    getBridge: () => bridge,
    setBridge: (next) => {
      bridge = next;
    },
  });
  attachDisconnectHandler(bridge);

  const shutdown = () => {
    shuttingDown = true;
    writeStdoutLine('\n[Channel] Shutting down...');
    scheduler?.stop();
    for (const [name, channel] of channels) {
      try {
        channel.disconnect();
        writeStdoutLine(`[Channel] "${name}" disconnected.`);
      } catch {
        // best-effort
      }
    }
    bridge.stop();
    router.clearAll();
    removeServiceInfo();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>(() => {});
}

export const startCommand: CommandModule<object, { name?: string }> = {
  command: 'start [name]',
  describe: 'Start channels (all if no name given, or a single named channel)',
  builder: (yargs) =>
    yargs.positional('name', {
      type: 'string',
      describe: 'Channel name (omit to start all configured channels)',
    }),
  handler: async (argv) => {
    const settings = loadSettings(process.cwd());
    const proxy = await resolveProxy(
      (argv as Record<string, unknown>)['proxy'] as string | undefined,
      settings.merged.proxy as string | undefined,
    );
    const cronEnabled = isChannelCronEnabled(settings);
    if (argv.name) {
      await startSingle(argv.name, proxy, cronEnabled);
    } else {
      await startAll(proxy, cronEnabled);
    }
  },
};
