/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Part } from '@google/genai';
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
  type HttpToolPublicationOwner,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { parseToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HostedToolRecoveryRequiredError,
  HostedWorkspaceToolTurn,
  type HostedWorkspaceToolProfile,
  type HostedShellTurnOptions,
} from './hosted-workspace-tool-turn.js';
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
  toolProfile?: HostedWorkspaceToolProfile;
  publication?: { owner: HttpToolPublicationOwner; captureBytes: number };
  shell?: HostedShellTurnOptions;
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

async function recoverShellReceipts(
  session: HostedSession,
  options: HostedWorkspaceBrokerOptions,
): Promise<string | null> {
  const authority = session.managed.authority;
  const events = authority.eventsInSequenceRange(
    1,
    authority.committedSequence,
  );
  const pending = new Set<string>();
  const receipts: Array<{ promptId: string; event: ManagedSessionEvent }> = [];
  let currentPrompt: string | null = null;
  for (const event of events) {
    if (event.kind === 'input.accepted') {
      const turnId = event.payload['turnId'];
      if (typeof turnId === 'string') {
        pending.add(turnId);
        currentPrompt = turnId;
      }
    }
    if (event.kind === 'tool.receipt' && currentPrompt) {
      receipts.push({ promptId: currentPrompt, event });
    }
    if (event.kind === 'turn.settled') {
      const turnId = event.payload['turnId'];
      if (typeof turnId === 'string') {
        pending.delete(turnId);
        if (currentPrompt === turnId) currentPrompt = null;
      }
    }
  }
  const promptId = pending.size === 1 ? [...pending][0] : null;
  const harness = createManagedHarnessHandle(session.managed);
  const projected = receipts.length ? await session.managed.sink.project() : [];
  const projectedIds = new Set(projected.map((item) => item.uuid));
  for (const { promptId: receiptPromptId, event: receipt } of receipts) {
    const executionCallId = receipt.payload['executionCallId'];
    if (typeof executionCallId !== 'string')
      throw new Error('Original Shell receipt has no execution identity.');
    const ref = assertManagedSessionDurableRef(
      receipt.payload['toolOutcomeRef'],
      'original Shell outcome',
    );
    const outcome = object(
      JSON.parse((await session.managed.resources.read(ref)).toString('utf8')),
    );
    const history = object(outcome?.['history']);
    const envelope = parseToolResultEnvelope(outcome?.['envelope']);
    const manifest = envelope.capture?.manifest ?? null;
    const decision =
      envelope.capture?.captureStatus === 'complete' ? 'committed' : 'blocked';
    if (
      outcome?.['schemaVersion'] !== 1 ||
      outcome['decision'] !== decision ||
      !isDeepStrictEqual(outcome['manifestRef'], manifest) ||
      !isDeepStrictEqual(
        receipt.payload['resultRef'],
        decision === 'committed' ? manifest : null,
      ) ||
      receipt.payload['historyRevision'] !== receipt.sequence ||
      typeof history?.['messageId'] !== 'string' ||
      !UUID.test(history['messageId']) ||
      typeof history['timestamp'] !== 'string' ||
      typeof history['model'] !== 'string' ||
      !Array.isArray(history['parts'])
    )
      throw new Error('Original Shell receipt or history conflicts.');
    if (!projectedIds.has(history['messageId'])) {
      if (receiptPromptId !== promptId)
        throw new Error('Settled Shell history is missing.');
      const result = record(
        session,
        authority.sessionHeader.sessionKey.sessionId,
        'tool_result',
        projected.at(-1)?.uuid ?? null,
        {
          uuid: history['messageId'],
          timestamp: history['timestamp'],
          daemonPromptId: receiptPromptId,
          model: history['model'],
          message: { role: 'user', parts: history['parts'] as Part[] },
        },
      );
      if (
        Buffer.byteLength(JSON.stringify(result)) >
        HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
      )
        throw new Error('Original Shell history exceeds the Session limit.');
      await session.managed.sink.write(result);
      projected.push(result);
      projectedIds.add(result.uuid);
    }
    const authorization = await authority.harnessRunAuthorization();
    if (
      decision === 'committed' &&
      authorization.status === 'runnable' &&
      authorization.checkpoint.continuation.phase === 'await_runtime' &&
      receiptPromptId === promptId &&
      authorization.checkpoint.tools?.items.some(
        (item) => item.executionCallId === executionCallId,
      )
    )
      await harness.resolveAwaitRuntime(executionCallId, ref);
    if (receiptPromptId !== promptId) continue;
    try {
      const broker = new HostedWorkspaceBroker(
        options,
        authority.sessionHeader.sessionKey,
        receiptPromptId,
      );
      await broker.acknowledgeV3(executionCallId, {
        executionCallId,
        manifest,
        deliveryStatus: decision,
        historyRevision: decision === 'committed' ? receipt.sequence : null,
      });
    } catch (cause) {
      writeStderrLineSafe(
        'qwen serve: Tool v3 ACK failed during recovery: ' + String(cause),
      );
    }
  }
  return promptId && receipts.some((item) => item.promptId === promptId)
    ? promptId
    : null;
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
    (event.payload['role'] === 'assistant' ||
      event.payload['role'] === 'tool_result')
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
        message.message?.parts
          ?.filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('') ?? '';
      if (
        message.type === 'tool_result' ||
        message.message?.parts?.some((part) => part.functionCall)
      ) {
        return {
          v: 1,
          id: event.sequence,
          type: 'managed_journal_event',
          ...(message.daemonPromptId
            ? { promptId: message.daemonPromptId }
            : {}),
          data: { sessionId, record: message },
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

async function executeHostedTurn(
  session: HostedSession,
  sessionId: string,
  cwd: string,
  promptId: string,
  text: string,
  abort: AbortController,
  brokerOptions: HostedWorkspaceBrokerOptions | undefined,
  resumeFromToolResults?: Part[],
  onTurnResult?: (result: ChatRecord) => void,
): Promise<ChatRecord> {
  const authority = session.managed.authority;
  const harness = createManagedHarnessHandle(session.managed);
  let turnResult: ChatRecord | undefined;
  let toolTurn: HostedWorkspaceToolTurn | undefined;
  const running = harness.run(async () => {
    const projected = await session.managed.sink.project();
    const settledPrompts = new Set(
      authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .filter((event) => event.kind === 'turn.settled')
        .map((event) => event.payload['turnId']),
    );
    const history = session.toolProfile
      ? projected.filter(
          (entry) =>
            settledPrompts.has(entry.daemonPromptId) ||
            (resumeFromToolResults && entry.daemonPromptId === promptId),
        )
      : projected;
    let parentUuid = projected.at(-1)?.uuid ?? null;
    if (!resumeFromToolResults) {
      const user = record(session, sessionId, 'user', parentUuid, {
        daemonPromptId: promptId,
        message: { role: 'user', parts: [{ text }] },
      });
      await session.managed.sink.write(user);
      parentUuid = user.uuid;
    }
    const messageRecord = (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
      identity?: { uuid: string; timestamp: string },
    ) =>
      record(session, sessionId, type, parentUuid, {
        daemonPromptId: promptId,
        model,
        message: { role: type === 'assistant' ? 'model' : 'user', parts },
        ...identity,
      });
    const commit = async (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
      identity?: { uuid: string; timestamp: string },
    ) => {
      const message = messageRecord(type, parts, model, identity);
      await session.managed.sink.write(message);
      parentUuid = message.uuid;
      return message.uuid;
    };
    toolTurn =
      session.toolProfile && brokerOptions
        ? new HostedWorkspaceToolTurn(
            brokerOptions,
            session.managed,
            harness,
            promptId,
            commit,
            (type, parts, model) =>
              Buffer.byteLength(
                JSON.stringify(messageRecord(type, parts, model)),
              ) <= HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes,
            session.publication,
            session.shell,
          )
        : undefined;
    if (resumeFromToolResults) {
      if (!toolTurn)
        throw new HostedToolRecoveryRequiredError('Tool turn is unavailable.');
      try {
        await toolTurn.resumeCommittedResults();
      } catch (cause) {
        throw new HostedToolRecoveryRequiredError(cause);
      }
    }
    let state: 'completed' | 'cancelled' | 'error' = 'completed';
    let stopReason = 'end_turn';
    try {
      const result = await runHostedHarnessTextTurn({
        sessionId,
        cwd,
        history,
        prompt: text,
        promptId,
        signal: abort.signal,
        ...(toolTurn ? { toolTurn } : {}),
        ...(resumeFromToolResults ? { resumeFromToolResults } : {}),
      });
      await commit(
        'assistant',
        result.parts ?? [{ text: result.text }],
        result.model,
      );
    } catch (cause) {
      if (cause instanceof HostedToolRecoveryRequiredError) throw cause;
      state = abort.signal.aborted ? 'cancelled' : 'error';
      stopReason = state;
      if (state === 'error') {
        writeStderrLineSafe(
          'qwen serve: Hosted Harness turn ' +
            promptId +
            ' failed: ' +
            String(cause),
        );
      }
    }
    await toolTurn?.finish();
    turnResult = record(session, sessionId, 'system', null, {
      subtype: 'turn_result',
      systemPayload: { promptId, state, stopReason, endedAt: Date.now() },
    });
    onTurnResult?.(turnResult);
    await session.managed.sink.write(turnResult);
  });
  await running.finally(() => toolTurn?.close());
  if (!turnResult) throw new Error('Hosted turn did not settle.');
  return turnResult;
}

export function registerHostedHarnessSessionRoutes(
  app: Application,
  contract: HostedHarnessContract,
  cwd: string,
  brokerOptions?: HostedWorkspaceBrokerOptions,
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
    const toolProfile = body?.['toolProfile'];
    const captureBytes = body?.['captureBytes'];
    if (
      toolProfile !== undefined &&
      ((toolProfile !== HOSTED_WORKSPACE_FILE_PROFILE &&
        toolProfile !== HOSTED_WORKSPACE_SHELL_PROFILE) ||
        !brokerOptions)
    ) {
      error(res, 400, 'hosted_tool_profile_unavailable');
      return;
    }
    if (
      toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE &&
      captureBytes !== undefined &&
      (!Number.isSafeInteger(captureBytes) ||
        (captureBytes as number) < 1 ||
        (captureBytes as number) > 2 ** 41)
    ) {
      error(res, 400, 'hosted_shell_capture_capacity_required');
      return;
    }
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
              Buffer.from(
                JSON.stringify({
                  engine: 'managed',
                  sessionId,
                  ...(toolProfile ? { toolProfile } : {}),
                  ...(toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE
                    ? { captureBytes }
                    : {}),
                }),
              ),
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
        ...(toolProfile ? { toolProfile } : {}),
        ...(toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE &&
        captureBytes !== undefined
          ? {
              publication: {
                owner: stores.publication,
                captureBytes: captureBytes as number,
              },
            }
          : {}),
        ...(toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE &&
        captureBytes === undefined
          ? {
              shell: {
                resources: stores.toolResultResources,
                assertWritable: stores.assertWritable,
              },
            }
          : {}),
      };
      const definition = object(
        JSON.parse(
          (
            await managed.resources.read(
              managed.authority.sessionHeader.definitionRef,
            )
          ).toString('utf8'),
        ),
      );
      if (
        definition?.['toolProfile'] !== toolProfile ||
        (toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE &&
          definition?.['captureBytes'] !== captureBytes)
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      const restore = await managed.authority.restoreBundle();
      let resume: { promptId: string; text: string; parts: Part[] } | undefined;
      let settlePromptId: string | undefined;
      if (
        restore.recoveryStatus === 'ok' &&
        session.publication &&
        brokerOptions
      ) {
        const promptId = await recoverShellReceipts(session, brokerOptions);
        const authorization = await managed.authority.harnessRunAuthorization();
        const projected = await managed.sink.project();
        const current = projected.filter(
          (item) => item.daemonPromptId === promptId,
        );
        const lastAssistant = current.findLastIndex(
          (item) => item.type === 'assistant',
        );
        const tail = current.slice(lastAssistant + 1);
        const user = current.find((item) => item.type === 'user');
        const prompt = user?.message?.parts
          ?.filter((part) => typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n');
        const parts = tail.flatMap((item) => item.message?.parts ?? []);
        if (
          promptId &&
          authorization.status === 'runnable' &&
          authorization.checkpoint.continuation.phase === 'results_ready' &&
          authorization.checkpoint.tools?.items.every(
            (item) => item.state === 'settled',
          ) &&
          lastAssistant >= 0 &&
          tail.length > 0 &&
          tail.every((item) => item.type === 'tool_result') &&
          typeof prompt === 'string' &&
          prompt.length > 0 &&
          parts.length > 0
        )
          resume = { promptId, text: prompt, parts };
        if (
          promptId &&
          authorization.status === 'runnable' &&
          ['results_ready', 'turn_settled'].includes(
            authorization.checkpoint.continuation.phase,
          ) &&
          authorization.checkpoint.tools?.items.every(
            (item) => item.state === 'settled' && item.consumed,
          ) &&
          lastAssistant >= 0 &&
          tail.length === 0 &&
          current[lastAssistant].message?.parts?.every(
            (part) => !part.functionCall,
          )
        )
          settlePromptId = promptId;
      }
      if (
        restore.recoveryStatus !== 'ok' ||
        (hasUnsettledInput(session) && !resume && !settlePromptId)
      ) {
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
      if (resume) {
        const abort = new AbortController();
        session.active = {
          promptId: resume.promptId,
          digest: '',
          abort,
        };
        void executeHostedTurn(
          session,
          sessionId,
          cwd,
          resume.promptId,
          resume.text,
          abort,
          brokerOptions,
          resume.parts,
        )
          .catch((cause: unknown) => {
            session.blocked = true;
            writeStderrLineSafe(
              'qwen serve: Hosted Harness recovery remained blocked: ' +
                String(cause),
            );
          })
          .finally(() => {
            session.active = undefined;
          });
      }
      if (settlePromptId) {
        const originalPromptId = settlePromptId;
        const abort = new AbortController();
        session.active = { promptId: originalPromptId, digest: '', abort };
        void (async () => {
          const harness = createManagedHarnessHandle(session.managed);
          await harness.run(async () => {
            await harness.settleConsumedRuntimeContinuation();
            await new HostedWorkspaceBroker(
              brokerOptions!,
              session.managed.authority.sessionHeader.sessionKey,
              originalPromptId,
            ).release();
            await session.managed.sink.write(
              record(session, sessionId, 'system', null, {
                subtype: 'turn_result',
                systemPayload: {
                  promptId: originalPromptId,
                  state: 'completed',
                  stopReason: 'end_turn',
                  endedAt: Date.now(),
                },
              }),
            );
          });
        })()
          .catch((cause: unknown) => {
            session.blocked = true;
            writeStderrLineSafe(
              'qwen serve: Hosted Harness final settlement remained blocked: ' +
                String(cause),
            );
          })
          .finally(() => {
            session.active = undefined;
          });
      }
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
      let turnResult: ChatRecord | undefined;
      const turnResultRecord = (
        state: 'completed' | 'cancelled' | 'error',
        stopReason: string,
      ) =>
        record(session, req.params['id'], 'system', null, {
          subtype: 'turn_result',
          systemPayload: { promptId, state, stopReason, endedAt: Date.now() },
        });
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
        turnResult = await executeHostedTurn(
          session,
          req.params['id'],
          cwd,
          promptId,
          text,
          abort,
          brokerOptions,
          undefined,
          (result) => {
            turnResult = result;
          },
        );
        settled = true;
      } catch (cause) {
        if (cause instanceof HostedToolRecoveryRequiredError) {
          session.blocked = true;
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} is recovery blocked: ${String(cause.cause)}`,
          );
          return;
        }
        if (admitted && !settled) {
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} could not finish after admission; retrying settlement: ${String(cause)}`,
          );
          try {
            const state = abort.signal.aborted ? 'cancelled' : 'error';
            await session.managed.sink.write(
              turnResult ?? turnResultRecord(state, state),
            );
          } catch (settleCause) {
            session.blocked = true;
            writeStderrLineSafe(
              `qwen serve: Hosted Harness turn ${promptId} could not settle: ${String(settleCause)}`,
            );
          }
        }
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
