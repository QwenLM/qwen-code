/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createManagedContextAttestationResponse,
  parseManagedContextBoot,
} from './managed-context-envelope.js';
import {
  computeManagedContextDigest,
  isCanonicalDecimalText,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';
import {
  parseManagedCsiFileJson,
  type ManagedCsiFileBoot,
} from './managed-csi-file-envelope.js';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';

export const CSI_NATIVE_READBACK_PATH =
  '/internal/runtime-broker/csi/v1/native:read';
export const CSI_NATIVE_REQUEST_LIMIT = 16 * 1024;
export const CSI_NATIVE_RESPONSE_LIMIT = 8 * 1024 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG = `sha256:${createHash('sha256')
  .update('csi-files-retirement-tools/1\0csi-files-retirement-policy/1')
  .digest('hex')}`;
const COMMON = [
  'protocolVersion',
  'requestId',
  'action',
  'identity',
  'context',
  'installedContext',
];

export interface CsiNativeReadbackRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly action: 'bind' | 'prepare' | 'execute';
  readonly identity: Record<string, unknown>;
  readonly context: Record<string, unknown>;
  readonly installedContext: Record<string, unknown>;
  readonly subject: ManagedSessionDurableRef | string | null;
}

export interface CsiNativeReadbackResponse {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly action: CsiNativeReadbackRequest['action'];
  readonly identity: Record<string, unknown>;
  readonly context: Record<string, unknown>;
  readonly installedContext: Record<string, unknown>;
  readonly head: { revision: number; sequence: number; digest: string };
  readonly evidence: Record<string, unknown>;
}

export function readCsiNativeRequest(value: unknown): CsiNativeReadbackRequest {
  const body = closed(value, [...COMMON, 'subject']);
  common(body);
  switch (body['action']) {
    case 'bind':
      ensure(body['subject'] === null);
      break;
    case 'prepare':
      ref(body['subject'], 'managed-file_history');
      break;
    case 'execute':
      id(body['subject']);
      break;
    default:
      throw invalid();
  }
  ensure(Buffer.byteLength(JSON.stringify(body)) <= CSI_NATIVE_REQUEST_LIMIT);
  return structuredClone(body) as unknown as CsiNativeReadbackRequest;
}

export function readCsiNativeResponse(
  value: unknown,
  request: CsiNativeReadbackRequest,
): CsiNativeReadbackResponse {
  readCsiNativeRequest(request);
  const body = closed(value, [...COMMON, 'head', 'evidence']);
  common(body);
  for (const field of COMMON)
    ensure(
      isDeepStrictEqual(
        body[field],
        request[field as keyof CsiNativeReadbackRequest],
      ),
    );
  const head = closed(body['head'], ['revision', 'sequence', 'digest']);
  ensure(counter(head['revision']) > 0 && counter(head['sequence']) > 0);
  digest(head['digest']);
  const owner = object(body['identity'])['sessionId'];
  const evidence = object(body['evidence']);
  switch (body['action']) {
    case 'bind':
      closed(evidence, ['kind']);
      ensure(evidence['kind'] === 'ready');
      break;
    case 'prepare': {
      closed(evidence, ['kind', 'intentRef', 'resources', 'members']);
      ensure(
        evidence['kind'] === 'intent' &&
          isDeepStrictEqual(evidence['intentRef'], request.subject),
      );
      const required = new Map<string, ManagedSessionDurableRef>();
      add(required, ref(evidence['intentRef'], 'managed-file_history'));
      const members = list(evidence['members']);
      ensure(members.length > 0 && members.length <= 4096);
      let previous = -1;
      let prompt: unknown;
      let batch: unknown;
      const calls = new Set<unknown>();
      const functions = new Set<unknown>();
      for (const candidate of members) {
        const member = execution(candidate, owner);
        const ordinal = counter(member['ordinal']);
        ensure(
          ordinal > previous &&
            !calls.has(member['callId']) &&
            !functions.has(member['functionCallId']),
        );
        ensure(
          prompt === undefined ||
            (prompt === member['promptId'] && batch === member['batchId']),
        );
        prompt = member['promptId'];
        batch = member['batchId'];
        previous = ordinal;
        calls.add(member['callId']);
        functions.add(member['functionCallId']);
        add(required, ref(member['inputRef'], 'managed-tool-input'));
        add(
          required,
          ref(member['toolDefinitionRef'], 'managed-tool-definition'),
        );
      }
      resources(evidence['resources'], required);
      break;
    }
    case 'execute': {
      closed(evidence, [
        'kind',
        'executionReference',
        'preparedRef',
        'authorizationRevision',
        'authorizationSequence',
        'grant',
        'resources',
      ]);
      ensure(evidence['kind'] === 'authorization');
      const reference = execution(evidence['executionReference'], owner);
      const required = new Map<string, ManagedSessionDurableRef>();
      const inputRef = ref(reference['inputRef'], 'managed-tool-input');
      add(required, inputRef);
      add(
        required,
        ref(reference['toolDefinitionRef'], 'managed-tool-definition'),
      );
      const prepared = evidence['preparedRef'];
      if (prepared !== null)
        add(required, ref(prepared, 'managed-file_history'));
      const grant = closed(evidence['grant'], [
        'protocolVersion',
        'runtimeBindingId',
        'bindingGeneration',
        'authorizedBindingVersion',
        'executionCallId',
        'dispatchGeneration',
        'authorizationRevision',
        'authorizationSequence',
        'executionReference',
        'intent',
        'checkpointRef',
        'preparedRef',
        'identity',
        'context',
        'installedContext',
      ]);
      ensure(
        grant['protocolVersion'] === 1 &&
          grant['executionCallId'] === request.subject &&
          isDeepStrictEqual(grant['executionReference'], reference) &&
          isDeepStrictEqual(grant['preparedRef'], prepared),
      );
      id(grant['runtimeBindingId']);
      for (const field of [
        'bindingGeneration',
        'authorizedBindingVersion',
        'dispatchGeneration',
      ])
        ensure(isCanonicalDecimalText(grant[field]));
      for (const field of ['authorizationRevision', 'authorizationSequence']) {
        const count = counter(evidence[field]);
        ensure(
          count > 0 &&
            count === counter(grant[field]) &&
            count <=
              counter(
                head[
                  field === 'authorizationRevision' ? 'revision' : 'sequence'
                ],
              ),
        );
      }
      for (const field of ['identity', 'context', 'installedContext'])
        ensure(isDeepStrictEqual(grant[field], body[field]));
      const intent = closed(grant['intent'], ['revision', 'sequence']);
      ensure(
        counter(intent['revision']) > 0 &&
          counter(intent['sequence']) > 0 &&
          counter(intent['revision']) <
            counter(grant['authorizationRevision']) &&
          counter(intent['sequence']) < counter(grant['authorizationSequence']),
      );
      ref(grant['checkpointRef'], 'managed-checkpoint');
      const bytes = resources(evidence['resources'], required);
      if (prepared === null) {
        const input = object(
          parseManagedSessionRecordJson(
            bytes.get(inputRef.resourceId)!.toString('utf8'),
            64 * 1024,
          ),
        );
        ensure(typeof input['payloadJson'] === 'string');
        const payload = object(
          parseManagedSessionRecordJson(
            input['payloadJson'] as string,
            64 * 1024,
          ),
        );
        ensure(payload['toolName'] === 'read_file');
      }
      break;
    }
    default:
      throw invalid();
  }
  ensure(Buffer.byteLength(JSON.stringify(body)) <= CSI_NATIVE_RESPONSE_LIMIT);
  return structuredClone(body) as unknown as CsiNativeReadbackResponse;
}

function common(value: Record<string, unknown>): void {
  ensure(value['protocolVersion'] === 1);
  uuid(value['requestId']);
  const identity = closed(value['identity'], [
    'profile',
    'sessionId',
    'capabilityDigest',
  ]);
  ensure(
    identity['profile'] === 'csi-files-retirement/1' &&
      identity['capabilityDigest'] === CSI_FILES_RETIREMENT_CAPABILITY_DIGEST,
  );
  uuid(identity['sessionId']);
  const context = closed(value['context'], [
    'protocolVersion',
    'managedContext',
    'runtimeInstanceId',
    'runtimeIncarnation',
    'leaseId',
    'epoch',
    'provisionRequestId',
    'tenantId',
    'workspaceId',
    'workspaceGeneration',
    'storageId',
    'mountRoot',
    'capabilityDigest',
    'isolationClass',
  ]);
  ensure(
    context['protocolVersion'] === 3 &&
      context['isolationClass'] === 'session' &&
      context['capabilityDigest'] === identity['capabilityDigest'],
  );
  const { protocolVersion: _version, ...fields } = context;
  parseManagedContextBoot({
    ...fields,
    type: 'boot',
    version: 2,
    token: 'validation-token',
  });
  const installed = closed(value['installedContext'], [
    'protocolVersion',
    'managedContext',
    'operationId',
    'sessionId',
    'contextDigest',
    'binding',
  ]);
  ensure(
    installed['protocolVersion'] === 3 &&
      installed['managedContext'] === 'managed-context/1' &&
      installed['sessionId'] === identity['sessionId'],
  );
  const owner = identity['sessionId'] as string;
  const hash = createHash('md5').update(owner).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  ensure(
    installed['operationId'] ===
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  const binding = closed(installed['binding'], [
    'tenantId',
    'workspaceId',
    'workspaceGeneration',
    'storageId',
    'cwdRelative',
    'contextConfigRef',
    'contextRevision',
  ]);
  for (const field of [
    'tenantId',
    'workspaceId',
    'workspaceGeneration',
    'storageId',
  ])
    ensure(binding[field] === context[field]);
  ensure(
    binding['cwdRelative'] === '.' &&
      binding['contextRevision'] === '1' &&
      binding['contextConfigRef'] === CONFIG,
  );
  ensure(
    computeManagedContextDigest(binding as unknown as ManagedContextBinding) ===
      installed['contextDigest'],
  );
}

function execution(value: unknown, owner: unknown): Record<string, unknown> {
  const result = closed(value, [
    'sessionId',
    'promptId',
    'callId',
    'argsDigest',
    'batchId',
    'functionCallId',
    'partIndex',
    'ordinal',
    'inputRef',
    'toolDefinitionRef',
    'dispatchMode',
  ]);
  ensure(
    result['sessionId'] === owner && result['dispatchMode'] === 'deferred',
  );
  for (const field of ['promptId', 'callId', 'batchId']) uuid(result[field]);
  id(result['functionCallId']);
  digest(result['argsDigest'], true);
  counter(result['partIndex']);
  counter(result['ordinal']);
  ensure(
    ref(result['inputRef'], 'managed-tool-input').resourceId !==
      ref(result['toolDefinitionRef'], 'managed-tool-definition').resourceId,
  );
  return result;
}

function resources(
  value: unknown,
  required: Map<string, ManagedSessionDurableRef>,
): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const candidate of list(value)) {
    const entry = closed(candidate, ['reference', 'bytesBase64']);
    const reference = object(entry['reference']);
    const resourceId = id(reference['resourceId']);
    ensure(
      required.has(resourceId) &&
        isDeepStrictEqual(required.get(resourceId), reference),
    );
    ensure(typeof entry['bytesBase64'] === 'string');
    const encoded = entry['bytesBase64'] as string;
    const bytes = Buffer.from(encoded, 'base64');
    ensure(
      bytes.toString('base64') === encoded &&
        bytes.length <= 64 * 1024 &&
        bytes.length === reference['byteLength'] &&
        createHash('sha256').update(bytes).digest('hex') ===
          reference['digest'] &&
        !result.has(resourceId),
    );
    result.set(resourceId, bytes);
  }
  ensure(result.size === required.size);
  return result;
}

function ref(value: unknown, kind: string): ManagedSessionDurableRef {
  const result = assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    'CSI native resource',
  );
  ensure(
    result.kind === kind &&
      result.schemaVersion === 1 &&
      result.byteLength > 0 &&
      result.byteLength <= 64 * 1024,
  );
  return result;
}

function add(
  required: Map<string, ManagedSessionDurableRef>,
  reference: ManagedSessionDurableRef,
): void {
  const previous = required.get(reference.resourceId);
  ensure(previous === undefined || isDeepStrictEqual(previous, reference));
  required.set(reference.resourceId, reference);
}

function counter(value: unknown): number {
  ensure(Number.isSafeInteger(value) && (value as number) >= 0);
  return value as number;
}
function id(value: unknown): string {
  return assertManagedSessionStableId(
    value as ManagedSessionJsonValue,
    'CSI native identity',
  );
}
function digest(value: unknown, prefix = false): void {
  ensure(
    typeof value === 'string' &&
      (prefix ? /^sha256:[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/).test(value),
  );
}
function uuid(value: unknown): void {
  ensure(typeof value === 'string' && UUID.test(value));
}
function list(value: unknown): unknown[] {
  ensure(Array.isArray(value));
  return value as unknown[];
}
function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  const result = object(value);
  ensure(isDeepStrictEqual(Object.keys(result).sort(), [...keys].sort()));
  return result;
}
function ensure(condition: boolean): asserts condition {
  if (!condition) throw invalid();
}
function invalid(): Error {
  return new Error('Invalid private CSI native readback.');
}

export async function readCurrentCsiNative(
  boot: ManagedCsiFileBoot,
  installedContext: Record<string, unknown>,
  action: CsiNativeReadbackRequest['action'],
  subject: CsiNativeReadbackRequest['subject'],
): Promise<CsiNativeReadbackResponse> {
  if (boot.version !== 5) throw invalid();
  const request = readCsiNativeRequest({
    protocolVersion: 1,
    requestId: randomUUID(),
    action,
    identity: boot.identity,
    context: createManagedContextAttestationResponse(boot.context),
    installedContext,
    subject,
  });
  const response = await fetch(
    `${boot.authority.origin}${CSI_NATIVE_READBACK_PATH}`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${boot.context.token}`,
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify(request),
    },
  );
  ensure(
    response.status === 200 &&
      response.headers.get('content-encoding') === null &&
      response.headers.get('cache-control') === 'no-store' &&
      response.headers.get('content-type')?.split(';')[0].trim() ===
        'application/json',
  );
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      ensure(length <= CSI_NATIVE_RESPONSE_LIMIT);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return readCsiNativeResponse(
    parseManagedCsiFileJson(Buffer.concat(chunks), CSI_NATIVE_RESPONSE_LIMIT),
    request,
  );
}
