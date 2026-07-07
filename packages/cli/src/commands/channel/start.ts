import type { CommandModule } from 'yargs';
import {
  appendChannelMemory,
  clearChannelMemory,
  nextFireTime,
  parseCron,
  readChannelMemory,
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
  ChannelBase,
  ChannelBaseOptions,
  ChannelLoopController,
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
  registerSessionCleanup,
  registerToolCallDispatch,
  selectFirstModel,
  sessionsPath,
} from './runtime.js';
import { BridgeChannelMemoryIntentClassifier } from './memory-intent-classifier.js';

export { resolveExtensionChannelEntrySpecifier } from './runtime.js';
export { resolveProxy } from './proxy.js';

const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 5 * 60 * 1000; // 5-minute window for counting crashes
const RESTART_DELAY_MS = 3000;

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
): Pick<ChannelBaseOptions, 'channelMemory' | 'memoryIntentClassifier'> {
  return {
    channelMemory: {
      readChannelMemory,
      appendChannelMemory,
      clearChannelMemory,
    },
    memoryIntentClassifier: new BridgeChannelMemoryIntentClassifier(
      getBridge,
      cwd,
    ),
  };
}

function createLoopController(store: ChannelLoopStore): ChannelLoopController {
  return {
    create: (input) => store.create(input),
    createForTarget: (input, maxEnabledLoops) =>
      store.createForTarget(input, maxEnabledLoops),
    listForTarget: (channelName, target) =>
      store.listForTarget(channelName, target),
    disable: (id) => store.disable(id),
    validateCron: (cron) => {
      parseCron(cron);
      nextFireTime(cron, new Date());
    },
    nextFireTime: (job) =>
      nextFireTime(job.cron, new Date(job.lastFiredAt ?? job.createdAt)),
  };
}

function isChannelCronEnabled(settings: {
  merged: { experimental?: { cron?: boolean } };
}): boolean {
  if (process.env['QWEN_CODE_DISABLE_CRON'] === '1') return false;
  return settings.merged.experimental?.cron !== false;
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
  } catch (err) {
    writeStderrLine(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const cliEntryPath = findCliEntryPath();
  let shuttingDown = false;
  const crashTimestamps: number[] = [];

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
    ? createLoopController(loopStore)
    : undefined;
  const channels: Map<string, ChannelBase> = new Map();

  const channel = await createChannel(name, config, bridge, {
    router,
    proxy,
    ...channelMemoryOptions(() => bridge, config.cwd),
    ...(loopController ? { loopController } : {}),
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
  scheduler?.start();
  writeStdoutLine(`[Channel] "${name}" is running. Press Ctrl+C to stop.`);

  const attachDisconnectHandler = (b: AcpBridge): void => {
    b.on('disconnected', async () => {
      if (shuttingDown) return;

      const now = Date.now();
      crashTimestamps.push(now);
      // Only count crashes within the recent window
      const recentCrashes = crashTimestamps.filter(
        (ts) => now - ts < CRASH_WINDOW_MS,
      );

      if (recentCrashes.length > MAX_CRASH_RESTARTS) {
        writeStderrLine(
          `[Channel] Bridge crashed ${recentCrashes.length} times in ${CRASH_WINDOW_MS / 1000}s. Giving up.`,
        );
        scheduler?.stop();
        channel.disconnect();
        router.clearAll();
        removeServiceInfo();
        process.exit(1);
      }

      writeStderrLine(
        `[Channel] Bridge crashed (${recentCrashes.length}/${MAX_CRASH_RESTARTS} in window). Restarting in ${RESTART_DELAY_MS / 1000}s...`,
      );
      scheduler?.stop();
      await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));

      try {
        bridge = new AcpBridge(bridgeOpts);
        await bridge.start();
        router.setBridge(bridge);
        channel.setBridge(bridge);
        channel.disconnect();
        await channel.connect();
        registerToolCallDispatch(bridge, router, channels);
        registerSessionCleanup(bridge, router, channels);
        attachDisconnectHandler(bridge);

        const result = await router.restoreSessions();
        scheduler?.start();
        writeStdoutLine(
          `[Channel] Bridge restarted. Sessions restored: ${result.restored}, failed: ${result.failed}`,
        );
      } catch (err) {
        writeStderrLine(
          `[Channel] Failed to restart bridge: ${err instanceof Error ? err.message : String(err)}`,
        );
        channel.disconnect();
        router.clearAll();
        removeServiceInfo();
        process.exit(1);
      }
    });
  };
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
  } catch (err) {
    writeStderrLine(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const cliEntryPath = findCliEntryPath();
  const defaultCwd = process.cwd();
  let shuttingDown = false;
  const crashTimestamps: number[] = [];

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
    ? createLoopController(loopStore)
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
      }),
    );
  }
  registerToolCallDispatch(bridge, router, channels);
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
  scheduler?.start();
  writeStdoutLine(
    `[Channel] Running ${connectedCount} channel(s). Press Ctrl+C to stop.`,
  );

  const attachDisconnectHandler = (b: AcpBridge): void => {
    b.on('disconnected', async () => {
      if (shuttingDown) return;

      const now = Date.now();
      crashTimestamps.push(now);
      const recentCrashes = crashTimestamps.filter(
        (ts) => now - ts < CRASH_WINDOW_MS,
      );

      if (recentCrashes.length > MAX_CRASH_RESTARTS) {
        writeStderrLine(
          `[Channel] Bridge crashed ${recentCrashes.length} times in ${CRASH_WINDOW_MS / 1000}s. Giving up.`,
        );
        scheduler?.stop();
        for (const channel of channels.values()) {
          try {
            channel.disconnect();
          } catch {
            // best-effort
          }
        }
        router.clearAll();
        removeServiceInfo();
        process.exit(1);
      }

      writeStderrLine(
        `[Channel] Bridge crashed (${recentCrashes.length}/${MAX_CRASH_RESTARTS} in window). Restarting in ${RESTART_DELAY_MS / 1000}s...`,
      );
      scheduler?.stop();
      await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));

      try {
        bridge = new AcpBridge(bridgeOpts);
        await bridge.start();
        router.setBridge(bridge);
        for (const channel of channels.values()) {
          channel.setBridge(bridge);
        }
        for (const [name, channel] of connectedChannels) {
          try {
            channel.disconnect();
            await channel.connect();
          } catch (err) {
            writeStderrLine(
              `[Channel] "${name}" failed to reconnect: ${err instanceof Error ? err.message : String(err)}`,
            );
            connectedChannels.delete(name);
          }
        }
        if (connectedChannels.size === 0) {
          writeStderrLine('[Channel] No channels reconnected. Exiting.');
          bridge.stop();
          router.clearAll();
          removeServiceInfo();
          process.exit(1);
        }
        registerToolCallDispatch(bridge, router, channels);
        registerSessionCleanup(bridge, router, channels);
        attachDisconnectHandler(bridge);

        const result = await router.restoreSessions();
        scheduler?.start();
        writeStdoutLine(
          `[Channel] Bridge restarted. Sessions restored: ${result.restored}, failed: ${result.failed}`,
        );
      } catch (err) {
        writeStderrLine(
          `[Channel] Failed to restart bridge: ${err instanceof Error ? err.message : String(err)}`,
        );
        for (const channel of channels.values()) {
          try {
            channel.disconnect();
          } catch {
            // best-effort
          }
        }
        router.clearAll();
        removeServiceInfo();
        process.exit(1);
      }
    });
  };
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
    const proxy = resolveProxy(
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
