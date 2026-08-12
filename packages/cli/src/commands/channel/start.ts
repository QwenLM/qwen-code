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
import {
  adoptLegacyChannelState,
  ChannelStateStore,
  channelRuntimeStatePath,
  selectActiveChannels,
  type ChannelRuntimeState,
} from './channel-state-store.js';
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

function writeServiceInfoOrExit(
  channels: string[],
  cleanup: () => void,
  workspaceCwd?: string,
): void {
  try {
    writeServiceInfo(channels, workspaceCwd);
  } catch (err) {
    cleanup();
    if (isFileExistsError(err)) {
      writeStderrLine(
        'Error: Channel service was started concurrently. Use "qwen channel status" to inspect it.',
      );
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
    writeStderrLine(
      'A standalone service hosts the channels it was started with; exit it (Ctrl+C, or "qwen channel stop") before starting a different channel set.',
    );
    writeStderrLine(
      'Note: "qwen channel stop" records the running channels as stopped, so a later "qwen channel start" skips them until each is started again by name.',
    );
    process.exit(1);
  }
}

/**
 * Keep the process serving with zero channels instead of exiting. An empty
 * effective channel set is a legitimate state (nothing configured, or every
 * configured channel stopped before restart), not a startup failure (#8975).
 */
async function serveWithoutChannels(
  message: string,
  workspaceCwd: string,
): Promise<void> {
  writeStdoutLine(message);
  writeServiceInfoOrExit([], () => {}, workspaceCwd);
  // Signal listeners and a pending promise do not keep the Node event loop
  // alive, so without a ref'd handle the zero-channel process would exit on
  // its own and leave a dangling pidfile (#8975).
  const keepAlive = setInterval(() => {}, 2_147_483_647);
  const shutdown = () => {
    clearInterval(keepAlive);
    writeStdoutLine('\n[Channel] Shutting down...');
    removeServiceInfo();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<void>(() => {});
}

/** Best-effort: record a successfully connected channel as active. */
function recordChannelActive(name: string, workspaceCwd: string): void {
  new ChannelStateStore(channelRuntimeStatePath(workspaceCwd)).trySet(
    name,
    'active',
  );
}

/** Start a single channel with its own bridge + crash recovery. */
async function startSingle(
  name: string,
  proxy: string | undefined,
  cronEnabled: boolean,
  workspaceCwd: string,
): Promise<void> {
  checkDuplicateInstance();
  const channelsConfig = loadChannelsConfig(workspaceCwd);

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
      workspaceCwd,
      { resolveEnvVars: 'available' },
    );
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
  // Adopt legacy stops before the first workspace-scoped write: once the
  // workspace file exists, adoption's existsSync guard never runs again, so
  // a named start must not create the file first and orphan the legacy
  // stops (#8975). Idempotent — a no-op once the workspace file exists.
  adoptLegacyChannelState(workspaceCwd);
  recordChannelActive(name, workspaceCwd);
  writeServiceInfoOrExit(
    [name],
    () => cleanupStartedChannels([channel], bridge, router),
    workspaceCwd,
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
  workspaceCwd: string,
): Promise<void> {
  checkDuplicateInstance();
  const channelsConfig = loadChannelsConfig(workspaceCwd);

  await loadChannelsFromExtensions();

  const configuredNames = Object.keys(channelsConfig);
  if (configuredNames.length === 0) {
    await serveWithoutChannels(
      '[Channel] No channels configured; serving with 0 channels.',
      workspaceCwd,
    );
    return;
  }

  // Restore semantics (#8975): skip channels explicitly stopped before the
  // last restart; channels without recorded state are treated as active.
  // State is scoped to this workspace, matching the config load above. A
  // legacy global file written by an older release is adopted first so its
  // recorded stops are not lost on upgrade.
  adoptLegacyChannelState(workspaceCwd);
  const stateStore = new ChannelStateStore(
    channelRuntimeStatePath(workspaceCwd),
  );
  let states: Record<string, ChannelRuntimeState>;
  try {
    // Drop entries for channels removed from settings so they cannot be
    // skipped forever by a stale `stopped` record.
    states = stateStore.prune(configuredNames);
  } catch {
    states = stateStore.readAll();
  }
  const selectedNames = selectActiveChannels(
    configuredNames,
    states,
    writeStdoutLine,
  );
  if (selectedNames.length === 0) {
    await serveWithoutChannels(
      '[Channel] All configured channels are stopped; serving with 0 channels. Exit this process, then restart individual channels with "qwen channel start <name>".',
      workspaceCwd,
    );
    return;
  }

  // Parse all configs upfront — fail fast on bad config
  let parsed;
  try {
    parsed = await parseConfiguredChannels(channelsConfig, selectedNames);
  } catch (err) {
    writeStderrLine(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const cliEntryPath = findCliEntryPath();
  const defaultCwd = workspaceCwd;
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
  // Register per-channel scope overrides so each channel uses its own sessionScope
  for (const { name, config } of parsed) {
    router.setChannelScope(name, config.sessionScope);
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
  const connectedChannels: Map<string, ChannelBase> = new Map();
  for (const [name, channel] of channels) {
    try {
      await channel.connect();
      connectedChannels.set(name, channel);
      writeStdoutLine(`[Channel] "${name}" connected.`);
    } catch (err) {
      writeStderrLine(
        `[Channel] Failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // One batched best-effort write after the loop instead of a fsync'd
  // read-modify-write per channel on the startup critical path.
  stateStore.trySetMany([...connectedChannels.keys()], 'active');
  const connectedCount = connectedChannels.size;

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
  // The pidfile lists the CONNECTED set, not the attempted set: `qwen
  // channel stop` persists these names as explicitly stopped, and
  // `qwen channel status` lists them as running — channels whose connect()
  // failed never ran and must not be recorded either way (#8975).
  writeServiceInfoOrExit(
    [...connectedChannels.keys()],
    () => cleanupStartedChannels(channels.values(), bridge, router),
    workspaceCwd,
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
    const workspaceCwd = process.cwd();
    const settings = loadSettings(workspaceCwd);
    const proxy = await resolveProxy(
      (argv as Record<string, unknown>)['proxy'] as string | undefined,
      settings.merged.proxy as string | undefined,
    );
    const cronEnabled = isChannelCronEnabled(settings);
    if (argv.name) {
      await startSingle(argv.name, proxy, cronEnabled, workspaceCwd);
    } else {
      await startAll(proxy, cronEnabled, workspaceCwd);
    }
  },
};
