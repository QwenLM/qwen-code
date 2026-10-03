/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  readHostedFileHistory,
  commitHostedFileHistory,
  assertHostedFileHistoryCapacity,
  HostedFileHistoryRefusedError,
  HOSTED_UUID,
  canSettleHostedFileHistory,
} from './hosted-file-history.js';
import { parseHostedFileHistoryState } from './hosted-file-history-protocol.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Part } from '@google/genai';
import { convertToFunctionErrorResponse } from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type { Application, Request, Response } from 'express';
import { parseBridgeManagedSessionStore } from '@qwen-code/acp-bridge/bridgeTypes';
import { parseHarnessCheckpointV1 } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { MANAGED_MCP_MAX_CONNECTIONS } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
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
import {
  MANAGED_TOOL_RESULT_LIMITS,
  parseToolResultEnvelope,
  parseToolResultManifestBytes,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  ResourceToolResultSegmentStore,
  type DurableToolResultResourceStore,
} from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
  ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';
import {
  HostedHookSession,
  HostedHookInputConflictError,
  HostedHookRecoveryRequiredError,
  parseHostedHookPin,
  hostedHookOccurrenceId,
} from './hosted-hook-session.js';
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { parseHookExecution } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import { runHostedHookOperation } from './hosted-hook-model.js';
import type { ManagedHookCatalogPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
  isHostedFileHistoryRefusal,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';
import { HostedTextDeltaStream } from './hosted-text-deltas.js';
import {
  recoverHostedRuntimeTurn,
  settleParkedTurnCancelled,
  stopParkedRuntimeExecutions,
  type HostedRuntimeRecoveryReport,
} from './hosted-runtime-recovery.js';
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HOSTED_WORKSPACE_SHELL_PROFILE,
  HostedToolRecoveryRequiredError,
  HostedWorkspaceToolTurn,
  isRetryableWorkspaceAcquisition,
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

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CLIENT = /^[A-Za-z0-9._:-]{1,128}$/u;
/** References whose resources a cold Workspace load verifies at once. */
const RESTORE_READ_BATCH = 32;
/**
 * Resource kinds a cold Workspace load descends into. Of the resources that
 * opening the Session verified, those of these kinds are queued again, so
 * what they reference is verified too; the rest are not read again.
 */
const RESTORE_CONTAINER_KINDS = new Set([
  'managed-session_metadata',
  'managed-file_history',
  'managed-tool-outcome',
  'managed-tool-result-manifest',
  'managed-checkpoint',
  'managed-hook-plan',
  'managed-hook-message-chunks',
]);

interface HostedSession {
  managed: ManagedSession;
  clientId: string;
  cwd: string;
  streams: Set<() => void>;
  active?: { promptId: string; digest: string; abort: AbortController };
  admissions: Map<string, { digest: string; lastEventId: number }>;
  blocked: boolean;
  toolProfile?: HostedWorkspaceToolProfile | typeof HOSTED_MCP_PROFILE;
  publication?: { owner: HttpToolPublicationOwner; captureBytes: number };
  shell?: HostedShellTurnOptions;
  mcp?: HostedMcpSession;
  hooks?: HostedHookSession;
  hooksBusy?: boolean;
  mcpBusy?: boolean;
  mcpClosing?: boolean;
  mcpRecovering?: boolean;
  approval?: HostedApprovalSettings;
  waiters: HostedApprovalWaiters;
  /** A recovery load acquired the Runtime Session for this promptId. On
   * the cancellation path, only the terminal success route and session
   * teardown hand it back; retry-inviting refusals deliberately leave it
   * owed, because a release persists RELEASED forever while a stranded
   * READY lease is re-admitted against the current checkpoint or
   * re-acquired idempotently. The continuation route keeps its #13083
   * handback discipline (a recorded follow-up). */
  runtimeLeaseHeld?: string;
}

async function runHostedLifecycleHook(
  session: HostedSession,
  event: HookEventName,
  operationId: string,
  fields: Record<string, unknown>,
): Promise<unknown> {
  if (!session.hooks) return undefined;
  await session.hooks.ensureReady();
  const signal = new AbortController().signal;
  const controller = new ManagedHookActivationController(session.managed);
  return controller.runHookOperation(
    {
      operationId,
      occurrenceId: hostedHookOccurrenceId(event, operationId),
      originTurnId: null,
    },
    async (scope) => {
      const run = (
        runner?: import('./hosted-hook-session.js').HostedPromptHookRunner,
      ) => session.hooks!.fire(event, operationId, fields, signal, runner);
      if (!(await session.hooks!.needsPromptRunner(event, operationId)))
        return run();
      return runHostedHookOperation(
        {
          sessionId:
            session.managed.authority.sessionHeader.sessionKey.sessionId,
          cwd: session.cwd,
          signal,
          scope,
        },
        run,
      );
    },
  );
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

function unsettledInputsThrough(
  session: HostedSession,
  throughSequence: number,
): Set<string> {
  const accepted = new Set<string>();
  const authority = session.managed.authority;
  for (const event of authority.eventsInSequenceRange(1, throughSequence)) {
    if (event.kind === 'input.accepted')
      accepted.add(event.payload['turnId'] as string);
    if (event.kind === 'turn.settled')
      accepted.delete(event.payload['turnId'] as string);
  }
  return accepted;
}

function hasUnsettledInput(
  session: HostedSession,
  throughSequence: number,
): boolean {
  return unsettledInputsThrough(session, throughSequence).size > 0;
}

function unsettledInputs(session: HostedSession): Set<string> {
  return unsettledInputsThrough(
    session,
    session.managed.authority.committedSequence,
  );
}

// Recovery needs one unambiguous parked Turn; more than one fails closed.
function unsettledPromptId(session: HostedSession): string | undefined {
  const unsettled = unsettledInputs(session);
  return unsettled.size === 1 ? [...unsettled][0] : undefined;
}

async function recoverCancelledPreToolHook(
  session: HostedSession,
  promptId: string,
  events: readonly ManagedSessionEvent[],
): Promise<boolean> {
  const { authority, sink } = session.managed;
  const attempts = new Map<string, unknown>();
  for (const event of events) {
    if (event.kind === 'model.attempt')
      attempts.set(
        event.payload['attemptId'] as string,
        event.payload['state'],
      );
    if (
      event.kind === 'tool.intent' ||
      event.kind === 'tool.receipt' ||
      (event.kind === 'action.changed' &&
        authority.action(event.payload['requestId'] as string)?.state ===
          'requested')
    )
      return false;
  }
  if (
    ![...attempts.values()].includes('output_committed') ||
    [...attempts.values()].some(
      (state) => state !== 'output_committed' && state !== 'abandoned',
    )
  )
    return false;
  const authorization = await authority.harnessRunAuthorization();
  if (
    authorization.status !== 'runnable' ||
    !['before_model', 'model_output_committed'].includes(
      authorization.checkpoint.continuation.phase,
    ) ||
    authorization.checkpoint.tools?.items.length
  )
    return false;
  const history = await readHostedFileHistory(session.managed);
  if (history?.pendingTurn || history?.pendingUndo) return false;
  const current = (await sink.project()).filter(
    (item) => item.daemonPromptId === promptId && item.type !== 'user',
  );
  const [assistant, ...tail] = current;
  if (
    assistant?.type !== 'assistant' ||
    tail.some((item) => item.type !== 'tool_result')
  )
    return false;
  const calls = (assistant.message?.parts ?? []).flatMap((part) =>
    part.functionCall ? [part.functionCall] : [],
  );
  if (
    !calls.length ||
    calls.some((call) => !call.id || !call.name) ||
    new Set(calls.map((call) => call.id)).size !== calls.length
  )
    return false;
  const responded = new Set<string>();
  for (const item of tail) {
    for (const part of item.message?.parts ?? []) {
      const response = part.functionResponse;
      if (
        !response?.id ||
        responded.has(response.id) ||
        !calls.some(
          (call) => call.id === response.id && call.name === response.name,
        )
      )
        return false;
      responded.add(response.id);
    }
  }
  let cancelled = false;
  for (const { record } of authority.extensionRecordsInDomain(
    'hook_execution',
  )) {
    const execution = parseHookExecution(record);
    if (
      execution.eventName !== HookEventName.PreToolUse ||
      execution.hookId === '__plan__' ||
      !execution.cancelRequested ||
      execution.run.state !== 'cancelled' ||
      execution.run.execution !== 'not_started_proven'
    )
      continue;
    const input = object(
      JSON.parse(
        (await session.managed.resources.read(execution.inputRef)).toString(),
      ),
    );
    if (
      input?.['prompt_id'] === promptId &&
      calls.some(
        (call) =>
          input['tool_use_id'] === call.id &&
          input['tool_name'] === call.name &&
          execution.occurrenceId ===
            hostedHookOccurrenceId(
              HookEventName.PreToolUse,
              `${promptId}:${call.id}`,
            ),
      )
    )
      cancelled = true;
  }
  if (!cancelled) return false;
  const missing = calls.filter((call) => !responded.has(call.id!));
  const refusalRecord = (parts: Part[], parentUuid: string) =>
    record(
      session,
      authority.sessionHeader.sessionKey.sessionId,
      'tool_result',
      parentUuid,
      {
        daemonPromptId: promptId,
        model: assistant.model,
        message: { role: 'user', parts },
      },
    );
  let result = refusalRecord([], current.at(-1)!.uuid);
  const maxBytes = HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
  for (const part of missing.flatMap((call) =>
    convertToFunctionErrorResponse(
      call.name!,
      call.id!,
      [],
      'The turn was cancelled before this tool call ran.',
    ),
  )) {
    result.message!.parts!.push(part);
    if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) continue;
    result.message!.parts!.pop();
    if (!result.message!.parts!.length)
      throw new Error(
        'Hosted tool refusal exceeds the inline Session Store limit.',
      );
    await sink.write(result);
    result = refusalRecord([part], result.uuid);
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
      throw new Error(
        'Hosted tool refusal exceeds the inline Session Store limit.',
      );
  }
  if (result.message!.parts!.length) await sink.write(result);
  return true;
}

async function settleCancelledHookTurn(session: HostedSession): Promise<void> {
  if (
    !session.blocked ||
    session.active ||
    session.hooksBusy ||
    session.mcpBusy ||
    session.mcpRecovering ||
    !session.hooks ||
    session.hooks.hasPendingOperations
  )
    return;
  session.hooksBusy = true;
  try {
    const { authority } = session.managed;
    const events = authority.eventsInSequenceRange(
      1,
      authority.committedSequence,
    );
    const pending = new Map<string, number>();
    for (const event of events) {
      if (event.kind === 'input.accepted')
        pending.set(event.payload['turnId'] as string, event.sequence);
      if (event.kind === 'turn.settled')
        pending.delete(event.payload['turnId'] as string);
    }
    if (pending.size !== 1) return;
    const [promptId, sequence] = [...pending][0];
    const turnEvents = events.filter((event) => event.sequence > sequence);
    const preModel = !turnEvents.some(
      (event) =>
        event.kind === 'model.attempt' ||
        event.kind === 'tool.intent' ||
        event.kind === 'tool.receipt' ||
        (event.kind === 'message.committed' &&
          event.payload['role'] !== 'user'),
    );
    const occurrenceIds = new Set([
      hostedHookOccurrenceId(HookEventName.UserPromptSubmit, promptId),
      hostedHookOccurrenceId(
        HookEventName.SessionStart,
        `session-start:${authority.sessionHeader.sessionKey.sessionId}`,
      ),
    ]);
    let cancelled = false;
    if (preModel)
      for (const { record } of authority.extensionRecordsInDomain(
        'hook_execution',
      )) {
        const execution = parseHookExecution(record);
        const cancelledInstructions =
          execution.eventName === HookEventName.InstructionsLoaded &&
          execution.hookId !== '__plan__' &&
          execution.cancelRequested;
        if (
          (!occurrenceIds.has(execution.occurrenceId) &&
            !cancelledInstructions) ||
          execution.run.state !== 'cancelled' ||
          execution.run.execution !== 'not_started_proven'
        )
          continue;
        const input = object(
          JSON.parse(
            (
              await session.managed.resources.read(execution.inputRef)
            ).toString(),
          ),
        );
        if (input?.['prompt_id'] === promptId) {
          cancelled = true;
          break;
        }
      }
    if (!preModel)
      cancelled = await recoverCancelledPreToolHook(
        session,
        promptId,
        turnEvents,
      );
    if (!cancelled) return;
    await session.managed.sink.write(
      record(
        session,
        authority.sessionHeader.sessionKey.sessionId,
        'system',
        null,
        {
          subtype: 'turn_result',
          systemPayload: {
            promptId,
            state: 'cancelled',
            stopReason: 'cancelled',
            endedAt: Date.now(),
          },
        },
      ),
    );
    session.blocked = false;
  } finally {
    session.hooksBusy = false;
  }
}

async function readShellReceipt(
  session: HostedSession,
  receipt: ManagedSessionEvent,
) {
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
  const decision: 'committed' | 'blocked' =
    envelope.capture?.captureStatus === 'complete' ? 'committed' : 'blocked';
  if (
    ref.kind !== 'managed-tool-outcome' ||
    outcome?.['schemaVersion'] !== 1 ||
    outcome['decision'] !== decision ||
    !isDeepStrictEqual(outcome['manifestRef'], manifest) ||
    !isDeepStrictEqual(
      receipt.payload['resultRef'],
      decision === 'committed' ? manifest : null,
    ) ||
    !isDeepStrictEqual(
      receipt.payload['resources'],
      manifest ? [manifest] : [],
    ) ||
    receipt.payload['historyRevision'] !== receipt.sequence ||
    typeof history?.['messageId'] !== 'string' ||
    !HOSTED_UUID.test(history['messageId']) ||
    typeof history['timestamp'] !== 'string' ||
    typeof history['model'] !== 'string' ||
    !Array.isArray(history['parts'])
  )
    throw new Error('Original Shell receipt or history conflicts.');
  return {
    executionCallId,
    ref,
    envelope,
    manifest,
    decision,
    history: {
      messageId: history['messageId'],
      timestamp: history['timestamp'],
      model: history['model'],
      parts: history['parts'],
    },
  };
}

async function verifyWorkspaceRestore(
  session: HostedSession,
  preverified: ReadonlyMap<string, ManagedSessionDurableRef>,
  toolResults: DurableToolResultResourceStore,
  throughSequence: number,
): Promise<boolean> {
  const { authority, resources, sink } = session.managed;
  const segmentStore = new ResourceToolResultSegmentStore(toolResults);
  const manifests = new Map<string, ManagedSessionDurableRef>();
  // What opening the Session verified is checked for conflicting references
  // but not read again, except the kinds this verification descends into,
  // which are queued with the other references below.
  const verified = new Map<
    string,
    { ref: ManagedSessionDurableRef; done: Promise<void> }
  >();
  const descend: ManagedSessionDurableRef[] = [];
  for (const [id, ref] of preverified) {
    if (RESTORE_CONTAINER_KINDS.has(ref.kind)) descend.push(ref);
    else verified.set(id, { ref, done: Promise.resolve() });
  }
  const publicationManifests = new Set<string>();
  let incomplete = false;
  function readRef(ref: ManagedSessionDurableRef): Promise<void> {
    const previous = verified.get(ref.resourceId);
    if (previous) {
      if (
        previous.ref.kind !== ref.kind ||
        previous.ref.schemaVersion !== ref.schemaVersion ||
        previous.ref.byteLength !== ref.byteLength ||
        previous.ref.digest !== ref.digest
      )
        return Promise.reject(
          new Error('Hosted resource references conflict.'),
        );
      return previous.done;
    }
    const done = verifyRef(ref);
    verified.set(ref.resourceId, { ref, done });
    return done;
  }
  async function verifyRef(ref: ManagedSessionDurableRef): Promise<void> {
    const bytes = await resources.read(ref);
    if (ref.kind === 'managed-tool-result-manifest')
      manifests.set(ref.resourceId, ref);
    if (
      ref.kind === 'managed-session_metadata' ||
      ref.kind === 'managed-file_history'
    ) {
      const metadata = object(JSON.parse(bytes.toString('utf8')));
      if (
        !metadata ||
        (ref.kind === 'managed-session_metadata'
          ? typeof metadata['title'] !== 'string'
          : metadata['schemaVersion'] !== 1)
      )
        throw new Error('Hosted recovery layout is unsupported.');
      if (ref.kind === 'managed-file_history')
        parseHostedFileHistoryState(
          metadata['state'],
          authority.sessionHeader.sessionKey.sessionId,
        );
      if (metadata['previousRecordRef'])
        await readRef(
          metadata['previousRecordRef'] as unknown as ManagedSessionDurableRef,
        );
    }
    if (ref.kind === 'managed-tool-outcome') {
      const outcome = object(JSON.parse(bytes.toString('utf8')));
      if (outcome?.['manifestRef'])
        await readRef(
          assertManagedSessionDurableRef(
            outcome['manifestRef'] as ManagedSessionJsonValue,
            'outcome manifest',
          ),
        );
    }
    if (ref.kind === 'managed-checkpoint') {
      const checkpoint = parseHarnessCheckpointV1(bytes);
      if (
        checkpoint.resume.fileHistoryRef ||
        checkpoint.output.mediaRefs.length
      )
        throw new Error('Hosted recovery layout is unsupported.');
      const refs = [
        checkpoint.resume.apiHistoryRef,
        checkpoint.resume.artifactRef,
        checkpoint.resume.goalRecordsRef,
        checkpoint.resume.goalCheckpointWindowRef,
        checkpoint.resume.tokenCountsRef,
        checkpoint.resume.uiTelemetryRef,
        checkpoint.resume.attributionRef,
        checkpoint.attempt?.routeRef,
        checkpoint.attempt?.capabilityRef,
        checkpoint.attempt?.samplingRef,
        checkpoint.attempt?.usageRef,
        ...(checkpoint.tools?.items.map((item) => item.outcomeRef) ?? []),
        checkpoint.approval?.optionsRef,
        checkpoint.approval?.decisionRef,
        checkpoint.approval?.invocationRef,
        checkpoint.output.llmContentRef,
        checkpoint.output.hookResultRef,
      ];
      for (const nested of refs) {
        if (nested) await readRef(nested);
      }
    }
    if (ref.kind === 'managed-hook-plan') {
      const plan = object(JSON.parse(bytes.toString()));
      if (!plan) throw new Error('Hosted Hook plan is invalid.');
      if (plan['messagesRef'] !== undefined)
        await readRef(
          assertManagedSessionDurableRef(
            plan['messagesRef'] as ManagedSessionJsonValue,
            'Hook messages',
          ),
        );
    }
    if (ref.kind === 'managed-hook-message-chunks') {
      const parts = object(JSON.parse(bytes.toString()))?.['parts'];
      if (!Array.isArray(parts))
        throw new Error('Hosted Hook message manifest is invalid.');
      for (const part of parts)
        await readRef(
          assertManagedSessionDurableRef(part, 'Hook message part'),
        );
    }
  }
  const header = authority.sessionHeader;
  const events = authority.eventsInSequenceRange(1, throughSequence);
  for (const event of events) {
    if (
      event.kind === 'domain.committed' &&
      ![
        'session_metadata',
        'hook_registration',
        'hook_execution',
        'file_history',
      ].includes(event.payload['domain'] as string)
    )
      throw new Error('Hosted recovery domain is unsupported.');
  }
  const refs = [
    header.definitionRef,
    header.rootSnapshotRef,
    ...(header.baseTranscriptProof ? [header.baseTranscriptProof] : []),
  ];
  for (const event of events) {
    for (const [field, value] of Object.entries(event.payload)) {
      if (field.endsWith('Ref') && value !== null && value !== undefined) {
        refs.push(value as unknown as ManagedSessionDurableRef);
      } else if (field === 'resources' && Array.isArray(value)) {
        for (const ref of value)
          refs.push(ref as unknown as ManagedSessionDurableRef);
      }
    }
  }
  refs.push(...descend);
  // Independent reads, a bounded batch at a time; a resource several
  // references name is still read once. A batch settles fully before a
  // failure is reported, so no read outlives the verification.
  for (let index = 0; index < refs.length; index += RESTORE_READ_BATCH) {
    const results = await Promise.allSettled(
      refs.slice(index, index + RESTORE_READ_BATCH).map((ref) => readRef(ref)),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  if (session.publication) {
    for (const event of authority.eventsInSequenceRange(1, throughSequence)) {
      if (event.kind !== 'tool.receipt') continue;
      const { executionCallId, ref, envelope, manifest } =
        await readShellReceipt(session, event);
      if (
        envelope.executionStatus === 'not_started' &&
        envelope.capture === null
      )
        continue;
      const receipt = object(
        await session.publication.owner.request('/receipts/verify', {
          executionCallId,
          toolOutcomeRef: ref,
          manifestRef: manifest,
          historyRevision: event.sequence,
        }),
      );
      if (
        !isDeepStrictEqual(receipt?.['toolOutcomeRef'], ref) ||
        !isDeepStrictEqual(receipt?.['manifestRef'], manifest) ||
        receipt?.['historyRevision'] !== event.sequence
      )
        throw new Error('Original publication verification conflicts.');
      if (manifest) publicationManifests.add(manifest.resourceId);
      if (envelope.capture?.captureStatus !== 'complete') incomplete = true;
    }
  }
  for (const ref of manifests.values()) {
    const manifest = parseToolResultManifestBytes(await toolResults.read(ref));
    if (session.publication) {
      if (!publicationManifests.has(ref.resourceId))
        throw new Error('Hosted publication has no verified receipt.');
      continue;
    }
    if (manifest.captureStatus !== 'complete')
      throw new Error('Hosted tool result capture is incomplete.');
    for (const content of manifest.contents) {
      if ('ref' in content.body) {
        const bytes = await toolResults.read(content.body.ref);
        if (createHash('sha256').update(bytes).digest('hex') !== content.digest)
          throw new Error('Hosted tool result content is incomplete.');
      } else {
        const hash = createHash('sha256');
        for (
          let offset = 0;
          offset < content.byteLength ||
          (content.byteLength === 0 && offset === 0);
          offset += MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes
        ) {
          const read = await segmentStore.readRange({
            manifestRef: ref,
            expectedIdentity: manifest,
            streamId: content.streamId,
            offset,
            length: Math.min(
              MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes,
              content.byteLength - offset,
            ),
          });
          if (read.status !== 'ok')
            throw new Error('Hosted tool result content is incomplete.');
          hash.update(read.result);
        }
        if (hash.digest('hex') !== content.digest)
          throw new Error('Hosted tool result content is incomplete.');
      }
    }
  }
  await sink.project(throughSequence);
  return incomplete;
}

async function recoverShellReceipts(
  session: HostedSession,
  options: HostedWorkspaceBrokerOptions,
  throughSequence: number,
): Promise<string | null> {
  const authority = session.managed.authority;
  const events = authority.eventsInSequenceRange(1, throughSequence);
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
  const projected = receipts.length
    ? await session.managed.sink.project(throughSequence)
    : [];
  const projectedIds = new Set(projected.map((item) => item.uuid));
  for (const { promptId: receiptPromptId, event: receipt } of receipts) {
    const { executionCallId, ref, history, envelope, manifest, decision } =
      await readShellReceipt(session, receipt);
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
      (decision === 'committed' ||
        envelope.executionStatus === 'not_started') &&
      authorization.status === 'runnable' &&
      authorization.checkpoint.continuation.phase === 'await_runtime' &&
      receiptPromptId === promptId &&
      authorization.checkpoint.tools?.items.some(
        (item) => item.executionCallId === executionCallId,
      )
    )
      await harness.resolveAwaitRuntime(executionCallId, ref);
    if (
      receiptPromptId !== promptId ||
      envelope.executionStatus === 'not_started'
    )
      continue;
    const intent = events.findLast(
      (event) =>
        event.sequence < receipt.sequence &&
        event.kind === 'tool.intent' &&
        event.payload['executionCallId'] === executionCallId,
    );
    const inputRef = assertManagedSessionDurableRef(
      intent?.payload['argsRef'],
      'original Shell input',
    );
    if (inputRef.kind !== 'managed-tool-input')
      throw new Error('Original Shell Runtime owner conflicts.');
    const input = object(
      JSON.parse((await session.managed.resources.read(inputRef)).toString()),
    );
    if (
      input?.['harnessSessionId'] !==
        authority.sessionHeader.sessionKey.sessionId ||
      typeof input['runtimeSessionId'] !== 'string'
    )
      throw new Error('Original Shell Runtime owner conflicts.');
    const runtimeSessionId = assertManagedSessionStableId(
      input['runtimeSessionId'],
      'original Shell Runtime owner',
    );
    try {
      const broker = new HostedWorkspaceBroker(
        options,
        authority.sessionHeader.sessionKey,
        runtimeSessionId,
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
  onResumeReady?: () => void,
): Promise<ChatRecord> {
  const authority = session.managed.authority;
  const harness = createManagedHarnessHandle(session.managed);
  let turnResult: ChatRecord | undefined;
  let toolTurn: HostedWorkspaceToolTurn | undefined;
  const running = new ManagedHookActivationController(session.managed).runTurn(
    promptId,
    async (modelScope) =>
      harness.run(async () => {
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
        const deltas = session.toolProfile
          ? new HostedTextDeltaStream(session.managed, promptId)
          : undefined;
        const commit = async (
          type: 'assistant' | 'tool_result',
          parts: Part[],
          model: string,
          identity?: { uuid: string; timestamp: string },
        ) => {
          const message = messageRecord(type, parts, model, identity);
          if (type === 'assistant' && deltas) {
            const streamed = deltas.takeMessageId();
            if (streamed !== undefined) message.uuid = streamed;
          }
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
                session.publication,
                session.shell,
                session.approval && {
                  settings: session.approval,
                  waiters: session.waiters,
                },
                session.mcp,
                session.hooks,
              )
            : undefined;
        if (resumeFromToolResults) {
          if (!toolTurn)
            throw new HostedToolRecoveryRequiredError(
              'Tool turn is unavailable.',
            );
          try {
            await toolTurn.resumeCommittedResults();
          } catch (cause) {
            if (isRetryableWorkspaceAcquisition(cause)) throw cause;
            throw new HostedToolRecoveryRequiredError(cause);
          }
          onResumeReady?.();
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
            modelScope,
            ...(session.hooks ? { hooks: session.hooks } : {}),
            ...(toolTurn ? { toolTurn } : {}),
            ...(resumeFromToolResults ? { resumeFromToolResults } : {}),
            ...(deltas ? { textDeltas: deltas } : {}),
          });
          await commit(
            'assistant',
            result.parts ?? [{ text: result.text }],
            result.model,
          );
        } catch (cause) {
          if (
            cause instanceof HostedToolRecoveryRequiredError ||
            cause instanceof HostedMcpRecoveryRequiredError ||
            cause instanceof HostedHookRecoveryRequiredError
          )
            throw cause;
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
      }),
  );
  // Session availability must not gate on publisher cleanup: the drain is
  // unbounded, and a stalled Session Store would otherwise leave the Session
  // permanently unavailable and undeletable. Each turn owns its publisher,
  // so a next turn shares no listener or capture state with this drain.
  await running.finally(() => {
    void toolTurn?.close().catch((cause: unknown) => {
      session.blocked = true;
      writeStderrLineSafe(
        'qwen serve: Hosted Shell publisher cleanup failed: ' + String(cause),
      );
    });
  });
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
    let toolProfile = body?.['toolProfile'];
    let captureBytes = body?.['captureBytes'];
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
    let hookCatalog: ManagedHookCatalogPin | undefined;
    try {
      if (body?.['hookCatalog'] !== undefined) {
        if (!brokerOptions || (create && !toolProfile))
          throw new Error('Hooks require a Hosted Workspace profile.');
        hookCatalog = parseHostedHookPin(body['hookCatalog']);
      }
    } catch {
      error(res, 400, 'invalid_hosted_hook_catalog');
      return;
    }
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
      !HOSTED_UUID.test(sessionId) ||
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
                  ...(hookCatalog ? { hookCatalog } : {}),
                  ...(toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE
                    ? { captureBytes }
                    : {}),
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
        ...(refs
          ? { create: refs, requireNew: true }
          : { retainVerifiedResources: true }),
      });
      // Taken now, so the authority keeps none of it for the Session's
      // lifetime; a cold Workspace load reuses it below.
      const preverified =
        await managed.authority.takeVerifiedExtensionResources();
      const definition = object(
        JSON.parse(
          (
            await managed.resources.read(
              managed.authority.sessionHeader.definitionRef,
            )
          ).toString('utf8'),
        ),
      );
      const savedProfile = definition?.['toolProfile'];
      if (
        !create &&
        toolProfile === undefined &&
        (savedProfile === HOSTED_WORKSPACE_FILE_PROFILE ||
          savedProfile === HOSTED_WORKSPACE_SHELL_PROFILE)
      )
        toolProfile = savedProfile;
      if (!create && hookCatalog === undefined && definition?.['hookCatalog']) {
        try {
          hookCatalog = parseHostedHookPin(definition['hookCatalog']);
        } catch {
          await managed.close();
          error(res, 409, 'hosted_tool_profile_conflict');
          return;
        }
      }
      if (
        !create &&
        toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE &&
        captureBytes === undefined
      )
        captureBytes = definition?.['captureBytes'];
      const workspaceProfile =
        toolProfile === HOSTED_WORKSPACE_FILE_PROFILE ||
        toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE;
      if (
        (hookCatalog !== undefined && (!toolProfile || !brokerOptions)) ||
        (toolProfile !== undefined &&
          ((toolProfile !== HOSTED_WORKSPACE_FILE_PROFILE &&
            toolProfile !== HOSTED_WORKSPACE_SHELL_PROFILE &&
            toolProfile !== HOSTED_MCP_PROFILE) ||
            !brokerOptions))
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (
        toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE &&
        captureBytes !== undefined &&
        (!Number.isSafeInteger(captureBytes) ||
          (captureBytes as number) < 1 ||
          (captureBytes as number) > 2 ** 41)
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      const session: HostedSession = {
        managed,
        clientId: randomUUID(),
        cwd,
        streams: new Set(),
        admissions: new Map(),
        blocked: false,
        waiters: new HostedApprovalWaiters(),
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
      const pinned = toolProfile
        ? readHostedApprovalDefinition(definition)
        : undefined;
      if (
        definition?.['toolProfile'] !== toolProfile ||
        JSON.stringify(definition?.['mcpServers']) !==
          JSON.stringify(mcpServers) ||
        !isDeepStrictEqual(definition?.['hookCatalog'], hookCatalog) ||
        (toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE &&
          definition?.['captureBytes'] !== captureBytes) ||
        (toolProfile && !pinned)
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (mcpServers && brokerOptions)
        session.mcp = new HostedMcpSession(brokerOptions, managed, mcpServers);
      if (hookCatalog && brokerOptions)
        session.hooks = new HostedHookSession(
          brokerOptions,
          managed,
          hookCatalog,
          session.mcp?.broker,
        );
      if (pinned) session.approval = pinned;
      // A takeover recovers exactly the parked Turn, including the file
      // history it left pending; only refuse a stranger's pending state.
      const unsettled = unsettledPromptId(session);
      // Cold loads stay inert: only an explicit takeover request may touch
      // the Broker or settle anything. A bare load of a parked Session keeps
      // refusing with 409 so it never drives a Runtime by accident.
      const takeover =
        !session.hooks &&
        (body?.['passiveManagedRuntimeRecovery'] === true ||
          body?.['driveRuntimeRecovery'] === true);
      const fileHistory = await readHostedFileHistory(managed);
      if (
        fileHistory?.pendingUndo ||
        (fileHistory?.pendingTurn &&
          !(takeover && fileHistory.pendingTurn === unsettled) &&
          !(await canSettleHostedFileHistory(managed, fileHistory)))
      ) {
        await managed.close();
        error(
          res,
          409,
          fileHistory.pendingUndo
            ? 'hosted_file_history_recovery_required'
            : 'hosted_turn_recovery_required',
        );
        return;
      }
      const restore = await managed.authority.restoreBundle();
      if (restore.recoveryStatus !== 'ok') {
        await managed.close();
        error(res, 409, 'hosted_turn_recovery_required');
        return;
      }
      let incompletePublication = false;
      if (!create && workspaceProfile) {
        try {
          incompletePublication = await verifyWorkspaceRestore(
            session,
            preverified,
            stores.toolResultResources,
            restore.throughSequence,
          );
          await stores.assertWritable();
        } catch {
          await managed.close();
          error(res, 409, 'hosted_turn_recovery_required');
          return;
        }
      }
      let resume: { promptId: string; text: string; parts: Part[] } | undefined;
      let settlePromptId: string | undefined;
      let recovery: HostedRuntimeRecoveryReport | undefined;
      if (
        restore.recoveryStatus === 'ok' &&
        unsettled !== undefined &&
        takeover
      ) {
        // A parked Runtime turn is taken over, not refused: settle its
        // executions under their original ids (or report them for a
        // cancellation) and answer with the recovery snapshot.
        if (toolProfile === undefined || !brokerOptions) {
          await managed.close();
          error(res, 409, 'hosted_turn_recovery_required');
          return;
        }
        try {
          const recovered = await recoverHostedRuntimeTurn({
            session: managed,
            sessionId,
            cwd,
            promptId: unsettled,
            brokerOptions,
            passive: body?.['passiveManagedRuntimeRecovery'] === true,
          });
          if (recovered === undefined) {
            await managed.close();
            error(res, 409, 'hosted_turn_recovery_required');
            return;
          }
          recovery = recovered.report;
          if (recovered.acquiredRuntime)
            session.runtimeLeaseHeld =
              recovered.report.executions[0]?.runtimeSessionId ??
              recovered.promptId;
        } catch (cause) {
          await managed.close();
          writeStderrLineSafe(
            `qwen serve: Hosted Harness recovery of session ${sessionId} failed: ${String(cause)}`,
          );
          // A failed takeover keeps the turn parked for the next attempt:
          // refuse exactly like a plain recovery refusal so the coordinator
          // retries instead of failing the Turn.
          error(res, 409, 'hosted_turn_recovery_required');
          return;
        }
      } else if (
        restore.recoveryStatus === 'ok' &&
        (session.publication || session.hooks || fileHistory) &&
        brokerOptions
      ) {
        const pendingInputs = new Set<string>();
        for (const event of managed.authority.eventsInSequenceRange(
          1,
          restore.throughSequence,
        )) {
          if (event.kind === 'input.accepted')
            pendingInputs.add(event.payload['turnId'] as string);
          if (event.kind === 'turn.settled')
            pendingInputs.delete(event.payload['turnId'] as string);
        }
        const recoveredPromptId = session.publication
          ? await recoverShellReceipts(
              session,
              brokerOptions,
              restore.throughSequence,
            )
          : session.hooks && pendingInputs.size === 1
            ? [...pendingInputs][0]
            : null;
        const authorization = await managed.authority.harnessRunAuthorization();
        const promptId =
          recoveredPromptId ??
          (fileHistory &&
          hasUnsettledInput(session, restore.throughSequence) &&
          authorization.status === 'runnable'
            ? authorization.checkpoint.identity.promptId
            : null);
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
          parts.length > 0 &&
          (!fileHistory ||
            (await canSettleHostedFileHistory(managed, {
              ...fileHistory,
              pendingTurn: promptId,
              pendingMessageId: current[lastAssistant].uuid,
            })))
        )
          resume = { promptId, text: prompt, parts };
        if (
          promptId &&
          authorization.status === 'runnable' &&
          ['results_ready', 'turn_settled'].includes(
            authorization.checkpoint.continuation.phase,
          ) &&
          authorization.checkpoint.tools?.items.every(
            (item) =>
              item.state === 'settled' &&
              (authorization.checkpoint.continuation.phase === 'turn_settled' ||
                item.consumed),
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
        incompletePublication ||
        (hasUnsettledInput(
          session,
          workspaceProfile
            ? restore.throughSequence
            : managed.authority.committedSequence,
        ) &&
          !resume &&
          !settlePromptId &&
          !session.hooks &&
          !recovery)
      ) {
        // A retry-inviting refusal keeps a takeover-adopted lease owed on
        // the Broker side: the coordinator's retried load re-acquires the
        // READY identity idempotently, while a release would persist
        // RELEASED and wedge every retry with runtime_session_not_acquirable.
        // This Session, though, is closed before registration, so no route
        // can ever see the owed lease again — record it and say so, or the
        // strand is silent until retirement.
        noteOwedAdoption(session, sessionId);
        await managed.close();
        error(res, 409, 'hosted_turn_recovery_required');
        return;
      }
      if (!create && workspaceProfile) {
        try {
          await stores.assertWritable();
        } catch {
          // Same owed-lease discipline as the refusal above.
          noteOwedAdoption(session, sessionId);
          await managed.close();
          error(res, 409, 'hosted_turn_recovery_required');
          return;
        }
      }
      if (
        hasUnsettledInput(session, restore.throughSequence) &&
        !resume &&
        !settlePromptId &&
        !recovery
      )
        session.blocked = true;
      await settleCancelledHookTurn(session);
      if (resume) {
        const abort = new AbortController();
        session.active = {
          promptId: resume.promptId,
          digest: '',
          abort,
        };
        let resolveReady!: () => void;
        let rejectReady!: (cause: unknown) => void;
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        const resumed = executeHostedTurn(
          session,
          sessionId,
          cwd,
          resume.promptId,
          resume.text,
          abort,
          brokerOptions,
          resume.parts,
          undefined,
          resolveReady,
        );
        // Do not attach a Session whose original continuation cannot acquire
        // Workspace ownership. The caller can retry load without losing it.
        void resumed.catch(rejectReady);
        await ready;
        void resumed
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
      sessions.set(sessionId, session);
      // The registered Session now carries the owed lease itself; the
      // refusal-time record is discharged.
      refusedAdoptions.delete(sessionId);
      res.status(200).json({
        sessionId,
        clientId: session.clientId,
        workspaceCwd: cwd,
        lastEventId: managed.authority.committedSequence,
        eventEpoch: epoch,
        // A Harness older than approvals omits this, so a caller can tell.
        ...(pinned ? { approvalMode: pinned.mode } : {}),
        ...(session.blocked || session.hooks?.hasPendingOperations
          ? { recoveryRequired: true }
          : {}),
        ...(recovery
          ? { _meta: { 'qwen.daemon.managedRuntimeRecovery': recovery } }
          : {}),
      });
      if (settlePromptId) {
        const originalPromptId = settlePromptId;
        const abort = new AbortController();
        session.active = { promptId: originalPromptId, digest: '', abort };
        void (async () => {
          const harness = createManagedHarnessHandle(session.managed);
          await harness.run(async () => {
            await harness.settleConsumedRuntimeContinuation();
            if (!session.hooks && !session.mcp)
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
      if (isRetryableWorkspaceAcquisition(cause)) {
        error(res, 409, cause.code);
      } else if (cause instanceof ManagedSessionAlreadyExistsError) {
        error(res, 409, 'managed_session_already_exists');
      } else if (cause instanceof ManagedSessionNotFoundError) {
        error(res, 404, 'managed_session_not_found');
      } else {
        writeStderrLineSafe(
          `qwen serve: Hosted Session open failed: ${String(cause)}`,
        );
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
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.hooksBusy)
      return error(res, 409, 'hosted_hook_operation_active');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    const body = object(req.body);
    const promptId = body?.['promptId'];
    const prompt = body?.['prompt'];
    const digest = body?.['payloadDigest'];
    const deadlineMs = body?.['deadlineMs'];
    if (
      typeof promptId !== 'string' ||
      !HOSTED_UUID.test(promptId) ||
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
    if (
      session.blocked ||
      session.managed.authority.currentActivation?.phase !== 'active' ||
      session.mcp?.hasPendingOperations() ||
      session.hooks?.hasPendingOperations
    )
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
        await session.mcp?.ensureReady(abort.signal);
        await session.hooks?.ensureReady(abort.signal);
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
        if (
          cause instanceof HostedToolRecoveryRequiredError ||
          cause instanceof HostedMcpRecoveryRequiredError ||
          cause instanceof HostedHookRecoveryRequiredError
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
        session.active = undefined;
      }
    })();
  });

  app.get('/session/:id/hooks', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.hooks) return error(res, 409, 'hosted_hooks_unavailable');
    const catalog = session.hooks.getCatalog();
    res.json({
      catalog: catalog
        ? {
            ...catalog,
            hooks: catalog.hooks.map(
              ({ config, handler: _handler, ...hook }) => ({
                ...hook,
                type: config.type,
              }),
            ),
          }
        : null,
    });
  });

  app.post('/session/:id/hooks/operations', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.hooks) return error(res, 409, 'hosted_hooks_unavailable');
    if (
      session.active ||
      session.hooksBusy ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.blocked
    )
      return error(res, 409, 'hosted_turn_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const event = body?.['event'];
    const fields = object(body?.['input']);
    if (
      typeof operationId !== 'string' ||
      !HOSTED_UUID.test(operationId) ||
      (event !== HookEventName.Notification &&
        event !== HookEventName.UserPromptExpansion) ||
      !fields
    )
      return error(res, 400, 'invalid_hook_operation');
    if (
      (event === HookEventName.Notification &&
        (typeof fields['message'] !== 'string' ||
          typeof fields['notification_type'] !== 'string')) ||
      (event === HookEventName.UserPromptExpansion &&
        (typeof fields['command_name'] !== 'string' ||
          typeof fields['command_args'] !== 'string' ||
          typeof fields['prompt'] !== 'string'))
    )
      return error(res, 400, 'invalid_hook_input');
    if (
      session.hooks.hasPendingOperations &&
      !session.managed.authority.extensionRecord(
        'hook_execution',
        hostedHookOccurrenceId(event, operationId),
      )
    )
      return error(res, 409, 'hosted_hook_recovery_required');
    session.hooksBusy = true;
    const input =
      event === HookEventName.Notification
        ? {
            message: fields['message'],
            notification_type: fields['notification_type'],
          }
        : {
            command_name: fields['command_name'],
            command_args: fields['command_args'],
            prompt: fields['prompt'],
          };
    void runHostedLifecycleHook(session, event, operationId, input)
      .then(
        (output) => res.json({ operationId, output: output ?? null }),
        (cause) => {
          if (cause instanceof HostedHookInputConflictError)
            return error(res, 409, 'hosted_hook_operation_conflict');
          writeStderrLineSafe(
            cause instanceof HostedHookRecoveryRequiredError
              ? `qwen serve: Hosted Hook operation ${operationId} is recovery blocked: ${String(cause)}`
              : `qwen serve: Hosted Hook operation ${operationId} failed: ${String(cause)}`,
          );
          error(res, 503, 'hosted_hook_operation_failed');
        },
      )
      .finally(() => {
        session.hooksBusy = false;
      });
  });

  const hookStatus = (cancel: boolean) => (req: Request, res: Response) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.hooks) return error(res, 409, 'hosted_hooks_unavailable');
    void session.hooks
      .status(req.params['operationId'], cancel)
      .then(async (execution) => {
        if (execution.hookId !== '__plan__')
          await session.hooks!.status(execution.occurrenceId);
        await settleCancelledHookTurn(session);
        res.json({
          operationId: execution.hookExecutionId,
          state: execution.run.state,
          execution: execution.run.execution,
          cancelRequested: execution.cancelRequested,
        });
      })
      .catch(() => error(res, 409, 'hosted_hook_recovery_required'));
  };
  app.get('/session/:id/hooks/operations/:operationId', hookStatus(false));
  app.post(
    '/session/:id/hooks/operations/:operationId/cancel',
    hookStatus(true),
  );

  app.post('/session/:id/hooks/registrations', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.hooks) return error(res, 409, 'hosted_hooks_unavailable');
    if (
      session.active ||
      session.hooksBusy ||
      session.mcpBusy ||
      session.mcpRecovering
    )
      return error(res, 409, 'hosted_turn_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const expectedRevision = body?.['expectedRevision'];
    let pin: ManagedHookCatalogPin;
    try {
      if (
        typeof operationId !== 'string' ||
        !HOSTED_UUID.test(operationId) ||
        !Number.isSafeInteger(expectedRevision) ||
        (expectedRevision as number) < 0
      )
        throw new Error('Invalid registration.');
      pin = parseHostedHookPin(body?.['catalog']);
    } catch {
      return error(res, 400, 'invalid_hook_registration');
    }
    session.hooksBusy = true;
    void session.hooks
      .configure(operationId as string, pin, expectedRevision as number)
      .then(
        () => res.json({ operationId, registered: true }),
        () => error(res, 409, 'hook_registration_failed'),
      )
      .finally(() => {
        session.hooksBusy = false;
      });
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
        !HOSTED_UUID.test(operationId) ||
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
    if (
      session.active ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.hooksBusy
    )
      return error(res, 409, 'hosted_turn_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const serverId = body?.['serverId'];
    const request = object(body?.['request']);
    if (
      typeof operationId !== 'string' ||
      !HOSTED_UUID.test(operationId) ||
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

  const recoveryRequest = (
    req: Request,
  ):
    | { promptId: string; checkpointId: string; activationId: string }
    | undefined => {
    const body = object(req.body);
    const promptId = body?.['promptId'];
    const checkpointId = body?.['checkpointId'];
    const activationId = body?.['activationId'];
    if (
      typeof promptId !== 'string' ||
      !HOSTED_UUID.test(promptId) ||
      typeof checkpointId !== 'string' ||
      checkpointId.length === 0 ||
      checkpointId.length > 512 ||
      typeof activationId !== 'string' ||
      activationId.length === 0 ||
      activationId.length > 512
    ) {
      return undefined;
    }
    return { promptId, checkpointId, activationId };
  };

  // The coordinator replays a recovery call whose reply was lost; an already
  // settled Turn answers with the current watermark instead of driving twice.
  const settledReplay = (
    session: HostedSession,
    promptId: string,
    res: Response,
  ): boolean => {
    if (
      !hasAcceptedInput(session, promptId) ||
      unsettledInputs(session).has(promptId)
    ) {
      return false;
    }
    res.status(200).json({
      accepted: true,
      promptId,
      lastEventId: session.managed.authority.committedSequence,
      eventEpoch: epoch,
    });
    return true;
  };

  const matchesRecovery = (
    session: HostedSession,
    promptId: string,
    checkpointId: string,
    activationId: string,
  ): boolean =>
    session.managed.authority.latestCheckpoint?.checkpointId === checkpointId &&
    session.managed.activation.activationId === activationId &&
    unsettledPromptId(session) === promptId;

  // A takeover adoption owed on a Session closed before ever registering
  // can never be handed back by a route — every discharger resolves the
  // Session through this map. Record the stranded identity so it is neither
  // silent nor wedged by a release; the next successful load of the id
  // drains the record.
  const refusedAdoptions = new Map<string, string>();
  const noteOwedAdoption = (
    session: HostedSession,
    sessionId: string,
  ): void => {
    const runtimeSessionId = session.runtimeLeaseHeld;
    if (runtimeSessionId === undefined || refusedAdoptions.has(sessionId))
      return;
    refusedAdoptions.set(sessionId, runtimeSessionId);
    writeStderrLineSafe(
      `qwen serve: Hosted Harness takeover of session ${sessionId} adopted Runtime Session ${runtimeSessionId} but refuses the load: the lease stays owed until this session loads successfully or retires.`,
    );
  };

  // A recovery load may hold the Runtime Session. On the cancellation
  // path, terminal routes hand it back — or the workspace lease stays
  // pinned forever — but retry-inviting refusals must not (see the field
  // doc): a release persists RELEASED. The continuation route keeps its
  // #13083 handback discipline (recorded follow-up). The flag clears only
  // once the release is confirmed, so a failed handback stays owed and the
  // next terminal route retries it.
  const releaseRecoveredRuntime = (session: HostedSession): void => {
    const promptId = session.runtimeLeaseHeld;
    if (promptId === undefined || !brokerOptions) return;
    new HostedWorkspaceBroker(
      brokerOptions,
      session.managed.authority.sessionHeader.sessionKey,
      promptId,
    )
      .release()
      .then(
        () => {
          if (session.runtimeLeaseHeld === promptId)
            session.runtimeLeaseHeld = undefined;
        },
        (cause: unknown) => {
          writeStderrLineSafe(
            `qwen serve: Hosted Harness release of recovered Runtime ${promptId} failed: ${String(cause)}`,
          );
        },
      );
  };

  // Awaited variant for exits after which no route can retry the handback
  // (session close/detach). Retry-inviting refusals must not call it: see
  // the owed-lease comment at the blocked cancel refusal.
  const releaseLeaseNow = async (session: HostedSession): Promise<void> => {
    const promptId = session.runtimeLeaseHeld;
    if (promptId === undefined || !brokerOptions) return;
    await new HostedWorkspaceBroker(
      brokerOptions,
      session.managed.authority.sessionHeader.sessionKey,
      promptId,
    )
      .release()
      .then(() => {
        if (session.runtimeLeaseHeld === promptId)
          session.runtimeLeaseHeld = undefined;
      })
      .catch((cause: unknown) => {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness release of recovered Runtime ${promptId} failed: ${String(cause)}`,
        );
      });
  };

  app.post('/session/:id/managed-runtime/continue', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.hooks) return error(res, 409, 'hosted_hook_recovery_required');
    const request = recoveryRequest(req);
    if (!request) return error(res, 400, 'invalid_managed_runtime_recovery');
    const { promptId, checkpointId, activationId } = request;
    // A blocked Turn never writes a terminal record, so a replay must meet
    // the refusal rather than re-answer an admission that will never settle.
    if (session.blocked) {
      releaseRecoveredRuntime(session);
      return error(res, 409, 'hosted_turn_recovery_required');
    }
    // A continuation whose reply was lost is replayed by the coordinator: it
    // must get the watermark it was admitted at, running or settled, or the
    // coordinator would stream from after the Turn's own events.
    const recoveryDigest = `recovery:${checkpointId}:${activationId}`;
    const admittedRecovery = session.admissions.get(promptId);
    if (admittedRecovery?.digest === recoveryDigest) {
      if (!session.active) releaseRecoveredRuntime(session);
      res.status(200).json({
        accepted: true,
        promptId,
        lastEventId: admittedRecovery.lastEventId,
        eventEpoch: epoch,
      });
      return;
    }
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (!session.toolProfile || !brokerOptions) {
      releaseRecoveredRuntime(session);
      return error(res, 409, 'hosted_turn_recovery_required');
    }
    if (!matchesRecovery(session, promptId, checkpointId, activationId)) {
      if (settledReplay(session, promptId, res)) {
        releaseRecoveredRuntime(session);
        return;
      }
      releaseRecoveredRuntime(session);
      return error(res, 409, 'hosted_recovery_identity_mismatch');
    }
    // Prove the checkpoint is continuable before answering: a 200 admission
    // for a turn that cannot continue would settle it with a bare
    // turn.settled and wedge the Session for good.
    const continueAuthorization = await session.managed.authority
      .harnessRunAuthorization()
      .catch(() => undefined);
    if (identity(req, sessions) !== session)
      return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (
      continueAuthorization?.status !== 'runnable' ||
      continueAuthorization.checkpoint.continuation.phase !== 'results_ready'
    ) {
      releaseRecoveredRuntime(session);
      return error(res, 409, 'hosted_turn_recovery_required');
    }
    const abort = new AbortController();
    session.active = { promptId, digest: '', abort };
    session.admissions.set(promptId, {
      digest: recoveryDigest,
      lastEventId: session.managed.authority.committedSequence,
    });
    res.status(200).json({
      accepted: true,
      promptId,
      lastEventId: session.managed.authority.committedSequence,
      eventEpoch: epoch,
    });
    const sessionId = req.params['id'];
    void (async () => {
      let toolTurn: HostedWorkspaceToolTurn | undefined;
      const turnResultRecord = (state: 'cancelled' | 'error' | 'completed') =>
        record(session, sessionId, 'system', null, {
          subtype: 'turn_result',
          systemPayload: {
            promptId,
            state,
            stopReason: state === 'completed' ? 'end_turn' : state,
            endedAt: Date.now(),
          },
        });
      try {
        const harness = createManagedHarnessHandle(session.managed);
        const projected = await session.managed.sink.project();
        const settledPrompts = new Set(
          session.managed.authority
            .eventsInSequenceRange(
              1,
              session.managed.authority.committedSequence,
            )
            .filter((event) => event.kind === 'turn.settled')
            .map((event) => event.payload['turnId']),
        );
        const turnRecords = projected.filter(
          (entry) => entry.daemonPromptId === promptId,
        );
        // Split at the last assistant message carrying function calls: earlier
        // tool rounds stay in history, and only the parked round's results
        // become the resume request. Otherwise a turn that parked after two
        // tool rounds would resume with an unanswered call in between.
        let lastCallIndex = -1;
        for (const [index, entry] of turnRecords.entries()) {
          if (
            entry.type === 'assistant' &&
            entry.message?.parts?.some((part) => part.functionCall)
          ) {
            lastCallIndex = index;
          }
        }
        if (lastCallIndex < 0) {
          throw new Error('Recovered Runtime turn has no journaled tool call.');
        }
        const parkedRound = new Set(turnRecords.slice(lastCallIndex + 1));
        const history = projected.filter(
          (entry) =>
            settledPrompts.has(entry.daemonPromptId) ||
            (entry.daemonPromptId === promptId && !parkedRound.has(entry)),
        );
        const resumeParts = turnRecords
          .slice(lastCallIndex + 1)
          .filter((entry) => entry.type === 'tool_result')
          .flatMap((entry) => entry.message?.parts ?? []);
        if (resumeParts.length === 0) {
          throw new Error(
            'Recovered Runtime turn has no journaled tool results.',
          );
        }
        let parentUuid = projected.at(-1)?.uuid ?? null;
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
        const deltas = new HostedTextDeltaStream(session.managed, promptId);
        const commit = async (
          type: 'assistant' | 'tool_result',
          parts: Part[],
          model: string,
          identity?: { uuid: string; timestamp: string },
        ) => {
          const message = messageRecord(type, parts, model, identity);
          if (type === 'assistant') {
            const streamed = deltas.takeMessageId();
            if (streamed !== undefined) message.uuid = streamed;
          }
          await session.managed.sink.write(message);
          parentUuid = message.uuid;
          return message.uuid;
        };
        toolTurn = new HostedWorkspaceToolTurn(
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
          session.approval && {
            settings: session.approval,
            waiters: session.waiters,
          },
          session.mcp,
        );
        let state: 'completed' | 'cancelled' | 'error' = 'completed';
        try {
          // Reconcile the pending file-history obligation the recovered turn
          // left behind before inference — a text-only continuation never
          // re-acquires, so without this the marker outlives the turn and
          // wedges every later cold load.
          await toolTurn.resumeCommittedResults();
          const result = await runHostedHarnessTextTurn({
            sessionId,
            cwd,
            history,
            prompt: '',
            promptId,
            signal: abort.signal,
            toolTurn,
            resumeFromToolResults: resumeParts,
            textDeltas: deltas,
          });
          await commit(
            'assistant',
            result.parts ?? [{ text: result.text }],
            result.model,
          );
        } catch (cause) {
          if (cause instanceof HostedToolRecoveryRequiredError) throw cause;
          state = abort.signal.aborted ? 'cancelled' : 'error';
          if (state === 'error') {
            writeStderrLineSafe(
              `qwen serve: Hosted Harness turn ${promptId} failed: ${String(cause)}`,
            );
          }
        }
        await toolTurn.finish();
        await harness.settleConsumedRuntimeContinuation();
        await session.managed.sink.write(turnResultRecord(state));
      } catch (cause) {
        if (cause instanceof HostedToolRecoveryRequiredError) {
          session.blocked = true;
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} is recovery blocked: ${String(cause.cause)}`,
          );
          return;
        }
        try {
          await session.managed.sink.write(turnResultRecord('error'));
        } catch (settleCause) {
          session.blocked = true;
          writeStderrLineSafe(
            `qwen serve: Hosted Harness turn ${promptId} could not settle: ${String(settleCause)}`,
          );
        }
      } finally {
        // Clear availability before the unbounded publisher drain, per the
        // discipline in executeHostedTurn.
        releaseRecoveredRuntime(session);
        session.active = undefined;
        void toolTurn?.close().catch((cause: unknown) => {
          session.blocked = true;
          writeStderrLineSafe(
            `qwen serve: Hosted Shell publisher cleanup failed: ${String(cause)}`,
          );
        });
      }
    })();
  });

  app.post('/session/:id/managed-runtime/cancel', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.hooks) return error(res, 409, 'hosted_hook_recovery_required');
    const request = recoveryRequest(req);
    if (!request) return error(res, 400, 'invalid_managed_runtime_recovery');
    const { promptId, checkpointId, activationId } = request;
    if (session.blocked) {
      // A retry-inviting refusal: keep an adopted lease owed with the
      // still-READY identity — the next takeover re-acquires it
      // idempotently, while a release would persist RELEASED and wedge
      // every retry with runtime_session_not_acquirable.
      return error(res, 409, 'hosted_turn_recovery_required');
    }
    // A cancellation whose reply was lost is replayed by the coordinator: it
    // must get the watermark it was admitted at, running or settled — the
    // same contract the continue route documents.
    const recoveryDigest = `recovery:${checkpointId}:${activationId}`;
    const admittedCancel = session.admissions.get(promptId);
    if (admittedCancel?.digest === recoveryDigest) {
      if (!session.active) releaseRecoveredRuntime(session);
      res.status(200).json({
        accepted: true,
        promptId,
        lastEventId: admittedCancel.lastEventId,
        eventEpoch: epoch,
      });
      return;
    }
    if (session.active) return error(res, 409, 'hosted_turn_active');
    // A redriven cancellation carries its load-time identity, but the
    // checkpoint may legitimately have advanced underneath: an earlier
    // attempt settled the executions and then failed before the terminal
    // record. The coordinator never re-loads an attached Session, so the
    // fence is the activation plus the unsettled Turn — admit those against
    // the current checkpoint instead of refusing the only retry there is.
    const attachedToUnsettled =
      session.managed.activation.activationId === activationId &&
      unsettledPromptId(session) === promptId;
    if (!attachedToUnsettled) {
      if (settledReplay(session, promptId, res)) {
        releaseRecoveredRuntime(session);
        return;
      }
      // A foreign-epoch cancel against a stranger's or settled Turn is not a
      // teardown: keep the lease owed and re-acquirable — the same owed
      // discipline as the refusals above. Only a genuinely settled replay
      // hands it back.
      return error(res, 409, 'hosted_recovery_identity_mismatch');
    }
    const sessionId = req.params['id'];
    // Symmetric with the continue route: without the tool profile or the
    // Broker there is no way to prove the parked executions stopped.
    if (!session.toolProfile || !brokerOptions) {
      return error(res, 409, 'hosted_turn_recovery_required');
    }
    // A checkpoint whose authorization is no longer readable cannot prove
    // its parked executions; refuse like the load path instead of settling
    // a cancellation nothing verified.
    const cancelAuthorization = await session.managed.authority
      .harnessRunAuthorization()
      .catch(() => undefined);
    if (identity(req, sessions) !== session)
      return error(res, 404, 'hosted_session_not_found');
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (cancelAuthorization?.status !== 'runnable') {
      // Retry-inviting refusal: keep the adopted lease owed (see the
      // blocked refusal above).
      return error(res, 409, 'hosted_turn_recovery_required');
    }
    session.admissions.set(promptId, {
      digest: recoveryDigest,
      lastEventId: session.managed.authority.committedSequence,
    });
    session.active = { promptId, digest: '', abort: new AbortController() };
    void (async () => {
      try {
        const broker = await stopParkedRuntimeExecutions({
          session: session.managed,
          promptId,
          brokerOptions,
        });
        // Settle the parked executions as cancelled so the terminal record
        // can move the checkpoint past the durable wait instead of wedging
        // the session on its next prompt.
        await settleParkedTurnCancelled({
          session: session.managed,
          sessionId,
          cwd: session.cwd,
          promptId,
        });
        // The cancelled Turn never continues, so its pending file-history
        // obligation dies with it — keep the snapshots, drop the marker, or
        // every later load stays refused.
        const savedHistory = await readHostedFileHistory(session.managed);
        if (savedHistory?.pendingTurn === promptId) {
          await commitHostedFileHistory(session.managed, {
            schemaVersion: 1,
            state: savedHistory.state,
            pendingTurn: null,
            pendingUndo: null,
          });
        }
        await session.managed.sink.write(
          record(session, sessionId, 'system', null, {
            subtype: 'turn_result',
            systemPayload: {
              promptId,
              state: 'cancelled',
              stopReason: 'cancelled',
              endedAt: Date.now(),
            },
          }),
        );
        // The original owner's Runtime Session keeps the Workspace lease
        // pinned; the passive takeover adopted it on load. Release only
        // after the terminal record is durable: the release persists
        // RELEASED (a same-identity re-acquire then conflicts forever), so a
        // failure between release and settle would wedge the Turn without a
        // retry, while a stranded READY lease is re-acquired idempotently.
        // It must also stay after the stop loop: the Broker refuses with
        // runtime_session_busy while an execution is active.
        const handedBack = await broker.release().then(
          () => true,
          (cause: unknown) => {
            if (
              cause instanceof HostedWorkspaceBrokerRejection &&
              cause.status === 404
            )
              return true;
            // The Turn is already durable, so a handback failure must not
            // refuse an answered cancellation. Leave the lease owed; later
            // replays and the session close retry it.
            writeStderrLineSafe(
              `qwen serve: Hosted Harness could not hand back the recovered Runtime ${promptId} for session ${sessionId}: ${String(cause)}`,
            );
            return false;
          },
        );
        if (handedBack)
          // The release discharged the lease the load adopted, or it never
          // existed; the teardown skips what is now a redundant handback.
          session.runtimeLeaseHeld = undefined;
        // Answer at the admission watermark: the cancelled turn_result
        // streams in from there, and a replayed cancel replays it exactly.
        res.status(200).json({
          accepted: true,
          promptId,
          lastEventId: session.admissions.get(promptId)!.lastEventId,
          eventEpoch: epoch,
        });
      } catch (cause) {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness turn ${promptId} could not settle the cancellation: ${String(cause)}`,
        );
        // The cancellation never confirmed: drop the admission so the
        // coordinator's retry re-drives instead of replaying the watermark.
        session.admissions.delete(promptId);
        if (!res.headersSent) error(res, 503, 'managed_runtime_cancel_failed');
      } finally {
        // No handback here: the coordinator retries a failed cancel, and a
        // release would wedge that retry; the success path above already
        // released and discharged the flag itself.
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
        session.blocked ||
        (session.mcp?.recoveryBlocked ?? false) ||
        (session.hooks?.hasPendingOperations ?? false),
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
  app.get('/session/:id/files/history', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.toolProfile || session.toolProfile === HOSTED_MCP_PROFILE)
      return error(res, 409, 'hosted_file_history_unavailable');
    void readHostedFileHistory(session.managed).then(
      (history) =>
        res.json({ sessionId: req.params['id'], history: history ?? null }),
      (cause: unknown) => {
        writeStderrLineSafe(
          `qwen serve: Hosted file history read failed: ${String(cause)}`,
        );
        error(res, 503, 'hosted_file_history_failed');
      },
    );
  });
  app.post('/session/:id/files/rewind', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (
      !session.toolProfile ||
      session.toolProfile === HOSTED_MCP_PROFILE ||
      !brokerOptions
    )
      return error(res, 409, 'hosted_file_history_unavailable');
    if (session.mcpBusy || session.mcpClosing || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.active) return error(res, 409, 'hosted_turn_active');
    if (session.hooksBusy || session.hooks?.hasUnsettledExecutions)
      return error(res, 409, 'hosted_hook_operation_active');
    if (session.blocked)
      return error(res, 409, 'hosted_turn_recovery_required');
    if (
      session.hooks?.hasPendingOperations ||
      session.managed.authority.currentActivation?.phase !== 'active'
    )
      return error(res, 409, 'hosted_turn_recovery_required');
    const body = object(req.body);
    const requestId = body?.['requestId'];
    const promptId = body?.['promptId'];
    if (
      typeof requestId !== 'string' ||
      !HOSTED_UUID.test(requestId) ||
      typeof promptId !== 'string' ||
      !HOSTED_UUID.test(promptId)
    )
      return error(res, 400, 'invalid_file_rewind');
    session.active = {
      promptId: requestId,
      digest: '',
      abort: new AbortController(),
    };
    void (async () => {
      const saved = await readHostedFileHistory(session.managed);
      if (
        !saved ||
        !saved.state.snapshots.some(
          (snapshot) => snapshot.promptId === promptId,
        )
      )
        return error(res, 404, 'hosted_file_snapshot_not_found');
      if (saved.pendingTurn || saved.pendingUndo)
        return error(res, 409, 'hosted_file_history_recovery_required');
      const priorUndo = saved.undoReceipts?.find(
        (receipt) => receipt.requestId === requestId,
      );
      if (priorUndo) {
        if (priorUndo.promptId !== promptId)
          return error(res, 409, 'hosted_file_rewind_conflict');
        return res.status(priorUndo.conflict ? 409 : 200).json(priorUndo);
      }
      const pending = { ...saved, pendingUndo: { requestId, promptId } };
      try {
        await assertHostedFileHistoryCapacity(session.managed, pending);
      } catch (cause) {
        if (!(cause instanceof HostedFileHistoryRefusedError)) throw cause;
        return error(res, 409, 'hosted_file_history_capacity_exceeded');
      }
      const broker =
        session.hooks?.broker ??
        new HostedWorkspaceBroker(
          brokerOptions,
          session.managed.authority.sessionHeader.sessionKey,
          requestId,
        );
      try {
        await broker.warm();
        if (session.hooks) await session.hooks.acquire();
        else await broker.acquire();
      } catch (cause) {
        if (isRetryableWorkspaceAcquisition(cause))
          return error(res, 409, cause.code);
        if (
          cause instanceof HostedWorkspaceBrokerRejection &&
          cause.status === 409 &&
          cause.code === 'runtime_session_not_acquirable'
        )
          return error(res, 409, 'runtime_session_not_acquirable');
        throw cause;
      }
      try {
        await broker.fileHistory({
          kind: 'raw-file-history',
          action: 'bind',
          state: saved.state,
        });
      } catch (cause) {
        if (!isHostedFileHistoryRefusal(cause)) throw cause;
        if (!session.hooks) await broker.release();
        return error(res, 409, 'hosted_file_history_refused');
      }
      await commitHostedFileHistory(session.managed, pending);
      const result = await broker.fileHistory({
        kind: 'raw-file-history',
        action: 'rewind',
        promptId,
      });
      if (result.filesFailed.length)
        throw new Error('Hosted file undo only partially completed.');
      const undo = {
        requestId,
        promptId,
        filesChanged: result.filesChanged,
        conflict: result.conflict,
      };
      await commitHostedFileHistory(session.managed, {
        schemaVersion: 1,
        state: result.state,
        pendingTurn: null,
        pendingUndo: { requestId, promptId },
        undoReceipts: [...(saved.undoReceipts ?? []), undo],
      });
      if (!session.hooks) await broker.release();
      await commitHostedFileHistory(session.managed, {
        schemaVersion: 1,
        state: result.state,
        pendingTurn: null,
        pendingUndo: null,
        undoReceipts: [...(saved.undoReceipts ?? []), undo],
      });
      return res.status(result.conflict ? 409 : 200).json(undo);
    })()
      .catch((cause: unknown) => {
        session.blocked = true;
        writeStderrLineSafe(
          `qwen serve: Hosted file undo requires recovery: ${String(cause)}`,
        );
        error(res, 503, 'hosted_file_history_recovery_required');
      })
      .finally(() => {
        session.active = undefined;
      });
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
    if (
      session.active ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.hooksBusy
    )
      return error(res, 409, 'hosted_turn_active');
    session.mcpBusy = true;
    session.mcpClosing = true;
    try {
      if (req.method === 'DELETE' && session.hooks) {
        session.hooksBusy = true;
        try {
          await session.hooks.drain();
          await runHostedLifecycleHook(
            session,
            HookEventName.SessionEnd,
            `session-end:${req.params['id']}`,
            { reason: 'other' },
          );
          await runHostedLifecycleHook(
            session,
            HookEventName.SessionDelete,
            `session-delete:${req.params['id']}`,
            { deleted_session_id: req.params['id'] },
          );
        } finally {
          session.hooksBusy = false;
        }
      }
      await session.hooks?.close();
      // A lease a recovery load acquired must go back with the Session, or
      // the Workspace stays pinned after every later route is gone.
      await releaseLeaseNow(session);
      await session.mcp?.close();
      await session.managed.close();
      for (const stop of session.streams) stop();
      sessions.delete(req.params['id']);
      res.sendStatus(204);
    } catch (cause) {
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${req.params['id']} close failed: ${String(cause)}`,
      );
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
