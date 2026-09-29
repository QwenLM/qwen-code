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
import { LocalJsonlManagedSessionJournalHandle } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { boundedShellPreview } from './managed-shell-publisher.js';
import { HostedWorkspaceBrokerRejection } from './hosted-workspace-broker.js';
import {
  HostedWorkspaceToolTurn,
  HostedToolRecoveryRequiredError,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  resolveHostedAction,
  type HostedApprovalMode,
} from './hosted-tool-approval.js';

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
let waiters: HostedApprovalWaiters;
function createTurn(
  shell = false,
  approval?: { mode: HostedApprovalMode; timeoutMs?: number },
) {
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
    approval && {
      settings: {
        mode: approval.mode,
        timeoutMs: approval.timeoutMs ?? 60_000,
      },
      waiters,
    },
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
  waiters = new HostedApprovalWaiters();
  turn = createTurn();
});
afterEach(async () => {
  await turn?.close();
  vi.restoreAllMocks();
  // A Session whose writes stopped cannot record its own close.
  if (session?.authority.writesStopped)
    await expect(session.close()).rejects.toThrow(/writes stopped/);
  else await session?.close();
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

it('refuses unsupported profile calls before acquiring or reserving work', async () => {
  for (const call of [
    { ...calls[0], name: 'run_shell_command' },
    { ...calls[0], wasOutputTruncated: true },
  ]) {
    await expect(
      turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toThrow();
  }
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
});

it.each(['read_file', 'write_file', 'edit'])(
  'persists correctable file_path errors for %s without dispatch',
  async (name) => {
    const invalidPaths: unknown[] = [
      undefined,
      null,
      '',
      '   ',
      123,
      '/private/secret-host-path',
      ' /private/secret-host-path ',
      '../escape',
      'a\\b',
      'C:/secret-host-path',
      'a\u0000b',
      '\ud800',
    ];
    for (const [index, file] of invalidPaths.entries()) {
      const args = file === undefined ? {} : { file_path: file };
      const call = { ...calls[0], name, callId: `invalid-${index}`, args };
      const original = [
        { functionCall: { id: call.callId, name, args: call.args } },
      ];
      const responses = await turn.execute(
        [call],
        original,
        'model',
        new AbortController().signal,
      );
      const error = responses[0].functionResponse?.response?.['error'];
      expect(responses[0].functionResponse?.id).toBe(call.callId);
      expect(error).toContain('file_path');
      expect(error).toContain('retry');
      expect(error).not.toContain('cwdRelative');
      expect(error).not.toContain('secret-host-path');
      const history = await session.sink.project();
      expect(history.slice(-2).map((record) => record.type)).toEqual([
        'assistant',
        'tool_result',
      ]);
      expect(history.at(-2)?.message?.parts).toEqual(original);
      expect(history.at(-1)?.message?.parts).toEqual(responses);
    }
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toBeUndefined();
  },
);

it('preserves trimmed and normalized valid file paths', async () => {
  const call = { ...calls[0], args: { file_path: ' ./dir//file.txt ' } };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const payload = JSON.parse(broker.execute.mock.calls[0][1]);
  expect(payload.input.file_path).toBe('dir/file.txt');
  await turn.consumeResults();
  await turn.finish();
});

it.each([
  ['file-first', false],
  ['file-last-with-shell', true],
] as const)(
  'refuses a mixed %s batch, then executes only the corrected call',
  async (_scenario, shell) => {
    turn = createTurn(shell);
    const invalid = {
      ...calls[0],
      callId: 'invalid-path',
      args: { file_path: '/private/secret-host-path' },
    };
    const sibling = shell
      ? {
          ...calls[0],
          callId: 'valid-shell',
          name: 'run_shell_command',
          args: { command: 'touch should-not-run' },
        }
      : {
          ...calls[0],
          callId: 'valid-write',
          name: 'write_file',
          args: { file_path: 'valid.txt', content: 'one effect' },
        };
    const batch = shell ? [sibling, invalid] : [invalid, sibling];
    const original = batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    }));
    const responses = await turn.execute(
      batch,
      original,
      'model',
      new AbortController().signal,
    );
    expect(responses.map((part) => part.functionResponse?.id)).toEqual(
      batch.map((call) => call.callId),
    );
    expect(
      responses.find((part) => part.functionResponse?.id === invalid.callId)
        ?.functionResponse?.response?.['error'],
    ).toContain('file_path');
    expect(
      responses.find((part) => part.functionResponse?.id === sibling.callId)
        ?.functionResponse?.response?.['error'],
    ).toContain('not executed');
    expect(JSON.stringify(responses)).not.toContain('invalid Shell arguments');
    expect((await session.sink.project()).map((record) => record.type)).toEqual(
      ['assistant', 'tool_result'],
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(broker.registerPublisher).not.toHaveBeenCalled();
    await turn.consumeResults();

    const corrected = {
      ...sibling,
      callId: 'corrected-write',
      name: 'write_file',
      args: { file_path: 'valid.txt', content: 'one effect' },
    };
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
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

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

it.each([
  [{ command: '' }, 'nonempty command'],
  [{ command: 'pwd', extra: true }, 'unsupported argument "extra"'],
  [{ command: 'pwd', description: 7 }, 'description must be a string'],
  [{ command: 'pwd', timeout: 0 }, 'timeout must be an integer'],
])('reports the invalid Shell argument %j', async (args, message) => {
  turn = createTurn(true);
  const call = { ...calls[0], name: 'run_shell_command', args };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args } }],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toContain(message);
  expect(broker.acquire).not.toHaveBeenCalled();
});

it('accepts the runtime foreground spelling is_background false', async () => {
  turn = createTurn(true);
  broker.execute.mockResolvedValue({
    executionStatus: 'not_started',
    responseParts: [],
    error: { message: 'command validation failed' },
    capture: null,
  });
  const args = { command: 'pwd', is_background: 'FaLsE' };
  const call = { ...calls[0], name: 'run_shell_command', args };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args } }],
    'model',
    new AbortController().signal,
  );
  expect(broker.prepare).toHaveBeenCalledOnce();
  expect(JSON.parse(broker.execute.mock.calls[0][1])).toEqual({
    toolName: 'run_shell_command',
    input: { command: 'pwd', is_background: false },
  });
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

it.each(['assistant', 'tool_result'] as const)(
  'blocks recovery when a file_path refusal %s commit fails',
  async (failedType) => {
    const original = commit;
    commit = async (...args) => {
      if (args[0] === failedType) throw new Error('history write failed');
      return original(...args);
    };
    turn = createTurn();
    const invalid = {
      ...calls[0],
      args: { file_path: '/private/secret-host-path' },
    };
    await expect(
      turn.execute(
        [invalid],
        [
          {
            functionCall: {
              id: invalid.callId,
              name: invalid.name,
              args: invalid.args,
            },
          },
        ],
        'model',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it('keeps an acquired Workspace held when a later file_path refusal cannot commit', async () => {
  const original = commit;
  let toolResultCommits = 0;
  commit = async (...args) => {
    if (args[0] === 'tool_result' && ++toolResultCommits === 2)
      throw new Error('history write failed');
    return original(...args);
  };
  turn = createTurn();
  await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  await turn.consumeResults();
  const invalid = {
    ...calls[0],
    args: { file_path: '/private/secret-host-path' },
  };
  await expect(
    turn.execute(
      [invalid],
      [
        {
          functionCall: {
            id: invalid.callId,
            name: invalid.name,
            args: invalid.args,
          },
        },
      ],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.acquire).toHaveBeenCalledOnce();
  expect(broker.release).not.toHaveBeenCalled();
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

const answer = (optionId: string, extra: Record<string, unknown> = {}) => ({
  optionId,
  inputRevision: 1,
  policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
  ...extra,
});

function actionIds(): string[] {
  return [
    ...new Set(
      session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'action.changed')
        .map((event) => event.payload['requestId'] as string),
    ),
  ];
}

async function requested(count = 1): Promise<string> {
  let requestId = '';
  await vi.waitFor(async () => {
    const ids = actionIds();
    expect(ids).toHaveLength(count);
    requestId = ids.at(-1)!;
    expect(session.authority.action(requestId)?.state).toBe('requested');
    expect((await checkpoint()).continuation.phase).toBe('await_action');
  });
  return requestId;
}

async function checkpoint() {
  const authorization = await session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') throw new Error('No checkpoint');
  return authorization.checkpoint;
}

async function toolResults() {
  return (await session.sink.project())
    .filter((record) => record.type === 'tool_result')
    .map((record) =>
      record.message?.parts?.map((part) => part.functionResponse?.id),
    );
}

it('asks before an edit in default mode and runs the batch once the owner allows', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const started = Date.now();
  const running = turn.execute(
    calls,
    parts,
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  expect(requestId).toMatch(/^tool_approval_[0-9a-f]{32}$/u);
  expect((await checkpoint()).identity).toMatchObject({
    turnId: 'prompt',
    promptId: 'prompt',
  });
  expect(broker.prepare).not.toHaveBeenCalled();
  expect((await session.sink.project()).map((record) => record.type)).toEqual([
    'assistant',
  ]);
  const action = session.authority.action(requestId)!;
  expect(action).toMatchObject({
    kind: 'permission',
    source: 'tool_call',
    inputRevision: 1,
  });
  const options = JSON.parse(
    (await session.resources.read(action.optionsRef!)).toString(),
  );
  expect(options).toMatchObject({
    v: 1,
    requestId,
    turnId: 'prompt',
    functionCallId: 'call-1',
    toolName: 'edit',
    policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
    inputRevision: 1,
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ],
  });
  expect(options.createdAt).toBeGreaterThanOrEqual(started);
  expect(options.expiresAt - options.createdAt).toBe(60_000);
  const invocationRef = (await checkpoint()).approval?.invocationRef;

  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  });
  const responses = await running;
  expect(
    responses.map((part) => part.functionResponse?.response?.['error']),
  ).toEqual([undefined, undefined]);
  expect(broker.execute).toHaveBeenCalledTimes(2);
  expect(actionIds()).toEqual([requestId]);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.intent')
      .map((event) => event.payload['argsRef']),
  ).toContainEqual(invocationRef);
  expect((await checkpoint()).continuation.phase).toBe('results_ready');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toMatchObject({ status: 200 });
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('deny')),
  ).resolves.toEqual({ status: 409, code: 'action_already_resolved' });
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('refuses a denied call in the model order and still runs the rest', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1], calls[0]],
    [parts[1], parts[0]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('deny')),
  ).resolves.toMatchObject({ status: 200 });
  const responses = await running;
  expect(broker.prepare).toHaveBeenCalledOnce();
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    'call-1',
    'call-0',
  ]);
  expect(responses[0].functionResponse?.response).toEqual({
    error: 'The Session owner denied this tool call, so it was not run.',
  });
  expect(responses[1].functionResponse?.response?.['executionStatus']).toBe(
    'success',
  );
  expect(await toolResults()).toEqual([['call-1'], ['call-0']]);
  expect(
    (await checkpoint()).tools?.items.map((item) => item.functionCallId),
  ).toEqual(['call-0']);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.intent'),
  ).toHaveLength(1);
});

it('commits only refusals when every asked call is denied', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  const responses = await running;
  expect(responses).toHaveLength(1);
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'denied',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(await toolResults()).toEqual([['call-1']]);
  expect((await checkpoint()).continuation.phase).toBe(
    'model_output_committed',
  );
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('asks one call at a time in the model order', async () => {
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    calls[1],
  ];
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  const first = await requested(1);
  expect(actionIds()).toEqual([first]);
  await resolveHostedAction(session, waiters, first, answer('allow'));
  const second = await requested(2);
  const options = JSON.parse(
    (
      await session.resources.read(
        session.authority.action(second)!.optionsRef!,
      )
    ).toString(),
  );
  expect(options).toMatchObject({ functionCallId: 'call-1', toolName: 'edit' });
  await resolveHostedAction(session, waiters, second, answer('deny'));
  const responses = await running;
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(
    responses.map((part) => !!part.functionResponse?.response?.['error']),
  ).toEqual([false, true]);
});

it.each(['yolo', 'auto-edit'] as const)(
  'does not ask before file calls in %s mode',
  async (mode) => {
    turn = createTurn(false, { mode });
    await turn.execute(calls, parts, 'model', new AbortController().signal);
    expect(actionIds()).toEqual([]);
    expect(broker.execute).toHaveBeenCalledTimes(2);
  },
);

it('refuses a call whose approval expires unanswered', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 1_000 });
  const responses = await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const [requestId] = actionIds();
  expect(session.authority.action(requestId)?.state).toBe('expired');
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'expired',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
  const publish = vi.spyOn(session.resources, 'publish');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'action_expired' });
  expect(publish).not.toHaveBeenCalled();
});

it('expires an approval that is answered after its expiry', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const late = Date.now() + 60_000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(late);
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'action_expired' });
  now.mockRestore();
  const responses = await running;
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'expired',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('cancels a waiting approval and refuses every call when the turn aborts', async () => {
  turn = createTurn(false, { mode: 'default' });
  const controller = new AbortController();
  const running = turn.execute(calls, parts, 'model', controller.signal);
  const requestId = await requested();
  controller.abort(new Error('turn cancelled'));
  await expect(running).rejects.toThrow('turn cancelled');
  expect(session.authority.action(requestId)?.state).toBe('cancelled');
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(await toolResults()).toEqual([['call-0', 'call-1']]);
  expect((await checkpoint()).continuation.phase).toBe(
    'model_output_committed',
  );
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'action_cancelled' });
});

it('refuses an Action response that does not match the request', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  for (const id of ['tool_approval_' + '0'.repeat(32), 'call-1'])
    await expect(
      resolveHostedAction(session, waiters, id, answer('allow')),
    ).resolves.toEqual({ status: 404, code: 'action_not_found' });
  for (const body of [
    answer('maybe'),
    answer('allow', { inputRevision: 2 }),
    answer('allow', { policyRevision: 'preapproved-workspace-tools/1' }),
    answer('allow', { note: 'extra' }),
    { optionId: 'allow' },
    null,
    ['allow'],
  ])
    await expect(
      resolveHostedAction(session, waiters, requestId, body),
    ).resolves.toEqual({ status: 400, code: 'invalid_action_response' });
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await resolveHostedAction(session, waiters, requestId, answer('allow'));
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('keeps an answer retryable when it fails before any write', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  vi.spyOn(session.resources, 'read').mockRejectedValueOnce(
    new Error('store unavailable'),
  );
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).rejects.toThrow('store unavailable');
  now.mockRestore();
  expect(session.authority.writesStopped).toBe(false);
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toMatchObject({ status: 200 });
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('stops the Turn when a late answer cannot record the expiry', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  vi.spyOn(
    LocalJsonlManagedSessionJournalHandle.prototype,
    'appendTransaction',
  ).mockRejectedValueOnce(new Error('journal down'));
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).rejects.toThrow('journal down');
  expect(session.authority.writesStopped).toBe(true);
  await expect(running).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.prepare).not.toHaveBeenCalled();
  // Still late and still requested: the answer must not try to write.
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'hosted_turn_recovery_required' });
  now.mockRestore();
});

it('stops a waiting Turn soon after another write stops the Session', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  await requested();
  vi.spyOn(
    LocalJsonlManagedSessionJournalHandle.prototype,
    'appendTransaction',
  ).mockRejectedValueOnce(new Error('journal down'));
  await expect(
    commit('assistant', [{ text: 'title' }], 'model'),
  ).rejects.toThrow('journal down');
  const started = Date.now();
  await expect(running).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('answers what a blocked Session already recorded but writes nothing', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    calls[1],
  ];
  const running = turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  const decided = await requested(1);
  await resolveHostedAction(session, waiters, decided, answer('allow'));
  const waiting = await requested(2);
  await expect(
    resolveHostedAction(session, waiters, decided, answer('allow'), () => true),
  ).resolves.toMatchObject({ status: 200 });
  await expect(
    resolveHostedAction(session, waiters, decided, answer('deny'), () => true),
  ).resolves.toEqual({ status: 409, code: 'action_already_resolved' });
  const publish = vi.spyOn(session.resources, 'publish');
  await expect(
    resolveHostedAction(session, waiters, waiting, answer('allow'), () => true),
  ).resolves.toEqual({ status: 409, code: 'hosted_turn_recovery_required' });
  expect(publish).not.toHaveBeenCalled();
  expect(session.authority.action(waiting)?.state).toBe('requested');
  await resolveHostedAction(session, waiters, waiting, answer('deny'));
  await running;
});

it('stops asking once an approval in the Turn has expired', async () => {
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    calls[1],
  ];
  const batchParts = batch.map((call) => ({
    functionCall: { id: call.callId, name: call.name, args: call.args },
  }));
  turn = createTurn(false, { mode: 'default', timeoutMs: 1_000 });
  const responses = await turn.execute(
    batch,
    batchParts,
    'model',
    new AbortController().signal,
  );
  expect(actionIds()).toHaveLength(1);
  expect(
    responses.map((part) => part.functionResponse?.response?.['error']),
  ).toEqual([
    'Nobody answered the approval request before it expired, so this tool call was not run.',
    'An earlier approval request in this turn expired unanswered, so this tool call was not asked about or run.',
  ]);
  const next = await turn.execute(
    [calls[0], calls[1]],
    [parts[0], parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(actionIds()).toHaveLength(1);
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(next[1].functionResponse?.response?.['error']).toContain(
    'expired unanswered',
  );
});

it('keeps a decision that lands just before the waiter ends the Action', async () => {
  turn = createTurn(false, { mode: 'default' });
  const controller = new AbortController();
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    controller.signal,
  );
  const requestId = await requested();
  const original = session.authority.resolveAction.bind(session.authority);
  vi.spyOn(session.authority, 'resolveAction').mockImplementationOnce(
    async (command, request) => {
      // The owner's answer is recorded between the waiter's check and its
      // own attempt to end the Action.
      await resolveHostedAction(session, waiters, requestId, answer('allow'));
      return original(command, request);
    },
  );
  controller.abort(new Error('turn cancelled'));
  await expect(running).rejects.toThrow('turn cancelled');
  expect(session.authority.action(requestId)?.state).toBe('decided');
  expect(broker.prepare).not.toHaveBeenCalled();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('reports an answer that loses the race to the expiry as expired', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const original = session.authority.resolveAction.bind(session.authority);
  vi.spyOn(session.authority, 'resolveAction').mockImplementationOnce(
    async (command, request) => {
      await original(
        { ...command, commandId: `${command.commandId}:race` },
        { requestId, state: 'expired', decisionRef: null },
      );
      return original(command, request);
    },
  );
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'action_expired' });
  waiters.notify(requestId);
  const responses = await running;
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'expired',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('blocks recovery when the refusals do not fit durably', async () => {
  turn = createTurn(false, { mode: 'default' });
  messageFitsInline.mockImplementation(
    (...args: unknown[]) => args[0] !== 'tool_result',
  );
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  await resolveHostedAction(
    session,
    waiters,
    await requested(),
    answer('deny'),
  );
  await expect(running).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(await toolResults()).toEqual([]);
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
});

it('does not ask about later calls once the turn is cancelled', async () => {
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    calls[1],
  ];
  turn = createTurn(false, { mode: 'default' });
  const controller = new AbortController();
  const publish = vi.spyOn(session.resources, 'publish');
  const running = turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    controller.signal,
  );
  const first = await requested();
  controller.abort(new Error('turn cancelled'));
  await expect(running).rejects.toThrow('turn cancelled');
  expect(actionIds()).toEqual([first]);
  expect(
    publish.mock.calls.filter(([kind]) => kind === 'managed-action-options'),
  ).toHaveLength(1);
  expect(session.authority.action(first)?.state).toBe('cancelled');
  expect(await toolResults()).toEqual([['call-0', 'call-1']]);
});

it('opens no Action when the turn is cancelled while one is prepared', async () => {
  turn = createTurn(false, { mode: 'default' });
  const controller = new AbortController();
  const publish = session.resources.publish.bind(session.resources);
  vi.spyOn(session.resources, 'publish').mockImplementation(
    async (kind, bytes) => {
      if (kind === 'managed-action-options')
        controller.abort(new Error('turn cancelled'));
      return publish(kind, bytes);
    },
  );
  await expect(
    turn.execute(calls, parts, 'model', controller.signal),
  ).rejects.toThrow('turn cancelled');
  expect(actionIds()).toEqual([]);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(await toolResults()).toEqual([['call-0', 'call-1']]);
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('asks before Shell in auto-edit mode and runs the edit when Shell is denied', async () => {
  turn = createTurn(true, { mode: 'auto-edit' });
  const register = vi.spyOn(HostedShellPublisher.prototype, 'register');
  const shell = {
    ...calls[0],
    name: 'run_shell_command',
    callId: 'call-1',
    args: { command: 'rm -rf build' },
  };
  const batch = [calls[1], shell].map((call, index) => ({
    ...call,
    callId: `call-${index}`,
  }));
  const running = turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const action = session.authority.action(requestId)!;
  expect(
    JSON.parse((await session.resources.read(action.optionsRef!)).toString()),
  ).toMatchObject({ functionCallId: 'call-1', toolName: 'run_shell_command' });
  expect(broker.registerPublisher).toHaveBeenCalledOnce();
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  const responses = await running;
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(register).not.toHaveBeenCalled();
  expect(
    responses.map((part) => part.functionResponse?.response?.['error']),
  ).toEqual([
    undefined,
    'The Session owner denied this tool call, so it was not run.',
  ]);
});

it('writes nothing once the Turn blocks during an answer', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  let blocked = false;
  const read = session.resources.read.bind(session.resources);
  vi.spyOn(session.resources, 'read').mockImplementationOnce(async (ref) => {
    blocked = true;
    return read(ref);
  });
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => blocked,
    ),
  ).resolves.toEqual({ status: 409, code: 'hosted_turn_recovery_required' });
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await resolveHostedAction(session, waiters, requestId, answer('allow'));
  await running;
});

it('replays a decision recorded while the answer was being read', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const read = session.resources.read.bind(session.resources);
  vi.spyOn(session.resources, 'read').mockImplementationOnce(async (ref) => {
    const bytes = await read(ref);
    await resolveHostedAction(session, waiters, requestId, answer('allow'));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    return bytes;
  });
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => true,
    ),
  ).resolves.toMatchObject({ status: 200 });
  vi.mocked(Date.now).mockRestore();
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});
