/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { HostedApprovalContinuation } from './hosted-approval-continuation.js';
import type { HostedApprovalWaiters } from './hosted-tool-approval.js';
import {
  HostedWorkspaceBrokerRejection,
  type HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';

// The owed handback's cadence: a quick backoff for the common late settle,
// then a steady one-minute tail — the chain stays owed until the handback
// lands, every timer unref'd so a blocked Session never holds the daemon's
// event loop open, and every attempt re-reads the Broker's gate, never
// bypasses it.
export const BLOCK_MOUNT_RETRY_GAPS_MS = [
  1000, 3000, 5000, 10000, 30000, 60000,
];
// The block verdict never waits out a slow Broker round-trip: it proceeds
// once the first handback attempt settles or this bound passes, whichever
// is first — the attempt itself keeps running inside the retry chain.
export const RELEASE_MOUNT_VERDICT_BOUND_MS = 2000;
// A reply that decided nothing earns a re-send — the holder-conditioned
// clear is idempotent — and so do the busy refusal, whose executions settle
// on their own clock, and the Broker's internal error. Every other refusal
// is final: a superseded claim, a lifecycle drain, a writer that never
// proved it stopped, a Session the Broker no longer holds.
export function retryableMountHandback(cause: unknown): boolean {
  if (!(cause instanceof HostedWorkspaceBrokerRejection)) return true;
  return (
    (cause.status === 409 && cause.code === 'runtime_session_busy') ||
    (cause.status === 500 && cause.code === 'runtime_broker_internal_error')
  );
}

export function questionWaitDefinitionAdmitted(
  definition: Record<string, unknown> | null,
  expectedDepth?: number,
): boolean {
  if (
    !definition ||
    typeof definition !== 'object' ||
    Array.isArray(definition) ||
    definition['foregroundOnly'] === true ||
    definition['mcpServers'] !== undefined ||
    definition['hookCatalog'] !== undefined ||
    definition['publicChildExtensionAgent'] !== undefined ||
    ![
      'hosted-workspace-files/1',
      'hosted-workspace-files/2',
      'hosted-workspace-files/3',
      'hosted-workspace-files/4',
      'hosted-workspace-shell/1',
      'hosted-workspace-shell/3',
      'hosted-workspace-shell/4',
    ].includes(String(definition['toolProfile'] ?? 'hosted-workspace-files/1'))
  )
    return false;
  const lineage = definition['lineage'];
  if (lineage === undefined)
    return expectedDepth === undefined || expectedDepth === 0;
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage))
    return false;
  const child = lineage as Record<string, unknown>;
  return (
    definition['publicChildAgentsVersion'] === 1 &&
    (expectedDepth === undefined || expectedDepth === 1) &&
    (definition['toolProfile'] === 'hosted-workspace-shell/1' ||
      definition['toolProfile'] === 'hosted-workspace-shell/3' ||
      definition['toolProfile'] === 'hosted-workspace-shell/4') &&
    child['depth'] === 1 &&
    typeof child['parentSessionId'] === 'string' &&
    child['parentSessionId'] === child['rootSessionId'] &&
    typeof child['parentChildRunId'] === 'string' &&
    child['parentChildRunId'].length > 0
  );
}

export async function acquireHostedQuestionRuntime(
  broker: HostedWorkspaceBroker,
  original: NonNullable<HostedApprovalContinuation['runtime']>,
  signal: AbortSignal,
  expiresAt?: number,
): Promise<boolean> {
  if (
    original.provisionerKind !== 'local-process' ||
    broker.runtimeSessionId !== original.runtimeSessionId
  )
    throw new Error('Original question Runtime is not qualified.');
  for (;;) {
    if (signal.aborted || (expiresAt !== undefined && Date.now() >= expiresAt))
      return false;
    try {
      await broker.acquire({
        runtimeBindingId: original.bindingId,
        generation: original.generation,
      });
      break;
    } catch (cause) {
      if (
        !(cause instanceof HostedWorkspaceBrokerRejection) ||
        cause.status !== 409 ||
        cause.code !== 'workspace_busy'
      )
        throw cause;
      try {
        await delay(
          Math.min(
            250,
            // A timer can fire up to 1 ms before the requested wall-clock
            // delay; overshoot the deadline so the next check cannot land a
            // millisecond short and issue an acquire past it.
            expiresAt === undefined
              ? 250
              : Math.max(0, expiresAt - Date.now()) + 1,
          ),
          undefined,
          { signal, ref: false },
        );
      } catch (cause) {
        // Only the definite busy refusal proves this attempt acquired nothing.
        if (signal.aborted) return false;
        throw cause;
      }
    }
  }
  if (
    broker.runtime?.bindingId !== original.bindingId ||
    broker.runtime.generation !== original.generation ||
    broker.runtime.workspaceGeneration !== original.workspaceGeneration ||
    broker.provisionerKind !== original.provisionerKind
  )
    throw new Error('Original question Runtime identity changed.');
  return true;
}

export async function waitForHostedQuestion(options: {
  session: ManagedSession;
  broker: HostedWorkspaceBroker;
  brokerOptions: HostedWorkspaceBrokerOptions;
  waiters: HostedApprovalWaiters;
  requestId: string;
  expiresAt: number;
  signal: AbortSignal;
  released?: () => void;
}): Promise<void> {
  const { session, broker, waiters, requestId, expiresAt, signal } = options;
  const claim = broker.mountClaim();
  if (claim === undefined)
    throw new Error('Original question mount claim is unavailable.');
  const stop = new AbortController();
  let failure: unknown;
  const pending = () =>
    !stop.signal.aborted &&
    !signal.aborted &&
    !session.authority.writesStopped &&
    Date.now() < expiresAt &&
    session.authority.action(requestId)?.state === 'requested';
  const finish = () => {
    stop.abort();
    waiters.notify(requestId);
  };
  const attempt = async (): Promise<boolean> => {
    if (!pending()) return false;
    try {
      await broker.releaseMount(claim);
      if (!stop.signal.aborted && broker.mountClaim() === claim)
        options.released?.();
      return false;
    } catch (cause) {
      if (!pending() || broker.mountClaim() !== claim) return false;
      if (retryableMountHandback(cause)) return true;
      failure = cause;
      waiters.notify(requestId);
      return false;
    }
  };
  const waiting = waiters.wait(
    requestId,
    expiresAt,
    signal,
    () => !pending() || failure !== undefined,
  );
  options.brokerOptions.mountHandbacks?.add(finish);
  signal.addEventListener('abort', finish, { once: true });
  const first = attempt();
  const retry = (async () => {
    let again = await first;
    for (let index = 0; again && pending(); index++) {
      await delay(
        BLOCK_MOUNT_RETRY_GAPS_MS[
          Math.min(index, BLOCK_MOUNT_RETRY_GAPS_MS.length - 1)
        ],
        undefined,
        { signal: stop.signal, ref: false },
      );
      again = await attempt();
    }
  })();
  void retry.catch((cause: unknown) => {
    if (!stop.signal.aborted) {
      failure = cause;
      waiters.notify(requestId);
    }
  });
  try {
    await Promise.race([
      first,
      waiting,
      delay(RELEASE_MOUNT_VERDICT_BOUND_MS, undefined, {
        signal: stop.signal,
        ref: false,
      }).catch(() => undefined),
    ]);
    await waiting;
    if (failure !== undefined) throw failure;
    if (stop.signal.aborted && !signal.aborted)
      throw new Error('Question wait stopped with its Runtime still owed.');
  } finally {
    finish();
    signal.removeEventListener('abort', finish);
    options.brokerOptions.mountHandbacks?.delete(finish);
  }
}
