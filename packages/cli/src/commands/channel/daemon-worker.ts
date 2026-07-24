import type { CommandModule } from 'yargs';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
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
  ChannelLoopScheduler,
  ChannelLoopStore,
  DaemonChannelBridge,
  isChannelProactiveDeliveryError,
  sanitizeLogText,
  SessionRouter,
} from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBase,
  ChannelLoopRunner,
  ChannelWebhookRunOptions,
  ChannelWebhookTask,
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
import {
  isChannelWebhookTaskMessage,
  type ChannelWebhookEnqueueErrorCode,
} from '../../serve/channel-webhook-ipc.js';
import {
  ChannelDeliveryError,
  isChannelDeliveryError,
  isChannelDeliveryMessage,
  MAX_CHANNEL_DELIVERIES_IN_FLIGHT,
  type ChannelDeliveryErrorCode,
  type ChannelDeliveryRequest,
} from '../../serve/channel-delivery-ipc.js';
import { sanitizeWorkerDiagnostic } from '../../serve/channel-worker-diagnostics.js';
import {
  isChannelStartupReportAckMessage,
  MAX_CHANNEL_STARTUP_FAILURES,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
  type ChannelStartupReportMessage,
} from '../../serve/channel-worker-startup-ipc.js';
import { isLoopbackBind } from '../../serve/loopback-binds.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { resolveProxyUrl } from './proxy.js';
import {
  createChannel,
  daemonChannelLoopPath,
  daemonObservedContactsPath,
  daemonSessionRoutesPath,
  loadChannelsConfig,
  loadChannelsFromExtensions,
  parseConfiguredChannels,
  registerBackgroundResponseRelay,
  registerPermissionRelay,
  registerSessionCleanup,
  registerToolCallDispatch,
  selectFirstModel,
  type ParsedChannel,
} from './runtime.js';
import { BridgeChannelMemoryIntentClassifier } from './memory-intent-classifier.js';
import { ObservedChannelContactStore } from './observed-contact-store.js';
import {
  createChannelLoopController,
  isChannelCronEnabled,
} from './loop-runtime.js';

const SESSION_SHELL_COMMAND_FEATURE = 'session_shell_command';
const MAX_ACTIVE_WEBHOOK_TASKS = 16;
const WORKER_SHUTDOWN_DRAIN_MS = 10_000;

interface DaemonCapabilitiesLike {
  features: string[];
  workspaceCwd?: string;
  /**
   * Registered runtimes advertised by a multi-workspace daemon.
   * Absent on legacy single-workspace daemons, where `workspaceCwd` is used.
   */
  workspaces?: Array<{
    cwd: string;
    id: string;
    primary: boolean;
    trusted: boolean;
  }>;
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
      approvalMode?: string;
      sourceType?: string;
      sourceId?: string;
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
      approvalMode?: string;
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
  deliverChannelMessage(request: ChannelDeliveryRequest): Promise<void>;
  validateWebhookTask(task: ChannelWebhookTask): void;
  runWebhookTask(
    task: ChannelWebhookTask,
    options?: ChannelWebhookRunOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface RunChannelDaemonWorkerOptions {
  daemonUrl: string;
  daemonToken?: string;
  workspace: string;
  selection: ServeChannelSelection;
  loadDaemonSdk?: () => Promise<DaemonSdkLike>;
  sendReady?: (ready: ChannelDaemonWorkerReady) => void;
  reportStartup?: (message: ChannelStartupReportMessage) => Promise<void>;
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
      ...(req.approvalMode ? { approvalMode: req.approvalMode } : {}),
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
      {
        ...daemonReq,
        sourceType: 'channel',
        // sourceId = channel instance name (e.g. feishu-main): distinguishes
        // channel instances on the daemon data plane; the channel kind
        // (dingtalk/feishu) is derivable from the name via the channel config.
        // The load branch above deliberately omits it: loading never re-stamps
        // creation attribution.
        ...(req.sourceId ? { sourceId: req.sourceId } : {}),
      },
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

  if (bridge.respondToPermission) {
    facade.respondToPermission = bridge.respondToPermission.bind(bridge);
  }

  if (bridge.discardSession) {
    facade.discardSession = bridge.discardSession.bind(bridge);
  }

  if (bridge.getAvailableCommands) {
    facade.getAvailableCommands = bridge.getAvailableCommands.bind(bridge);
  }

  if (opts.exposeShellCommand && bridge.shellCommand) {
    facade.shellCommand = bridge.shellCommand.bind(bridge);
  }

  if (bridge.listSessions) {
    facade.listSessions = bridge.listSessions.bind(bridge);
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

function readConnectErrorMessage(error: unknown): string {
  if (
    (typeof error === 'object' && error !== null) ||
    typeof error === 'function'
  ) {
    try {
      const message = Reflect.get(error, 'message');
      if (typeof message === 'string' && message.length > 0) {
        return message;
      }
    } catch {
      return 'Channel connection failed.';
    }
  }
  try {
    const message = String(error);
    return message.length > 0 ? message : 'Channel connection failed.';
  } catch {
    return 'Channel connection failed.';
  }
}

function readConnectErrorCode(error: unknown): string | undefined {
  if (
    !(
      (typeof error === 'object' && error !== null) ||
      typeof error === 'function'
    )
  ) {
    return undefined;
  }
  try {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string') {
      return code.trim().length > 0 ? code : undefined;
    }
    return typeof code === 'number' && Number.isFinite(code)
      ? String(code)
      : undefined;
  } catch {
    return undefined;
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
  const requestedWorkspace = canonicalizeWorkspace(opts.workspace);
  let daemonWorkspace: string;
  if (capabilities.workspaces && capabilities.workspaces.length > 1) {
    // Multi-workspace daemon: the worker must target one of the registered
    // workspaces (matched on canonical cwd), and that workspace must be trusted
    // before it can create sessions.
    const match = capabilities.workspaces.find(
      (workspace) =>
        canonicalizeWorkspace(workspace.cwd) === requestedWorkspace,
    );
    if (!match) {
      throw new Error(
        `Worker workspace "${requestedWorkspace}" is not registered on the daemon.`,
      );
    }
    if (!match.trusted) {
      throw new Error(
        `Worker workspace "${requestedWorkspace}" is not trusted; channels cannot run there.`,
      );
    }
    daemonWorkspace = requestedWorkspace;
  } else {
    // Legacy single-workspace daemon: validate against the primary workspace.
    daemonWorkspace = canonicalizeWorkspace(
      capabilities.workspaceCwd ?? opts.workspace,
    );
    if (requestedWorkspace !== daemonWorkspace) {
      throw new Error(
        `Daemon workspace "${daemonWorkspace}" does not match worker workspace "${requestedWorkspace}".`,
      );
    }
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
  const observedContacts = new ObservedChannelContactStore(
    daemonObservedContactsPath(daemonWorkspace),
  );
  const loopStore = isChannelCronEnabled(settings)
    ? new ChannelLoopStore({
        filePath: daemonChannelLoopPath(daemonWorkspace),
      })
    : undefined;
  const loopController = loopStore
    ? createChannelLoopController(loopStore)
    : undefined;

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
  let scheduler: ChannelLoopScheduler | undefined;
  let connectFailureCount = 0;
  const diagnosticRedaction = {
    ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
    workerEnv: process.env,
  };
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
      daemonSessionRoutesPath(daemonWorkspace),
      { recoveryMode: 'lazy' },
    );
    router = createdRouter;
    for (const { name, config } of parsed) {
      createdRouter.setChannelScope(name, config.sessionScope);
      if (config['webhooks']) {
        createdRouter.setChannelApprovalMode(name, config.approvalMode);
      }
    }
    const restoredRoutes = createdRouter.restoreRoutes();
    writeStdoutLine(
      `[Channel] Restored ${restoredRoutes.restored} dormant route(s)` +
        (restoredRoutes.dropped > 0
          ? `; dropped ${restoredRoutes.dropped} invalid route(s)`
          : ''),
    );

    for (const { name, config } of parsed) {
      throwIfStartupAborted(startupSignal);
      channels.set(
        name,
        await abortableStartup(
          createChannel(name, config, bridgeFacade, {
            ...(proxy ? { proxy } : {}),
            router: createdRouter,
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
              bridgeFacade,
              config.cwd,
            ),
            channelMemoryRecallObserver: recordChannelMemoryRecallMetrics,
            observedContacts: {
              observe: (channelName, observation) => {
                observedContacts.observe(channelName, observation);
              },
            },
            ...(loopController ? { loopController } : {}),
          }),
          startupSignal,
        ),
      );
    }
    registerToolCallDispatch(bridgeFacade, createdRouter, channels);
    registerBackgroundResponseRelay(bridgeFacade, createdRouter, channels);
    registerPermissionRelay(bridgeFacade, createdRouter, channels);
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
        const message = readConnectErrorMessage(err);
        const code = readConnectErrorCode(err);
        const safeMessage = sanitizeLogText(message, 512);
        writeStderrLine(
          `[Channel] Failed to connect "${safeName}": ${safeMessage}`,
        );
        try {
          channel.disconnect();
        } catch {
          // best-effort
        }
        connectFailureCount += 1;
        if (connectFailureCount <= MAX_CHANNEL_STARTUP_FAILURES) {
          const reportMessage =
            sanitizeWorkerDiagnostic(
              message,
              MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
              diagnosticRedaction,
            ) || 'Channel connection failed.';
          const reportCode = code
            ? sanitizeWorkerDiagnostic(
                code,
                MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
                diagnosticRedaction,
              )
            : undefined;
          await abortableStartup(
            opts.reportStartup?.({
              type: 'channel_startup_failure',
              failure: {
                channel:
                  sanitizeWorkerDiagnostic(
                    name,
                    MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
                    diagnosticRedaction,
                  ) || '<unnamed>',
                phase: 'connect',
                ...(reportCode ? { code: reportCode } : {}),
                message: reportMessage,
              },
            }),
            startupSignal,
          );
        } else if (connectFailureCount === MAX_CHANNEL_STARTUP_FAILURES + 1) {
          await abortableStartup(
            opts.reportStartup?.({
              type: 'channel_startup_failures_truncated',
            }),
            startupSignal,
          );
        }
      }
    }

    if (connected.length === 0) {
      throw new Error('No channels connected.');
    }

    if (loopStore) {
      const schedulerChannels = new Map<string, ChannelLoopRunner>();
      for (const name of connected) {
        const channel = channels.get(name)!;
        schedulerChannels.set(name, {
          runLoopPrompt: async (job, options) => {
            let jobWorkspace: string | undefined;
            try {
              jobWorkspace = canonicalizeWorkspace(job.cwd);
            } catch {
              jobWorkspace = undefined;
            }
            if (jobWorkspace !== daemonWorkspace) {
              await loopStore.disable(job.id);
              writeStderrLine(
                `[Channel] Disabled loop "${sanitizeLogText(job.id, 128)}": its workspace does not match this daemon worker.`,
              );
              throw new Error(
                `Loop ${sanitizeLogText(job.id, 128)} is outside daemon workspace and was disabled.`,
              );
            }
            return channel.runLoopPrompt(job, options);
          },
        });
      }
      scheduler = new ChannelLoopScheduler({
        store: loopStore,
        channels: schedulerChannels,
        nextFireTime,
      });
      scheduler.start();
    }

    opts.sendReady?.({
      channels: connected,
      requestedChannels: parsed.map((p) => p.name),
      pid: process.pid,
    });

    return {
      channels: connected,
      async deliverChannelMessage(request: ChannelDeliveryRequest) {
        const channel = channels.get(request.channelName);
        if (!channel || !connected.includes(request.channelName)) {
          throw new ChannelDeliveryError(
            'channel_worker_unavailable',
            `Channel "${request.channelName}" is not running.`,
          );
        }
        await channel.deliverProactive(
          { channelName: request.channelName, ...request.target },
          request.text,
        );
      },
      validateWebhookTask(task: ChannelWebhookTask): void {
        const channel = channels.get(task.channelName);
        if (!channel || !connected.includes(task.channelName)) {
          throw new Error(`Channel "${task.channelName}" is not running.`);
        }
        channel.validateWebhookTask(task);
      },
      async runWebhookTask(
        task: ChannelWebhookTask,
        options?: ChannelWebhookRunOptions,
      ): Promise<void> {
        const channel = channels.get(task.channelName);
        if (!channel || !connected.includes(task.channelName)) {
          throw new Error(`Channel "${task.channelName}" is not running.`);
        }
        if (options) {
          await channel.runWebhookTask(task, options);
        } else {
          await channel.runWebhookTask(task);
        }
      },
      async close() {
        scheduler?.stop();
        disconnectAll();
        try {
          bridge.stop();
        } finally {
          createdRouter.dispose();
        }
      },
    };
  } catch (err) {
    scheduler?.stop();
    disconnectAll();
    try {
      bridge.stop();
    } catch {
      // best-effort during startup rollback
    } finally {
      router?.dispose();
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

function reportStartupToSupervisor(
  message: ChannelStartupReportMessage,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(startupAbortError());
  }
  const send = process.send;
  if (!send) {
    return Promise.reject(new Error('Channel worker IPC is unavailable.'));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (value: unknown) => {
      if (isChannelStartupReportAckMessage(value)) {
        finish();
      }
    };
    const onDisconnect = () => {
      finish(new Error('Channel worker IPC disconnected during startup.'));
    };
    const onAbort = () => {
      finish(startupAbortError());
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      send.call(process, message, (error) => {
        if (error) {
          finish(new Error('Channel worker startup report failed.'));
        }
      });
    } catch {
      finish(new Error('Channel worker startup report failed.'));
    }
  });
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
        reportStartup: (message) =>
          reportStartupToSupervisor(message, startupAbortController.signal),
        sendReady: (ready) => {
          process.send?.({ type: 'ready', ...ready });
        },
      });
      removeEarlyShutdownHandlers();

      let heartbeatTimer: NodeJS.Timeout | undefined;
      const sendWebhookTaskResult = (
        id: string,
        result:
          | { ok: true }
          | {
              ok: false;
              code: ChannelWebhookEnqueueErrorCode;
              error: string;
            },
      ) => {
        try {
          process.send?.({
            type: 'webhook_task_result',
            id,
            ...result,
          });
        } catch {
          // Supervisor will time out if the IPC channel is already closed.
        }
      };
      const sendChannelDeliveryResult = (
        id: string,
        result:
          | { ok: true }
          | {
              ok: false;
              code: ChannelDeliveryErrorCode;
              error: string;
            },
      ) => {
        try {
          process.send?.({
            type: 'channel_delivery_result',
            id,
            ...result,
          });
        } catch {
          // The supervisor times out if the IPC channel is already closed.
        }
      };
      const activeWebhookTasks = new Map<string, Promise<void>>();
      const activeChannelDeliveries = new Map<string, Promise<void>>();
      const onMessage = (message: unknown) => {
        if (isChannelDeliveryMessage(message)) {
          if (message.expiresAt <= Date.now()) {
            sendChannelDeliveryResult(message.id, {
              ok: false,
              code: 'channel_delivery_timeout',
              error: 'Channel delivery IPC timed out.',
            });
            return;
          }
          if (
            activeChannelDeliveries.size >= MAX_CHANNEL_DELIVERIES_IN_FLIGHT
          ) {
            sendChannelDeliveryResult(message.id, {
              ok: false,
              code: 'channel_delivery_queue_full',
              error: 'Channel delivery queue is full.',
            });
            return;
          }
          const deliveryId = message.id;
          const delivery = handle
            .deliverChannelMessage(message.request)
            .then(() => {
              sendChannelDeliveryResult(deliveryId, { ok: true });
            })
            .catch((error: unknown) => {
              sendChannelDeliveryResult(deliveryId, {
                ok: false,
                code: classifyChannelDeliveryError(error),
                error: sanitizeWorkerDiagnostic(
                  error instanceof Error ? error.message : String(error),
                  512,
                  {
                    ...(daemonToken ? { daemonToken } : {}),
                    workerEnv: process.env,
                  },
                ),
              });
            })
            .finally(() => {
              activeChannelDeliveries.delete(deliveryId);
            });
          activeChannelDeliveries.set(deliveryId, delivery);
          return;
        }
        if (!isChannelWebhookTaskMessage(message)) return;
        if (message.expiresAt <= Date.now()) {
          sendWebhookTaskResult(message.id, {
            ok: false,
            code: 'channel_webhook_enqueue_timeout',
            error: 'Channel webhook task IPC timed out.',
          });
          return;
        }
        try {
          handle.validateWebhookTask(message.task);
        } catch (err) {
          sendWebhookTaskResult(message.id, {
            ok: false,
            code: classifyWebhookTaskValidationError(err),
            error: sanitizeLogText(
              err instanceof Error ? err.message : String(err),
              512,
            ),
          });
          return;
        }
        if (activeWebhookTasks.size >= MAX_ACTIVE_WEBHOOK_TASKS) {
          sendWebhookTaskResult(message.id, {
            ok: false,
            code: 'channel_webhook_queue_full',
            error: 'Channel webhook task queue is full.',
          });
          return;
        }
        const taskId = message.id;
        const task = message.task;
        const safeId = sanitizeLogText(taskId, 128);
        const safeChannel = sanitizeLogText(task.channelName, 128);
        const safeSource = sanitizeLogText(task.source, 128);
        sendWebhookTaskResult(message.id, { ok: true });
        const taskPromise = handle
          .runWebhookTask(task, { timeoutMs: 5 * 60_000 })
          .catch((err: unknown) => {
            const safeMessage = sanitizeLogText(
              err instanceof Error ? err.message : String(err),
              512,
            );
            writeStderrLine(
              `[Channel] webhook task failed ` +
                `(id=${safeId}, channel=${safeChannel}, source=${safeSource}): ` +
                safeMessage,
            );
          })
          .finally(() => {
            activeWebhookTasks.delete(taskId);
          });
        activeWebhookTasks.set(taskId, taskPromise);
      };
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
      process.on('message', onMessage);

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
          process.removeListener('message', onMessage);
          try {
            const deliveryCount = activeChannelDeliveries.size;
            const webhookCount = activeWebhookTasks.size;
            if (deliveryCount > 0) {
              writeStderrLine(
                `[Channel] shutdown: draining ${deliveryCount} channel delivery task(s)...`,
              );
            }
            if (webhookCount > 0) {
              writeStderrLine(
                `[Channel] shutdown: draining ${webhookCount} webhook task(s)...`,
              );
            }
            if (deliveryCount > 0 || webhookCount > 0) {
              await Promise.race([
                Promise.allSettled([
                  ...activeChannelDeliveries.values(),
                  ...activeWebhookTasks.values(),
                ]),
                new Promise<void>((resolve) => {
                  const timer = setTimeout(resolve, WORKER_SHUTDOWN_DRAIN_MS);
                  timer.unref();
                }),
              ]);
            }
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
      process.removeListener('message', onMessage);
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

function classifyWebhookTaskValidationError(
  error: unknown,
): ChannelWebhookEnqueueErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === 'Webhook tasks require unattended approval mode.' ||
    message ===
      'Webhook tasks are not supported when sessionScope is single.' ||
    message === 'Channel does not support proactive webhook messages.' ||
    message ===
      'Channel does not support proactive webhook messages for this chat target.'
  ) {
    return 'channel_webhook_target_unavailable';
  }
  if (
    message.startsWith('Unknown webhook source "') ||
    message.startsWith('Unknown webhook target "') ||
    message.startsWith('Webhook task belongs to ')
  ) {
    return 'channel_webhook_invalid_task';
  }
  if (/^Channel ".+" is not running\.$/u.test(message)) {
    return 'channel_worker_unavailable';
  }
  return 'channel_webhook_enqueue_failed';
}

function classifyChannelDeliveryError(
  error: unknown,
): ChannelDeliveryErrorCode {
  if (isChannelDeliveryError(error)) {
    return error.code;
  }
  if (
    isChannelProactiveDeliveryError(error) &&
    error.disposition === 'permanent'
  ) {
    return 'channel_delivery_rejected';
  }
  return 'channel_delivery_failed';
}
