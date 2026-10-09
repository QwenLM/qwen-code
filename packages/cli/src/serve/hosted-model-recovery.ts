/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LlmPreparedRequest } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { parseHostedRecoveryResource } from '@qwen-code/qwen-code-core/managed-runtime/hosted-recovery-records.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export interface HostedModelRequest {
  v: 1;
  sessionKey: ManagedSession['authority']['sessionHeader']['sessionKey'];
  promptId: string;
  definitionRef: ManagedSessionDurableRef;
  rootSnapshotRef: ManagedSessionDurableRef;
  sourceActivation: ManagedSession['activation'];
  sourceBootId: string;
  sourceEventEpoch: string;
  messageId: string;
  round: number;
  throughSequence: number;
  pendingToolResults: boolean;
  workspaceContext: string | null;
  prepared: LlmPreparedRequest;
  requestDigest: string;
}

export function createHostedModelRequest(
  session: ManagedSession,
  promptId: string,
  prepared: LlmPreparedRequest,
  round: number,
  pendingToolResults: boolean,
  workspaceContext: string | undefined,
  owner: { bootId: string; eventEpoch: string },
): HostedModelRequest {
  const header = session.authority.sessionHeader;
  return {
    v: 1,
    sessionKey: header.sessionKey,
    promptId,
    definitionRef: header.definitionRef,
    rootSnapshotRef: header.rootSnapshotRef,
    sourceActivation: session.activation,
    sourceBootId: owner.bootId,
    sourceEventEpoch: owner.eventEpoch,
    messageId: randomUUID(),
    round,
    throughSequence: session.authority.committedSequence,
    pendingToolResults,
    workspaceContext: workspaceContext ?? null,
    prepared,
    requestDigest: createHash('sha256')
      .update(JSON.stringify(prepared))
      .digest('hex'),
  };
}

export async function publishHostedModelRequest(
  session: ManagedSession,
  request: HostedModelRequest,
): Promise<ManagedSessionDurableRef | undefined> {
  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > 64 * 1024) return undefined;
  return session.resources.publish('hosted-model-request', bytes);
}

async function readHostedModelRequest(
  session: ManagedSession,
  promptId: string,
  allowCommittedOutput: boolean,
): Promise<HostedModelRequest | undefined> {
  const events = session.authority.eventsInSequenceRange(
    1,
    session.authority.committedSequence,
  );
  const attempt = [...events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'model.attempt' &&
        typeof event.payload['attemptId'] === 'string' &&
        event.payload['attemptId'].startsWith(`${promptId}:main:`),
    );
  if (!attempt || !attempt.payload['recoveryRef']) return undefined;
  const ref = assertManagedSessionDurableRef(
    attempt.payload['recoveryRef'],
    'model recovery request',
  );
  if (ref.kind !== 'hosted-model-request' || ref.schemaVersion !== 1)
    throw new Error('Invalid model request reference.');
  const raw = parseHostedRecoveryResource(
    await session.resources.read(ref),
    session.authority.sessionHeader.sessionKey,
  );
  if (raw['promptId'] !== promptId) return undefined;
  const saved = raw as unknown as HostedModelRequest;
  if (
    Object.keys(raw).length !== 15 ||
    !isDeepStrictEqual(
      saved.definitionRef,
      session.authority.sessionHeader.definitionRef,
    ) ||
    !isDeepStrictEqual(
      saved.rootSnapshotRef,
      session.authority.sessionHeader.rootSnapshotRef,
    ) ||
    !Number.isSafeInteger(saved.round) ||
    saved.round < 0 ||
    saved.round >= 16 ||
    !Number.isSafeInteger(saved.throughSequence) ||
    saved.throughSequence < 1 ||
    saved.throughSequence >= attempt.sequence ||
    typeof saved.pendingToolResults !== 'boolean' ||
    !(
      saved.workspaceContext === null ||
      typeof saved.workspaceContext === 'string'
    ) ||
    !saved.sourceActivation ||
    Object.keys(saved.sourceActivation).length !== 2 ||
    !Number.isSafeInteger(saved.sourceActivation.epoch) ||
    saved.sourceActivation.epoch < 1 ||
    !saved.prepared ||
    Object.keys(saved.prepared).length !== 6 ||
    !Array.isArray(saved.prepared.history) ||
    !Array.isArray(saved.prepared.completedToolCallIds) ||
    !Array.isArray(saved.prepared.request?.contents) ||
    Object.keys(saved.prepared.request).length !== 3 ||
    !saved.prepared.request.config ||
    typeof saved.prepared.request.config !== 'object' ||
    Array.isArray(saved.prepared.request.config) ||
    ['abortSignal', 'httpOptions', 'apiKey', 'headers', 'authorization'].some(
      (field) => Object.hasOwn(saved.prepared.request.config, field),
    ) ||
    typeof saved.prepared.request.model !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(saved.prepared.providerPin) ||
    !Number.isSafeInteger(saved.prepared.promptTokensForClamp) ||
    saved.prepared.promptTokensForClamp < 0 ||
    saved.requestDigest !==
      createHash('sha256').update(JSON.stringify(saved.prepared)).digest('hex')
  )
    throw new Error('Invalid saved model request.');
  for (const id of [
    saved.messageId,
    saved.sourceBootId,
    saved.sourceEventEpoch,
    saved.sourceActivation.activationId,
    saved.prepared.routeSelector,
  ])
    assertManagedSessionStableId(id, 'saved model identity');
  if (
    !/^[^:]+:.+$/u.test(saved.prepared.routeSelector) ||
    new Set(saved.prepared.completedToolCallIds).size !==
      saved.prepared.completedToolCallIds.length
  )
    throw new Error('Invalid saved model route or completed calls.');
  for (const id of saved.prepared.completedToolCallIds)
    assertManagedSessionStableId(id, 'completed call');
  for (const content of [
    ...saved.prepared.history,
    ...saved.prepared.request.contents,
  ])
    if (
      !content ||
      !['user', 'model'].includes(content.role ?? '') ||
      !Array.isArray(content.parts) ||
      content.parts.some(
        (part) => !part || typeof part !== 'object' || Array.isArray(part),
      )
    )
      throw new Error('Invalid saved model content.');
  const started = events.find(
    (event) =>
      event.kind === 'model.attempt' &&
      event.payload['attemptId'] === attempt.payload['attemptId'] &&
      event.payload['state'] === 'started',
  );
  if (
    started?.subject?.type !== 'activation' ||
    started.subject.activationId !== saved.sourceActivation.activationId ||
    started.subject.epoch !== saved.sourceActivation.epoch
  )
    throw new Error('Saved model source differs from original attempt.');
  // Any committed output after this request belongs to a different recovery path.
  if (
    !allowCommittedOutput &&
    events.some(
      (event) =>
        event.sequence > saved.throughSequence &&
        ((event.kind === 'message.committed' &&
          event.payload['role'] === 'assistant') ||
          event.kind === 'tool.intent'),
    )
  )
    return undefined;
  const verdict = await session.authority.harnessRunAuthorization();
  if (
    verdict.status !== 'runnable' ||
    verdict.checkpoint.approval ||
    !(verdict.checkpoint.tools?.items ?? []).every(
      (item) => item.state === 'settled',
    ) ||
    ![
      'before_model',
      'model_output_committed',
      'results_ready',
      'turn_settled',
    ].includes(verdict.checkpoint.continuation.phase)
  )
    return undefined;
  return saved;
}

export async function findHostedModelRequest(
  session: ManagedSession,
  promptId: string,
): Promise<HostedModelRequest | undefined> {
  return readHostedModelRequest(session, promptId, false);
}

export async function findHostedCommittedModelOutput(
  session: ManagedSession,
  promptId: string,
): Promise<{ promptId: string } | undefined> {
  const events = session.authority.eventsInSequenceRange(
    1,
    session.authority.committedSequence,
  );
  const latestAttempt = events.findLast(
    (event) =>
      event.kind === 'model.attempt' &&
      typeof event.payload['attemptId'] === 'string' &&
      event.payload['attemptId'].startsWith(`${promptId}:main:`),
  );
  if (latestAttempt?.payload['state'] !== 'output_committed') return;
  const saved = latestAttempt.payload['recoveryRef']
    ? await readHostedModelRequest(session, promptId, true)
    : undefined;
  if (latestAttempt.payload['recoveryRef'] && !saved) return;
  const current = (await session.sink.project()).filter(
    (item) => item.daemonPromptId === promptId,
  );
  const last = current.at(-1);
  if (
    last?.type !== 'assistant' ||
    (saved && last.uuid !== saved.messageId) ||
    !last.message?.parts?.length ||
    last.message.parts.some((part) => part.functionCall)
  )
    return;
  const committed = events.findLast(
    (event) =>
      event.kind === 'message.committed' &&
      event.payload['messageId'] === last.uuid,
  );
  if (!committed || committed.sequence <= latestAttempt.sequence) return;
  const verdict = await session.authority.harnessRunAuthorization();
  if (
    verdict.status !== 'runnable' ||
    verdict.checkpoint.approval ||
    ![
      'before_model',
      'model_output_committed',
      'results_ready',
      'turn_settled',
    ].includes(verdict.checkpoint.continuation.phase) ||
    (verdict.checkpoint.tools?.items ?? []).some((item) => !item.consumed)
  )
    return;
  return saved ?? { promptId };
}
