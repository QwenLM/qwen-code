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
import {
  writeStderrLine,
  writeStdoutLine,
  writeStdoutLineBestEffort,
} from '../../utils/stdioHelpers.js';
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
  // its own and leave a dangling pidfile (#8975). The delay is
  // deliberate: TIMEOUT_MAX (2^31 - 1 ms ≈ 24.8 days), the largest value
  // setInterval accepts — the zero-channel state is a long-lived steady
  // state, and a small delay would tick an empty callback thousands of
  // times a second and burn a CPU core on every machine left in it.
  // Pinned by the zero-channel tests in start.test.ts (R10-44).
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
  const persisted = new ChannelStateStore(
    channelRuntimeStatePath(workspaceCwd),
  ).trySet(name, 'active');
  // Mirror the stop side's dual-write (recordStoppedChannels): a stop
  // records `stopped` in BOTH the workspace-scoped store and the legacy
  // global file, and adoption seeds every other workspace from the
  // legacy file on its next start. Without the mirrored active write the
  // restart stays scoped to this workspace — after the service dies, a
  // bare start from ANOTHER workspace adopts the legacy `stopped` record
  // and skips the channel the user explicitly restarted (R16-30).
  //
  // The legacy write is GATED on a differing record (doudouOUC C2): it
  // only matters while the legacy file still says `stopped` for this
  // name — the restart must flip that. An absent record (absence already
  // means active to adoption) or an already-`active` one needs no write,
  // so a restart-by-name loop pays one scoped write instead of two
  // fsync'd atomic writes per restart. readAll is the store's tolerant
  // contract read: an unreadable legacy file yields no record and the
  // write is skipped — the mirror is then lost under the same disk
  // condition the write itself would fail under, and the store already
  // warned about the unreadable file.
  let legacyPersisted = true;
  if (workspaceCwd) {
    const legacyStore = new ChannelStateStore(channelRuntimeStatePath());
    if (legacyStore.readAll()[name] === 'stopped') {
      legacyPersisted = legacyStore.trySet(name, 'active');
    }
  }
  // The channel IS running, so a failed write is a warning, not an exit —
  // but the stale `stopped` record survives and the next `--channel all`
  // would skip the channel the user explicitly restarted. Surface the loss
  // like the stop direction does (#8975).
  if (!persisted || !legacyPersisted) {
    // Best-effort sink: a warning write must not terminate the process
    // when stdout is already failing (R11-13).
    writeStdoutLineBestEffort(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
  }
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
  // Adopt legacy stops before the first workspace-scoped write: a named
  // start must not create a snapshot-less workspace file first, or the
  // next adoption treats it as predating snapshot recording, baselines
  // without merging, and drops the legacy stops (#8975). Adoption runs on
  // EVERY start and snapshot-diff merges; this ordering keeps the first
  // write from beating the initial sync to file creation.
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
    // skipped forever by a stale `stopped` record. Adopted legacy stops
    // are exempt: they were recorded in another workspace or an older
    // release, and pruning them here lets the snapshot shield the loss
    // from ever re-merging (#8975).
    states = stateStore.prune(configuredNames, { preserveAdopted: true });
  } catch {
    // prune throws on ANY store failure — a transient READ failure
    // (applyChange rethrows every non-ENOENT read error) as well as a
    // write failure. Fall back to whatever is still readable; when that
    // is empty, say so: selecting from an empty map treats every
    // configured channel as active, including explicitly stopped ones
    // (#8975). Best-effort sink (R11-13).
    states = stateStore.readAll();
    writeStdoutLineBestEffort(
      Object.keys(states).length === 0
        ? '[Channel] Warning: no recorded channel state readable; treating all channels as active.'
        : '[Channel] Warning: failed to update channel state; falling back to recorded states.',
    );
  }
  // Skip notices are best-effort diagnostics: route them through the
  // guarded sink so a dead stdout reader cannot kill the start (R11-13).
  const selectedNames = selectActiveChannels(
    configuredNames,
    states,
    writeStdoutLineBestEffort,
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
  // No batched `active` write here: every connected name was selected by
  // selectActiveChannels, which excludes exactly the `stopped` entries —
  // the file already holds active-or-nothing for each of them and no
  // reader distinguishes those, so the write (and a warning claiming a
  // skip consequence its loss cannot produce) was pure noise on the
  // startup critical path (R9-19). startSingle's recordChannelActive is
  // different: a restart-by-name clears a prior `stopped` record.
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
