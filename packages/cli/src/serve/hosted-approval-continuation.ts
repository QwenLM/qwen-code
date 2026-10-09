/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Part } from '@google/genai';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { parseHostedRecoveryResource } from '@qwen-code/qwen-code-core/managed-runtime/hosted-recovery-records.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  type ManagedSessionDurableRef,
  type ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  hostedActionAllowed,
  hostedActionDenied,
  readHostedActionOptions,
} from './hosted-tool-approval.js';

const NATIVE_TOOLS = new Set(['read_file', 'write_file', 'edit', 'glob']);

export interface HostedNativePlannedCall {
  readonly call: ToolCallRequestInfo;
  readonly runtimeCallId: string;
  readonly inputRef: ManagedSessionDurableRef;
  readonly definitionRef: ManagedSessionDurableRef;
  readonly requestDigest: string;
  readonly argsDigest: string;
  readonly prepareKey: string;
  readonly prepareReference: {
    readonly sessionId: string;
    readonly promptId: string;
    readonly callId: string;
    readonly argsDigest: string;
  };
  readonly partIndex: number;
  readonly refusal: string | null;
  readonly actionId: string | null;
}

export interface HostedApprovalContinuation {
  readonly v: 1;
  readonly sessionKey: ManagedSessionKey;
  readonly promptId: string;
  readonly definitionRef: ManagedSessionDurableRef;
  readonly rootSnapshotRef: ManagedSessionDurableRef;
  readonly sourceActivation: {
    readonly activationId: string;
    readonly epoch: number;
  };
  readonly runtime: {
    readonly runtimeSessionId: string;
    readonly bindingId: string;
    readonly generation: string;
    readonly workspaceGeneration: string;
  };
  readonly batchId: string;
  readonly assistantRef: ManagedSessionDurableRef;
  readonly model: string;
  readonly round: number;
  readonly stage: 'approval' | 'final';
  readonly approvalOrdinal: number;
  readonly actionId: string | null;
  readonly calls: readonly HostedNativePlannedCall[];
}

export interface RestoredHostedApprovalContinuation {
  readonly plan: HostedApprovalContinuation;
  readonly parts: Part[];
  readonly inputs: ReadonlyArray<{
    readonly bytes: Buffer;
    readonly payloadJson: string;
    readonly input: Record<string, unknown>;
  }>;
}

export async function readHostedApprovalContinuation(
  session: ManagedSession,
  ref: ManagedSessionDurableRef,
  promptId: string,
): Promise<RestoredHostedApprovalContinuation> {
  if (ref.kind !== 'hosted-approval-continuation' || ref.schemaVersion !== 1)
    throw new Error('Unsupported Hosted approval continuation.');
  const raw = parseHostedRecoveryResource(
    await session.resources.read(ref),
    session.authority.sessionHeader.sessionKey,
  );
  const plan = raw as unknown as HostedApprovalContinuation;
  const header = session.authority.sessionHeader;
  if (
    Object.keys(raw).length !== 15 ||
    plan.promptId !== promptId ||
    !['approval', 'final'].includes(plan.stage) ||
    !isDeepStrictEqual(plan.definitionRef, header.definitionRef) ||
    !isDeepStrictEqual(plan.rootSnapshotRef, header.rootSnapshotRef) ||
    !Number.isSafeInteger(plan.round) ||
    plan.round < 0 ||
    plan.round >= 16 ||
    !Array.isArray(plan.calls) ||
    plan.calls.length < 1 ||
    !Number.isSafeInteger(plan.approvalOrdinal) ||
    plan.approvalOrdinal < 0 ||
    plan.approvalOrdinal >= plan.calls.length ||
    !plan.runtime ||
    Object.keys(plan.runtime).length !== 4 ||
    plan.runtime.runtimeSessionId !== promptId ||
    !/^[1-9][0-9]{0,18}$/u.test(plan.runtime.generation) ||
    !/^[1-9][0-9]{0,18}$/u.test(plan.runtime.workspaceGeneration) ||
    BigInt(plan.runtime.generation) > 2n ** 63n - 1n ||
    BigInt(plan.runtime.workspaceGeneration) > 2n ** 63n - 1n ||
    !plan.sourceActivation ||
    Object.keys(plan.sourceActivation).length !== 2 ||
    !Number.isSafeInteger(plan.sourceActivation.epoch) ||
    plan.sourceActivation.epoch < 1
  )
    throw new Error(
      'Hosted approval continuation conflicts with the original Turn.',
    );
  for (const id of [
    plan.batchId,
    plan.runtime.bindingId,
    plan.sourceActivation.activationId,
    plan.model,
  ])
    assertManagedSessionStableId(id, 'Hosted continuation identity');
  const assistant = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .find(
      (event) =>
        event.kind === 'message.committed' &&
        event.payload['messageId'] === plan.batchId &&
        event.payload['role'] === 'assistant',
    );
  if (
    !assistant ||
    !isDeepStrictEqual(assistant.payload['contentRef'], plan.assistantRef)
  )
    throw new Error('Original assistant batch is missing.');
  const record = JSON.parse(
    (await session.resources.read(plan.assistantRef)).toString('utf8'),
  ) as { daemonPromptId?: string; message?: { parts?: Part[] } };
  const parts = record.message?.parts;
  if (
    record.daemonPromptId !== promptId ||
    !Array.isArray(parts) ||
    parts.filter((part) => part.functionCall).length !== plan.calls.length
  )
    throw new Error(
      'Original assistant batch does not match the continuation.',
    );
  const ids = new Set<string>();
  const runtimeIds = new Set<string>();
  const partIndexes = new Set<number>();
  const inputs = [];
  for (const [ordinal, item] of plan.calls.entries()) {
    if (
      Object.keys(item).length !== 11 ||
      !item.call ||
      !NATIVE_TOOLS.has(item.call.name) ||
      item.call.prompt_id !== promptId ||
      item.call.wasOutputTruncated ||
      item.call.hadIncompleteArguments ||
      ids.has(item.call.callId) ||
      runtimeIds.has(item.runtimeCallId) ||
      partIndexes.has(item.partIndex) ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.argsDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.requestDigest) ||
      !Number.isSafeInteger(item.partIndex) ||
      item.partIndex < 0 ||
      parts[item.partIndex]?.functionCall?.id !== item.call.callId ||
      parts[item.partIndex]?.functionCall?.name !== item.call.name ||
      item.prepareKey !== `${promptId}:${item.runtimeCallId}` ||
      item.prepareReference?.sessionId !== promptId ||
      item.prepareReference.promptId !== promptId ||
      item.prepareReference.callId !== item.runtimeCallId ||
      item.prepareReference.argsDigest !== item.requestDigest ||
      (item.refusal !== null && typeof item.refusal !== 'string') ||
      (item.actionId !== null && typeof item.actionId !== 'string')
    )
      throw new Error('Invalid Hosted native batch member.');
    ids.add(item.call.callId);
    runtimeIds.add(item.runtimeCallId);
    partIndexes.add(item.partIndex);
    assertManagedSessionStableId(item.call.callId, 'model call ID');
    assertManagedSessionStableId(item.runtimeCallId, 'Runtime call ID');
    for (const [resource, kind] of [
      [item.inputRef, 'managed-tool-input'],
      [item.definitionRef, 'managed-tool-definition'],
    ] as const) {
      const checked = assertManagedSessionDurableRef(
        resource,
        'Hosted batch resource',
      );
      if (checked.kind !== kind || checked.schemaVersion !== 1)
        throw new Error('Invalid Hosted batch resource kind.');
    }
    const bytes = await session.resources.read(item.inputRef);
    const saved = JSON.parse(bytes.toString('utf8')) as {
      harnessSessionId?: string;
      runtimeSessionId?: string;
      payloadJson?: string;
    };
    if (
      saved.harnessSessionId !== header.sessionKey.sessionId ||
      saved.runtimeSessionId !== promptId ||
      typeof saved.payloadJson !== 'string' ||
      item.requestDigest !==
        `sha256:${createHash('sha256').update(saved.payloadJson).digest('hex')}`
    )
      throw new Error('Saved native request digest conflicts.');
    const payload = JSON.parse(saved.payloadJson) as {
      toolName?: string;
      input?: Record<string, unknown>;
    };
    if (
      payload.toolName !== item.call.name ||
      !payload.input ||
      typeof payload.input !== 'object' ||
      Array.isArray(payload.input) ||
      item.argsDigest !== `sha256:${managedToolDigest(payload.input)}`
    )
      throw new Error('Saved native request is invalid.');
    const definition = JSON.parse(
      (await session.resources.read(item.definitionRef)).toString('utf8'),
    ) as { name?: string };
    if (definition.name !== item.call.name)
      throw new Error('Saved tool definition conflicts.');
    if (item.actionId) {
      const action = session.authority.action(item.actionId);
      if (!action) throw new Error('Original approval is missing.');
      const options = await readHostedActionOptions(session, action);
      if (
        options.v !== 3 ||
        options.functionCallId !== item.call.callId ||
        options.turnId !== promptId ||
        options.toolName !== item.call.name ||
        (options.inputRef &&
          !isDeepStrictEqual(options.inputRef, item.inputRef)) ||
        (action.state === 'decided' &&
          !hostedActionAllowed(action, options.policyRevision) &&
          !hostedActionDenied(action, options.policyRevision)) ||
        (plan.stage === 'approval' &&
          ordinal < plan.approvalOrdinal &&
          action.state !== 'decided') ||
        (plan.stage === 'final' && action.state === 'requested') ||
        (plan.stage === 'final' &&
          ['expired', 'cancelled'].includes(action.state) &&
          item.refusal === null) ||
        (action.state === 'decided' &&
          hostedActionDenied(action, options.policyRevision) &&
          item.refusal === null &&
          (plan.stage === 'final' || ordinal !== plan.approvalOrdinal))
      )
        throw new Error('Original approval verdict conflicts.');
    }
    inputs.push({
      bytes,
      payloadJson: saved.payloadJson,
      input: payload.input,
    });
  }
  if (
    plan.stage === 'approval' &&
    (!plan.actionId ||
      plan.calls[plan.approvalOrdinal].actionId !== plan.actionId)
  )
    throw new Error('Original approval ordinal conflicts.');
  return { plan, parts, inputs };
}

export async function findHostedApprovalContinuation(
  session: ManagedSession,
  promptId: string,
): Promise<RestoredHostedApprovalContinuation | undefined> {
  const authorization = await session.authority.harnessRunAuthorization();
  if (
    authorization.status !== 'runnable' ||
    !['before_model', 'await_action', 'model_output_committed'].includes(
      authorization.checkpoint.continuation.phase,
    )
  )
    return undefined;
  const events = session.authority.eventsInSequenceRange(
    1,
    session.authority.committedSequence,
  );
  const projected = await session.sink.project();
  const latestAssistant = projected.findLast(
    (item) => item.type === 'assistant' && item.daemonPromptId === promptId,
  );
  if (!latestAssistant?.message?.parts?.some((part) => part.functionCall))
    return undefined;
  const callIds = latestAssistant.message.parts.flatMap((part) =>
    part.functionCall?.id ? [part.functionCall.id] : [],
  );
  const answered = new Set(
    projected
      .filter(
        (item) =>
          item.type === 'tool_result' && item.daemonPromptId === promptId,
      )
      .flatMap(
        (item) =>
          item.message?.parts?.flatMap((part) =>
            part.functionResponse?.id ? [part.functionResponse.id] : [],
          ) ?? [],
      ),
  );
  if (callIds.every((id) => answered.has(id))) return undefined;
  const batch = [...events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'hosted.batch.planned' &&
        event.payload['batchId'] === latestAssistant.uuid,
    );
  if (batch)
    return readHostedApprovalContinuation(
      session,
      batch.payload['planRef'] as unknown as ManagedSessionDurableRef,
      promptId,
    );
  for (const event of [...events].reverse()) {
    if (
      event.kind !== 'action.changed' ||
      event.payload['source'] !== 'tool_call'
    )
      continue;
    const action = session.authority.action(
      event.payload['requestId'] as string,
    );
    if (!action) continue;
    const options = await readHostedActionOptions(session, action);
    if (
      options.turnId !== promptId ||
      options.v !== 3 ||
      !callIds.includes(options.functionCallId)
    )
      continue;
    return readHostedApprovalContinuation(
      session,
      options.continuationRef,
      promptId,
    );
  }
  return undefined;
}
