/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readManagedMessageBody } from '@qwen-code/qwen-code-core/managed-runtime/managed-message-chunks.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { Application } from 'express';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import { HOSTED_UUID } from '../hosted-file-history.js';
import { HOSTED_MODEL_API_ERROR_MESSAGES } from '../hosted-harness-model.js';
import { inspectHostedRecovery } from '../hosted-recovery-status.js';
import { hostedToolProgress } from '../hosted-tool-progress.js';
import { checkSseAdmission, countSseStream } from '../sse-occupancy.js';
import type { HostedRuntimeOwnership } from './runtime-ownership.js';
import { error, identity, object } from './session-http.js';
import type {
  HostedHarnessSessionOptions,
  HostedSession,
} from './session-state.js';

export async function eventEnvelope(
  session: HostedSession,
  event: ManagedSessionEvent,
  streamedDeltaIds: Set<string>,
): Promise<{
  v: 1;
  id: number;
  type: string;
  data: Record<string, unknown>;
  promptId?: string;
}> {
  const sessionId =
    session.managed.authority.sessionHeader.sessionKey.sessionId;
  const progress = await hostedToolProgress(session.managed, event);
  if (progress && event.kind !== 'message.committed') {
    return {
      v: 1,
      id: event.sequence,
      type: 'session_update',
      promptId: progress.promptId,
      data: { sessionId, update: progress.update },
    };
  }
  if (event.kind === 'message.delta') {
    const text = event.payload['text'];
    const turnId = event.payload['turnId'];
    const messageId = event.payload['messageId'];
    if (typeof messageId === 'string') streamedDeltaIds.add(messageId);
    return {
      v: 1,
      id: event.sequence,
      type: 'session_update',
      ...(typeof turnId === 'string' ? { promptId: turnId } : {}),
      data: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: typeof text === 'string' ? text : '',
          },
        },
      },
    };
  }
  if (event.kind === 'message.retracted') {
    // A restarted model attempt retracts the orphaned prefix it published
    // (#13319). The coordinator blanks the turn's deltas from
    // `fromSequence` onward and announces the repair as `stream.reconciled`.
    const turnId = event.payload['turnId'];
    return {
      v: 1,
      id: event.sequence,
      type: 'message_retracted',
      ...(typeof turnId === 'string' ? { promptId: turnId } : {}),
      data: {
        sessionId,
        turnId: event.payload['turnId'],
        messageId: event.payload['messageId'],
        fromSequence: event.payload['fromSequence'],
        ...(event.payload['throughSequence'] !== undefined
          ? {
              throughSequence: event.payload['throughSequence'],
              sourceBootId: event.payload['sourceBootId'],
              sourceEventEpoch: event.payload['sourceEventEpoch'],
            }
          : {}),
      },
    };
  }
  if (
    event.kind === 'message.committed' &&
    event.payload['role'] === 'user' &&
    String(event.payload['messageId']).startsWith('umsg_')
  ) {
    const message = JSON.parse(
      (
        await readManagedMessageBody(
          (ref) => session.managed.resources.read(ref),
          event.payload['contentRef'] as unknown as ManagedSessionDurableRef,
        )
      ).toString('utf8'),
    ) as ChatRecord;
    if (message.subtype !== 'mid_turn_user_message')
      return {
        v: 1,
        id: event.sequence,
        type: 'managed_journal_event',
        data: { sessionId },
      };
    return {
      v: 1,
      id: event.sequence,
      type: 'user_message_consumed',
      promptId: message.daemonPromptId,
      data: {
        sessionId,
        messageId: message.uuid,
        parts: message.message?.parts ?? [],
      },
    };
  }
  if (
    event.kind === 'message.committed' &&
    (event.payload['role'] === 'assistant' ||
      event.payload['role'] === 'tool_result')
  ) {
    const ref = event.payload['contentRef'];
    if (ref && typeof ref === 'object') {
      const message = JSON.parse(
        (
          await readManagedMessageBody(
            (bodyRef) => session.managed.resources.read(bodyRef),
            ref as unknown as ManagedSessionDurableRef,
          )
        ).toString('utf8'),
      ) as ChatRecord;
      const text =
        message.message?.parts
          ?.filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('') ?? '';
      // A message whose text already streamed as message.delta events must not
      // project a second chunk, or from-scratch consumers would see it twice.
      const streamed = streamedDeltaIds.has(message.uuid);
      if (
        message.type === 'tool_result' ||
        message.message?.parts?.some((part) => part.functionCall) ||
        streamed
      ) {
        return {
          v: 1,
          id: event.sequence,
          type: 'managed_journal_event',
          ...(message.daemonPromptId
            ? { promptId: message.daemonPromptId }
            : {}),
          data: {
            sessionId,
            record: message,
            ...(progress ? { update: progress.update } : {}),
          },
        };
      }
      return {
        v: 1,
        id: event.sequence,
        type: 'session_update',
        ...(message.daemonPromptId ? { promptId: message.daemonPromptId } : {}),
        data: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        },
      };
    }
  }
  if (event.kind === 'turn.settled') {
    const promptId = event.payload['turnId'] as string;
    const outcome = event.payload['outcome'];
    if (outcome === 'completed' || outcome === 'cancelled') {
      return {
        v: 1,
        id: event.sequence,
        type: 'turn_complete',
        promptId,
        data: {
          sessionId,
          promptId,
          stopReason: event.payload['stopReason'] ?? 'end_turn',
        },
      };
    }
    // A deadline expiry keeps its own error code so the coordinator's
    // projection stays distinguishable from both a cancellation and an
    // unattributed failure.
    const expired = event.payload['stopReason'] === 'deadline_exceeded';
    const modelUnavailable =
      event.payload['stopReason'] === 'model_unavailable';
    const storeUnavailable =
      event.payload['stopReason'] === 'managed_session_store_unavailable';
    const roundLimit = event.payload['stopReason'] === 'model_round_limit';
    const imageUnsupported =
      event.payload['stopReason'] === 'image_input_unsupported';
    const stopReason = event.payload['stopReason'];
    const modelApiFailure =
      typeof stopReason === 'string' &&
      Object.hasOwn(HOSTED_MODEL_API_ERROR_MESSAGES, stopReason)
        ? (stopReason as keyof typeof HOSTED_MODEL_API_ERROR_MESSAGES)
        : undefined;
    return {
      v: 1,
      id: event.sequence,
      type: 'turn_error',
      promptId,
      data: {
        sessionId,
        promptId,
        code:
          modelApiFailure ??
          (expired
            ? 'hosted_turn_deadline_exceeded'
            : modelUnavailable
              ? 'model_unavailable'
              : storeUnavailable
                ? 'managed_session_store_unavailable'
                : imageUnsupported
                  ? 'image_input_unsupported'
                  : roundLimit
                    ? 'hosted_turn_limit_exceeded'
                    : 'hosted_turn_failed'),
        message: modelApiFailure
          ? HOSTED_MODEL_API_ERROR_MESSAGES[modelApiFailure]
          : expired
            ? 'The Hosted Harness Turn exceeded its deadline.'
            : imageUnsupported
              ? 'The selected model does not support image input. Choose a model with image support or remove the image.'
              : roundLimit
                ? 'The Hosted Harness Turn reached its configured model round limit.'
                : 'Hosted Harness turn failed.',
      },
    };
  }
  return {
    v: 1,
    id: event.sequence,
    type: 'managed_journal_event',
    data: { sessionId },
  };
}

export function registerHostedObservationRoutes({
  app,
  sessions,
  epoch,
  options,
  cleanupOriginalRecovery,
}: {
  app: Application;
  sessions: Map<string, HostedSession>;
  epoch: string;
  options: HostedHarnessSessionOptions | undefined;
  cleanupOriginalRecovery: HostedRuntimeOwnership['cleanupOriginalRecovery'];
}): void {
  app.get('/session/:id/events', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (
      req.get('X-Qwen-Event-Epoch') &&
      req.get('X-Qwen-Event-Epoch') !== epoch
    )
      return error(res, 409, 'hosted_event_epoch_mismatch');
    const after = Number(req.get('Last-Event-ID') ?? '0');
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > session.managed.authority.committedSequence
    )
      return error(res, 400, 'invalid_event_cursor');
    if (
      !checkSseAdmission({
        surface: 'hostedEvents',
        req,
        res,
        caps: options?.sseAdmissionCaps,
        daemonLog: options?.daemonLog,
        logContext: { sessionId: req.params['id'] },
      })
    ) {
      return;
    }
    countSseStream('hostedEvents', req, res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    // Disable proxy buffering (nginx): the keepalives below exist to put
    // bytes on the wire during quiet phases, and a buffering intermediary
    // would hold them until the client's idle watchdog aborts a healthy
    // stream. The event-stream content type alone doesn't always reach
    // the client through every proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Qwen-Event-Epoch', epoch);
    res.flushHeaders();
    let cursor = after;
    let busy = false;
    // Seeded once per stream, then updated as deltas flow: a committed
    // message whose text streamed must not project a second chunk.
    const streamedDeltaIds = new Set(
      session.managed.authority
        .eventsInSequenceRange(1, after)
        .filter((event) => event.kind === 'message.delta')
        .map((event) => event.payload['messageId'] as string),
    );
    const pump = async (): Promise<void> => {
      if (busy || res.destroyed || res.writableEnded) return;
      if (cursor >= session.managed.authority.committedSequence) return;
      busy = true;
      try {
        for (const event of session.managed.authority.readEvents({
          afterSequence: cursor,
          limit: 256,
        })) {
          const envelope = await eventEnvelope(
            session,
            event,
            streamedDeltaIds,
          );
          if (res.destroyed || res.writableEnded) return;
          const writable = res.write(
            `id: ${event.sequence}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`,
          );
          cursor = event.sequence;
          if (!writable) {
            stop();
            return;
          }
        }
      } catch (cause) {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness event stream failed: ${String(cause)}`,
        );
        stop();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void pump();
    }, 250);
    timer.unref();
    // Mirror the primary route's keepalive: while no event is committed
    // the pump writes nothing, and clients bound that silence with an
    // idle watchdog (the Java SDK defaults to 45s), so a healthy but
    // quiet stream must still put bytes on the wire.
    const keepaliveTimer = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      res.write(': keepalive\n\n');
    }, 15_000);
    keepaliveTimer.unref();
    // stop funnels every teardown path — backpressure, pump failure,
    // session close — through both timer clears; it is declared after
    // the timers so it can clear them unconditionally, and the
    // synchronous route body registers it before any path can fire.
    const stop = (): void => {
      clearInterval(timer);
      clearInterval(keepaliveTimer);
      if (!res.destroyed && !res.writableEnded) res.end();
    };
    session.streams.add(stop);
    res.on('close', () => {
      clearInterval(timer);
      clearInterval(keepaliveTimer);
      session.streams.delete(stop);
    });
    void pump();
  });

  app.get('/session/:id/status', async (req, res) => {
    // A control-plane instance that did not load the Session reads the same
    // committed evidence without a client id; a mismatched one is refused.
    const unattached = req.get('X-Qwen-Client-Id') === undefined;
    const session = identity(req, sessions, unattached);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const promptId = req.query['promptId'];
    if (
      promptId !== undefined &&
      (typeof promptId !== 'string' || !HOSTED_UUID.test(promptId))
    )
      return error(res, 400, 'invalid_managed_runtime_recovery');
    const recovery = await inspectHostedRecovery(session, promptId);
    if (identity(req, sessions, unattached) !== session)
      return error(res, 404, 'hosted_session_not_found');
    res.json({
      sessionId: req.params['id'],
      hasActivePrompt: !!session.active || session.recoveredTurn !== undefined,
      recoveryBlocked:
        session.blocked ||
        (session.mcp?.recoveryBlocked ?? false) ||
        (session.hooks?.hasPendingOperations ?? false),
      ...(session.recoveryReason === undefined
        ? {}
        : { recoveryReason: session.recoveryReason }),
      recovery,
    });
  });
  const recoveryCleanups = new Map<
    string,
    { promptId: string; pending: Promise<void> }
  >();
  app.post('/session/:id/recovery/recheck', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const promptId = object(req.body)?.['promptId'];
    if (typeof promptId !== 'string' || !HOSTED_UUID.test(promptId))
      return error(res, 400, 'invalid_managed_runtime_recovery');
    const sessionId = req.params['id'];
    let cleanup = recoveryCleanups.get(sessionId);
    if (!cleanup) {
      const sequence = session.managed.authority.committedSequence;
      const recovery = await inspectHostedRecovery(session, promptId);
      cleanup = recoveryCleanups.get(sessionId);
      if (!cleanup) {
        if (
          identity(req, sessions) === session &&
          session.managed.authority.committedSequence === sequence &&
          recovery.nextTurnAllowed
        ) {
          res.status(202).json({ accepted: true, promptId });
          return;
        }
        if (
          identity(req, sessions) !== session ||
          session.managed.authority.committedSequence !== sequence ||
          session.active ||
          session.recoveredTurn ||
          session.hooksBusy ||
          session.mcpBusy ||
          session.mcpRecovering ||
          session.mcpClosing ||
          !recovery.inputSettled ||
          !recovery.continuationReady ||
          recovery.state !== 'cleanup_pending'
        )
          return error(res, 409, 'hosted_turn_recovery_required');
        session.hooksBusy = true;
        const pending = cleanupOriginalRecovery(session, promptId).finally(
          () => {
            session.hooksBusy = false;
            recoveryCleanups.delete(sessionId);
          },
        );
        cleanup = { promptId, pending };
        recoveryCleanups.set(sessionId, cleanup);
      }
    }
    if (cleanup.promptId !== promptId)
      return error(res, 409, 'hosted_recovery_identity_mismatch');
    try {
      await cleanup.pending;
      res.status(202).json({ accepted: true, promptId });
    } catch {
      error(res, 503, 'hosted_turn_recovery_required');
    }
  });
  app.get('/session/:id/transcript', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const cursor = Number(req.query['cursor'] ?? '0');
    const limit = Number(req.query['limit'] ?? '100');
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 256
    )
      return error(res, 400, 'invalid_transcript_page');
    void (async () => {
      try {
        const events: unknown[] = [];
        const page = session.managed.authority.readEvents({
          afterSequence: cursor,
          limit,
        });
        const last = page.at(-1)?.sequence ?? cursor;
        const streamedDeltaIds = new Set(
          session.managed.authority
            .eventsInSequenceRange(1, last)
            .filter((event) => event.kind === 'message.delta')
            .map((event) => event.payload['messageId'] as string),
        );
        for (const event of page)
          events.push(await eventEnvelope(session, event, streamedDeltaIds));
        res.json({
          v: 1,
          sessionId: req.params['id'],
          events,
          hasMore: last < session.managed.authority.committedSequence,
          ...(last < session.managed.authority.committedSequence
            ? { nextCursor: String(last) }
            : {}),
        });
      } catch {
        error(res, 503, 'managed_transcript_unavailable');
      }
    })();
  });
  app.post('/session/:id/heartbeat', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    res.json({
      sessionId: req.params['id'],
      clientId: session.clientId,
      lastSeenAt: Date.now(),
    });
  });
}
