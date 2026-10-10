/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  hostedWorkspaceDeclarations,
  HOSTED_WORKSPACE_FILE_TOOLS,
} from '../hosted-workspace-tool-turn.js';
import {
  readCsiNativeRequest,
  readCsiNativeResponse,
} from '../managed-csi-native-readback.js';
import type {
  CsiFileHistoryObservation,
  CsiHistoryInvocation,
} from '../managed-csi-file-history-protocol.js';

const native = JSON.parse(
  readFileSync(
    new URL(
      '../contracts/managed-csi-native-readback-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

// Structural readback fixture only; no native SQL admission or CSI preimage I/O.
export function csiHistoryPreparationFixture() {
  const owner = native.boot.identity.sessionId;
  const promptId = randomUUID();
  const batchId = randomUUID();
  const observation: CsiFileHistoryObservation = {
    state: { ownerSessionId: owner, snapshots: [], files: {} },
    backupDirectory: {
      volumeDevice: '1',
      volumeInode: '2',
      directoryDevice: '1',
      directoryInode: '3',
    },
    retainedBackups: [],
  };
  const resources: Array<{
    reference: ManagedSessionDurableRef;
    bytesBase64: string;
  }> = [];
  function publish(kind: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    const reference = {
      resourceId: randomUUID(),
      kind,
      schemaVersion: 1,
      byteLength: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
    resources.push({ reference, bytesBase64: bytes.toString('base64') });
    return reference;
  }
  const declarations = hostedWorkspaceDeclarations(
    HOSTED_WORKSPACE_FILE_TOOLS,
    false,
  );
  const inputs = [
    { toolName: 'read_file', input: { file_path: 'read-only.txt' } },
    {
      toolName: 'write_file',
      input: { file_path: 'new.txt', content: 'new bytes' },
    },
    {
      toolName: 'edit',
      input: { file_path: 'existing.txt', old_string: 'a', new_string: 'b' },
    },
  ];
  const invocations: CsiHistoryInvocation[] = inputs.map((input, index) => {
    const payloadJson = JSON.stringify(input);
    return {
      executionCallId: `unit-execution-${index}`,
      callId: randomUUID(),
      functionCallId: `provider-${index}`,
      toolName: input.toolName,
      partIndex: index + 2,
      ordinal: index * 2,
      requestDigest:
        'sha256:' + createHash('sha256').update(payloadJson).digest('hex'),
      inputRef: publish('managed-tool-input', {
        harnessSessionId: owner,
        runtimeSessionId: owner,
        payloadJson,
      }),
      toolDefinitionRef: publish(
        'managed-tool-definition',
        declarations.find((declaration) => declaration.name === input.toolName),
      ),
    };
  });
  const preparation = {
    stage: 'intent' as const,
    turnId: promptId,
    promptId,
    batchId,
    invocations,
    paths: ['existing.txt', 'new.txt'],
  };
  const body = {
    operationId: `csi-file-history:intent:${batchId}`,
    revision: 2,
    previousRecordRef: null,
    schemaVersion: 2,
    profile: 'csi-files-retirement/1',
    runtimeSessionId: owner,
    ...observation,
    preparation,
    record: {},
  };
  const intentRef = publish('managed-file_history', body);
  const request = readCsiNativeRequest({
    ...native.valid[0].request,
    action: 'prepare',
    subject: intentRef,
  });
  const response = readCsiNativeResponse(
    {
      ...native.valid[0].response,
      action: 'prepare',
      evidence: {
        kind: 'intent',
        intentRef,
        resources,
        members: invocations.map((invocation) => ({
          sessionId: owner,
          promptId,
          batchId,
          callId: invocation.callId,
          functionCallId: invocation.functionCallId,
          partIndex: invocation.partIndex,
          ordinal: invocation.ordinal,
          argsDigest: invocation.requestDigest,
          inputRef: invocation.inputRef,
          toolDefinitionRef: invocation.toolDefinitionRef,
          dispatchMode: 'deferred',
        })),
      },
    },
    request,
  );
  return { request, response, intentRef, preparation, observation };
}
