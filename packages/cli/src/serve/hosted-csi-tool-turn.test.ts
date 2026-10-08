/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostedCsiToolTurn } from './hosted-csi-tool-turn.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';

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
  commit.mockReset().mockResolvedValue(batchId);
  turn = new HostedCsiToolTurn(
    managed,
    { baseUrl: 'http://127.0.0.1:8080', token: 'unit-broker' },
    { bindingId, generation: '1' },
    promptId,
    commit,
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
