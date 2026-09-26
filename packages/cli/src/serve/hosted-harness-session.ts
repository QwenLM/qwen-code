/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Application, Request, Response } from 'express';
import { parseBridgeManagedSessionStore } from '@qwen-code/acp-bridge/bridgeTypes';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  ManagedSessionAlreadyExistsError,
  ManagedSessionNotFoundError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  createHttpManagedSessionStores,
  HTTP_MANAGED_SESSION_STORE_CONTRACT,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';
import type { HostedHarnessContract } from './hosted-harness-contract.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CLIENT = /^[A-Za-z0-9._:-]{1,128}$/u;

interface HostedSession {
  managed: ManagedSession;
  clientId: string;
  cwd: string;
  streams: Set<() => void>;
  active?: { promptId: string; digest: string; abort: AbortController };
  admissions: Map<string, { digest: string; lastEventId: number }>;
  blocked: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function error(res: Response, status: number, code: string): void {
  res.status(status).json({ error: code, code });
}

function identity(
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

function record(
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

function hasAcceptedInput(session: HostedSession, promptId: string): boolean {
  const authority = session.managed.authority;
  return authority
    .eventsInSequenceRange(1, authority.committedSequence)
    .some(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['inputId'] === promptId,
    );
}

function hasUnsettledInput(session: HostedSession): boolean {
  const accepted = new Set<string>();
  const authority = session.managed.authority;
  for (const event of authority.eventsInSequenceRange(
    1,
    authority.committedSequence,
  )) {
    if (event.kind === 'input.accepted')
      accepted.add(event.payload['turnId'] as string);
    if (event.kind === 'turn.settled')
      accepted.delete(event.payload['turnId'] as string);
  }
  return accepted.size > 0;
}

async function eventEnvelope(
  session: HostedSession,
  event: ManagedSessionEvent,
): Promise<{
  v: 1;
  id: number;
  type: string;
  data: Record<string, unknown>;
  promptId?: string;
}> {
  const sessionId =
    session.managed.authority.sessionHeader.sessionKey.sessionId;
  if (
    event.kind === 'message.committed' &&
    event.payload['role'] === 'assistant'
  ) {
    const ref = event.payload['contentRef'];
    if (ref && typeof ref === 'object') {
      const message = JSON.parse(
        (
          await session.managed.resources.read(
            ref as unknown as ManagedSessionDurableRef,
          )
        ).toString('utf8'),
      ) as ChatRecord;
      const text =
        message.message?.parts?.map((part) => part.text ?? '').join('') ?? '';
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
    return outcome === 'completed' || outcome === 'cancelled'
      ? {
          v: 1,
          id: event.sequence,
          type: 'turn_complete',
          promptId,
          data: {
            sessionId,
            promptId,
            stopReason: event.payload['stopReason'] ?? 'end_turn',
          },
        }
      : {
          v: 1,
          id: event.sequence,
          type: 'turn_error',
          promptId,
          data: {
            sessionId,
            promptId,
            code: 'hosted_turn_failed',
            message: 'Hosted Harness turn failed.',
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

export function registerHostedHarnessSessionRoutes(
  app: Application,
  contract: HostedHarnessContract,
  cwd: string,
): void {
  const sessions = new Map<string, HostedSession>();
  const opening = new Set<string>();
  const epoch = contract.bootId.replaceAll('-', '_');

  const open = async (
    req: Request,
    res: Response,
    create: boolean,
  ): Promise<void> => {
    const body = object(req.body);
    const sessionId = create ? body?.['sessionId'] : req.params['id'];
    if (
      typeof sessionId !== 'string' ||
      !UUID.test(sessionId) ||
      (create && body?.['sessionScope'] !== 'thread')
    ) {
      error(res, 400, 'invalid_hosted_session');
      return;
    }
    let store;
    try {
      store = parseBridgeManagedSessionStore(body?.['managedSessionStore']);
    } catch {
      error(res, 400, 'invalid_managed_session_store');
      return;
    }
    if (store.writerId !== contract.bootId) {
      error(res, 409, 'hosted_harness_generation_mismatch');
      return;
    }
    if (sessions.has(sessionId) || opening.has(sessionId)) {
      error(res, 409, 'hosted_session_already_attached');
      return;
    }
    const sessionKey = {
      tenantId: store.tenantId,
      workspaceId: store.workspaceId,
      sessionId,
    };
    const stores = createHttpManagedSessionStores({
      baseUrl: store.baseUrl,
      sessionKey,
      writerId: store.writerId,
      leaseDurationMs: store.leaseDurationMs,
    });
    opening.add(sessionId);
    let managed: ManagedSession | undefined;
    try {
      const refs = create
        ? {
            definitionRef: await stores.resourceStore.publish(
              'managed-definition',
              Buffer.from(JSON.stringify({ engine: 'managed', sessionId })),
            ),
            rootSnapshotRef: await stores.resourceStore.publish(
              'managed-root',
              Buffer.from(JSON.stringify({ cwd })),
            ),
            createdBy: 'hosted-harness',
          }
        : undefined;
      managed = await openManagedSession({
        runtimeBaseDir: cwd,
        transcriptPath: '',
        sessionId,
        sessionKey,
        cwd,
        version: 'hosted-harness/1',
        workerId: contract.bootId,
        activationLeaseDurationMs: store.leaseDurationMs,
        journalStore: stores.journalStore,
        resourceStore: stores.resourceStore,
        ...(refs ? { create: refs, requireNew: true } : {}),
      });
      const session: HostedSession = {
        managed,
        clientId: randomUUID(),
        cwd,
        streams: new Set(),
        admissions: new Map(),
        blocked: false,
      };
      const restore = await managed.authority.restoreBundle();
      if (restore.recoveryStatus !== 'ok' || hasUnsettledInput(session)) {
        await managed.close();
        error(res, 409, 'hosted_turn_recovery_required');
        return;
      }
      sessions.set(sessionId, session);
      res.status(200).json({
        sessionId,
        clientId: session.clientId,
        workspaceCwd: cwd,
        lastEventId: managed.authority.committedSequence,
        eventEpoch: epoch,
      });
    } catch (cause) {
      await managed?.close().catch(() => undefined);
      await stores.close().catch(() => undefined);
      if (cause instanceof ManagedSessionAlreadyExistsError) {
        error(res, 409, 'managed_session_already_exists');
      } else if (cause instanceof ManagedSessionNotFoundError) {
        error(res, 404, 'managed_session_not_found');
      } else {
        error(res, 503, 'managed_session_open_failed');
      }
    } finally {
      opening.delete(sessionId);
    }
  };

  app.post('/session', (req, res) => {
    void open(req, res, true);
  });
  app.post('/session/:id/load', (req, res) => {
    void open(req, res, false);
  });

  app.post('/session/:id/prompt', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const body = object(req.body);
    const promptId = body?.['promptId'];
    const prompt = body?.['prompt'];
    const digest = body?.['payloadDigest'];
    const deadlineMs = body?.['deadlineMs'];
    if (
      typeof promptId !== 'string' ||
      !UUID.test(promptId) ||
      !Array.isArray(prompt) ||
      prompt.length === 0 ||
      !prompt.every((block) => {
        const item = object(block);
        return (
          item?.['type'] === 'text' &&
          typeof item['text'] === 'string' &&
          item['text'].length > 0 &&
          Object.keys(item).length === 2
        );
      }) ||
      typeof digest !== 'string' ||
      !DIGEST.test(digest) ||
      (deadlineMs !== undefined &&
        (!Number.isSafeInteger(deadlineMs) ||
          (deadlineMs as number) < 1 ||
          (deadlineMs as number) > 2_147_483_647)) ||
      digest !==
        `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`
    ) {
      return error(res, 400, 'invalid_hosted_prompt');
    }
    const text = prompt
      .map((block) => (block as { text: string }).text)
      .join('\n');
    const maxBytes = HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
    // A parent UUID is the largest possible parentUuid in the durable record.
    const userRecord = record(session, req.params['id'], 'user', promptId, {
      daemonPromptId: promptId,
      message: { role: 'user', parts: [{ text }] },
    });
    if (
      Buffer.byteLength(JSON.stringify(prompt)) > maxBytes ||
      Buffer.byteLength(JSON.stringify(userRecord)) > maxBytes
    )
      return error(res, 413, 'hosted_prompt_too_large');
    const existing = session.admissions.get(promptId);
    if (existing) {
      if (existing.digest !== digest)
        return error(res, 409, 'hosted_prompt_conflict');
      res.status(202).json({
        promptId,
        lastEventId: existing.lastEventId,
        eventEpoch: epoch,
      });
      return;
    }
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (session.blocked)
      return error(res, 409, 'hosted_turn_recovery_required');
    if (hasAcceptedInput(session, promptId)) {
      return error(res, 409, 'hosted_prompt_recovery_required');
    }
    const abort = new AbortController();
    const deadline =
      deadlineMs === undefined ? null : Date.now() + (deadlineMs as number);
    const timer =
      deadlineMs === undefined
        ? undefined
        : setTimeout(() => abort.abort(), deadlineMs as number);
    timer?.unref();
    session.active = { promptId, digest, abort };
    void (async () => {
      let admitted = false;
      let settled = false;
      try {
        const authority = session.managed.authority;
        const contentRef = await session.managed.resources.publish(
          'managed-input',
          Buffer.from(JSON.stringify(prompt)),
        );
        const admissionRef = await session.managed.resources.publish(
          'managed-admission',
          Buffer.from(JSON.stringify({ promptId, digest })),
        );
        await authority.submitInput(
          {
            operation: 'submitInput',
            commandId: promptId,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: digest.slice(7),
          },
          {
            inputId: promptId,
            turnId: promptId,
            source: 'hosted-harness',
            contentRef,
            admissionRef,
            deadline,
            wakeReason: 'input',
          },
        );
        admitted = true;
        const lastEventId = authority.committedSequence;
        session.admissions.set(promptId, { digest, lastEventId });
        res.status(202).json({ promptId, lastEventId, eventEpoch: epoch });
        const harness = createManagedHarnessHandle(session.managed);
        await harness.run(async () => {
          const history = await session.managed.sink.project();
          const parentUuid = history.at(-1)?.uuid ?? null;
          const user = record(session, req.params['id'], 'user', parentUuid, {
            daemonPromptId: promptId,
            message: { role: 'user', parts: [{ text }] },
          });
          await session.managed.sink.write(user);
          let state: 'completed' | 'cancelled' | 'error' = 'completed';
          let stopReason = 'end_turn';
          try {
            const result = await runHostedHarnessTextTurn({
              sessionId: req.params['id'],
              cwd,
              history,
              prompt: text,
              promptId,
              signal: abort.signal,
            });
            await session.managed.sink.write(
              record(session, req.params['id'], 'assistant', user.uuid, {
                daemonPromptId: promptId,
                model: result.model,
                message: { role: 'model', parts: [{ text: result.text }] },
              }),
            );
          } catch (cause) {
            state = abort.signal.aborted ? 'cancelled' : 'error';
            stopReason = state;
            if (state === 'error') {
              writeStderrLineSafe(
                `qwen serve: Hosted Harness turn ${promptId} failed: ${String(cause)}`,
              );
            }
          }
          await session.managed.sink.write(
            record(session, req.params['id'], 'system', null, {
              subtype: 'turn_result',
              systemPayload: {
                promptId,
                state,
                stopReason,
                endedAt: Date.now(),
              },
            }),
          );
          settled = true;
        });
      } catch {
        if (admitted && !settled) session.blocked = true;
        if (!res.headersSent) error(res, 503, 'hosted_prompt_admission_failed');
      } finally {
        if (timer) clearTimeout(timer);
        session.active = undefined;
      }
    })();
  });

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
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Qwen-Event-Epoch', epoch);
    res.flushHeaders();
    let cursor = after;
    let busy = false;
    const stop = (): void => {
      clearInterval(timer);
      if (!res.destroyed && !res.writableEnded) res.end();
    };
    session.streams.add(stop);
    const pump = async (): Promise<void> => {
      if (busy || res.destroyed || res.writableEnded) return;
      if (cursor >= session.managed.authority.committedSequence) return;
      busy = true;
      try {
        for (const event of session.managed.authority.readEvents({
          afterSequence: cursor,
          limit: 256,
        })) {
          const envelope = await eventEnvelope(session, event);
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
    res.on('close', () => {
      clearInterval(timer);
      session.streams.delete(stop);
    });
    void pump();
  });

  app.get('/session/:id/status', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    res.json({
      sessionId: req.params['id'],
      hasActivePrompt: !!session.active,
      recoveryBlocked: session.blocked,
    });
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
        for (const event of page)
          events.push(await eventEnvelope(session, event));
        const last = page.at(-1)?.sequence ?? cursor;
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
  app.post('/session/:id/cancel', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    session.active?.abort.abort();
    res.sendStatus(204);
  });
  app.post('/session/:id/title', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const title = object(req.body)?.['title'];
    if (typeof title !== 'string' || !title.trim() || title.length > 256)
      return error(res, 400, 'invalid_session_title');
    void session.managed.sink
      .write(
        record(session, req.params['id'], 'system', null, {
          subtype: 'custom_title',
          systemPayload: { customTitle: title, titleSource: 'manual' },
        }),
      )
      .then(
        () => res.json({ sessionId: req.params['id'], persisted: true }),
        () => error(res, 503, 'managed_session_title_failed'),
      );
  });
  const close = async (
    req: Request,
    res: Response,
    allowMissingClientId = false,
  ): Promise<void> => {
    const session = identity(req, sessions, allowMissingClientId);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.active) return error(res, 409, 'hosted_turn_active');
    try {
      await session.managed.close();
      for (const stop of session.streams) stop();
      sessions.delete(req.params['id']);
      res.sendStatus(204);
    } catch {
      error(res, 503, 'managed_session_close_failed');
    }
  };
  app.post('/session/:id/detach', (req, res) => {
    void close(req, res);
  });
  app.delete('/session/:id', (req, res) => {
    void close(req, res, true);
  });
}
