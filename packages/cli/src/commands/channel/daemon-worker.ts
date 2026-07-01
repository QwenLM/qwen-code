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
  CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS,
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_DAEMON_WORKSPACE_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';
import { isLoopbackBind } from '../../serve/loopback-binds.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { resolveProxyUrl } from './proxy.js';
import {
  createChannel,
  loadChannelsConfig,
  loadChannelsFromExtensions,
  parseConfiguredChannels,
  registerSessionCleanup,
  registerToolCallDispatch,
  selectFirstModel,
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
  requestedChannels: string[];
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
  startupSignal?: AbortSignal;
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

function validateDaemonWorkerUrl(daemonUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(daemonUrl);
  } catch {
    throw new Error(`${QWEN_DAEMON_URL_ENV} must be a valid URL.`);
  }
  if (parsed.protocol !== 'http:' || !isLoopbackBind(parsed.hostname)) {
    throw new Error(`${QWEN_DAEMON_URL_ENV} must use an http loopback URL.`);
  }
}

function startupAbortError(): Error {
  return new Error('Daemon worker startup aborted.');
}

async function abortableStartup<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const promise = Promise.resolve(value);
  if (!signal) return await promise;
  if (signal.aborted) throw startupAbortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(startupAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function throwIfStartupAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw startupAbortError();
  }
}

export async function runChannelDaemonWorker(
  opts: RunChannelDaemonWorkerOptions,
): Promise<ChannelDaemonWorkerHandle> {
  validateDaemonWorkerUrl(opts.daemonUrl);
  const startupSignal = opts.startupSignal;
  const sdk = await abortableStartup(
    (opts.loadDaemonSdk ?? loadDaemonSdk)(),
    startupSignal,
  );
  const client = new sdk.DaemonClient({
    baseUrl: opts.daemonUrl,
    ...(opts.daemonToken ? { token: opts.daemonToken } : {}),
  });
  const capabilities = await abortableStartup(
    client.capabilities(),
    startupSignal,
  );
  const daemonWorkspace = canonicalizeWorkspace(
    capabilities.workspaceCwd ?? opts.workspace,
  );
  const requestedWorkspace = canonicalizeWorkspace(opts.workspace);
  if (requestedWorkspace !== daemonWorkspace) {
    throw new Error(
      `Daemon workspace "${daemonWorkspace}" does not match worker workspace "${requestedWorkspace}".`,
    );
  }

  await abortableStartup(loadChannelsFromExtensions(), startupSignal);
  const settings = loadSettings(daemonWorkspace, {
    skipLoadEnvironment: true,
  });
  throwIfStartupAborted(startupSignal);
  const proxy = resolveProxyUrl(
    undefined,
    settings.merged.proxy as string | undefined,
  );
  const channelsConfig = loadChannelsConfig(daemonWorkspace, settings);
  const names = selectedChannelNames(channelsConfig, opts.selection);
  const parsed = await abortableStartup(
    parseConfiguredChannels(channelsConfig, names, {
      defaultCwd: daemonWorkspace,
    }),
    startupSignal,
  );
  validateChannelWorkspaces(parsed, daemonWorkspace);
  const modelServiceId = selectFirstModel(parsed, 'Daemon worker');

  const bridge = new DaemonChannelBridge({
    cwd: daemonWorkspace,
    sessionFactory: createDaemonSessionFactory({
      client,
      DaemonSessionClient: sdk.DaemonSessionClient,
      clientId: `qwen-channel-worker:${process.pid}`,
    }),
    ...(modelServiceId ? { modelServiceId } : {}),
  });

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

  let router: SessionRouter | undefined;
  try {
    await abortableStartup(bridge.start(), startupSignal);
    const bridgeFacade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: capabilities.features.includes(
        SESSION_SHELL_COMMAND_FEATURE,
      ),
    });
    const createdRouter = new SessionRouter(
      bridgeFacade,
      daemonWorkspace,
      'user',
      undefined,
    );
    router = createdRouter;
    for (const { name, config } of parsed) {
      createdRouter.setChannelScope(name, config.sessionScope);
    }

    for (const { name, config } of parsed) {
      throwIfStartupAborted(startupSignal);
      channels.set(
        name,
        await abortableStartup(
          createChannel(name, config, bridgeFacade, {
            ...(proxy ? { proxy } : {}),
            router: createdRouter,
          }),
          startupSignal,
        ),
      );
    }
    registerToolCallDispatch(bridgeFacade, createdRouter, channels);
    registerSessionCleanup(bridgeFacade, createdRouter, channels);

    for (const [name, channel] of channels) {
      throwIfStartupAborted(startupSignal);
      const safeName = sanitizeLogText(name, 128);
      writeStdoutLine(`[Channel] Connecting "${safeName}"...`);
      try {
        await abortableStartup(channel.connect(), startupSignal);
        connected.push(name);
        writeStdoutLine(`[Channel] "${safeName}" connected.`);
      } catch (err) {
        if (startupSignal?.aborted) {
          throw err;
        }
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

    opts.sendReady?.({
      channels: connected,
      requestedChannels: parsed.map((p) => p.name),
      pid: process.pid,
    });

    return {
      channels: connected,
      async close() {
        disconnectAll();
        try {
          bridge.stop();
        } finally {
          createdRouter.clearAll();
        }
      },
    };
  } catch (err) {
    disconnectAll();
    try {
      bridge.stop();
    } catch {
      // best-effort during startup rollback
    } finally {
      router?.clearAll();
    }
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

function scrubDaemonWorkerEnv(): void {
  delete process.env[CHANNEL_DAEMON_WORKER_SENTINEL];
  delete process.env[QWEN_DAEMON_TOKEN_ENV];
  delete process.env[QWEN_DAEMON_URL_ENV];
  delete process.env[QWEN_DAEMON_WORKSPACE_ENV];
  delete process.env[QWEN_SERVER_TOKEN_ENV];
}

function readDaemonWorkerEnv(): {
  daemonToken: string | undefined;
  daemonUrl: string;
  workspace: string;
} {
  const daemonToken = process.env[QWEN_DAEMON_TOKEN_ENV];
  try {
    return {
      daemonToken,
      daemonUrl: readRequiredEnv(QWEN_DAEMON_URL_ENV),
      workspace: readRequiredEnv(QWEN_DAEMON_WORKSPACE_ENV),
    };
  } finally {
    scrubDaemonWorkerEnv();
  }
}

function assertInternalDaemonWorkerInvocation(): void {
  const sentinel = process.env[CHANNEL_DAEMON_WORKER_SENTINEL];
  if (!sentinel || sentinel === '1' || typeof process.send !== 'function') {
    scrubDaemonWorkerEnv();
    throw new Error('daemon-worker is an internal qwen serve command.');
  }
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
    const startupAbortController = new AbortController();
    let pendingShutdownReason: NodeJS.Signals | 'disconnect' | undefined;
    const onEarlyShutdown = (reason: NodeJS.Signals | 'disconnect') => {
      if (pendingShutdownReason) {
        process.exit(1);
        return;
      }
      pendingShutdownReason = reason;
      startupAbortController.abort();
    };
    const onEarlyDisconnect = () => {
      if (pendingShutdownReason) {
        process.exit(1);
        return;
      }
      pendingShutdownReason = 'disconnect';
      startupAbortController.abort();
    };
    process.on('SIGINT', onEarlyShutdown);
    process.on('SIGTERM', onEarlyShutdown);
    process.once('disconnect', onEarlyDisconnect);
    const removeEarlyShutdownHandlers = () => {
      process.removeListener('SIGINT', onEarlyShutdown);
      process.removeListener('SIGTERM', onEarlyShutdown);
      process.removeListener('disconnect', onEarlyDisconnect);
    };

    try {
      assertInternalDaemonWorkerInvocation();
      const { daemonToken, daemonUrl, workspace } = readDaemonWorkerEnv();
      const selection = normalizeServeChannelSelection(argv.channel);
      if (!selection) {
        throw new Error('--channel is required.');
      }
      const handle = await runChannelDaemonWorker({
        daemonUrl,
        daemonToken,
        workspace,
        selection,
        startupSignal: startupAbortController.signal,
        sendReady: (ready) => {
          process.send?.({ type: 'ready', ...ready });
        },
      });
      removeEarlyShutdownHandlers();

      let heartbeatTimer: NodeJS.Timeout | undefined;
      const clearHeartbeat = () => {
        if (!heartbeatTimer) return;
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      };
      heartbeatTimer = setInterval(() => {
        try {
          process.send?.({
            type: 'heartbeat',
            pid: process.pid,
            at: new Date().toISOString(),
          });
        } catch {
          clearHeartbeat();
        }
      }, CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();

      let shuttingDown = false;
      let exitCode = 0;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const shutdown = async (reason: NodeJS.Signals | 'disconnect') => {
        if (shuttingDown) {
          process.exit(1);
        } else {
          shuttingDown = true;
          clearHeartbeat();
          try {
            await handle.close();
          } catch (err) {
            exitCode = 1;
            const safeReason = sanitizeLogText(reason, 128);
            const safeMessage = sanitizeLogText(
              err instanceof Error ? err.message : String(err),
              512,
            );
            writeStderrLine(
              `[Channel] daemon worker failed to shut down after ${safeReason}: ${safeMessage}`,
            );
          } finally {
            clearHeartbeat();
            finish();
          }
        }
      };
      const onDisconnect = () => {
        void shutdown('disconnect');
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.once('disconnect', onDisconnect);
      if (pendingShutdownReason) {
        void shutdown(pendingShutdownReason);
      }
      await finished;
      clearHeartbeat();
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      process.removeListener('disconnect', onDisconnect);
      process.exit(exitCode);
    } catch (err) {
      removeEarlyShutdownHandlers();
      const safeMessage = sanitizeLogText(
        err instanceof Error ? err.message : String(err),
        512,
      );
      writeStderrLine(`[Channel] daemon worker failed: ${safeMessage}`);
      process.exit(1);
    }
  },
};
