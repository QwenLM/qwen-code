import type { CommandModule } from 'yargs';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import {
  CHANNEL_WORKER_KILL_GRACE_MS,
  CHANNEL_WORKER_STOP_GRACE_MS,
} from '@qwen-code/acp-bridge/channelControlTimeouts';
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
import { resolveLanguage, resolveLanguageSetting } from '../../i18n/index.js';
import { scrubAndReportInheritedLoaderEnv } from '../../config/shared-env-keys.js';
import {
  BoundSessionGoneError,
  BoundSessionQueueFullError,
  BoundSessionUnavailableError,
  CHANNEL_PROMPT_AUTHORIZATION_META_KEY,
  CHANNEL_PROMPT_META_KEY,
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
  ChannelBoundSessions,
  ChannelLoopRunner,
  ChannelWebhookRunOptions,
  ChannelWebhookTask,
  DaemonChannelLoopMcpHost,
  DaemonChannelSessionClient,
  DaemonChannelSessionFactory,
  DaemonChannelSessionFactoryRequest,
  PrBindingsSnapshot,
  PrBindingSummary,
} from '@qwen-code/channel-base';
import type { ServeFeature } from '../../serve/capabilities.js';
import type { ServeChannelSelection } from '../../serve/types.js';
import { normalizeServeChannelSelection } from '../../serve/channel-selection.js';
import {
  CHANNEL_DAEMON_WORKER_SENTINEL,
  CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS,
  MANAGED_RUNTIME_BROKER_TOKEN_ENV,
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_DAEMON_WORKSPACE_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';
import { EXTERNAL_TOOL_GUARD_TOKEN_ENV } from '@qwen-code/acp-bridge/externalToolGuard';
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
} from '../../runtime/channel-delivery-ipc.js';
import { sanitizeWorkerDiagnostic } from '../../serve/channel-worker-diagnostics.js';
import { CHANNEL_BOUND_RELAY_META_KEY } from '../../serve/channel-worker-prompt-authorization.js';
import {
  isChannelStartupReportAckMessage,
  MAX_CHANNEL_STARTUP_FAILURES,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
  type ChannelStartupReportMessage,
} from '../../serve/channel-worker-startup-ipc.js';
import { isLoopbackBind } from '../../serve/loopback-binds.js';
import { isOwnInterfaceAddress } from '../../serve/local-bind-addresses.js';
import { ChannelLoopMcpWorkerHost } from '../../serve/channel-loop-mcp-ipc.js';
import {
  writeStderrLine,
  writeStderrLineSafe,
  writeStdoutLine,
} from '../../utils/stdioHelpers.js';
import { resolveProxyUrl } from './proxy.js';
import {
  createChannel,
  daemonChannelLoopPath,
  daemonChannelStateDir,
  daemonObservedContactsPath,
  daemonSessionRoutesPath,
  loadChannelsConfig,
  loadChannelsFromExtensions,
  parseConfiguredChannels,
  registerBackgroundResponseRelay,
  registerPermissionRelay,
  registerSessionCleanup,
  registerToolCallDispatch,
  resolveChannelLocale,
  selectFirstModel,
  type ParsedChannel,
} from './runtime.js';
import { BridgeChannelMemoryIntentClassifier } from './memory-intent-classifier.js';
import {
  OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS,
  ObservedChannelContactStore,
} from './observed-contact-store.js';
import {
  createChannelLoopController,
  isChannelCronEnabled,
} from './loop-runtime.js';
import { disconnectChannels } from './disconnect-channels.js';

// Typed against the registry so renaming a capability key fails the build here
// instead of silently degrading the worker to the pre-capability behavior.
const SESSION_SHELL_COMMAND_FEATURE: ServeFeature = 'session_shell_command';
const SESSION_ATTACHMENTS_FEATURE: ServeFeature = 'session_attachments';
const SESSION_BTW_FEATURE: ServeFeature = 'session_btw';
const SESSION_PERMISSION_VOTE_FEATURE: ServeFeature = 'session_permission_vote';
const SESSION_WORKTREE_PERSISTENCE_FEATURE: ServeFeature =
  'session_worktree_persistence_v1';
const SESSION_WORKTREE_RESET_FEATURE: ServeFeature =
  'session_worktree_reset_v1';
const MAX_ACTIVE_WEBHOOK_TASKS = 16;
const WORKER_CHANNEL_DISCONNECT_DRAIN_MS =
  CHANNEL_WORKER_STOP_GRACE_MS - CHANNEL_WORKER_KILL_GRACE_MS;
const WORKER_STARTUP_ROLLBACK_DRAIN_MS = 1_500;

async function disconnectWorkerChannels(
  channels: Iterable<ChannelBase>,
  timeoutMs = WORKER_CHANNEL_DISCONNECT_DRAIN_MS,
): Promise<void> {
  await disconnectChannels(channels, {
    timeoutMs,
    onTimeout: () => {
      writeStderrLineSafe(
        `[Channel] disconnect drain exceeded ${timeoutMs}ms; continuing worker shutdown.`,
      );
    },
  });
}

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
  requestRest(path: string, init?: RequestInit): Promise<Response>;
  workspaceByCwd?(cwd: string): {
    deleteSessionsData(sessionIds: string[]): Promise<{
      removed: string[];
      notFound: string[];
      errors: Array<{ sessionId: string; error: string }>;
    }>;
  };
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
      worktree?: Record<string, never>;
    },
    clientId?: string,
  ): Promise<DaemonChannelSessionClient>;
  resume(
    client: DaemonClientLike,
    sessionId: string,
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
  // The reset route registers no client for the caller, so unlike `create`
  // and `resume` this takes no client id.
  resetWorktree(
    client: DaemonClientLike,
    sessionId: string,
    req: {
      workspaceCwd: string;
      modelServiceId?: string;
      sessionScope: 'thread';
      approvalMode?: string;
      sourceType?: string;
      sourceId?: string;
    },
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
  close(disconnectDrainMs?: number): Promise<void>;
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
  channelLoopMcpHost?: DaemonChannelLoopMcpHost;
  promptAuthorization?: string;
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
      sourceType: 'channel',
      // sourceId = channel instance name (e.g. feishu-main): distinguishes
      // channel instances on the daemon data plane; the channel kind
      // (dingtalk/feishu) is derivable from the name via the channel config.
      ...(req.sourceId ? { sourceId: req.sourceId } : {}),
    };
    if (req.worktreeReset) {
      return await DaemonSessionClient.resetWorktree(
        client,
        req.worktreeReset.sessionId,
        daemonReq,
      );
    }
    if (req.sessionId) {
      return await DaemonSessionClient.resume(
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
        ...(req.worktree ? { worktree: req.worktree } : {}),
      },
      clientId,
    );
  };
}

/**
 * Upper bound on the accessor's session→cwd wake cache. Complete snapshots
 * rebuild it and Gone verdicts evict entries, but a permanent partial never
 * clears it; the cap bounds churn-driven growth during such a window.
 */
const MAX_WAKE_CWD_CACHE = 1024;

/**
 * Daemon-backed delivery into PR-bound sessions the channel does not own.
 * Acceptance into the session's prompt queue counts as delivery; the turn
 * itself runs independently of the channel worker.
 *
 * `wake` restores a dormant (persisted but not live) session, which the
 * prompt route rejects with 404, and returns a release callback for the
 * client registration the restore minted. The accessor invokes that
 * release once the retried prompt settles: a non-empty client registration
 * blocks the daemon's prompt-settled idle close, so discarding it without
 * detaching would pin the woken session live until the TTL reaper.
 *
 * Error classification: a 404 (session or workspace truly gone) becomes
 * `BoundSessionGoneError` so the adapter falls back to the channel path —
 * except a 404 on the retry AFTER a successful wake, which is reversible
 * backpressure (the owner may have begun draining) and defers one cycle;
 * queue-full and temporarily-unavailable conditions (503, 429, other 5xx,
 * restore conflicts, session limits, draining workspaces) are backpressure
 * that defers the event without consuming the failure budget; everything
 * else propagates as a transient delivery error for the adapter to retry.
 *
 * Every POST carries the caller's idempotency key (a stable event identity
 * derived from the source chat and message id) and the bound-relay marker:
 * the daemon deduplicates repeated admissions of the same key (a lost
 * acceptance mark or a lost 202 must not re-inject the event), and
 * cross-workspace channel classification requires the marker in addition to
 * the worker token.
 */
export function createBoundSessionsAccessor(
  client: DaemonClientLike,
  wake?: (
    sessionId: string,
    workspaceCwd: string,
  ) => Promise<(() => Promise<void>) | undefined>,
  promptAuthorization?: string,
): ChannelBoundSessions {
  const cwdBySession = new Map<string, string>();
  // requestRest's timer covers the connection through response headers
  // only; the signal also bounds body consumption so a half-open connection
  // cannot hang the poll loop indefinitely.
  const requestSignal = (): AbortSignal => AbortSignal.timeout(30_000);
  const discardBody = (res: Response): Promise<void> =>
    res.body?.cancel().catch(() => {}) ?? Promise.resolve();
  const postPrompt = (
    sessionId: string,
    prompt: string,
    idempotencyKey?: string,
  ): Promise<Response> =>
    client.requestRest(`/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestSignal(),
      // Same classification the channel bridge rides: without the marker
      // and worker authorization the daemon treats the relay as an
      // interactive user prompt (loop-detected rejection instead of the
      // graceful channel end-turn, and live PR-binding backfill on relayed
      // external text). Admission strips the marker for unauthorized
      // callers, so both keys must ride together. The bound-relay marker
      // additionally scopes the process-level worker credential to its
      // reason: cross-workspace channel classification requires it.
      body: JSON.stringify({
        prompt: [{ type: 'text', text: prompt }],
        // The durable task id: the daemon deduplicates repeated admissions
        // of the same key, so a retry after a lost acceptance mark or a
        // lost 202 response does not re-inject the event.
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          [CHANNEL_BOUND_RELAY_META_KEY]: true,
          ...(promptAuthorization
            ? { [CHANNEL_PROMPT_AUTHORIZATION_META_KEY]: promptAuthorization }
            : {}),
        },
      }),
    });
  const listPrBindings = async (): Promise<PrBindingsSnapshot> => {
    const res = await client.requestRest('/sessions/pr-bindings', {
      signal: requestSignal(),
    });
    if (!res.ok) {
      await discardBody(res);
      throw new Error(`GET /sessions/pr-bindings failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      bindings?: unknown;
      partial?: unknown;
    };
    let partial = body.partial === true;
    // A malformed 200 is not an authoritative empty snapshot: throwing
    // routes it into the adapter's fail-closed refresh handling (keep the
    // previous map, skip the watch pass) instead of wiping watch state.
    if (!Array.isArray(body.bindings)) {
      throw new Error(
        'GET /sessions/pr-bindings returned malformed bindings (HTTP 200)',
      );
    }
    const summaries: PrBindingSummary[] = [];
    // Rebuild (not accumulate) on complete answers so sessions that left
    // the bindings drop out of the wake cache. On a partial answer keep
    // the known cwds: an incomplete enumeration must not turn a queued
    // dormant delivery into a gone-session public fallback.
    if (!partial) cwdBySession.clear();
    for (const entry of body.bindings) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const { sessionId, workspaceCwd, prs } = record;
      if (
        typeof sessionId !== 'string' ||
        typeof workspaceCwd !== 'string' ||
        !Array.isArray(prs)
      ) {
        continue;
      }
      const entries: PrBindingSummary['prs'] = [];
      for (const pr of prs) {
        if (pr === null || typeof pr !== 'object') continue;
        const { number, url, state } = pr as Record<string, unknown>;
        if (
          typeof number !== 'number' ||
          !Number.isSafeInteger(number) ||
          number <= 0 ||
          typeof url !== 'string'
        ) {
          continue;
        }
        entries.push({
          number,
          url,
          ...(state === 'open' || state === 'merged' || state === 'closed'
            ? { state }
            : {}),
        });
      }
      if (entries.length === 0 && prs.length > 0) {
        // A listed session whose PR entries ALL failed shape validation is
        // a degraded answer, not an unbind: flag it so the adapter retains
        // known bindings instead of trusting an empty projection.
        partial = true;
        continue;
      }
      // An empty prs row is a TOMBSTONE and must pass through: the adapter
      // keys retention on the listed session set, so "scanned, no bindings"
      // (an observed unbind) has to reach it even on a partial answer.
      const { sourceType, updatedAt } = record;
      // Bounded: under a permanent partial the cache is never cleared, so
      // session churn during the partial window must not grow it without
      // limit. FIFO eviction only drops the oldest wake hints; a dropped
      // entry is re-fetched from the bindings route on the next 404.
      if (
        cwdBySession.size >= MAX_WAKE_CWD_CACHE &&
        !cwdBySession.has(sessionId)
      ) {
        const oldest = cwdBySession.keys().next().value;
        if (oldest !== undefined) cwdBySession.delete(oldest);
      }
      cwdBySession.set(sessionId, workspaceCwd);
      summaries.push({
        sessionId,
        workspaceCwd,
        ...(typeof sourceType === 'string' ? { sourceType } : {}),
        ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
        prs: entries,
      });
    }
    return { bindings: summaries, partial };
  };
  return {
    listPrBindings,
    deliverPrompt: async (sessionId, prompt, idempotencyKey) => {
      let res = await postPrompt(sessionId, prompt, idempotencyKey);
      let releaseWake: (() => Promise<void>) | undefined;
      let wokeSession = false;
      try {
        if (res.status === 404 && wake) {
          // Dormant session: the bindings route lists persisted active
          // sessions, but the prompt route only serves live ones. Wake it
          // and retry once. A refresh failure here is transient and must
          // propagate, not degrade into a gone-session public fallback.
          let cwd = cwdBySession.get(sessionId);
          if (cwd === undefined) {
            const snapshot = await listPrBindings();
            cwd = cwdBySession.get(sessionId);
            if (cwd === undefined && snapshot.partial) {
              // Cold cache meets an incomplete enumeration: absence from a
              // partial snapshot is not evidence of deletion. Defer to the
              // adapter's backpressure retry instead of the public
              // gone-session fallback — and instead of the failure budget,
              // which a generic Error would consume (the message promises
              // deferral; the class must match).
              throw new BoundSessionUnavailableError(
                sessionId,
                'absent from a partial bindings snapshot; deferring delivery',
              );
            }
          }
          if (cwd !== undefined) {
            releaseWake = await wake(sessionId, cwd);
            wokeSession = true;
            await discardBody(res);
            // Same idempotency key: the first POST was a 404 (never
            // admitted), and a response-loss retry must dedupe too.
            res = await postPrompt(sessionId, prompt, idempotencyKey);
          }
        }
        if (res.status === 404) {
          if (wokeSession) {
            // A 404 AFTER a successful wake is more likely a reversible
            // lifecycle transition — the owning workspace began draining
            // between the resume and this retry, and the prompt route answers
            // this same 404 for a non-active owner — than permanent deletion.
            // Defer one cycle: the next wake's resume reports a permanent
            // 404/409 if the session is truly gone, so the fallback is only
            // delayed, never lost to the failure budget.
            throw new BoundSessionUnavailableError(
              sessionId,
              'post-wake retry 404 (reversible lifecycle state)',
            );
          }
          throw new BoundSessionGoneError(sessionId);
        }
        if (res.status === 503) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: unknown;
          };
          if (body.code === 'prompt_queue_full') {
            throw new BoundSessionQueueFullError(sessionId);
          }
          // Every other 503 (workspace draining/restarting, session limit,
          // runtime starting) is a retry-later condition — the daemon even
          // sends Retry-After. Burning the attempt budget on these
          // steady states would silently lose the event after three polls.
          throw new BoundSessionUnavailableError(
            sessionId,
            `HTTP 503 (${String(body.code)})`,
          );
        }
        if (res.status === 409) {
          const body = (await res.json().catch(() => ({}))) as {
            code?: unknown;
          };
          if (
            body.code === 'session_archived' ||
            body.code === 'worktree_session_superseded'
          ) {
            // Permanent states: an archived or superseded session is never
            // restored (same classification as the wake path). Fall back to
            // the channel path rather than burning the failure budget.
            throw new BoundSessionGoneError(sessionId);
          }
          if (
            body.code === 'restore_in_progress' ||
            body.code === 'session_busy' ||
            body.code === 'worktree_reset_active'
          ) {
            // Reversible barriers: a restore in flight, a busy session, or
            // an armed worktree-reset prompt barrier (the reset flow tells
            // channel-worker callers to retry). Defer, don't burn the budget.
            throw new BoundSessionUnavailableError(
              sessionId,
              `HTTP 409 (${String(body.code)})`,
            );
          }
          throw new Error(
            `POST /session/:id/prompt failed: HTTP 409 (${String(body.code)})`,
          );
        }
        if (res.status === 429 || res.status >= 500) {
          // The daemon's own rate limiter answers 429 rate_limit_exceeded
          // (prompt tier, keyed on the worker's client id — one bucket for
          // every bound delivery of the channel), and other 5xx are daemon
          // transient states. Both are daemon-signalled backpressure: like
          // the sibling 503s they must defer, not consume the failure budget
          // (three consecutive 429s would otherwise dead-letter a watch
          // event irrecoverably). The retries themselves keep the bucket
          // saturated, so the deferral horizon is the escape.
          throw new BoundSessionUnavailableError(
            sessionId,
            `HTTP ${res.status} (daemon backpressure)`,
          );
        }
        if (!res.ok) {
          throw new Error(
            `POST /session/:id/prompt failed: HTTP ${res.status}`,
          );
        }
      } catch (err) {
        // An authoritative Gone is durable evidence: evict the dead session's
        // cached cwd so a permanent partial snapshot cannot make every later
        // delivery pay a doomed resume round-trip (and the map grow without
        // bound). A post-wake retry 404 is NOT Gone (it classifies as
        // Unavailable), so a possibly-reversible lifecycle state never
        // evicts a live session's wake cwd.
        if (err instanceof BoundSessionGoneError) {
          cwdBySession.delete(sessionId);
        }
        throw err;
      } finally {
        // Never leave a response body unconsumed: an unread undici body
        // holds its connection until GC, leaking sockets in this
        // long-lived worker on every delivery, probe and failure.
        await discardBody(res);
        // Release the wake registration once the retried prompt settled
        // (accepted or not). Detaching before the retry could close the
        // session ahead of the POST and misclassify the 404 as gone.
        if (releaseWake) {
          await releaseWake().catch(() => {});
        }
      }
    },
  };
}

export function createDaemonChannelBridgeFacade(
  bridge: ChannelAgentBridge,
  opts: { exposeBtw: boolean; exposeShellCommand: boolean },
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

  if (opts.exposeBtw && bridge.btw) {
    facade.btw = bridge.btw.bind(bridge);
  }

  if (bridge.respondToPermission) {
    facade.respondToPermission = bridge.respondToPermission.bind(bridge);
  }

  if (bridge.discardSession) {
    facade.discardSession = bridge.discardSession.bind(bridge);
  }

  if (bridge.deleteSessionData) {
    facade.deleteSessionData = bridge.deleteSessionData.bind(bridge);
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

  if (bridge.resetWorktreeSession) {
    facade.resetWorktreeSession = bridge.resetWorktreeSession.bind(bridge);
  }

  if (bridge.registerChannelLoopToolHandler) {
    facade.registerChannelLoopToolHandler =
      bridge.registerChannelLoopToolHandler.bind(bridge);
  }

  if (bridge.registerChannelTool) {
    facade.registerChannelTool = bridge.registerChannelTool.bind(bridge);
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
  // A daemon bound to a concrete interface (`--hostname 192.168.1.100`)
  // listens on that socket ONLY — loopback is not bound, so rewriting the
  // URL to `127.0.0.1` would trade this rejection for `ECONNREFUSED`. The
  // worker dials the bound address itself, and an own-interface address
  // keeps the daemon token on this host exactly as loopback does, which is
  // the property this rule protects; anything else (a routable third-party
  // host, a DNS name we would have to resolve to find out) stays refused.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `${QWEN_DAEMON_URL_ENV} must use an http(s) loopback URL or a ` +
        `literal address of one of this machine's interfaces.`,
    );
  }
  if (isLoopbackBind(parsed.hostname)) return;
  if (!isOwnInterfaceAddress(parsed.hostname)) {
    throw new Error(
      `${QWEN_DAEMON_URL_ENV} must use an http(s) loopback URL or a ` +
        `literal address of one of this machine's interfaces.`,
    );
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
  const locale = resolveChannelLocale(settings.merged.general?.language);
  const displayLanguage = resolveLanguage(
    resolveLanguageSetting(
      settings.merged.general?.language as string | undefined,
    ),
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
  if (loopStore) {
    const multiSessionChannels = new Set(
      parsed
        .filter(({ config }) => config.multiSession)
        .map(({ name }) => name),
    );
    if (multiSessionChannels.size > 0) {
      const loops = await abortableStartup(loopStore.list(), startupSignal);
      const conflicting = loops.find(
        (loop) => loop.enabled && multiSessionChannels.has(loop.channelName),
      );
      if (conflicting) {
        throw new Error(
          `Channel "${conflicting.channelName}" cannot enable multiSession while it has an enabled Channel loop. Disable the loop first.`,
        );
      }
    }
  }

  const bridge = new DaemonChannelBridge({
    cwd: daemonWorkspace,
    sessionFactory: createDaemonSessionFactory({
      client,
      DaemonSessionClient: sdk.DaemonSessionClient,
      clientId: `qwen-channel-worker:${process.pid}`,
    }),
    sessionAttachments: capabilities.features.includes(
      SESSION_ATTACHMENTS_FEATURE,
    ),
    sessionPermissionVote: capabilities.features.includes(
      SESSION_PERMISSION_VOTE_FEATURE,
    ),
    sessionWorktreePersistence: capabilities.features.includes(
      SESSION_WORKTREE_PERSISTENCE_FEATURE,
    ),
    sessionWorktreeReset: capabilities.features.includes(
      SESSION_WORKTREE_RESET_FEATURE,
    ),
    ...(opts.promptAuthorization
      ? { promptAuthorization: opts.promptAuthorization }
      : {}),
    deleteSessionData: async (sessionId) => {
      const workspaceClient = client.workspaceByCwd?.(daemonWorkspace);
      if (!workspaceClient) {
        throw new Error('Daemon SDK does not support session data deletion.');
      }
      const result = await workspaceClient.deleteSessionsData([sessionId]);
      if (
        !result.removed.includes(sessionId) &&
        !result.notFound.includes(sessionId)
      ) {
        const detail = result.errors.find(
          (entry) => entry.sessionId === sessionId,
        )?.error;
        throw new Error(detail ?? `Session ${sessionId} was not deleted.`);
      }
    },
    ...(modelServiceId ? { modelServiceId } : {}),
    ...(opts.channelLoopMcpHost
      ? { channelLoopMcpHost: opts.channelLoopMcpHost }
      : {}),
  });

  const channels = new Map<string, ChannelBase>();
  const connected: string[] = [];
  let scheduler: ChannelLoopScheduler | undefined;
  let connectFailureCount = 0;
  const diagnosticRedaction = {
    ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
    workerEnv: process.env,
  };
  let router: SessionRouter | undefined;
  try {
    await abortableStartup(bridge.start(), startupSignal);
    const bridgeFacade = createDaemonChannelBridgeFacade(bridge, {
      exposeBtw: capabilities.features.includes(SESSION_BTW_FEATURE),
      exposeShellCommand: capabilities.features.includes(
        SESSION_SHELL_COMMAND_FEATURE,
      ),
    });
    const boundSessions = createBoundSessionsAccessor(
      client,
      async (sessionId, workspaceCwd) => {
        // Same restore path the channel bridge uses for its own dormant
        // sessions. The restore mints a client registration; return its
        // release so the accessor can detach once the retried prompt
        // settles — a non-empty registration blocks the daemon's
        // prompt-settled idle close and would pin the session live until
        // the TTL reaper (or forever with the reaper disabled).
        try {
          const restored = await sdk.DaemonSessionClient.resume(
            client,
            sessionId,
            { workspaceCwd, sessionScope: 'thread' },
            `qwen-channel-worker:${process.pid}`,
          );
          return restored.detach?.bind(restored);
        } catch (err) {
          const status = (err as { status?: unknown }).status;
          const code = (err as { body?: { code?: unknown } }).body?.code;
          // A missing session (404) is gone. An archived session is not
          // restorable either (409 session_archived) and is excluded from
          // the candidate set by contract, so it takes the same fallback.
          // A superseded session (409 worktree_session_superseded) is never
          // restored again — the worktree reset severed it permanently. The
          // interrupted-worktree shapes (409 worktree_marker_missing /
          // worktree_reset_interrupted) do not converge under a RESUME retry
          // — the repair is a worktree-reset retry — so deferring them would
          // dead-letter after the horizon without ever falling back. All of
          // them are gone for delivery purposes, not retry-later backpressure.
          if (
            status === 404 ||
            (status === 409 &&
              (code === 'session_archived' ||
                code === 'worktree_session_superseded' ||
                code === 'worktree_marker_missing' ||
                code === 'worktree_reset_interrupted'))
          ) {
            throw new BoundSessionGoneError(sessionId);
          }
          // Draining/transitioning workspaces (400 workspace_mismatch,
          // 503 unavailable), restore conflicts and session limits are
          // retry-later backpressure, not delivery failures: burning the
          // attempt budget on them would silently lose the event.
          if (
            status === 503 ||
            status === 409 ||
            (status === 400 && code === 'workspace_mismatch')
          ) {
            throw new BoundSessionUnavailableError(
              sessionId,
              `wake HTTP ${String(status)} (${String(code)})`,
            );
          }
          throw err;
        }
      },
      opts.promptAuthorization,
    );
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
      createdRouter.setChannelLoopsEnabled(name, !config.multiSession);
      createdRouter.setChannelApprovalMode(name, config.approvalMode);
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
            locale,
            ...(proxy ? { proxy } : {}),
            ...(displayLanguage ? { displayLanguage } : {}),
            router: createdRouter,
            boundSessions,
            stateDir: daemonChannelStateDir(daemonWorkspace, name),
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
              list: () =>
                observedContacts.list({
                  freshWithinSeconds: OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS,
                }),
            },
            ...(loopController && !config.multiSession
              ? { loopController }
              : {}),
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
          await channel.disconnect();
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
              await loopStore.disable(job.id).catch(() => false);
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
      async close(disconnectDrainMs) {
        scheduler?.stop();
        await disconnectWorkerChannels(channels.values(), disconnectDrainMs);
        try {
          bridge.stop();
        } finally {
          createdRouter.dispose();
        }
      },
    };
  } catch (err) {
    scheduler?.stop();
    await disconnectWorkerChannels(
      channels.values(),
      WORKER_STARTUP_ROLLBACK_DRAIN_MS,
    );
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
  delete process.env[EXTERNAL_TOOL_GUARD_TOKEN_ENV];
  delete process.env[MANAGED_RUNTIME_BROKER_TOKEN_ENV];
}

function readDaemonWorkerEnv(): {
  daemonToken: string | undefined;
  daemonUrl: string;
  promptAuthorization: string;
  workspace: string;
} {
  const daemonToken = process.env[QWEN_DAEMON_TOKEN_ENV];
  try {
    return {
      daemonToken,
      daemonUrl: readRequiredEnv(QWEN_DAEMON_URL_ENV),
      promptAuthorization: readRequiredEnv(CHANNEL_DAEMON_WORKER_SENTINEL),
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
  subscribeMessage: (listener: (message: unknown) => void) => () => void = (
    listener,
  ) => {
    process.on('message', listener);
    return () => process.removeListener('message', listener);
  },
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
    let unsubscribeMessage = () => {};
    const cleanup = () => {
      unsubscribeMessage();
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
    unsubscribeMessage = subscribeMessage(onMessage);
    process.once('disconnect', onDisconnect);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      send.call(process, message, (error: Error | null) => {
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
    let channelLoopMcpHost: ChannelLoopMcpWorkerHost | undefined;
    const messageSubscribers = new Set<(message: unknown) => void>();
    let onWorkerMessage: ((message: unknown) => void) | undefined;
    const subscribeMessage = (listener: (message: unknown) => void) => {
      messageSubscribers.add(listener);
      return () => messageSubscribers.delete(listener);
    };
    const disposeChannelLoopMcpHost = () => {
      if (onWorkerMessage) {
        process.removeListener('message', onWorkerMessage);
        onWorkerMessage = undefined;
      }
      messageSubscribers.clear();
      channelLoopMcpHost?.dispose();
      channelLoopMcpHost = undefined;
    };
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
      const { daemonToken, daemonUrl, promptAuthorization, workspace } =
        readDaemonWorkerEnv();
      // Mirror the ACP-child self-scrub: in dev mode the supervisor spawns
      // this worker with the daemon's loader-carrying base env (the harness
      // tsx loader must reach this .ts entry), but nothing the worker spawns
      // may inherit them into another workspace. Production base envs are
      // scrubbed before the freeze, so this is a no-op there.
      scrubAndReportInheritedLoaderEnv(
        process.env,
        'qwen channel daemon-worker',
        'channel daemon worker',
      );
      const send = process.send!;
      channelLoopMcpHost = new ChannelLoopMcpWorkerHost((message, callback) =>
        send.call(process, message, callback ?? (() => {})),
      );
      onWorkerMessage = (message: unknown) => {
        if (channelLoopMcpHost?.handleMessage(message)) return;
        for (const subscriber of [...messageSubscribers]) {
          subscriber(message);
        }
      };
      process.on('message', onWorkerMessage);
      const selection = normalizeServeChannelSelection(argv.channel);
      if (!selection) {
        throw new Error('--channel is required.');
      }
      const handle = await runChannelDaemonWorker({
        daemonUrl,
        daemonToken,
        promptAuthorization,
        workspace,
        selection,
        startupSignal: startupAbortController.signal,
        reportStartup: (message) =>
          reportStartupToSupervisor(
            message,
            startupAbortController.signal,
            subscribeMessage,
          ),
        channelLoopMcpHost,
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
      const unsubscribeMessage = subscribeMessage(onMessage);

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
          const shutdownDeadline =
            Date.now() + WORKER_CHANNEL_DISCONNECT_DRAIN_MS;
          clearHeartbeat();
          unsubscribeMessage();
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
                  const timer = setTimeout(
                    resolve,
                    Math.max(0, shutdownDeadline - Date.now()),
                  );
                  timer.unref();
                }),
              ]);
            }
            await handle.close(Math.max(0, shutdownDeadline - Date.now()));
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
            disposeChannelLoopMcpHost();
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
      unsubscribeMessage();
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      process.removeListener('disconnect', onDisconnect);
      process.exit(exitCode);
    } catch (err) {
      removeEarlyShutdownHandlers();
      disposeChannelLoopMcpHost();
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
