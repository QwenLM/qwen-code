/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import type { Part } from '@google/genai';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { convertToFunctionErrorResponse } from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import {
  acceptedCsiToolInput,
  convertHostedCsiToolResult,
} from './hosted-csi-tool-evidence.js';
import type { ManagedToolResultPayload } from './managed-runtime-tool-executor.js';
import { parseManagedCsiFileJson } from './managed-csi-file-envelope.js';
import {
  commitHostedCsiHistory,
  requestHostedCsiHistory,
} from './hosted-csi-file-history.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';

const LIMIT = HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Original CSI recovery evidence is unavailable.');
  return value as Record<string, unknown>;
}

export async function requireClosedHostedCsiHistory(session: ManagedSession) {
  const latest = session.authority.domainRecord('file_history');
  if (!latest) throw new Error('Original CSI file history is unavailable.');
  const saved = object(
    parseManagedCsiFileJson(
      await session.resources.read(latest.recordRef),
      LIMIT,
    ),
  );
  if (saved['preparation'] !== null)
    throw new Error('Original CSI file history still requires recovery.');
}

export async function recoverHostedCsiReceipts(
  session: ManagedSession,
  broker: HostedWorkspaceBrokerOptions,
  promptId: string,
  text: string,
): Promise<Part[]> {
  const authority = session.authority;
  const events = authority.eventsInSequenceRange(
    1,
    authority.committedSequence,
  );
  const inputs = events.filter((event) => event.kind === 'input.accepted');
  if (inputs.length !== 1 || inputs[0].payload['inputId'] !== promptId)
    throw new Error('Original CSI prompt identity differs.');
  const inputRef = assertManagedSessionDurableRef(
    inputs[0].payload['contentRef'],
    'original CSI input',
  );
  if (
    inputRef.kind !== 'managed-input' ||
    !(await session.resources.read(inputRef)).equals(
      Buffer.from(JSON.stringify([{ type: 'text', text }])),
    )
  )
    throw new Error('Original CSI prompt bytes differ.');
  const authorization = await authority.harnessRunAuthorization();
  if (
    authorization.status !== 'runnable' ||
    !['await_runtime', 'results_ready'].includes(
      authorization.checkpoint.continuation.phase,
    ) ||
    authorization.checkpoint.identity.promptId !== promptId
  )
    throw new Error('Original CSI checkpoint is unavailable.');
  const items = [...(authorization.checkpoint.tools?.items ?? [])].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  if (items.length === 0)
    throw new Error('Original CSI receipt batch is unavailable.');
  const projected = await session.sink.project();
  const batchId = items[0].modelMessageId;
  const batchIndex = projected.findIndex((record) => record.uuid === batchId);
  const batch = projected[batchIndex];
  if (
    !batch ||
    batch.type !== 'assistant' ||
    batch.daemonPromptId !== promptId ||
    !Array.isArray(batch.message?.parts) ||
    typeof batch.model !== 'string' ||
    new Set(items.map((item) => item.executionCallId)).size !== items.length ||
    new Set(items.map((item) => item.functionCallId)).size !== items.length ||
    items.some(
      (item, index) =>
        item.modelMessageId !== batchId ||
        item.consumed ||
        !['in_progress', 'settled'].includes(item.state) ||
        (index > 0 && item.ordinal <= items[index - 1].ordinal),
    )
  )
    throw new Error('Original CSI assistant batch differs.');
  const functions = (batch.message.parts as Part[]).flatMap(
    (part, partIndex) =>
      part.functionCall ? [{ call: part.functionCall, partIndex }] : [],
  );
  for (const item of items) {
    const original = functions[item.ordinal];
    if (
      !original ||
      original.partIndex !== item.partIndex ||
      original.call.id !== item.functionCallId ||
      original.call.name !== item.toolName
    )
      throw new Error('Original CSI accepted function differs.');
  }
  const responses: Part[][] = functions.map(() => []);
  let parentUuid: string | null = batchId;
  let refusalCount = 0;
  for (const [ordinal, { call }] of functions.entries()) {
    if (items.some((item) => item.ordinal === ordinal)) continue;
    let reason = 'CSI file input is invalid.';
    let input: Record<string, unknown> | undefined;
    try {
      input = acceptedCsiToolInput({
        callId: call.id!,
        name: call.name!,
        args: call.args!,
        isClientInitiated: false,
        prompt_id: promptId,
      });
    } catch {
      // Refusals are persisted before any original execution is reserved.
    }
    if (input !== undefined) {
      const bytes = Buffer.from(
        JSON.stringify({
          harnessSessionId: authority.sessionHeader.sessionKey.sessionId,
          runtimeSessionId: authority.sessionHeader.sessionKey.sessionId,
          payloadJson: JSON.stringify({ toolName: call.name, input }),
        }),
      );
      if (bytes.length <= LIMIT)
        throw new Error('Original CSI accepted member is missing.');
      reason = 'CSI file input exceeds the durable Session limit.';
    }
    const parts = convertToFunctionErrorResponse(
      call.name!,
      call.id!,
      [],
      reason,
    );
    const existing = projected[batchIndex + 1 + refusalCount];
    if (
      !existing ||
      !isDeepStrictEqual(existing, {
        ...authority.recordEnvelope,
        sessionId: authority.sessionHeader.sessionKey.sessionId,
        uuid: existing.uuid,
        timestamp: existing.timestamp,
        parentUuid,
        type: 'tool_result',
        daemonPromptId: promptId,
        model: batch.model,
        message: { role: 'user', parts },
      })
    )
      throw new Error('Original CSI refusal message differs.');
    responses[ordinal] = parts;
    parentUuid = existing.uuid;
    refusalCount++;
  }
  const planned: Array<{
    item: (typeof items)[number];
    ref: ReturnType<typeof assertManagedSessionDurableRef>;
    record: ChatRecord;
    exists: boolean;
  }> = [];
  const ids = new Set(projected.map((record) => record.uuid));
  let existingCount = 0;
  for (const [index, item] of items.entries()) {
    const receipts = events.filter(
      (event) =>
        event.kind === 'tool.receipt' &&
        event.payload['executionCallId'] === item.executionCallId,
    );
    if (receipts.length !== 1)
      throw new Error('Original CSI receipt is unavailable.');
    const ref = assertManagedSessionDurableRef(
      receipts[0].payload['toolOutcomeRef'],
      'original CSI outcome',
    );
    if (ref.kind !== 'managed-tool-outcome')
      throw new Error('Original CSI outcome kind differs.');
    const outcome = object(
      parseManagedCsiFileJson(await session.resources.read(ref), LIMIT),
    );
    const history = object(outcome['history']);
    const envelope = object(outcome['envelope']);
    if (
      Object.keys(envelope).some(
        (key) => !['executionStatus', 'responseParts', 'error'].includes(key),
      ) ||
      !['success', 'error'].includes(String(envelope['executionStatus'])) ||
      !Array.isArray(envelope['responseParts'])
    )
      throw new Error('Original CSI complete result differs.');
    if (envelope['error'] !== undefined) {
      const error = object(envelope['error']);
      if (
        Object.keys(error).some((key) => !['message', 'type'].includes(key)) ||
        typeof error['message'] !== 'string' ||
        (error['type'] !== undefined && typeof error['type'] !== 'string')
      )
        throw new Error('Original CSI result error differs.');
    }
    const parts = convertHostedCsiToolResult(
      item.toolName,
      item.functionCallId,
      envelope as unknown as ManagedToolResultPayload,
    );
    if (
      !isDeepStrictEqual(Object.keys(outcome).sort(), [
        'envelope',
        'executionCallId',
        'history',
        'schemaVersion',
      ]) ||
      !isDeepStrictEqual(Object.keys(history).sort(), [
        'messageId',
        'model',
        'parts',
        'timestamp',
      ]) ||
      outcome['schemaVersion'] !== 1 ||
      outcome['executionCallId'] !== item.executionCallId ||
      typeof history['messageId'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        history['messageId'],
      ) ||
      typeof history['timestamp'] !== 'string' ||
      !Number.isFinite(Date.parse(history['timestamp'])) ||
      history['model'] !== batch.model ||
      !isDeepStrictEqual(history['parts'], parts) ||
      (item.state === 'settled' && !isDeepStrictEqual(item.outcomeRef, ref))
    )
      throw new Error('Original CSI outcome identity differs.');
    const record: ChatRecord = {
      ...authority.recordEnvelope,
      sessionId: authority.sessionHeader.sessionKey.sessionId,
      uuid: history['messageId'],
      timestamp: history['timestamp'],
      parentUuid,
      type: 'tool_result',
      daemonPromptId: promptId,
      model: batch.model,
      message: { role: 'user', parts },
    };
    const existing = projected.find(
      (candidate) => candidate.uuid === record.uuid,
    );
    if (existing) {
      if (
        existingCount !== index ||
        !isDeepStrictEqual(existing, record) ||
        projected[batchIndex + 1 + refusalCount + index]?.uuid !== record.uuid
      )
        throw new Error('Original CSI tool message differs.');
      existingCount++;
    } else if (ids.has(record.uuid)) {
      throw new Error('Original CSI history identity is reused.');
    }
    if (Buffer.byteLength(JSON.stringify(record)) > LIMIT)
      throw new Error('Complete CSI result exceeds the durable Session limit.');
    ids.add(record.uuid);
    planned.push({ item, ref, record, exists: existing !== undefined });
    responses[item.ordinal] = parts;
    parentUuid = record.uuid;
  }
  if (projected.length !== batchIndex + 1 + refusalCount + existingCount)
    throw new Error('Original CSI history tail differs.');
  const latest = authority.domainRecord('file_history');
  if (!latest) throw new Error('Original CSI file history is unavailable.');
  const saved = object(
    parseManagedCsiFileJson(
      await session.resources.read(latest.recordRef),
      LIMIT,
    ),
  );
  const harness = createManagedHarnessHandle(session);
  for (const plan of planned) {
    if (!plan.exists) await session.sink.write(plan.record);
    if (plan.item.state === 'in_progress')
      await harness.resolveAwaitRuntime(plan.item.executionCallId, plan.ref);
  }
  if (saved['preparation'] !== null) {
    const observation = await requestHostedCsiHistory(
      broker,
      authority.sessionHeader.sessionKey,
      { kind: 'csi-file-history', version: 1, action: 'snapshot' },
    );
    await commitHostedCsiHistory(
      session,
      observation,
      null,
      parentUuid,
      `csi-file-history:result:${batchId}`,
    );
  }
  await requireClosedHostedCsiHistory(session);
  return responses.flat();
}
