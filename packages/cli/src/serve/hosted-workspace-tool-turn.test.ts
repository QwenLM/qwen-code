/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { boundedShellPreview } from './managed-shell-publisher.js';
import { HostedWorkspaceBrokerRejection } from './hosted-workspace-broker.js';
import {
  HostedWorkspaceToolTurn,
  HostedToolRecoveryRequiredError,
} from './hosted-workspace-tool-turn.js';

const broker = vi.hoisted(() => ({
  warm: vi.fn(),
  acquire: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  release: vi.fn(),
  registerPublisher: vi.fn(),
  acknowledge: vi.fn(),
}));
vi.mock('./hosted-workspace-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-workspace-broker.js')>()),
  HostedWorkspaceBroker: class {
    warm = broker.warm;
    acquire = broker.acquire;
    prepare = broker.prepare;
    execute = broker.execute;
    cancel = broker.cancel;
    release = broker.release;
    registerPublisher = broker.registerPublisher;
    acknowledge = broker.acknowledge;
  },
}));
let root: string;
let session: ManagedSession;
let harness: ReturnType<typeof createManagedHarnessHandle>;
let turn: HostedWorkspaceToolTurn;
let commit: ConstructorParameters<typeof HostedWorkspaceToolTurn>[4];
const messageFitsInline = vi.fn(() => true);
function createTurn(shell = false) {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    shell
      ? { resources: session.resources, assertWritable: async () => undefined }
      : undefined,
  );
}
const calls = ['read_file', 'edit'].map((name, index) => ({
  name,
  callId: `call-${index}`,
  args: {
    file_path: 'file.txt',
    ...(index ? { old_string: 'a', new_string: 'b' } : {}),
  },
  isClientInitiated: false,
  prompt_id: 'prompt',
}));
const parts: Part[] = calls.map((call) => ({
  functionCall: { id: call.callId, name: call.name, args: call.args },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  for (const method of [
    broker.warm,
    broker.acquire,
    broker.cancel,
    broker.release,
  ])
    method.mockResolvedValue(undefined);
  root = await mkdtemp(path.join(tmpdir(), 'hosted-tool-turn-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const definitionRef = await resources.publish(
    'managed-definition',
    Buffer.from('{}'),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-root',
    Buffer.from('{}'),
  );
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
  });
  harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  broker.prepare.mockImplementation(async () => randomUUID());
  broker.execute.mockResolvedValue({
    executionStatus: 'success',
    responseParts: [{ text: 'original result' }],
  });
  commit = async (type, messageParts) => {
    const uuid = randomUUID();
    await session.sink.write({
      uuid,
      parentUuid: null,
      sessionId: sessionKey.sessionId,
      timestamp: new Date().toISOString(),
      type,
      cwd: root,
      version: 'test',
      daemonPromptId: 'prompt',
      message: {
        role: type === 'assistant' ? 'model' : 'user',
        parts: messageParts,
      },
    });
    return uuid;
  };
  messageFitsInline.mockReturnValue(true);
  broker.registerPublisher.mockResolvedValue('1');
  broker.acknowledge.mockResolvedValue(undefined);
  turn = createTurn();
});
afterEach(async () => {
  await turn?.close();
  vi.restoreAllMocks();
  await session?.close();
  await rm(root, { recursive: true, force: true });
});

it('commits the whole batch before the first dispatch and each receipt before resolving it', async () => {
  const original = harness.resolveAwaitRuntime.bind(harness);
  vi.spyOn(harness, 'resolveAwaitRuntime').mockImplementation(
    async (id, ref) => {
      expect((await session.sink.project()).at(-1)?.type).toBe('tool_result');
      expect(
        JSON.parse((await session.resources.read(ref)).toString())
          .executionCallId,
      ).toBe(id);
      return original(id, ref);
    },
  );
  broker.execute.mockImplementation(async () => {
    const authorization = await session.authority.harnessRunAuthorization();
    expect(authorization.status).toBe('runnable');
    if (authorization.status !== 'runnable') throw new Error('No checkpoint');
    expect(authorization.checkpoint.identity).toMatchObject({
      turnId: 'prompt',
      promptId: 'prompt',
    });
    expect(authorization.checkpoint.continuation.phase).toBe('await_runtime');
    expect(authorization.checkpoint.tools?.items).toHaveLength(2);
    expect((await session.sink.project())[0]?.message?.parts).toEqual(parts);
    return {
      executionStatus: 'success',
      responseParts: [{ text: 'original result' }],
    };
  });
  const responses = await turn.execute(
    calls,
    parts,
    'model',
    new AbortController().signal,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual(
    calls.map((call) => call.callId),
  );
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it.each(['input', 'intent', 'wait', 'result'] as const)(
  'blocks without inventing settlement after %s persistence failure',
  async (point) => {
    if (point === 'intent') {
      const append = session.authority.appendExecutionEvent.bind(
        session.authority,
      );
      vi.spyOn(session.authority, 'appendExecutionEvent').mockImplementation(
        async (command, event, actor) => {
          if (command.operation === 'toolIntent') throw new Error('store down');
          return append(command, event, actor);
        },
      );
    } else if (point === 'wait')
      vi.spyOn(harness, 'commitAwaitRuntimeBatch').mockRejectedValue(
        new Error('store down'),
      );
    else {
      const publish = session.resources.publish.bind(session.resources);
      vi.spyOn(session.resources, 'publish').mockImplementation(
        async (kind, bytes) => {
          if (
            kind ===
            (point === 'input' ? 'managed-tool-input' : 'managed-tool-outcome')
          )
            throw new Error('store down');
          return publish(kind, bytes);
        },
      );
    }
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(broker.execute).toHaveBeenCalledTimes(point === 'result' ? 1 : 0);
    expect(broker.release).not.toHaveBeenCalled();
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
  },
);

it('anchors every exact input through an intent before dispatch across multiple batches', async () => {
  const seen: string[] = [];
  broker.execute.mockImplementation(async (id, payloadJson) => {
    const intent = session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'tool.intent' &&
          event.payload['executionCallId'] === id,
      );
    expect(intent).toBeDefined();
    const ref = intent!.payload[
      'argsRef'
    ] as unknown as ManagedSessionDurableRef;
    const input = JSON.parse((await session.resources.read(ref)).toString());
    expect(input.payloadJson).toBe(payloadJson);
    seen.push(id);
    return { executionStatus: 'success', responseParts: [{ text: 'done' }] };
  });
  for (let round = 0; round < 2; round++) {
    const batch = calls.map((call) => ({
      ...call,
      callId: `${call.callId}-${round}`,
    }));
    await turn.execute(
      batch,
      batch.map((call) => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      })),
      'model',
      new AbortController().signal,
    );
    await turn.consumeResults();
  }
  await turn.finish();
  expect(seen).toHaveLength(4);
  expect(new Set(seen).size).toBe(4);
});

it('does not consume an unknown outcome or continue a partly executed batch', async () => {
  broker.execute.mockRejectedValueOnce(new Error('unknown'));
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(broker.cancel).toHaveBeenCalledTimes(2);
  const authorization = await session.authority.harnessRunAuthorization();
  expect(
    authorization.status === 'runnable' &&
      authorization.checkpoint.continuation.phase,
  ).toBe('await_runtime');
  expect(
    (await session.sink.project()).filter(
      (record) => record.type === 'tool_result',
    ),
  ).toHaveLength(0);
});

it('refuses local paths and Shell before acquiring or reserving work', async () => {
  for (const call of [
    { ...calls[0], name: 'run_shell_command' },
    { ...calls[0], args: { file_path: '/local/file' } },
    { ...calls[0], args: { file_path: '../escape' } },
    { ...calls[0], args: { file_path: ' /local/file ' } },
    { ...calls[0], wasOutputTruncated: true },
  ]) {
    await expect(
      turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toThrow();
  }
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('keeps release failures recovery blocked', async () => {
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  broker.release.mockRejectedValue(new Error('lost release'));
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
});

it('keeps an empty Runtime error visible to the model instead of reporting success', async () => {
  broker.execute.mockResolvedValue({
    executionStatus: 'error',
    responseParts: [],
    error: { message: 'file missing' },
  });
  const result = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(result[0].functionResponse?.response).toMatchObject({
    error: 'file missing',
    executionStatus: 'error',
  });
  expect(result[0].functionResponse?.response).not.toHaveProperty('output');
});

it.each([
  {
    label: 'UTF-8 output',
    result: {
      executionStatus: 'success',
      responseParts: [{ text: '中'.repeat(25_000) }],
    },
  },
  {
    label: 'JSON-escaped output',
    result: {
      executionStatus: 'success',
      responseParts: [{ text: '\\'.repeat(35_000) }],
    },
  },
  {
    label: 'Runtime error',
    result: {
      executionStatus: 'error',
      responseParts: [],
      error: { message: '中'.repeat(25_000) },
    },
  },
])(
  'persists a small receipt for oversized settled $label',
  async ({ result }) => {
    broker.execute.mockResolvedValue(result);
    const publish = vi.spyOn(session.resources, 'publish');
    const responses = await turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    const response = responses[0].functionResponse?.response;
    expect(response?.['outputOmitted']).toBe(true);
    expect(response?.['executionStatus']).toBe(result.executionStatus);
    expect(response?.['error']).toContain('durable Session limit');
    expect(response).not.toHaveProperty('output');
    expect(response).not.toHaveProperty('runtimeError');
    const outcome = publish.mock.calls.find(
      ([kind]) => kind === 'managed-tool-outcome',
    )?.[1];
    expect(outcome?.byteLength).toBeLessThanOrEqual(64 * 1024);
    const receipt = (await session.sink.project()).at(-1);
    expect(receipt?.message?.parts).toEqual(responses);
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(
      64 * 1024,
    );
    await turn.consumeResults();
    await turn.finish();
    expect(broker.execute).toHaveBeenCalledOnce();
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

it.each(['workspace_busy', 'workspace_unavailable'])(
  'allows another attempt after a definite %s acquire refusal',
  async (code) => {
    const refusal = new HostedWorkspaceBrokerRejection(409, code);
    broker.acquire.mockRejectedValueOnce(refusal);
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBe(refusal);
    await expect(turn.finish()).resolves.toBeUndefined();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.release).not.toHaveBeenCalled();
    expect(await session.sink.project()).toEqual([]);
    await turn.execute(calls, parts, 'model', new AbortController().signal);
    await turn.consumeResults();
    await turn.finish();
    expect(broker.acquire).toHaveBeenCalledTimes(2);
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

it.each([
  new Error('lost acquire response'),
  new HostedWorkspaceBrokerRejection(503, 'workspace_unavailable'),
  new HostedWorkspaceBrokerRejection(409, 'runtime_session_acquire_failed'),
])(
  'retains recovery blocking after ambiguous acquisition: %s',
  async (cause) => {
    broker.acquire.mockRejectedValueOnce(cause);
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.release).not.toHaveBeenCalled();
  },
);

it.each(['x'.repeat(70 * 1024), '中'.repeat(23 * 1024), '"'.repeat(17 * 1024)])(
  'checks the exact serialized argument resource before acquisition (%#)',
  async (content) => {
    const call = {
      ...calls[0],
      name: 'write_file',
      args: { file_path: 'file.txt', content },
    };
    await expect(
      turn.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'model',
        new AbortController().signal,
      ),
    ).rejects.toThrow('inline Session Store limit');
    await expect(turn.finish()).resolves.toBeUndefined();
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
  },
);

it('returns durable errors for a refused Shell batch and permits a corrected call', async () => {
  turn = createTurn(true);
  const shell = {
    ...calls[0],
    callId: 'background',
    name: 'run_shell_command',
    args: { command: 'sleep 2', is_background: true },
  };
  const batch = [calls[0], shell];
  const responses = await turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    calls[0].callId,
    shell.callId,
  ]);
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'not executed',
  );
  expect(responses[1].functionResponse?.response?.['error']).toContain(
    'foreground',
  );
  expect((await session.sink.project()).map((record) => record.type)).toEqual([
    'assistant',
    'tool_result',
  ]);
  expect((await session.sink.project()).at(-1)?.message?.parts).toEqual(
    responses,
  );
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(broker.registerPublisher).not.toHaveBeenCalled();
  await turn.consumeResults();
  const corrected = { ...shell, args: { command: 'printf hello' } };
  broker.execute.mockResolvedValue({
    executionStatus: 'not_started',
    responseParts: [],
    error: { message: 'command validation failed' },
    capture: null,
  });
  await turn.execute(
    [corrected],
    [
      {
        functionCall: {
          id: corrected.callId,
          name: corrected.name,
          args: corrected.args,
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  await turn.consumeResults();
  await turn.finish();
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual({
    command: 'printf hello',
    is_background: false,
  });
  expect(broker.release).toHaveBeenCalledOnce();
});

it('blocks recovery if the durable refusal cannot be committed', async () => {
  const original = commit;
  commit = async (...args) => {
    if (args[0] === 'tool_result') throw new Error('history write failed');
    return original(...args);
  };
  turn = createTurn(true);
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    args: { command: 'x', is_background: true },
  };
  await expect(
    turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.acquire).not.toHaveBeenCalled();
});

it.each([false, true])(
  'preserves the admitted Shell outcome when history rejects it: %s',
  async (rejectHistory) => {
    turn = createTurn(true);
    broker.prepare.mockResolvedValue('execution-shell');
    const manifest = await session.resources.publish(
      'managed-tool-result-manifest',
      Buffer.from('{}'),
    );
    const envelope = {
      executionStatus: 'error',
      responseParts: boundedShellPreview([
        { text: '\u0001'.repeat(70_000) + '\nBUILD FAILED\nExit Code: 3' },
      ]),
      error: { message: 'exit 3' },
      capture: {
        captureStatus: 'complete',
        captureReason: null,
        manifest,
        previewTruncated: true,
        deliveryStatus: 'committed',
      },
    };
    const outcomeRef = await session.resources.publish(
      'managed-tool-outcome',
      Buffer.from(JSON.stringify({ envelope })),
    );
    const receipt = {
      executionCallId: 'execution-shell',
      manifest,
      deliveryStatus: 'committed' as const,
      historyRevision: 1,
      outcomeRef,
    };
    vi.spyOn(HostedShellPublisher.prototype, 'receipt').mockResolvedValue(
      receipt,
    );
    broker.execute.mockResolvedValue(envelope);
    const resolve = vi.spyOn(harness, 'resolveAwaitRuntime');
    const publish = vi.spyOn(session.resources, 'publish');
    messageFitsInline.mockImplementation(
      (...args: unknown[]) => args[0] !== 'tool_result' || !rejectHistory,
    );
    const call = {
      ...calls[0],
      name: 'run_shell_command',
      args: { command: 'sh build.sh' },
    };
    const result = turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    if (rejectHistory) {
      await expect(result).rejects.toMatchObject({
        cause: {
          message:
            'Admitted Shell result exceeds the inline Session Store limit.',
        },
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(broker.acknowledge).not.toHaveBeenCalled();
      expect(
        (await session.sink.project()).filter(
          (record) => record.type === 'tool_result',
        ),
      ).toEqual([]);
      await expect(turn.finish()).rejects.toBeInstanceOf(
        HostedToolRecoveryRequiredError,
      );
    } else {
      const responses = await result;
      expect(JSON.stringify(responses)).toContain('BUILD FAILED');
      expect(JSON.stringify(responses)).toContain('Exit Code: 3');
      expect(responses[0].functionResponse?.response?.['capture']).toEqual(
        envelope.capture,
      );
      expect(responses[0].functionResponse?.response).not.toHaveProperty(
        'outputOmitted',
      );
      expect(
        Buffer.byteLength(
          JSON.stringify((await session.sink.project()).at(-1)),
        ),
      ).toBeLessThan(64 * 1024);
      expect(resolve).toHaveBeenCalledWith('execution-shell', outcomeRef);
      expect(broker.acknowledge).toHaveBeenCalledWith(
        'execution-shell',
        receipt,
      );
      await turn.consumeResults();
      await turn.finish();
    }
    expect(
      publish.mock.calls.some(([kind]) => kind === 'managed-tool-outcome'),
    ).toBe(false);
  },
);
