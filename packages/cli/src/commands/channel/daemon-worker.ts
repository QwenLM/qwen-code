import type { CommandModule } from 'yargs';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import { loadSettings } from '../../config/settings.js';
import {
  DaemonChannelBridge,
  sanitizeLogText,
  SessionRouter,
} from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBase,
  DaemonChannelSessionClient,
  DaemonChannelSessionFactory,
  DaemonChannelSessionFactoryRequest,
} from '@qwen-code/channel-base';
import type { ServeChannelSelection } from '../../serve/types.js';
import { normalizeServeChannelSelection } from '../../serve/channel-selection.js';
import {
  CHANNEL_DAEMON_WORKER_SENTINEL,
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_DAEMON_WORKSPACE_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { resolveProxy } from './proxy.js';
import {
  createChannel,
  loadChannelsConfig,
  loadChannelsFromExtensions,
  parseConfiguredChannels,
  registerSessionCleanup,
  registerToolCallDispatch,
  type ParsedChannel,
} from './runtime.js';

const SESSION_SHELL_COMMAND_FEATURE = 'session_shell_command';

interface DaemonCapabilitiesLike {
  features: string[];
  workspaceCwd?: string;
}

interface DaemonClientLike {
  capabilities(): Promise<DaemonCapabilitiesLike>;
}

interface DaemonSessionClientStaticLike {
  createOrAttach(
    client: DaemonClientLike,
    req: {
      workspaceCwd: string;
      modelServiceId?: string;
      sessionScope: 'thread';
    },
    clientId?: string,
  ): Promise<DaemonChannelSessionClient>;
  load(
    client: DaemonClientLike,
    sessionId: string,
    req: {
      workspaceCwd: string;
      modelServiceId?: string;
      sessionScope: 'thread';
    },
    clientId?: string,
  ): Promise<DaemonChannelSessionClient>;
}

interface DaemonSdkLike {
  DaemonClient: new (opts: {
    baseUrl: string;
    token?: string;
  }) => DaemonClientLike;
  DaemonSessionClient: DaemonSessionClientStaticLike;
}

interface ChannelDaemonWorkerReady {
  pid: number;
  channels: string[];
}

export interface ChannelDaemonWorkerHandle {
  readonly channels: string[];
  close(): Promise<void>;
}

export interface RunChannelDaemonWorkerOptions {
  daemonUrl: string;
  daemonToken?: string;
  workspace: string;
  selection: ServeChannelSelection;
  loadDaemonSdk?: () => Promise<DaemonSdkLike>;
  sendReady?: (ready: ChannelDaemonWorkerReady) => void;
}

export function createDaemonSessionFactory({
  client,
  DaemonSessionClient,
  clientId,
}: {
  client: DaemonClientLike;
  DaemonSessionClient: DaemonSessionClientStaticLike;
  clientId: string;
}): DaemonChannelSessionFactory {
  return async (
    req: DaemonChannelSessionFactoryRequest,
  ): Promise<DaemonChannelSessionClient> => {
    const daemonReq = {
      workspaceCwd: req.workspaceCwd,
      ...(req.modelServiceId ? { modelServiceId: req.modelServiceId } : {}),
      // Channel-level user/thread/single routing stays in SessionRouter; daemon
      // sessions remain thread-scoped so different channels never share the
      // daemon's default single session.
      sessionScope: 'thread' as const,
    };
    if (req.sessionId) {
      return await DaemonSessionClient.load(
        client,
        req.sessionId,
        daemonReq,
        clientId,
      );
    }
    return await DaemonSessionClient.createOrAttach(
      client,
      daemonReq,
      clientId,
    );
  };
}

export function createDaemonChannelBridgeFacade(
  bridge: ChannelAgentBridge,
  opts: { exposeShellCommand: boolean },
): ChannelAgentBridge {
  const facade: ChannelAgentBridge = {
    get availableCommands() {
      return bridge.availableCommands;
    },
    on: bridge.on.bind(bridge),
    off: bridge.off.bind(bridge),
    newSession: bridge.newSession.bind(bridge),
    loadSession: bridge.loadSession.bind(bridge),
    prompt: bridge.prompt.bind(bridge),
    cancelSession: bridge.cancelSession.bind(bridge),
  };

  if (bridge.getAvailableCommands) {
    facade.getAvailableCommands = bridge.getAvailableCommands.bind(bridge);
  }

  if (opts.exposeShellCommand && bridge.shellCommand) {
    facade.shellCommand = bridge.shellCommand.bind(bridge);
  }

  return facade;
}

async function loadDaemonSdk(): Promise<DaemonSdkLike> {
  return (await import('@qwen-code/sdk/daemon')) as unknown as DaemonSdkLike;
}

function selectedChannelNames(
  channelsConfig: Record<string, unknown>,
  selection: ServeChannelSelection,
): string[] {
  const names =
    selection.mode === 'all' ? Object.keys(channelsConfig) : selection.names;
  if (names.length === 0) {
    throw new Error('No channels configured in settings.json.');
  }
  for (const name of names) {
    if (!channelsConfig[name]) {
      throw new Error(`Channel "${name}" not found in settings.`);
    }
  }
  return names;
}

function firstModel(parsed: ParsedChannel[]): string | undefined {
  const models = [
    ...new Set(parsed.map((p) => p.config.model).filter(Boolean)),
  ] as string[];
  if (models.length > 1) {
    writeStderrLine(
      `[Channel] Warning: Multiple models configured (${models.join(', ')}). ` +
        `Daemon worker will use "${models[0]}".`,
    );
  }
  return models[0];
}

function validateChannelWorkspaces(
  parsed: ParsedChannel[],
  daemonWorkspace: string,
): void {
  for (const { name, config } of parsed) {
    const channelWorkspace = canonicalizeWorkspace(config.cwd);
    if (channelWorkspace !== daemonWorkspace) {
      throw new Error(
        `Channel "${name}" cwd "${channelWorkspace}" must use daemon workspace "${daemonWorkspace}".`,
      );
    }
  }
}

export async function runChannelDaemonWorker(
  opts: RunChannelDaemonWorkerOptions,
): Promise<ChannelDaemonWorkerHandle> {
  const sdk = await (opts.loadDaemonSdk ?? loadDaemonSdk)();
  const client = new sdk.DaemonClient({
    baseUrl: opts.daemonUrl,
    ...(opts.daemonToken ? { token: opts.daemonToken } : {}),
  });
  const capabilities = await client.capabilities();
  const daemonWorkspace = canonicalizeWorkspace(
    capabilities.workspaceCwd ?? opts.workspace,
  );
  const requestedWorkspace = canonicalizeWorkspace(opts.workspace);
  if (requestedWorkspace !== daemonWorkspace) {
    throw new Error(
      `Daemon workspace "${daemonWorkspace}" does not match worker workspace "${requestedWorkspace}".`,
    );
  }

  await loadChannelsFromExtensions();
  const settings = loadSettings(daemonWorkspace);
  const proxy = resolveProxy(
    undefined,
    settings.merged.proxy as string | undefined,
  );
  const channelsConfig = loadChannelsConfig(daemonWorkspace);
  const names = selectedChannelNames(channelsConfig, opts.selection);
  const parsed = await parseConfiguredChannels(channelsConfig, names, {
    defaultCwd: daemonWorkspace,
  });
  validateChannelWorkspaces(parsed, daemonWorkspace);
  const modelServiceId = firstModel(parsed);

  const bridge = new DaemonChannelBridge({
    cwd: daemonWorkspace,
    sessionFactory: createDaemonSessionFactory({
      client,
      DaemonSessionClient: sdk.DaemonSessionClient,
      clientId: `qwen-channel-worker:${process.pid}`,
    }),
    ...(modelServiceId ? { modelServiceId } : {}),
  });
  await bridge.start();

  const channels = new Map<string, ChannelBase>();
  const connected: string[] = [];
  const disconnectAll = () => {
    for (const channel of channels.values()) {
      try {
        channel.disconnect();
      } catch {
        // best-effort
      }
    }
  };

  try {
    const bridgeFacade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: capabilities.features.includes(
        SESSION_SHELL_COMMAND_FEATURE,
      ),
    });
    const router = new SessionRouter(
      bridgeFacade,
      daemonWorkspace,
      'user',
      undefined,
    );
    for (const { name, config } of parsed) {
      router.setChannelScope(name, config.sessionScope);
    }

    for (const { name, config } of parsed) {
      channels.set(
        name,
        await createChannel(name, config, bridgeFacade, {
          ...(proxy ? { proxy } : {}),
          router,
        }),
      );
    }
    registerToolCallDispatch(bridgeFacade, router, channels);
    registerSessionCleanup(bridgeFacade, router, channels);

    for (const [name, channel] of channels) {
      try {
        await channel.connect();
        connected.push(name);
        const safeName = sanitizeLogText(name, 128);
        writeStdoutLine(`[Channel] "${safeName}" connected.`);
      } catch (err) {
        const safeName = sanitizeLogText(name, 128);
        const safeMessage = sanitizeLogText(
          err instanceof Error ? err.message : String(err),
          512,
        );
        writeStderrLine(
          `[Channel] Failed to connect "${safeName}": ${safeMessage}`,
        );
        try {
          channel.disconnect();
        } catch {
          // best-effort
        }
      }
    }

    if (connected.length === 0) {
      throw new Error('No channels connected.');
    }

    opts.sendReady?.({ channels: connected, pid: process.pid });

    return {
      channels: connected,
      async close() {
        disconnectAll();
        bridge.stop();
        router.clearAll();
      },
    };
  } catch (err) {
    disconnectAll();
    bridge.stop();
    throw err;
  }
}

interface DaemonWorkerArgs {
  channel?: string[];
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export const daemonWorkerCommand: CommandModule<unknown, DaemonWorkerArgs> = {
  command: 'daemon-worker',
  describe: false,
  builder: (yargs) =>
    yargs.option('channel', {
      type: 'string',
      array: true,
      description: 'Internal daemon-managed channel selection.',
    }),
  handler: async (argv) => {
    try {
      if (process.env[CHANNEL_DAEMON_WORKER_SENTINEL] !== '1') {
        throw new Error('daemon-worker is an internal qwen serve command.');
      }
      const daemonToken = process.env[QWEN_DAEMON_TOKEN_ENV];
      delete process.env[QWEN_DAEMON_TOKEN_ENV];
      delete process.env[QWEN_SERVER_TOKEN_ENV];
      const selection = normalizeServeChannelSelection(argv.channel);
      if (!selection) {
        throw new Error('--channel is required.');
      }
      const handle = await runChannelDaemonWorker({
        daemonUrl: readRequiredEnv(QWEN_DAEMON_URL_ENV),
        daemonToken,
        workspace: readRequiredEnv(QWEN_DAEMON_WORKSPACE_ENV),
        selection,
        sendReady: (ready) => {
          process.send?.({ type: 'ready', ...ready });
        },
      });

      let shuttingDown = false;
      const shutdown = async (reason: NodeJS.Signals | 'disconnect') => {
        if (shuttingDown) {
          process.exit(1);
        }
        shuttingDown = true;
        try {
          await handle.close();
          process.exit(0);
        } catch (err) {
          const safeReason = sanitizeLogText(reason, 128);
          const safeMessage = sanitizeLogText(
            err instanceof Error ? err.message : String(err),
            512,
          );
          writeStderrLine(
            `[Channel] daemon worker failed to shut down after ${safeReason}: ${safeMessage}`,
          );
          process.exit(1);
        }
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.once('disconnect', () => {
        void shutdown('disconnect');
      });
    } catch (err) {
      const safeMessage = sanitizeLogText(
        err instanceof Error ? err.message : String(err),
        512,
      );
      writeStderrLine(`[Channel] daemon worker failed: ${safeMessage}`);
      process.exit(1);
    }

    await new Promise<void>(() => {});
  },
};
