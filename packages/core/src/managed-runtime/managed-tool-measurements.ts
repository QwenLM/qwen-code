/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from './managed-session-assembly.js';
import {
  ManagedSessionRecordError,
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
} from './managed-session-records.js';
import { managedInvocationId } from './managed-execution-diagnostics.js';
import { readManagedMessageBody } from './managed-message-chunks.js';
import type { ChatRecord } from '../services/chatRecordingService.js';

export const MANAGED_TOOL_MEASUREMENTS_KIND = 'managed-tool-measurements';
export const MANAGED_TOOL_MEASUREMENTS_MAX_BYTES = 4096;

export interface ManagedFileMeasurement {
  operation: 'read' | 'write' | 'edit';
  status: 'measured' | 'unchanged' | 'unmeasured';
  modelLinesAdded: number | null;
  modelLinesRemoved: number | null;
  appliedLinesAdded: number | null;
  appliedLinesRemoved: number | null;
}

export interface ManagedToolMeasurements {
  protocol: 'managed-tool-measurements/1';
  executionDurationMs: number | null;
  executionOutcome:
    | 'not_started'
    | 'success'
    | 'error'
    | 'cancelled'
    | 'unknown';
  file: ManagedFileMeasurement | null;
}

export interface ManagedToolMeasurementEvidence {
  schemaVersion: 1;
  invocationId: string;
  executionCallId: string;
  resultDigest: string;
  modelProposal: 'original' | 'modified' | 'unknown';
  measurements: ManagedToolMeasurements | null;
}

export interface ManagedToolResultMeasurements {
  measurements: ManagedToolMeasurements | null;
  resultDigest: string;
}

function invalid(): never {
  throw new ManagedSessionRecordError('Invalid Managed tool measurements.');
}

function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== keys.sort().join(',')) invalid();
  return record;
}

function count(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

export function parseManagedToolMeasurements(
  value: unknown,
): ManagedToolMeasurements {
  const body = closed(value, [
    'protocol',
    'executionDurationMs',
    'executionOutcome',
    'file',
  ]);
  if (
    body['protocol'] !== 'managed-tool-measurements/1' ||
    !count(body['executionDurationMs']) ||
    !['not_started', 'success', 'error', 'cancelled', 'unknown'].includes(
      String(body['executionOutcome']),
    )
  )
    invalid();
  if (body['file'] !== null) {
    const file = closed(body['file'], [
      'operation',
      'status',
      'modelLinesAdded',
      'modelLinesRemoved',
      'appliedLinesAdded',
      'appliedLinesRemoved',
    ]);
    const fields = [
      'modelLinesAdded',
      'modelLinesRemoved',
      'appliedLinesAdded',
      'appliedLinesRemoved',
    ];
    if (
      body['executionOutcome'] !== 'success' ||
      !['read', 'write', 'edit'].includes(String(file['operation'])) ||
      !['measured', 'unchanged', 'unmeasured'].includes(
        String(file['status']),
      ) ||
      !fields.every((field) => count(file[field])) ||
      (file['modelLinesAdded'] === null) !==
        (file['modelLinesRemoved'] === null) ||
      (file['appliedLinesAdded'] === null) !==
        (file['appliedLinesRemoved'] === null)
    )
      invalid();
    if (file['operation'] === 'read') {
      if (
        file['status'] !== 'measured' ||
        !fields.every((field) => file[field] === null)
      )
        invalid();
    } else if (file['status'] === 'unmeasured') {
      if (file['appliedLinesAdded'] !== null) invalid();
    } else if (
      fields.some((field) => file[field] === null) ||
      (file['status'] === 'unchanged') !==
        (file['appliedLinesAdded'] === 0 && file['appliedLinesRemoved'] === 0)
    )
      invalid();
  }
  return structuredClone(body) as unknown as ManagedToolMeasurements;
}

export function parseManagedToolMeasurementEvidence(
  bytes: Buffer,
): ManagedToolMeasurementEvidence {
  if (bytes.byteLength > MANAGED_TOOL_MEASUREMENTS_MAX_BYTES) invalid();
  const body = closed(JSON.parse(bytes.toString('utf8')), [
    'schemaVersion',
    'invocationId',
    'executionCallId',
    'resultDigest',
    'modelProposal',
    'measurements',
  ]);
  if (
    body['schemaVersion'] !== 1 ||
    typeof body['invocationId'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(body['invocationId']) ||
    typeof body['resultDigest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(body['resultDigest']) ||
    typeof body['executionCallId'] !== 'string' ||
    !body['executionCallId'].length ||
    Buffer.byteLength(body['executionCallId']) > 512 ||
    /[\ud800-\udfff]/u.test(body['executionCallId']) ||
    !['original', 'modified', 'unknown'].includes(String(body['modelProposal']))
  )
    invalid();
  if (body['measurements'] !== null)
    parseManagedToolMeasurements(body['measurements']);
  return body as unknown as ManagedToolMeasurementEvidence;
}

export function toolMeasurementCommitDigest(
  executionCallId: string,
  outcome: ManagedSessionDurableRef,
  measurements: ManagedSessionDurableRef,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'managed-tool-measured/1',
        executionCallId,
        outcome.digest,
        measurements.digest,
      ]),
    )
    .digest('hex');
}

async function modelProposal(
  session: ManagedSession,
  intent: ManagedSessionEvent,
  measurements: ManagedToolMeasurements | null,
): Promise<ManagedToolMeasurementEvidence['modelProposal']> {
  if (!measurements?.file || measurements.file.operation === 'read')
    return 'unknown';
  const source = session.authority.committedEvent(
    `message:${String(intent.payload['batchId'])}`,
  );
  if (!source) return 'unknown';
  const inputRef = assertManagedSessionDurableRef(
    intent.payload['argsRef'],
    'tool input',
  );
  if (inputRef.kind !== 'managed-tool-input') return 'unknown';
  const record = JSON.parse(
    (
      await readManagedMessageBody(
        (ref) => session.resources.read(ref),
        assertManagedSessionDurableRef(source.payload['contentRef'], 'message'),
      )
    ).toString('utf8'),
  ) as ChatRecord;
  const call = record.message?.parts?.filter((part) => part.functionCall)[
    Number(intent.payload['ordinal'])
  ]?.functionCall;
  const routed = JSON.parse(
    (await session.resources.read(inputRef)).toString(),
  );
  const dispatched = JSON.parse(routed.payloadJson) as {
    toolName: string;
    input: unknown;
  };
  if (!call || call.name !== dispatched.toolName) return 'unknown';
  return isDeepStrictEqual(call.args, dispatched.input)
    ? 'original'
    : 'modified';
}

/** A separate source event preserves receipts already committed by v3 publication. */
export async function recordManagedToolMeasurements(
  session: ManagedSession,
  executionCallId: string,
  toolOutcomeRef: ManagedSessionDurableRef,
  result: ManagedToolResultMeasurements | undefined,
): Promise<void> {
  if (!result) return;
  const authority = session.authority;
  const events = authority.eventsInSequenceRange(
    1,
    authority.committedSequence,
  );
  const intent = events.find(
    (event) =>
      event.kind === 'tool.intent' &&
      event.payload['executionCallId'] === executionCallId,
  );
  // An execution admitted before collection started stays outside that window.
  if (!intent?.payload['diagnosticsRef']) return;
  const body: ManagedToolMeasurementEvidence = {
    schemaVersion: 1,
    invocationId: managedInvocationId(
      authority.sessionHeader.sessionKey,
      String(intent.payload['batchId']),
      Number(intent.payload['ordinal']),
    ),
    executionCallId,
    resultDigest: result.resultDigest,
    modelProposal: await modelProposal(session, intent, result.measurements),
    measurements: result.measurements,
  };
  const bytes = Buffer.from(JSON.stringify(body));
  parseManagedToolMeasurementEvidence(bytes);
  const existing = events.find(
    (event) =>
      event.kind === 'tool.measured' &&
      event.payload['executionCallId'] === executionCallId,
  );
  if (existing) {
    const ref = assertManagedSessionDurableRef(
      existing.payload['measurementsRef'],
      'tool measurements',
    );
    if (
      !isDeepStrictEqual(
        parseManagedToolMeasurementEvidence(await session.resources.read(ref)),
        body,
      )
    )
      invalid();
    return;
  }
  const measurementsRef = await session.resources.publish(
    MANAGED_TOOL_MEASUREMENTS_KIND,
    bytes,
  );
  await authority.appendExecutionEvent(
    {
      operation: 'recordToolMeasurements',
      commandId: executionCallId,
      sessionKey: authority.sessionHeader.sessionKey,
      contentDigest: toolMeasurementCommitDigest(
        executionCallId,
        toolOutcomeRef,
        measurementsRef,
      ),
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: `tool-measured:${executionCallId}`,
      sessionKey: authority.sessionHeader.sessionKey,
      kind: 'tool.measured',
      occurredAt: Date.now(),
      subject: {
        type: 'activation',
        scopeId: session.activation.activationId,
        activationId: session.activation.activationId,
        epoch: session.activation.epoch,
      },
      payload: { executionCallId, toolOutcomeRef, measurementsRef },
    }),
    {
      class: 'harness',
      activation: {
        activationId: session.activation.activationId,
        epoch: session.activation.epoch,
      },
    },
  );
}
