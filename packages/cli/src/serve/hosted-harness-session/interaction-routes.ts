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
import {
  assertChannelPolicy,
  assertChannelRouteScope,
  MANAGED_CHANNEL_LIMITS,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import type { ChannelDelivery } from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-record.js';
import type {
  PublicChildExtensionAgent,
  PublicChildModelRoute,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  parseSessionCommandReply,
  type SessionCommandReply,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-operations.js';
import {
  MANAGED_SESSION_COMMAND_LIMITS,
  type SessionCommandKind,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-record.js';
import { MANAGED_SESSION_MESSAGE_LIMITS } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import {
  ManagedSessionAppendUnsettledError,
  ManagedSessionJournalFencedError,
  ManagedSessionRecordError,
  ManagedSessionWritesStoppedError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { Application, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import {
  parseHostedApprovalSelection,
  readHostedTurnApprovalSelection,
} from '../hosted-approval-selection.js';
import { ChannelGenerationStaleError } from '../hosted-channel-session.js';
import { ChildMessagesPendingError } from '../hosted-child-agent-session.js';
import { HOSTED_UUID } from '../hosted-file-history.js';
import { readHostedTurnModelSelection } from '../hosted-model-selection.js';
import { settlePendingMonitorInputs } from '../hosted-monitor-wake.js';
import {
  parsePrWatchSubmitInput,
  submitPrEventInput,
} from '../hosted-pr-watch-session.js';
import {
  type HostedSessionCommandSession,
  SessionCommandBlockedError,
  SessionCommandRefusalError,
} from '../hosted-session-command-session.js';
import {
  type HostedSessionMessageSession,
  SESSION_MESSAGE_INPUT_SOURCE,
  SessionMessageNotReadyError,
} from '../hosted-session-message-session.js';
import { pendingSessionInputs } from '../hosted-wake-intake.js';
import {
  error,
  hostedTurnBusyReason,
  identity,
  object,
} from './session-http.js';
import type { HostedSession } from './session-state.js';
import { HOSTED_WAKE_PASS_WAIT_MS } from './wake-recovery.js';

const CHANNEL_ID = /^[A-Za-z0-9._:@+-]{1,128}$/u;

/**
 * H5b: the closed shape of a `submit_input` channel operation. Attachments
 * arrive base64-encoded and bounded; anything malformed answers 400, never
 * a partial commit. Exported for the parsing guard's own suite.
 */
export function parseChannelSubmitInput(
  body: Record<string, unknown> | null,
): import('../hosted-channel-session.js').ChannelSubmitInputParams | undefined {
  const inputId = body?.['inputId'];
  const channelInstanceId = body?.['channelInstanceId'];
  const accountId = body?.['accountId'];
  const accountGeneration = body?.['accountGeneration'];
  const platformEventId = body?.['platformEventId'];
  const semanticRevision = body?.['semanticRevision'];
  const senderId = body?.['senderId'];
  const chatId = body?.['chatId'] ?? null;
  const threadId = body?.['threadId'] ?? null;
  const subject = body?.['subject'] ?? null;
  const text = body?.['text'];
  const attachments = body?.['attachments'] ?? [];
  const bounded = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length >= 1 && value.length <= max;
  if (
    !bounded(inputId, 512) ||
    !bounded(channelInstanceId, 128) ||
    !CHANNEL_ID.test(channelInstanceId) ||
    !bounded(accountId, 512) ||
    !Number.isSafeInteger(accountGeneration) ||
    (accountGeneration as number) < 1 ||
    !bounded(platformEventId, 512) ||
    !Number.isSafeInteger(semanticRevision) ||
    (semanticRevision as number) < 1 ||
    !bounded(senderId, 512) ||
    (chatId !== null && !bounded(chatId, 512)) ||
    (threadId !== null && !bounded(threadId, 512)) ||
    (subject !== null &&
      !bounded(subject, MANAGED_CHANNEL_LIMITS.maxSubjectChars)) ||
    typeof text !== 'string' ||
    text.length > MANAGED_CHANNEL_LIMITS.maxTextChars ||
    !Array.isArray(attachments) ||
    attachments.length > MANAGED_CHANNEL_LIMITS.maxAttachments
  ) {
    return undefined;
  }
  let scope: import('@qwen-code/qwen-code-core/managed-runtime/managed-channel-record.js').ChannelRouteScope;
  let policy: import('@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js').ChannelPolicy;
  try {
    // The Java control plane's JSON encoder drops null map values, so a
    // scope's absent senderId/chatId/threadId arrives as a missing key.
    const rawScope = object(body?.['scope']);
    scope = assertChannelRouteScope(
      rawScope === null
        ? body?.['scope']
        : { senderId: null, chatId: null, threadId: null, ...rawScope },
    );
    policy = assertChannelPolicy(body?.['policy']);
  } catch {
    return undefined;
  }
  const staged: Array<{ fileName: string; mimeType: string; bytes: Buffer }> =
    [];
  for (const entry of attachments as unknown[]) {
    const attachment = object(entry);
    const fileName = attachment?.['fileName'];
    const mimeType = attachment?.['mimeType'];
    const bytesBase64 = attachment?.['bytesBase64'];
    if (
      !bounded(fileName, 128) ||
      !bounded(mimeType, 128) ||
      typeof bytesBase64 !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(bytesBase64)
    ) {
      return undefined;
    }
    staged.push({
      fileName,
      mimeType,
      bytes: Buffer.from(bytesBase64, 'base64'),
    });
  }
  const replyContext = body?.['replyContext'] ?? null;
  // The reply context is adapter-opaque, but the closed guard is the last
  // place that can refuse on size before staging would side-effect.
  if (
    replyContext !== null &&
    Buffer.byteLength(JSON.stringify(replyContext), 'utf8') >
      MANAGED_CHANNEL_LIMITS.maxReplyContextBytes
  ) {
    return undefined;
  }
  return {
    inputId,
    channelInstanceId,
    accountId,
    accountGeneration: accountGeneration as number,
    platformEventId,
    semanticRevision: semanticRevision as number,
    scope,
    policy,
    senderId,
    chatId,
    threadId,
    subject,
    text,
    attachments: staged,
    replyContext,
  };
}

/**
 * The child orchestration a Turn of this Session gets, the same for an
 * ordinary Turn and a recovered one: its funnel, its depth, whether the
 * host serves child Workspaces (#13753 I2) and snapshots (I3), and the
 * consumption queue.
 */
export function childAgentsOf(session: HostedSession) {
  return (
    session.childAgents && {
      funnel: session.childAgents,
      depth: session.childDepth ?? 0,
      publicChildren: session.publicChildAgentsVersion === 1,
      launchEnabled: () => session.publicChildLaunchEnabled !== false,
      snapshot: async (
        promptId: string,
        model: string,
        route: PublicChildModelRoute,
        extensionAgent?: PublicChildExtensionAgent,
      ) => {
        const selection = parseHostedApprovalSelection(
          await session.stores!.approvalSelection(),
        );
        const admitted = await readHostedTurnApprovalSelection(
          session.managed,
          promptId,
        );
        if (
          !selection ||
          (admitted &&
            (selection.revision < admitted.revision ||
              (selection.revision === admitted.revision &&
                selection.mode !== admitted.mode)))
        )
          throw new Error(
            'Public child approval snapshot is unavailable or regressed.',
          );
        const modelSelection = await readHostedTurnModelSelection(
          session.managed,
          promptId,
        );
        return {
          version: extensionAgent ? (2 as const) : (1 as const),
          ...(extensionAgent ? { extensionAgent } : {}),
          sourcePromptId: promptId,
          approvalMode:
            selection.mode === 'auto' ? ('default' as const) : selection.mode,
          approvalRevision: selection.revision,
          modelId: model,
          modelRevision: modelSelection?.revision ?? 0,
          modelRoute: route,
          skillsRef:
            session.sessionSkillsRef ??
            session.agentDefinition?.skillsRef ??
            null,
        };
      },
      childWorkspaces: session.childWorkspaces === true,
      childSnapshots:
        session.childWorkspaces === true && session.childSnapshots === true,
      queueConsumption: (childRunId: string) =>
        session.childConsumption.add(childRunId),
    }
  );
}

export async function stopPublicChildSource(
  session: HostedSession,
  promptId: string,
): Promise<void> {
  if (session.publicChildAgentsVersion !== 1 || !session.childAgents) return;
  const authority = session.managed.authority;
  await session.childAgents.cancelSourcePrompt(promptId, async () => {
    const commandId = `hosted-cancel:${promptId}`;
    await authority.appendExecutionEvent(
      {
        operation: 'requestCancel',
        commandId,
        sessionKey: authority.sessionHeader.sessionKey,
        contentDigest: createHash('sha256').update(promptId).digest('hex'),
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: commandId,
        sessionKey: authority.sessionHeader.sessionKey,
        kind: 'cancel.requested',
        occurredAt: Date.now(),
        payload: {
          requestId: commandId,
          target: { turnId: promptId },
          reason: 'user',
          requestedBy: 'hosted',
        },
      }),
      { class: 'trusted_entry' },
    );
    if (session.active?.promptId === promptId) session.active.abort.abort();
  });
}

export function registerHostedInteractionRoutes(
  app: Application,
  sessions: Map<string, HostedSession>,
): void {
  /**
   * H4b: the control plane's child operations onto this Session's journal.
   * Each verb maps to one funnel act; replay-safety rides the funnel's
   * derived command ids, so a retried relay never mints a second revision.
   * A turn in flight is not a refusal: on the tool arm the turn waits for
   * exactly these commits.
   */
  app.post('/session/:id/children/operations', async (req, res) => {
    const session = identity(req, sessions);
    const claimedRestore = res.locals as {
      lifecycleRestoreAuthority?: ManagedSessionLifecycleAuthority;
    };
    // The claimed stamp restores on EVERY exit, including the
    // unavailable/blocked/validation returns that previously ran before
    // any try and leaked the stamp onto the shared client for good.
    try {
      if (!session) return error(res, 404, 'hosted_session_not_found');
      if (!session.childAgents)
        return error(res, 409, 'hosted_children_unavailable');
      if (session.blocked)
        return error(
          res,
          409,
          'hosted_turn_recovery_required',
          hostedTurnBusyReason(session),
        );
      const body = object(req.body);
      const operationId = body?.['operationId'];
      const childRunId = body?.['childRunId'];
      const kind = body?.['kind'];
      if (
        typeof operationId !== 'string' ||
        !HOSTED_UUID.test(operationId) ||
        typeof childRunId !== 'string' ||
        childRunId.length < 1 ||
        childRunId.length > 256
      ) {
        return error(res, 400, 'invalid_child_operation');
      }
      const children = session.childAgents;
      // A claimed cleanup keeps its stamped authority on this route's
      // durable writes and restores the prior stamp on every exit —
      // `try/finally` because a `return` inside any case must close too.
      try {
        switch (kind) {
          case 'dispatch_started': {
            const dispatchId = body?.['dispatchId'];
            const runtimeBindingId = body?.['runtimeBindingId'];
            const generationValue = body?.['generation'];
            if (
              typeof dispatchId !== 'string' ||
              dispatchId.length < 1 ||
              typeof runtimeBindingId !== 'string' ||
              runtimeBindingId.length < 1 ||
              typeof generationValue !== 'string' ||
              !/^[1-9][0-9]{0,18}$/.test(generationValue)
            ) {
              return error(res, 400, 'invalid_child_operation');
            }
            await children.dispatchStarted(childRunId, {
              dispatchId,
              runtime: {
                runtimeBindingId,
                generation: generationValue,
              },
            });
            break;
          }
          case 'attach': {
            const childSessionId = body?.['childSessionId'];
            if (
              typeof childSessionId !== 'string' ||
              !HOSTED_UUID.test(childSessionId)
            ) {
              return error(res, 400, 'invalid_child_operation');
            }
            await children.attach(childRunId, childSessionId);
            break;
          }
          case 'commit_result': {
            const result = body?.['result'];
            const receipt = body?.['receipt'];
            const messageCount = body?.['messageCount'];
            if (
              typeof result !== 'string' ||
              Buffer.byteLength(result, 'utf8') < 1 ||
              receipt === undefined ||
              !(
                messageCount === undefined ||
                (Number.isSafeInteger(messageCount) &&
                  (messageCount as number) >= 0)
              )
            ) {
              return error(res, 400, 'invalid_child_operation');
            }
            await children.settleCompleted(childRunId, {
              result: Buffer.from(result, 'utf8'),
              receipt: Buffer.from(
                typeof receipt === 'string' ? receipt : JSON.stringify(receipt),
                'utf8',
              ),
              ...(messageCount === undefined
                ? {}
                : { messageCount: messageCount as number }),
            });
            break;
          }
          case 'accept': {
            const rawNotification = body?.['notification'];
            if (
              rawNotification !== undefined &&
              rawNotification !== null &&
              typeof rawNotification !== 'object'
            ) {
              return error(res, 400, 'invalid_child_operation');
            }
            const notification = object(rawNotification);
            if (
              notification !== null &&
              notification !== undefined &&
              typeof notification['description'] !== 'string'
            ) {
              return error(res, 400, 'invalid_child_operation');
            }
            await children.accept(
              childRunId,
              notification
                ? {
                    notification: {
                      description: notification['description'] as string,
                    },
                  }
                : {},
            );
            session.monitorWake?.kick();
            break;
          }
          case 'mark_accepted':
            await children.markAccepted(childRunId);
            break;
          case 'fail': {
            const stopReason = body?.['stopReason'];
            const reason = body?.['reason'];
            const started = body?.['started'];
            const childSessionId = body?.['childSessionId'];
            const messageCount = body?.['messageCount'];
            const QUOTA = [
              'count_limit',
              'rate_limit',
              'depth_limit',
              'byte_limit',
              'budget_exhausted',
              'duration_limit',
            ];
            if (
              typeof stopReason !== 'string' ||
              !['creation_failed', 'child_failed', 'quota_exceeded'].includes(
                stopReason,
              ) ||
              typeof started !== 'boolean' ||
              !(
                reason === null ||
                reason === undefined ||
                (typeof reason === 'string' && QUOTA.includes(reason))
              ) ||
              !(
                childSessionId === null ||
                childSessionId === undefined ||
                typeof childSessionId === 'string'
              ) ||
              !(
                messageCount === undefined ||
                (Number.isSafeInteger(messageCount) &&
                  (messageCount as number) >= 0)
              )
            ) {
              return error(res, 400, 'invalid_child_operation');
            }
            await children.settleFailed(childRunId, {
              stopReason: stopReason as
                | 'creation_failed'
                | 'child_failed'
                | 'quota_exceeded',
              reason:
                (reason as
                  | 'count_limit'
                  | 'rate_limit'
                  | 'depth_limit'
                  | 'byte_limit'
                  | 'budget_exhausted'
                  | 'duration_limit') ?? null,
              started,
              ...(typeof childSessionId === 'string' ? { childSessionId } : {}),
              ...(messageCount === undefined
                ? {}
                : { messageCount: messageCount as number }),
            });
            break;
          }
          case 'cancel':
            await children.requestStop(childRunId);
            break;
          case 'recovery_blocked': {
            // #14387: the relay's honest settlement for a child whose
            // Harness generation was lost mid-run — the outcome stays
            // unwitnessed, so the record blocks instead of failing. Only
            // the lost-Runtime reason is admitted.
            const reason = body?.['reason'];
            const blockedChildSessionId = body?.['childSessionId'];
            if (
              reason !== 'runtime_lost' ||
              !(
                blockedChildSessionId === null ||
                blockedChildSessionId === undefined ||
                typeof blockedChildSessionId === 'string'
              )
            ) {
              return error(res, 400, 'invalid_child_operation');
            }
            await children.settleRecoveryBlocked(childRunId, {
              reason,
              ...(typeof blockedChildSessionId === 'string'
                ? { childSessionId: blockedChildSessionId }
                : {}),
            });
            // The blocked settlement of a background child is a committed
            // notification — kick the parent like the accept arm does, or
            // an idle Session's scheduler (which exits on an empty next())
            // never delivers it. Fires on a replay too: the kick is the
            // delivery, idempotent by the scheduler's own dedupe.
            session.monitorWake?.kick();
            break;
          }
          case 'close_scope': {
            const started = body?.['started'];
            const childSessionId = body?.['childSessionId'];
            if (
              typeof started !== 'boolean' ||
              !(
                childSessionId === null ||
                childSessionId === undefined ||
                typeof childSessionId === 'string'
              )
            ) {
              return error(res, 400, 'invalid_child_operation');
            }
            await children.settleCancelled(childRunId, {
              started,
              ...(typeof childSessionId === 'string' ? { childSessionId } : {}),
            });
            break;
          }
          default:
            return error(res, 400, 'invalid_child_operation');
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // H4d-b: not yet, never a conflict — the relay watches again.
        if (cause instanceof ChildMessagesPendingError) {
          return error(res, 409, 'child_messages_pending', undefined, message);
        }
        if (
          cause instanceof ManagedSessionAppendUnsettledError ||
          cause instanceof ManagedSessionJournalFencedError
        ) {
          writeStderrLineSafe(
            `qwen serve: Hosted child operation ${kind} of session ${req.params['id']} has an unknown store outcome: ${message}`,
          );
          return error(res, 503, 'child_operation_failed', undefined, message);
        }
        if (cause instanceof ManagedSessionConflictError) {
          return error(
            res,
            409,
            'child_operation_conflict',
            undefined,
            message,
          );
        }
        if (cause instanceof ManagedSessionRecordError) {
          return error(res, 409, 'child_operation_record', undefined, message);
        }
        writeStderrLineSafe(
          `qwen serve: Hosted child operation ${kind} of session ${req.params['id']} failed: ${message}`,
        );
        return error(res, 503, 'child_operation_failed', undefined, message);
      }
      res.status(202).json({ operationId, state: 'settled' });
    } finally {
      if (session && 'lifecycleRestoreAuthority' in claimedRestore) {
        session.stores!.setLifecycleAuthority(
          claimedRestore.lifecycleRestoreAuthority,
        );
      }
    }
  });

  /**
   * H4f × H4d-b: a stopped run's child takes no more message work. From
   * now on the wake pump starts none of its message inputs; a message turn
   * in flight is aborted, and its own end settles its input cancelled.
   * The waiting ones settle cancelled once no turn runs, holding the
   * Session as a close does, so neither the pump nor a prompt starts in
   * between. Idempotent: the relay repeats it until the journal shows no
   * message input owed.
   */
  const stopSessionMessageTurns = async (
    session: HostedSession,
    sessionId: string,
  ): Promise<void> => {
    session.messagesStopped = true;
    const active = session.active;
    if (active !== undefined) {
      const authority = session.managed.authority;
      if (
        authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .some(
            (event) =>
              event.kind === 'input.accepted' &&
              event.payload['turnId'] === active.promptId &&
              event.payload['source'] === SESSION_MESSAGE_INPUT_SOURCE,
          )
      )
        active.abort.abort();
      return;
    }
    if (session.mcpBusy || session.hooksBusy || session.mcpRecovering) return;
    session.mcpBusy = true;
    try {
      await settlePendingMonitorInputs({
        authority: session.managed.authority,
        sink: session.managed.sink,
        sessionId,
        cwd: session.cwd,
        sources: [SESSION_MESSAGE_INPUT_SOURCE],
        stopReason: 'stop_requested',
      });
    } finally {
      session.mcpBusy = false;
    }
    // What is left owed is a message turn that crashed in an earlier
    // process: its aftermath, which the pump no longer picks for a stopped
    // Session, settles it. A pass that picked it before the stop runs that
    // same aftermath, holding no turn slot while it reads and classifies,
    // so this one waits for the pass (#14538).
    const authority = session.managed.authority;
    const owed = () =>
      pendingSessionInputs(
        authority.eventsInSequenceRange(1, authority.committedSequence),
      ).filter((input) => input.source === SESSION_MESSAGE_INPUT_SOURCE);
    if (owed().length === 0) return;
    await session.monitorWake?.exclusive(async () => {
      // Re-read after the wait. A pass that left the Session blocked owns
      // the crash: its blocked cycle retries the aftermath and lifts the
      // block, which this consume would leave in place. A prompt or a
      // lifecycle claim admitted meanwhile keeps the Session to itself.
      // The relay repeats the stop either way.
      if (
        session.blocked ||
        session.active !== undefined ||
        session.mcpBusy ||
        session.hooksBusy ||
        session.mcpRecovering ||
        session.mcpClosing
      )
        return;
      for (const input of owed()) await session.wakeAftermath?.(input.turnId);
    }, HOSTED_WAKE_PASS_WAIT_MS);
  };

  // One message verb onto the Session's journal, for the route below.
  const runMessageOperation = async (
    req: Request,
    res: Response,
    session: HostedSession,
    messages: HostedSessionMessageSession,
  ): Promise<void> => {
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const messageId = body?.['messageId'];
    const kind = body?.['kind'];
    if (typeof operationId !== 'string' || !HOSTED_UUID.test(operationId)) {
      return error(res, 400, 'invalid_message_operation');
    }
    if (kind === 'stop') {
      // H4f: the Session's run is stopped, and its message turns stop with
      // it (H4d-b decision 8 counts them as its work).
      try {
        await stopSessionMessageTurns(session, req.params['id']);
      } catch (cause) {
        writeStderrLineSafe(
          `qwen serve: Hosted message turns of session ${req.params['id']} could not be stopped: ${String(cause)}`,
        );
        return error(
          res,
          503,
          'session_message_failed',
          undefined,
          String(cause),
        );
      }
      res.status(202).json({ operationId, state: 'settled' });
      return;
    }
    if (
      typeof messageId !== 'string' ||
      messageId.length < 1 ||
      messageId.length > 320
    ) {
      return error(res, 400, 'invalid_message_operation');
    }
    let inputId: string | undefined;
    try {
      switch (kind) {
        case 'handover': {
          const targetSessionId = body?.['targetSessionId'];
          if (
            typeof targetSessionId !== 'string' ||
            !HOSTED_UUID.test(targetSessionId)
          ) {
            return error(res, 400, 'invalid_message_operation');
          }
          await messages.handover(messageId, targetSessionId);
          break;
        }
        case 'accepted': {
          const accepted = body?.['inputId'];
          if (typeof accepted !== 'string' || accepted.length < 1) {
            return error(res, 400, 'invalid_message_operation');
          }
          await messages.accepted(messageId, accepted);
          break;
        }
        case 'consumed':
        case 'cancelled':
        case 'rejected':
        case 'unknown':
          await messages.settle(messageId, kind);
          break;
        case 'consume':
          await messages.consume(messageId);
          break;
        case 'receive': {
          const route = body?.['route'];
          const childRunId = body?.['childRunId'];
          const senderSessionId = body?.['senderSessionId'];
          const content = body?.['contentBase64'];
          const contentDigest = body?.['contentDigest'];
          if (
            (route !== 'to_child' && route !== 'to_parent') ||
            typeof childRunId !== 'string' ||
            childRunId.length < 1 ||
            childRunId.length > 256 ||
            typeof senderSessionId !== 'string' ||
            !HOSTED_UUID.test(senderSessionId) ||
            typeof content !== 'string' ||
            content.length < 1 ||
            // The base64 of at most the 64 KiB content bound.
            content.length >
              Math.ceil(MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes / 3) *
                4 ||
            typeof contentDigest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(contentDigest)
          ) {
            return error(res, 400, 'invalid_message_operation');
          }
          inputId = await messages.receive({
            messageId,
            route,
            childRunId,
            senderSessionId,
            content: Buffer.from(content, 'base64'),
            contentDigest,
          });
          session.monitorWake?.kick();
          break;
        }
        default:
          return error(res, 400, 'invalid_message_operation');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof SessionMessageNotReadyError) {
        return error(res, 409, 'session_message_not_ready', undefined, message);
      }
      // A store that faltered or stopped writing is not the target's
      // verdict on the message: the relay retries it, never rejects.
      if (
        cause instanceof ManagedSessionStoreHttpError ||
        cause instanceof ManagedSessionStoreTransportError ||
        cause instanceof ManagedSessionWritesStoppedError ||
        cause instanceof ManagedSessionAppendUnsettledError ||
        cause instanceof ManagedSessionJournalFencedError
      ) {
        writeStderrLineSafe(
          `qwen serve: Hosted message operation ${kind} of session ${req.params['id']} failed in its store: ${message}`,
        );
        return error(res, 503, 'session_message_failed', undefined, message);
      }
      if (cause instanceof ManagedSessionConflictError) {
        return error(res, 409, 'session_message_conflict', undefined, message);
      }
      if (cause instanceof ManagedSessionRecordError) {
        return error(res, 409, 'session_message_record', undefined, message);
      }
      writeStderrLineSafe(
        `qwen serve: Hosted message operation ${kind} of session ${req.params['id']} failed: ${message}`,
      );
      return error(res, 503, 'session_message_failed', undefined, message);
    }
    res.status(202).json({
      operationId,
      state: 'settled',
      ...(inputId === undefined ? {} : { inputId }),
    });
  };

  // One command verb onto the Session's journal, for the route below.
  // Same replay rules as the message verbs; `execute` additionally answers
  // with the reply document so the relay can copy it back to the member.
  const runCommandOperation = async (
    req: Request,
    res: Response,
    session: HostedSession,
    commands: HostedSessionCommandSession,
  ): Promise<void> => {
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const commandId = body?.['commandId'];
    const kind = body?.['kind'];
    if (typeof operationId !== 'string' || !HOSTED_UUID.test(operationId)) {
      return error(res, 400, 'invalid_command_operation');
    }
    if (
      typeof commandId !== 'string' ||
      commandId.length < 1 ||
      commandId.length > 320
    ) {
      return error(res, 400, 'invalid_command_operation');
    }
    let reply: SessionCommandReply | undefined;
    try {
      switch (kind) {
        case 'handover': {
          const targetSessionId = body?.['targetSessionId'];
          if (
            typeof targetSessionId !== 'string' ||
            !HOSTED_UUID.test(targetSessionId)
          ) {
            return error(res, 400, 'invalid_command_operation');
          }
          await commands.handover(commandId, targetSessionId);
          break;
        }
        case 'answered': {
          try {
            await commands.answered(
              commandId,
              parseSessionCommandReply(body?.['reply']),
            );
          } catch (cause) {
            // A store-side append outcome is not the request's shape: let it
            // reach the outer catch, which answers the retryable 503.
            if (
              cause instanceof ManagedSessionRecordError &&
              !(cause instanceof ManagedSessionConflictError) &&
              !(cause instanceof ManagedSessionStoreHttpError) &&
              !(cause instanceof ManagedSessionStoreTransportError) &&
              !(cause instanceof ManagedSessionWritesStoppedError) &&
              !(cause instanceof ManagedSessionAppendUnsettledError) &&
              !(cause instanceof ManagedSessionJournalFencedError)
            ) {
              return error(res, 400, 'invalid_command_operation');
            }
            throw cause;
          }
          break;
        }
        case 'cancelled':
        case 'rejected':
        case 'unknown':
          await commands.settle(commandId, kind);
          break;
        case 'execute': {
          const commandKind = body?.['commandKind'];
          const route = body?.['route'];
          const childRunId = body?.['childRunId'];
          const senderSessionId = body?.['senderSessionId'];
          const argsBase64 = body?.['argsBase64'];
          const argsDigest = body?.['argsDigest'];
          if (
            (commandKind !== 'board_read' &&
              commandKind !== 'board_write' &&
              commandKind !== 'member_message' &&
              commandKind !== 'plan_submit') ||
            route !== 'to_parent' ||
            typeof childRunId !== 'string' ||
            childRunId.length < 1 ||
            childRunId.length > 256 ||
            typeof senderSessionId !== 'string' ||
            !HOSTED_UUID.test(senderSessionId) ||
            typeof argsBase64 !== 'string' ||
            argsBase64.length < 1 ||
            // The base64 of at most the 64 KiB arguments bound.
            argsBase64.length >
              Math.ceil(MANAGED_SESSION_COMMAND_LIMITS.maxArgsBytes / 3) * 4 ||
            typeof argsDigest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(argsDigest)
          ) {
            return error(res, 400, 'invalid_command_operation');
          }
          const argsBytes = Buffer.from(argsBase64, 'base64');
          if (
            createHash('sha256').update(argsBytes).digest('hex') !== argsDigest
          ) {
            return error(
              res,
              409,
              'session_command_refused',
              undefined,
              `Session command ${commandId} names a digest that does not match its arguments.`,
            );
          }
          let args: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(argsBytes.toString('utf8'));
            if (
              typeof parsed !== 'object' ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              throw new Error('not an object');
            }
            args = parsed as Record<string, unknown>;
          } catch {
            return error(
              res,
              409,
              'session_command_refused',
              undefined,
              `Session command ${commandId} carries arguments that are not a JSON object.`,
            );
          }
          if (session.teams === undefined) {
            return error(res, 409, 'hosted_commands_unavailable');
          }
          reply = await commands.execute(session.teams, {
            commandId,
            kind: commandKind as SessionCommandKind,
            childRunId,
            senderSessionId,
            args,
          });
          break;
        }
        default:
          return error(res, 400, 'invalid_command_operation');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A command whose sender has not attached yet waits for the
      // control plane's attach commit: the relay defers it untouched,
      // never toward `rejected` and never spending an attempt.
      if (cause instanceof SessionCommandBlockedError) {
        return error(res, 409, 'session_command_blocked', undefined, message);
      }
      // The lead cannot accept the command at all: the relay walks this
      // entry into `rejected`, never re-executing it.
      if (cause instanceof SessionCommandRefusalError) {
        return error(res, 409, 'session_command_refused', undefined, message);
      }
      if (
        cause instanceof ManagedSessionStoreHttpError ||
        cause instanceof ManagedSessionStoreTransportError ||
        cause instanceof ManagedSessionWritesStoppedError ||
        cause instanceof ManagedSessionAppendUnsettledError ||
        cause instanceof ManagedSessionJournalFencedError
      ) {
        writeStderrLineSafe(
          `qwen serve: Hosted command operation ${kind} of session ${req.params['id']} failed in its store: ${message}`,
        );
        return error(res, 503, 'session_command_failed', undefined, message);
      }
      if (cause instanceof ManagedSessionConflictError) {
        return error(res, 409, 'session_command_conflict', undefined, message);
      }
      if (cause instanceof ManagedSessionRecordError) {
        return error(res, 409, 'session_command_record', undefined, message);
      }
      writeStderrLineSafe(
        `qwen serve: Hosted command operation ${kind} of session ${req.params['id']} failed: ${message}`,
      );
      return error(res, 503, 'session_command_failed', undefined, message);
    }
    res.status(202).json({
      operationId,
      state: 'settled',
      ...(reply === undefined ? {} : { reply }),
    });
  };

  /**
   * H4d-b: the control plane's message relay onto this Session's journal.
   * A sender's outbox entry moves through its handover, its acceptance and
   * its last step; a target commits the receipt together with the input
   * and wake that carry the message. Every verb is replay-safe by the
   * funnel's derived command ids, so a redriven relay request never mints
   * a second input. A turn in flight is not a refusal: the input queues
   * behind it in the journal. The child result relay's `stop` (H4f) is
   * idempotent rather than replayed: it settles only what is still waiting.
   *
   * H4e-b3: the same route carries the command relay's verbs when the body
   * names a `commandId` — `handover`, `execute`, `answered` and the three
   * endings — on the Session's command funnel instead.
   */
  app.post('/session/:id/messages/operations', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const commanding = typeof object(req.body)?.['commandId'] === 'string';
    let operation: Promise<void>;
    if (commanding) {
      if (session.commands === undefined) {
        return error(res, 409, 'hosted_commands_unavailable');
      }
      if (session.blocked)
        return error(
          res,
          409,
          'hosted_turn_recovery_required',
          hostedTurnBusyReason(session),
        );
      if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
      operation = runCommandOperation(req, res, session, session.commands);
    } else {
      if (session.messages === undefined) {
        return error(res, 409, 'hosted_messages_unavailable');
      }
      if (session.blocked)
        return error(
          res,
          409,
          'hosted_turn_recovery_required',
          hostedTurnBusyReason(session),
        );
      if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
      operation = runMessageOperation(req, res, session, session.messages);
    }
    // The close waits out an operation that passed the check above, so a
    // receipt never lands after its pass over the pending inputs.
    const settled = operation.catch(() => undefined);
    const operations = (session.messageOperations ??= new Set());
    operations.add(settled);
    try {
      await operation;
    } finally {
      operations.delete(settled);
    }
  });

  /**
   * H5b/H5c: the control plane's channel operations onto this Session's
   * journal. Each verb maps to one funnel act; replay-safety rides the
   * funnel's derived command ids, so a redriven adapter request never mints
   * a second input, revision or chain. A turn in flight is not a refusal:
   * an input queues behind it in the journal.
   */
  app.post('/session/:id/channels/operations', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const kind = body?.['kind'];
    // A PR-watch injection targets the bound Session, which need not be a
    // channel Session; every other channel operation requires the funnel.
    if (!session.channels && kind !== 'submit_pr_event_input')
      return error(res, 409, 'hosted_channels_unavailable');
    const reconciliation =
      typeof operationId === 'string' &&
      kind === 'settle_delivery' &&
      body?.['outcome'] === 'unknown' &&
      /^channel-reconcile:[0-9a-f]{64}$/.test(operationId);
    if (
      typeof operationId !== 'string' ||
      (!HOSTED_UUID.test(operationId) && !reconciliation)
    ) {
      return error(res, 400, 'invalid_channel_operation');
    }
    // Non-null for every kind except submit_pr_event_input (guarded above);
    // that case commits through session.managed and never reads this funnel.
    const channels = session.channels!;
    const summary = (delivery: ChannelDelivery) => ({
      deliveryId: delivery.deliveryId,
      routeId: delivery.routeId,
      routeRevision: delivery.routeRevision,
      sourceTurnId: delivery.sourceTurnId,
      state: delivery.run.delivery?.state ?? null,
      cancelRequested: delivery.cancelRequested,
      segments: delivery.segments.map((segment) => ({
        ordinal: segment.ordinal,
        segmentId: segment.segmentId,
        providerMessageId: segment.receipt?.providerMessageId ?? null,
      })),
    });
    const deliveryId = body?.['deliveryId'];
    const needsDelivery =
      kind !== 'submit_input' && kind !== 'submit_pr_event_input';
    if (
      needsDelivery &&
      (typeof deliveryId !== 'string' ||
        deliveryId.length < 1 ||
        deliveryId.length > 512)
    ) {
      return error(res, 400, 'invalid_channel_operation');
    }
    let result: Record<string, unknown>;
    try {
      switch (kind) {
        case 'submit_input': {
          const parsed = parseChannelSubmitInput(body);
          if (parsed === undefined)
            return error(res, 400, 'invalid_channel_operation');
          result = { ...(await channels.submitInput(parsed)) };
          break;
        }
        case 'submit_pr_event_input': {
          const parsed = parsePrWatchSubmitInput(body);
          if (parsed === undefined)
            return error(res, 400, 'invalid_channel_operation');
          // A pr_event input is driven into a turn only by the in-process
          // wake pump. A Session without one (e.g. the external-files
          // profile, which installs neither automations nor channels) would
          // acknowledge the input and never run it, while the adapter records
          // the transition as fired. Refuse so the adapter sees an actionable
          // failure instead of a false 202.
          //
          // A resident opened for recovery cleanup is the one absence that is
          // not permanent: it registers before its funnel and pump exist, and
          // the next full load replaces it with one that has both. The
          // permanent 409 below retires the binding, so that window answers a
          // retryable 503 instead.
          if (!session.monitorWake)
            return session.recoveryCleanupOnly
              ? error(res, 503, 'pr_event_wake_pending')
              : error(res, 409, 'pr_event_wake_unavailable');
          result = {
            ...(await submitPrEventInput(
              session.managed,
              session.managed.authority.sessionHeader.sessionKey,
              parsed,
            )),
          };
          break;
        }
        case 'claim_delivery': {
          const claimed = await channels.claim(deliveryId as string);
          result = {
            delivery: summary(claimed.delivery),
            reply: claimed.reply,
            segments: claimed.segments,
          };
          break;
        }
        case 'segment_receipt': {
          const ordinal = body?.['ordinal'];
          const providerMessageId = body?.['providerMessageId'];
          const acceptedAt = body?.['acceptedAt'];
          if (
            !Number.isSafeInteger(ordinal) ||
            (ordinal as number) < 0 ||
            typeof providerMessageId !== 'string' ||
            providerMessageId.length < 1 ||
            providerMessageId.length > 512 ||
            !Number.isSafeInteger(acceptedAt) ||
            (acceptedAt as number) < 0
          ) {
            return error(res, 400, 'invalid_channel_operation');
          }
          result = {
            delivery: summary(
              await channels.receipt(deliveryId as string, ordinal as number, {
                providerMessageId,
                acceptedAt: acceptedAt as number,
                proofRef: null,
              }),
            ),
          };
          break;
        }
        case 'settle_delivery': {
          const outcome = body?.['outcome'];
          if (outcome !== 'unknown' && outcome !== 'rejected') {
            return error(res, 400, 'invalid_channel_operation');
          }
          result = {
            delivery: summary(
              await channels.settle(
                deliveryId as string,
                outcome,
                reconciliation ? operationId : undefined,
              ),
            ),
          };
          break;
        }
        case 'cancel_delivery':
          result = {
            delivery: summary(await channels.cancel(deliveryId as string)),
          };
          break;
        case 'resend_delivery':
          result = {
            delivery: summary(await channels.resend(deliveryId as string)),
            possibleDuplicate: true,
          };
          break;
        default:
          return error(res, 400, 'invalid_channel_operation');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof ChannelGenerationStaleError)
        return error(res, 409, 'channel_generation_stale', undefined, message);
      if (message.includes('is not enabled for submission'))
        return error(res, 409, 'channel_adapter_disabled', undefined, message);
      // A record-validation refusal is a deterministic 400; the durable
      // store's own transient fault classes must not masquerade as one —
      // they fall through to the retryable 503 underneath (F10).
      if (
        cause instanceof ManagedSessionRecordError &&
        !(cause instanceof ManagedSessionConflictError) &&
        !(cause instanceof ManagedSessionStoreHttpError) &&
        !(cause instanceof ManagedSessionStoreTransportError) &&
        !(
          cause instanceof ManagedSessionAppendUnsettledError ||
          cause instanceof ManagedSessionJournalFencedError
        )
      )
        return error(res, 400, 'invalid_channel_operation', undefined, message);
      if (
        message.includes('cannot follow') ||
        message.includes('cannot be') ||
        message.includes('already') ||
        message.includes('has no ') ||
        message.includes('must bind')
      ) {
        return error(
          res,
          409,
          'channel_operation_conflict',
          undefined,
          message,
        );
      }
      writeStderrLineSafe(
        `qwen serve: Hosted channel operation ${String(kind)} of session ${req.params['id']} failed: ${message}`,
      );
      return error(res, 503, 'channel_operation_failed', undefined, message);
    }
    session.monitorWake?.kick();
    res.status(202).json({ operationId, state: 'settled', ...result });
  });
}
