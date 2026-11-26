/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ManagedSessionLifecycleAuthority,
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type { HarnessRunAuthorization } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import {
  ManagedSessionAppendUnsettledError,
  ManagedSessionJournalFencedError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { sanitizeDaemonLogLine } from '../../utils/stdioHelpers.js';
import type { HostedRecoveryDeclineReason } from '../hosted-runtime-recovery.js';
import type { HostedRefusalReason } from '../hosted-tool-approval.js';
import { markAccessLogError } from '../server/access-log.js';
import type { HostedSession } from './session-state.js';

const CLIENT = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * The wedge family #13800 names: a turn that dies against its Session store
 * ends with a named, caller-visible reason, never a silent freeze. Only
 * transport and server-5xx failures reclassify: per-Session refusals
 * (writer conflicts, recovery blocks) keep their own names. A bounded
 * tenant-guard wait is not an outage either — the store answered it
 * promptly with a retryable contention refusal — so it stays unattributed
 * rather than naming the store unavailable. A stopped writer reads as
 * unattributed here; `blockRecovery` keeps the name it already carries.
 */
export function namedStoreFailure(cause: unknown): string | undefined {
  if (
    cause instanceof ManagedSessionAppendUnsettledError ||
    cause instanceof ManagedSessionJournalFencedError ||
    cause instanceof ManagedSessionStoreTransportError ||
    (cause instanceof ManagedSessionStoreHttpError &&
      cause.status >= 500 &&
      cause.remoteCode !== 'tenant_guard_contended')
  ) {
    return 'managed_session_store_unavailable';
  }
  return undefined;
}

/**
 * Renders a store refusal with its stable status, remote code, refusing
 * route and any writer-vs-store-head pairing captured at the refusal
 * (review #14522): the store's public refusal text is shared across
 * server predicates, so the printable error has to name which operation
 * with which grant was refused (a grant never re-acquired vs one the
 * store already judged superseded).
 */
export function describeManagedError(cause: unknown): string {
  let store: ManagedSessionStoreHttpError | undefined;
  for (
    let current: unknown = cause;
    current instanceof Error;
    current = (current as Error & { cause?: unknown }).cause
  ) {
    if (current instanceof ManagedSessionStoreHttpError) {
      store = current;
      break;
    }
  }
  if (store === undefined) return String(cause);
  const details = [
    `status=${store.status}`,
    `code=${store.remoteCode}`,
    ...(store.route === undefined ? [] : [`route=${store.route}`]),
    ...(store.writerRefusalContext === undefined
      ? []
      : [`[writer-context: ${store.writerRefusalContext}]`]),
  ];
  return `${String(cause)} (${details.join(' ')})`;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function lifecycleAuthority(
  value: unknown,
): ManagedSessionLifecycleAuthority | undefined {
  if (value === undefined) return undefined;
  const fields = object(value);
  if (
    !fields ||
    Object.keys(fields).sort().join(',') !== 'claimGeneration,operationId' ||
    typeof fields['operationId'] !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(fields['operationId']) ||
    !Number.isSafeInteger(fields['claimGeneration']) ||
    (fields['claimGeneration'] as number) < 1
  )
    throw new Error('Invalid lifecycle authority.');
  return {
    operationId: fields['operationId'],
    claimGeneration: fields['claimGeneration'] as number,
  };
}

export function error(
  res: Response,
  status: number,
  code: string,
  reason?: HostedRefusalReason,
  message?: string,
): void {
  markAccessLogError(res, code, reason);
  res.status(status).json({
    error: code,
    code,
    ...(reason === undefined ? {} : { reason }),
    ...(message === undefined ? {} : { message }),
  });
}

/**
 * Names the first predicate of a turn-busy gate that fired, so its refusals
 * are attributable: a stopped writer admits no retry at all, a blocked
 * Session never recovers alone, an inactive Activation needs re-acquiring,
 * and pending MCP or Hook operations settle and retry clean. Call it only
 * after one of the predicates is known true.
 */
export function hostedTurnBusyReason(
  session: HostedSession,
): HostedRefusalReason {
  if (session.managed.authority.writesStopped) return 'writes_stopped';
  if (session.blocked) return 'turn_blocked';
  if (session.managed.authority.currentActivation?.phase !== 'active')
    return 'activation_inactive';
  if (session.mcp?.hasPendingOperations()) return 'mcp_operations_pending';
  return 'hook_operations_pending';
}

/**
 * Renders the sub-cause of an unusable run authorization for stderr: the
 * five-way blocked reason plus, when core recorded one, the specific message.
 * The response body's reason stays inside the closed refusal vocabulary. The
 * message is Store-influenced free text, so it is stripped and capped like
 * the load gate's other single-line tags.
 */
export function harnessAuthorizationDetail(
  authorization: Exclude<HarnessRunAuthorization, { status: 'runnable' }>,
): string {
  if (authorization.status !== 'blocked') return authorization.status;
  return authorization.message === undefined
    ? authorization.reason
    : `${authorization.reason}: ${sanitizeDaemonLogLine(authorization.message)}`;
}

/** The fence codes a close in flight raises under either lifecycle
 * protocol: the v1 lifecycle fence or the v2 claim fence (files-on-v2).
 * Shared by ordinaryAuthorizationError and the children/operations claim
 * gate so the two cannot drift apart. */
export function isLifecycleFenceRemoteCode(code: unknown): boolean {
  return (
    code === 'managed_session_lifecycle_active' ||
    code === 'workspace_lifecycle_claim_fenced'
  );
}

export function ordinaryAuthorizationError(
  res: Response,
  cause: unknown,
): void {
  // A close in flight fences ordinary admission under either protocol:
  // the v1 lifecycle fence or the v2 claim fence (files-on-v2). Both are
  // conflicts that retry cannot clear until the close finishes.
  if (
    cause instanceof ManagedSessionStoreHttpError &&
    cause.status === 409 &&
    isLifecycleFenceRemoteCode(cause.remoteCode)
  )
    return error(res, 409, 'hosted_lifecycle_operation_active');
  error(res, 503, 'hosted_execution_authorization_unavailable');
}

/** A takeover refusal that cannot change under retry: distinct from
 * `hosted_turn_recovery_required`, which stays retriable. */
export function recoveryDeclined(
  res: Response,
  reason: HostedRecoveryDeclineReason,
): void {
  // Its reason vocabulary is separate, so it marks the locals itself rather
  // than routing through error()'s HostedRefusalReason parameter.
  markAccessLogError(res, 'hosted_turn_recovery_declined', reason);
  res.status(409).json({
    error: 'hosted_turn_recovery_declined',
    code: 'hosted_turn_recovery_declined',
    reason,
  });
}

export function identity(
  req: Request,
  sessions: Map<string, HostedSession>,
  allowMissingClientId = false,
): HostedSession | undefined {
  const session = sessions.get(req.params['id']);
  const clientId = req.get('X-Qwen-Client-Id');
  if (allowMissingClientId && !clientId) return session;
  return session &&
    clientId &&
    CLIENT.test(clientId) &&
    clientId === session.clientId
    ? session
    : undefined;
}

export function record(
  session: HostedSession,
  sessionId: string,
  type: ChatRecord['type'],
  parentUuid: string | null,
  fields: Partial<ChatRecord>,
): ChatRecord {
  return {
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    cwd: session.cwd,
    version: 'hosted-harness/1',
    ...fields,
  };
}
