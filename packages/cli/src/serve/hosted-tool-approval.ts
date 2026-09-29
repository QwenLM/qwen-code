/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  ManagedSessionConflictError,
  type ManagedSessionAction,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';

export const HOSTED_TOOL_APPROVAL_POLICY = 'hosted-tool-approval/1';
export const HOSTED_APPROVAL_TIMEOUT_MS = 10 * 60_000;
const MIN_APPROVAL_TIMEOUT_MS = 1_000;
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000;
// How often a waiter re-checks, so a Session whose writes stopped for any
// reason is noticed without an answer.
const WAIT_POLL_MS = 1_000;

export const HOSTED_APPROVAL_OPTIONS = [
  { id: 'allow', label: 'Allow' },
  { id: 'deny', label: 'Deny' },
] as const;

export type HostedApprovalMode = 'yolo' | 'default' | 'auto-edit';

export interface HostedApprovalSettings {
  readonly mode: HostedApprovalMode;
  readonly timeoutMs: number;
}

// Listing what each mode pre-approves means a tool added to a profile later
// is asked about until someone decides otherwise.
const PREAPPROVED_TOOLS: Readonly<
  Record<Exclude<HostedApprovalMode, 'yolo'>, readonly string[]>
> = {
  default: ['read_file'],
  'auto-edit': ['read_file', 'write_file', 'edit'],
};

/**
 * Reads a tool profile's approval settings. `plan` needs its own planning
 * semantics and `auto` a classifier, which the Hosted path does not have, so
 * both are refused like any unknown mode. `yolo` never waits, so it ignores
 * the timeout.
 */
export function parseHostedApprovalSettings(
  mode: unknown,
  timeoutMs: unknown,
): HostedApprovalSettings | undefined {
  const parsed = mode === undefined ? 'yolo' : mode;
  if (parsed === 'yolo')
    return { mode: parsed, timeoutMs: HOSTED_APPROVAL_TIMEOUT_MS };
  if (parsed !== 'default' && parsed !== 'auto-edit') return undefined;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < MIN_APPROVAL_TIMEOUT_MS ||
      timeoutMs > MAX_APPROVAL_TIMEOUT_MS)
  )
    return undefined;
  return {
    mode: parsed,
    timeoutMs: (timeoutMs as number | undefined) ?? HOSTED_APPROVAL_TIMEOUT_MS,
  };
}

/**
 * Reads the settings a Session definition pinned. A mode saved without its
 * timeout, or the reverse, was not written by this Harness and fails closed.
 */
export function readHostedApprovalDefinition(
  definition: Record<string, unknown> | null,
): HostedApprovalSettings | undefined {
  const mode = definition?.['approvalMode'];
  const timeoutMs = definition?.['approvalTimeoutMs'];
  if ((mode === undefined) !== (timeoutMs === undefined)) return undefined;
  return parseHostedApprovalSettings(mode, timeoutMs);
}

/** Definition fields that pin a mode which asks; `yolo` adds none. */
export function hostedApprovalDefinition(
  settings: HostedApprovalSettings,
): Record<string, unknown> {
  return settings.mode === 'yolo'
    ? {}
    : { approvalMode: settings.mode, approvalTimeoutMs: settings.timeoutMs };
}

export function hostedApprovalAsks(
  settings: HostedApprovalSettings,
  toolName: string,
): boolean {
  return (
    settings.mode !== 'yolo' &&
    !PREAPPROVED_TOOLS[settings.mode].includes(toolName)
  );
}

/** The Action's `optionsRef` resource, enough to project it without asking. */
export interface HostedActionOptions {
  readonly v: 1;
  readonly requestId: string;
  readonly turnId: string;
  readonly functionCallId: string;
  readonly toolName: string;
  readonly policyRevision: string;
  readonly inputRevision: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
}

function decisionBytes(
  optionId: string,
  inputRevision: number,
  policyRevision: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({ v: 1, optionId, inputRevision, policyRevision }),
  );
}

/**
 * Whether a decided Action chose `allow`. Decision bytes are deterministic, so
 * their recorded digest says which option was chosen without reading them.
 */
export function hostedActionAllowed(action: ManagedSessionAction): boolean {
  return (
    action.state === 'decided' &&
    action.decisionRef?.digest ===
      createHash('sha256')
        .update(
          decisionBytes(
            'allow',
            action.inputRevision,
            HOSTED_TOOL_APPROVAL_POLICY,
          ),
        )
        .digest('hex')
  );
}

/** Wakes a waiting tool turn when its Action is answered. */
export class HostedApprovalWaiters {
  private readonly waiting = new Map<string, () => void>();

  /**
   * Resolves once `isFinal` holds, the expiry passes, or the signal aborts.
   * The caller settles an Action that is still requested.
   */
  async wait(
    requestId: string,
    expiresAt: number,
    signal: AbortSignal,
    isFinal: () => boolean,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let onAbort: () => void = () => undefined;
    try {
      await new Promise<void>((resolve) => {
        this.waiting.set(requestId, resolve);
        onAbort = resolve;
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(resolve, Math.max(0, expiresAt - Date.now()));
        timer.unref();
        poll = setInterval(() => {
          if (isFinal()) resolve();
        }, WAIT_POLL_MS);
        poll.unref();
        // An answer may have landed before the waiter was registered.
        if (isFinal() || signal.aborted) resolve();
      });
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      signal.removeEventListener('abort', onAbort);
      this.waiting.delete(requestId);
    }
  }

  notify(requestId: string): void {
    this.waiting.get(requestId)?.();
  }
}

/**
 * Ends a requested Action as expired or cancelled. A decision that won the
 * race is kept; the caller reads the final state afterwards.
 */
export async function endHostedAction(
  session: ManagedSession,
  requestId: string,
  state: 'expired' | 'cancelled',
): Promise<void> {
  const authority = session.authority;
  try {
    await authority.resolveAction(
      {
        operation: 'resolveAction',
        commandId: `resolveAction:${requestId}:${state}`,
        sessionKey: authority.sessionHeader.sessionKey,
        contentDigest: createHash('sha256').update(state).digest('hex'),
      },
      { requestId, state, decisionRef: null },
    );
  } catch (cause) {
    if (
      !(cause instanceof ManagedSessionConflictError) ||
      authority.action(requestId)?.state === 'requested'
    )
      throw cause;
  }
}

async function readHostedActionOptions(
  session: ManagedSession,
  action: ManagedSessionAction,
): Promise<HostedActionOptions> {
  if (action.optionsRef === null)
    throw new Error(`Action ${action.requestId} has no options.`);
  return JSON.parse(
    (await session.resources.read(action.optionsRef)).toString('utf8'),
  ) as HostedActionOptions;
}

export type HostedActionResolution =
  | {
      readonly status: 200;
      readonly body: {
        readonly requestId: string;
        readonly state: 'decided';
        readonly optionId: string;
      };
    }
  | { readonly status: 400 | 404 | 409; readonly code: string };

const RECOVERY_REQUIRED = {
  status: 409,
  code: 'hosted_turn_recovery_required',
} as const;

const ENDED_CODES = {
  expired: 'action_expired',
  cancelled: 'action_cancelled',
} as const;

/**
 * Records a trusted final decision for a Hosted tool approval. The same
 * decision is idempotent; a different or late one is refused. A blocked
 * Session still answers what is already recorded but writes nothing; it is
 * checked just before each write, since the Turn may block meanwhile.
 */
export async function resolveHostedAction(
  session: ManagedSession,
  waiters: HostedApprovalWaiters,
  requestId: string,
  body: unknown,
  isBlocked: () => boolean = () => false,
): Promise<HostedActionResolution> {
  const authority = session.authority;
  const existing = authority.action(requestId);
  if (existing === undefined) return { status: 404, code: 'action_not_found' };
  const options = await readHostedActionOptions(session, existing);
  const request =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const optionId = request?.['optionId'];
  if (
    request === undefined ||
    Object.keys(request).length !== 3 ||
    typeof optionId !== 'string' ||
    !options.options.some((option) => option.id === optionId) ||
    request['inputRevision'] !== existing.inputRevision ||
    request['policyRevision'] !== options.policyRevision
  )
    return { status: 400, code: 'invalid_action_response' };
  const writable = () => !isBlocked() && !authority.writesStopped;
  if (
    authority.action(requestId)!.state === 'requested' &&
    Date.now() >= options.expiresAt
  ) {
    if (!writable()) return RECOVERY_REQUIRED;
    await endHostedAction(session, requestId, 'expired');
    waiters.notify(requestId);
  }
  const bytes = decisionBytes(
    optionId,
    existing.inputRevision,
    options.policyRevision,
  );
  const digest = createHash('sha256').update(bytes).digest('hex');
  const current = authority.action(requestId)!;
  if (current.state === 'expired' || current.state === 'cancelled')
    return { status: 409, code: ENDED_CODES[current.state] };
  if (current.state === 'decided') {
    return current.decisionRef?.digest === digest
      ? { status: 200, body: { requestId, state: 'decided', optionId } }
      : { status: 409, code: 'action_already_resolved' };
  }
  if (!writable()) return RECOVERY_REQUIRED;
  const decisionRef = await session.resources.publish(
    'managed-action-decision',
    bytes,
  );
  try {
    await authority.resolveAction(
      {
        operation: 'resolveAction',
        commandId: `resolveAction:${requestId}:decided`,
        sessionKey: authority.sessionHeader.sessionKey,
        contentDigest: digest,
      },
      { requestId, state: 'decided', decisionRef },
    );
  } catch (cause) {
    const raced = authority.action(requestId)!;
    if (
      !(cause instanceof ManagedSessionConflictError) ||
      raced.state === 'requested'
    )
      throw cause;
    return raced.state === 'decided'
      ? { status: 409, code: 'action_already_resolved' }
      : { status: 409, code: ENDED_CODES[raced.state] };
  }
  waiters.notify(requestId);
  return { status: 200, body: { requestId, state: 'decided', optionId } };
}
