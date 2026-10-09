/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Part } from '@google/genai';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { convertManagedRuntimeToolResult } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-tool-response.js';
import { publishHostedCsiReceipt } from './hosted-csi-tool-evidence.js';
import {
  readCsiRecoveryResult,
  readHostedCsiRecoveryBatch,
  type CsiRecoveryOwner,
} from './hosted-csi-recovery-batch.js';
import { parseManagedCsiFileJson } from './managed-csi-file-envelope.js';
import {
  commitHostedCsiHistory,
  requestHostedCsiHistory,
} from './hosted-csi-file-history.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';

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
      64 * 1024,
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
  owner?: CsiRecoveryOwner,
): Promise<{ parts: Part[]; finalOutput?: ChatRecord }> {
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
  const originalParts = batch.message.parts as Part[];
  const functions = originalParts.flatMap((part, partIndex) =>
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
  const receiptEvents = items.map((item) =>
    events.filter(
      (event) =>
        event.kind === 'tool.receipt' &&
        event.payload['executionCallId'] === item.executionCallId,
    ),
  );
  if (receiptEvents.some((receipts) => receipts.length > 1))
    throw new Error('Original CSI receipt is ambiguous.');
  const missing = receiptEvents.some((receipts) => receipts.length === 0);
  if (missing && !owner)
    throw new Error('Original CSI installed recovery owner is required.');
  const recovered = missing
    ? await readHostedCsiRecoveryBatch(
        session,
        broker,
        promptId,
        items,
        originalParts,
        owner!,
      )
    : undefined;
  const planned: Array<{
    item: (typeof items)[number];
    ref: ReturnType<typeof assertManagedSessionDurableRef> | null;
    outcome: Buffer;
    record: ChatRecord;
    exists: boolean;
    parts: Part[];
  }> = [];
  let parentUuid: string | null = batchId;
  let existingCount = 0;
  const ids = new Set(projected.map((record) => record.uuid));
  for (const [index, item] of items.entries()) {
    const receipts = receiptEvents[index];
    const ref =
      receipts.length === 1
        ? assertManagedSessionDurableRef(
            receipts[0].payload['toolOutcomeRef'],
            'original CSI outcome',
          )
        : null;
    if (ref && ref.kind !== 'managed-tool-outcome')
      throw new Error('Original CSI outcome kind differs.');
    const savedBytes = ref ? await session.resources.read(ref) : null;
    const outcome = savedBytes
      ? object(parseManagedCsiFileJson(savedBytes, 64 * 1024))
      : {
          schemaVersion: 1,
          executionCallId: item.executionCallId,
          envelope: recovered!.get(item.executionCallId),
          history: {
            messageId: randomUUID(),
            timestamp: new Date().toISOString(),
            model: batch.model,
            parts: convertManagedRuntimeToolResult(
              item.toolName,
              item.functionCallId,
              recovered!.get(item.executionCallId)!,
              undefined,
            ),
          },
        };
    const history = object(outcome['history']);
    const result = readCsiRecoveryResult(outcome['envelope']);
    const parts = convertManagedRuntimeToolResult(
      item.toolName,
      item.functionCallId,
      result,
      undefined,
    );
    if (
      !isDeepStrictEqual(
        Object.keys(outcome).sort(),
        ['schemaVersion', 'executionCallId', 'envelope', 'history'].sort(),
      ) ||
      !isDeepStrictEqual(
        Object.keys(history).sort(),
        ['messageId', 'timestamp', 'model', 'parts'].sort(),
      ) ||
      outcome['schemaVersion'] !== 1 ||
      outcome['executionCallId'] !== item.executionCallId ||
      typeof history['messageId'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        history['messageId'],
      ) ||
      typeof history['timestamp'] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        history['timestamp'],
      ) ||
      !Number.isFinite(Date.parse(history['timestamp'])) ||
      history['model'] !== batch.model ||
      !isDeepStrictEqual(history['parts'], parts) ||
      (recovered &&
        !isDeepStrictEqual(result, recovered.get(item.executionCallId)))
    )
      throw new Error('Original CSI outcome identity differs.');
    if (
      item.state === 'settled' &&
      (!ref || !isDeepStrictEqual(item.outcomeRef, ref))
    )
      throw new Error('Original CSI tool checkpoint differs.');
    const record: ChatRecord = {
      ...authority.recordEnvelope,
      sessionId: authority.sessionHeader.sessionKey.sessionId,
      uuid: history['messageId'],
      timestamp: history['timestamp'],
      parentUuid,
      type: 'tool_result',
      daemonPromptId: promptId,
      model: history['model'],
      message: { role: 'user', parts },
    };
    const existing = projected.find(
      (candidate) => candidate.uuid === record.uuid,
    );
    if (existing) {
      if (
        existingCount !== index ||
        !isDeepStrictEqual(existing, record) ||
        projected[batchIndex + 1 + index]?.uuid !== record.uuid
      )
        throw new Error('Original CSI tool message differs.');
      existingCount++;
    } else if (ids.has(record.uuid)) {
      throw new Error('Original CSI history identity is reused.');
    }
    ids.add(record.uuid);
    const outcomeBytes = savedBytes ?? Buffer.from(JSON.stringify(outcome));
    if (
      outcomeBytes.length > 64 * 1024 ||
      Buffer.byteLength(JSON.stringify(record)) > 64 * 1024
    )
      throw new Error('Complete CSI result exceeds the durable Session limit.');
    planned.push({
      item,
      ref,
      outcome: outcomeBytes,
      record,
      exists: existing !== undefined,
      parts,
    });
    parentUuid = record.uuid;
  }
  const tail = projected.slice(batchIndex + 1 + existingCount);
  let finalOutput: ChatRecord | undefined;
  if (tail.length !== 0) {
    const candidate = tail[0];
    const attempt = events
      .filter((event) => event.kind === 'model.attempt')
      .at(-1);
    const message = events
      .filter((event) => event.kind === 'message.committed')
      .at(-1);
    const routeRef =
      attempt &&
      assertManagedSessionDurableRef(
        attempt.payload['routeRef'],
        'final CSI route',
      );
    const route =
      routeRef &&
      object(
        parseManagedCsiFileJson(
          await session.resources.read(routeRef),
          64 * 1024,
        ),
      );
    if (
      tail.length !== 1 ||
      missing ||
      existingCount !== items.length ||
      items.some((item) => item.state !== 'settled') ||
      authorization.checkpoint.continuation.phase !== 'results_ready' ||
      !attempt ||
      attempt.payload['state'] !== 'output_committed' ||
      !message ||
      message.sequence !== attempt.sequence + 1 ||
      message.payload['modelAttemptId'] !== attempt.payload['attemptId'] ||
      message.payload['messageId'] !== candidate.uuid ||
      !isDeepStrictEqual(message.subject, attempt.subject) ||
      !isDeepStrictEqual(
        attempt.payload['inputCheckpointRef'],
        authority.latestCheckpoint?.stateRef,
      ) ||
      routeRef?.kind !== 'managed-hosted-model-route' ||
      route?.['version'] !== 1 ||
      route['turnId'] !== promptId ||
      route['model'] !== candidate.model ||
      candidate.type !== 'assistant' ||
      candidate.daemonPromptId !== promptId ||
      candidate.parentUuid !== parentUuid ||
      candidate.message?.role !== 'model' ||
      !candidate.message.parts?.length ||
      candidate.message.parts.some((part) => part.functionCall)
    )
      throw new Error('Original CSI final output differs.');
    finalOutput = candidate;
  }
  const latest = authority.domainRecord('file_history');
  if (!latest) throw new Error('Original CSI file history is unavailable.');
  const saved = object(
    parseManagedCsiFileJson(
      await session.resources.read(latest.recordRef),
      64 * 1024,
    ),
  );
  if (finalOutput && saved['preparation'] !== null)
    throw new Error('Original CSI final output history is not closed.');
  // No durable repair happens before the complete original batch passes preflight.
  const harness = createManagedHarnessHandle(session);
  const responses: Part[] = [];
  for (const plan of planned) {
    const ref =
      plan.ref ??
      (await publishHostedCsiReceipt(
        session,
        plan.item.executionCallId,
        plan.outcome,
      ));
    if (!plan.exists) await session.sink.write(plan.record);
    if (plan.item.state === 'in_progress')
      await harness.resolveAwaitRuntime(plan.item.executionCallId, ref);
    responses.push(...plan.parts);
  }
  if (saved['preparation'] !== null) {
    const observation = await requestHostedCsiHistory(
      broker,
      authority.sessionHeader.sessionKey,
      {
        kind: 'csi-file-history',
        version: 1,
        action: 'snapshot',
      },
    );
    await commitHostedCsiHistory(
      session,
      observation,
      null,
      parentUuid,
      `csi-file-history:result:${items[0].modelMessageId}`,
    );
  }
  await requireClosedHostedCsiHistory(session);
  return { parts: responses, ...(finalOutput ? { finalOutput } : {}) };
}
