/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import {
  assertManagedSessionDigest,
  assertManagedSessionDurableRef,
  assertManagedSessionKey,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  assertManagedSessionTime,
  managedSessionKeysEqual,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
  type ManagedSessionKey,
} from './managed-session-records.js';
import type { ToolResultExpectedIdentity } from './managed-tool-result-store.js';

export const TOOL_PUBLICATION_PROTOCOL = 'managed-tool-publication/1';
export const TOOL_PUBLICATION_LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  maxCaptureBytes: 2 ** 41,
  producerBytes: 2 * 1024 * 1024 + 64 * 1024 + 2 * 256 * 1024,
  admissionBytes: 2 * 1024 * 1024,
});

export interface ToolPublicationOwner {
  readonly writerId: string;
  readonly writerGeneration: number;
}

export interface ToolPublicationBinding extends ToolPublicationOwner {
  readonly publication: typeof TOOL_PUBLICATION_PROTOCOL;
  readonly publicationId: string;
  readonly sessionKey: ManagedSessionKey;
  readonly turnId: string;
  readonly executionCallId: string;
  readonly modelCallId: string;
  readonly runtimeBindingId: string;
  readonly reference: {
    readonly sessionId: string;
    readonly promptId: string;
    readonly callId: string;
    readonly argsDigest: string;
  };
  readonly bindingGeneration: string;
  readonly captureId: string;
  readonly revision: 1;
  readonly captureScope: 'process_pipes';
  readonly capturePolicy: 'complete_required';
  readonly argsRef: ManagedSessionDurableRef;
  readonly requestDigest: string;
  readonly activationId: string;
  readonly activationEpoch: number;
  readonly intentSequence: number;
  readonly checkpointRef: ManagedSessionDurableRef;
}

export type ToolPublicationRequest = {
  readonly publication: typeof TOOL_PUBLICATION_PROTOCOL;
  readonly sessionKey: ManagedSessionKey;
  readonly owner: ToolPublicationOwner;
} & (
  | {
      readonly operation: 'reserve';
      readonly binding: ToolPublicationBinding;
      readonly captureBytes: number;
    }
  | {
      readonly operation: 'renew' | 'fence' | 'close_not_started';
      readonly publicationId: string;
    }
);

export interface ToolPublicationGrant {
  readonly publication: typeof TOOL_PUBLICATION_PROTOCOL;
  readonly publicationId: string;
  readonly bindingDigest: string;
  readonly state: 'OPEN' | 'FENCED' | 'NOT_STARTED';
  readonly expiresAt: number | null;
  readonly captureBytes: number;
  readonly producerBytes: number;
  readonly admissionBytes: number;
}

const BINDING_KEYS = [
  'publication',
  'publicationId',
  'sessionKey',
  'turnId',
  'executionCallId',
  'modelCallId',
  'runtimeBindingId',
  'reference',
  'bindingGeneration',
  'captureId',
  'revision',
  'captureScope',
  'capturePolicy',
  'argsRef',
  'requestDigest',
  'writerId',
  'writerGeneration',
  'activationId',
  'activationEpoch',
  'intentSequence',
  'checkpointRef',
] as const;

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid managed tool publication.');
}

function closed(
  value: unknown,
  keys: readonly string[],
): Record<string, ManagedSessionJsonValue> {
  requireValue(value !== null && typeof value === 'object');
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
  );
  const present = Object.keys(value);
  requireValue(
    present.length === keys.length &&
      present.every((key) => keys.includes(key)),
  );
  return Object.fromEntries(
    present.map((key) => [
      key,
      (value as Record<string, ManagedSessionJsonValue>)[key],
    ]),
  );
}

function id(value: ManagedSessionJsonValue | undefined): string {
  return assertManagedSessionStableId(value, 'publication id');
}

function token(value: ManagedSessionJsonValue | undefined): string {
  const text = id(value);
  requireValue(/^[a-z0-9_-]{1,128}$/.test(text));
  return text;
}

function count(
  value: ManagedSessionJsonValue | undefined,
  max = Number.MAX_SAFE_INTEGER - 1,
): number {
  const result = assertManagedSessionSequence(value, 'publication count');
  requireValue(result > 0 && result <= max);
  return result;
}

function wireDigest(value: ManagedSessionJsonValue | undefined): string {
  requireValue(
    typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value),
  );
  return value;
}

function ref(
  value: ManagedSessionJsonValue | undefined,
  kind: string,
): ManagedSessionDurableRef {
  const result = assertManagedSessionDurableRef(value, 'publication ref');
  requireValue(
    result.kind === kind &&
      result.schemaVersion === 1 &&
      result.byteLength > 0 &&
      result.byteLength <= TOOL_PUBLICATION_LIMITS.maxBodyBytes,
  );
  return Object.freeze(result);
}

function bounded<T>(value: T): T {
  requireValue(
    Buffer.byteLength(JSON.stringify(value)) <=
      TOOL_PUBLICATION_LIMITS.maxBodyBytes,
  );
  return Object.freeze(value);
}

export function parseToolPublicationBinding(
  value: unknown,
): ToolPublicationBinding {
  const r = closed(value, BINDING_KEYS);
  requireValue(
    r['publication'] === TOOL_PUBLICATION_PROTOCOL &&
      r['revision'] === 1 &&
      r['captureScope'] === 'process_pipes' &&
      r['capturePolicy'] === 'complete_required',
  );
  const generation = id(r['bindingGeneration']);
  requireValue(
    /^[1-9][0-9]{0,18}$/.test(generation) &&
      BigInt(generation) <= 9223372036854775807n,
  );
  const reference = closed(r['reference'], [
    'sessionId',
    'promptId',
    'callId',
    'argsDigest',
  ]);
  return bounded({
    publication: TOOL_PUBLICATION_PROTOCOL,
    publicationId: token(r['publicationId']),
    sessionKey: Object.freeze(assertManagedSessionKey(r['sessionKey'])),
    turnId: id(r['turnId']),
    executionCallId: id(r['executionCallId']),
    modelCallId: id(r['modelCallId']),
    runtimeBindingId: id(r['runtimeBindingId']),
    reference: Object.freeze({
      sessionId: id(reference['sessionId']),
      promptId: id(reference['promptId']),
      callId: id(reference['callId']),
      argsDigest: wireDigest(reference['argsDigest']),
    }),
    bindingGeneration: generation,
    captureId: token(r['captureId']),
    revision: 1,
    captureScope: 'process_pipes',
    capturePolicy: 'complete_required',
    argsRef: ref(r['argsRef'], 'managed-tool-input'),
    requestDigest: wireDigest(r['requestDigest']),
    writerId: id(r['writerId']),
    writerGeneration: count(r['writerGeneration']),
    activationId: id(r['activationId']),
    activationEpoch: count(r['activationEpoch']),
    intentSequence: count(r['intentSequence']),
    checkpointRef: ref(r['checkpointRef'], 'managed-checkpoint'),
  });
}

export function parseToolPublicationRequest(
  value: unknown,
): ToolPublicationRequest {
  requireValue(value !== null && typeof value === 'object');
  const operation = (value as Record<string, unknown>)['operation'];
  requireValue(
    typeof operation === 'string' &&
      ['reserve', 'renew', 'fence', 'close_not_started'].includes(operation),
  );
  const r = closed(value, [
    'publication',
    'operation',
    'sessionKey',
    'owner',
    ...(operation === 'reserve'
      ? ['binding', 'captureBytes']
      : ['publicationId']),
  ]);
  requireValue(r['publication'] === TOOL_PUBLICATION_PROTOCOL);
  const o = closed(r['owner'], ['writerId', 'writerGeneration']);
  const common = {
    publication: TOOL_PUBLICATION_PROTOCOL,
    sessionKey: Object.freeze(assertManagedSessionKey(r['sessionKey'])),
    owner: Object.freeze({
      writerId: id(o['writerId']),
      writerGeneration: count(o['writerGeneration']),
    }),
  } as const;
  if (operation === 'reserve') {
    const binding = parseToolPublicationBinding(r['binding']);
    requireValue(
      managedSessionKeysEqual(binding.sessionKey, common.sessionKey) &&
        binding.writerId === common.owner.writerId &&
        binding.writerGeneration === common.owner.writerGeneration,
    );
    return bounded({
      ...common,
      operation,
      binding,
      captureBytes: count(
        r['captureBytes'],
        TOOL_PUBLICATION_LIMITS.maxCaptureBytes,
      ),
    });
  }
  return bounded({
    ...common,
    operation: operation as 'renew' | 'fence' | 'close_not_started',
    publicationId: token(r['publicationId']),
  });
}

export function parseToolPublicationGrant(
  value: unknown,
): ToolPublicationGrant {
  const r = closed(value, [
    'publication',
    'publicationId',
    'bindingDigest',
    'state',
    'expiresAt',
    'captureBytes',
    'producerBytes',
    'admissionBytes',
  ]);
  requireValue(
    r['publication'] === TOOL_PUBLICATION_PROTOCOL &&
      typeof r['state'] === 'string' &&
      ['OPEN', 'FENCED', 'NOT_STARTED'].includes(r['state']),
  );
  requireValue(
    r['producerBytes'] === TOOL_PUBLICATION_LIMITS.producerBytes &&
      r['admissionBytes'] === TOOL_PUBLICATION_LIMITS.admissionBytes,
  );
  const expiresAt =
    r['state'] === 'OPEN'
      ? assertManagedSessionTime(r['expiresAt'], 'grant expiry')
      : null;
  requireValue(
    r['state'] === 'OPEN'
      ? expiresAt !== null && expiresAt > 0
      : r['expiresAt'] === null,
  );
  return bounded({
    publication: TOOL_PUBLICATION_PROTOCOL,
    publicationId: token(r['publicationId']),
    bindingDigest: assertManagedSessionDigest(
      r['bindingDigest'],
      'binding digest',
    ),
    state: r['state'] as ToolPublicationGrant['state'],
    expiresAt,
    captureBytes: count(
      r['captureBytes'],
      TOOL_PUBLICATION_LIMITS.maxCaptureBytes,
    ),
    producerBytes: TOOL_PUBLICATION_LIMITS.producerBytes,
    admissionBytes: TOOL_PUBLICATION_LIMITS.admissionBytes,
  });
}

export function parseToolPublicationBytes(
  kind: 'binding' | 'request' | 'grant',
  bytes: Uint8Array,
): ToolPublicationBinding | ToolPublicationRequest | ToolPublicationGrant {
  requireValue(bytes.byteLength <= TOOL_PUBLICATION_LIMITS.maxBodyBytes);
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const value = parseManagedSessionRecordJson(
    text,
    TOOL_PUBLICATION_LIMITS.maxBodyBytes,
  );
  return {
    binding: parseToolPublicationBinding,
    request: parseToolPublicationRequest,
    grant: parseToolPublicationGrant,
  }[kind](value);
}

export function assertToolPublicationPayload(
  binding: ToolPublicationBinding,
  payloadJson: string,
): void {
  const parsed = parseToolPublicationBinding(binding);
  const payload = closed(
    parseManagedSessionRecordJson(payloadJson, 256 * 1024),
    ['toolName', 'input'],
  );
  requireValue(
    payload['toolName'] === 'run_shell_command' &&
      payload['input'] !== null &&
      typeof payload['input'] === 'object' &&
      !Array.isArray(payload['input']),
  );
  const input = payload['input'] as Record<string, ManagedSessionJsonValue>;
  requireValue(
    typeof input['command'] === 'string' &&
      input['command'].length > 0 &&
      Object.keys(input).every((key) =>
        ['command', 'timeout', 'description'].includes(key),
      ) &&
      (input['timeout'] === undefined ||
        (Number.isInteger(input['timeout']) &&
          (input['timeout'] as number) >= 1 &&
          (input['timeout'] as number) <= 600_000)) &&
      (input['description'] === undefined ||
        typeof input['description'] === 'string'),
  );
  requireValue(
    parsed.requestDigest ===
      `sha256:${createHash('sha256').update(payloadJson).digest('hex')}` &&
      parsed.reference.argsDigest === `sha256:${managedToolDigest(input)}`,
  );
}

export function toolPublicationBindingDigest(
  binding: ToolPublicationBinding,
): string {
  return managedToolDigest(
    parseToolPublicationBinding(binding),
    TOOL_PUBLICATION_LIMITS.maxBodyBytes,
  );
}

export function toolPublicationManifestIdentity(
  binding: ToolPublicationBinding,
): ToolResultExpectedIdentity {
  const b = parseToolPublicationBinding(binding);
  return {
    tenantId: b.sessionKey.tenantId,
    sessionId: b.sessionKey.sessionId,
    turnId: b.turnId,
    executionCallId: b.executionCallId,
    callId: b.reference.callId,
    invocationDigest: b.reference.argsDigest,
    bindingGeneration: b.bindingGeneration,
    captureId: b.captureId,
    revision: b.revision,
  };
}

export function createToolPublicationToken(): string {
  return randomBytes(32).toString('base64url');
}
