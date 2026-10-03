/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  ProcessExitError,
  ProcessRegistry,
  type TrackedChildProcess,
} from '@qwen-code/acp-bridge/processRegistry';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  MANAGED_RUNTIME_TOOL_NAMES,
  ManagedRuntimeOutcomeUnknownError,
  type ExecutionEnvironment,
} from '@qwen-code/qwen-code-core/services/execution-environment.js';
import { LocalExecutionEnvironment } from '@qwen-code/qwen-code-core/services/local-execution-environment.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { ToolNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import type { Part } from '@google/genai';
import type { ToolResult } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { ToolErrorType } from '@qwen-code/qwen-code-core/tools/tool-error.js';
import { promptIdContext } from '@qwen-code/qwen-code-core/utils/promptIdContext.js';
import {
  isNodeOptionsEnvKey,
  processBootLoaderEnv,
} from '../config/shared-env-keys.js';
import type {
  ManagedRuntimeWorkerBoot,
  ManagedRuntimeWorkerReady,
} from './managed-runtime-attestation-worker.js';
import type {
  ManagedToolReference,
  ManagedToolResultPayload,
} from './managed-runtime-tool-executor.js';

const READY_TIMEOUT_MS = 30_000;
/** How long a cancelled call may take to settle before its outcome is unknown. */
const CANCEL_SETTLE_TIMEOUT_MS = 15_000;
const STATUS_POLL_MS = 100;
/** How long a broken call waits for its worker's exit to be observed. */
const EXIT_GRACE_MS = 100;
/** Every request but `execute`, which answers when its call settles. */
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
/** Above the worker's result bound, so no answer it may give is cut off. */
export const MANAGED_RUNTIME_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const LOCAL_CAPABILITY_DIGEST = `sha256:${createHash('sha256')
  .update('qwen-code/managed-session-runtime/1')
  .digest('hex')}`;
type RouteKey = 'attest' | 'execute' | 'status' | 'cancel';

interface StartedWorker {
  readonly tracked: TrackedChildProcess;
  readonly url: URL;
  readonly boot: ManagedRuntimeWorkerBoot;
  readonly routes: ReadonlyMap<string, string>;
  /** The header in which the worker names its incarnation, in lower case. */
  readonly incarnationHeader: string;
  /**
   * Aborted once the worker exited: its port may then belong to any process,
   * so nothing is sent there again.
   */
  readonly gone: AbortSignal;
}

interface WorkerResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The worker could not be reached, or answered outside the protocol. */
class WorkerTransportError extends Error {
  /** Whether the request never reached the worker, so nothing ran. */
  readonly undelivered: boolean;

  constructor(message: string, options?: ErrorOptions, undelivered?: boolean) {
    super(message, options);
    this.undelivered =
      undelivered ??
      (options?.cause as NodeJS.ErrnoException | undefined)?.code ===
        'ECONNREFUSED';
  }
}

// Node reads `_` for `-` in option names, so `--inspect_brk` opens one too.
const INSPECT_FLAGS: ReadonlySet<string> = new Set([
  '--inspect',
  '--inspect-brk',
  '--inspect-brk-node',
  '--inspect-wait',
  '--inspect-port',
  '--debug-port',
]);
// An options file would give the worker again what was removed from its
// environment, such as an inspector flag in NODE_OPTIONS.
const OPTIONS_FILE_FLAGS: ReadonlySet<string> = new Set([
  '--env-file',
  '--env-file-if-exists',
  '--experimental-config-file',
  '--experimental-default-config-file',
]);
// These take their value as the next entry unless it follows `=`.
const SEPARATE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--inspect-port',
  '--debug-port',
  '--env-file',
  '--env-file-if-exists',
  '--experimental-config-file',
]);

/** The positions of the options the worker must not start with. */
function withheldOptionIndexes(options: readonly string[]): Set<number> {
  const indexes = new Set<number>();
  for (let index = 0; index < options.length; index++) {
    const option = options[index]!;
    if (!option.startsWith('--')) continue;
    const flag = option.split('=', 1)[0]!.replaceAll('_', '-');
    if (!INSPECT_FLAGS.has(flag) && !OPTIONS_FILE_FLAGS.has(flag)) continue;
    indexes.add(index);
    if (SEPARATE_VALUE_FLAGS.has(flag) && !option.includes('=')) {
      indexes.add(++index);
    }
  }
  return indexes;
}

/**
 * The Node options the worker starts with: these without the inspector flags,
 * which would open a debugger, or stop at the first line until one attaches,
 * and without options files.
 */
export function workerExecArgv(options: readonly string[]): string[] {
  const indexes = withheldOptionIndexes(options);
  return options.filter((_, index) => !indexes.has(index));
}

/**
 * A `NODE_OPTIONS` value without its inspector flags, or the value itself when
 * it holds none. Node splits the value at spaces outside double quotes, where
 * a backslash escapes the next character; every option kept is copied as
 * written, so a quoted path keeps its spacing.
 */
export function nodeOptionsWithoutInspectFlags(value: string): string {
  const entries: Array<{ option: string; written: string }> = [];
  let option = '';
  let written = '';
  let quoted = false;
  const endEntry = (): void => {
    // As in Node, an entry such as `""` names no option.
    if (option !== '') entries.push({ option, written });
    option = '';
    written = '';
  };
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === ' ' && !quoted) {
      endEntry();
      continue;
    }
    written += char;
    if (char === '"') {
      quoted = !quoted;
    } else if (char === '\\' && quoted && index + 1 < value.length) {
      option += value[++index];
      written += value[index];
    } else {
      option += char;
    }
  }
  endEntry();
  const indexes = withheldOptionIndexes(entries.map((entry) => entry.option));
  if (indexes.size === 0) return value;
  return entries
    .filter((_, index) => !indexes.has(index))
    .map((entry) => entry.written)
    .join(' ');
}

export interface ManagedRuntimeWorkerLaunch {
  /** The node binary and arguments that start the worker command. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/** The worker command of the CLI this process runs. */
export function currentCliWorkerLaunch(): ManagedRuntimeWorkerLaunch {
  const cliEntry = process.env['QWEN_CLI_ENTRY'] || process.argv[1];
  if (!cliEntry) {
    throw new Error('The Managed Runtime worker needs the CLI entry script.');
  }
  // The worker boots as this process did, with the loader vars its boot
  // scrub removed; the worker scrubs them from its own commands.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(processBootLoaderEnv),
  };
  // Node reads inspector flags from NODE_OPTIONS too, where execArgv does not
  // show them, and on Windows under any spelling of its name.
  for (const key of Object.keys(env)) {
    const nodeOptions = env[key];
    if (!isNodeOptionsEnvKey(key) || nodeOptions === undefined) continue;
    const kept = nodeOptionsWithoutInspectFlags(nodeOptions);
    if (kept === nodeOptions) continue;
    if (kept !== '') env[key] = kept;
    else delete env[key];
  }
  return {
    command: process.execPath,
    args: [
      ...workerExecArgv(process.execArgv),
      cliEntry,
      'managed-runtime-worker',
    ],
    env,
  };
}

/**
 * The Runtime worker of one Managed session: `qwen managed-runtime-worker`
 * with boot v1, started on the first call and bound to the session's
 * directory. The session owns it exclusively; its process tree is tracked so
 * closing proves every known process group gone.
 */
export class ManagedSessionRuntimeWorker {
  private readonly registry = new ProcessRegistry();
  private starting?: Promise<StartedWorker>;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly directory: string,
    private readonly launch: () => ManagedRuntimeWorkerLaunch = currentCliWorkerLaunch,
    private readonly cancelSettleTimeoutMs = CANCEL_SETTLE_TIMEOUT_MS,
  ) {}

  /**
   * Runs one call to its settled result. A call the worker refused or could
   * not start resolves `not_started`; a call whose outcome cannot be learned
   * rejects with {@link ManagedRuntimeOutcomeUnknownError}. `callId`, the
   * host's id for the call, names it in the worker's journal too.
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    callId: string = randomUUID(),
  ): Promise<ManagedToolResultPayload> {
    signal.throwIfAborted();
    // The parameters as the wire carries them: a built invocation can hold
    // keys whose value is undefined, which JSON drops.
    input = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const argsDigest = `sha256:${managedToolDigest(input)}`;
    // Starting can take a while: a call cancelled meanwhile returns at once,
    // and the worker goes on starting for the session's next call.
    let stopWatching = () => {};
    const cancelled = new Promise<undefined>((resolve) => {
      const onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      stopWatching = () => signal.removeEventListener('abort', onAbort);
    });
    let worker: StartedWorker | undefined;
    try {
      worker = await Promise.race([this.start(), cancelled]);
    } catch (error) {
      if (this.closed) {
        throw new Error('The Managed session is closing.', { cause: error });
      }
      throw error;
    } finally {
      stopWatching();
    }
    // A session closed or a call cancelled while the worker started is not
    // sent.
    if (this.closed) throw new Error('The Managed session is closing.');
    if (worker === undefined || signal.aborted) {
      return { executionStatus: 'cancelled', responseParts: [] };
    }
    const reference: ManagedToolReference = {
      sessionId: this.sessionId,
      promptId: promptIdContext.getStore() ?? 'unknown',
      callId,
      argsDigest,
    };
    let settled = false;
    let cancelling: Promise<void> | undefined;
    // A cancelled call that has not settled by then has an unknown outcome.
    const giveUp = new AbortController();
    // Ends the cancel retries however the call ended.
    const ended = new AbortController();
    let giveUpTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      giveUpTimer = setTimeout(
        () => giveUp.abort(),
        this.cancelSettleTimeoutMs,
      );
      cancelling = (async () => {
        // A cancel can overtake its call: until the worker has recorded the
        // call, it does not know the reference.
        while (!ended.signal.aborted && !giveUp.signal.aborted) {
          const answer = await this.request(worker, 'cancel', {
            protocolVersion: 2,
            reference,
          }).catch(() => undefined);
          if (
            (answer?.body as { state?: unknown } | undefined)?.state !==
            'unknown'
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
        }
      })();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      let response: WorkerResponse | undefined;
      try {
        response = await this.request(
          worker,
          'execute',
          { protocolVersion: 2, reference, toolName, input },
          giveUp.signal,
        );
      } catch (error) {
        if (!(error instanceof WorkerTransportError)) throw error;
        if (error.undelivered) {
          // The worker was gone before the call reached it.
          this.forget(worker);
          settled = true;
          return {
            executionStatus: 'not_started',
            responseParts: [],
            error: { message: 'The Runtime worker was not running.' },
          };
        }
        // A broken connection often means the worker died: let its exit
        // land before asking anything on the port it held.
        await exitOrTimeout(worker.gone, EXIT_GRACE_MS);
      }
      if (response?.status === 200) {
        const result = settledResult(response.body);
        if (result) {
          settled = true;
          return result;
        }
      } else if (
        response !== undefined &&
        response.status >= 400 &&
        response.status < 500
      ) {
        // The worker refuses a call before it journals or runs it.
        settled = true;
        return {
          executionStatus: 'not_started',
          responseParts: [],
          error: { message: refusalMessage(response.body) },
        };
      }
      const result = await this.awaitSettlement(
        worker,
        reference,
        giveUp.signal,
      );
      settled = true;
      return result;
    } finally {
      ended.abort();
      signal.removeEventListener('abort', cancel);
      clearTimeout(giveUpTimer);
      if (!settled) await cancelling;
    }
  }

  /**
   * Terminates the process tree of every worker the session started and
   * waits until each is gone.
   */
  async close(): Promise<void> {
    this.closed = true;
    // A worker that is starting is in the registry from its spawn on, and a
    // launch that has not spawned yet finds the registry draining.
    try {
      await this.registry.shutdown();
    } catch (error) {
      // A worker that had to be killed, as Windows always does, is gone all
      // the same; only a tree that could not be proven gone is a failure.
      const failures = error instanceof AggregateError ? error.errors : [error];
      const unproven = failures.filter(
        (failure) => !(failure instanceof ProcessExitError),
      );
      if (unproven.length > 0) {
        throw new AggregateError(unproven, 'The Runtime worker did not stop.');
      }
    }
  }

  private async awaitSettlement(
    worker: StartedWorker,
    reference: ManagedToolReference,
    giveUp: AbortSignal,
  ): Promise<ManagedToolResultPayload> {
    while (true) {
      // A worker that exited cannot answer for the call, and its port may now
      // belong to another process; one being closed is about to.
      if (worker.gone.aborted || this.closed) {
        throw new ManagedRuntimeOutcomeUnknownError(
          'The Runtime worker exited during a tool call.',
        );
      }
      // One last look once the wait is over: the call may just have settled.
      const lastLook = giveUp.aborted;
      let response: WorkerResponse;
      try {
        response = await this.request(worker, 'status', {
          protocolVersion: 2,
          reference,
        });
      } catch (error) {
        throw new ManagedRuntimeOutcomeUnknownError(
          'The Runtime worker stopped answering for a tool call.',
          { cause: error },
        );
      }
      const body = response.body as { state?: unknown } | undefined;
      if (response.status !== 200 || body?.state === 'unknown') {
        throw new ManagedRuntimeOutcomeUnknownError(
          'The Runtime worker does not know how a tool call ended.',
        );
      }
      const result = settledResult(response.body);
      if (result) return result;
      if (lastLook) {
        throw new ManagedRuntimeOutcomeUnknownError(
          'A cancelled Runtime tool call did not settle.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
    }
  }

  private start(): Promise<StartedWorker> {
    if (this.closed) {
      return Promise.reject(new Error('The Managed session is closing.'));
    }
    if (this.starting) return this.starting;
    const starting = this.launchWorker();
    this.starting = starting;
    // A worker that failed to start, or exited between calls, is replaced.
    const forget = () => {
      if (this.starting === starting && !this.closed) this.starting = undefined;
    };
    void starting.then(({ tracked }) => tracked.exited.then(forget), forget);
    return starting;
  }

  /** Stops `worker` and lets the next call start a new one in its place. */
  private forget(worker: StartedWorker): void {
    void worker.tracked.terminate().catch(() => undefined);
    void this.starting?.then(
      (current) => {
        if (current === worker && !this.closed) this.starting = undefined;
      },
      // A replacement that failed to start is forgotten by start() itself.
      () => undefined,
    );
  }

  private async launchWorker(): Promise<StartedWorker> {
    const boot: ManagedRuntimeWorkerBoot = {
      type: 'boot',
      version: 1,
      token: randomBytes(32).toString('hex'),
      runtimeInstanceId: this.sessionId,
      runtimeIncarnation: randomUUID(),
      leaseId: randomUUID(),
      epoch: 1,
      provisionRequestId: randomUUID(),
      tenantId: 'local',
      workspaceId: 'local',
      workspaceGeneration: '1',
      workspaceCwd: this.directory,
      capabilityDigest: LOCAL_CAPABILITY_DIGEST,
      isolationClass: 'session',
    };
    // Loaded on first use: the route table brings the worker's HTTP stack.
    const { MANAGED_RUNTIME_INCARNATION_HEADER, OWNED_MANAGED_RUNTIME_ROUTES } =
      await import('./managed-runtime-attestation-contract.js');
    const routes = new Map<string, string>(
      OWNED_MANAGED_RUNTIME_ROUTES.map((route) => [route.key, route.path]),
    );
    const launch = this.launch();
    const reservation = this.registry.reserve();
    let child;
    try {
      child = spawn(launch.command, [...launch.args], {
        cwd: this.directory,
        env: launch.env ?? process.env,
        // The IPC channel carries no messages: the worker exits when it closes.
        stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      reservation.cancel();
      throw error;
    }
    const tracked = reservation.attach(child, { ownsProcessTree: true });
    const gone = new AbortController();
    void tracked.exited.then(
      () => gone.abort(),
      () => gone.abort(),
    );
    try {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(JSON.stringify(boot));
      const ready = await readReady(child.stdout!, tracked);
      if (
        ready.type !== 'ready' ||
        ready.version !== 1 ||
        ready.runtimeInstanceId !== boot.runtimeInstanceId ||
        ready.runtimeIncarnation !== boot.runtimeIncarnation ||
        ready.leaseId !== boot.leaseId ||
        ready.epoch !== boot.epoch ||
        typeof ready.url !== 'string' ||
        !/^http:\/\/127\.0\.0\.1:\d+$/u.test(ready.url)
      ) {
        throw new Error('The Managed Runtime worker is not the one started.');
      }
      const worker = {
        tracked,
        url: new URL(ready.url),
        boot,
        routes,
        incarnationHeader: MANAGED_RUNTIME_INCARNATION_HEADER.toLowerCase(),
        gone: gone.signal,
      };
      const attested = await this.request(worker, 'attest', {
        protocolVersion: 2,
        provisionRequestId: boot.provisionRequestId,
        tenantId: boot.tenantId,
        workspaceId: boot.workspaceId,
        workspaceGeneration: boot.workspaceGeneration,
        workspaceCwd: boot.workspaceCwd,
        capabilityDigest: boot.capabilityDigest,
        isolationClass: boot.isolationClass,
      });
      const identity = attested.body as Record<string, unknown> | undefined;
      if (
        attested.status !== 200 ||
        identity?.['runtimeIncarnation'] !== boot.runtimeIncarnation ||
        identity?.['leaseId'] !== boot.leaseId
      ) {
        throw new Error('The Managed Runtime worker failed attestation.');
      }
      return worker;
    } catch (error) {
      await tracked.terminate().catch(() => undefined);
      throw error;
    }
  }

  private request(
    worker: StartedWorker,
    route: RouteKey,
    body: unknown,
    stop?: AbortSignal,
  ): Promise<WorkerResponse> {
    if (worker.gone.aborted) {
      // Nothing is sent to a port the worker no longer holds.
      return Promise.reject(
        new WorkerTransportError('The Runtime worker exited.', undefined, true),
      );
    }
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: worker.url.hostname,
          port: worker.url.port,
          path: worker.routes.get(route),
          method: 'POST',
          // A fresh connection per call: a reused socket the worker closed
          // would fail a call the worker never saw.
          agent: false,
          headers: {
            Authorization: `Bearer ${worker.boot.token}`,
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json',
            'Content-Length': payload.byteLength,
            'X-Qwen-Managed-Lease-Id': worker.boot.leaseId,
            'X-Qwen-Managed-Lease-Epoch': String(worker.boot.epoch),
          },
        },
        (response) => {
          // Attestation proved who listens on the port; from then on only
          // the worker can name its incarnation, which no request carries.
          // An answer read as a result or a state must name it. A refusal
          // needs not: whoever sent it, the request did not run.
          if (
            route !== 'attest' &&
            response.statusCode === 200 &&
            response.headers[worker.incarnationHeader] !==
              worker.boot.runtimeIncarnation
          ) {
            reject(
              new WorkerTransportError(
                'The Runtime worker did not answer as itself.',
              ),
            );
            request.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MANAGED_RUNTIME_RESPONSE_LIMIT_BYTES) {
              response.destroy(
                new WorkerTransportError(
                  'Runtime worker response is too large.',
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', (error) =>
            reject(new WorkerTransportError(error.message, { cause: error })),
          );
          response.on('end', () => {
            let parsed: unknown;
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              parsed = text.length > 0 ? JSON.parse(text) : undefined;
            } catch (error) {
              reject(
                new WorkerTransportError(
                  'Runtime worker response is invalid.',
                  {
                    cause: error,
                  },
                ),
              );
              return;
            }
            resolve({ status: response.statusCode ?? 0, body: parsed });
          });
        },
      );
      request.on('error', (error) =>
        reject(new WorkerTransportError(error.message, { cause: error })),
      );
      const exited = () =>
        request.destroy(new WorkerTransportError('The Runtime worker exited.'));
      worker.gone.addEventListener('abort', exited, { once: true });
      request.on('close', () =>
        worker.gone.removeEventListener('abort', exited),
      );
      if (stop) {
        const abandon = () =>
          request.destroy(new WorkerTransportError('Abandoned the request.'));
        if (stop.aborted) abandon();
        else stop.addEventListener('abort', abandon, { once: true });
        request.on('close', () => stop.removeEventListener('abort', abandon));
      } else {
        request.setTimeout(CONTROL_REQUEST_TIMEOUT_MS, () =>
          request.destroy(new WorkerTransportError('The request timed out.')),
        );
      }
      request.end(payload);
    });
  }
}

/** Whether `candidate` is `root` or lies below it. */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(root),
    path.resolve(root, candidate),
  );
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function exitOrTimeout(gone: AbortSignal, ms: number): Promise<void> {
  if (gone.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      gone.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    gone.addEventListener('abort', done, { once: true });
  });
}

function readReady(
  stdout: NodeJS.ReadableStream,
  tracked: TrackedChildProcess,
): Promise<ManagedRuntimeWorkerReady> {
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  return new Promise<ManagedRuntimeWorkerReady>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, ready?: ManagedRuntimeWorkerReady) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(ready!);
    };
    const timer = setTimeout(
      () => finish(new Error('The Managed Runtime worker did not get ready.')),
      READY_TIMEOUT_MS,
    );
    timer.unref();
    lines.on('line', (line) => {
      // Later output is drained so the worker never blocks on its pipe.
      if (settled) return;
      try {
        finish(undefined, JSON.parse(line) as ManagedRuntimeWorkerReady);
      } catch {
        finish(new Error('The Managed Runtime worker is not ready.'));
      }
    });
    void tracked.exited.then(() =>
      finish(
        new Error('The Managed Runtime worker exited before it was ready.'),
      ),
    );
  });
}

function settledResult(body: unknown): ManagedToolResultPayload | undefined {
  const view = body as
    | { state?: unknown; result?: ManagedToolResultPayload }
    | undefined;
  return view?.state === 'settled' && view.result ? view.result : undefined;
}

function refusalMessage(body: unknown): string {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === 'string'
    ? error
    : 'The Runtime worker refused the tool call.';
}

/** The tool result the host reports for a worker's settled payload. */
export function toToolResult(payload: ManagedToolResultPayload): ToolResult {
  // The worker marks text parts with a `type` that model parts do not have.
  const parts = payload.responseParts.map((part): Part => {
    const { type, ...rest } = part as { type?: unknown } & Record<
      string,
      unknown
    >;
    return (type === 'text' ? rest : part) as Part;
  });
  const text = parts
    .map((part) => (part as { text?: unknown }).text)
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  if (payload.executionStatus === 'success') {
    return { llmContent: parts, returnDisplay: text };
  }
  const message =
    payload.error?.message ??
    (payload.executionStatus === 'cancelled'
      ? 'The tool call was cancelled.'
      : 'The tool call failed.');
  return {
    llmContent: parts.length > 0 ? parts : message,
    returnDisplay: text || message,
    error: {
      message,
      // The worker's tools report the same error types, such as a timeout.
      ...(payload.error?.type
        ? { type: payload.error.type as ToolErrorType }
        : {}),
    },
  };
}

/**
 * The environment of a Managed session's tools: each call is prepared and
 * permission-checked in this process with the real tool, then runs with its
 * final parameters in the session's Runtime worker. An unknown outcome
 * blocks the session.
 */
export function createManagedRuntimeEnvironment(
  config: Config,
  launch?: () => ManagedRuntimeWorkerLaunch,
): ExecutionEnvironment {
  // The worker is bound to this directory for its lifetime, so the host
  // judges a Shell `directory` against the same one.
  const sessionDirectory = config.getTargetDir();
  const worker = new ManagedSessionRuntimeWorker(
    config.getSessionId(),
    sessionDirectory,
    launch,
  );
  const prepared = new LocalExecutionEnvironment(config, {
    toolNames: MANAGED_RUNTIME_TOOL_NAMES,
    run: async (call, signal) => {
      try {
        const result = toToolResult(
          await worker.execute(call.toolName, call.params, signal, call.id),
        );
        // As Legacy, a read shows no copy of the file it returns.
        return call.toolName === ToolNames.READ_FILE && !result.error
          ? { ...result, returnDisplay: '' }
          : result;
      } catch (error) {
        if (error instanceof ManagedRuntimeOutcomeUnknownError) {
          config.blockManagedSession(error);
          await worker.close().catch(() => undefined);
        }
        throw error;
      }
    },
  });
  return {
    toolNames: prepared.toolNames,
    prepare: async (request, signal) => {
      const preparation = await prepared.prepare(request, signal);
      // The worker runs foreground Shell only, in the session's directory:
      // refuse before asking what it would refuse. The prepared parameters
      // are the validated ones.
      if (request.toolName === ToolNames.SHELL) {
        const directory = preparation.params['directory'];
        const refusal =
          preparation.params['is_background'] === true
            ? 'A Managed session runs shell commands in the foreground only.'
            : typeof directory === 'string' &&
                directory !== '' &&
                !isWithin(sessionDirectory, directory)
              ? `A Managed session runs shell commands only in ${sessionDirectory}.`
              : undefined;
        if (refusal) {
          await prepared.release(request.id, signal);
          throw new Error(refusal);
        }
      }
      return preparation;
    },
    permission: (id, signal) => prepared.permission(id, signal),
    confirmation: (id, signal) => prepared.confirmation(id, signal),
    confirm: (id, outcome, payload, signal) =>
      prepared.confirm(id, outcome, payload, signal),
    execute: (id, signal, updateOutput) =>
      prepared.execute(id, signal, updateOutput),
    modificationContent: (toolName, params, signal) =>
      prepared.modificationContent(toolName, params, signal),
    release: (id, signal) => prepared.release(id, signal),
    invalidateReadCache: () => Promise.resolve(),
    dispose: async () => {
      try {
        await prepared.dispose();
      } finally {
        await worker.close();
      }
    },
  };
}
