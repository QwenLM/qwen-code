/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { parseHarnessCheckpointV1 } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostedCsiToolTurn } from './hosted-csi-tool-turn.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';
import * as history from './hosted-csi-file-history.js';
import type { CsiFileHistoryObservation } from './managed-csi-file-history-protocol.js';
import { recoverHostedCsiReceipts } from './hosted-csi-cold-recovery.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  computeManagedContextDigest,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';

let root: string;
let managed: ManagedSession;
let sessionId: string;
let promptId: string;
let batchId: string;
let bindingId: string;
let turn: HostedCsiToolTurn;
const commit = vi.fn();
let requests: Array<Record<string, unknown>>;
let members: Array<Record<string, unknown>>;
let paths: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qwen-csi-reservation-unit-'));
  sessionId = randomUUID();
  promptId = randomUUID();
  batchId = randomUUID();
  bindingId = randomUUID();
  const sessionKey = {
    tenantId: 'unit-tenant',
    workspaceId: 'unit-workspace',
    sessionId,
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const definitionRef = await resources.publish(
    'managed-definition',
    Buffer.from(
      JSON.stringify({
        engine: 'managed',
        sessionId,
        toolProfile: 'csi-files-retirement/1',
      }),
    ),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-root',
    Buffer.from(JSON.stringify({ cwd: root })),
  );
  managed = await openManagedSession({
    runtimeBaseDir: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId,
    sessionKey,
    cwd: root,
    version: 'hosted-harness/1',
    workerId: randomUUID(),
    activationLeaseDurationMs: 60000,
    create: { definitionRef, rootSnapshotRef, createdBy: 'hosted-harness' },
  });
  const harness = createManagedHarnessHandle(managed);
  await harness.ensureRunnable();
  commit.mockReset().mockResolvedValue(batchId);
  turn = new HostedCsiToolTurn(
    managed,
    { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
    { bindingId, generation: '1' },
    promptId,
    commit,
    harness,
    () => true,
  );
  await turn.declarations(new AbortController().signal);
  requests = [];
  members = [];
  paths = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const route = new URL(String(url)).pathname;
    paths.push(route);
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(body['harnessSessionId']).toBe(sessionId);
    expect(body['runtimeSessionId']).toBe(sessionId);
    if (route.endsWith(':start')) {
      const id = route.split('/').at(-1)!.slice(0, -6);
      const member = members.find((item) => item['executionCallId'] === id)!;
      const wrapper = JSON.parse(
        Buffer.from(String(member['inputBytesBase64']), 'base64').toString(),
      );
      expect(body['payloadJson']).toBe(wrapper.payloadJson);
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          harnessSessionId: sessionId,
          runtimeSessionId: sessionId,
          executionCallId: id,
          status: {
            state: 'settled',
            result: {
              executionStatus: 'success',
              responseParts: [{ text: `owned result ${id}` }],
            },
          },
        }),
      );
    }
    if (route.endsWith('/executions:prepare')) {
      requests.push(body);
      members.push({
        executionCallId: `unit-execution-${requests.length}`,
        state: 'prepared',
        reference: {
          ...(body['reference'] as object),
          dispatchMode: 'deferred',
        },
        inputBytesBase64: body['inputBytesBase64'],
        toolDefinitionBytesBase64: body['toolDefinitionBytesBase64'],
      });
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          harnessSessionId: sessionId,
          runtimeSessionId: sessionId,
          executionCallId: `unit-execution-${requests.length}`,
          status: { state: 'prepared' },
        }),
      );
    }
    expect(route.endsWith('/executions:read-batch')).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      [
        'protocolVersion',
        'requestId',
        'harnessSessionId',
        'runtimeSessionId',
        'promptId',
        'batchId',
      ].sort(),
    );
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        harnessSessionId: sessionId,
        runtimeSessionId: sessionId,
        promptId,
        batchId,
        runtimeBindingId: bindingId,
        bindingGeneration: '1',
        members,
      }),
    );
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await managed?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

function batch() {
  const calls: ToolCallRequestInfo[] = [
    {
      callId: 'provider-read',
      name: 'read_file',
      args: { file_path: '\ufeff ./dir//file.txt \u00a0', offset: 0 },
      isClientInitiated: false,
      prompt_id: promptId,
    },
    {
      callId: 'provider-write',
      name: 'write_file',
      args: { file_path: 'output.txt', content: '' },
      isClientInitiated: false,
      prompt_id: promptId,
    },
    {
      callId: 'provider-edit',
      name: 'edit',
      args: {
        file_path: 'dir/file.txt',
        old_string: '',
        new_string: '😀',
        replace_all: false,
      },
      isClientInitiated: false,
      prompt_id: promptId,
    },
  ];
  const parts: Part[] = [
    { text: 'original thought', thought: true },
    { text: 'original visible text' },
    ...calls.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
  ];
  return { calls, parts };
}

it('fixes full Parts, original IDs, exact input bytes and final definitions before reservation', async () => {
  const { calls, parts } = batch();
  const declarations = await turn.declarations(new AbortController().signal);
  for (const declaration of declarations) {
    if (declaration.name !== 'write_file') {
      const schema = declaration.parametersJsonSchema as Record<
        string,
        unknown
      >;
      delete schema['additionalProperties'];
    }
  }
  let publications = 0;
  const publish = managed.resources.publish.bind(managed.resources);
  vi.spyOn(managed.resources, 'publish').mockImplementation(async (...args) => {
    publications++;
    return publish(...args);
  });
  const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, 'fetch').mockImplementation((...args) => {
    expect(publications).toBe(6);
    return fetch(...args);
  });
  await expect(
    turn.execute(calls, parts, 'unit-model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(commit).toHaveBeenCalledExactlyOnceWith(
    'assistant',
    parts,
    'unit-model',
  );
  expect(requests).toHaveLength(3);
  const pinned = JSON.parse(
    await readFile(
      new URL(
        '../../../sdk-java/runtime-broker/src/main/resources/csi-native-file-declarations.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const [ordinal, request] of requests.entries()) {
    const reference = request['reference'] as Record<string, unknown>;
    expect(reference).toMatchObject({
      sessionId,
      promptId,
      batchId,
      functionCallId: calls[ordinal].callId,
      ordinal,
      partIndex: ordinal + 2,
    });
    expect(reference['callId']).not.toBe(calls[ordinal].callId);
    const bytes = Buffer.from(String(request['inputBytesBase64']), 'base64');
    const wrapper = JSON.parse(bytes.toString());
    expect(wrapper.harnessSessionId).toBe(sessionId);
    expect(wrapper.runtimeSessionId).toBe(sessionId);
    const payload = JSON.parse(wrapper.payloadJson);
    expect(payload.input.file_path).toBe(
      ordinal === 1 ? 'output.txt' : 'dir/file.txt',
    );
    expect(request['requestDigest']).toBe(
      `sha256:${createHash('sha256').update(wrapper.payloadJson).digest('hex')}`,
    );
    expect(reference['inputRef']).toMatchObject({
      byteLength: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(
      JSON.parse(
        Buffer.from(
          String(request['toolDefinitionBytesBase64']),
          'base64',
        ).toString(),
      ),
    ).toEqual(pinned[ordinal]);
  }
  expect(
    paths.filter((route) => route.endsWith('/executions:read-batch')),
  ).toHaveLength(1);
  expect(await turn.declarations(new AbortController().signal)).toEqual(pinned);
});

it('retains ordinal and Part gaps for invalid input without fabricating a response', async () => {
  const { calls, parts } = batch();
  calls[1].args = { file_path: '../outside', content: 'blocked' };
  parts[3].functionCall!.args = calls[1].args;
  await expect(
    turn.execute(calls, parts, 'unit-model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(
    requests.map(
      (request) => (request['reference'] as Record<string, unknown>)['ordinal'],
    ),
  ).toEqual([0, 2]);
  expect(
    requests.map(
      (request) =>
        (request['reference'] as Record<string, unknown>)['partIndex'],
    ),
  ).toEqual([2, 4]);
  expect(commit).toHaveBeenCalledTimes(1);
});

it('reads complete current membership after a lost answer and never remints or settles', async () => {
  const { calls, parts } = batch();
  const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await fetch(...args);
    if (String(args[0]).endsWith('/executions:prepare'))
      throw new TypeError('owned lost response');
    return response;
  });
  await expect(
    turn.execute(calls, parts, 'unit-model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(requests).toHaveLength(1);
  expect(members).toHaveLength(1);
  expect(paths).toEqual([
    '/internal/runtime-broker/v1/executions:prepare',
    '/internal/runtime-broker/v1/executions:read-batch',
  ]);
  expect(commit).toHaveBeenCalledTimes(1);
});

it('refuses a changed complete-read identity while preserving the original assistant', async () => {
  const { calls, parts } = batch();
  const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await fetch(...args);
    if (String(args[0]).endsWith('/executions:read-batch')) {
      const body = await response.json();
      body.members[0].reference.functionCallId = 'foreign-call';
      return new Response(JSON.stringify(body));
    }
    return response;
  });
  await expect(
    turn.execute(calls, parts, 'unit-model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(requests).toHaveLength(3);
  expect(commit).toHaveBeenCalledTimes(1);
});

it('closes prepared history after the complete mixed batch and before returning model results with labelled broker/worker seams', async () => {
  // Original local authority; the assistant callback, broker rows and worker observation are explicit seams.
  const initial: CsiFileHistoryObservation = {
    state: { ownerSessionId: sessionId, snapshots: [], files: {} },
    backupDirectory: {
      volumeDevice: '1',
      volumeInode: '2',
      directoryDevice: '1',
      directoryInode: '3',
    },
    retainedBackups: [],
  };
  const first = await history.commitInitialHostedCsiHistory(managed, initial);
  expect(first.revision).toBe(1);
  expect(first.receipt.replayed).toBe(false);
  let preparedObservation: CsiFileHistoryObservation | undefined;
  const control = vi
    .spyOn(history, 'requestHostedCsiHistory')
    .mockImplementation(async (_broker, _key, operation) => {
      if (operation.action === 'snapshot')
        return preparedObservation ?? initial;
      expect(operation.action).toBe('prepare');
      if (operation.action !== 'prepare')
        throw new Error('Unexpected operation');
      const original = JSON.parse(
        (await managed.resources.read(operation.preparationRef)).toString(),
      );
      expect(original.revision).toBe(2);
      expect(original.previousRecordRef).toEqual(first.recordRef);
      expect(original.preparation.stage).toBe('intent');
      expect(
        original.preparation.invocations.map(
          (item: { toolName: string }) => item.toolName,
        ),
      ).toEqual(['read_file', 'write_file', 'edit']);
      expect(original.preparation.paths).toEqual([
        'dir/file.txt',
        'output.txt',
      ]);
      expect(original.record.parentUuid).toBe(batchId);
      const timestamp = new Date().toISOString();
      preparedObservation = {
        ...initial,
        state: {
          ...initial.state,
          files: { 'dir/file.txt': null, 'output.txt': null },
          snapshots: [
            {
              promptId,
              timestamp,
              trackedFileBackups: {
                'dir/file.txt': {
                  backupFileName: null,
                  version: 1,
                  backupTime: timestamp,
                },
                'output.txt': {
                  backupFileName: null,
                  version: 1,
                  backupTime: timestamp,
                },
              },
            },
          ],
        },
      };
      return preparedObservation;
    });
  const { calls, parts } = batch();
  const responses = await turn.execute(
    calls,
    parts,
    'unit-model',
    new AbortController().signal,
  );
  expect(responses).toHaveLength(3);
  expect(control).toHaveBeenCalledTimes(3);
  const latest = managed.authority.domainRecord('file_history')!;
  expect(latest.revision).toBe(4);
  const resultHistory = JSON.parse(
    (await managed.resources.read(latest.recordRef)).toString(),
  );
  expect(resultHistory.preparation).toBeNull();
  expect(resultHistory.operationId).toBe(`csi-file-history:result:${batchId}`);
  expect(resultHistory.record.parentUuid).toBe(
    commit.mock.calls.at(-1)![3].uuid,
  );
  const prepared = JSON.parse(
    (await managed.resources.read(resultHistory.previousRecordRef)).toString(),
  );
  expect(prepared.preparation.stage).toBe('prepared');
  expect(prepared.preparation.intentRef).toEqual(prepared.previousRecordRef);
  expect(prepared.preparation.invocations).toHaveLength(3);
  expect(prepared.record.parentUuid).toBe(batchId);
  const replay = await history.commitHostedCsiHistory(
    managed,
    {
      state: prepared.state,
      backupDirectory: prepared.backupDirectory,
      retainedBackups: prepared.retainedBackups,
    },
    prepared.preparation,
    batchId,
    `csi-file-history:prepared:${batchId}`,
  );
  expect(replay.revision).toBe(3);
  expect(replay.recordRef).toEqual(resultHistory.previousRecordRef);
  expect(replay.receipt.replayed).toBe(true);
  expect(
    paths.some((path) => path.includes('start') || path.includes('execute')),
  ).toBe(true);
  expect(
    parseHarnessCheckpointV1((await managed.authority.readCheckpointState())!)
      .continuation.phase,
  ).toBe('results_ready');
});

it('records complete broker results and tool history before explicit Harness consumption with a labelled broker seam', async () => {
  const { calls } = batch();
  const second = {
    ...calls[0],
    callId: 'second-read',
    args: { file_path: 'other.txt' },
  };
  const refused = {
    ...calls[0],
    callId: 'refused-read',
    args: { file_path: '../outside.txt' },
  };
  const readCalls = [calls[0], refused, second];
  const parts: Part[] = readCalls.map((call) => ({
    functionCall: { id: call.callId, name: call.name, args: call.args },
  }));
  const responses = await turn.execute(
    readCalls,
    parts,
    'unit-model',
    new AbortController().signal,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    calls[0].callId,
    second.callId,
  ]);
  const checkpoint = parseHarnessCheckpointV1(
    (await managed.authority.readCheckpointState())!,
  );
  expect(checkpoint.continuation).toEqual({
    phase: 'results_ready',
    pendingEventIds: [],
  });
  expect(checkpoint.identity).toMatchObject({ turnId: promptId, promptId });
  expect(checkpoint.tools?.batchId).toBe('batch-provider-read');
  expect(checkpoint.tools?.items.map((item) => item.executionCallId)).toEqual([
    'unit-execution-1',
    'unit-execution-2',
  ]);
  expect(checkpoint.attempt).toMatchObject({
    attemptId: batchId,
    routeRef:
      members[0]['reference'] &&
      (members[0]['reference'] as Record<string, unknown>)['inputRef'],
  });
  expect(checkpoint.resume.fileHistoryRef).toBeNull();
  for (const [index, item] of checkpoint.tools!.items.entries()) {
    expect(item).toMatchObject({
      ordinal: index === 0 ? 0 : 2,
      modelMessageId: batchId,
      partIndex: index === 0 ? 0 : 2,
      state: 'settled',
      consumed: false,
      inputDigest: (requests[index]['requestDigest'] as string).slice(7),
    });
    const outcome = JSON.parse(
      (await managed.resources.read(item.outcomeRef!)).toString(),
    );
    expect(outcome).toMatchObject({
      schemaVersion: 1,
      executionCallId: `unit-execution-${index + 1}`,
      envelope: {
        executionStatus: 'success',
        responseParts: [{ text: `owned result unit-execution-${index + 1}` }],
      },
      history: { model: 'unit-model', parts: [responses[index]] },
    });
    expect(commit).toHaveBeenNthCalledWith(
      index + 2,
      'tool_result',
      [responses[index]],
      'unit-model',
      { uuid: outcome.history.messageId, timestamp: outcome.history.timestamp },
    );
  }
  expect(checkpoint.runtime?.bindings).toHaveLength(2);
  expect(paths.filter((route) => route.endsWith(':start'))).toHaveLength(2);
  expect(paths.some((route) => /acknowledge|release/.test(route))).toBe(false);
  await turn.consumeResults();
  expect(
    parseHarnessCheckpointV1(
      (await managed.authority.readCheckpointState())!,
    ).tools?.items.every((item) => item.consumed),
  ).toBe(true);
  await turn.finish();
  expect(
    parseHarnessCheckpointV1((await managed.authority.readCheckpointState())!)
      .continuation.phase,
  ).toBe('turn_settled');
});

it('repairs a durable receipt before the model gate without new execution or message identity', async () => {
  // Local native journal and mocked Broker results exercise repair only, not SQL takeover or model acceptance.
  const initial: CsiFileHistoryObservation = {
    state: { ownerSessionId: sessionId, snapshots: [], files: {} },
    backupDirectory: {
      volumeDevice: '1',
      volumeInode: '2',
      directoryDevice: '1',
      directoryInode: '3',
    },
    retainedBackups: [],
  };
  await history.commitInitialHostedCsiHistory(managed, initial);
  const text = 'Original exact prompt';
  const contentRef = await managed.resources.publish(
    'managed-input',
    Buffer.from(JSON.stringify([{ type: 'text', text }])),
  );
  const admissionRef = await managed.resources.publish(
    'managed-admission',
    Buffer.from('{}'),
  );
  await managed.authority.submitInput(
    {
      operation: 'submitInput',
      commandId: promptId,
      sessionKey: managed.authority.sessionHeader.sessionKey,
      contentDigest: contentRef.digest,
    },
    {
      inputId: promptId,
      turnId: promptId,
      source: 'hosted-harness',
      contentRef,
      admissionRef,
      deadline: null,
      wakeReason: 'input',
    },
  );
  let parentUuid: string | null = null;
  let results = 0;
  commit.mockImplementation(
    async (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
      identity?: { uuid: string; timestamp: string },
    ) => {
      if (type === 'tool_result' && ++results === 2)
        throw new Error('Original receipt answer lost');
      const record: ChatRecord = {
        ...managed.authority.recordEnvelope,
        sessionId,
        parentUuid,
        uuid: type === 'assistant' ? batchId : identity!.uuid,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        daemonPromptId: promptId,
        model,
        message: { role: type === 'assistant' ? 'model' : 'user', parts },
      };
      await managed.sink.write(record);
      parentUuid = record.uuid;
      return record.uuid;
    },
  );
  const { calls } = batch();
  const reads = [
    calls[0],
    { ...calls[0], callId: 'refused', args: { file_path: '../outside' } },
    { ...calls[0], callId: 'second', args: { file_path: 'other.txt' } },
  ];
  const parts: Part[] = reads.map((call) => ({
    functionCall: { id: call.callId, name: call.name, args: call.args },
  }));
  await expect(
    turn.execute(reads, parts, 'unit-model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(
    parseHarnessCheckpointV1((await managed.authority.readCheckpointState())!)
      .continuation.phase,
  ).toBe('await_runtime');
  const activation = await managed.authority.installActivation({
    activationId: randomUUID(),
    workerId: randomUUID(),
    leaseDurationMs: 60000,
  });
  const successor = {
    ...managed,
    activation,
    sink: new ManagedSessionRecordSink(
      managed.authority,
      managed.resources,
      () => ({ class: 'harness', activation }),
    ),
  };
  const broker = { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' };
  const sequence = managed.authority.committedSequence;
  const originalRequests = paths.slice();
  await expect(
    recoverHostedCsiReceipts(successor, broker, promptId, 'Changed prompt'),
  ).rejects.toThrow('prompt bytes differ');
  expect(managed.authority.committedSequence).toBe(sequence);
  const responses = await recoverHostedCsiReceipts(
    successor,
    broker,
    promptId,
    text,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    reads[0].callId,
    reads[2].callId,
  ]);
  const checkpoint = parseHarnessCheckpointV1(
    (await managed.authority.readCheckpointState())!,
  );
  expect(checkpoint.continuation.phase).toBe('results_ready');
  expect(
    checkpoint.tools?.items.every(
      (item) => item.state === 'settled' && !item.consumed,
    ),
  ).toBe(true);
  expect(checkpoint.identity.activationId).not.toBe(activation.activationId);
  const repaired = await successor.sink.project();
  expect(
    repaired.filter((record) => record.type === 'tool_result'),
  ).toHaveLength(2);
  const after = managed.authority.committedSequence;
  expect(
    await recoverHostedCsiReceipts(successor, broker, promptId, text),
  ).toEqual(responses);
  expect(managed.authority.committedSequence).toBe(after);
  expect(await successor.sink.project()).toEqual(repaired);
  expect(paths).toEqual(originalRequests);
});

async function missingReceiptFixture() {
  // Local journal and synthetic stored results only; actual SQL takeover is verified separately.
  const text = 'Original missing receipt prompt';
  await history.commitInitialHostedCsiHistory(managed, {
    state: { ownerSessionId: sessionId, snapshots: [], files: {} },
    backupDirectory: {
      volumeDevice: '1',
      volumeInode: '2',
      directoryDevice: '1',
      directoryInode: '3',
    },
    retainedBackups: [],
  });
  const contentRef = await managed.resources.publish(
    'managed-input',
    Buffer.from(JSON.stringify([{ type: 'text', text }])),
  );
  const admissionRef = await managed.resources.publish(
    'managed-admission',
    Buffer.from('{}'),
  );
  await managed.authority.submitInput(
    {
      operation: 'submitInput',
      commandId: promptId,
      sessionKey: managed.authority.sessionHeader.sessionKey,
      contentDigest: contentRef.digest,
    },
    {
      inputId: promptId,
      turnId: promptId,
      source: 'hosted-harness',
      contentRef,
      admissionRef,
      deadline: null,
      wakeReason: 'input',
    },
  );
  let parentUuid: string | null = null;
  commit.mockImplementation(
    async (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
      identity?: { uuid: string; timestamp: string },
    ) => {
      const record: ChatRecord = {
        ...managed.authority.recordEnvelope,
        sessionId,
        parentUuid,
        uuid: type === 'assistant' ? batchId : identity!.uuid,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        daemonPromptId: promptId,
        model,
        message: { role: type === 'assistant' ? 'model' : 'user', parts },
      };
      await managed.sink.write(record);
      parentUuid = record.uuid;
      return record.uuid;
    },
  );
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const route = new URL(String(url)).pathname;
    if (route.endsWith(':start')) {
      const id = route.split('/').at(-1)!.slice(0, -6);
      const member = members.find((value) => value['executionCallId'] === id)!;
      member['state'] = 'settled';
      member['resultBytesBase64'] = Buffer.from(
        JSON.stringify({
          executionStatus: 'success',
          responseParts: [{ text: `owned result ${id}` }],
        }),
      ).toString('base64');
      if (id === members.at(-1)!['executionCallId']) {
        paths.push(route);
        throw new Error('Terminal result answer lost after storage');
      }
    }
    return originalFetch(url, options);
  });
  const first = batch().calls[0];
  const calls = [
    first,
    { ...first, callId: 'refused', args: { file_path: '../outside' } },
    { ...first, callId: 'read-second', args: { file_path: 'second.txt' } },
    { ...first, callId: 'read-third', args: { file_path: 'third.txt' } },
  ];
  const parts: Part[] = [
    { text: 'Original thought', thought: true },
    ...calls.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
  ];
  await expect(
    turn.execute(calls, parts, 'unit-model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  const before = await managed.sink.project();
  expect(before.filter((record) => record.type === 'tool_result')).toHaveLength(
    2,
  );
  const events = managed.authority.eventsInSequenceRange(
    1,
    managed.authority.committedSequence,
  );
  const checkpoint = events.find(
    (event) =>
      event.kind === 'checkpoint.committed' &&
      event.sequence >
        Math.max(
          ...events
            .filter((candidate) => candidate.kind === 'tool.intent')
            .map((candidate) => candidate.sequence),
        ),
  )!;
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        './contracts/managed-csi-native-readback-v1.fixtures.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).valid.find((value: { name: string }) => value.name === 'execute-read-only')
    .response.evidence.grant;
  const nameBytes = createHash('md5').update(sessionId).digest();
  nameBytes[6] = (nameBytes[6] & 0x0f) | 0x30;
  nameBytes[8] = (nameBytes[8] & 0x3f) | 0x80;
  const nameHex = nameBytes.toString('hex');
  const operationId = `${nameHex.slice(0, 8)}-${nameHex.slice(8, 12)}-${nameHex.slice(12, 16)}-${nameHex.slice(16, 20)}-${nameHex.slice(20)}`;
  for (const member of members) {
    const grant = structuredClone(fixture);
    grant.runtimeBindingId = bindingId;
    grant.bindingGeneration = '1';
    grant.executionCallId = member['executionCallId'];
    grant.executionReference = member['reference'];
    grant.identity.sessionId = sessionId;
    grant.context.tenantId = 'unit-tenant';
    grant.context.workspaceId = 'unit-workspace';
    Object.assign(grant.installedContext, { sessionId, operationId });
    Object.assign(grant.installedContext.binding, {
      tenantId: 'unit-tenant',
      workspaceId: 'unit-workspace',
    });
    grant.installedContext.contextDigest = computeManagedContextDigest(
      grant.installedContext.binding as ManagedContextBinding,
    );
    grant.authorizationSequence = checkpoint.sequence;
    grant.authorizationRevision = checkpoint.sequence;
    const intent = events.find(
      (event) =>
        event.kind === 'tool.intent' &&
        event.payload['executionCallId'] === member['executionCallId'],
    )!;
    grant.intent = { sequence: intent.sequence, revision: intent.sequence };
    grant.checkpointRef = checkpoint.payload['stateRef'];
    member['authorizationBytesBase64'] = Buffer.from(
      JSON.stringify(grant),
    ).toString('base64');
  }
  const writerId = randomUUID();
  const activation = await managed.authority.installActivation({
    activationId: randomUUID(),
    workerId: writerId,
    leaseDurationMs: 60000,
  });
  const successor = {
    ...managed,
    activation,
    sink: new ManagedSessionRecordSink(
      managed.authority,
      managed.resources,
      () => ({ class: 'harness', activation }),
    ),
  };
  const owner = {
    bindingId,
    generation: '1',
    writerId,
    writerGeneration: 2,
    activationId: activation.activationId,
    activationEpoch: activation.epoch,
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    paths.push(new URL(String(url)).pathname);
    const body = JSON.parse(String(options?.body));
    expect(body.recoveryOwner).toEqual({
      writerId: owner.writerId,
      writerGeneration: 2,
      activationId: owner.activationId,
      activationEpoch: owner.activationEpoch,
    });
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        harnessSessionId: sessionId,
        runtimeSessionId: sessionId,
        promptId,
        batchId,
        runtimeBindingId: bindingId,
        bindingGeneration: '1',
        members,
      }),
    );
  });
  return { successor, owner, text, before };
}

it('repairs the absent receipt from the original settled batch and reuses its first durable identity after interruption', async () => {
  const { successor, owner, text, before } = await missingReceiptFixture();
  const write = successor.sink.write.bind(successor.sink);
  const interruption = vi
    .spyOn(successor.sink, 'write')
    .mockRejectedValueOnce(new Error('Repair message answer lost'));
  const starts = paths.filter((route) => route.endsWith(':start')).length;
  await expect(
    recoverHostedCsiReceipts(
      successor,
      { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
      promptId,
      text,
      owner,
    ),
  ).rejects.toThrow('Repair message answer lost');
  const receipts = managed.authority
    .eventsInSequenceRange(1, managed.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(3);
  const lastOutcome = JSON.parse(
    (
      await managed.resources.read(
        assertManagedSessionDurableRef(
          receipts.at(-1)!.payload['toolOutcomeRef'],
          'unit original receipt',
        ),
      )
    ).toString(),
  );
  interruption.mockImplementation(write);
  const reads = paths.filter((route) =>
    route.endsWith('/executions:read-batch'),
  ).length;
  const response = await recoverHostedCsiReceipts(
    successor,
    { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
    promptId,
    text,
  );
  expect(response.map((part) => part.functionResponse?.id)).toEqual([
    'provider-read',
    'read-second',
    'read-third',
  ]);
  const after = await successor.sink.project();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.at(-1)?.uuid).toBe(lastOutcome.history.messageId);
  expect(after.at(-1)?.parentUuid).toBe(before.at(-1)?.uuid);
  expect(paths.filter((route) => route.endsWith(':start'))).toHaveLength(
    starts,
  );
  expect(
    paths.filter((route) => route.endsWith('/executions:read-batch')),
  ).toHaveLength(reads);
  const sequence = managed.authority.committedSequence;
  await recoverHostedCsiReceipts(
    successor,
    { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
    promptId,
    text,
  );
  expect(managed.authority.committedSequence).toBe(sequence);
});

it.each(['resultBytesBase64', 'authorizationBytesBase64'])(
  'refuses a corrupt late %s before publishing or repairing any member',
  async (field) => {
    const { successor, owner, text, before } = await missingReceiptFixture();
    members.at(-1)![field] = Buffer.from('{} {}').toString('base64');
    const sequence = managed.authority.committedSequence;
    await expect(
      recoverHostedCsiReceipts(
        successor,
        { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
        promptId,
        text,
        owner,
      ),
    ).rejects.toThrow();
    expect(managed.authority.committedSequence).toBe(sequence);
    expect(await successor.sink.project()).toEqual(before);
  },
);

it.each([
  'grant identity',
  'missing member',
  'oversized stored result',
  'oversized complete outcome',
  'unsupported state',
])('refuses %s before any durable repair', async (failure) => {
  const { successor, owner, text, before } = await missingReceiptFixture();
  const member = members.at(-1)!;
  if (failure === 'grant identity') {
    const grant = JSON.parse(
      Buffer.from(
        String(member['authorizationBytesBase64']),
        'base64',
      ).toString(),
    );
    grant.executionCallId = 'unrelated-execution';
    member['authorizationBytesBase64'] = Buffer.from(
      JSON.stringify(grant),
    ).toString('base64');
  } else if (failure === 'missing member') members.pop();
  else if (failure === 'unsupported state') member['state'] = 'unknown';
  else
    member['resultBytesBase64'] = Buffer.from(
      JSON.stringify({
        executionStatus: 'success',
        responseParts: [
          {
            text: 'x'.repeat(
              failure === 'oversized stored result' ? 65536 : 64000,
            ),
          },
        ],
      }),
    ).toString('base64');
  const sequence = managed.authority.committedSequence;
  await expect(
    recoverHostedCsiReceipts(
      successor,
      { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
      promptId,
      text,
      owner,
    ),
  ).rejects.toThrow();
  expect(managed.authority.committedSequence).toBe(sequence);
  expect(await successor.sink.project()).toEqual(before);
});
