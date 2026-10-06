/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Part } from '@google/genai';
import { openManagedSession } from '../managed-session-assembly.js';
import { LocalManagedSessionAuthority } from '../managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '../managed-session-resources.js';
import { createManagedHarnessHandle } from '../managed-harness-factory.js';
import { resetManagedRuntimeDispatchGatesForTest } from '../managed-runtime-dispatch-gate.js';
import { convertManagedRuntimeToolResult } from '../managed-runtime-tool-response.js';
import { csiSessionSnapshot } from './csi-session-snapshot.js';
const cleanup: Array<() => Promise<void>> = [];
export async function closeCsiFileFixtures() {
  resetManagedRuntimeDispatchGatesForTest();
  for (const close of cleanup.splice(0).reverse()) await close();
}

export async function csiFileSession(
  toolName = 'read_file',
  status: 'success' | 'error' | 'cancelled' = 'success',
  damage?:
    | 'assistant-name'
    | 'assistant-args'
    | 'normalized-path'
    | 'unsupported-inline'
    | 'definition-name'
    | 'pending-history'
    | 'unsupported-history'
    | 'omitted-result',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-file-proof-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const key = { tenantId: 't', workspaceId: 'w', sessionId: randomUUID() };
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(
    runtimeBaseDir,
    'chats',
    `${key.sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey: key,
  });
  const definitionRef = await resources.publish(
    'managed-definition',
    Buffer.from('{}'),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-root',
    Buffer.from('{}'),
  );
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir,
    sessionId: key.sessionId,
    transcriptPath,
  });
  cleanup.push(() => lease.release());
  const session = await openManagedSession({
    runtimeBaseDir,
    transcriptPath,
    sessionId: key.sessionId,
    sessionKey: key,
    cwd: root,
    version: 'test',
    workerId: 'owner',
    activationLeaseDurationMs: 300000,
    lease,
    resourceStore: resources,
    create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
  });
  cleanup.push(async () => {
    await session.close();
    await session.authority.close();
  });
  const harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  const initialSnapshot = {
    ...(await csiSessionSnapshot(session, resources, transcriptPath)),
    originalCSI: {
      bindingId: 'java-binding',
      runtimeGeneration: '19',
      sealedBindingVersion: 4,
    },
  };
  const promptId = randomUUID();
  const modelMessageId = randomUUID();
  let parentUuid: string | null = null;
  const commitMessage = async (
    type: 'assistant' | 'tool_result',
    parts: Part[],
    uuid = randomUUID(),
  ) => {
    await session.sink.write({
      uuid,
      parentUuid,
      sessionId: key.sessionId,
      timestamp: new Date().toISOString(),
      type,
      cwd: root,
      version: 'test',
      daemonPromptId: promptId,
      model: 'fixture',
      message: { role: type === 'assistant' ? 'model' : 'user', parts },
    });
    parentUuid = uuid;
  };
  const input = {
    file_path: 'file.txt',
    ...(toolName === 'write_file' ? { content: 'original content' } : {}),
    ...(toolName === 'edit' ? { old_string: 'old', new_string: 'new' } : {}),
  };
  await commitMessage(
    'assistant',
    [
      {
        functionCall: {
          id: 'model-call',
          name: damage === 'assistant-name' ? 'run_shell_command' : toolName,
          args: {
            ...input,
            ...(damage === 'normalized-path'
              ? { file_path: ' ./file.txt  ' }
              : {}),
            ...(damage === 'assistant-args'
              ? toolName === 'edit'
                ? { new_string: 'other' }
                : { content: 'other' }
              : {}),
          },
        },
      },
    ],
    modelMessageId,
  );
  const payloadJson = JSON.stringify({
    toolName,
    input,
  });
  const requestDigest = `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`;
  const argsRef = await resources.publish(
    'managed-tool-input',
    Buffer.from(
      JSON.stringify({
        harnessSessionId: key.sessionId,
        runtimeSessionId: 'runtime-session',
        payloadJson,
      }),
    ),
  );
  const toolDefinitionRef = await resources.publish(
    'managed-tool-definition',
    Buffer.from(
      JSON.stringify({
        name: damage === 'definition-name' ? 'run_shell_command' : toolName,
      }),
    ),
  );
  await session.authority.appendExecutionEvent(
    {
      operation: 'toolIntent',
      commandId: 'tool-intent:execution',
      sessionKey: key,
      contentDigest: argsRef.digest,
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: 'tool-intent:execution',
      sessionKey: key,
      kind: 'tool.intent',
      occurredAt: Date.now(),
      subject: {
        type: 'activation',
        scopeId: session.activation.activationId,
        ...session.activation,
      },
      payload: {
        executionCallId: 'execution',
        batchId: modelMessageId,
        ordinal: 0,
        toolDefinitionRef,
        argsRef,
        outcomeSource: 'runtime',
      },
    }),
    { class: 'harness', activation: session.activation },
  );
  await harness.commitAwaitRuntimeBatch(
    [
      {
        functionCallId: 'model-call',
        toolName,
        executionCallId: 'execution',
        invocationBindingId: 'execution',
        capabilityVersion: 'cap',
        policyVersion: 'policy',
        mediaVersion: null,
        modelMessageId,
        partIndex: 0,
        ordinal: 0,
        inputDigest: requestDigest.slice(7),
        progressCursor: null,
        attemptId: modelMessageId,
        routeRef: argsRef,
      },
    ],
    { turnId: promptId, promptId },
  );
  const result = {
    executionStatus: status,
    responseParts:
      damage === 'unsupported-inline'
        ? [
            {
              inlineData: {
                data: 'Zg==',
                mimeType: 'text/plain',
                outputOmitted: true,
              },
            },
          ]
        : [
            {
              text: 'full result',
              ...(damage === 'omitted-result' ? { outputOmitted: true } : {}),
            },
          ],
  };
  const converted = convertManagedRuntimeToolResult(
    toolName,
    'model-call',
    result,
    undefined,
  );
  const outcomeRef = await resources.publish(
    'managed-tool-outcome',
    Buffer.from(
      JSON.stringify({ executionCallId: 'execution', ...converted[0] }),
    ),
  );
  await commitMessage('tool_result', converted);
  await harness.resolveAwaitRuntime('execution', outcomeRef);
  if (toolName !== 'read_file') {
    const state = {
      ownerSessionId: key.sessionId,
      snapshots: [
        {
          promptId,
          timestamp: new Date().toISOString(),
          trackedFileBackups: {
            'file.txt': {
              backupFileName: null,
              version: 0,
              backupTime: new Date().toISOString(),
            },
          },
        },
      ],
      files: {
        'file.txt': { digest: `sha256:${'a'.repeat(64)}`, mode: 0o644 },
      },
    };
    await session.authority.commitDomainRecord(
      {
        operation: 'commitFileHistory',
        commandId: 'history',
        sessionKey: key,
        contentDigest: argsRef.digest,
      },
      {
        domain: 'file_history',
        content: {
          schemaVersion: 1,
          state,
          pendingTurn: null,
          pendingUndo:
            damage === 'pending-history' ? { operationId: 'pending' } : null,
          undoReceipts: [],
          ...(damage === 'unsupported-history'
            ? { pendingOtherEffect: true }
            : {}),
        },
      },
      { class: 'trusted_entry' },
    );
  }
  const originalExecution = {
    executionCallId: 'execution',
    bindingId: 'java-binding',
    runtimeGeneration: '19',
    harnessSessionId: key.sessionId,
    runtimeSessionId: 'runtime-session',
    turnId: promptId,
    toolCallId: 'runtime-call',
    requestDigest,
    reference: {
      sessionId: 'runtime-session',
      promptId,
      callId: 'runtime-call',
      argsDigest: requestDigest,
      dispatchMode: 'deferred',
    },
    state: 'SETTLED',
    executionStatus: status,
    result,
    dispatchGeneration: '1',
    authorizedDispatchGeneration: '1',
    authorizedBindingVersion: '3',
  };
  return {
    session,
    harness,
    resources,
    originalExecution,
    initialSnapshot,
    outcomeRef,
    promptId,
    snapshot: async () => ({
      ...(await csiSessionSnapshot(session, resources, transcriptPath)),
      originalCSI: {
        bindingId: 'java-binding',
        runtimeGeneration: '19',
        sealedBindingVersion: 4,
      },
      originalExecution: structuredClone(originalExecution),
    }),
  };
}

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export async function csiFileInventory(empty = false) {
  const f = await csiFileSession('write_file');
  await f.harness.consumeRuntimeResults();
  const snapshot = empty ? f.initialSnapshot : await f.snapshot();
  const scope = {
    tenantId: 't',
    workspaceId: 'w',
    workspaceGeneration: '1',
    canonicalCwd: '/workspace',
    capabilityDigest: 'cap',
    isolationClass: 'session',
  };
  const id = snapshot.sessionKey.sessionId;
  const resourceScope = hash(`t\0${id}`);
  return {
    format: 'qwen-csi-retirement-inventory/1',
    originalCSI: snapshot.originalCSI,
    scope,
    isolationKey: id,
    runtimeSessions: [
      {
        ...scope,
        runtimeSessionId: 'runtime-session',
        harnessSessionId: id,
        bindingId: 'java-binding',
        runtimeGeneration: '19',
        sessionState: 'READY',
      },
    ],
    executions: empty ? [] : [f.originalExecution],
    publications: [] as Array<Record<string, unknown>>,
    workerAcks: [] as Array<Record<string, unknown>>,
    sessionSnapshots: [snapshot],
    sessionResourceInventory: snapshot.resources.map(({ ref }) => ({
      ...snapshot.sessionKey,
      sessionScopeKey: resourceScope,
      resourceId: ref.resourceId,
      kind: ref.kind,
      schemaVersion: String(ref.schemaVersion),
      byteLength: String(ref.byteLength),
      sha256: ref.digest,
      storageKind: 'MYSQL_INLINE',
      state: 'REFERENCED',
      externalObject: false,
    })),
    sessionResourceReferences: snapshot.resources.flatMap(
      ({ ref, referencedRevisions }) =>
        referencedRevisions.map((revision) => ({
          ...snapshot.sessionKey,
          sessionScopeKey: resourceScope,
          resourceId: ref.resourceId,
          journalRevision: String(revision),
        })),
    ),
    publicationOperations: [] as Array<Record<string, unknown>>,
    publicationObjects: [] as Array<Record<string, unknown>>,
    publicationSeals: [] as Array<Record<string, unknown>>,
  };
}
