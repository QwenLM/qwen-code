/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type { ManagedSession } from './managed-session-assembly.js';
import type { LocalManagedSessionAuthority } from './managed-session-authority.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionKey,
} from './managed-session-records.js';
import { readManagedMessageBody } from './managed-message-chunks.js';

export const EXECUTION_DIAGNOSTICS_KIND = 'managed-execution-diagnostics';
export const EXECUTION_DIAGNOSTICS_MAX_BYTES = 64 * 1024;
export const DIAGNOSTIC_ADMISSIONS = [
  'allowed',
  'denied',
  'invalid',
  'unknown',
] as const;
export const DIAGNOSTIC_EXECUTIONS = [
  'not_started',
  'running',
  'success',
  'error',
  'cancelled',
  'unknown',
] as const;
export const DIAGNOSTIC_DELIVERIES = [
  'pending',
  'complete',
  'partial',
  'unavailable',
  'unknown',
] as const;

export interface ManagedInvocationObservation {
  invocationId: string;
  assistantMessageId: string;
  ordinal: number;
  toolName: string;
  functionCallId: string | null;
  providerCallId: string | null;
  executionCallId: string | null;
  taskId: string | null;
  toolKind: 'builtin' | 'mcp' | 'hosted' | 'unknown';
  serverId: string | null;
  admission: (typeof DIAGNOSTIC_ADMISSIONS)[number];
  execution: (typeof DIAGNOSTIC_EXECUTIONS)[number];
  delivery: (typeof DIAGNOSTIC_DELIVERIES)[number];
  capture: 'complete' | 'partial' | 'unavailable' | 'unknown';
  file: {
    operation: 'read' | 'write' | 'edit';
    path: string | null;
    cwdRelative: string | null;
  } | null;
  skill: {
    resourceKind: 'skill' | 'extension_command';
    name: string;
    pin: string;
    origin: 'user' | 'model' | 'unknown';
    delivery: 'complete' | 'partial' | 'unknown';
  } | null;
}

export interface ManagedExecutionEvidence {
  schemaVersion: 1;
  reducerVersion: 1;
  epochId: string;
  startEventId: string;
  sourceEventId: string;
  observations: ManagedInvocationObservation[];
  coverageReasons: string[];
  omittedObservationCount: number;
}

export function observeManagedToolResponse(
  fact: ManagedInvocationObservation,
  response?: Record<string, unknown>,
): void {
  const execution = response?.['executionStatus'];
  if (
    typeof execution === 'string' &&
    DIAGNOSTIC_EXECUTIONS.includes(
      execution as ManagedInvocationObservation['execution'],
    )
  )
    fact.execution = execution as ManagedInvocationObservation['execution'];
  fact.delivery =
    response?.['outputOmitted'] === true
      ? 'unavailable'
      : response?.['outputTruncated'] === true
        ? 'partial'
        : 'complete';
  const capture = response?.['capture'];
  if (capture && typeof capture === 'object') {
    const value = capture as Record<string, unknown>;
    const status = value['captureStatus'];
    if (
      status === 'complete' ||
      status === 'partial' ||
      status === 'unavailable'
    )
      fact.capture = status;
    if (value['deliveryStatus'] === 'blocked') fact.delivery = 'unavailable';
    if (value['previewTruncated'] === true && fact.delivery === 'complete')
      fact.delivery = 'partial';
  }
  if (fact.skill?.delivery === 'partial' && fact.delivery === 'complete')
    fact.delivery = 'partial';
  if (
    fact.skill &&
    fact.execution === 'success' &&
    fact.skill.delivery === 'unknown'
  )
    fact.skill.delivery = fact.delivery === 'complete' ? 'complete' : 'partial';
}

export function managedInvocationId(
  key: ManagedSessionKey,
  messageId: string,
  ordinal: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'managed-tool-invocation/1',
        key.tenantId,
        key.sessionId,
        messageId,
        ordinal,
      ]),
    )
    .digest('hex');
}

export function executionDiagnosticDigest(
  original: string,
  ref: ManagedSessionDurableRef,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(['managed-execution-commit/1', original, ref.digest]),
    )
    .digest('hex');
}

function invalid(): never {
  throw new ManagedSessionRecordError('Invalid Managed execution diagnostics.');
}

export function parseManagedExecutionEvidence(
  bytes: Buffer,
): ManagedExecutionEvidence {
  if (bytes.length > EXECUTION_DIAGNOSTICS_MAX_BYTES) invalid();
  const value = JSON.parse(bytes.toString('utf8')) as ManagedExecutionEvidence;
  const text = (v: unknown, nullable = false) =>
    (nullable && v === null) ||
    (typeof v === 'string' &&
      v.length > 0 &&
      Buffer.byteLength(v) <= 4096 &&
      !/[\ud800-\udfff]/u.test(v));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'coverageReasons,epochId,observations,omittedObservationCount,reducerVersion,schemaVersion,sourceEventId,startEventId' ||
    value.schemaVersion !== 1 ||
    value.reducerVersion !== 1 ||
    !text(value.epochId) ||
    !text(value.startEventId) ||
    !text(value.sourceEventId) ||
    !Array.isArray(value.observations) ||
    !Array.isArray(value.coverageReasons) ||
    value.coverageReasons.length > 16 ||
    !value.coverageReasons.every((v) =>
      [
        'observations_omitted',
        'file_path_unavailable',
        'history_before_collection',
      ].includes(v),
    ) ||
    !Number.isSafeInteger(value.omittedObservationCount) ||
    value.omittedObservationCount < 0
  )
    invalid();
  for (const fact of value.observations) {
    if (
      !fact ||
      typeof fact !== 'object' ||
      Object.keys(fact).sort().join(',') !==
        'admission,assistantMessageId,capture,delivery,execution,executionCallId,file,functionCallId,invocationId,ordinal,providerCallId,serverId,skill,taskId,toolKind,toolName' ||
      !/^[0-9a-f]{64}$/.test(fact.invocationId) ||
      !text(fact.assistantMessageId) ||
      !Number.isSafeInteger(fact.ordinal) ||
      fact.ordinal < 0 ||
      !text(fact.toolName) ||
      ![
        'functionCallId',
        'providerCallId',
        'executionCallId',
        'taskId',
        'serverId',
      ].every((key) =>
        text(fact[key as keyof ManagedInvocationObservation], true),
      ) ||
      !DIAGNOSTIC_ADMISSIONS.includes(fact.admission) ||
      !DIAGNOSTIC_EXECUTIONS.includes(fact.execution) ||
      !DIAGNOSTIC_DELIVERIES.includes(fact.delivery) ||
      !['builtin', 'mcp', 'hosted', 'unknown'].includes(fact.toolKind) ||
      !['complete', 'partial', 'unavailable', 'unknown'].includes(fact.capture)
    )
      invalid();
    if (fact.file !== null) {
      const file = fact.file;
      if (
        fact.toolKind !== 'builtin' ||
        !['read_file', 'write_file', 'edit'].includes(fact.toolName) ||
        file.operation !==
          (fact.toolName === 'read_file'
            ? 'read'
            : fact.toolName === 'write_file'
              ? 'write'
              : 'edit') ||
        Object.keys(file).sort().join(',') !== 'cwdRelative,operation,path' ||
        !['read', 'write', 'edit'].includes(file.operation) ||
        !text(file.path, true) ||
        !text(file.cwdRelative, true) ||
        [file.path, file.cwdRelative].some(
          (path) =>
            path !== null &&
            (path.startsWith('/') ||
              path.includes('\\') ||
              path.split('/').includes('..') ||
              path.includes('://') ||
              [...path].some((character) => character.codePointAt(0)! < 32)),
        )
      )
        invalid();
    }
    if (fact.skill !== null) {
      const skill = fact.skill;
      if (
        fact.toolKind !== 'hosted' ||
        fact.toolName !== 'skill' ||
        Object.keys(skill).sort().join(',') !==
          'delivery,name,origin,pin,resourceKind' ||
        !['skill', 'extension_command'].includes(skill.resourceKind) ||
        !text(skill.name) ||
        !text(skill.pin) ||
        !['user', 'model', 'unknown'].includes(skill.origin) ||
        !['complete', 'partial', 'unknown'].includes(skill.delivery)
      )
        invalid();
    }
  }
  return value;
}

const collectors = new WeakMap<
  LocalManagedSessionAuthority,
  ManagedExecutionDiagnostics
>();

export function getManagedExecutionDiagnostics(
  authority: LocalManagedSessionAuthority,
) {
  return collectors.get(authority);
}

export async function enableManagedExecutionDiagnostics(
  session: ManagedSession,
): Promise<void> {
  if (collectors.has(session.authority)) return;
  const collector = new ManagedExecutionDiagnostics(
    session.authority,
    session.resources,
  );
  await collector.restore();
  collectors.set(session.authority, collector);
}

export class ManagedExecutionDiagnostics {
  private epoch:
    | Pick<ManagedExecutionEvidence, 'epochId' | 'startEventId'>
    | undefined;
  private readonly calls = new Map<string, ManagedInvocationObservation>();
  private readonly prepared = new Map<
    string,
    { digest: string; ref: ManagedSessionDurableRef }
  >();
  private epochCommitted = false;
  private historyBeforeCollection = false;

  constructor(
    private readonly authority: LocalManagedSessionAuthority,
    private readonly resources: ManagedSessionResourceStore,
  ) {}

  async restore(): Promise<void> {
    for (const event of this.authority.eventsInSequenceRange(
      1,
      this.authority.committedSequence,
    )) {
      const ref = event.payload['diagnosticsRef'] as
        | ManagedSessionDurableRef
        | undefined;
      if (!ref) {
        if (
          !this.epoch &&
          event.kind === 'message.committed' &&
          event.payload['role'] === 'assistant'
        )
          this.historyBeforeCollection = true;
        continue;
      }
      const evidence = parseManagedExecutionEvidence(
        await this.resources.read(ref),
      );
      if (
        ref.kind !== EXECUTION_DIAGNOSTICS_KIND ||
        ref.schemaVersion !== 1 ||
        evidence.sourceEventId !== event.eventId
      )
        invalid();
      if (
        this.epoch &&
        (this.epoch.epochId !== evidence.epochId ||
          this.epoch.startEventId !== evidence.startEventId)
      )
        invalid();
      this.epoch = evidence;
      this.epochCommitted = true;
      if (
        event.kind === 'message.committed' &&
        event.payload['role'] === 'assistant'
      ) {
        const record = JSON.parse(
          (
            await readManagedMessageBody(
              (r) => this.resources.read(r),
              event.payload[
                'contentRef'
              ] as unknown as ManagedSessionDurableRef,
            )
          ).toString('utf8'),
        ) as ChatRecord;
        this.requests(record);
      }
      for (const observation of evidence.observations) {
        const call = observation.functionCallId
          ? this.calls.get(observation.functionCallId)
          : undefined;
        if (call?.invocationId !== observation.invocationId) continue;
        for (const [field, value] of Object.entries(observation)) {
          if (
            value !== null &&
            value !== 'unknown' &&
            !(field === 'delivery' && value === 'pending')
          )
            Object.assign(call, { [field]: structuredClone(value) });
        }
      }
    }
  }

  observation(callId: string): ManagedInvocationObservation | undefined {
    const call = this.calls.get(callId);
    return call ? structuredClone(call) : undefined;
  }

  private requests(record: ChatRecord): ManagedInvocationObservation[] {
    this.calls.clear();
    const facts: ManagedInvocationObservation[] = [];
    for (const part of record.message?.parts ?? []) {
      if (!part.functionCall) continue;
      const call = part.functionCall;
      const fact: ManagedInvocationObservation = {
        invocationId: managedInvocationId(
          this.authority.sessionHeader.sessionKey,
          record.uuid,
          facts.length,
        ),
        assistantMessageId: record.uuid,
        ordinal: facts.length,
        toolName: call.name ?? 'unknown',
        functionCallId: call.id ?? null,
        providerCallId: null,
        executionCallId: null,
        taskId: null,
        toolKind: 'unknown',
        serverId: null,
        admission: 'unknown',
        execution: 'unknown',
        delivery: 'pending',
        capture: 'unknown',
        file: null,
        skill: null,
      };
      facts.push(fact);
      if (call.id) this.calls.set(call.id, fact);
    }
    return facts;
  }

  async message(
    record: ChatRecord,
    observations?: readonly ManagedInvocationObservation[],
  ): Promise<ManagedSessionDurableRef | undefined> {
    if (!['assistant', 'tool_result'].includes(record.type)) return undefined;
    const committed = this.authority.committedEvent(`message:${record.uuid}`);
    if (committed) {
      return committed.payload['diagnosticsRef'] as
        | ManagedSessionDurableRef
        | undefined;
    }
    const facts =
      record.type === 'assistant'
        ? this.requests(record)
        : observations
          ? [...observations]
          : (record.message?.parts ?? []).flatMap((part) => {
              const fact = part.functionResponse?.id
                ? this.observation(part.functionResponse.id)
                : undefined;
              if (!fact) return [];
              observeManagedToolResponse(fact, part.functionResponse?.response);
              return [fact];
            });
    return this.publish(`message:${record.uuid}`, facts);
  }

  async publish(
    sourceEventId: string,
    observations: readonly ManagedInvocationObservation[],
  ): Promise<ManagedSessionDurableRef> {
    if (this.epoch && !this.epochCommitted) {
      this.epochCommitted = this.authority.hasCommittedEvent(
        this.epoch.startEventId,
      );
      if (!this.epochCommitted && this.epoch.startEventId !== sourceEventId)
        this.epoch = undefined;
    }
    if (!this.epoch)
      this.epoch = {
        epochId: createHash('sha256')
          .update(
            JSON.stringify([
              'managed-execution-epoch/1',
              this.authority.sessionHeader.sessionKey,
              sourceEventId,
            ]),
          )
          .digest('hex'),
        startEventId: sourceEventId,
      };
    const evidence: ManagedExecutionEvidence = {
      schemaVersion: 1,
      reducerVersion: 1,
      ...this.epoch,
      sourceEventId,
      observations: structuredClone([...observations]),
      coverageReasons: this.historyBeforeCollection
        ? ['history_before_collection']
        : [],
      omittedObservationCount: 0,
    };
    if (
      evidence.observations.some(
        (observation) => observation.file?.path === null,
      )
    )
      evidence.coverageReasons.push('file_path_unavailable');
    const originalDigest = createHash('sha256')
      .update(JSON.stringify(evidence))
      .digest('hex');
    const previous = this.prepared.get(sourceEventId);
    if (previous) {
      if (previous.digest !== originalDigest)
        throw new ManagedSessionRecordError(
          'Execution diagnostics replay differs.',
        );
      return previous.ref;
    }
    const lengths = evidence.observations.map((fact) =>
      Buffer.byteLength(JSON.stringify(fact)),
    );
    let observationBytes = lengths.reduce((total, length) => total + length, 0);
    const byteLength = () =>
      Buffer.byteLength(JSON.stringify({ ...evidence, observations: [] })) +
      observationBytes +
      Math.max(0, evidence.observations.length - 1);
    for (
      let index = evidence.observations.length - 1;
      index >= 0 && byteLength() > EXECUTION_DIAGNOSTICS_MAX_BYTES;
      index--
    ) {
      const observation = evidence.observations[index];
      if (!observation.file || observation.file.path === null) continue;
      observation.file.path = null;
      observation.file.cwdRelative = null;
      const length = Buffer.byteLength(JSON.stringify(observation));
      observationBytes += length - lengths[index];
      lengths[index] = length;
      if (!evidence.coverageReasons.includes('file_path_unavailable'))
        evidence.coverageReasons.push('file_path_unavailable');
    }
    while (
      byteLength() > EXECUTION_DIAGNOSTICS_MAX_BYTES &&
      evidence.observations.length
    ) {
      evidence.observations.pop();
      observationBytes -= lengths.pop()!;
      evidence.omittedObservationCount++;
      if (!evidence.coverageReasons.includes('observations_omitted'))
        evidence.coverageReasons.push('observations_omitted');
    }
    const bytes = Buffer.from(JSON.stringify(evidence));
    parseManagedExecutionEvidence(bytes);
    const ref = await this.resources.publish(EXECUTION_DIAGNOSTICS_KIND, bytes);
    this.prepared.set(sourceEventId, { digest: originalDigest, ref });
    if (this.prepared.size > 256)
      this.prepared.delete(this.prepared.keys().next().value!);
    return ref;
  }
}
