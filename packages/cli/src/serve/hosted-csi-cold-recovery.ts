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
  const harness = createManagedHarnessHandle(session);
  const projected = await session.sink.project();
  let parentUuid = projected.at(-1)?.uuid ?? null;
  const responses: Part[] = [];
  for (const item of items) {
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
      parseManagedCsiFileJson(await session.resources.read(ref), 64 * 1024),
    );
    const history = object(outcome['history']);
    if (
      outcome['executionCallId'] !== item.executionCallId ||
      typeof history['messageId'] !== 'string' ||
      typeof history['timestamp'] !== 'string' ||
      typeof history['model'] !== 'string' ||
      !Array.isArray(history['parts'])
    )
      throw new Error('Original CSI outcome identity differs.');
    const parts = history['parts'] as Part[];
    const existing = projected.find(
      (record) => record.uuid === history['messageId'],
    );
    if (existing) {
      if (
        !isDeepStrictEqual(existing, {
          ...authority.recordEnvelope,
          sessionId: authority.sessionHeader.sessionKey.sessionId,
          uuid: history['messageId'],
          timestamp: history['timestamp'],
          parentUuid: existing.parentUuid,
          type: 'tool_result',
          daemonPromptId: promptId,
          model: history['model'],
          message: { role: 'user', parts },
        })
      )
        throw new Error('Original CSI tool message differs.');
    } else {
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
      await session.sink.write(record);
      parentUuid = record.uuid;
    }
    if (item.state === 'in_progress')
      await harness.resolveAwaitRuntime(item.executionCallId, ref);
    else if (
      item.state !== 'settled' ||
      !isDeepStrictEqual(item.outcomeRef, ref)
    )
      throw new Error('Original CSI tool checkpoint differs.');
    responses.push(...parts);
  }
  const latest = authority.domainRecord('file_history');
  if (!latest) throw new Error('Original CSI file history is unavailable.');
  const saved = object(
    parseManagedCsiFileJson(
      await session.resources.read(latest.recordRef),
      64 * 1024,
    ),
  );
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
  return responses;
}
