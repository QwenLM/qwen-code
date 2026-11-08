/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import { inspect } from 'node:util';
import { extractErrorCode, extractErrorMessage } from '@qwen-code/acp-bridge';
import {
  CHANNEL_PROMPT_META_KEY,
  DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
  DAEMON_SUBMITTED_PROMPT_META_KEY,
  SUBMITTED_PROMPT_META_KEY,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { parseChannelDelivery } from '../../runtime/channel-delivery.js';
import {
  InvalidClientIdError,
  PromptQueueFullError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import type { ChannelDeliveryAuthorizationStore } from '../channel-delivery-authorization.js';
import {
  CHANNEL_BOUND_RELAY_META_KEY,
  CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY,
  isChannelWorkerPromptAuthorized,
  isChannelWorkerPromptToken,
} from '../channel-worker-prompt-authorization.js';
import type { DaemonLogger } from '../daemon-logger.js';
import { resolvePromptDeadlineMs } from '../server/prompt-deadline.js';
import {
  DaemonDrainingError,
  type SessionArchiveCoordinator,
} from '../server/session-archive.js';
import {
  WorkspaceGenerationClosedError,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { bindSessionPrsFromPromptCommand } from './session-pr-backfill.js';

// Must exceed CHANNEL_DELIVERY_IPC_TIMEOUT_MS (30 s, channel-delivery-ipc.ts) plus scheduling slack.
const CHANNEL_DELIVERY_AUTHORIZATION_GRACE_MS = 60_000;

// Admission-side idempotency for prompt admissions (POST /session/:id/prompt
// and in-process callers share one ring, per session). A channel relay
// marks acceptance durably AFTER the 202; a crash or write failure in that
// gap (or a lost response) makes it retry, and the retry must not enqueue
// the event twice. The ring maps a caller-supplied key to the promptId of
// its first admission; a repeat returns that admission without re-enqueueing.
// In-memory on purpose: the prompt queue it protects is in-memory too, so a
// daemon restart loses both together and re-injection becomes the correct
// recovery. Bounded per session and across sessions (FIFO eviction).
export const PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const PROMPT_IDEMPOTENCY_KEYS_PER_SESSION = 128;
const PROMPT_IDEMPOTENCY_MAX_SESSIONS = 1024;
const promptIdempotencyBySession = new Map<string, Map<string, string>>();

function rememberPromptIdempotencyKey(
  sessionId: string,
  key: string,
  promptId: string,
): void {
  let keys = promptIdempotencyBySession.get(sessionId);
  if (!keys) {
    keys = new Map<string, string>();
    promptIdempotencyBySession.set(sessionId, keys);
    if (promptIdempotencyBySession.size > PROMPT_IDEMPOTENCY_MAX_SESSIONS) {
      const oldest = promptIdempotencyBySession.keys().next().value;
      if (oldest !== undefined) promptIdempotencyBySession.delete(oldest);
    }
  }
  keys.set(key, promptId);
  if (keys.size > PROMPT_IDEMPOTENCY_KEYS_PER_SESSION) {
    const oldest = keys.keys().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
}

function forgetPromptIdempotencyKey(sessionId: string, key: string): void {
  const keys = promptIdempotencyBySession.get(sessionId);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) promptIdempotencyBySession.delete(sessionId);
}

/**
 * Renders a prompt-turn rejection for the daemon log. Non-Error rejections
 * (bare JSON-RPC error objects forwarded by the bridge) must not degrade to
 * `[object Object]` — that hid the failure cause in production incidents
 * (#10710), so extract the structured message/code instead.
 */
export function describePromptTurnFailure(err: unknown): string {
  const detail = extractErrorMessage(err);
  if (err instanceof Error) {
    return `[${err.name}] ${detail}`;
  }
  const code = extractErrorCode(err);
  // `extractErrorMessage` terminates in `String(err)`, which renders a plain
  // object as `[object Object]`. Fall back to `inspect` for those: unlike
  // `JSON.stringify` it never throws, so circular and non-serializable
  // rejections stay readable instead of degrading again.
  const rendered =
    typeof err === 'object' &&
    err !== null &&
    (detail === '' || detail === String(err))
      ? inspect(err, { depth: 2, breakLength: Infinity })
      : detail;
  return code === undefined ? rendered : `[code ${code}] ${rendered}`;
}

/** How a prompt's caller is classified, decided before admission. */
export interface SessionPromptClassification {
  /**
   * A channel turn: `qwen.channel.prompt` from a caller the daemon trusts.
   * The bridge turns it into the session's channel classification.
   */
  channelPrompt: boolean;
  /** The display projection, accepted only from an authorized channel worker. */
  promptDisplayText?: string;
  /** The submitted prompt source, accepted only from a plain client. */
  submittedPrompt?: string;
  /**
   * The request carried a `qwen.channel.prompt` marker of its own, trusted
   * or not. With `channelPrompt` it keeps the PR-binding backfill off the
   * turn: relayed text is an external sender's message, and a client that
   * marks its own prompt opts only itself out.
   */
  requestedChannelPrompt: boolean;
}

/**
 * Split a prompt request into the body the bridge receives and the
 * caller's classification: strip the request-envelope fields and every
 * classification marker, then accept a marker only from the caller it is
 * meant for.
 */
export function classifyPromptRequest(
  body: Readonly<Record<string, unknown>>,
  runtime: Pick<WorkspaceRuntime, 'workspaceCwd' | 'primary' | 'trusted'>,
): {
  forwardedBody: Record<string, unknown>;
  classification: SessionPromptClassification;
} {
  const forwardedBody = { ...body };
  delete forwardedBody['deadlineMs'];
  delete forwardedBody['delivery'];
  delete forwardedBody['idempotencyKey'];
  const forwardedMeta =
    typeof forwardedBody['_meta'] === 'object' &&
    forwardedBody['_meta'] !== null &&
    !Array.isArray(forwardedBody['_meta'])
      ? { ...(forwardedBody['_meta'] as Record<string, unknown>) }
      : undefined;
  const submittedPrompt = forwardedMeta?.[SUBMITTED_PROMPT_META_KEY];
  const promptAuthorization =
    forwardedMeta?.[CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY];
  const promptDisplayText =
    forwardedMeta?.[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
  const channelPrompt = forwardedMeta?.[CHANNEL_PROMPT_META_KEY];
  const boundRelay = forwardedMeta?.[CHANNEL_BOUND_RELAY_META_KEY];
  if (forwardedMeta) {
    delete forwardedMeta[CHANNEL_WORKER_PROMPT_AUTHORIZATION_META_KEY];
    delete forwardedMeta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
    delete forwardedMeta[SUBMITTED_PROMPT_META_KEY];
    delete forwardedMeta[DAEMON_SUBMITTED_PROMPT_META_KEY];
    delete forwardedMeta[CHANNEL_PROMPT_META_KEY];
    delete forwardedMeta[CHANNEL_BOUND_RELAY_META_KEY];
    if (Object.keys(forwardedMeta).length > 0) {
      forwardedBody['_meta'] = forwardedMeta;
    } else {
      delete forwardedBody['_meta'];
    }
  }
  // Home-workspace channel turns ride the per-workspace worker
  // registration (the pre-relay predicate). Cross-workspace bound
  // delivery additionally requires the explicit bound-relay marker:
  // the process-level credential exists for createBoundSessionsAccessor
  // relays, so a PLAIN prompt carrying a foreign worker token gets no
  // channel classification (and no caller-supplied display projection).
  // The target must still be primary or trusted — the same trust model
  // the bindings route enumerates. A forged token is dropped here and
  // again at the bridge admission strip.
  const channelWorkerAuthorized =
    isChannelWorkerPromptAuthorized(
      promptAuthorization,
      runtime.workspaceCwd,
    ) ||
    (boundRelay === true &&
      isChannelWorkerPromptToken(promptAuthorization) &&
      (runtime.primary || runtime.trusted));
  // Channel classification opts the turn out of loop-detected rejection,
  // so it rides the same worker authorization as the display projection;
  // a forged key from any other caller is dropped here and again at the
  // bridge admission strip.
  return {
    forwardedBody,
    classification: {
      channelPrompt: channelWorkerAuthorized && channelPrompt === true,
      ...(typeof promptDisplayText === 'string' && channelWorkerAuthorized
        ? { promptDisplayText }
        : {}),
      ...(typeof submittedPrompt === 'string' &&
      channelPrompt === undefined &&
      promptAuthorization === undefined &&
      promptDisplayText === undefined
        ? { submittedPrompt }
        : {}),
      requestedChannelPrompt: channelPrompt !== undefined,
    },
  };
}

export interface SessionPromptAdmissionDeps {
  archiveCoordinator: SessionArchiveCoordinator;
  channelDeliveryAuthorizations?: ChannelDeliveryAuthorizationStore;
  daemonLog?: DaemonLogger;
  promptDeadlineMs?: number;
}

export interface SessionPromptAdmissionInput {
  runtime: WorkspaceRuntime;
  /**
   * The canonical id of a live session of `runtime`. The caller provides
   * what `withOwnerMutableSession` provides for the route: the archive
   * coordinator's shared lock on the session, the runtime activity gate
   * for an internal runtime, and the generation guard asserted open with
   * no `await` between that check and this call — or the standalone
   * service's prompt dispatch for a standalone session.
   */
  sessionId: string;
  /** The prompt's content blocks, already validated. */
  prompt: unknown[];
  /** The rest of the bridge request (see {@link classifyPromptRequest}). */
  request: Record<string, unknown>;
  classification: SessionPromptClassification;
  /** Non-empty, at most {@link PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH} characters. */
  idempotencyKey?: string;
  requestDeadlineMs?: number;
  clientId?: string;
  delivery?: ReturnType<typeof parseChannelDelivery>;
  signal?: AbortSignal;
  /**
   * Runs with the new promptId once the admission is past the dedupe check
   * and the session's cursor reads, just before the enqueue.
   */
  onPromptId?: (promptId: string) => void;
  onPromptAdmitted?: () => void;
}

export type SessionPromptAdmission =
  | {
      deduplicated: true;
      promptId: string;
      lastEventId: ReturnType<AcpSessionBridge['getSessionLastEventId']>;
      eventEpoch: ReturnType<AcpSessionBridge['getSessionEventEpoch']>;
    }
  | {
      deduplicated: false;
      promptId: string;
      lastEventId: ReturnType<AcpSessionBridge['getSessionLastEventId']>;
      eventEpoch: ReturnType<AcpSessionBridge['getSessionEventEpoch']>;
      /** Settles, never rejecting, once the turn has finished either way. */
      settled: Promise<void>;
    };

/**
 * Admit a prompt into a live session: deduplicate a repeated idempotency
 * key, enqueue the turn with the caller's classification, remember the
 * key, and run the PR-binding backfill for a local user's prompt. Used by
 * `POST /session/:id/prompt`, and callable in-process with a
 * classification the caller decides.
 *
 * Synchronous on purpose: the dedupe check, the enqueue and remembering the
 * key happen with no `await` in between, so a concurrent retry cannot slip
 * past the check. A pre-admission failure throws; the delivery
 * authorization is minted just before the enqueue and revoked when it
 * throws. An empty key or one longer than
 * {@link PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH} is a caller error and throws
 * before anything happens.
 */
export function admitSessionPrompt(
  deps: SessionPromptAdmissionDeps,
  input: SessionPromptAdmissionInput,
): SessionPromptAdmission {
  const { runtime, sessionId, idempotencyKey, clientId, delivery } = input;
  const { daemonLog } = deps;
  const ownerBridge = runtime.bridge;
  if (
    idempotencyKey !== undefined &&
    (idempotencyKey.length === 0 ||
      idempotencyKey.length > PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH)
  ) {
    throw new RangeError(
      `idempotencyKey must be a non-empty string of at most ${PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }
  const promptId = crypto.randomUUID();
  if (idempotencyKey !== undefined) {
    const admittedPromptId = promptIdempotencyBySession
      .get(sessionId)
      ?.get(idempotencyKey);
    if (admittedPromptId !== undefined) {
      // A retry of an already-admitted event (lost acceptance mark or
      // lost 202 on the caller side): return the original admission
      // without enqueueing a second turn — and before any delivery
      // authorization is minted for the unused new promptId. The
      // cursor/epoch are fresh so the caller can still seed SSE
      // resume from this response.
      return {
        deduplicated: true,
        promptId: admittedPromptId,
        lastEventId: ownerBridge.getSessionLastEventId(sessionId),
        eventEpoch: ownerBridge.getSessionEventEpoch(sessionId),
      };
    }
  }
  const { classification } = input;

  const lastEventId = ownerBridge.getSessionLastEventId(sessionId);
  // Epoch token paired with the cursor above: a client that seeds its
  // SSE resume position from this 202 must also learn the bus epoch so
  // a daemon restart in between is detected (DAEMON-001).
  const eventEpoch = ownerBridge.getSessionEventEpoch(sessionId);
  input.onPromptId?.(promptId);
  // Minted after everything above that can throw (the cursor getters
  // throw for a session that has just closed), so only the enqueue below
  // can fail with an authorization outstanding, and that path revokes it.
  if (delivery && deps.channelDeliveryAuthorizations) {
    deps.channelDeliveryAuthorizations.authorizePrompt(runtime.workspaceCwd, {
      sessionId,
      deliveryId: promptId,
      target: delivery.target,
    });
  }

  // The effective deadline (server cap ∩ request override) is passed
  // to the bridge, which owns the deadline race: it publishes the
  // formal `turn_error{code:'prompt_deadline_exceeded'}` terminal,
  // releases the per-session FIFO, and best-effort cancels the agent.
  // A route-side timer can't do any of that — it could only abort
  // this request's signal.
  const effectiveDeadlineMs = resolvePromptDeadlineMs(
    deps.promptDeadlineMs,
    input.requestDeadlineMs,
  );

  let promptPromise: ReturnType<AcpSessionBridge['sendPrompt']>;
  // Tracks whether the bridge actually enqueued the prompt. The
  // admission contract throws every reachable pre-enqueue failure
  // synchronously; the admission signal remains the type-agnostic
  // defense-in-depth way to tell a non-admission apart from a turn
  // that was admitted and then failed (a custom bridge could still
  // reject deferred; prompt shape validation is pre-validated here).
  let promptAdmitted = false;
  try {
    promptPromise = ownerBridge.sendPrompt(
      sessionId,
      {
        ...input.request,
        sessionId,
        prompt: input.prompt,
      } as Parameters<AcpSessionBridge['sendPrompt']>[1],
      input.signal,
      {
        ...(clientId !== undefined ? { clientId } : {}),
        promptId,
        ...(effectiveDeadlineMs !== undefined
          ? { deadlineMs: effectiveDeadlineMs }
          : {}),
        ...(classification.promptDisplayText !== undefined
          ? { promptDisplayText: classification.promptDisplayText }
          : {}),
        ...(classification.submittedPrompt !== undefined
          ? { submittedPrompt: classification.submittedPrompt }
          : {}),
        ...(classification.channelPrompt ? { channelPrompt: true } : {}),
        ...(delivery !== undefined
          ? {
              channelDelivery: {
                deliveryId: promptId,
                target: delivery.target,
              },
            }
          : {}),
        onPromptAdmitted: () => {
          promptAdmitted = true;
          input.onPromptAdmitted?.();
        },
      },
    );
  } catch (err) {
    deps.channelDeliveryAuthorizations?.revokePrompt(
      runtime.workspaceCwd,
      sessionId,
      promptId,
    );
    if (daemonLog && err instanceof PromptQueueFullError) {
      daemonLog.warn('prompt admission rejected: queue full', {
        sessionId,
        promptId,
        ...(clientId !== undefined ? { clientId } : {}),
        limit: err.limit,
        pendingCount: err.pendingCount,
      });
    }
    if (daemonLog && err instanceof InvalidClientIdError) {
      daemonLog.warn('prompt admission rejected: invalid client id', {
        sessionId,
        promptId,
        ...(clientId !== undefined ? { clientId } : {}),
      });
    }
    throw err;
  }
  if (idempotencyKey !== undefined) {
    // sendPrompt returned without a synchronous admission throw:
    // remember the key BEFORE any await so a concurrent retry cannot
    // slip past the check above (the whole check-admit-remember
    // sequence is synchronous). A deferred pre-admission rejection
    // forgets it again in the failure handler below.
    rememberPromptIdempotencyKey(sessionId, idempotencyKey, promptId);
  }

  // A `/review` or `/verify-pr` prompt binds the PR to this session as
  // soon as the turn is admitted, instead of waiting for an on-demand
  // backfill sweep. Off the prompt path: a failed bind never affects
  // the turn.
  if (
    runtime.trusted &&
    !classification.channelPrompt &&
    !classification.requestedChannelPrompt
  ) {
    // Only the prompt the user typed is a source: take the first text
    // block. Later blocks can carry @-imported file content whose
    // line-leading examples would forge a binding; a channel-relayed
    // turn is an external sender's message, not the local user's.
    const firstTextBlock = input.prompt.find(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>)['type'] === 'text',
    ) as Record<string, unknown> | undefined;
    const promptText =
      typeof firstTextBlock?.['text'] === 'string'
        ? (firstTextBlock['text'] as string)
        : undefined;
    if (promptText !== undefined) {
      void bindSessionPrsFromPromptCommand(runtime, sessionId, promptText, {
        archiveCoordinator: deps.archiveCoordinator,
      })
        .then((result) => {
          if (!result) return;
          // A `--repo` decline is a policy outcome, not a failure, but
          // it still has to reach the log: a badge missing because the
          // number named another repository is otherwise
          // indistinguishable from one that never resolved.
          if (result.writeErrors || result.unresolved || result.repoDeclined) {
            daemonLog?.warn('session PR bind incomplete', {
              sessionId,
              unresolved: result.unresolved,
              repoDeclined: result.repoDeclined,
              writeErrors: result.writeErrors,
              overLimit: result.overLimit,
            });
          }
        })
        .catch((error) => {
          if (
            error instanceof WorkspaceGenerationClosedError ||
            error instanceof DaemonDrainingError
          ) {
            return;
          }
          daemonLog?.warn('session PR bind failed', {
            sessionId,
            error: describePromptTurnFailure(error),
          });
        });
    }
  }

  const settled = promptPromise
    .then(
      () => {
        if (daemonLog) {
          daemonLog.info('prompt turn completed', {
            sessionId,
            promptId,
            clientId,
          });
        }
      },
      (err) => {
        // A rejection WITHOUT the admission signal means the prompt
        // was never enqueued (a deferred pre-admission check rejected
        // it). The remembered key must be removed, or a retry would
        // dedupe into a phantom admission and silently lose the
        // event. Turn failures (the prompt WAS admitted) keep their
        // key. Every reachable pre-admission check in the bridge now
        // throws synchronously (the reserved standalone
        // working-directory check included), so the route answers
        // non-202 before the relay can consume a phantom acceptance;
        // this forget stays as defense-in-depth for a bridge that
        // still rejects deferred, where the CURRENT delivery is
        // already consumed by the caller and only subsequent retries
        // can be protected.
        if (idempotencyKey !== undefined && !promptAdmitted) {
          forgetPromptIdempotencyKey(sessionId, idempotencyKey);
        }
        if (daemonLog) {
          daemonLog.warn(
            `prompt turn failed: ${describePromptTurnFailure(err)}`,
            { sessionId, promptId, clientId },
          );
        }
      },
    )
    .finally(() => {
      if (delivery && deps.channelDeliveryAuthorizations) {
        const revokeTimer = setTimeout(() => {
          deps.channelDeliveryAuthorizations?.revokePrompt(
            runtime.workspaceCwd,
            sessionId,
            promptId,
          );
        }, CHANNEL_DELIVERY_AUTHORIZATION_GRACE_MS);
        revokeTimer.unref();
      }
    })
    .catch(() => {});

  if (daemonLog) {
    daemonLog.info('prompt enqueued', { sessionId, promptId, clientId });
  }
  return { deduplicated: false, promptId, lastEventId, eventEpoch, settled };
}
