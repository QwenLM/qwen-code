import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { channelSelectionNames } from './channel-selection.js';
import {
  ExtraCaInspectionError,
  extractCertificateBlocks,
} from './pem-certificate-blocks.js';
import type { ServeChannelSelection } from './types.js';
import {
  CHANNEL_DAEMON_WORKER_SENTINEL,
  CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS,
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_DAEMON_WORKSPACE_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from './channel-worker-env.js';
import { sanitizeLogText } from '@qwen-code/channel-base';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';
import {
  CHANNEL_WORKER_KILL_GRACE_MS,
  CHANNEL_WORKER_STARTUP_TIMEOUT_MS,
  CHANNEL_WORKER_STOP_GRACE_MS,
} from '@qwen-code/acp-bridge/channelControlTimeouts';
import { EXTERNAL_TOOL_GUARD_TOKEN_ENV } from '@qwen-code/acp-bridge/externalToolGuard';
import {
  CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS,
  ChannelWebhookEnqueueError,
  createChannelWebhookTaskMessage,
  isChannelWebhookEnqueueErrorCode,
  isChannelWebhookTaskResultMessage,
  type ChannelWebhookAccepted,
  type ChannelWebhookEnqueueErrorCode,
} from './channel-webhook-ipc.js';
import {
  CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
  ChannelDeliveryError,
  createChannelDeliveryMessage,
  isChannelDeliveryResultMessage,
  MAX_CHANNEL_DELIVERIES_IN_FLIGHT,
  type ChannelDeliveryAccepted,
  type ChannelDeliveryErrorCode,
  type ChannelDeliveryRequest,
} from '../runtime/channel-delivery-ipc.js';
import {
  createWorkerDiagnosticRedactor,
  normalizeWorkerDiagnostic,
  sanitizeWorkerDiagnostic,
  type WorkerDiagnosticRedactionOptions,
} from './channel-worker-diagnostics.js';
import {
  isChannelStartupReportMessage,
  isChannelStartupReportType,
  MAX_CHANNEL_STARTUP_FAILURES,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
  type ChannelAdapterSnapshot,
  type ChannelStartupFailure,
} from './channel-worker-startup-ipc.js';
import {
  registerChannelWorkerPromptAuthorization,
  revokeChannelWorkerPromptAuthorization,
} from './channel-worker-prompt-authorization.js';
import {
  CHANNEL_LOOP_MCP_IPC_TIMEOUT_MS,
  createChannelLoopMcpRequest,
  isChannelLoopMcpControlMessage,
  isChannelLoopMcpResultMessage,
  MAX_CHANNEL_LOOP_MCP_IN_FLIGHT,
  type ChannelLoopMcpControlMessage,
  type ChannelLoopMcpIpcSend,
} from './channel-loop-mcp-ipc.js';

const DEFAULT_CHANNEL_WORKER_HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_WORKER_LOG_LINE_LENGTH = 4096;
const MAX_WORKER_LOG_BUFFER_LENGTH = 64 * 1024;
const MAX_WORKER_LOG_DISCARDED_REMAINDER_LENGTH = MAX_WORKER_LOG_BUFFER_LENGTH;

export interface ChannelWorkerRestartPolicy {
  maxRestarts: number;
  windowMs: number;
  delaysMs: number[];
}

export class ChannelWorkerStopError extends Error {
  constructor(message = 'Channel worker did not exit after SIGKILL.') {
    super(message);
    this.name = 'ChannelWorkerStopError';
  }
}

export interface ChannelStartupAttemptFailure extends ChannelStartupFailure {
  workspaceCwd: string;
}

export class ChannelWorkerStartupError extends Error {
  readonly startupFailures: ChannelStartupAttemptFailure[];
  readonly startupFailuresTruncated: boolean;

  constructor(
    message: string,
    details: {
      workspaceCwd: string;
      startupFailures: readonly ChannelStartupFailure[];
      startupFailuresTruncated?: boolean;
    },
  ) {
    super(message);
    this.name = 'ChannelWorkerStartupError';
    this.startupFailures = details.startupFailures.map((failure) => ({
      ...failure,
      workspaceCwd: details.workspaceCwd,
    }));
    this.startupFailuresTruncated = details.startupFailuresTruncated === true;
  }
}

const DEFAULT_RESTART_POLICY: ChannelWorkerRestartPolicy = {
  maxRestarts: 3,
  windowMs: 5 * 60_000,
  delaysMs: [1_000, 5_000, 15_000],
};

export type ChannelWorkerState =
  | 'disabled'
  | 'starting'
  | 'running'
  | 'exited'
  | 'failed'
  | 'stopped';

export interface ChannelWorkerSnapshot {
  enabled: boolean;
  state: ChannelWorkerState;
  channels: string[];
  requestedChannels?: string[];
  pid?: number;
  startedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  restartCount?: number;
  lastExitAt?: string;
  lastRestartAt?: string;
  nextRestartAt?: string;
  lastHeartbeatAt?: string;
  staleHeartbeatAt?: string;
  startupFailures?: ChannelStartupFailure[];
  startupFailuresTruncated?: boolean;
  adapters?: ChannelAdapterSnapshot[];
}

export interface ChannelWorkerSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Stop the current worker (if any) and relaunch it. The relaunched worker
   * re-reads settings.json, so this is how settings changes are applied
   * without restarting the whole daemon. Rejects if the relaunch fails.
   */
  restart(): Promise<ChannelWorkerSnapshot>;
  killAllSync(): void;
  snapshot(): ChannelWorkerSnapshot;
  deliverChannelMessage?(
    request: ChannelDeliveryRequest,
  ): Promise<ChannelDeliveryAccepted>;
  enqueueWebhookTask(task: ChannelWebhookTask): Promise<ChannelWebhookAccepted>;
}

export interface ChannelWorkerChild {
  pid?: number;
  killed?: boolean;
  stdout?: WorkerLogStream;
  stderr?: WorkerLogStream;
  send?(message: unknown, callback?: (err: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  removeListener(event: 'message', listener: (message: unknown) => void): this;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'message', listener: (message: unknown) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnChannelWorker = (
  execPath: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'];
  },
) => ChannelWorkerChild;

export interface ChannelWorkerLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface WorkerLogStream {
  on(
    event: 'data',
    listener: (chunk: Buffer | string | Uint8Array) => void,
  ): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface CreateChannelWorkerSupervisorOptions {
  cliEntryPath: string;
  daemonUrl: string;
  daemonToken?: string;
  workspace: string;
  selection: ServeChannelSelection;
  /**
   * Base environment for the spawned worker. Defaults to `process.env`. In
   * multi-workspace mode the caller passes the owning runtime's effective env
   * overlay so the worker inherits that workspace's `.env` instead of the
   * daemon base env.
   */
  workerBaseEnv?: Readonly<NodeJS.ProcessEnv>;
  /**
   * PEM cert the worker must additionally trust when calling the daemon
   * over a self-signed TLS listener, injected as their `NODE_EXTRA_CA_CERTS`.
   *
   * With no operator CA set this is handed over as a PATH, and Node re-reads
   * it at every (re)spawn — while the daemon keeps serving the bytes it read
   * at boot. Rotating this file in place without restarting the daemon
   * therefore leaves respawned workers trusting the NEW contents against the
   * OLD served cert, and they restart-loop until the daemon restarts. An
   * operator CA gives no cover: `resolveWorkerCaCertPath` stamps BOTH sources,
   * so rotating this file in place invalidates the merged bundle and rebuilds
   * it from the NEW contents — the same restart loop. Either way, rotating
   * `--tls-cert` requires a daemon restart; see the HTTPS / TLS notes in
   * docs/users/qwen-serve.md.
   */
  tlsCaCertPath?: string;
  startupTimeoutMs?: number;
  spawnWorker?: SpawnChannelWorker;
  onExit?: (snapshot: ChannelWorkerSnapshot) => void;
  onReady?: (snapshot: ChannelWorkerSnapshot) => void;
  onLog?: (entry: ChannelWorkerLogEntry) => void;
  restartPolicy?: ChannelWorkerRestartPolicy;
  heartbeatTimeoutMs?: number;
  registerChannelLoopMcp?: (request: {
    sessionId: string;
    ownerId: string;
    sendMessage: (payload: unknown) => Promise<unknown>;
  }) => Promise<void>;
  unregisterChannelLoopMcp?: (
    sessionId: string,
    ownerId: string,
  ) => Promise<void>;
}

function selectionChannelArgs(selection: ServeChannelSelection): string[] {
  return channelSelectionNames(selection).flatMap((name) => [
    '--channel',
    name,
  ]);
}

function defaultSpawnWorker(
  execPath: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'];
  },
): ChannelWorkerChild {
  const child = fork(argv[0]!, argv.slice(1), {
    execPath,
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
  });
  return child as ChildProcess & ChannelWorkerChild;
}

function isReadyMessage(message: unknown): message is {
  type: 'ready';
  pid?: number;
  channels?: string[];
  requestedChannels?: string[];
} {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'ready'
  );
}

function isHeartbeatMessage(message: unknown): message is {
  type: 'heartbeat';
  pid?: number;
  at?: string;
} {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'heartbeat'
  );
}

function requestedChannelNames(
  selection: ServeChannelSelection,
): string[] | undefined {
  return selection.mode === 'names' ? [...selection.names] : undefined;
}

function workerLogRedactionOptions(
  daemonToken: string | undefined,
  workerEnv: NodeJS.ProcessEnv,
): WorkerDiagnosticRedactionOptions {
  return {
    ...(daemonToken ? { daemonToken } : {}),
    workerEnv,
  };
}

function sanitizeWorkerError(
  error: string,
  redaction?: WorkerDiagnosticRedactionOptions,
): string {
  return redaction
    ? sanitizeWorkerDiagnostic(error, 512, redaction)
    : sanitizeLogText(normalizeWorkerDiagnostic(error), 512);
}

function notifyExit(
  onExit: ((snapshot: ChannelWorkerSnapshot) => void) | undefined,
  snapshot: ChannelWorkerSnapshot,
): void {
  try {
    onExit?.(snapshot);
  } catch {
    // onExit is bookkeeping; worker exit handling must not crash the daemon.
  }
}

function notifyReady(
  onReady: ((snapshot: ChannelWorkerSnapshot) => void) | undefined,
  snapshot: ChannelWorkerSnapshot,
): void {
  try {
    onReady?.(snapshot);
  } catch {
    // onReady is bookkeeping; worker readiness must not crash the daemon.
  }
}

function notifyLog(
  onLog: ((entry: ChannelWorkerLogEntry) => void) | undefined,
  entry: ChannelWorkerLogEntry,
): void {
  try {
    onLog?.(entry);
  } catch {
    // onLog is bookkeeping; worker log forwarding must not crash the daemon.
  }
}

function waitForExit(
  child: ChannelWorkerChild,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const onExit = () => done(true);
    const done = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    child.once('exit', onExit);
  });
}

function hasObservedExit(snapshot: ChannelWorkerSnapshot): boolean {
  return snapshot.exitCode !== undefined || snapshot.signal !== undefined;
}

const NODE_EXTRA_CA_CERTS_ENV = 'NODE_EXTRA_CA_CERTS';

/**
 * Merged bundles keyed by `${operatorCaPath}\0${daemonCertPath}`. Workers are
 * respawned on every restart, so without this the daemon would mint a fresh
 * bundle directory per spawn and leak all of them.
 */
const mergedWorkerCaBundles = new Map<string, MergedWorkerCaBundle>();

interface MergedWorkerCaBundle {
  bundlePath: string;
  /** `${mtimeMs}:${size}` of each source file, in merge order. */
  sourceStamps: readonly string[];
}

function sourceStamp(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}:${stat.size}`;
}

/**
 * Path pairs already warned about, keyed the way `mergedWorkerCaBundles` is.
 * Every fallback branch returns without caching, `launch()` rebuilds the env
 * on every 'initial' and 'restart' spawn, and `process.emitWarning` does not
 * dedup identical text — so without this a crash-looping worker appends one
 * identical multi-line warning per restart, burying the very log stream the
 * operator reads to diagnose the loop.
 */
const warnedWorkerCaMergeFallbacks = new Set<string>();

/**
 * The coarse reason a merge fell back, so a CHANGED failure mode re-warns once
 * while a crash loop stays deduped. `reason` itself carries errno text and
 * would let a flapping message defeat the dedup entirely; the paths alone
 * swallowed the second, now-accurate diagnosis (`ENOENT` before a mount
 * appears, then a DER export afterwards sends the operator to fix mounts).
 */
const WORKER_CA_MERGE_FALLBACK_FAMILIES = [
  'read-error',
  'inspection-failed',
  'no-operator-blocks',
  'no-daemon-blocks',
] as const;

type WorkerCaMergeFallbackFamily =
  (typeof WORKER_CA_MERGE_FALLBACK_FAMILIES)[number];

function workerCaMergeFallbackKey(
  operatorCaPath: string,
  daemonCertPath: string,
  family: WorkerCaMergeFallbackFamily,
): string {
  return `${operatorCaPath}\0${daemonCertPath}\0${family}`;
}

function warnWorkerCaMergeFallback(
  operatorCaPath: string,
  daemonCertPath: string,
  family: WorkerCaMergeFallbackFamily,
  reason: string,
): void {
  const key = workerCaMergeFallbackKey(operatorCaPath, daemonCertPath, family);
  if (warnedWorkerCaMergeFallbacks.has(key)) return;
  warnedWorkerCaMergeFallbacks.add(key);
  // Falling back to the daemon cert alone silently drops the operator CA
  // the merge above exists to preserve, and Node says nothing when the
  // remaining cert loads fine — so say it here.
  process.emitWarning(
    `qwen: failed to merge ${NODE_EXTRA_CA_CERTS_ENV} "${operatorCaPath}" ` +
      `with the daemon cert "${daemonCertPath}": ${reason}; channel ` +
      `workers will trust only the daemon cert`,
  );
}

/**
 * Bundle directories minted this process, cleaned up together. One
 * `process.once('exit')` per mint accumulated a listener, a closure and an
 * orphaned directory per rebuild — and the merge cache is rebuilt on purpose
 * (in-place operator CA rotation, tmp-cleaner aging), so a long-lived daemon
 * crossed Node's `MaxListenersExceededWarning` threshold and printed that
 * leak warning into the very log stream `warnWorkerCaMergeFallback` dedups to
 * keep readable.
 */
const mintedWorkerCaBundleDirs = new Set<string>();
let workerCaBundleExitHookRegistered = false;

function cleanupWorkerCaBundleDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a tmp cleaner may already have taken it.
  }
}

function writeMergedWorkerCaBundle(contents: string): string {
  // mkdtempSync gives a 0700 directory with a random suffix, so the bundle
  // path cannot be pre-planted the way a fixed `qwen-worker-ca-<pid>.pem` in
  // the shared tmpdir can (CWE-377/CWE-59: a pre-planted symlink redirects
  // the write, a pre-planted regular file keeps attacker ownership and mode
  // while receiving the cert — the private key too, for a combined PEM).
  // Same defence as standalone-update.ts's extract dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-worker-ca-'));
  // Nothing else references this directory, so the daemon owns its lifetime —
  // and it owns it from the moment it exists, not from the moment the write
  // succeeds. A throw at the write (ENOSPC/EDQUOT on a size-capped tmpfs
  // /tmp: the directory entry fits, the ~2 KB body does not) lands in
  // `resolveWorkerCaCertPath`'s read-error fallback, which returns the daemon
  // cert and never unwinds this. Registering afterwards left every failing
  // respawn one more untracked 0700 directory that the exit hook — which
  // walks the registry and nothing else — could not see.
  mintedWorkerCaBundleDirs.add(dir);
  if (!workerCaBundleExitHookRegistered) {
    workerCaBundleExitHookRegistered = true;
    process.once('exit', cleanupMintedWorkerCaBundleDirs);
  }
  const bundlePath = path.join(dir, 'ca-bundle.pem');
  fs.writeFileSync(bundlePath, contents, { mode: 0o600 });
  return bundlePath;
}

/**
 * Removes every merged-bundle directory this process minted and empties the
 * registry, returning the directories it swept. This is the `exit` hook's
 * whole body, named so a test can run it: nothing else observes process exit,
 * so the registration, the sweep and the reset were all unpinned, and what it
 * swept is what makes "a superseded bundle leaves the registry" observable.
 */
export function cleanupMintedWorkerCaBundleDirs(): string[] {
  const swept = [...mintedWorkerCaBundleDirs];
  for (const minted of swept) {
    cleanupWorkerCaBundleDir(minted);
  }
  mintedWorkerCaBundleDirs.clear();
  return swept;
}

export function resolveWorkerCaCertPath(
  daemonCertPath: string,
  existing: string | undefined,
): string {
  if (!existing || existing === daemonCertPath) return daemonCertPath;
  const cacheKey = `${existing}\0${daemonCertPath}`;
  const sources = [existing, daemonCertPath];
  const cached = mergedWorkerCaBundles.get(cacheKey);
  if (cached) {
    try {
      // Two ways a hit goes stale, both ending in workers that restart-loop
      // while the daemon stays green: the operator rotates their CA file in
      // place (before this bundle existed a respawned worker read that file
      // live), and an external tmp cleaner ages out the bundle directory,
      // leaving the cache pointing at a dead path. Re-stat both ends.
      fs.statSync(cached.bundlePath);
      if (
        sources.every((src, i) => sourceStamp(src) === cached.sourceStamps[i])
      ) {
        return cached.bundlePath;
      }
    } catch {
      // Unreadable source or vanished bundle: rebuild below.
    }
    // No eviction here on purpose. Control always reaches the rebuild below,
    // which overwrites this key on success, and every future hit re-stats the
    // bundle and re-compares both stamps before returning it — so a stale
    // entry can never be handed out, and deleting it changes no observable
    // behaviour. The rebuild itself is pinned by the rotation and tmp-cleaner
    // tests.
  }
  try {
    const sourceStamps = sources.map(sourceStamp);
    // NODE_EXTRA_CA_CERTS takes a single file; merge so an operator-set CA
    // (e.g. corporate proxy) keeps working alongside the daemon cert. A
    // merely *readable* operator file is not enough — one Node's loader
    // rejects takes the daemon cert down with it, which is strictly worse
    // than the fallback below.
    const operatorBlocks = extractCertificateBlocks(
      fs.readFileSync(existing, 'utf8'),
      existing,
    );
    if (!operatorBlocks) {
      warnWorkerCaMergeFallback(
        existing,
        daemonCertPath,
        'no-operator-blocks',
        // Three causes reject a file, not one: markers, decoding, and DER.
        // Blaming markers alone tells an operator whose CA is truncated or
        // hand-edited to fix lines that are already correct — and after boot
        // this warning is the only diagnostic they get, so it has to name the
        // same three the boot-time check does.
        'it holds no PEM certificate block Node can load (every ' +
          '-----BEGIN/END CERTIFICATE----- marker must sit alone on its own ' +
          'line and every block must decode, and a DER file is never read ' +
          'at all)',
      );
      return daemonCertPath;
    }
    const daemonBlocks = extractCertificateBlocks(
      fs.readFileSync(daemonCertPath, 'utf8'),
      daemonCertPath,
    );
    if (!daemonBlocks) {
      warnWorkerCaMergeFallback(
        existing,
        daemonCertPath,
        'no-daemon-blocks',
        'the daemon cert holds no PEM certificate block to merge into',
      );
      return daemonCertPath;
    }
    const bundlePath = writeMergedWorkerCaBundle(
      `${[...operatorBlocks, ...daemonBlocks].join('\n')}\n`,
    );
    const superseded = mergedWorkerCaBundles.get(cacheKey);
    mergedWorkerCaBundles.set(cacheKey, { bundlePath, sourceStamps });
    if (superseded) {
      // This rebuild orphaned the previous bundle; the exit hook would hold
      // one per rotation until the daemon stops.
      const dir = path.dirname(superseded.bundlePath);
      mintedWorkerCaBundleDirs.delete(dir);
      cleanupWorkerCaBundleDir(dir);
    }
    // The merge works again, so a LATER failure of the same pair is new
    // information — without this, the first failure's key silenced it forever
    // and the workers restart-looped with no diagnostic at all.
    for (const family of WORKER_CA_MERGE_FALLBACK_FAMILIES) {
      warnedWorkerCaMergeFallbacks.delete(
        workerCaMergeFallbackKey(existing, daemonCertPath, family),
      );
    }
    return bundlePath;
  } catch (err) {
    warnWorkerCaMergeFallback(
      existing,
      daemonCertPath,
      // An inspection that could not run blames nothing about the file's
      // contents; sharing the read-error family would let a first ENOENT
      // silence the later, now-accurate inspection-failure diagnosis.
      err instanceof ExtraCaInspectionError
        ? 'inspection-failed'
        : 'read-error',
      err instanceof Error ? err.message : String(err),
    );
    return daemonCertPath;
  }
}

function createWorkerEnv(opts: {
  daemonUrl: string;
  daemonToken?: string;
  workspace: string;
  baseEnv?: Readonly<NodeJS.ProcessEnv>;
  tlsCaCertPath?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.baseEnv ?? process.env) };
  env['QWEN_CODE_NO_RELAUNCH'] = 'true';
  // Marks the worker (and the ACP children it spawns) as daemon-spawned so
  // the ACP channel fallback reports channel=daemon in usage statistics
  // (see cli/src/config/acp-channel-fallback.ts).
  env['QWEN_CODE_SERVE'] = '1';
  if (opts.tlsCaCertPath) {
    env[NODE_EXTRA_CA_CERTS_ENV] = resolveWorkerCaCertPath(
      opts.tlsCaCertPath,
      env[NODE_EXTRA_CA_CERTS_ENV],
    );
  }
  env[CHANNEL_DAEMON_WORKER_SENTINEL] = randomUUID();
  env[QWEN_DAEMON_URL_ENV] = opts.daemonUrl;
  env[QWEN_DAEMON_WORKSPACE_ENV] = opts.workspace;
  delete env[QWEN_SERVER_TOKEN_ENV];
  delete env[QWEN_DAEMON_TOKEN_ENV];
  delete env[EXTERNAL_TOOL_GUARD_TOKEN_ENV];
  if (opts.daemonToken) {
    env[QWEN_DAEMON_TOKEN_ENV] = opts.daemonToken;
  }
  return env;
}

function attachWorkerLogStream(
  stream: WorkerLogStream | undefined,
  streamName: ChannelWorkerLogEntry['stream'],
  opts: {
    daemonToken?: string;
    workerEnv: NodeJS.ProcessEnv;
    onLog?: (entry: ChannelWorkerLogEntry) => void;
  },
): () => void {
  if (!stream) return () => {};
  let buffer = '';
  let discardingOversizedLineRemainder = false;
  let discardedOversizedLineRemainderLength = 0;
  const redactWorkerLogLineForStream = createWorkerDiagnosticRedactor({
    ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
    workerEnv: opts.workerEnv,
  });
  const flushLine = (line: string) => {
    const displayLine = line.replace(/\t/gu, ' ');
    const redacted = redactWorkerLogLineForStream(
      normalizeWorkerDiagnostic(displayLine),
    );
    notifyLog(opts.onLog, {
      stream: streamName,
      line: sanitizeLogText(redacted, MAX_WORKER_LOG_LINE_LENGTH),
    });
  };
  const flushPartial = () => {
    if (buffer.length === 0) return;
    flushLine(buffer);
    buffer = '';
  };
  const flushOversizedBuffer = () => {
    if (buffer.length <= MAX_WORKER_LOG_BUFFER_LENGTH) return;
    // Keep one truncated entry for the huge logical line, then drop its tail
    // until the next newline so a single worker write cannot flood daemon logs.
    flushLine(buffer);
    buffer = '';
    discardingOversizedLineRemainder = true;
    discardedOversizedLineRemainderLength = 0;
  };
  stream.on('data', (chunk) => {
    buffer +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    for (;;) {
      const newlineIndex = buffer.search(/\r?\n/);
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex);
      const newlineLength =
        buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n'
          ? 2
          : 1;
      buffer = buffer.slice(newlineIndex + newlineLength);
      if (!discardingOversizedLineRemainder) {
        flushLine(line);
      }
      discardingOversizedLineRemainder = false;
      discardedOversizedLineRemainderLength = 0;
    }
    if (discardingOversizedLineRemainder) {
      discardedOversizedLineRemainderLength += buffer.length;
      buffer = '';
      if (
        discardedOversizedLineRemainderLength >=
        MAX_WORKER_LOG_DISCARDED_REMAINDER_LENGTH
      ) {
        discardingOversizedLineRemainder = false;
        discardedOversizedLineRemainderLength = 0;
      }
      return;
    }
    flushOversizedBuffer();
  });
  stream.on('end', flushPartial);
  stream.on('close', flushPartial);
  stream.on('error', () => {
    flushPartial();
  });
  return flushPartial;
}

export function createChannelWorkerSupervisor(
  opts: CreateChannelWorkerSupervisorOptions,
): ChannelWorkerSupervisor {
  const spawnWorker = opts.spawnWorker ?? defaultSpawnWorker;
  const restartPolicy = opts.restartPolicy ?? DEFAULT_RESTART_POLICY;
  if (restartPolicy.delaysMs.length === 0) {
    throw new Error('restartPolicy.delaysMs must be non-empty.');
  }
  const heartbeatTimeoutMs =
    opts.heartbeatTimeoutMs ?? DEFAULT_CHANNEL_WORKER_HEARTBEAT_TIMEOUT_MS;
  if (
    heartbeatTimeoutMs > 0 &&
    heartbeatTimeoutMs <= CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS
  ) {
    throw new Error(
      `heartbeatTimeoutMs (${heartbeatTimeoutMs}) must exceed the worker heartbeat interval (${CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS}ms) or be 0 to disable.`,
    );
  }
  let child: ChannelWorkerChild | undefined;
  let activePromptAuthorization: string | undefined;
  let snapshot: ChannelWorkerSnapshot = {
    enabled: true,
    state: 'disabled',
    channels: channelSelectionNames(opts.selection),
    restartCount: 0,
  };
  let stopping = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let staleHeartbeatTimer: NodeJS.Timeout | undefined;
  let restartAttemptTimes: number[] = [];
  const pendingWebhookTasks = new Map<
    string,
    {
      resolve: (accepted: ChannelWebhookAccepted) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const pendingChannelDeliveries = new Map<
    string,
    {
      resolve: (accepted: ChannelDeliveryAccepted) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const pendingChannelLoopMcpMessages = new Map<
    string,
    {
      resolve: (payload: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let cleanupChannelLoopMcpRegistrations: (() => void) | undefined;
  let restarting: Promise<ChannelWorkerSnapshot> | undefined;
  let disposed = false;

  const snapshotCopy = (): ChannelWorkerSnapshot => ({
    ...snapshot,
    channels: [...snapshot.channels],
    ...(snapshot.requestedChannels
      ? { requestedChannels: [...snapshot.requestedChannels] }
      : {}),
    ...(snapshot.startupFailures
      ? {
          startupFailures: snapshot.startupFailures.map((failure) => ({
            ...failure,
          })),
        }
      : {}),
    ...(snapshot.adapters
      ? { adapters: snapshot.adapters.map((adapter) => ({ ...adapter })) }
      : {}),
  });

  const clearRestartTimer = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    if (snapshot.nextRestartAt) {
      const next = { ...snapshot };
      delete next.nextRestartAt;
      snapshot = next;
    }
  };

  const clearStaleHeartbeatTimer = () => {
    if (!staleHeartbeatTimer) return;
    clearTimeout(staleHeartbeatTimer);
    staleHeartbeatTimer = undefined;
  };

  const rejectPendingWebhookTasks = (
    code: ChannelWebhookEnqueueErrorCode,
    message: string,
  ) => {
    for (const pending of pendingWebhookTasks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ChannelWebhookEnqueueError(code, message));
    }
    pendingWebhookTasks.clear();
  };

  const rejectPendingWebhookTask = (id: string, err: Error) => {
    const pending = pendingWebhookTasks.get(id);
    if (!pending) return;
    pendingWebhookTasks.delete(id);
    clearTimeout(pending.timer);
    pending.reject(err);
  };

  const settleWebhookTask = (message: unknown): boolean => {
    if (!isChannelWebhookTaskResultMessage(message)) return false;
    const pending = pendingWebhookTasks.get(message.id);
    if (!pending) return true;
    if (message.ok) {
      pendingWebhookTasks.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve({ accepted: true });
    } else {
      const code = isChannelWebhookEnqueueErrorCode(message.code)
        ? message.code
        : 'channel_webhook_enqueue_failed';
      rejectPendingWebhookTask(
        message.id,
        new ChannelWebhookEnqueueError(
          code,
          message.error || 'Channel webhook task failed.',
        ),
      );
    }
    return true;
  };

  const rejectPendingChannelDeliveries = (
    code: ChannelDeliveryErrorCode,
    message: string,
  ) => {
    for (const pending of pendingChannelDeliveries.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ChannelDeliveryError(code, message));
    }
    pendingChannelDeliveries.clear();
  };

  const rejectPendingChannelDelivery = (id: string, error: Error) => {
    const pending = pendingChannelDeliveries.get(id);
    if (!pending) return;
    pendingChannelDeliveries.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  };

  const settleChannelDelivery = (message: unknown): boolean => {
    if (!isChannelDeliveryResultMessage(message)) return false;
    const pending = pendingChannelDeliveries.get(message.id);
    if (!pending) return true;
    if (message.ok) {
      pendingChannelDeliveries.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve({ delivered: true });
    } else {
      rejectPendingChannelDelivery(
        message.id,
        new ChannelDeliveryError(
          message.code,
          message.error || 'Channel delivery failed.',
        ),
      );
    }
    return true;
  };

  const rejectPendingChannelLoopMcpMessages = (message: string) => {
    for (const pending of pendingChannelLoopMcpMessages.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    pendingChannelLoopMcpMessages.clear();
  };

  const settleChannelLoopMcpMessage = (message: unknown): boolean => {
    if (!isChannelLoopMcpResultMessage(message)) return false;
    const pending = pendingChannelLoopMcpMessages.get(message.id);
    if (!pending) return true;
    pendingChannelLoopMcpMessages.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.payload ?? {});
    } else {
      pending.reject(
        new Error(message.error ?? 'Channel loop MCP request failed.'),
      );
    }
    return true;
  };

  const pruneRestartAttempts = (nowMs: number) => {
    restartAttemptTimes = restartAttemptTimes.filter(
      (attemptMs) => nowMs - attemptMs < restartPolicy.windowMs,
    );
  };

  const canScheduleRestart = (nowMs: number): boolean => {
    pruneRestartAttempts(nowMs);
    return restartAttemptTimes.length < restartPolicy.maxRestarts;
  };

  const nextRestartDelayMs = (): number => {
    const index = Math.min(
      restartAttemptTimes.length,
      restartPolicy.delaysMs.length - 1,
    );
    return restartPolicy.delaysMs[index] ?? 0;
  };

  const setExited = (
    state: ChannelWorkerState,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: string,
  ) => {
    const next: ChannelWorkerSnapshot = {
      ...snapshot,
      state,
      exitCode: code,
      signal,
      lastExitAt: new Date().toISOString(),
    };
    if (error) {
      next.error = error;
    } else {
      delete next.error;
    }
    snapshot = {
      ...next,
    };
  };

  const scheduleRestart = (): boolean => {
    if (stopping) return false;
    const nowMs = Date.now();
    if (!canScheduleRestart(nowMs)) {
      const lastError = snapshot.error;
      snapshot = {
        ...snapshot,
        state: 'failed',
        error: lastError
          ? `Channel worker restart budget exhausted. Last error: ${lastError}`
          : 'Channel worker restart budget exhausted.',
        nextRestartAt: undefined,
      };
      return false;
    }
    clearRestartTimer();
    const delayMs = nextRestartDelayMs();
    const nextRestartAt = new Date(nowMs + delayMs).toISOString();
    snapshot = {
      ...snapshot,
      nextRestartAt,
    };
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void launch('restart').catch((err: unknown) => {
        handleRestartFailure(err instanceof Error ? err.message : String(err));
      });
    }, delayMs);
    restartTimer.unref();
    return true;
  };

  const handleRestartFailure = (
    error: string,
    redaction?: WorkerDiagnosticRedactionOptions,
  ) => {
    snapshot = {
      ...snapshot,
      state: 'failed',
      error: sanitizeWorkerError(error, redaction),
    };
    scheduleRestart();
    notifyExit(opts.onExit, snapshotCopy());
  };

  const armStaleHeartbeatTimer = (startedChild: ChannelWorkerChild) => {
    clearStaleHeartbeatTimer();
    if (heartbeatTimeoutMs <= 0) return;
    staleHeartbeatTimer = setTimeout(() => {
      if (child !== startedChild || stopping) return;
      snapshot = {
        ...snapshot,
        error: 'Channel worker heartbeat timed out.',
        staleHeartbeatAt: new Date().toISOString(),
      };
      startedChild.kill('SIGKILL');
    }, heartbeatTimeoutMs);
    staleHeartbeatTimer.unref();
  };

  const launch = async (kind: 'initial' | 'restart'): Promise<void> => {
    clearStaleHeartbeatTimer();
    const argv = [
      opts.cliEntryPath,
      'channel',
      'daemon-worker',
      ...selectionChannelArgs(opts.selection),
    ];
    const env = createWorkerEnv({
      daemonUrl: opts.daemonUrl,
      workspace: opts.workspace,
      ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
      ...(opts.workerBaseEnv ? { baseEnv: opts.workerBaseEnv } : {}),
      ...(opts.tlsCaCertPath ? { tlsCaCertPath: opts.tlsCaCertPath } : {}),
    });
    const promptAuthorization = env[CHANNEL_DAEMON_WORKER_SENTINEL]!;
    registerChannelWorkerPromptAuthorization(
      promptAuthorization,
      opts.workspace,
    );
    activePromptAuthorization = promptAuthorization;
    const revokePromptAuthorization = () => {
      revokeChannelWorkerPromptAuthorization(promptAuthorization);
      if (activePromptAuthorization === promptAuthorization) {
        activePromptAuthorization = undefined;
      }
    };
    const redaction = workerLogRedactionOptions(opts.daemonToken, env);
    const requestedChannels = requestedChannelNames(opts.selection);
    const startedAt = new Date().toISOString();
    snapshot = {
      enabled: true,
      state: 'starting',
      channels: channelSelectionNames(opts.selection),
      ...(requestedChannels ? { requestedChannels } : {}),
      ...(requestedChannels
        ? {
            adapters: requestedChannels.map((name) => ({
              name,
              state: 'starting' as const,
            })),
          }
        : {}),
      startedAt,
      restartCount: snapshot.restartCount ?? 0,
      ...(snapshot.lastExitAt ? { lastExitAt: snapshot.lastExitAt } : {}),
      ...(snapshot.lastHeartbeatAt
        ? { lastHeartbeatAt: snapshot.lastHeartbeatAt }
        : {}),
      ...(snapshot.staleHeartbeatAt
        ? { staleHeartbeatAt: snapshot.staleHeartbeatAt }
        : {}),
    };
    if (kind === 'restart') {
      const nowMs = Date.now();
      restartAttemptTimes.push(nowMs);
      snapshot = {
        ...snapshot,
        restartCount: (snapshot.restartCount ?? 0) + 1,
        lastRestartAt: new Date(nowMs).toISOString(),
        nextRestartAt: undefined,
      };
    }

    let startedChild: ChannelWorkerChild;
    try {
      startedChild = spawnWorker(process.execPath, argv, {
        cwd: opts.workspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      revokePromptAuthorization();
      const message = err instanceof Error ? err.message : String(err);
      const error = sanitizeWorkerError(message, redaction);
      if (kind === 'initial') {
        snapshot = {
          ...snapshot,
          state: 'failed',
          error,
        };
        throw new Error(error);
      }
      handleRestartFailure(message, redaction);
      return;
    }

    child = startedChild;
    attachWorkerLogStream(startedChild.stdout, 'stdout', {
      ...redaction,
      onLog: opts.onLog,
    });
    attachWorkerLogStream(startedChild.stderr, 'stderr', {
      ...redaction,
      onLog: opts.onLog,
    });
    if (startedChild.pid !== undefined) {
      snapshot = { ...snapshot, pid: startedChild.pid };
    }

    const channelLoopMcpOwnerId = `channel-worker:${randomUUID()}`;
    const registeredChannelLoopMcpSessions = new Set<string>();
    const activeChannelLoopMcpControls = new Set<string>();
    const sendToStartedChild: ChannelLoopMcpIpcSend = (message, callback) => {
      if (child !== startedChild || !startedChild.send) {
        throw new Error('Channel worker IPC is unavailable.');
      }
      return callback
        ? startedChild.send.call(startedChild, message, callback)
        : startedChild.send.call(startedChild, message);
    };
    const sendChannelLoopMcpMessage = (
      sessionId: string,
      payload: unknown,
    ): Promise<unknown> => {
      if (
        pendingChannelLoopMcpMessages.size >= MAX_CHANNEL_LOOP_MCP_IN_FLIGHT
      ) {
        return Promise.reject(new Error('Channel loop MCP IPC queue is full.'));
      }
      const message = createChannelLoopMcpRequest(sessionId, payload);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingChannelLoopMcpMessages.delete(message.id);
          reject(new Error('Channel loop MCP IPC timed out.'));
        }, CHANNEL_LOOP_MCP_IPC_TIMEOUT_MS);
        timer.unref();
        pendingChannelLoopMcpMessages.set(message.id, {
          resolve,
          reject,
          timer,
        });
        try {
          sendToStartedChild(message, (error) => {
            if (!error) return;
            const pending = pendingChannelLoopMcpMessages.get(message.id);
            if (!pending) return;
            pendingChannelLoopMcpMessages.delete(message.id);
            clearTimeout(pending.timer);
            pending.reject(new Error('Channel loop MCP IPC send failed.'));
          });
        } catch {
          const pending = pendingChannelLoopMcpMessages.get(message.id);
          if (!pending) return;
          pendingChannelLoopMcpMessages.delete(message.id);
          clearTimeout(pending.timer);
          pending.reject(new Error('Channel loop MCP IPC send failed.'));
        }
      });
    };
    const cleanupLaunchChannelLoopMcpRegistrations = () => {
      for (const sessionId of registeredChannelLoopMcpSessions) {
        void opts
          .unregisterChannelLoopMcp?.(sessionId, channelLoopMcpOwnerId)
          .catch(() => {});
      }
      registeredChannelLoopMcpSessions.clear();
    };
    cleanupChannelLoopMcpRegistrations =
      cleanupLaunchChannelLoopMcpRegistrations;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let ready = false;
      let exitObserved = false;
      let terminatingBeforeReady = false;
      let startupTimer: NodeJS.Timeout | undefined;
      const cleanupStartupTimer = () => {
        if (!startupTimer) return;
        clearTimeout(startupTimer);
        startupTimer = undefined;
      };
      const cleanupLaunch = () => {
        cleanupStartupTimer();
        startedChild.removeListener('message', handleMessage);
        clearStaleHeartbeatTimer();
      };
      const terminateBeforeReady = () => {
        cleanupLaunch();
        if (terminatingBeforeReady) return;
        terminatingBeforeReady = true;
        const exited = waitForExit(startedChild, CHANNEL_WORKER_KILL_GRACE_MS);
        startedChild.kill('SIGTERM');
        void exited.then(async (didExit) => {
          if (!didExit && child === startedChild && !exitObserved) {
            const killed = waitForExit(
              startedChild,
              CHANNEL_WORKER_KILL_GRACE_MS,
            );
            startedChild.kill('SIGKILL');
            if (!(await killed) && child === startedChild && !exitObserved) {
              stopping = true;
              notifyLog(opts.onLog, {
                stream: 'stderr',
                line: 'Channel worker did not exit after SIGKILL; automatic restart is disabled.',
              });
              snapshot = {
                ...snapshot,
                state: 'failed',
                error:
                  snapshot.error ??
                  'Channel worker did not exit after SIGKILL.',
              };
              notifyExit(opts.onExit, snapshotCopy());
            }
          }
        });
      };
      const failBeforeReady = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanupStartupTimer();
        if (kind === 'initial') {
          reject(err);
        } else {
          resolve();
        }
      };
      const startupError = (message: string): Error => {
        const failures = snapshot.startupFailures;
        return failures && failures.length > 0
          ? new ChannelWorkerStartupError(message, {
              workspaceCwd: opts.workspace,
              startupFailures: failures,
              ...(snapshot.startupFailuresTruncated
                ? { startupFailuresTruncated: true }
                : {}),
            })
          : new Error(message);
      };
      const failStartupProtocol = (detail: string) => {
        if (settled || ready || child !== startedChild) return;
        const error = sanitizeWorkerError(
          `Channel worker startup IPC protocol error: ${detail}`,
          redaction,
        );
        snapshot = { ...snapshot, state: 'failed', error };
        failBeforeReady(startupError(error));
        terminateBeforeReady();
      };
      const acknowledgeStartupReport = () => {
        const send = startedChild.send;
        if (!send) {
          failStartupProtocol('acknowledgement is unavailable.');
          return;
        }
        try {
          send.call(
            startedChild,
            { type: 'channel_startup_report_ack' },
            (err) => {
              if (err) {
                failStartupProtocol('acknowledgement failed.');
              }
            },
          );
        } catch {
          failStartupProtocol('acknowledgement failed.');
        }
      };
      const handleStartupReport = (message: unknown) => {
        if (!isChannelStartupReportMessage(message)) {
          failStartupProtocol('invalid startup report.');
          return;
        }
        if (message.type === 'channel_startup_failures_truncated') {
          if (
            snapshot.startupFailuresTruncated ||
            snapshot.startupFailures?.length !== MAX_CHANNEL_STARTUP_FAILURES
          ) {
            failStartupProtocol('invalid truncation marker.');
            return;
          }
          snapshot = { ...snapshot, startupFailuresTruncated: true };
          acknowledgeStartupReport();
          return;
        }
        if (
          snapshot.startupFailuresTruncated ||
          (snapshot.startupFailures?.length ?? 0) >=
            MAX_CHANNEL_STARTUP_FAILURES
        ) {
          failStartupProtocol('too many startup failures.');
          return;
        }
        const safeChannel =
          sanitizeWorkerDiagnostic(
            message.failure.channel,
            MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
            redaction,
          ) || '<unnamed>';
        const safeMessage =
          sanitizeWorkerDiagnostic(
            message.failure.message,
            MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
            redaction,
          ) || 'Channel connection failed.';
        const safeCode = message.failure.code
          ? sanitizeWorkerDiagnostic(
              message.failure.code,
              MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
              redaction,
            )
          : undefined;
        const failure: ChannelStartupFailure = {
          channel: safeChannel,
          phase: 'connect',
          ...(safeCode ? { code: safeCode } : {}),
          message: safeMessage,
        };
        snapshot = {
          ...snapshot,
          startupFailures: [...(snapshot.startupFailures ?? []), failure],
          adapters: snapshot.adapters?.map((adapter) =>
            adapter.name === failure.channel
              ? {
                  name: adapter.name,
                  state: 'error' as const,
                  error: failure.message,
                }
              : adapter,
          ),
        };
        acknowledgeStartupReport();
      };
      const completeReady = (message: {
        pid?: number;
        channels?: string[];
        requestedChannels?: string[];
      }) => {
        if (settled || child !== startedChild) return;
        settled = true;
        ready = true;
        cleanupStartupTimer();
        const next: ChannelWorkerSnapshot = {
          ...snapshot,
          state: 'running',
          pid: message.pid ?? startedChild.pid,
          channels:
            message.channels && message.channels.length > 0
              ? [...message.channels]
              : [...snapshot.channels],
        };
        delete next.error;
        delete next.lastHeartbeatAt;
        delete next.nextRestartAt;
        delete next.staleHeartbeatAt;
        if (message.requestedChannels?.length) {
          next.requestedChannels = [...message.requestedChannels];
        }
        const adapterNames = message.requestedChannels?.length
          ? message.requestedChannels
          : (next.requestedChannels ?? next.channels);
        const connected = new Set(next.channels);
        const failures = new Map(
          next.startupFailures?.map((failure) => [failure.channel, failure]),
        );
        next.adapters = adapterNames.map((name) => {
          if (connected.has(name)) {
            return { name, state: 'connected' as const };
          }
          const failure = failures.get(name);
          return {
            name,
            state: 'error' as const,
            ...(failure ? { error: failure.message } : {}),
          };
        });
        snapshot = next;
        armStaleHeartbeatTimer(startedChild);
        notifyReady(opts.onReady, snapshotCopy());
        resolve();
      };
      const handleHeartbeat = (message: { pid?: number; at?: string }) => {
        if (!ready || child !== startedChild) return;
        const currentPid = snapshot.pid ?? startedChild.pid;
        if (message.pid !== undefined && currentPid !== undefined) {
          if (message.pid !== currentPid) return;
        }
        // Use daemon clock, not worker-supplied message.at — a compromised
        // adapter could inject arbitrary data via the IPC heartbeat.
        snapshot = {
          ...snapshot,
          lastHeartbeatAt: new Date().toISOString(),
        };
        armStaleHeartbeatTimer(startedChild);
      };
      const sendChannelLoopMcpControlResult = (
        id: string,
        result: { ok: true } | { ok: false; error: string },
      ) => {
        try {
          sendToStartedChild({
            type: 'channel_loop_mcp_control_result',
            id,
            ...result,
          });
        } catch {
          // The worker request owns the timeout when IPC is already closed.
        }
      };
      const handleChannelLoopMcpControl = (
        message: ChannelLoopMcpControlMessage,
      ) => {
        if (
          activeChannelLoopMcpControls.size >= MAX_CHANNEL_LOOP_MCP_IN_FLIGHT
        ) {
          sendChannelLoopMcpControlResult(message.id, {
            ok: false,
            error: 'Channel loop MCP IPC queue is full.',
          });
          return;
        }
        activeChannelLoopMcpControls.add(message.id);
        const operation =
          message.type === 'channel_loop_mcp_register'
            ? (opts
                .registerChannelLoopMcp?.({
                  sessionId: message.sessionId,
                  ownerId: channelLoopMcpOwnerId,
                  sendMessage: (payload) =>
                    sendChannelLoopMcpMessage(message.sessionId, payload),
                })
                .then(async () => {
                  if (child !== startedChild) {
                    await opts.unregisterChannelLoopMcp?.(
                      message.sessionId,
                      channelLoopMcpOwnerId,
                    );
                    throw new Error('Channel worker exited during MCP setup.');
                  }
                  registeredChannelLoopMcpSessions.add(message.sessionId);
                }) ??
              Promise.reject(
                new Error('Channel loop MCP registration is unavailable.'),
              ))
            : (opts
                .unregisterChannelLoopMcp?.(
                  message.sessionId,
                  channelLoopMcpOwnerId,
                )
                .then(() => {
                  registeredChannelLoopMcpSessions.delete(message.sessionId);
                }) ?? Promise.resolve());
        void operation
          .then(() => {
            sendChannelLoopMcpControlResult(message.id, { ok: true });
          })
          .catch((error: unknown) => {
            sendChannelLoopMcpControlResult(message.id, {
              ok: false,
              error:
                sanitizeWorkerDiagnostic(
                  error instanceof Error ? error.message : String(error),
                  512,
                  redaction,
                ) || 'Channel loop MCP operation failed.',
            });
          })
          .finally(() => {
            activeChannelLoopMcpControls.delete(message.id);
          });
      };
      function handleMessage(message: unknown) {
        if (child !== startedChild) return;
        if (settleChannelDelivery(message)) {
          return;
        }
        if (settleWebhookTask(message)) {
          return;
        }
        if (settleChannelLoopMcpMessage(message)) {
          return;
        }
        if (isChannelLoopMcpControlMessage(message)) {
          handleChannelLoopMcpControl(message);
          return;
        }
        if (!ready && isChannelStartupReportType(message)) {
          handleStartupReport(message);
        } else if (!ready && isReadyMessage(message)) {
          completeReady(message);
        } else if (isHeartbeatMessage(message)) {
          handleHeartbeat(message);
        }
      }
      function settleExit(code: number | null, signal: NodeJS.Signals | null) {
        if (child !== startedChild) return;
        revokePromptAuthorization();
        exitObserved = true;
        cleanupLaunch();
        const state = ready ? 'exited' : 'failed';
        const message = `Channel worker exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
        setExited(
          state,
          code,
          signal,
          snapshot.error ??
            (ready ? undefined : sanitizeWorkerError(message, redaction)),
        );
        rejectPendingWebhookTasks(
          'channel_worker_unavailable',
          'Channel worker exited.',
        );
        rejectPendingChannelDeliveries(
          'channel_worker_unavailable',
          'Channel worker exited.',
        );
        rejectPendingChannelLoopMcpMessages('Channel worker exited.');
        cleanupLaunchChannelLoopMcpRegistrations();
        if (
          cleanupChannelLoopMcpRegistrations ===
          cleanupLaunchChannelLoopMcpRegistrations
        ) {
          cleanupChannelLoopMcpRegistrations = undefined;
        }
        child = undefined;
        if ((ready || kind === 'restart') && !stopping) {
          scheduleRestart();
          notifyExit(opts.onExit, snapshotCopy());
        }
        if (!settled) {
          failBeforeReady(startupError(snapshot.error ?? message));
        }
      }
      function settleError(err: Error) {
        if (child !== startedChild || exitObserved) return;
        if (settled && ready) {
          snapshot = {
            ...snapshot,
            error: sanitizeWorkerError(err.message, redaction),
          };
          startedChild.kill('SIGTERM');
          return;
        }
        snapshot = {
          ...snapshot,
          state: 'failed',
          error: sanitizeWorkerError(err.message, redaction),
        };
        terminateBeforeReady();
        if (!settled) {
          failBeforeReady(
            startupError(snapshot.error ?? 'Channel worker failed to start.'),
          );
        }
      }
      startupTimer = setTimeout(() => {
        const timeoutMs =
          opts.startupTimeoutMs ?? CHANNEL_WORKER_STARTUP_TIMEOUT_MS;
        const error = `Channel worker did not become ready within ${timeoutMs}ms.`;
        snapshot = {
          ...snapshot,
          state: 'failed',
          error: sanitizeWorkerError(error, redaction),
        };
        failBeforeReady(startupError(error));
        if (child === startedChild) {
          terminateBeforeReady();
        }
      }, opts.startupTimeoutMs ?? CHANNEL_WORKER_STARTUP_TIMEOUT_MS);
      startupTimer.unref();
      startedChild.on('message', handleMessage);
      startedChild.once('exit', settleExit);
      startedChild.once('error', settleError);
    });
  };

  const supervisor: ChannelWorkerSupervisor = {
    async start() {
      // `disposed` is latched only by killAllSync() (hard shutdown), so the
      // supported stop()/start() reuse lifecycle is preserved; this guard just
      // prevents a relaunch into a daemon that is being force-torn-down.
      if (disposed) return;
      if (child) {
        if (stopping) {
          throw new ChannelWorkerStopError(
            'Channel worker stop is not yet confirmed.',
          );
        }
        return;
      }
      stopping = false;
      clearRestartTimer();
      restartAttemptTimes = [];
      await launch('initial');
    },
    async stop() {
      clearRestartTimer();
      clearStaleHeartbeatTimer();
      rejectPendingWebhookTasks(
        'channel_worker_unavailable',
        'Channel worker stopped.',
      );
      rejectPendingChannelDeliveries(
        'channel_worker_unavailable',
        'Channel worker stopped.',
      );
      rejectPendingChannelLoopMcpMessages('Channel worker stopped.');
      if (
        !child ||
        snapshot.state === 'exited' ||
        (snapshot.state === 'failed' && hasObservedExit(snapshot)) ||
        snapshot.state === 'stopped'
      ) {
        child = undefined;
        snapshot = { ...snapshot, state: 'stopped' };
        return;
      }
      const stoppingChild = child;
      const exited = waitForExit(stoppingChild, CHANNEL_WORKER_STOP_GRACE_MS);
      stopping = true;
      stoppingChild.kill('SIGTERM');
      if (!(await exited) && child === stoppingChild) {
        const killed = waitForExit(stoppingChild, CHANNEL_WORKER_KILL_GRACE_MS);
        stoppingChild.kill('SIGKILL');
        if (!(await killed)) {
          snapshot = {
            ...snapshot,
            state: 'failed',
            error: 'Channel worker did not exit after SIGKILL.',
          };
          throw new ChannelWorkerStopError();
        }
      }
      child = undefined;
      stopping = false;
      snapshot = { ...snapshot, state: 'stopped' };
    },
    async restart() {
      // A hard shutdown (killAllSync) latches `disposed`; a reload racing that
      // must not relaunch a worker into a tearing-down daemon.
      if (disposed) return snapshotCopy();
      // Coalesce concurrent reloads onto one stop+relaunch so a burst of
      // reload requests cannot fork multiple workers.
      restarting ??= (async () => {
        try {
          await supervisor.stop();
          // start() bails if a child is still attached (stop cleared it) or if
          // killAllSync latched `disposed` mid-reload — avoiding an orphaned
          // fork. It also resets the restart budget, so a worker previously
          // parked in `failed` recovers on an explicit reload.
          await supervisor.start();
          return snapshotCopy();
        } finally {
          restarting = undefined;
        }
      })();
      return restarting;
    },
    killAllSync() {
      disposed = true;
      rejectPendingWebhookTasks(
        'channel_worker_unavailable',
        'Channel worker stopped.',
      );
      rejectPendingChannelDeliveries(
        'channel_worker_unavailable',
        'Channel worker stopped.',
      );
      rejectPendingChannelLoopMcpMessages('Channel worker stopped.');
      cleanupChannelLoopMcpRegistrations?.();
      cleanupChannelLoopMcpRegistrations = undefined;
      if (
        !child ||
        snapshot.state === 'exited' ||
        (snapshot.state === 'failed' && hasObservedExit(snapshot)) ||
        snapshot.state === 'stopped'
      ) {
        clearRestartTimer();
        clearStaleHeartbeatTimer();
        return;
      }
      const preserveFailure =
        snapshot.state === 'failed' && !hasObservedExit(snapshot);
      clearRestartTimer();
      clearStaleHeartbeatTimer();
      stopping = true;
      if (activePromptAuthorization) {
        revokeChannelWorkerPromptAuthorization(activePromptAuthorization);
        activePromptAuthorization = undefined;
      }
      child.kill('SIGKILL');
      child = undefined;
      if (!preserveFailure) {
        snapshot = {
          ...snapshot,
          state: 'stopped',
          signal: 'SIGKILL',
        };
      }
    },
    snapshot() {
      return snapshotCopy();
    },
    async deliverChannelMessage(request) {
      const startedChild = child;
      if (!startedChild || snapshot.state !== 'running') {
        throw new ChannelDeliveryError(
          'channel_worker_unavailable',
          'Channel worker is not running.',
        );
      }
      const send = startedChild.send;
      if (!send) {
        throw new ChannelDeliveryError(
          'channel_worker_unavailable',
          'Channel worker IPC send failed.',
        );
      }
      if (pendingChannelDeliveries.size >= MAX_CHANNEL_DELIVERIES_IN_FLIGHT) {
        throw new ChannelDeliveryError(
          'channel_delivery_queue_full',
          'Channel delivery queue is full.',
        );
      }
      const message = createChannelDeliveryMessage(request);
      return await new Promise<ChannelDeliveryAccepted>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingChannelDeliveries.delete(message.id);
          reject(
            new ChannelDeliveryError(
              'channel_delivery_timeout',
              'Channel delivery IPC timed out.',
            ),
          );
        }, CHANNEL_DELIVERY_IPC_TIMEOUT_MS);
        timer.unref();
        pendingChannelDeliveries.set(message.id, { resolve, reject, timer });
        try {
          send.call(startedChild, message, (error) => {
            if (!error) return;
            rejectPendingChannelDelivery(
              message.id,
              new ChannelDeliveryError(
                'channel_worker_unavailable',
                `Channel worker IPC send failed: ${error.message}`,
              ),
            );
          });
        } catch (error) {
          rejectPendingChannelDelivery(
            message.id,
            new ChannelDeliveryError(
              'channel_worker_unavailable',
              `Channel worker IPC send failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      });
    },
    async enqueueWebhookTask(task) {
      const startedChild = child;
      if (!startedChild || snapshot.state !== 'running') {
        throw new ChannelWebhookEnqueueError(
          'channel_worker_unavailable',
          'Channel worker is not running.',
        );
      }
      const send = startedChild.send;
      if (!send) {
        throw new ChannelWebhookEnqueueError(
          'channel_worker_unavailable',
          'Channel worker IPC send failed.',
        );
      }
      const message = createChannelWebhookTaskMessage(task);
      return await new Promise<ChannelWebhookAccepted>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingWebhookTasks.delete(message.id);
          reject(
            new ChannelWebhookEnqueueError(
              'channel_webhook_enqueue_timeout',
              'Channel webhook task IPC timed out.',
            ),
          );
        }, CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS);
        timer.unref();
        pendingWebhookTasks.set(message.id, { resolve, reject, timer });
        try {
          send.call(startedChild, message, (err) => {
            if (err) {
              rejectPendingWebhookTask(
                message.id,
                new ChannelWebhookEnqueueError(
                  'channel_worker_unavailable',
                  `Channel worker IPC send failed: ${err.message}`,
                ),
              );
            }
          });
        } catch (err) {
          rejectPendingWebhookTask(
            message.id,
            new ChannelWebhookEnqueueError(
              'channel_worker_unavailable',
              `Channel worker IPC send failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
        }
      });
    },
  };
  return supervisor;
}
