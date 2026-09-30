/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import type { Application, Request, Response } from 'express';
import { parseBridgeManagedSessionStore } from '@qwen-code/acp-bridge/bridgeTypes';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { MANAGED_MCP_MAX_CONNECTIONS } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
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
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HostedToolRecoveryRequiredError,
  HostedWorkspaceToolTurn,
  type HostedWorkspaceToolProfile,
  type HostedShellTurnOptions,
} from './hosted-workspace-tool-turn.js';
import type { HostedHarnessContract } from './hosted-harness-contract.js';
import {
  HOSTED_MCP_PROFILE,
  HostedMcpSession,
  HostedMcpRecoveryRequiredError,
  HostedMcpConflictError,
  HostedMcpConnectionQuotaError,
  parseHostedMcpServers,
  type HostedMcpServerPin,
} from './hosted-mcp-session.js';
import {
  HostedApprovalWaiters,
  hostedApprovalDefinition,
  parseHostedApprovalSettings,
  readHostedApprovalDefinition,
  resolveHostedAction,
  type HostedApprovalSettings,
} from './hosted-tool-approval.js';

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
  toolProfile?: HostedWorkspaceToolProfile | typeof HOSTED_MCP_PROFILE;
  shell?: HostedShellTurnOptions;
  mcp?: HostedMcpSession;
  mcpBusy?: boolean;
  mcpClosing?: boolean;
  mcpRecovering?: boolean;
  approval?: HostedApprovalSettings;
  waiters: HostedApprovalWaiters;
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
    if (
      toolProfile !== undefined &&
      ((toolProfile !== HOSTED_WORKSPACE_FILE_PROFILE &&
        toolProfile !== HOSTED_WORKSPACE_SHELL_PROFILE &&
        toolProfile !== HOSTED_MCP_PROFILE) ||
        !brokerOptions)
    ) {
      error(res, 400, 'hosted_tool_profile_unavailable');
      return;
    }
    let mcpServers: readonly HostedMcpServerPin[] | undefined;
    try {
      if (toolProfile === HOSTED_MCP_PROFILE)
        mcpServers = parseHostedMcpServers(body?.['mcpServers']);
      else if (body?.['mcpServers'] !== undefined)
        throw new Error('MCP requires its explicit profile.');
      if (
        create &&
        mcpServers &&
        mcpServers.length > MANAGED_MCP_MAX_CONNECTIONS
      )
        throw new Error('MCP server definitions exceed Runtime capacity.');
    } catch {
      error(res, 400, 'invalid_hosted_mcp_servers');
      return;
    }
    // The mode is pinned at creation, so a deployment's later mode affects
    // only new Sessions; a load uses the saved one.
    const approval =
      create && toolProfile !== undefined
        ? parseHostedApprovalSettings(
            body?.['approvalMode'],
            body?.['approvalTimeoutMs'],
          )
        : undefined;
    if (create && toolProfile !== undefined && !approval) {
      error(res, 400, 'invalid_hosted_approval');
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
                  ...(mcpServers ? { mcpServers } : {}),
                  ...(approval ? hostedApprovalDefinition(approval) : {}),
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
        waiters: new HostedApprovalWaiters(),
        ...(toolProfile ? { toolProfile } : {}),
        ...(toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE
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
      const pinned = toolProfile
        ? readHostedApprovalDefinition(definition)
        : undefined;
      if (
        definition?.['toolProfile'] !== toolProfile ||
        JSON.stringify(definition?.['mcpServers']) !==
          JSON.stringify(mcpServers) ||
        (toolProfile && !pinned)
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (mcpServers && brokerOptions)
        session.mcp = new HostedMcpSession(brokerOptions, managed, mcpServers);
      if (pinned) session.approval = pinned;
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
        // A Harness older than approvals omits this, so a caller can tell.
        ...(pinned ? { approvalMode: pinned.mode } : {}),
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
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
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
    if (session.blocked || session.mcp?.hasPendingOperations())
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
      let toolTurn: HostedWorkspaceToolTurn | undefined;
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
        await session.mcp?.ensureReady(abort.signal);
        abort.signal.throwIfAborted();
        const authority = session.managed.authority;
        const contentRef = await session.managed.resources.publish(
          'managed-input',
          Buffer.from(JSON.stringify(prompt)),
        );
        const admissionRef = await session.managed.resources.publish(
          'managed-admission',
          Buffer.from(JSON.stringify({ promptId, digest })),
        );
        abort.signal.throwIfAborted();
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
          const projected = await session.managed.sink.project();
          const settledPrompts = new Set(
            authority
              .eventsInSequenceRange(1, authority.committedSequence)
              .filter((event) => event.kind === 'turn.settled')
              .map((event) => event.payload['turnId']),
          );
          const history = session.toolProfile
            ? projected.filter((entry) =>
                settledPrompts.has(entry.daemonPromptId),
              )
            : projected;
          let parentUuid = projected.at(-1)?.uuid ?? null;
          const user = record(session, req.params['id'], 'user', parentUuid, {
            daemonPromptId: promptId,
            message: { role: 'user', parts: [{ text }] },
          });
          await session.managed.sink.write(user);
          parentUuid = user.uuid;
          const messageRecord = (
            type: 'assistant' | 'tool_result',
            parts: Part[],
            model: string,
          ) =>
            record(session, req.params['id'], type, parentUuid, {
              daemonPromptId: promptId,
              model,
              message: { role: type === 'assistant' ? 'model' : 'user', parts },
            });
          const commit = async (
            type: 'assistant' | 'tool_result',
            parts: Part[],
            model: string,
          ) => {
            const message = messageRecord(type, parts, model);
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
                    ) <=
                    HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes,
                  session.shell,
                  session.approval && {
                    settings: session.approval,
                    waiters: session.waiters,
                  },
                  session.mcp,
                )
              : undefined;
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
              ...(toolTurn ? { toolTurn } : {}),
            });
            await commit(
              'assistant',
              result.parts ?? [{ text: result.text }],
              result.model,
            );
          } catch (cause) {
            if (
              cause instanceof HostedToolRecoveryRequiredError ||
              cause instanceof HostedMcpRecoveryRequiredError
            )
              throw cause;
            state = abort.signal.aborted ? 'cancelled' : 'error';
            stopReason = state;
            if (state === 'error') {
              writeStderrLineSafe(
                `qwen serve: Hosted Harness turn ${promptId} failed: ${String(cause)}`,
              );
            }
          }
          await toolTurn?.finish();
          turnResult = turnResultRecord(state, stopReason);
          await session.managed.sink.write(turnResult);
          settled = true;
        });
      } catch (cause) {
        if (
          cause instanceof HostedToolRecoveryRequiredError ||
          cause instanceof HostedMcpRecoveryRequiredError
        ) {
          if (admitted) session.blocked = true;
          else if (!res.headersSent)
            error(res, 503, 'hosted_mcp_recovery_required');
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
        if (!res.headersSent)
          error(
            res,
            cause instanceof HostedMcpConnectionQuotaError ? 409 : 503,
            cause instanceof HostedMcpConnectionQuotaError
              ? cause.message
              : 'hosted_prompt_admission_failed',
          );
      } finally {
        if (timer) clearTimeout(timer);
        try {
          await toolTurn?.close();
        } catch (cause) {
          session.blocked = true;
          writeStderrLineSafe(
            `qwen serve: Hosted Shell publisher cleanup failed: ${String(cause)}`,
          );
        }
        session.active = undefined;
      }
    })();
  });

  app.get('/session/:id/mcp-catalog', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    res.json({ catalogs: session.mcp.getCatalogs() });
  });

  app.post('/session/:id/mcp/configurations', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    if (session.mcpBusy || session.mcpRecovering || session.blocked)
      return error(res, 409, 'hosted_mcp_operation_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const expectedRevision = body?.['expectedRevision'];
    let pin: HostedMcpServerPin;
    try {
      if (
        typeof operationId !== 'string' ||
        !UUID.test(operationId) ||
        !Number.isSafeInteger(expectedRevision) ||
        Number(expectedRevision) < 1
      )
        throw new Error('Invalid configuration command.');
      [pin] = parseHostedMcpServers([body?.['server']]);
    } catch {
      return error(res, 400, 'invalid_mcp_configuration');
    }
    session.mcpBusy = true;
    void session.mcp
      .configure(operationId as string, pin, Number(expectedRevision))
      .then(
        () => res.status(202).json({ operationId, state: 'settled' }),
        (cause: unknown) => {
          if (cause instanceof HostedMcpRecoveryRequiredError) {
            error(res, 503, 'hosted_mcp_recovery_required');
            return;
          }
          error(
            res,
            409,
            cause instanceof HostedMcpConnectionQuotaError
              ? cause.message
              : 'hosted_mcp_configuration_failed',
          );
        },
      )
      .finally(() => {
        session.mcpBusy = false;
      });
  });

  app.post('/session/:id/mcp/operations', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    if (session.active || session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_turn_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const serverId = body?.['serverId'];
    const request = object(body?.['request']);
    if (
      typeof operationId !== 'string' ||
      !UUID.test(operationId) ||
      typeof serverId !== 'string' ||
      !request
    )
      return error(res, 400, 'invalid_mcp_operation');
    let invocation: Parameters<HostedMcpSession['invoke']>[2];
    if (
      request['kind'] === 'resource_read' &&
      Object.keys(request).sort().join(',') === 'kind,uri' &&
      typeof request['uri'] === 'string' &&
      request['uri'].trim().length > 0
    ) {
      invocation = { kind: 'resource_read', uri: request['uri'] };
    } else if (
      request['kind'] === 'prompt_get' &&
      Object.keys(request).sort().join(',') === 'arguments,kind,name' &&
      typeof request['name'] === 'string' &&
      request['name'].trim().length > 0 &&
      object(request['arguments']) &&
      Object.values(request['arguments'] as object).every(
        (value) => typeof value === 'string',
      )
    ) {
      invocation = {
        kind: 'prompt_get',
        name: request['name'],
        arguments: request['arguments'] as Record<string, string>,
      };
    } else return error(res, 400, 'invalid_mcp_operation');
    const strings =
      invocation.kind === 'resource_read'
        ? [invocation.uri]
        : [invocation.name, ...Object.entries(invocation.arguments).flat()];
    if (strings.some((value) => /\p{Cs}/u.test(value)))
      return error(res, 400, 'invalid_mcp_operation');
    if (
      (session.blocked || session.mcp.hasPendingOperations()) &&
      !session.managed.authority.extensionRecord('mcp_operation', operationId)
    )
      return error(res, 409, 'hosted_turn_recovery_required');
    session.mcpBusy = true;
    void session.mcp
      .invoke(operationId, serverId, invocation)
      .then(
        (response) => {
          res.status(202).json(response);
        },
        (cause: unknown) => {
          error(
            res,
            cause instanceof HostedMcpConflictError ||
              cause instanceof HostedMcpConnectionQuotaError
              ? 409
              : 503,
            cause instanceof HostedMcpConnectionQuotaError
              ? cause.message
              : 'hosted_mcp_operation_failed',
          );
        },
      )
      .finally(() => {
        session.mcpBusy = false;
      });
  });

  app.post('/session/:id/mcp/operations/:operationId/cancel', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    if (session.mcpClosing || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    session.mcpRecovering = true;
    void session.mcp
      .cancel(req.params['operationId'])
      .then(
        (response) => res.status(202).json(response),
        () => error(res, 503, 'hosted_mcp_cancel_failed'),
      )
      .finally(() => {
        session.mcpRecovering = false;
      });
  });

  app.get('/session/:id/mcp/operations/:operationId', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    if (session.mcpClosing || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    session.mcpRecovering = true;
    void session.mcp
      .status(req.params['operationId'])
      .then(
        (response) => res.json(response),
        () => error(res, 503, 'hosted_mcp_status_failed'),
      )
      .finally(() => {
        session.mcpRecovering = false;
      });
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
      recoveryBlocked:
        session.blocked || (session.mcp?.recoveryBlocked ?? false),
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
  app.post('/session/:id/actions/:requestId/resolve', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const requestId = req.params['requestId'];
    void resolveHostedAction(
      session.managed,
      session.waiters,
      requestId,
      req.body,
      () => session.blocked,
    ).then(
      (result) =>
        result.status === 200
          ? res.json(result.body)
          : error(res, result.status, result.code),
      (cause) => {
        // This answer recorded nothing, so a retry is safe.
        writeStderrLineSafe(
          `qwen serve: Hosted Action ${requestId} could not be resolved: ${String(cause)}`,
        );
        error(res, 503, 'action_resolution_failed');
      },
    );
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
    if (session.active || session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_turn_active');
    session.mcpBusy = true;
    session.mcpClosing = true;
    try {
      await session.mcp?.close();
      await session.managed.close();
      for (const stop of session.streams) stop();
      sessions.delete(req.params['id']);
      res.sendStatus(204);
    } catch {
      error(res, 503, 'managed_session_close_failed');
    } finally {
      session.mcpClosing = false;
      session.mcpBusy = false;
    }
  };
  app.post('/session/:id/detach', (req, res) => {
    void close(req, res);
  });
  app.delete('/session/:id', (req, res) => {
    void close(req, res, true);
  });
}
