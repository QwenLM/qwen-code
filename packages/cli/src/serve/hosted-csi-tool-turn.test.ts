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
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { runHostedCsiTextTurn } from './hosted-csi-text-turn.js';
import { runHostedHarnessTextTurn } from './hosted-harness-model.js';
import {
  computeManagedContextDigest,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';
import { ManagedHookActivationController } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { TurnBudget } from '@qwen-code/qwen-code-core/core/turn-budget.js';

vi.mock('./hosted-harness-model.js', () => ({
  runHostedHarnessTextTurn: vi.fn(),
}));

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
let runtimeError: boolean;
let runtimeErrorMessage: string;
const messageFitsInline = vi.fn();

it.each(['Owned original error', 'Long original error '.repeat(300)])(
  'reuses a complete settled error receipt without another Runtime request (%#)',
  async (message) => {
    runtimeError = true;
    runtimeErrorMessage = message;
    const { text, successor } = await interruptedReceiptTurn('before_message');
    const originalRequests = paths.slice();
    const responses = await recoverHostedCsiReceipts(
      successor,
      { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
      promptId,
      text,
    );
    expect(responses.parts.at(-1)?.functionResponse?.response).toMatchObject({
      executionStatus: 'error',
      runtimeError: { message },
    });
    expect(paths).toEqual(originalRequests);
  },
);

async function interruptedReceiptTurn(cut: 'before_message' | 'after_message') {
  await history.commitInitialHostedCsiHistory(managed, emptyHistory());
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
  const user: ChatRecord = {
    ...managed.authority.recordEnvelope,
    sessionId,
    uuid: randomUUID(),
    parentUuid: null,
    timestamp: new Date().toISOString(),
    type: 'user',
    daemonPromptId: promptId,
    message: { role: 'user', parts: [{ text }] },
  };
  await managed.sink.write(user);
  let parentUuid: string | null = user.uuid;
  let results = 0;
  commit.mockImplementation(
    async (
      type: 'assistant' | 'tool_result',
      parts: Part[],
      model: string,
      identity?: { uuid: string; timestamp: string },
    ) => {
      const interrupted = type === 'tool_result' && identity && ++results === 2;
      if (interrupted && cut === 'before_message')
        throw new Error('Original answer lost');
      const record: ChatRecord = {
        ...managed.authority.recordEnvelope,
        sessionId,
        parentUuid,
        uuid: type === 'assistant' ? batchId : (identity?.uuid ?? randomUUID()),
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        daemonPromptId: promptId,
        model,
        message: { role: type === 'assistant' ? 'model' : 'user', parts },
      };
      await managed.sink.write(record);
      parentUuid = record.uuid;
      if (interrupted) throw new Error('Original message answer lost');
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
  return { text, reads, successor };
}

it.each(['missing_receipt', 'changed_parts', 'foreign_tail'] as const)(
  'refuses %s before repairing any original receipt',
  async (failure) => {
    const { text, successor } = await interruptedReceiptTurn('before_message');
    const authority = successor.authority;
    const events = authority.eventsInSequenceRange(
      1,
      authority.committedSequence,
    );
    const receipt = events
      .filter((event) => event.kind === 'tool.receipt')
      .at(-1)!;
    const sequence = authority.committedSequence;
    const before = await successor.sink.project();
    const requests = paths.slice();
    if (failure === 'missing_receipt') {
      vi.spyOn(authority, 'eventsInSequenceRange').mockReturnValue(
        events.filter((event) => event !== receipt),
      );
    } else if (failure === 'changed_parts') {
      const read = successor.resources.read.bind(successor.resources);
      const outcomeRef = assertManagedSessionDurableRef(
        receipt.payload['toolOutcomeRef'],
        'original CSI test outcome',
      );
      vi.spyOn(successor.resources, 'read').mockImplementation(async (ref) => {
        const bytes = await read(ref);
        if (ref.resourceId !== outcomeRef.resourceId) return bytes;
        const outcome = JSON.parse(bytes.toString());
        outcome.history.parts[0].functionResponse.id = 'foreign-function';
        return Buffer.from(JSON.stringify(outcome));
      });
    } else {
      vi.spyOn(successor.sink, 'project').mockResolvedValue([
        ...before,
        { ...before.at(-1)!, uuid: randomUUID(), type: 'assistant' },
      ]);
    }
    await expect(
      recoverHostedCsiReceipts(
        successor,
        { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
        promptId,
        text,
      ),
    ).rejects.toThrow(/Original CSI/);
    expect(authority.committedSequence).toBe(sequence);
    expect(paths).toEqual(requests);
  },
);

it.each(['before_message', 'after_message'] as const)(
  'recovers original receipts %s with durable refusal gaps and no repeated dispatch',
  async (cut) => {
    const { text, reads, successor } = await interruptedReceiptTurn(cut);
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
    expect(responses.parts.map((part) => part.functionResponse?.id)).toEqual(
      reads.map((call) => call.callId),
    );
    const repaired = await successor.sink.project();
    const messages = repaired.filter((record) => record.type === 'tool_result');
    expect(
      messages.map((record) => record.message?.parts?.[0].functionResponse?.id),
    ).toEqual(['refused', reads[0].callId, reads[2].callId]);
    const after = managed.authority.committedSequence;
    expect(
      await recoverHostedCsiReceipts(successor, broker, promptId, text),
    ).toEqual(responses);
    expect(managed.authority.committedSequence).toBe(after);
    expect(await successor.sink.project()).toEqual(repaired);
    expect(paths).toEqual(originalRequests);
    vi.mocked(runHostedHarnessTextTurn).mockImplementation(async (input) => {
      expect(input.resumeFromToolResults).toEqual(responses.parts);
      expect(
        input.history.filter((record) => record.type === 'user'),
      ).toHaveLength(1);
      const finish = await input.modelScope!.beginMainAttempt('unit-model');
      await input.completeFinalOutput!(
        finish,
        [],
        [{ text: 'Recovered answer' }],
        'unit-model',
      );
      await input.toolTurn!.consumeResults();
      return { text: 'Recovered answer', model: 'unit-model' };
    });
    const terminal = await runHostedCsiTextTurn(
      {
        managed: successor,
        cwd: root,
        files: { broker, runtime: { bindingId, generation: '1' } },
      },
      promptId,
      text,
      new AbortController(),
      responses.parts,
    );
    expect(terminal.systemPayload).toMatchObject({ state: 'completed' });
    expect(
      (await successor.sink.project()).filter(
        (record) => record.type === 'user',
      ),
    ).toHaveLength(1);
    expect(paths).toEqual(originalRequests);
  },
);

function emptyHistory(): CsiFileHistoryObservation {
  return {
    state: { ownerSessionId: sessionId, snapshots: [], files: {} },
    backupDirectory: {
      volumeDevice: '1',
      volumeInode: '2',
      directoryDevice: '1',
      directoryInode: '3',
    },
    retainedBackups: [],
  };
}

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
  messageFitsInline.mockReset().mockReturnValue(true);
  turn = new HostedCsiToolTurn(
    managed,
    { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
    { bindingId, generation: '1' },
    promptId,
    commit,
    harness,
    messageFitsInline,
  );
  await turn.declarations(new AbortController().signal);
  requests = [];
  members = [];
  paths = [];
  runtimeError = false;
  runtimeErrorMessage = 'Owned original error';
  // Control/worker history is a seam here; the history client has separate wire tests.
  vi.spyOn(history, 'requestHostedCsiHistory').mockImplementation(async () =>
    emptyHistory(),
  );
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
            result:
              runtimeError && id === 'unit-execution-2'
                ? {
                    executionStatus: 'error',
                    responseParts: [],
                    error: { message: runtimeErrorMessage },
                  }
                : {
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
    expect(body['protocolVersion']).toBe(1);
    expect(body['promptId']).toBe(promptId);
    expect(body['batchId']).toBe(batchId);
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
  const originalParts = structuredClone(parts);
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
    if (String(args[0]).endsWith('/executions:prepare'))
      expect(publications).toBe(6);
    return fetch(...args);
  });
  const responses = await turn.execute(
    calls,
    parts,
    'unit-model',
    new AbortController().signal,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual(
    calls.map((call) => call.callId),
  );
  expect(commit).toHaveBeenNthCalledWith(
    1,
    'assistant',
    originalParts,
    'unit-model',
  );
  expect(commit).toHaveBeenCalledTimes(4);
  expect(paths.filter((route) => route.endsWith(':start'))).toHaveLength(3);
  expect(
    managed.authority
      .eventsInSequenceRange(1, managed.authority.committedSequence)
      .filter((event) => event.kind === 'tool.receipt'),
  ).toHaveLength(3);
  expect(requests).toHaveLength(3);
  const pinned = JSON.parse(
    await readFile(
      new URL(
        '../../../managed-agent-server/src/main/resources/csi-native-file-declarations.json',
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

it('retains Runtime ordinal and Part gaps and commits an explicit rejected-call response', async () => {
  const { calls, parts } = batch();
  calls[1].args = { file_path: '../outside', content: 'blocked' };
  parts[3].functionCall!.args = calls[1].args;
  const responses = await turn.execute(
    calls,
    parts,
    'unit-model',
    new AbortController().signal,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual(
    calls.map((call) => call.callId),
  );
  expect(responses[1].functionResponse?.response).toEqual({
    error: 'CSI file input is invalid.',
  });
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
  expect(commit).toHaveBeenCalledTimes(4);
  expect(paths.filter((route) => route.endsWith(':start'))).toHaveLength(2);
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
  ).rejects.toMatchObject({
    cause: { message: 'Original CSI member read differs.' },
  });
  expect(requests).toHaveLength(3);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(paths.some((route) => route.endsWith(':start'))).toBe(false);
});

it.each([false, true])(
  'closes prepared history after the complete mixed batch with labelled broker/worker seams (refusal: %s)',
  async (withRefusal) => {
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
    const parentMessageId = withRefusal ? randomUUID() : batchId;
    if (withRefusal)
      commit
        .mockResolvedValueOnce(batchId)
        .mockResolvedValueOnce(parentMessageId);
    let preparedObservation: CsiFileHistoryObservation | undefined;
    let postWorkObservation: CsiFileHistoryObservation | undefined;
    const control = vi
      .spyOn(history, 'requestHostedCsiHistory')
      .mockImplementation(async (_broker, _key, operation) => {
        if (
          operation.action === 'snapshot' &&
          paths.some((route) => route.endsWith(':start'))
        ) {
          expect(
            paths.filter((route) => route.endsWith(':start')),
          ).toHaveLength(3);
          postWorkObservation = structuredClone(preparedObservation!);
          postWorkObservation.state.files['output.txt'] = {
            digest: `sha256:${'c'.repeat(64)}`,
            mode: 420,
          };
          return postWorkObservation;
        }
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
        expect(original.record.parentUuid).toBe(parentMessageId);
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
    if (withRefusal) {
      const refused = {
        ...calls[0],
        callId: 'refused-root',
        args: { file_path: './' },
      };
      calls.push(refused);
      parts.push({
        functionCall: {
          id: refused.callId,
          name: refused.name,
          args: refused.args,
        },
      });
    }
    const responses = await turn.execute(
      calls,
      parts,
      'unit-model',
      new AbortController().signal,
    );
    expect(responses).toHaveLength(withRefusal ? 4 : 3);
    expect(control).toHaveBeenCalledTimes(3);
    const latest = managed.authority.domainRecord('file_history')!;
    expect(latest.revision).toBe(4);
    const resultHistory = JSON.parse(
      (await managed.resources.read(latest.recordRef)).toString(),
    );
    expect(resultHistory.preparation).toBeNull();
    expect(resultHistory.state).toEqual(postWorkObservation!.state);
    expect(resultHistory.state).not.toEqual(preparedObservation!.state);
    expect(resultHistory.record.systemPayload.snapshots).toEqual(
      postWorkObservation!.state.snapshots,
    );
    expect(resultHistory.operationId).toBe(
      `csi-file-history:result:${batchId}`,
    );
    expect(resultHistory.record.parentUuid).toBe(
      commit.mock.calls.at(-1)![3].uuid,
    );
    const prepared = JSON.parse(
      (
        await managed.resources.read(resultHistory.previousRecordRef)
      ).toString(),
    );
    expect(prepared.preparation.stage).toBe('prepared');
    expect(prepared.preparation.intentRef).toEqual(prepared.previousRecordRef);
    expect(prepared.preparation.invocations).toHaveLength(3);
    expect(prepared.record.parentUuid).toBe(parentMessageId);
    const replay = await history.commitHostedCsiHistory(
      managed,
      {
        state: prepared.state,
        backupDirectory: prepared.backupDirectory,
        retainedBackups: prepared.retainedBackups,
      },
      prepared.preparation,
      parentMessageId,
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
  },
);

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
  const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await fetch(...args);
    if (String(args[0]).endsWith('/executions:read-batch')) {
      const body = await response.json();
      body.members.reverse();
      return new Response(JSON.stringify(body));
    }
    return response;
  });
  const responses = await turn.execute(
    readCalls,
    parts,
    'unit-model',
    new AbortController().signal,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    calls[0].callId,
    refused.callId,
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
      history: { model: 'unit-model', parts: [responses[index === 0 ? 0 : 2]] },
    });
    expect(commit).toHaveBeenNthCalledWith(
      index + 3,
      'tool_result',
      [responses[index === 0 ? 0 : 2]],
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

it.each([
  ['short', 'Original CSI batch is incomplete.'],
  ['executing', 'Original CSI batch is not prepared.'],
  ...['prompt', 'batch', 'binding', 'generation', 'members'].map((fault) => [
    fault,
    'Original CSI batch read differs.',
  ]),
  ...[
    'duplicate-execution',
    'duplicate-call',
    'unknown-call',
    'input',
    'definition',
  ].map((fault) => [fault, 'Original CSI member read differs.']),
])(
  'refuses a %s batch before dispatch for the intended reason',
  async (fault, reason) => {
    const { calls, parts } = batch();
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).endsWith('/executions:read-batch')) {
        const body = await response.json();
        if (fault === 'short') body.members.pop();
        else if (fault === 'executing') body.members[0].state = 'executing';
        else if (fault === 'prompt') body.promptId = randomUUID();
        else if (fault === 'batch') body.batchId = randomUUID();
        else if (fault === 'binding') body.runtimeBindingId = randomUUID();
        else if (fault === 'generation') body.bindingGeneration = '2';
        else if (fault === 'members') body.members = null;
        else if (fault === 'duplicate-execution')
          body.members[1].executionCallId = body.members[0].executionCallId;
        else if (fault === 'duplicate-call')
          body.members[1] = {
            ...structuredClone(body.members[0]),
            executionCallId: 'unit-execution-extra',
          };
        else if (fault === 'unknown-call')
          body.members[0].reference.callId = randomUUID();
        else if (fault === 'input') body.members[0].inputBytesBase64 = 'e30=';
        else if (fault === 'definition')
          body.members[0].toolDefinitionBytesBase64 = 'e30=';
        return new Response(JSON.stringify(body));
      }
      return response;
    });
    await expect(
      turn.execute(calls, parts, 'unit-model', new AbortController().signal),
    ).rejects.toMatchObject({
      cause: { message: reason },
    });
    expect(requests).toHaveLength(3);
    expect(paths.some((route) => route.endsWith(':start'))).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  },
);

it.each(['count', 'duplicate', 'id', 'name', 'args'])(
  'refuses an original function %s mismatch before reservation',
  async (fault) => {
    const { calls, parts } = batch();
    if (fault === 'count') calls.pop();
    else if (fault === 'duplicate') calls[1].callId = calls[0].callId;
    else if (fault === 'id') calls[1].callId = 'replaced-function';
    else if (fault === 'name') calls[1].name = 'read_file';
    else calls[1].args = { file_path: 'different.txt', content: '' };
    await expect(
      turn.execute(calls, parts, 'unit-model', new AbortController().signal),
    ).rejects.toMatchObject({
      cause: {
        message: ['count', 'duplicate'].includes(fault)
          ? 'Original CSI functions differ.'
          : 'Original CSI function identity differs.',
      },
    });
    expect(requests).toEqual([]);
    expect(paths).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(1);
  },
);

it.each(['function', 'error'])(
  'retains pending work and refuses a malformed %s result before publishing a receipt',
  async (fault) => {
    const { calls, parts } = batch();
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (!String(args[0]).endsWith(':start')) return response;
      const body = await response.json();
      body.status.result =
        fault === 'function'
          ? {
              executionStatus: 'success',
              responseParts: [
                {
                  text: 'owned',
                  functionResponse: {
                    id: 'foreign',
                    name: 'edit',
                    response: { output: 'replaced' },
                  },
                },
              ],
            }
          : {
              executionStatus: 'error',
              responseParts: [],
              error: { message: '' },
            };
      return new Response(JSON.stringify(body));
    });
    const publish = vi.spyOn(managed.resources, 'publish');
    await expect(
      turn.execute(calls, parts, 'unit-model', new AbortController().signal),
    ).rejects.toMatchObject({
      cause: { message: 'Runtime returned an unsupported tool result.' },
    });
    expect(paths.filter((route) => route.endsWith(':start'))).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(
      publish.mock.calls.some(([kind]) => kind === 'managed-tool-outcome'),
    ).toBe(false);
    expect(
      managed.authority
        .eventsInSequenceRange(1, managed.authority.committedSequence)
        .filter((event) => event.kind === 'tool.receipt'),
    ).toEqual([]);
    const checkpoint = parseHarnessCheckpointV1(
      (await managed.authority.readCheckpointState())!,
    );
    expect(checkpoint.continuation.phase).toBe('await_runtime');
    expect(
      checkpoint.tools!.items.every(
        (item) => !item.consumed && item.outcomeRef === null,
      ),
    ).toBe(true);
  },
);

it.each(['transport', 'invalid'])(
  'keeps the prepare failure instance when its independent read-back is %s',
  async (fault) => {
    const { calls, parts } = batch();
    const reason = new Error('owned prepare failure');
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).endsWith('/executions:prepare')) throw reason;
      if (String(args[0]).endsWith('/executions:read-batch')) {
        reads++;
        if (fault === 'transport')
          throw new TypeError('owned read-back failure');
        return new Response('{}');
      }
      return response;
    });
    const failure: unknown = await turn
      .execute(calls, parts, 'unit-model', new AbortController().signal)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect((failure as Error).cause).toBe(reason);
    expect(reads).toBe(1);
    expect(requests).toHaveLength(1);
    expect(paths.some((route) => route.endsWith(':start'))).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  },
);

it.each(['schema', 'oversized', 'root'])(
  'returns a durable %s refusal without any Runtime work for an all-rejected batch',
  async (fault) => {
    const { calls } = batch();
    const call = calls[1];
    call.args =
      fault === 'schema'
        ? { file_path: 'a.txt', content: '', extra: true }
        : fault === 'oversized'
          ? { file_path: 'a.txt', content: 'x'.repeat(70 * 1024) }
          : { file_path: './', content: '' };
    const parts = [
      { functionCall: { id: call.callId, name: call.name, args: call.args } },
    ];
    const result = await turn.execute(
      [call],
      parts,
      'unit-model',
      new AbortController().signal,
    );
    expect(result).toMatchObject([
      {
        functionResponse: {
          id: call.callId,
          name: call.name,
          response: {
            error:
              fault === 'oversized'
                ? 'CSI file input exceeds the durable Session limit.'
                : 'CSI file input is invalid.',
          },
        },
      },
    ]);
    expect(commit).toHaveBeenNthCalledWith(
      2,
      'tool_result',
      result,
      'unit-model',
    );
    expect(commit).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([]);
    expect(paths).toEqual([]);
    expect(history.requestHostedCsiHistory).not.toHaveBeenCalled();
    expect(
      managed.authority
        .eventsInSequenceRange(1, managed.authority.committedSequence)
        .filter(
          (event) =>
            event.kind === 'tool.intent' || event.kind === 'tool.receipt',
        ),
    ).toEqual([]);
    await turn.consumeResults();
    await turn.finish();
  },
);

it.each(['outcome-bytes', 'message'])(
  'retains the unconsumed batch and refuses later dispatch when %s exceeds capacity',
  async (fault) => {
    const call = batch().calls[0];
    const calls = [call, { ...call, callId: 'later-read' }];
    const parts = calls.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    }));
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (fault === 'outcome-bytes' && String(args[0]).endsWith(':start')) {
        const body = await response.json();
        body.status.result.responseParts = [{ text: 'x'.repeat(70 * 1024) }];
        return new Response(JSON.stringify(body));
      }
      return response;
    });
    messageFitsInline.mockReturnValue(fault !== 'message');
    await expect(
      turn.execute(calls, parts, 'unit-model', new AbortController().signal),
    ).rejects.toMatchObject({
      cause: {
        message: 'Complete CSI result exceeds the durable Session limit.',
      },
    });
    expect(paths.filter((route) => route.endsWith(':start'))).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(1);
    const checkpoint = parseHarnessCheckpointV1(
      (await managed.authority.readCheckpointState())!,
    );
    expect(checkpoint.continuation.phase).toBe('await_runtime');
    expect(checkpoint.tools!.items).toHaveLength(2);
    expect(
      checkpoint.tools!.items.every(
        (item) => !item.consumed && item.outcomeRef === null,
      ),
    ).toBe(true);
    expect(
      managed.authority
        .eventsInSequenceRange(1, managed.authority.committedSequence)
        .filter((event) => event.kind === 'tool.receipt'),
    ).toEqual([]);
  },
);

it('cancels an in-flight prepare while reconciling once with an independent live signal', async () => {
  const { calls, parts } = batch();
  const controller = new AbortController();
  const reason = new Error('owned cancel');
  const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const signal = args[1]!.signal!;
    const response = await fetch(...args);
    if (String(args[0]).endsWith('/executions:prepare')) {
      expect(signal.aborted).toBe(false);
      controller.abort(reason);
      expect(signal.aborted).toBe(true);
      signal.throwIfAborted();
    } else if (String(args[0]).endsWith('/executions:read-batch')) {
      expect(controller.signal.aborted).toBe(true);
      expect(signal.aborted).toBe(false);
    }
    return response;
  });
  await expect(
    turn.execute(calls, parts, 'unit-model', controller.signal),
  ).rejects.toMatchObject({ cause: reason });
  expect(requests).toHaveLength(1);
  expect(paths).toEqual([
    '/internal/runtime-broker/v1/executions:prepare',
    '/internal/runtime-broker/v1/executions:read-batch',
  ]);
  expect(commit).toHaveBeenCalledTimes(1);
});

it('refuses nonempty initial history before committing it', async () => {
  const observation = emptyHistory();
  observation.state.files['owned.txt'] = null;
  const timestamp = new Date().toISOString();
  observation.state.snapshots.push({
    promptId,
    timestamp,
    trackedFileBackups: {
      'owned.txt': { backupFileName: null, version: 1, backupTime: timestamp },
    },
  });
  const commit = vi.spyOn(managed.authority, 'commitDomainRecord');
  await expect(
    history.commitInitialHostedCsiHistory(managed, observation),
  ).rejects.toThrow('Initial CSI history must be empty.');
  expect(commit).not.toHaveBeenCalled();
});

it('checks the full serialized history envelope before publishing it', async () => {
  const observation = emptyHistory();
  const filename = `owned-${'x'.repeat(230)}.txt`;
  observation.state.files[filename] = null;
  observation.state.snapshots = Array.from({ length: 85 }, () => ({
    promptId: randomUUID(),
    timestamp: '2026-10-18T00:00:00.000Z',
    trackedFileBackups: {
      [filename]: {
        backupFileName: null,
        version: 1,
        backupTime: '2026-10-18T00:00:00.000Z',
      },
    },
  }));
  expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThan(65536);
  const publish = vi.spyOn(managed.resources, 'publish');
  await expect(
    history.commitHostedCsiHistory(
      managed,
      observation,
      null,
      null,
      'capacity-refused',
    ),
  ).rejects.toThrow(
    'Complete CSI file history exceeds the durable Session limit.',
  );
  expect(publish).not.toHaveBeenCalled();
  expect(managed.authority.domainRecord('file_history')).toBeUndefined();
  observation.state.snapshots = observation.state.snapshots.slice(0, 55);
  const committed = await history.commitHostedCsiHistory(
    managed,
    observation,
    null,
    null,
    'capacity-accepted',
  );
  const bytes = await managed.resources.read(committed.recordRef);
  expect(bytes.length).toBeLessThan(65536);
  expect(JSON.parse(bytes.toString()).record.systemPayload.snapshots).toEqual(
    observation.state.snapshots,
  );
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
        uuid: type === 'assistant' ? batchId : (identity?.uuid ?? randomUUID()),
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
    3,
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

it('recovers complete final output without repair, another model request or a duplicate assistant with labelled SQL/worker seams', async () => {
  const { successor, owner, text } = await missingReceiptFixture();
  const broker = { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' };
  await recoverHostedCsiReceipts(successor, broker, promptId, text, owner);
  const prior = await successor.sink.project();
  const original: ChatRecord = {
    ...successor.authority.recordEnvelope,
    sessionId,
    uuid: randomUUID(),
    parentUuid: prior.at(-1)!.uuid,
    timestamp: new Date().toISOString(),
    type: 'assistant',
    daemonPromptId: promptId,
    model: 'unit-model',
    message: {
      role: 'model',
      parts: [
        {
          text: 'original thought',
          thought: true,
          thoughtSignature: 'signature',
        },
        { text: 'original complete answer' },
        { inlineData: { mimeType: 'image/png', data: 'AQID' } },
      ],
    },
  };
  await new ManagedHookActivationController(successor).runTurn(
    promptId,
    async (scope) => {
      await scope.bindBudget(new TurnBudget(), text);
      const complete = await scope.beginMainAttempt('unit-model');
      await complete(true, [{ candidatesTokenCount: 30 }], original);
    },
  );
  const activation = await successor.authority.installActivation({
    activationId: randomUUID(),
    workerId: randomUUID(),
    leaseDurationMs: 60000,
  });
  const resumed = {
    ...successor,
    activation,
    sink: new ManagedSessionRecordSink(
      successor.authority,
      successor.resources,
      () => ({ class: 'harness', activation }),
    ),
  };
  const sequence = resumed.authority.committedSequence;
  const before = await resumed.sink.project();
  const pathsBefore = paths.slice();
  const recovered = await recoverHostedCsiReceipts(
    resumed,
    broker,
    promptId,
    text,
  );
  expect(recovered.finalOutput).toEqual(original);
  expect(resumed.authority.committedSequence).toBe(sequence);
  expect(await resumed.sink.project()).toEqual(before);
  expect(paths).toEqual(pathsBefore);
  const model = vi.mocked(runHostedHarnessTextTurn).mockClear();
  const result = await runHostedCsiTextTurn(
    {
      managed: resumed,
      cwd: root,
      files: { broker, runtime: { bindingId, generation: '1' } },
    },
    promptId,
    text,
    new AbortController(),
    recovered.parts,
    recovered.finalOutput,
  );
  expect(model).not.toHaveBeenCalled();
  expect(result.subtype).toBe('turn_result');
  expect(result.systemPayload).toMatchObject({ state: 'completed' });
  expect(paths).toEqual(pathsBefore);
  const after = await resumed.sink.project();
  expect(after.filter((record) => record.type !== 'system')).toEqual(before);
  expect(after.filter((record) => record.uuid === original.uuid)).toEqual([
    original,
  ]);
  const checkpoint = parseHarnessCheckpointV1(
    (await resumed.authority.readCheckpointState())!,
  );
  expect(checkpoint.continuation.phase).toBe('before_model');
  const events = resumed.authority.eventsInSequenceRange(
    sequence + 1,
    resumed.authority.committedSequence,
  );
  expect(events.filter((event) => event.kind === 'turn.settled')).toHaveLength(
    1,
  );
  expect(
    events.some((event) =>
      [
        'model.attempt',
        'message.committed',
        'tool.intent',
        'tool.receipt',
      ].includes(event.kind),
    ),
  ).toBe(false);
});

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
  expect(response.parts.map((part) => part.functionResponse?.id)).toEqual([
    'provider-read',
    'refused',
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
