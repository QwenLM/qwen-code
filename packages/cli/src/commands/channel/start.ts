import * as path from 'node:path';
import * as os from 'node:os';
import type { CommandModule } from 'yargs';
import { loadSettings } from '../../config/settings.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { AcpBridge, SessionRouter } from '@qwen-code/channel-base';
import type { ChannelBase, ToolCallEvent } from '@qwen-code/channel-base';
import { getPlugin } from './channel-registry.js';
import { findCliEntryPath, parseChannelConfig } from './config-utils.js';
import {
  readServiceInfo,
  writeServiceInfo,
  removeServiceInfo,
} from './pidfile.js';

const MAX_CRASH_RESTARTS = 3;
const RESTART_DELAY_MS = 3000;

function sessionsPath(): string {
  return path.join(os.homedir(), '.qwen', 'channels', 'sessions.json');
}

function loadChannelsConfig(): Record<string, unknown> {
  const settings = loadSettings(process.cwd());
  const channels = (
    settings.merged as unknown as { channels?: Record<string, unknown> }
  ).channels;
  return channels || {};
}

function createChannel(
  name: string,
  config: ReturnType<typeof parseChannelConfig>,
  bridge: AcpBridge,
  options?: { router?: SessionRouter },
): ChannelBase {
  const channelPlugin = getPlugin(config.type);
  if (!channelPlugin) {
    throw new Error(`Unknown channel type: "${config.type}".`);
  }
  return channelPlugin.createChannel(name, config, bridge, options);
}

function registerToolCallDispatch(
  bridge: AcpBridge,
  router: SessionRouter,
  channels: Map<string, ChannelBase>,
): void {
  bridge.on('toolCall', (event: ToolCallEvent) => {
    const target = router.getTarget(event.sessionId);
    if (target) {
      const channel = channels.get(target.channelName);
      if (channel) {
        channel.onToolCall(target.chatId, event);
      }
    }
  });
}

/** Check for duplicate instance and abort if one is already running. */
function checkDuplicateInstance(): void {
  const existing = readServiceInfo();
  if (existing) {
    writeStderrLine(
      `Error: Channel service is already running (PID ${existing.pid}, started ${existing.startedAt}).`,
    );
    writeStderrLine('Use "qwen channel stop" to stop it first.');
    process.exit(1);
  }
}

/** Start a single channel with its own bridge + crash recovery. */
async function startSingle(name: string): Promise<void> {
  checkDuplicateInstance();
  const channelsConfig = loadChannelsConfig();

  if (!channelsConfig[name]) {
    writeStderrLine(
      `Error: Channel "${name}" not found in settings. Add it to channels.${name} in settings.json.`,
    );
    process.exit(1);
  }

  let config;
  try {
    config = parseChannelConfig(
      name,
      channelsConfig[name] as Record<string, unknown>,
    );
  } catch (err) {
    writeStderrLine(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const cliEntryPath = findCliEntryPath();
  let shuttingDown = false;
  let crashCount = 0;

  const bridgeOpts = { cliEntryPath, cwd: config.cwd, model: config.model };
  let bridge = new AcpBridge(bridgeOpts);
  await bridge.start();

  const router = new SessionRouter(bridge, config.cwd, 'user', sessionsPath());
  const channels: Map<string, ChannelBase> = new Map();

  const channel = createChannel(name, config, bridge, { router });
  channels.set(name, channel);
  registerToolCallDispatch(bridge, router, channels);
  await channel.connect();

  writeServiceInfo([name]);
  writeStdoutLine(`[Channel] "${name}" is running. Press Ctrl+C to stop.`);

  bridge.on('disconnected', async () => {
    if (shuttingDown) return;

    crashCount++;
    if (crashCount > MAX_CRASH_RESTARTS) {
      writeStderrLine(
        `[Channel] Bridge crashed ${crashCount} times. Giving up.`,
      );
      router.clearAll();
      removeServiceInfo();
      process.exit(1);
    }

    writeStderrLine(
      `[Channel] Bridge crashed (${crashCount}/${MAX_CRASH_RESTARTS}). Restarting in ${RESTART_DELAY_MS / 1000}s...`,
    );
    await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));

    try {
      bridge = new AcpBridge(bridgeOpts);
      await bridge.start();
      router.setBridge(bridge);
      channel.setBridge(bridge);
      registerToolCallDispatch(bridge, router, channels);

      const result = await router.restoreSessions();
      writeStdoutLine(
        `[Channel] Bridge restarted. Sessions restored: ${result.restored}, failed: ${result.failed}`,
      );
      crashCount = 0;
    } catch (err) {
      writeStderrLine(
        `[Channel] Failed to restart bridge: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const shutdown = () => {
    shuttingDown = true;
    writeStdoutLine('\n[Channel] Shutting down...');
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
async function startAll(): Promise<void> {
  checkDuplicateInstance();
  const channelsConfig = loadChannelsConfig();

  if (Object.keys(channelsConfig).length === 0) {
    writeStderrLine(
      'Error: No channels configured in settings.json. Add entries under "channels".',
    );
    process.exit(1);
  }

  // Parse all configs upfront — fail fast on bad config
  const parsed: Array<{
    name: string;
    config: ReturnType<typeof parseChannelConfig>;
  }> = [];
  for (const [name, raw] of Object.entries(channelsConfig)) {
    try {
      parsed.push({
        name,
        config: parseChannelConfig(name, raw as Record<string, unknown>),
      });
    } catch (err) {
      writeStderrLine(
        `Error in channel "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  const cliEntryPath = findCliEntryPath();
  const defaultCwd = process.cwd();
  let shuttingDown = false;
  let crashCount = 0;

  // All channels share one bridge process. Use the first channel's model.
  const models = [
    ...new Set(parsed.map((p) => p.config.model).filter(Boolean)),
  ];
  if (models.length > 1) {
    writeStderrLine(
      `[Channel] Warning: Multiple models configured (${models.join(', ')}). ` +
        `Shared bridge will use "${models[0]}".`,
    );
  }
  const bridgeOpts = {
    cliEntryPath,
    cwd: defaultCwd,
    model: models[0],
  };
  let bridge = new AcpBridge(bridgeOpts);
  await bridge.start();

  const router = new SessionRouter(bridge, defaultCwd, 'user', sessionsPath());
  const channels: Map<string, ChannelBase> = new Map();

  writeStdoutLine(
    `[Channel] Starting ${parsed.length} channel(s): ${parsed.map((p) => p.name).join(', ')}`,
  );

  for (const { name, config } of parsed) {
    channels.set(name, createChannel(name, config, bridge, { router }));
  }
  registerToolCallDispatch(bridge, router, channels);

  // Connect all channels
  let connectedCount = 0;
  for (const [name, channel] of channels) {
    try {
      await channel.connect();
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

  writeServiceInfo(parsed.map((p) => p.name));
  writeStdoutLine(
    `[Channel] Running ${connectedCount} channel(s). Press Ctrl+C to stop.`,
  );

  bridge.on('disconnected', async () => {
    if (shuttingDown) return;

    crashCount++;
    if (crashCount > MAX_CRASH_RESTARTS) {
      writeStderrLine(
        `[Channel] Bridge crashed ${crashCount} times. Giving up.`,
      );
      router.clearAll();
      removeServiceInfo();
      process.exit(1);
    }

    writeStderrLine(
      `[Channel] Bridge crashed (${crashCount}/${MAX_CRASH_RESTARTS}). Restarting in ${RESTART_DELAY_MS / 1000}s...`,
    );
    await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));

    try {
      bridge = new AcpBridge(bridgeOpts);
      await bridge.start();
      router.setBridge(bridge);
      for (const channel of channels.values()) {
        channel.setBridge(bridge);
      }
      registerToolCallDispatch(bridge, router, channels);

      const result = await router.restoreSessions();
      writeStdoutLine(
        `[Channel] Bridge restarted. Sessions restored: ${result.restored}, failed: ${result.failed}`,
      );
      crashCount = 0;
    } catch (err) {
      writeStderrLine(
        `[Channel] Failed to restart bridge: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const shutdown = () => {
    shuttingDown = true;
    writeStdoutLine('\n[Channel] Shutting down...');
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
    if (argv.name) {
      await startSingle(argv.name);
    } else {
      await startAll();
    }
  },
};
