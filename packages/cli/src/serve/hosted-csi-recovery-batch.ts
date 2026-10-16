/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Part } from '@google/genai';
import type { HarnessToolItem } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedSessionJsonValue } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedRuntimeInlineResult } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-tool-response.js';
import { parseManagedCsiFileJson } from './managed-csi-file-envelope.js';
import {
  CSI_NATIVE_RESPONSE_LIMIT,
  readCsiNativeGrant,
} from './managed-csi-native-readback.js';
import { acceptedCsiToolInput } from './hosted-csi-tool-evidence.js';
import {
  HOSTED_WORKSPACE_FILE_TOOLS,
  hostedWorkspaceDeclarations,
} from './hosted-workspace-tool-turn.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';

export interface CsiRecoveryOwner {
  readonly bindingId: string;
  readonly generation: string;
  readonly writerId: string;
  readonly writerGeneration: number;
  readonly activationId: string;
  readonly activationEpoch: number;
}

function ensure(condition: boolean): asserts condition {
  if (!condition) throw new Error('Original CSI settled batch differs.');
}
function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function closed(value: unknown, fields: string[]): Record<string, unknown> {
  const result = object(value);
  ensure(isDeepStrictEqual(Object.keys(result).sort(), [...fields].sort()));
  return result;
}
function bytes(value: unknown): Buffer {
  ensure(typeof value === 'string' && value.length <= 87384);
  const decoded = Buffer.from(value, 'base64');
  ensure(
    decoded.length > 0 &&
      decoded.length <= 64 * 1024 &&
      decoded.toString('base64') === value,
  );
  return decoded;
}
function resource(value: unknown, encoded: unknown, kind: string): Buffer {
  const ref = assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    'original CSI batch resource',
  );
  const result = bytes(encoded);
  ensure(
    ref.kind === kind &&
      ref.schemaVersion === 1 &&
      ref.byteLength === result.length &&
      ref.digest === createHash('sha256').update(result).digest('hex'),
  );
  return result;
}

export function readCsiRecoveryResult(
  value: unknown,
): ManagedRuntimeInlineResult {
  const result = closed(value, [
    'executionStatus',
    'responseParts',
    ...(Object.hasOwn(object(value), 'error') ? ['error'] : []),
  ]);
  ensure(
    ['success', 'error'].includes(String(result['executionStatus'])) &&
      Array.isArray(result['responseParts']),
  );
  for (const candidate of result['responseParts']) {
    const part = object(candidate);
    if (Object.hasOwn(part, 'text')) {
      closed(part, ['text', ...(Object.hasOwn(part, 'type') ? ['type'] : [])]);
      ensure(
        typeof part['text'] === 'string' &&
          (!Object.hasOwn(part, 'type') || part['type'] === 'text'),
      );
    } else {
      const field = Object.hasOwn(part, 'inlineData')
        ? 'inlineData'
        : 'fileData';
      closed(part, [field]);
      const data = closed(part[field], [
        'mimeType',
        field === 'inlineData' ? 'data' : 'fileUri',
      ]);
      ensure(
        Object.values(data).every(
          (entry) =>
            typeof entry === 'string' &&
            entry.length > 0 &&
            entry.length <= 4096,
        ),
      );
    }
  }
  if (Object.hasOwn(result, 'error')) {
    const error = object(result['error']);
    closed(error, [
      'message',
      ...(Object.hasOwn(error, 'type') ? ['type'] : []),
    ]);
    ensure(
      Object.values(error).every(
        (entry) =>
          typeof entry === 'string' && entry.length > 0 && entry.length <= 4096,
      ),
    );
  }
  return result as unknown as ManagedRuntimeInlineResult;
}

export async function readHostedCsiRecoveryBatch(
  session: ManagedSession,
  broker: HostedWorkspaceBrokerOptions,
  promptId: string,
  items: HarnessToolItem[],
  parts: Part[],
  owner: CsiRecoveryOwner,
): Promise<Map<string, ManagedRuntimeInlineResult>> {
  const key = session.authority.sessionHeader.sessionKey;
  const batchId = items[0].modelMessageId;
  const { bindingId, generation, ...recoveryOwner } = owner;
  const response = await fetch(
    new URL(
      '/internal/runtime-broker/v1/executions:read-batch',
      resolveManagedRuntimeBrokerBaseUrl(broker.baseUrl),
    ),
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${broker.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: randomUUID(),
        harnessSessionId: key.sessionId,
        runtimeSessionId: key.sessionId,
        promptId,
        batchId,
        recoveryOwner,
      }),
    },
  );
  ensure(
    response.status === 200 &&
      response.headers.get('content-encoding') === null,
  );
  const reader = response.body?.getReader();
  ensure(reader !== undefined);
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
  const body = closed(
    parseManagedCsiFileJson(Buffer.concat(chunks), CSI_NATIVE_RESPONSE_LIMIT),
    [
      'protocolVersion',
      'harnessSessionId',
      'runtimeSessionId',
      'promptId',
      'batchId',
      'runtimeBindingId',
      'bindingGeneration',
      'members',
    ],
  );
  ensure(
    body['protocolVersion'] === 1 &&
      body['harnessSessionId'] === key.sessionId &&
      body['runtimeSessionId'] === key.sessionId &&
      body['promptId'] === promptId &&
      body['batchId'] === batchId &&
      body['runtimeBindingId'] === bindingId &&
      body['bindingGeneration'] === generation &&
      Array.isArray(body['members']) &&
      body['members'].length === items.length,
  );
  const events = session.authority.eventsInSequenceRange(
    1,
    session.authority.committedSequence,
  );
  const functions = parts.flatMap((part, partIndex) =>
    part.functionCall ? [{ call: part.functionCall, partIndex }] : [],
  );
  const definitions = hostedWorkspaceDeclarations(
    HOSTED_WORKSPACE_FILE_TOOLS,
    false,
  );
  const results = new Map<string, ManagedRuntimeInlineResult>();
  const calls = new Set<string>();
  let contexts: unknown;
  for (const [index, candidate] of body['members'].entries()) {
    const member = closed(candidate, [
      'executionCallId',
      'state',
      'reference',
      'inputBytesBase64',
      'toolDefinitionBytesBase64',
      'resultBytesBase64',
      'authorizationBytesBase64',
    ]);
    const item = items[index];
    const grant = readCsiNativeGrant(
      parseManagedCsiFileJson(
        bytes(member['authorizationBytesBase64']),
        64 * 1024,
      ),
    );
    const ref = object(grant['executionReference']);
    const original = functions[item.ordinal];
    ensure(
      member['state'] === 'settled' &&
        member['executionCallId'] === item.executionCallId &&
        !results.has(item.executionCallId) &&
        isDeepStrictEqual(member['reference'], ref) &&
        grant['executionCallId'] === item.executionCallId &&
        grant['runtimeBindingId'] === bindingId &&
        grant['bindingGeneration'] === generation &&
        ref['sessionId'] === key.sessionId &&
        ref['promptId'] === promptId &&
        ref['batchId'] === batchId &&
        ref['ordinal'] === item.ordinal &&
        ref['partIndex'] === item.partIndex &&
        ref['functionCallId'] === item.functionCallId &&
        ref['argsDigest'] === `sha256:${item.inputDigest}` &&
        typeof ref['callId'] === 'string' &&
        !calls.has(ref['callId']) &&
        original !== undefined &&
        original.partIndex === item.partIndex &&
        original.call.id === item.functionCallId &&
        original.call.name === item.toolName,
    );
    calls.add(ref['callId']);
    const input = closed(
      parseManagedCsiFileJson(
        resource(
          ref['inputRef'],
          member['inputBytesBase64'],
          'managed-tool-input',
        ),
        64 * 1024,
      ),
      ['harnessSessionId', 'runtimeSessionId', 'payloadJson'],
    );
    ensure(
      input['harnessSessionId'] === key.sessionId &&
        input['runtimeSessionId'] === key.sessionId &&
        typeof input['payloadJson'] === 'string',
    );
    const payload = closed(
      parseManagedCsiFileJson(Buffer.from(input['payloadJson']), 64 * 1024),
      ['toolName', 'input'],
    );
    ensure(
      payload['toolName'] === item.toolName &&
        `sha256:${createHash('sha256').update(input['payloadJson']).digest('hex')}` ===
          ref['argsDigest'] &&
        isDeepStrictEqual(
          payload['input'],
          acceptedCsiToolInput({
            callId: item.functionCallId,
            name: item.toolName,
            args: original.call.args ?? {},
            isClientInitiated: false,
            prompt_id: promptId,
          }),
        ),
    );
    const definition = parseManagedCsiFileJson(
      resource(
        ref['toolDefinitionRef'],
        member['toolDefinitionBytesBase64'],
        'managed-tool-definition',
      ),
      64 * 1024,
    );
    ensure(
      isDeepStrictEqual(
        definition,
        definitions.find((value) => value.name === item.toolName),
      ),
    );
    const intents = events.filter(
      (event) =>
        event.kind === 'tool.intent' &&
        event.payload['executionCallId'] === item.executionCallId,
    );
    const checkpoint = events.find(
      (event) =>
        event.sequence === grant['authorizationSequence'] &&
        event.kind === 'checkpoint.committed',
    );
    ensure(
      intents.length === 1 &&
        intents[0].sequence === object(grant['intent'])['sequence'] &&
        intents[0].payload['batchId'] === batchId &&
        intents[0].payload['ordinal'] === item.ordinal &&
        isDeepStrictEqual(intents[0].payload['argsRef'], ref['inputRef']) &&
        isDeepStrictEqual(
          intents[0].payload['toolDefinitionRef'],
          ref['toolDefinitionRef'],
        ) &&
        checkpoint !== undefined &&
        isDeepStrictEqual(
          checkpoint.payload['stateRef'],
          grant['checkpointRef'],
        ),
    );
    const identity = object(grant['identity']);
    const context = object(grant['context']);
    ensure(
      identity['sessionId'] === key.sessionId &&
        context['tenantId'] === key.tenantId &&
        context['workspaceId'] === key.workspaceId,
    );
    const joined = ['identity', 'context', 'installedContext'].map(
      (field) => grant[field],
    );
    ensure(contexts === undefined || isDeepStrictEqual(contexts, joined));
    contexts = joined;
    if (grant['preparedRef'] === null) {
      ensure(item.toolName === 'read_file');
    } else {
      const preparedRef = assertManagedSessionDurableRef(
        grant['preparedRef'] as ManagedSessionJsonValue,
        'original CSI prepared history',
      );
      ensure(
        events.some(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'file_history' &&
            isDeepStrictEqual(event.payload['recordRef'], preparedRef),
        ),
      );
      const preparation = object(
        object(
          parseManagedCsiFileJson(
            await session.resources.read(preparedRef),
            64 * 1024,
          ),
        )['preparation'],
      );
      ensure(
        preparation['stage'] === 'prepared' &&
          preparation['promptId'] === promptId &&
          preparation['batchId'] === batchId &&
          Array.isArray(preparation['invocations']) &&
          preparation['invocations'].length === items.length &&
          preparation['invocations'].some((candidate) => {
            const invocation = object(candidate);
            return (
              invocation['executionCallId'] === item.executionCallId &&
              invocation['callId'] === ref['callId'] &&
              invocation['functionCallId'] === item.functionCallId &&
              invocation['toolName'] === item.toolName &&
              invocation['ordinal'] === item.ordinal &&
              invocation['partIndex'] === item.partIndex &&
              invocation['requestDigest'] === ref['argsDigest'] &&
              isDeepStrictEqual(invocation['inputRef'], ref['inputRef']) &&
              isDeepStrictEqual(
                invocation['toolDefinitionRef'],
                ref['toolDefinitionRef'],
              )
            );
          }),
      );
    }
    const result = readCsiRecoveryResult(
      parseManagedCsiFileJson(bytes(member['resultBytesBase64']), 64 * 1024),
    );
    results.set(item.executionCallId, result);
  }
  return results;
}
