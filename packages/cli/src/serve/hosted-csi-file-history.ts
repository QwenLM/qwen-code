/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
import { readCsiNativeRequest } from './managed-csi-native-readback.js';
import { parseManagedCsiFileJson } from './managed-csi-file-envelope.js';
import {
  csiHistoryContentDigest,
  readCsiFileHistoryObservation,
  type CsiFileHistoryObservation,
  type CsiFileHistoryOperation,
  type CsiHistoryPreparation,
} from './managed-csi-file-history-protocol.js';

export async function bindHostedCsiHistory(
  broker: HostedWorkspaceBrokerOptions,
  key: ManagedSessionKey,
) {
  return requestHostedCsiHistory(broker, key, {
    kind: 'csi-file-history',
    version: 1,
    action: 'bind',
  });
}

export async function requestHostedCsiHistory(
  broker: HostedWorkspaceBrokerOptions,
  key: ManagedSessionKey,
  operation: CsiFileHistoryOperation,
) {
  const response = await fetch(
    new URL(
      `/internal/runtime-broker/v1/tool-sessions/${encodeURIComponent(key.sessionId)}/control`,
      resolveManagedRuntimeBrokerBaseUrl(broker.baseUrl),
    ),
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${broker.token}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: randomUUID(),
        harnessSessionId: key.sessionId,
        operation,
      }),
    },
  );
  if (
    response.status !== 200 ||
    response.headers.get('content-encoding') !== null ||
    response.headers.get('cache-control') !== 'no-store' ||
    response.headers.get('content-type')?.split(';')[0].trim() !==
      'application/json'
  )
    throw new Error('Original CSI history bind failed.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing CSI history response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 65 * 1024)
        throw new Error('CSI history response is too large.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const body = closed(
    parseManagedCsiFileJson(Buffer.concat(chunks), 65 * 1024),
    ['protocolVersion', 'harnessSessionId', 'runtimeSessionId', 'result'],
  );
  if (
    body['protocolVersion'] !== 1 ||
    body['harnessSessionId'] !== key.sessionId ||
    body['runtimeSessionId'] !== key.sessionId
  )
    throw new Error('CSI history owner differs.');
  const result = closed(body['result'], [
    'protocolVersion',
    'managedCsi',
    'identity',
    'context',
    'installedContext',
    'operation',
    'observation',
  ]);
  if (
    result['protocolVersion'] !== 2 ||
    result['managedCsi'] !== 'managed-csi/2' ||
    !isDeepStrictEqual(result['operation'], operation)
  )
    throw new Error('CSI history response differs.');
  const original = readCsiNativeRequest({
    protocolVersion: 1,
    requestId: randomUUID(),
    action: 'bind',
    identity: result['identity'],
    context: result['context'],
    installedContext: result['installedContext'],
    subject: null,
  });
  if (
    original.identity['sessionId'] !== key.sessionId ||
    original.context['tenantId'] !== key.tenantId ||
    original.context['workspaceId'] !== key.workspaceId
  )
    throw new Error('CSI history scope differs.');
  return readCsiFileHistoryObservation(result['observation'], key.sessionId);
}

function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw new Error('Invalid CSI history response.');
  return value as Record<string, unknown>;
}

export async function commitInitialHostedCsiHistory(
  session: ManagedSession,
  observation: CsiFileHistoryObservation,
) {
  const authority = session.authority;
  const sessionKey = authority.sessionHeader.sessionKey;
  const owner = sessionKey.sessionId;
  const original = readCsiFileHistoryObservation(observation, owner);
  if (
    original.state.snapshots.length ||
    Object.keys(original.state.files).length ||
    original.retainedBackups.length
  )
    throw new Error('Initial CSI history must be empty.');
  return commitHostedCsiHistory(
    session,
    original,
    null,
    null,
    `csi-file-history:bind:${owner}`,
  );
}

export async function commitHostedCsiHistory(
  session: ManagedSession,
  observation: CsiFileHistoryObservation,
  preparation: CsiHistoryPreparation | null,
  parentUuid: string | null,
  commandId: string,
) {
  const authority = session.authority;
  const sessionKey = authority.sessionHeader.sessionKey;
  const owner = sessionKey.sessionId;
  const original = readCsiFileHistoryObservation(observation, owner);
  const content = {
    schemaVersion: 2,
    profile: 'csi-files-retirement/1',
    runtimeSessionId: owner,
    ...original,
    preparation,
    record: {
      uuid: randomUUID(),
      parentUuid,
      sessionId: owner,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'file_history_snapshot',
      ...authority.recordEnvelope,
      systemPayload: { snapshots: original.state.snapshots },
    },
  };
  return authority.commitDomainRecord(
    {
      operation: 'commitFileHistory',
      commandId,
      sessionKey,
      contentDigest: csiHistoryContentDigest(content),
    },
    { domain: 'file_history', content },
    { class: 'trusted_entry' },
  );
}
