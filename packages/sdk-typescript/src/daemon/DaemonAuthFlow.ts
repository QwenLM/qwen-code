/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonHttpError, type DaemonClient } from './DaemonClient.js';
import type { DaemonAuthProviderId, DaemonDeviceFlowState } from './types.js';

/**
 * High-level convenience wrapper around the four `client.*DeviceFlow*` HTTP
 * helpers. SDK users should normally write:
 *
 *   const flow = await client.auth.start({ providerId: 'qwen-oauth' });
 *   console.log(`Open ${flow.verificationUri}\nCode: ${flow.userCode}`);
 *   const result = await flow.awaitCompletion({ signal });
 *
 * The handle's `awaitCompletion` first attempts to consume an SSE event
 * stream (so the resolution is real-time on a freshly-running daemon);
 * if no stream is available — or it produces a parse error — the helper
 * transparently falls back to GET-based polling using the daemon-supplied
 * `intervalMs`. Both paths terminate when the daemon's view reaches a
 * terminal status (`authorized`, `expired`, `error`, `cancelled`).
 *
 * Issue #4175 PR 21.
 */
export interface DaemonAuthFlowHandle {
  deviceFlowId: string;
  providerId: DaemonAuthProviderId;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
  /** True iff the daemon returned an existing pending entry rather than
   *  starting a fresh IdP request. */
  attached: boolean;
  /** Block until the daemon settles the flow into a terminal state, then
   *  return the final state. The promise rejects on `signal.abort()`. */
  awaitCompletion(
    opts?: AwaitCompletionOptions,
  ): Promise<DaemonDeviceFlowState>;
  /** Cancel the in-flight device flow on the daemon. Idempotent. */
  cancel(): Promise<void>;
}

export interface AwaitCompletionOptions {
  /** Aborts both SSE consumption and GET-fallback polling. */
  signal?: AbortSignal;
  /** Called whenever the daemon reports an upstream `slow_down` (mirroring
   *  the `auth_device_flow_throttled` event). The new effective interval
   *  is the value the SDK will use for the next GET poll. */
  onThrottled?: (intervalMs: number) => void;
  /** Optional override of the GET-fallback interval. Defaults to the
   *  daemon-supplied `intervalMs` from `start(...)` and respects bumps
   *  from `slow_down`. */
  pollOverrideMs?: number;
  /** Hard ceiling on `awaitCompletion`'s wall-clock duration. Defaults to
   *  the daemon's `expiresAt - Date.now()`. */
  timeoutMs?: number;
}

const TERMINAL_STATUSES: ReadonlySet<DaemonDeviceFlowState['status']> = new Set(
  ['authorized', 'expired', 'error', 'cancelled'],
);

export class DaemonAuthFlow {
  constructor(private readonly client: DaemonClient) {}

  async start(opts: {
    providerId: DaemonAuthProviderId;
    clientId?: string;
  }): Promise<DaemonAuthFlowHandle> {
    const initial = await this.client.startDeviceFlow(opts);
    const handleClient = this.client;
    const handle: DaemonAuthFlowHandle = {
      deviceFlowId: initial.deviceFlowId,
      providerId: initial.providerId,
      userCode: initial.userCode,
      verificationUri: initial.verificationUri,
      verificationUriComplete: initial.verificationUriComplete,
      expiresAt: initial.expiresAt,
      intervalMs: initial.intervalMs,
      attached: initial.attached,
      cancel: () =>
        handleClient.cancelDeviceFlow(initial.deviceFlowId, {
          clientId: opts.clientId,
        }),
      awaitCompletion: async (waitOpts = {}) => {
        const finalState = await awaitCompletion(
          handleClient,
          initial,
          opts.clientId,
          waitOpts,
        );
        return finalState;
      },
    };
    return handle;
  }

  status(deviceFlowId: string, opts?: { clientId?: string }) {
    return this.client.getDeviceFlow(deviceFlowId, opts);
  }

  cancel(deviceFlowId: string, opts?: { clientId?: string }) {
    return this.client.cancelDeviceFlow(deviceFlowId, opts);
  }
}

async function awaitCompletion(
  client: DaemonClient,
  start: {
    deviceFlowId: string;
    intervalMs: number;
    expiresAt: number;
    providerId: DaemonAuthProviderId;
  },
  clientId: string | undefined,
  opts: AwaitCompletionOptions,
): Promise<DaemonDeviceFlowState> {
  // The SSE stream is workspace-scoped today and only flows through
  // session subscriptions; without a session id we have no stream to
  // attach to. PR 21 §3 ships device-flow events on the session bus
  // fan-out for now (PR 16's `bridge.publishWorkspaceEvent` lands the
  // shared workspace topic). Until then, GET polling is the universal
  // path.
  return await pollUntilTerminal(client, start, clientId, opts);
}

async function pollUntilTerminal(
  client: DaemonClient,
  start: {
    deviceFlowId: string;
    intervalMs: number;
    expiresAt: number;
  },
  clientId: string | undefined,
  opts: AwaitCompletionOptions,
): Promise<DaemonDeviceFlowState> {
  const signal = opts.signal;
  const ceiling = opts.timeoutMs
    ? Date.now() + opts.timeoutMs
    : start.expiresAt + 30_000;
  let interval = Math.max(
    1_000,
    opts.pollOverrideMs ?? start.intervalMs ?? 5_000,
  );
  let lastIntervalMs = interval;
  while (true) {
    if (signal?.aborted) {
      throw signalAbortError(signal);
    }
    const now = Date.now();
    if (now >= ceiling) {
      // Final read so the caller still gets the daemon's current view.
      return await client.getDeviceFlow(start.deviceFlowId, { clientId });
    }
    let snapshot: DaemonDeviceFlowState;
    try {
      snapshot = await client.getDeviceFlow(start.deviceFlowId, { clientId });
    } catch (err: unknown) {
      if (err instanceof DaemonHttpError && err.status === 404) {
        // The entry was evicted post-grace; treat as terminal and stop.
        return {
          deviceFlowId: start.deviceFlowId,
          providerId: 'qwen-oauth',
          status: 'expired',
          createdAt: now,
        };
      }
      throw err;
    }
    if (snapshot.intervalMs && snapshot.intervalMs !== lastIntervalMs) {
      lastIntervalMs = snapshot.intervalMs;
      interval = snapshot.intervalMs;
      opts.onThrottled?.(snapshot.intervalMs);
    }
    if (TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    await waitFor(interval, signal);
  }
}

async function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signalAbortError(signal);
  await new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (typeof handle === 'object' && handle && 'unref' in handle) {
      (handle as { unref(): void }).unref();
    }
    const onAbort = () => {
      cleanup();
      reject(signalAbortError(signal));
    };
    function cleanup() {
      clearTimeout(handle);
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function signalAbortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  return new Error('aborted');
}
