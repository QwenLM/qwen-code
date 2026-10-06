/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
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
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  createHttpManagedSessionStores,
  ManagedSessionStoreHttpError,
  type HttpToolPublicationOwner,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { LocalJsonlManagedSessionJournalHandle } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { readManagedSessionRecords } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-projection.js';
import {
  readHostedFileHistory,
  commitHostedFileHistory,
} from './hosted-file-history.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { HostedHookSession } from './hosted-hook-session.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { boundedShellPreview } from './managed-shell-publisher.js';
import {
  HostedWorkspaceBrokerRejection,
  type HostedWorkspaceBroker,
} from './hosted-workspace-broker.js';
import {
  HostedWorkspaceToolTurn,
  HostedToolRecoveryRequiredError,
  HOSTED_WORKSPACE_FILE_TOOLS,
  HOSTED_WORKSPACE_SHELL_TOOLS,
  HOSTED_INPUT_PREVIEW_TOOLS,
  type HostedShellTurnOptions,
} from './hosted-workspace-tool-turn.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  hostedActionAllowed,
  resolveHostedAction,
  type HostedApprovalMode,
} from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';

const broker = vi.hoisted(() => ({
  fileHistory: vi.fn(),
  warm: vi.fn(),
  acquire: vi.fn(),
  prepare: vi.fn(),
  prepareV3: vi.fn(),
  execute: vi.fn(),
  executeV3: vi.fn(),
  acknowledgeV3: vi.fn(),
  cancel: vi.fn(),
  release: vi.fn(),
  registerPublisher: vi.fn(),
  acknowledge: vi.fn(),
}));
// child_run is enabled by the H3 enablement slice; background tests flip
// this per case, per the same harness the core suites use.
const enablement = vi.hoisted(() => ({
  childRun: false,
  monitorRun: false,
}));
vi.mock('./hosted-workspace-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-workspace-broker.js')>()),
  HostedWorkspaceBroker: class {
    readonly runtimeSessionId = 'prompt';
    fileHistory = broker.fileHistory;
    warm = broker.warm;
    acquire = broker.acquire;
    prepare = broker.prepare;
    prepareV3 = broker.prepareV3;
    execute = broker.execute;
    executeV3 = broker.executeV3;
    acknowledgeV3 = broker.acknowledgeV3;
    cancel = broker.cancel;
    release = broker.release;
    registerPublisher = broker.registerPublisher;
    acknowledge = broker.acknowledge;
  },
}));
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
    return {
      ...actual,
      assertManagedSessionDomainEnabled: (
        domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
      ) => {
        if (domain === 'child_run' && enablement.childRun) return;
        if (domain === 'monitor_run' && enablement.monitorRun) return;
        actual.assertManagedSessionDomainEnabled(domain);
      },
    };
  },
);
let root: string;
let session: ManagedSession;
let harness: ReturnType<typeof createManagedHarnessHandle>;
let turn: HostedWorkspaceToolTurn;
let commit: ConstructorParameters<typeof HostedWorkspaceToolTurn>[4];
const messageFitsInline = vi.fn<
  ConstructorParameters<typeof HostedWorkspaceToolTurn>[5]
>(() => true);
let waiters: HostedApprovalWaiters;
let expectWritesStopped: boolean;
function createTurn(
  shell = false,
  approval?: { mode: HostedApprovalMode; timeoutMs?: number },
  hooks?: HostedHookSession,
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
    undefined,
    approval && {
      settings: {
        mode: approval.mode,
        timeoutMs: approval.timeoutMs ?? 60_000,
      },
      waiters,
    },
    undefined,
    undefined,
    hooks,
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
  expectWritesStopped = false;
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
  broker.fileHistory.mockResolvedValue({
    ownerSessionId: sessionKey.sessionId,
    snapshots: [],
    files: {},
  });
  harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  broker.prepare.mockImplementation(async () => randomUUID());
  broker.execute.mockResolvedValue({
    executionStatus: 'success',
    responseParts: [{ text: 'original result' }],
  });
  commit = async (type, messageParts, model, identity) => {
    const uuid = identity?.uuid ?? randomUUID();
    await session.sink.write({
      uuid,
      parentUuid: null,
      sessionId: sessionKey.sessionId,
      timestamp: identity?.timestamp ?? new Date().toISOString(),
      model,
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
  enablement.childRun = false;
  enablement.monitorRun = false;
  await turn?.close();
  vi.restoreAllMocks();
  // A Session whose writes stopped cannot record its own close.
  if (expectWritesStopped)
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
    expect(authorization.checkpoint.identity).toMatchObject({
      turnId: 'prompt',
      promptId: 'prompt',
    });
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

async function shellReceiptScenario(
  mode:
    | 'normal'
    | 'abandoned'
    | 'mismatched'
    | 'truncated'
    | 'large'
    | 'sentinel'
    | 'lost-admission'
    | 'lost-reserve',
) {
  const shellCall = {
    ...calls[0],
    name: 'run_shell_command',
    callId: 'shell-call',
    args: { command: 'printf hi' },
  };
  const shellParts: Part[] = [
    {
      functionCall: {
        id: shellCall.callId,
        name: shellCall.name,
        args: shellCall.args,
      },
    },
  ];
  const manifest = await session.resources.publish(
    'managed-tool-result-manifest',
    Buffer.from('{}'),
  );
  const sentinelOutput =
    'Tool output was too large and has been truncated.\nreal payload\n';
  const envelope = {
    executionStatus: 'success' as const,
    responseParts:
      mode === 'truncated'
        ? boundedShellPreview([{ text: `HEAD\n${'x'.repeat(10_000)}\nTAIL` }])
        : [
            {
              text:
                mode === 'sentinel'
                  ? sentinelOutput
                  : mode === 'large'
                    ? `HEAD\n${'x'.repeat(66_000)}\nExit Code: 2`
                    : 'hi',
            },
          ],
    capture: {
      manifest,
      captureStatus: 'complete' as const,
      captureReason: null,
      previewTruncated: mode === 'truncated' || mode === 'large',
      deliveryStatus: 'pending' as const,
    },
  };
  const order: string[] = [];
  let originalBinding: unknown;
  broker.prepareV3.mockResolvedValue({
    executionCallId: 'shell-execution',
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  });
  broker.executeV3.mockImplementation(async () => {
    order.push('execute');
    expect(session.authority.latestCheckpoint?.boundary).toBe('durable_wait');
    if (
      mode !== 'normal' &&
      mode !== 'truncated' &&
      mode !== 'large' &&
      mode !== 'sentinel' &&
      mode !== 'lost-admission' &&
      mode !== 'lost-reserve'
    )
      throw new HostedWorkspaceBrokerRejection(
        409,
        'runtime_broker_execution_unknown',
      );
    return envelope;
  });
  broker.acknowledgeV3.mockImplementation(async () => {
    order.push('ack');
    expect((await session.sink.project()).at(-1)?.type).toBe('tool_result');
    expect(session.authority.latestCheckpoint?.boundary).toBeNull();
    if (mode === 'abandoned')
      throw new HostedWorkspaceBrokerRejection(
        409,
        'runtime_broker_execution_unknown',
      );
  });
  let admissionRef: ManagedSessionDurableRef | undefined;
  let admissionBody: string | undefined;
  const request = vi.fn(async (route: string, body: unknown) => {
    if (route === '/grants') {
      order.push(
        (body as { operation: string }).operation === 'renew'
          ? 'renew'
          : 'reserve',
      );
      if ((body as { operation: string }).operation === 'reserve')
        originalBinding = (body as { binding: unknown }).binding;
      if (
        mode === 'lost-reserve' &&
        order.filter((step) => step === 'reserve').length === 1
      )
        throw new TypeError('Reservation response lost.');
      return { state: 'OPEN' };
    }
    if (route.endsWith('/finished')) {
      order.push('finished');
      return {
        binding:
          mode === 'mismatched'
            ? { ...(originalBinding as object), captureId: randomUUID() }
            : originalBinding,
        result: envelope,
      };
    }
    if (route.endsWith('/admissions/prepare')) {
      order.push('admission');
      const bytes = JSON.stringify(body);
      if (admissionBody && admissionBody !== bytes)
        throw new Error('Admission changed on replay.');
      admissionBody = bytes;
      admissionRef ??= await session.resources.publish(
        'managed-tool-outcome',
        Buffer.from(bytes),
      );
      if (
        mode === 'lost-admission' &&
        order.filter((step) => step === 'admission').length === 1
      )
        throw new TypeError('Admission response lost.');
      return admissionRef;
    }
    throw new Error('Unexpected publication route ' + route);
  });
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    request,
    rememberAdmission: vi.fn(),
  } as unknown as HttpToolPublicationOwner;
  const originalAppend = session.authority.appendExecutionEvent.bind(
    session.authority,
  );
  vi.spyOn(session.authority, 'appendExecutionEvent').mockImplementation(
    async (...args) => {
      if (args[0].operation === 'recordToolResult') order.push('receipt');
      return originalAppend(...args);
    },
  );
  const shellTurn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async (type, messageParts, model, identity) => {
      order.push(type);
      const uuid = identity?.uuid ?? randomUUID();
      await session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        cwd: root,
        version: 'test',
        daemonPromptId: 'prompt',
        model,
        message: {
          role: type === 'assistant' ? 'model' : 'user',
          parts: messageParts,
        },
      });
      return uuid;
    },
    (_type, messageParts) =>
      mode !== 'large' ||
      Buffer.byteLength(JSON.stringify(messageParts)) <= 64 * 1024,
    { owner, captureBytes: 1024 * 1024 },
  );
  const execution = shellTurn.execute(
    [shellCall],
    shellParts,
    'model',
    new AbortController().signal,
  );
  if (mode === 'mismatched') {
    await expect(execution).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.executeV3).toHaveBeenCalledOnce();
    expect(
      session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'tool.receipt'),
    ).toHaveLength(0);
    expect(broker.acknowledgeV3).not.toHaveBeenCalled();
    return;
  }
  const result = await execution;
  expect(broker.executeV3).toHaveBeenCalledOnce();
  expect(result[0]?.functionResponse?.response).toMatchObject({
    output:
      mode === 'truncated'
        ? expect.stringContaining('TAIL')
        : mode === 'large'
          ? expect.stringContaining('Exit Code: 2')
          : mode === 'sentinel'
            ? sentinelOutput
            : 'hi',
    manifestRef: manifest,
    captureStatus: 'complete',
    previewTruncated: mode === 'truncated' || mode === 'large',
  });
  if (mode === 'truncated')
    expect(JSON.stringify(result)).toContain('preview truncated');
  expect(order).toEqual([
    'assistant',
    'reserve',
    ...(mode === 'lost-reserve' ? ['reserve'] : []),
    'renew',
    'execute',
    ...(mode === 'abandoned' ? ['finished'] : []),
    'finished',
    'admission',
    ...(mode === 'lost-admission' ? ['admission'] : []),
    'receipt',
    'tool_result',
    'ack',
  ]);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.receipt'),
  ).toHaveLength(1);
  expect(broker.acknowledgeV3.mock.calls[0]?.[0]).toBe('shell-execution');
  const publicationId = broker.prepareV3.mock.calls[0]?.[3] as string;
  if (mode === 'lost-reserve') {
    const reservations = request.mock.calls.filter(
      ([route, body]) =>
        route === '/grants' &&
        (body as { operation: string }).operation === 'reserve',
    );
    expect(reservations).toHaveLength(2);
    expect(reservations[0]).toEqual(reservations[1]);
  }
  broker.acknowledgeV3.mockRejectedValueOnce(new Error('ACK transport down'));
  const replayed = await (
    shellTurn as unknown as {
      acceptShell: (
        call: typeof shellCall,
        executionCallId: string,
        publicationId: string,
        publicationToken: string,
        result: typeof envelope,
        model: string,
      ) => Promise<Part[]>;
    }
  ).acceptShell(
    shellCall,
    'shell-execution',
    publicationId,
    'unused-token',
    envelope,
    'model',
  );
  expect(replayed).toEqual(result);
  expect(
    request.mock.calls.filter(([route]) =>
      String(route).endsWith('/admissions/prepare'),
    ),
  ).toHaveLength(mode === 'lost-admission' ? 2 : 1);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.receipt'),
  ).toHaveLength(1);
}

it.each([
  'normal',
  'abandoned',
  'mismatched',
  'truncated',
  'large',
  'sentinel',
  'lost-admission',
  'lost-reserve',
] as const)(
  'uses only the original Shell publication after Broker %s',
  shellReceiptScenario,
);

it('records a durable receipt for a proven unstarted Shell', async () => {
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    callId: 'shell-call',
    args: { command: 'printf hi' },
  };
  const shellParts: Part[] = [
    {
      functionCall: { id: call.callId, name: call.name, args: call.args },
    },
  ];
  const envelope = {
    executionStatus: 'not_started' as const,
    responseParts: [],
    error: { message: 'Blocked: split the command into two calls.' },
    capture: null,
  };
  broker.prepareV3.mockResolvedValue({
    executionCallId: 'shell-execution',
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  });
  broker.executeV3.mockResolvedValue(envelope);
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    request: vi.fn(async (route: string, body: { operation: string }) => {
      expect(route).toBe('/grants');
      return {
        state: body.operation === 'close_not_started' ? 'NOT_STARTED' : 'OPEN',
      };
    }),
  } as unknown as HttpToolPublicationOwner;
  turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    { owner, captureBytes: 1024 * 1024 },
  );
  const result = await turn.execute(
    [call],
    shellParts,
    'model',
    new AbortController().signal,
  );
  expect(result[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'not_started',
    error: envelope.error.message,
  });
  expect(
    (await session.sink.project()).at(-1)?.message?.parts?.[0]?.functionResponse
      ?.response?.['error'],
  ).toBe(envelope.error.message);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.payload['resultRef']).toBeNull();
  const ref = assertManagedSessionDurableRef(
    receipts[0]?.payload['toolOutcomeRef'],
    'unstarted Shell outcome',
  );
  expect(
    JSON.parse((await session.resources.read(ref)).toString()),
  ).toMatchObject({
    schemaVersion: 1,
    decision: 'blocked',
    envelope,
    manifestRef: null,
    history: { model: 'model', parts: result },
  });
  expect(broker.acknowledgeV3).not.toHaveBeenCalled();
});

it('closes proven unstarted reservations after a later batch reservation fails', async () => {
  const shellCalls = [0, 1].map((index) => ({
    ...calls[index],
    name: 'run_shell_command',
    args: { command: `printf ${index}` },
  }));
  const shellParts: Part[] = shellCalls.map((call) => ({
    functionCall: { id: call.callId, name: call.name, args: call.args },
  }));
  broker.prepareV3.mockImplementation(async () => ({
    executionCallId: `shell-execution-${broker.prepareV3.mock.calls.length}`,
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  }));
  const events: string[] = [];
  const request = vi.fn(async (route: string, body: unknown) => {
    expect(route).toBe('/grants');
    const operation = (body as { operation: string }).operation;
    events.push(operation);
    if (
      operation === 'reserve' &&
      events.filter((e) => e === 'reserve').length === 2
    )
      throw new Error('Publication capacity exhausted');
    return {
      state: operation === 'close_not_started' ? 'NOT_STARTED' : 'OPEN',
    };
  });
  broker.cancel.mockImplementation(async () => {
    events.push('cancel');
  });
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    request,
  } as unknown as HttpToolPublicationOwner;
  const shellTurn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async (type, messageParts) => {
      const uuid = randomUUID();
      await session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        type,
        cwd: root,
        version: 'test',
        daemonPromptId: 'prompt',
        message: { role: 'model', parts: messageParts },
      });
      return uuid;
    },
    () => true,
    { owner, captureBytes: 1024 * 1024 },
  );
  await expect(
    shellTurn.execute(
      shellCalls,
      shellParts,
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(events).toEqual([
    'reserve',
    'reserve',
    'cancel',
    'cancel',
    'close_not_started',
    'close_not_started',
  ]);
  expect(
    request.mock.calls
      .filter(
        ([, body]) =>
          (body as { operation: string }).operation === 'close_not_started',
      )
      .map(([, body]) => (body as { publicationId: string }).publicationId)
      .sort(),
  ).toEqual(broker.prepareV3.mock.calls.map((call) => call[3]).sort());
  expect(broker.executeV3).not.toHaveBeenCalled();
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
    // Arguments that arrived unterminated are refused even when the output
    // token limit was not what cut them: this profile writes to a remote
    // Workspace with no undo backup (#12970).
    { ...calls[0], hadIncompleteArguments: true },
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

it('offers glob only under the /2 Workspace profiles', async () => {
  const signal = new AbortController().signal;
  const advertised = async (profile?: string, shell = false) =>
    (
      await new HostedWorkspaceToolTurn(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        harness,
        'prompt',
        commit,
        messageFitsInline,
        shell
          ? { resources: session.resources, assertWritable: async () => {} }
          : undefined,
        undefined,
        undefined,
        undefined,
        profile,
      ).declarations(signal)
    ).map((tool) => tool.name);
  const file = ['read_file', 'write_file', 'edit'];
  const shellTools = [...file, 'run_shell_command', 'monitor'];
  await expect(advertised()).resolves.toEqual(file);
  await expect(advertised('hosted-workspace-files/1')).resolves.toEqual(file);
  await expect(advertised('hosted-workspace-shell/1', true)).resolves.toEqual(
    shellTools,
  );
  await expect(advertised('hosted-workspace-files/2')).resolves.toEqual([
    ...file,
    'glob',
  ]);
  await expect(advertised('hosted-workspace-shell/2', true)).resolves.toEqual([
    ...shellTools,
    'glob',
  ]);
});

function createSearchTurn() {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    undefined,
    'hosted-workspace-files/2',
  );
}

it('refuses a glob call a /1 profile never advertised', async () => {
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: '**/*.ts' },
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
  ).rejects.toThrow('Hosted Workspace profile refused a tool call.');
  expect(broker.acquire).not.toHaveBeenCalled();
});

it.each([
  {},
  { pattern: '' },
  { pattern: '   ' },
  { pattern: 7 },
  { pattern: '/**/*.ts' },
  { pattern: '../**/*' },
  { pattern: '\\.\\./**/*' },
  { pattern: 'src/{x,\\.\\.}/**/*' },
  // The guard must judge the value it dispatches, which is the trimmed one:
  // leading whitespace otherwise masks both shapes past this pre-acquisition
  // refusal and into a durable Runtime round trip.
  { pattern: ' ../**/*' },
  { pattern: '\t/etc/host*' },
  // Brace expansion composes what the literal segment check cannot see,
  // and its cost is bounded before any expansion runs.
  { pattern: '{/etc,/zz-nonexistent}/host*' },
  { pattern: '{.,..}/**/*' },
  { pattern: 'src/{..,x}/**' },
  // Bounded before anything expands it: nesting deep enough to overflow
  // brace-expansion's recursion, a range glob would search 100000 times,
  // and an alternative product that exhausts memory.
  { pattern: '{a,'.repeat(3400) + 'x' + '}'.repeat(3400) },
  { pattern: '{1..100000}/passwd' },
  { pattern: '{9007199254740992..9007199254740992}/*' },
  { pattern: '{a,b}'.repeat(30) },
  { pattern: 'x'.repeat(1025) },
  { pattern: '**/*.ts', path: '/private/secret-host-path' },
  { pattern: '**/*.ts', path: '../escape' },
  { pattern: '**/*.ts', path: 'a\\b' },
  { pattern: '**/*.ts', path: 5 },
])(
  'persists correctable glob argument errors without dispatch: %j',
  async (args) => {
    turn = createSearchTurn();
    const call = { ...calls[0], name: 'glob', args };
    const original = [
      { functionCall: { id: call.callId, name: call.name, args: call.args } },
    ];
    const responses = await turn.execute(
      [call],
      original,
      'model',
      new AbortController().signal,
    );
    const error = responses[0].functionResponse?.response?.['error'];
    expect(responses[0].functionResponse?.id).toBe(call.callId);
    expect(error).toContain('glob');
    expect(error).toContain('retry');
    expect(error).not.toContain('secret-host-path');
    const history = await session.sink.project();
    expect(history.slice(-2).map((record) => record.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(history.at(-2)?.message?.parts).toEqual(original);
    expect(history.at(-1)?.message?.parts).toEqual(responses);
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toBeUndefined();
  },
);

it('normalizes a glob pattern and path before dispatch', async () => {
  turn = createSearchTurn();
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: ' **/*.ts ', path: ' ./src//nested ' },
  };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const payload = JSON.parse(broker.execute.mock.calls[0][1]);
  expect(payload).toEqual({
    toolName: 'glob',
    input: { pattern: '**/*.ts', path: 'src/nested' },
  });
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('treats a blank glob path as omitted and still dispatches', async () => {
  // The declaration marks `path` optional; an explicit blank must not read
  // as a traversal refusal (which would also poison every valid sibling
  // call in the batch).
  turn = createSearchTurn();
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: '**/*.ts', path: '' },
  };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toBeUndefined();
  expect(broker.execute).toHaveBeenCalledOnce();
  const payload = JSON.parse(broker.execute.mock.calls[0][1]);
  expect(payload.input).toEqual({ pattern: '**/*.ts' });
  await turn.consumeResults();
  await turn.finish();
});

it('treats a null glob path as omitted and still dispatches the whole batch', async () => {
  // `null` is one more provider encoding of an unset optional. Argument
  // validation is batch-wide, so refusing it as traversal would also cancel
  // the valid sibling call in the same turn.
  turn = createSearchTurn();
  const nullPath = {
    ...calls[0],
    name: 'glob',
    args: { pattern: '**/*.ts', path: null },
  };
  const sibling = { ...calls[1], name: 'glob', args: { pattern: '*.md' } };
  const responses = await turn.execute(
    [nullPath, sibling],
    [nullPath, sibling].map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  for (const response of responses)
    expect(response.functionResponse?.response?.['error']).toBeUndefined();
  expect(broker.execute).toHaveBeenCalledTimes(2);
  expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual({
    pattern: '**/*.ts',
  });
  await turn.consumeResults();
  await turn.finish();
});

it('truncates an oversized glob result to a fitting prefix with a narrowing hint', async () => {
  turn = createSearchTurn();
  messageFitsInline.mockImplementation(
    (type, messageParts) =>
      Buffer.byteLength(
        JSON.stringify({
          uuid: randomUUID(),
          parentUuid: null,
          sessionId: session.authority.sessionHeader.sessionKey.sessionId,
          timestamp: new Date().toISOString(),
          type,
          cwd: root,
          version: 'test',
          daemonPromptId: 'prompt',
          message: {
            role: type === 'assistant' ? 'model' : 'user',
            parts: messageParts,
          },
        }),
      ) <=
      64 * 1024,
  );
  const lines = Array.from(
    { length: 400 },
    (_, index) =>
      `src/file-${String(index).padStart(3, '0')}-${'x'.repeat(150)}.ts`,
  );
  broker.execute.mockResolvedValue({
    executionStatus: 'success',
    responseParts: [
      {
        text: `Found ${lines.length} file(s) matching "**/*.ts" in the workspace directory, sorted by modification time (newest first):\n---\n${lines.join('\n')}`,
      },
    ],
  });
  const publish = vi.spyOn(session.resources, 'publish');
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: '**/*.ts' },
  };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const response = responses[0].functionResponse?.response;
  expect(response?.['executionStatus']).toBe('success');
  expect(response?.['outputTruncated']).toBe(true);
  const output = response?.['output'];
  expect(typeof output).toBe('string');
  expect(output).toContain('file-000');
  expect(output).not.toContain('file-399');
  expect(output).toContain('Narrow the pattern or path.');
  expect(response).not.toHaveProperty('outputOmitted');
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
  'allows recovery acquisition to retry after a definite %s refusal',
  async (code) => {
    const refusal = new HostedWorkspaceBrokerRejection(409, code);
    broker.acquire.mockRejectedValueOnce(refusal);
    await expect(turn.resumeCommittedResults()).rejects.toBe(refusal);
    await expect(turn.finish()).resolves.toBeUndefined();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.release).not.toHaveBeenCalled();
    await turn.resumeCommittedResults();
    expect(broker.acquire).toHaveBeenCalledTimes(2);
  },
);

it.each([
  new Error('lost recovery acquire response'),
  new HostedWorkspaceBrokerRejection(503, 'workspace_unavailable'),
  new HostedWorkspaceBrokerRejection(409, 'runtime_session_acquire_failed'),
])('keeps ambiguous recovery acquisition blocked: %s', async (cause) => {
  broker.acquire.mockRejectedValueOnce(cause);
  await expect(turn.resumeCommittedResults()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.release).not.toHaveBeenCalled();
});

it('allows another attempt after a definite workspace_unavailable acquire refusal', async () => {
  const refusal = new HostedWorkspaceBrokerRejection(
    409,
    'workspace_unavailable',
  );
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
});

it('queues a definite workspace_busy acquire refusal until the mount frees', async () => {
  const log = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  broker.acquire.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
  );
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  await turn.consumeResults();
  await turn.finish();
  expect(broker.acquire).toHaveBeenCalledTimes(2);
  expect(broker.release).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining(
      'waits for the Workspace mount held by another Session.',
    ),
  );
});

it('keeps polling across repeated workspace_busy refusals until the mount frees', async () => {
  const log = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  broker.acquire
    .mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    )
    .mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    );
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  await turn.consumeResults();
  await turn.finish();
  expect(broker.acquire).toHaveBeenCalledTimes(3);
  expect(broker.release).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledTimes(1);
});

it('cancels a queued workspace_busy acquisition with the turn', async () => {
  const controller = new AbortController();
  broker.acquire.mockImplementation(async () => {
    queueMicrotask(() => controller.abort());
    throw new HostedWorkspaceBrokerRejection(409, 'workspace_busy');
  });
  const rejection = await turn
    .execute(calls, parts, 'model', controller.signal)
    .then(
      () => {
        throw new Error('expected the queued acquisition to reject');
      },
      (cause: unknown) => cause,
    );
  expect(rejection).toBe(controller.signal.reason);
  await expect(turn.finish()).resolves.toBeUndefined();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
});

it('keeps an ambiguous queued-acquire failure recovery-blocking even when the turn is cancelled', async () => {
  const controller = new AbortController();
  broker.acquire
    .mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    )
    .mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('lost acquire response');
    });
  await expect(
    turn.execute(calls, parts, 'model', controller.signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.release).not.toHaveBeenCalled();
});

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

it.each(['files', 'shell', 'mcp'])(
  'discloses the %s backup contract without changing shared or MCP tools',
  async (profile) => {
    const remote = { name: 'mcp_write', description: 'Remote server tool.' };
    const mcp = {
      broker,
      ensureReady: async () => undefined,
      refresh: async () => undefined,
      tools: () => [remote],
    };
    const original = structuredClone(HOSTED_WORKSPACE_FILE_TOOLS);
    const described = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      profile === 'shell'
        ? {
            resources: session.resources,
            assertWritable: async () => undefined,
          }
        : undefined,
      undefined,
      undefined,
      profile === 'mcp'
        ? (mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession)
        : undefined,
    );
    const declarations = await described.declarations(
      new AbortController().signal,
    );
    for (const name of ['write_file', 'edit']) {
      const description = declarations.find(
        (tool) => tool.name === name,
      )?.description;
      if (profile === 'mcp') {
        expect(description).toContain('no file backups or undo');
        expect(description).not.toContain('preimages are backed up');
      } else {
        expect(description).toContain('preimages are backed up');
        expect(description).toContain('content or permissions');
        expect(description).toContain('same prompt');
        expect(description).toContain('validate a fresh backup');
      }
    }
    if (profile === 'shell')
      expect(
        declarations.find((tool) => tool.name === 'run_shell_command')
          ?.description,
      ).toContain('Shell file mutations are not backed up');
    else
      expect(
        declarations.find((tool) => tool.name === 'run_shell_command'),
      ).toBeUndefined();
    if (profile === 'mcp') {
      expect(declarations.map((tool) => tool.name)).toEqual([
        'read_file',
        'write_file',
        'edit',
        'mcp_write',
      ]);
      expect(declarations.at(-1)).toEqual(remote);
    }
    expect(declarations.find((tool) => tool.name === 'read_file')).toEqual(
      original[0],
    );
    expect(HOSTED_WORKSPACE_FILE_TOOLS).toEqual(original);
    await described.close();
  },
);

it.each(['refresh', 'warmup'] as const)(
  'aborts MCP %s without waiting for the original work to finish',
  async (phase) => {
    const pending = new Promise<void>(() => undefined);
    const refresh = vi.fn(() =>
      phase === 'refresh' ? pending : Promise.resolve(),
    );
    const mcp = {
      broker: { ...broker, runtimeSessionId: 'mcp:session' },
      ensureReady: () => (phase === 'warmup' ? pending : Promise.resolve()),
      refresh,
      tools: () => [],
    };
    const mcpTurn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      undefined,
      undefined,
      undefined,
      mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
    );
    const abort = new AbortController();
    const reason = new Error('cancelled test turn');
    const work =
      phase === 'refresh'
        ? mcpTurn.declarations(abort.signal)
        : mcpTurn.execute([], [], 'model', abort.signal);
    const observed = work.catch((cause: unknown) => cause);
    abort.abort(reason);
    await expect(observed).resolves.toBe(reason);
    expect(broker.prepare).not.toHaveBeenCalled();
    await expect(mcpTurn.execute([], [], 'model', abort.signal)).rejects.toBe(
      reason,
    );
  },
);

it('keeps native file tools in the MCP profile on their existing shared runtime', async () => {
  const mcp = {
    broker: { ...broker, runtimeSessionId: 'mcp:session' },
    ensureReady: async () => undefined,
    refresh: async () => undefined,
    tools: () => [],
    toolInput: () => undefined,
  };
  const mcpTurn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
  );
  await mcpTurn.execute(calls, parts, 'model', new AbortController().signal);
  await mcpTurn.consumeResults();
  await mcpTurn.finish();
  expect(broker.execute).toHaveBeenCalledTimes(2);
  expect(broker.fileHistory).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
});

it('executes against the declarations actually advertised before a catalog replacement', async () => {
  let name = 'mcp_old';
  const input = { toolName: 'managed_mcp_call', input: { pinned: 'original' } };
  const mcp = {
    broker: { ...broker, runtimeSessionId: 'mcp:session' },
    ensureReady: async () => undefined,
    refresh: async () => undefined,
    tools: () => [{ name, parametersJsonSchema: { type: 'object' } }],
    toolInput: vi.fn(() => input),
  };
  const mcpTurn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async () => randomUUID(),
    () => true,
    undefined,
    undefined,
    undefined,
    mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
  );
  expect(
    (await mcpTurn.declarations(new AbortController().signal)).at(-1)?.name,
  ).toBe('mcp_old');
  name = 'mcp_new';
  const call = { ...calls[0], name: 'mcp_old', args: { text: 'hello' } };
  await mcpTurn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(broker.execute).toHaveBeenCalledWith(
    expect.any(String),
    JSON.stringify(input),
    expect.any(AbortSignal),
    630_000,
    true,
  );
  expect(broker.prepare).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringMatching(/^sha256:/u),
    undefined,
    'prompt',
  );
  expect(mcp.toolInput).toHaveBeenCalledWith(
    call.name,
    call.args,
    broker.prepare.mock.calls[0][0],
  );
  const intent = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .find((event) => event.kind === 'tool.intent');
  const saved = await session.resources.read(
    intent!.payload['toolDefinitionRef'] as unknown as ManagedSessionDurableRef,
  );
  expect(JSON.parse(saved.toString()).name).toBe('mcp_old');
  expect(
    (await mcpTurn.declarations(new AbortController().signal)).at(-1)?.name,
  ).toBe('mcp_new');
});
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

it.each([
  [{ command: 'pwd', timeout: 0 }, 'timeout must be an integer'],
  [{ command: 'pwd', is_background: false }, 'foreground command'],
])(
  'returns a durable O2 refusal for invalid Shell arguments %j',
  async (args, message) => {
    const owner = {
      owner: vi.fn(),
      request: vi.fn(),
      rememberAdmission: vi.fn(),
    } as unknown as HttpToolPublicationOwner;
    turn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      { owner, captureBytes: 1024 * 1024 },
    );
    const call = { ...calls[0], name: 'run_shell_command', args };
    const responses = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args } }],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toContain(
      message,
    );
    expect((await session.sink.project()).map((record) => record.type)).toEqual(
      ['assistant', 'tool_result'],
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepareV3).not.toHaveBeenCalled();
    expect(owner.request).not.toHaveBeenCalled();
  },
);

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
      (type, content) =>
        type !== 'tool_result' ||
        !rejectHistory ||
        !content.some((part) => part.functionResponse?.response?.['capture']),
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
  // The Action request commits first and its await_action checkpoint after
  // it, each behind fsynced durable writes; on the coverage-enabled, shared
  // post-merge CI runners the checkpoint lost vitest's 1s default (#13397).
  await vi.waitFor(
    async () => {
      const ids = actionIds();
      expect(ids).toHaveLength(count);
      requestId = ids.at(-1)!;
      expect(session.authority.action(requestId)?.state).toBe('requested');
      expect((await checkpoint()).continuation.phase).toBe('await_action');
    },
    { timeout: 10_000 },
  );
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

async function toolResultErrors() {
  return (await session.sink.project())
    .filter((record) => record.type === 'tool_result')
    .flatMap((record) => record.message?.parts ?? [])
    .map((part) => part.functionResponse?.response?.['error']);
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
  expect(options).toEqual({
    v: 2,
    inputRef: (await checkpoint()).approval!.invocationRef,
    requestId,
    turnId: 'prompt',
    functionCallId: 'call-1',
    toolName: 'edit',
    policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
    inputRevision: 1,
    createdAt: expect.any(Number),
    expiresAt: expect.any(Number),
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
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  });
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
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('deny')),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'deny' },
  });
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

it.each(['allow', 'deny'])(
  'honors %s approval for an MCP call while retaining its shared owner',
  async (optionId) => {
    const input = {
      toolName: 'managed_mcp_call',
      input: { pinned: 'original' },
    };
    let expiresAt = 1;
    const mcp = {
      broker,
      ensureReady: async () => undefined,
      refresh: async () => undefined,
      tools: () => [
        { name: 'mcp_echo', parametersJsonSchema: { type: 'object' } },
      ],
      toolInput: () => ({
        ...input,
        input: { ...input.input, grant: { expiresAt } },
      }),
    };
    turn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      undefined,
      undefined,
      { settings: { mode: 'default', timeoutMs: 60_000 }, waiters },
      mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
    );
    const call = { ...calls[0], name: 'mcp_echo', args: { text: 'hello' } };
    const running = turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    const requestId = await requested();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    const options = JSON.parse(
      (
        await session.resources.read(
          session.authority.action(requestId)!.optionsRef!,
        )
      ).toString(),
    );
    expect(options.v).toBe(1);
    expect(options).not.toHaveProperty('inputRef');
    const approvedRef = (await checkpoint()).approval!.invocationRef!;
    const approved = (await session.resources.read(approvedRef)).toString();
    expiresAt = 2;
    await resolveHostedAction(session, waiters, requestId, answer(optionId));
    const result = await running;
    expect(broker.prepare).toHaveBeenCalledTimes(optionId === 'allow' ? 1 : 0);
    expect(broker.execute).toHaveBeenCalledTimes(optionId === 'allow' ? 1 : 0);
    if (optionId === 'allow') {
      const payload = broker.execute.mock.calls[0][1];
      expect(JSON.parse(payload)).toEqual({
        ...input,
        input: { ...input.input, grant: { expiresAt: 2 } },
      });
      expect(broker.prepare.mock.calls[0][1]).toBe(
        `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      );
      const intent = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .find((event) => event.kind === 'tool.intent')!;
      const routed = JSON.parse(
        (
          await session.resources.read(
            intent.payload['argsRef'] as unknown as ManagedSessionDurableRef,
          )
        ).toString(),
      );
      expect(routed.payloadJson).toBe(payload);
      expect((await session.resources.read(approvedRef)).toString()).toBe(
        approved,
      );
    } else
      expect(result[0].functionResponse?.response?.['error']).toContain(
        'denied',
      );
    await turn.consumeResults();
    await turn.finish();
    expect(broker.release).not.toHaveBeenCalled();
  },
);

it('binds successive approvals for the same tool to their own inputs', async () => {
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    {
      ...calls[1],
      name: 'write_file',
      args: { file_path: 'second.txt', content: 'second' },
    },
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
  const firstOptions = JSON.parse(
    (
      await session.resources.read(session.authority.action(first)!.optionsRef!)
    ).toString(),
  );
  expect(firstOptions.inputRef).toEqual(
    (await checkpoint()).approval!.invocationRef,
  );
  await resolveHostedAction(session, waiters, first, answer('allow'));
  const second = await requested(2);
  const options = JSON.parse(
    (
      await session.resources.read(
        session.authority.action(second)!.optionsRef!,
      )
    ).toString(),
  );
  expect(options).toMatchObject({
    v: 2,
    functionCallId: 'call-1',
    toolName: 'write_file',
    inputRef: (await checkpoint()).approval!.invocationRef,
  });
  expect(options.inputRef).not.toEqual(firstOptions.inputRef);
  for (const [ref, input] of [
    [firstOptions.inputRef, batch[0].args],
    [options.inputRef, batch[1].args],
  ] as const) {
    const captured = JSON.parse((await session.resources.read(ref)).toString());
    expect(JSON.parse(captured.payloadJson)).toEqual({
      toolName: 'write_file',
      input,
    });
  }
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
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => true,
    ),
  ).resolves.toEqual({ status: 409, code: 'action_expired' });
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
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => true,
    ),
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
  expectWritesStopped = true;
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
  const notify = vi.spyOn(waiters, 'notify');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'hosted_turn_recovery_required' });
  expect(notify).toHaveBeenCalledWith(requestId);
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
  expectWritesStopped = true;
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

it('blocks recovery when a refusal record write fails', async () => {
  turn = createTurn(false, { mode: 'default' });
  const write = session.sink.write.bind(session.sink);
  vi.spyOn(session.sink, 'write').mockImplementation(async (record) => {
    if (record.type === 'tool_result') throw new Error('resource unavailable');
    return write(record);
  });
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
  expect(await toolResultErrors()).toEqual([
    'The turn was cancelled before this tool call ran.',
    'The turn was cancelled before this tool call ran.',
  ]);
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
  const options = JSON.parse(
    (await session.resources.read(action.optionsRef!)).toString(),
  );
  expect(options).toMatchObject({
    v: 2,
    functionCallId: 'call-1',
    toolName: 'run_shell_command',
  });
  expect(
    JSON.parse(
      JSON.parse((await session.resources.read(options.inputRef)).toString())
        .payloadJson,
    ).input,
  ).toMatchObject({ command: 'rm -rf build' });
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

it('admits exactly the declared native tools to the version 2 input preview', () => {
  // The Java reader admits a closed set. A name missing on either side degrades
  // to "Tool arguments are unavailable for this approval." with no error, so the
  // set is pinned here and each name must still be a declared native tool.
  expect(HOSTED_INPUT_PREVIEW_TOOLS).toEqual([
    'read_file',
    'write_file',
    'edit',
    'run_shell_command',
  ]);
  const declared = HOSTED_WORKSPACE_SHELL_TOOLS.map((tool) => tool.name);
  for (const name of HOSTED_INPUT_PREVIEW_TOOLS)
    expect(declared).toContain(name);
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

it('answers two identical concurrent decisions alike', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const decided = {
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  };
  await expect(
    Promise.all([
      resolveHostedAction(session, waiters, requestId, answer('allow')),
      resolveHostedAction(session, waiters, requestId, answer('allow')),
    ]),
  ).resolves.toEqual([decided, decided]);
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('answers the same decision that won a race while it was being written', async () => {
  turn = createTurn(false, { mode: 'default' });
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
      // The same decision is recorded first, and this write then conflicts.
      await original(command, request);
      throw new ManagedSessionConflictError('action already decided.');
    },
  );
  const notify = vi.spyOn(waiters, 'notify');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  });
  expect(notify).toHaveBeenCalledWith(requestId);
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('answers the loser of two different concurrent decisions with a conflict', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const results = await Promise.all([
    resolveHostedAction(session, waiters, requestId, answer('allow')),
    resolveHostedAction(session, waiters, requestId, answer('deny')),
  ]);
  const recorded = hostedActionAllowed(
    session.authority.action(requestId)!,
    HOSTED_TOOL_APPROVAL_POLICY,
  )
    ? 'allow'
    : 'deny';
  expect(results).toContainEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: recorded },
  });
  expect(results).toContainEqual({
    status: 409,
    code: 'action_already_resolved',
  });
  await running;
  expect(broker.execute).toHaveBeenCalledTimes(recorded === 'allow' ? 1 : 0);
});

it('writes nothing once the Turn blocks while the decision is published', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  let blocked = false;
  const publish = session.resources.publish.bind(session.resources);
  vi.spyOn(session.resources, 'publish').mockImplementationOnce(
    async (kind, bytes) => {
      blocked = true;
      return publish(kind, bytes);
    },
  );
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
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  await running;
  expect(broker.execute).not.toHaveBeenCalled();
});

it('answers what landed while the decision was published, even once blocked', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  let blocked = false;
  const publish = session.resources.publish.bind(session.resources);
  vi.spyOn(session.resources, 'publish').mockImplementationOnce(
    async (kind, bytes) => {
      // Another answer records allow, then the Session blocks.
      await resolveHostedAction(session, waiters, requestId, answer('allow'));
      blocked = true;
      return publish(kind, bytes);
    },
  );
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => blocked,
    ),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  });
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it.each(['decision', 'expiry'])(
  'writes nothing when the Session blocks while the %s waits in the queue',
  async (resolution) => {
    turn = createTurn(false, { mode: 'default' });
    const running = turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      new AbortController().signal,
    );
    const requestId = await requested();
    // Hold another write inside the authority's queue.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inQueue = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const append =
      LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockImplementationOnce(async function (
      this: LocalJsonlManagedSessionJournalHandle,
      records,
    ) {
      entered();
      await gate;
      return append.call(this, records);
    });
    const held = commit('assistant', [{ text: 'held' }], 'model');
    await inQueue;
    const queued = vi.spyOn(session.authority, 'resolveAction');
    const now =
      resolution === 'expiry'
        ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
        : undefined;
    // Observe only the answer's write; the Turn settles its own Action later.
    const notify = vi.spyOn(waiters, 'notify').mockImplementation(() => {});
    let blocked = false;
    const answering = resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => blocked,
    );
    try {
      await vi.waitFor(() => expect(queued).toHaveBeenCalled());
      blocked = true;
    } finally {
      release();
    }
    await held;
    await expect(answering).resolves.toEqual({
      status: 409,
      code: 'hosted_turn_recovery_required',
    });
    expect(session.authority.action(requestId)?.state).toBe('requested');
    expect(session.authority.writesStopped).toBe(false);
    expect(notify).toHaveBeenCalledWith(requestId);
    now?.mockRestore();
    notify.mockRestore();
    await resolveHostedAction(session, waiters, requestId, answer('deny'));
    await running;
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

function hookSession(fire: HostedHookSession['fire']): HostedHookSession {
  return {
    fire,
    broker: { ...broker, runtimeSessionId: 'prompt' },
    acquire: () => broker.acquire(),
  } as unknown as HostedHookSession;
}

it.each(['assistant-commit', 'second-call'] as const)(
  'settles every tool refusal when cancelled before a new Hook plan (%s)',
  async (window) => {
    const controller = new AbortController();
    const reason = new Error('turn cancelled');
    const pin = {
      catalogId: 'pre-cancel',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog: {
              ...pin,
              hooks: [
                {
                  hookId: 'before',
                  eventName: HookEventName.PreToolUse,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command' },
                },
              ],
            },
          };
        expect(operation.kind).toBe('hook-execute');
        controller.abort(reason);
        return {
          operationId: operation.operationId,
          state: 'settled',
          result: { success: true, outcome: 'success', duration: 0 },
        };
      },
    );
    const hookBroker = {
      ...broker,
      runtimeSessionId: 'prompt',
      runtime: {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      },
      hookControl,
    } as unknown as HostedWorkspaceBroker;
    const hooks = new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      pin,
      hookBroker,
    );
    await hooks.ensureReady();
    if (window === 'assistant-commit') {
      const originalCommit = commit;
      commit = async (...args) => {
        const id = await originalCommit(...args);
        if (args[0] === 'assistant') controller.abort(reason);
        return id;
      };
    }
    turn = createTurn(false, { mode: 'yolo' }, hooks);
    await expect(
      turn.execute(calls, parts, 'model', controller.signal),
    ).rejects.toBe(reason);
    await expect(turn.finish()).resolves.toBeUndefined();
    const history = await session.sink.project();
    expect(history.map((record) => record.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(history[1].message?.parts).toEqual(
      calls.map((call) => ({
        functionResponse: {
          id: call.callId,
          name: call.name,
          response: { error: 'Hook execution cancelled.' },
        },
      })),
    );
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(hooks.hasPendingOperations).toBe(false);
    const restored = new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      pin,
      hookBroker,
    );
    for (const call of calls) {
      expect(
        await restored.fire(
          HookEventName.PreToolUse,
          `prompt:${call.callId}`,
          {
            tool_name: call.name,
            tool_input: call.args,
            tool_use_id: call.callId,
            permission_mode: 'yolo',
            prompt_id: 'prompt',
          },
          new AbortController().signal,
        ),
      ).toMatchObject({ continue: false, reason: 'Hook execution cancelled.' });
    }
    expect(
      hookControl.mock.calls.filter(
        ([operation]) => operation.kind === 'hook-execute',
      ),
    ).toHaveLength(window === 'assistant-commit' ? 0 : 1);
  },
);

it('recovers committed tool results through the Hook owner acquisition', async () => {
  const hooks = hookSession(vi.fn());
  const acquire = vi.spyOn(hooks, 'acquire');
  const restored = createTurn(false, undefined, hooks);
  await restored.resumeCommittedResults();
  expect(acquire).toHaveBeenCalledOnce();
  expect(broker.acquire).toHaveBeenCalledOnce();
});

it('refuses tool dispatch when fail-closed permission evaluation is combined with an allow', async () => {
  const pin = {
    catalogId: 'permission-test',
    catalogRevision: 1,
    definitionDigest: 'a'.repeat(64),
  };
  const hookBroker = {
    ...broker,
    runtimeSessionId: 'prompt',
    runtime: {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    },
    hookControl: vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => ({
        operationId: operation.operationId,
        state: 'settled' as const,
        ...(operation.kind === 'hook-catalog'
          ? {
              catalog: {
                ...pin,
                hooks: ['fail', 'allow'].map((hookId) => ({
                  hookId,
                  eventName: HookEventName.PermissionRequest,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command' as const },
                })),
              },
            }
          : {
              result:
                operation.kind === 'hook-execute' && operation.hookId === 'fail'
                  ? {
                      success: false,
                      outcome: 'non_blocking_error' as const,
                      duration: 0,
                    }
                  : {
                      success: true,
                      outcome: 'success' as const,
                      duration: 0,
                      output: {
                        hookSpecificOutput: { decision: { behavior: 'allow' } },
                      },
                    },
            }),
      }),
    ),
  };
  const hooks = new HostedHookSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    pin,
    hookBroker as unknown as HostedWorkspaceBroker,
  );
  turn = createTurn(false, { mode: 'default' }, hooks);
  const result = await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(result[0].functionResponse?.response?.['error']).toBeTruthy();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'action.changed'),
  ).toEqual([]);
});

it('runs PreToolUse after approval and asks again for changed arguments', async () => {
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) =>
      event === HookEventName.PreToolUse
        ? {
            hookSpecificOutput: {
              hookEventName: event,
              updatedInput: { ...calls[1].args, file_path: 'changed.txt' },
            },
          }
        : undefined,
    );
  turn = createTurn(false, { mode: 'default' }, hookSession(fire));
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const first = await requested();
  expect(fire.mock.calls.map(([event]) => event)).toEqual([
    HookEventName.PermissionRequest,
  ]);
  const original = (await checkpoint()).approval!.invocationRef!;
  await resolveHostedAction(session, waiters, first, answer('allow'));
  const second = await requested(2);
  expect(second).not.toBe(first);
  const revised = (await checkpoint()).approval!.invocationRef!;
  expect(revised).not.toEqual(original);
  for (const [requestId, inputRef] of [
    [first, original],
    [second, revised],
  ] as const) {
    const options = JSON.parse(
      (
        await session.resources.read(
          session.authority.action(requestId)!.optionsRef!,
        )
      ).toString(),
    );
    expect(options).toMatchObject({ v: 2, inputRef });
  }
  expect(
    JSON.parse(
      JSON.parse((await session.resources.read(revised)).toString())
        .payloadJson,
    ).input.file_path,
  ).toBe('changed.txt');
  expect(broker.execute).not.toHaveBeenCalled();
  await resolveHostedAction(session, waiters, second, answer('allow'));
  await running;
  expect(JSON.parse(broker.execute.mock.calls[0][1])).toMatchObject({
    input: { file_path: 'changed.txt' },
  });
  expect(fire.mock.calls.map(([event]) => event)).toEqual([
    HookEventName.PermissionRequest,
    HookEventName.PreToolUse,
    HookEventName.PostToolUse,
    HookEventName.PostToolBatch,
  ]);
});

it.each(['allow', 'deny'] as const)(
  'honors a top-level PreToolUse ask before a preapproved call (%s)',
  async (decision) => {
    const fire = vi
      .fn<HostedHookSession['fire']>()
      .mockImplementation(async (event) =>
        event === HookEventName.PreToolUse
          ? { decision: 'ask', reason: 'Confirm this read.' }
          : undefined,
      );
    turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
    const running = turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    const approval = await requested();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await resolveHostedAction(session, waiters, approval, answer(decision));
    await running;
    expect(broker.execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
    expect(
      fire.mock.calls.filter(([event]) => event === HookEventName.PreToolUse),
    ).toHaveLength(1);
  },
);

it.each([
  { decision: 'allow', oversized: false },
  { decision: 'deny', oversized: false },
  { decision: 'ask', oversized: false },
  { decision: 'allow', oversized: true },
] as const)(
  'restores PreToolUse context from its durable receipt without duplicate effects ($decision, oversized: $oversized)',
  async ({ decision, oversized }) => {
    if (oversized) {
      const remote = createHttpManagedSessionStores({
        baseUrl: 'http://127.0.0.1:1',
        sessionKey: session.authority.sessionHeader.sessionKey,
        writerId: 'test',
      });
      const publish = session.resources.publish.bind(session.resources);
      vi.spyOn(session.resources, 'publish').mockImplementation(
        async (kind, bytes) => {
          await remote.resourceStore.publish(kind, bytes);
          return publish(kind, bytes);
        },
      );
      messageFitsInline.mockImplementation(
        (_type, content) =>
          Buffer.byteLength(JSON.stringify(content)) <= 60 * 1024,
      );
    }
    const pin = {
      catalogId: 'pre-context',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => ({
        operationId: operation.operationId,
        state: 'settled',
        ...(operation.kind === 'hook-catalog'
          ? {
              catalog: {
                ...pin,
                hooks: [
                  HookEventName.PreToolUse,
                  HookEventName.PostToolUse,
                ].map((eventName) => ({
                  hookId: eventName,
                  eventName,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command' as const },
                })),
              },
            }
          : {
              result: {
                success: true,
                outcome: 'success',
                duration: 0,
                output: {
                  hookSpecificOutput:
                    operation.kind === 'hook-execute' &&
                    operation.hookId === HookEventName.PreToolUse
                      ? {
                          permissionDecision: decision,
                          additionalContext: oversized
                            ? 'x'.repeat(36 * 1024)
                            : 'before <tool>',
                        }
                      : {
                          additionalContext: oversized
                            ? 'y'.repeat(36 * 1024)
                            : 'after tool',
                        },
                },
              },
            }),
      }),
    );
    const hookBroker = {
      ...broker,
      runtimeSessionId: 'prompt',
      runtime: {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      },
      hookControl,
    } as unknown as HostedWorkspaceBroker;
    const createHooks = () =>
      new HostedHookSession(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        pin,
        hookBroker,
      );
    turn = createTurn(false, { mode: 'yolo' }, createHooks());
    const running = turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    if (decision === 'ask')
      await resolveHostedAction(
        session,
        waiters,
        await requested(),
        answer('deny'),
      );
    const responses = await running;
    const contexts = responses.filter((part) => typeof part.text === 'string');
    expect(contexts).toEqual(
      decision === 'ask' || oversized
        ? []
        : [
            { text: 'before &lt;tool&gt;' },
            ...(decision === 'allow' ? [{ text: 'after tool' }] : []),
          ],
    );
    if (oversized) {
      expect(turn.hookStopReason).toContain('context');
      await turn.finish();
      const authorization = await harness.ensureRunnable();
      expect(authorization.continuation.phase).toBe('turn_settled');
      expect(authorization.tools?.items[0]).toMatchObject({
        state: 'settled',
        consumed: false,
      });
    }
    const history = await session.sink.project();
    const controls = hookControl.mock.calls.length;
    const restored = createTurn(false, { mode: 'yolo' }, createHooks());
    expect(
      await restored.resumeHookResults(
        responses,
        'model',
        new AbortController().signal,
      ),
    ).toEqual(responses);
    expect(await session.sink.project()).toEqual(history);
    if (oversized) expect(restored.hookStopReason).toBe(turn.hookStopReason);
    expect(hookControl).toHaveBeenCalledTimes(controls);
    expect(broker.execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
  },
);

it('validates Hook-modified arguments before dispatch', async () => {
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) =>
      event === HookEventName.PreToolUse
        ? {
            hookSpecificOutput: {
              hookEventName: event,
              updatedInput: { file_path: '../outside' },
            },
          }
        : undefined,
    );
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  const responses = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'relative',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(fire.mock.calls.map(([event]) => event)).toEqual([
    HookEventName.PreToolUse,
    HookEventName.PostToolBatch,
  ]);
});

it.each([
  [{ decision: 'block', reason: 'policy' }, 'policy'],
  [
    {
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecision: 'deny',
        permissionDecisionReason: 'policy',
      },
    },
    'policy',
  ],
  [
    {
      continue: false,
      stopReason: 'halt',
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecisionReason: 'needs approval',
      },
    },
    'halt',
  ],
] as const)(
  'does not execute a denied tool or emit a physical post-tool event (%j)',
  async (output, error) => {
    const fire = vi
      .fn<HostedHookSession['fire']>()
      .mockImplementation(async (event) =>
        event === HookEventName.PreToolUse ? output : undefined,
      );
    turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
    const responses = await turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBe(error);
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(fire.mock.calls.map(([event]) => event)).toEqual([
      HookEventName.PreToolUse,
      HookEventName.PostToolBatch,
    ]);
  },
);

it('recovers a failed after Hook from the committed physical receipt without executing the tool again', async () => {
  let fail = true;
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) => {
      if (event === HookEventName.PostToolUse && fail)
        throw new Error('Hook owner disconnected');
      return undefined;
    });
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  await expect(
    turn.execute([calls[0]], [parts[0]], 'model', new AbortController().signal),
  ).rejects.toThrow('Hook owner disconnected');
  const history = await session.sink.project();
  const saved = history.find((entry) => entry.type === 'tool_result')!.message!
    .parts!;
  expect(saved[0].functionResponse?.response?.['executionStatus']).toBe(
    'success',
  );
  fail = false;
  const recovered = await turn.resumeHookResults(
    saved,
    'model',
    new AbortController().signal,
  );
  expect(recovered).toEqual(saved);
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(
    fire.mock.calls.filter(([event]) => event === HookEventName.PostToolUse),
  ).toHaveLength(2);
});

it.each([
  {
    event: HookEventName.PostToolUse,
    output: { continue: false, stopReason: 'policy stop' },
  },
  {
    event: HookEventName.PostToolBatch,
    output: { continue: false, stopReason: 'policy stop' },
  },
  {
    event: HookEventName.PostToolBatch,
    output: { decision: 'deny' as const, reason: 'policy stop' },
  },
])(
  'honors $event orchestration stop while retaining the successful unconsumed receipt',
  async ({ event, output }) => {
    const fire = vi
      .fn<HostedHookSession['fire']>()
      .mockImplementation(async (actual) =>
        actual === event ? output : undefined,
      );
    const hooks = hookSession(fire);
    turn = createTurn(false, { mode: 'yolo' }, hooks);
    const responses = await turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBeUndefined();
    expect(turn.hookStopReason).toBe('policy stop');
    const original = (await checkpoint()).tools!.items;
    expect(original).toEqual([
      expect.objectContaining({ state: 'settled', consumed: false }),
    ]);
    const restored = createTurn(false, { mode: 'yolo' }, hooks);
    await restored.resumeHookResults(
      responses,
      'model',
      new AbortController().signal,
    );
    expect(restored.hookStopReason).toBe('policy stop');
    await turn.finish();
    expect((await checkpoint()).continuation.phase).toBe('turn_settled');
    expect((await checkpoint()).tools!.items).toEqual(original);
    expect(broker.execute).toHaveBeenCalledOnce();
  },
);

it('does not duplicate durable Hook context when resuming committed tool results', async () => {
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) =>
      event === HookEventName.PostToolUse
        ? { hookSpecificOutput: { additionalContext: 'after-tool context' } }
        : undefined,
    );
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  const response = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  const before = await session.sink.project();
  expect(response.at(-1)).toEqual({ text: 'after-tool context' });
  expect(before.filter((entry) => entry.type === 'tool_result')).toHaveLength(
    2,
  );
  expect(
    await turn.resumeHookResults(
      response,
      'model',
      new AbortController().signal,
    ),
  ).toEqual(response);
  expect(await session.sink.project()).toEqual(before);
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('preserves native success in after and batch Hooks when oversized output is omitted', async () => {
  const fire = vi.fn<HostedHookSession['fire']>().mockResolvedValue(undefined);
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  broker.execute.mockResolvedValue({
    executionStatus: 'success',
    responseParts: [{ text: 'x'.repeat(70 * 1024) }],
  });
  const results = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(results[0].functionResponse?.response).toMatchObject({
    executionStatus: 'success',
    outputOmitted: true,
    error: expect.any(String),
  });
  expect(fire.mock.calls.map(([event]) => event)).toContain(
    HookEventName.PostToolUse,
  );
  expect(fire.mock.calls.map(([event]) => event)).not.toContain(
    HookEventName.PostToolUseFailure,
  );
  expect(
    fire.mock.calls.find(
      ([event]) => event === HookEventName.PostToolBatch,
    )?.[2],
  ).toMatchObject({ tool_calls: [{ status: 'success' }] });
});

it('preserves a bounded Shell failure without an error field in after and batch Hooks', async () => {
  const fire = vi.fn<HostedHookSession['fire']>().mockResolvedValue(undefined);
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  fire.mockClear();
  const saved: Part[] = [
    {
      functionResponse: {
        id: calls[0].callId,
        name: calls[0].name,
        response: {
          executionStatus: 'error',
          outputOmitted: true,
          summary: 'The Shell result was saved in its immutable capture.',
        },
      },
    },
  ];
  await turn.resumeHookResults(saved, 'model', new AbortController().signal);
  expect(fire.mock.calls.map(([event]) => event)).toContain(
    HookEventName.PostToolUseFailure,
  );
  expect(
    fire.mock.calls.find(
      ([event]) => event === HookEventName.PostToolBatch,
    )?.[2],
  ).toMatchObject({ tool_calls: [{ status: 'error' }] });
  expect(broker.execute).toHaveBeenCalledOnce();
});

it.each([
  [false, 0],
  [true, 0],
  [true, 8 * 1024 * 1024 + 1],
] as const)(
  'stops oversized Hook data and recovers physical receipts (matching hook: %s, snapshot bytes: %s)',
  async (matchingHook, snapshotBytes) => {
    const remote = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:1',
      sessionKey: session.authority.sessionHeader.sessionKey,
      writerId: 'test',
    });
    const publish = session.resources.publish.bind(session.resources);
    vi.spyOn(session.resources, 'publish').mockImplementation(
      async (kind, bytes) => {
        await remote.resourceStore.publish(kind, bytes);
        return publish(kind, bytes);
      },
    );
    messageFitsInline.mockImplementation(
      (_type, content) =>
        Buffer.byteLength(JSON.stringify(content)) <= 60 * 1024,
    );
    const pin = {
      catalogId: 'round8',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const control = vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => ({
        operationId: operation.operationId,
        state: 'settled',
        ...(operation.kind === 'hook-catalog'
          ? {
              catalog: {
                ...pin,
                hooks: matchingHook
                  ? [
                      {
                        hookId: 'batch',
                        eventName: HookEventName.PostToolBatch,
                        sequential: false,
                        async: false,
                        onceKey: null,
                        failClosed: true,
                        config: {
                          type: snapshotBytes
                            ? ('function' as const)
                            : ('command' as const),
                        },
                      },
                    ]
                  : [],
              },
            }
          : { result: { success: true, outcome: 'success', duration: 0 } }),
      }),
    );
    const hookBroker = {
      ...broker,
      runtimeSessionId: 'prompt',
      runtime: {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      },
      hookControl: control,
    } as unknown as HostedWorkspaceBroker;
    const createHooks = () => {
      const hooks = new HostedHookSession(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        pin,
        hookBroker,
      );
      if (snapshotBytes)
        hooks.setMessagesProvider(() => [{ text: 'x'.repeat(snapshotBytes) }]);
      return hooks;
    };
    broker.execute.mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'x'.repeat(snapshotBytes ? 1024 : 36 * 1024) }],
    });
    turn = createTurn(false, { mode: 'yolo' }, createHooks());
    await turn.execute(calls, parts, 'model', new AbortController().signal);
    expect(turn.hookStopReason).toContain('60 KiB');
    const saved = await checkpoint();
    const history = await session.sink.project();
    const responses = history
      .filter((r) => r.type === 'tool_result')
      .flatMap((r) => r.message?.parts ?? []);
    const key = session.authority.sessionHeader.sessionKey;
    await turn.close();
    await session.close();
    session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: key.sessionId,
      sessionKey: key,
      version: 'test',
      workerId: 'reopened-worker',
      activationLeaseDurationMs: 60000,
    });
    harness = createManagedHarnessHandle(session);
    await harness.ensureRunnable();
    const publishAfter = session.resources.publish.bind(session.resources);
    vi.spyOn(session.resources, 'publish').mockImplementation(
      async (kind, bytes) => {
        await remote.resourceStore.publish(kind, bytes);
        return publishAfter(kind, bytes);
      },
    );
    const restored = createTurn(false, { mode: 'yolo' }, createHooks());
    await restored.resumeCommittedResults();
    turn = restored;
    expect(
      await restored.resumeHookResults(
        responses,
        'model',
        new AbortController().signal,
      ),
    ).toEqual(responses);
    expect(restored.hookStopReason).toContain('60 KiB');
    expect(saved.tools!.items).toEqual([
      expect.objectContaining({ state: 'settled', consumed: false }),
      expect.objectContaining({ state: 'settled', consumed: false }),
    ]);
    await restored.finish();
    expect((await checkpoint()).continuation.phase).toBe('turn_settled');
    expect((await checkpoint()).tools!.items).toEqual(saved.tools!.items);
    expect(await session.sink.project()).toEqual(history);
    expect(broker.execute).toHaveBeenCalledTimes(2);
    expect(control.mock.calls.map(([operation]) => operation.kind)).toEqual([
      'hook-catalog',
    ]);
  },
);
it('persists the prepared history before effects and settled history before continuation', async () => {
  broker.execute.mockImplementation(async () => {
    expect((await readHostedFileHistory(session))?.pendingTurn).toBe('prompt');
    return { executionStatus: 'success', responseParts: [{ text: 'written' }] };
  });
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  expect((await readHostedFileHistory(session))?.pendingTurn).toBeNull();
  const projected = await readManagedSessionRecords({
    runtimeBaseDir: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionKey: session.authority.sessionHeader.sessionKey,
  });
  expect(
    projected.filter((record) => record.subtype === 'file_history_snapshot'),
  ).toHaveLength(2);
  expect(
    broker.fileHistory.mock.calls.map(([operation]) => operation.action),
  ).toEqual(['bind', 'prepare', 'snapshot']);
});

it.each(['pendingTurn', 'pendingUndo'] as const)(
  'refuses a fresh turn with durable %s before binding or dispatching',
  async (pending) => {
    await commit('assistant', [{ text: 'previous turn' }], 'model');
    await commitHostedFileHistory(session, {
      schemaVersion: 1,
      state: {
        ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
        snapshots: [],
        files: {},
      },
      pendingTurn: pending === 'pendingTurn' ? 'previous-prompt' : null,
      pendingUndo:
        pending === 'pendingUndo'
          ? { requestId: randomUUID(), promptId: randomUUID() }
          : null,
    });
    const saved = await readHostedFileHistory(session);
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(broker.acquire).toHaveBeenCalledOnce();
    expect(broker.fileHistory).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.release).not.toHaveBeenCalled();
    expect(await readHostedFileHistory(session)).toEqual(saved);
  },
);

it('persists capacity refusals without dispatch or pending history and releases the runtime', async () => {
  const names = Array.from(
    { length: 160 },
    (_, index) => `${index}-${'x'.repeat(60)}.txt`,
  );
  broker.fileHistory.mockImplementation(async (operation) => ({
    ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
    snapshots:
      operation.action === 'prepare'
        ? [
            {
              promptId: 'prompt',
              timestamp: '2026-09-30T00:00:00.000Z',
              trackedFileBackups: Object.fromEntries(
                names.map((file) => [
                  file,
                  {
                    backupFileName: null,
                    version: 1,
                    backupTime: '2026-09-30T00:00:00.000Z',
                  },
                ]),
              ),
            },
          ]
        : [],
    files:
      operation.action === 'prepare'
        ? Object.fromEntries(names.map((file) => [file, null]))
        : {},
  }));
  const responses = await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(JSON.stringify(responses)).toContain('capacity is exhausted');
  expect(
    broker.fileHistory.mock.calls.map(([operation]) => operation.action),
  ).toEqual(['bind', 'prepare']);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(await readHostedFileHistory(session)).toBeUndefined();
  expect(
    (await session.sink.project())
      .filter((record) => record.type === 'tool_result')
      .flatMap((record) => record.message?.parts ?? []),
  ).toEqual(responses);
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it.each(['backup', 'persistence'])(
  'never dispatches when prepared-history %s fails',
  async (failure) => {
    if (failure === 'persistence')
      vi.spyOn(session.authority, 'commitDomainRecord').mockRejectedValueOnce(
        new Error('history persistence unavailable'),
      );
    broker.fileHistory.mockImplementation(async (operation) => {
      if (failure === 'backup' && operation.action === 'prepare')
        throw new Error('backup unavailable');
      return {
        ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
        snapshots: [],
        files: {},
      };
    });
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(broker.execute).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
  },
);

it('keeps a durable pending history when post-execution settlement fails', async () => {
  broker.fileHistory.mockImplementation(async (operation) => {
    if (operation.action === 'snapshot')
      throw new Error('history response lost');
    return {
      ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
      snapshots: [],
      files: {},
    };
  });
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.execute).toHaveBeenCalledTimes(2);
  expect((await readHostedFileHistory(session))?.pendingTurn).toBe('prompt');
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.release).not.toHaveBeenCalled();
});

it.each([false, true])(
  'settles a definite preparation refusal (mixed batch: %s)',
  async (mixed) => {
    broker.fileHistory.mockImplementation(async (operation) => {
      if (operation.action === 'prepare')
        throw new HostedWorkspaceBrokerRejection(
          409,
          'managed_runtime_provider_operation_failed',
          undefined,
          'ordinary files only',
        );
      return {
        ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
        snapshots: [],
        files: {},
      };
    });
    const responses = await turn.execute(
      mixed ? calls : [calls[1]],
      mixed ? parts : [parts[1]],
      'model',
      new AbortController().signal,
    );
    expect(JSON.stringify(responses)).toContain('ordinary files only');
    expect(broker.prepare).toHaveBeenCalledTimes(mixed ? 1 : 0);
    expect(broker.execute).toHaveBeenCalledTimes(mixed ? 1 : 0);
    expect(await readHostedFileHistory(session)).toBeUndefined();
    expect(
      (await session.sink.project())
        .filter((record) => record.type === 'tool_result')
        .flatMap((record) => record.message?.parts ?? []),
    ).toEqual(responses);
    if (mixed) await turn.consumeResults();
    await turn.finish();
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

it.each([
  [409, 'managed_runtime_provider_operation_failed'],
  [400, 'runtime_control_operation_invalid'],
] as const)(
  'releases a definite bind rejection %s %s without blocking',
  async (status, code) => {
    broker.fileHistory.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(status, code),
    );
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toThrow('Runtime Broker returned HTTP');
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toBeUndefined();
    expect(broker.release).toHaveBeenCalledOnce();
    expect(await session.sink.project()).toEqual([]);
  },
);

it.each(['bind', 'prepare', 'release', 'store'] as const)(
  'keeps uncertain history %s failures blocked',
  async (phase) => {
    if (phase === 'store') {
      vi.spyOn(session.authority, 'commitDomainRecord').mockRejectedValueOnce(
        new ManagedSessionStoreHttpError(
          503,
          'store_unavailable',
          'commit outcome unknown',
        ),
      );
    } else {
      broker.fileHistory.mockImplementation(async (operation) => {
        if (
          operation.action === phase ||
          (phase === 'release' && operation.action === 'bind')
        )
          throw new HostedWorkspaceBrokerRejection(
            phase === 'release' ? 409 : 503,
            'managed_runtime_provider_operation_failed',
          );
        return {
          ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
          snapshots: [],
          files: {},
        };
      });
      if (phase === 'release')
        broker.release.mockRejectedValueOnce(
          new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
        );
    }
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.execute).not.toHaveBeenCalled();
    expect(broker.release).toHaveBeenCalledTimes(phase === 'release' ? 1 : 0);
  },
);

it.each([false, true])(
  'settles definite reservation conflicts (mixed: %s)',
  async (mixed) => {
    if (mixed) broker.prepare.mockResolvedValueOnce('read-execution');
    broker.prepare.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(
        409,
        'runtime_execution_conflict',
        undefined,
        'execution identity already in use',
      ),
    );
    const responses = await turn.execute(
      mixed ? calls : [calls[1]],
      mixed ? parts : [parts[1]],
      'model',
      new AbortController().signal,
    );
    expect(JSON.stringify(responses)).toContain('before dispatch');
    expect(broker.execute).toHaveBeenCalledTimes(mixed ? 1 : 0);
    expect((await readHostedFileHistory(session))?.pendingTurn).toBeNull();
    if (mixed) await turn.consumeResults();
    await turn.finish();
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

it('recovers settled file history by observing the original runtime without rebinding or executing', async () => {
  broker.fileHistory.mockImplementation(async (operation) => {
    if (operation.action === 'snapshot') throw new Error('response lost');
    return {
      ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
      snapshots: [],
      files: {},
    };
  });
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  const saved = await readHostedFileHistory(session);
  expect(saved?.pendingMessageId).toEqual(
    (await session.sink.project()).find((item) => item.type === 'assistant')
      ?.uuid,
  );
  broker.fileHistory.mockResolvedValue(saved!.state);
  broker.fileHistory.mockClear();
  broker.execute.mockClear();
  const recovered = createTurn();
  await recovered.resumeCommittedResults();
  expect(
    broker.fileHistory.mock.calls.map(([operation]) => operation.action),
  ).toEqual(['snapshot']);
  expect(broker.execute).not.toHaveBeenCalled();
  expect((await readHostedFileHistory(session))?.pendingTurn).toBeNull();
  expect(
    (await readHostedFileHistory(session))?.pendingMessageId,
  ).toBeUndefined();
  await recovered.consumeResults();
  await recovered.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it.each([
  'previous-batch',
  'missing-message-id',
  'incomplete-results',
  'changed-snapshots',
  'missing-runtime',
])('does not clear pending history for %s', async (failure) => {
  broker.fileHistory.mockImplementation(async (operation) => {
    if (operation.action === 'snapshot') throw new Error('response lost');
    return {
      ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
      snapshots: [],
      files: {},
    };
  });
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  const saved = (await readHostedFileHistory(session))!;
  if (failure === 'previous-batch')
    saved.pendingMessageId = await commit('assistant', parts, 'model');
  if (failure === 'missing-message-id') delete saved.pendingMessageId;
  if (failure === 'incomplete-results') {
    const project = session.sink.project.bind(session.sink);
    vi.spyOn(session.sink, 'project').mockImplementation(async (...args) => {
      const records = await project(...args);
      const lastResult = records.findLastIndex(
        (item) => item.type === 'tool_result',
      );
      return records.filter((_, index) => index !== lastResult);
    });
  }
  await commitHostedFileHistory(session, saved);
  broker.fileHistory.mockResolvedValue(
    failure === 'changed-snapshots'
      ? { ...saved.state, snapshots: [{ promptId: 'unexpected' }] }
      : saved.state,
  );
  if (failure === 'missing-runtime')
    broker.fileHistory.mockRejectedValue(
      new HostedWorkspaceBrokerRejection(
        409,
        'managed_runtime_provider_operation_failed',
      ),
    );
  broker.fileHistory.mockClear();
  const recovered = createTurn();
  await expect(recovered.resumeCommittedResults()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect((await readHostedFileHistory(session))?.pendingTurn).toBe('prompt');
  expect(broker.release).not.toHaveBeenCalled();
  if (
    ['previous-batch', 'missing-message-id', 'incomplete-results'].includes(
      failure,
    )
  )
    expect(broker.fileHistory).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// H3 background Shell flow
// ---------------------------------------------------------------------------

function backgroundTurnRig(
  outcome: ToolResultEnvelope,
  options: {
    attached?: boolean;
    lane?: HostedShellTurnOptions;
    notStartedProven?: boolean;
    reserveRefused?: boolean;
  } = {},
) {
  enablement.childRun = true;
  const order: string[] = [];
  const orchestrator = {
    calls: [] as Array<readonly [string, unknown]>,
    record(id: string) {
      return options.attached === true
        ? {
            ...({} as Record<string, unknown>),
            startReceiptRef: {
              resourceId: `receipt-${id}`,
              kind: 'managed-runtime-receipt',
              schemaVersion: 1,
              byteLength: 1,
              digest: 'a'.repeat(64),
            },
          }
        : undefined;
    },
    async admit(params: unknown) {
      orchestrator.calls.push(['admit', params]);
    },
    async dispatchStarted(id: string, runtime: unknown) {
      orchestrator.calls.push(['dispatchStarted', { id, runtime }]);
    },
    async attach(id: string, runtime: unknown, receipt: unknown) {
      orchestrator.calls.push(['attach', { id, runtime, receipt }]);
    },
    async settleFailed(id: string, params: unknown) {
      orchestrator.calls.push(['settleFailed', { id, params }]);
    },
  };
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    rememberAdmission: vi.fn(),
    request: vi.fn(async (route: string, body: unknown) => {
      const operation = (body as { operation?: string }).operation;
      if (route === '/grants' && operation === 'reserve') {
        order.push('reserve');
        if (options.reserveRefused === true)
          throw new ManagedSessionStoreHttpError(
            500,
            'store_unavailable',
            'reserve refused',
          );
        return { state: 'OPEN' };
      }
      if (route === '/grants' && operation === 'renew') {
        order.push('renew');
        return { state: 'OPEN' };
      }
      if (route === '/grants' && operation === 'close_not_started') {
        order.push('close_not_started');
        return {
          state: options.notStartedProven === false ? 'RUNNING' : 'NOT_STARTED',
        };
      }
      throw new Error('Unexpected publication route ' + route);
    }),
  } as unknown as HttpToolPublicationOwner;
  broker.prepareV3.mockResolvedValue({
    executionCallId: 'shell-execution',
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  });
  broker.executeV3.mockImplementation(async () => {
    order.push('execute');
    expect(session.authority.latestCheckpoint?.boundary).toBe('durable_wait');
    return outcome;
  });
  broker.acknowledgeV3.mockImplementation(async () => {
    order.push('ack');
    expect(session.authority.latestCheckpoint?.boundary).toBeNull();
  });
  const turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async (type, messageParts, model, identity) => {
      order.push(type);
      const uuid = identity?.uuid ?? randomUUID();
      await session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        cwd: root,
        version: 'test',
        daemonPromptId: 'prompt',
        model,
        message: {
          role: type === 'assistant' ? 'model' : 'user',
          parts: messageParts,
        },
      });
      return uuid;
    },
    () => true,
    { owner, captureBytes: 1024 * 1024 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    orchestrator as never,
    undefined,
    options.lane,
  );
  return { order, orchestrator, turn, lane: options.lane };
}

function monitorTurnRig(
  outcome: ToolResultEnvelope,
  opts: {
    notStartedProven?: boolean;
    lane?: HostedShellTurnOptions;
    reserveRefused?: boolean;
  } = {},
) {
  enablement.childRun = true;
  enablement.monitorRun = true;
  const order: string[] = [];
  const options = {
    resources: {} as never,
    assertWritable: async () => {},
    monitorLoops: undefined as Map<string, unknown> | undefined,
    publisher: undefined as unknown,
  } as unknown as HostedShellTurnOptions;
  const monitors = {
    calls: [] as Array<readonly [string, unknown]>,
    attached: new Map<string, unknown>(),
    record(id: string) {
      return monitors.attached.get(id);
    },
    lastAdmit: undefined as Record<string, unknown> | undefined,
    async admit(params: Record<string, unknown>) {
      monitors.calls.push(['admit', params]);
      monitors.lastAdmit = params;
    },
    async dispatchStarted(id: string, runtime: unknown) {
      monitors.calls.push(['dispatchStarted', { id, runtime }]);
    },
    async attach(id: string, runtime: unknown, receipt: unknown) {
      monitors.calls.push(['attach', { id, runtime, receipt }]);
      const argsRef = await session.resources.publish(
        'managed-tool-args',
        Buffer.from(JSON.stringify(monitors.lastAdmit?.['args'] ?? {}), 'utf8'),
      );
      const bound = runtime as { runtimeBindingId: string; generation: string };
      monitors.attached.set(id, {
        monitorId: id,
        ownerScopeId: session.authority.sessionHeader.sessionKey.sessionId,
        commandRef: argsRef,
        maxEvents: (monitors.lastAdmit?.['maxEvents'] as number) ?? 100,
        idleTimeoutMs:
          (monitors.lastAdmit?.['idleTimeoutMs'] as number) ?? 300_000,
        debounceMs: (monitors.lastAdmit?.['debounceMs'] as number) ?? 1_000,
        startReceiptRef: {
          resourceId: `receipt-${id}`,
          kind: 'managed-runtime-receipt',
          schemaVersion: 1,
          byteLength: 2,
          digest: 'a'.repeat(64),
        },
        observationSequence: 0,
        lastObservationRef: null,
        notifiedThrough: 0,
        stopReason: null,
        outputRef: null,
        run: {
          state: 'running',
          reason: null,
          definition: null,
          executionCallId: id,
          effectId: null,
          dispatchId: null,
          deliveryId: null,
          execution: 'running_attached',
          runtime: bound,
          delivery: null,
        },
      });
    },
    async settleFailed(id: string, params: unknown) {
      monitors.calls.push(['settleFailed', { id, params }]);
    },
  };
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    rememberAdmission: vi.fn(),
    request: vi.fn(async (route: string, body: unknown) => {
      const operation = (body as { operation?: string }).operation;
      if (route === '/grants' && operation === 'reserve') {
        order.push('reserve');
        if (opts.reserveRefused === true)
          throw new ManagedSessionStoreHttpError(
            500,
            'store_unavailable',
            'reserve refused',
          );
        return { state: 'OPEN' };
      }
      if (route === '/grants' && operation === 'renew') {
        order.push('renew');
        return { state: 'OPEN' };
      }
      if (route === '/grants' && operation === 'close_not_started') {
        order.push('close_not_started');
        return {
          state: opts.notStartedProven === false ? 'RUNNING' : 'NOT_STARTED',
        };
      }
      throw new Error('Unexpected publication route ' + route);
    }),
  } as unknown as HttpToolPublicationOwner;
  broker.prepareV3.mockResolvedValue({
    executionCallId: 'monitor-execution',
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  });
  broker.executeV3.mockImplementation(async () => {
    order.push('execute');
    expect(session.authority.latestCheckpoint?.boundary).toBe('durable_wait');
    return outcome;
  });
  broker.acknowledgeV3.mockImplementation(async () => {
    order.push('ack');
    expect(session.authority.latestCheckpoint?.boundary).toBeNull();
  });
  const turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async (type, messageParts, model, identity) => {
      order.push(type);
      const uuid = identity?.uuid ?? randomUUID();
      await session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        cwd: root,
        version: 'test',
        daemonPromptId: 'prompt',
        model,
        message: {
          role: type === 'assistant' ? 'model' : 'user',
          parts: messageParts,
        },
      });
      return uuid;
    },
    () => true,
    { owner, captureBytes: 1024 * 1024 },
    opts.lane !== undefined ? undefined : options,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      admit: async () => {},
      dispatchStarted: async () => {},
      attach: async () => {},
      settleFailed: async () => {},
      record: () => undefined,
    } as never,
    monitors as never,
    opts.lane,
  );
  return { order, monitors, options: opts.lane ?? options, turn };
}

function monitorCall() {
  const call = {
    ...calls[0],
    name: 'monitor',
    callId: 'monitor-call',
    args: { command: 'tail -f build.log' },
  };
  const parts: Part[] = [
    {
      functionCall: {
        id: call.callId,
        name: call.name,
        args: call.args,
      },
    },
  ];
  return { call, parts };
}

describe('hosted Monitor admission arm', () => {
  const DETACHED: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Monitor watch started under unit qwen-mon-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };

  it('admits, dispatches and attaches through the monitor funnel', async () => {
    const { call, parts } = monitorCall();
    const rig = monitorTurnRig(DETACHED);
    turn = rig.turn;
    const result = await rig.turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );

    expect(result[0]?.functionResponse?.response).toMatchObject({
      executionStatus: 'success',
    });
    expect(rig.monitors.calls.map(([name]) => name)).toEqual([
      'admit',
      'dispatchStarted',
      'attach',
    ]);
    const [admit] = rig.monitors.calls;
    expect(admit?.[1]).toMatchObject({
      monitorId: 'monitor-execution',
      ownerScopeId: session.authority.sessionHeader.sessionKey.sessionId,
      executionCallId: 'monitor-execution',
      maxEvents: 1_000,
      idleTimeoutMs: 300_000,
      debounceMs: 1_000,
    });
    const [, , attach] = rig.monitors.calls;
    expect(attach?.[1]).toMatchObject({
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    const receipt = (attach?.[1] as { receipt: Record<string, unknown> })
      .receipt;
    expect(receipt['executionCallId']).toBe('monitor-execution');
    expect(receipt['bindingGeneration']).toBe('1');
    expect(receipt['unitName']).toMatch(/^qwen-mon-/);
    expect(broker.acknowledgeV3).toHaveBeenCalledWith('monitor-execution', {
      executionCallId: 'monitor-execution',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
    const receipts = session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.payload).toMatchObject({
      executionCallId: 'monitor-execution',
      resultRef: null,
      resources: [],
    });
    // A fresh accept starts exactly one observation lifecycle on the Session.
    expect(rig.options.monitorLoops?.has('monitor-execution')).toBe(true);
  });

  it('drives a Monitor through the publication lane exactly where production admits it', async () => {
    const { call, parts } = monitorCall();
    const descriptor = { url: 'http://127.0.0.1:9/lane-mon', token: 'tok' };
    const lane: HostedShellTurnOptions = {
      resources: {} as never,
      assertWritable: async () => undefined,
      monitorLoops: undefined as Map<string, unknown> | undefined,
      publisher: {
        start: async () => descriptor,
        register: vi.fn(),
        setMonitorObserver: vi.fn(),
        settleAttached: async () => undefined,
        close: async () => undefined,
      } as never,
    } as unknown as HostedShellTurnOptions;
    const rig = monitorTurnRig(DETACHED, { lane });
    turn = rig.turn;
    const result = await turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    expect(result[0]?.functionResponse?.response).toMatchObject({
      executionStatus: 'success',
    });
    // The lane carries the Session publisher for the detached family:
    // installed once, fed with the monitoring capture, and its attach
    // drives the observation loop to resume through the same lane.
    expect(broker.registerPublisher).toHaveBeenCalledTimes(1);
    expect(broker.prepareV3).toHaveBeenCalledTimes(1);
    expect(broker.executeV3).toHaveBeenCalledTimes(1);
    expect(rig.monitors.calls.map(([name]) => name)).toEqual([
      'admit',
      'dispatchStarted',
      'attach',
    ]);
    const register = lane.publisher!.register as ReturnType<typeof vi.fn>;
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toMatchObject({
      capture: {
        executionCallId: 'monitor-execution',
        background: true,
        monitoring: true,
      },
    });
    expect(rig.options.monitorLoops?.has('monitor-execution')).toBe(true);
  });

  it('settles a proven-unstarted monitor as start_failed', async () => {
    const { call, parts } = monitorCall();
    const rejectedStart: ToolResultEnvelope = {
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: {
        message:
          'Monitor watch requires a delegated Linux cgroup v2 root on this Runtime.',
      },
    };
    const rig = monitorTurnRig(rejectedStart);
    turn = rig.turn;
    await rig.turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    expect(rig.monitors.calls.map(([name]) => name)).toEqual([
      'admit',
      'dispatchStarted',
      'settleFailed',
    ]);
    expect(rig.monitors.calls.at(-1)?.[1]).toEqual({
      id: 'monitor-execution',
      params: { stopReason: 'start_failed', started: false },
    });
    expect(rig.order).toEqual([
      'assistant',
      'reserve',
      'renew',
      'execute',
      'close_not_started',
      'tool_result',
    ]);
  });

  it('rejects an unproven not_started refuse before settling the watch record', async () => {
    const { call, parts } = monitorCall();
    const rejectedStart: ToolResultEnvelope = {
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: {
        message:
          'Monitor watch requires a delegated Linux cgroup v2 root on this Runtime.',
      },
    };
    const rig = monitorTurnRig(rejectedStart, { notStartedProven: false });
    turn = rig.turn;
    await expect(
      rig.turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    // The authoritative proof failed: the record stays un-settled rather
    // than claiming a failure that never happened.
    expect(rig.monitors.calls.some(([name]) => name === 'settleFailed')).toBe(
      false,
    );
  });

  it('rejects an unproven not_started refuse before settling the Shell record', async () => {
    const { call, parts } = backgroundCall();
    const rejectedStart: ToolResultEnvelope = {
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: {
        message:
          'Background Shell requires a delegated Linux cgroup v2 directory on this Runtime.',
      },
    };
    const rig = backgroundTurnRig(rejectedStart, { notStartedProven: false });
    turn = rig.turn;
    await expect(
      rig.turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(
      rig.orchestrator.calls.some(([name]) => name === 'settleFailed'),
    ).toBe(false);
  });

  it('resumes a live watch on an accept replay whose loop was lost', async () => {
    const { call, parts } = monitorCall();
    const rig = monitorTurnRig(DETACHED);
    turn = rig.turn;
    await rig.turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    expect(rig.options.monitorLoops?.has('monitor-execution')).toBe(true);
    // The process that owned the observation loop is gone; the journal
    // keeps the record running and its receipt, so the next accept for it
    // must resume the loop or the run never settles again.
    rig.options.monitorLoops = new Map();
    const accept = (
      rig.turn as unknown as {
        acceptMonitor(
          request: {
            call: ToolCallRequestInfo;
            input: Record<string, unknown>;
          },
          executionCallId: string,
          saved: Record<string, string>,
          result: ToolResultEnvelope,
          model: string,
        ): Promise<Part[]>;
      }
    ).acceptMonitor.bind(rig.turn);
    const retried = await accept(
      { call, input: call.args as Record<string, unknown> },
      'monitor-execution',
      {
        publicationId: 'publication-1',
        publicationToken: 'token-1',
        runtimeBindingId: 'binding-1',
        bindingGeneration: '1',
        runtimeCallId: 'rt',
      },
      DETACHED,
      'model',
    );
    expect(retried[0]?.functionResponse?.response).toMatchObject({
      executionStatus: 'success',
    });
    expect(rig.options.monitorLoops?.has('monitor-execution')).toBe(true);
    expect(
      rig.monitors.calls.filter(([name]) => name === 'attach'),
    ).toHaveLength(1);
  });

  it('refuses a background request on a Session whose flow has no publication lane', async () => {
    enablement.childRun = true;
    const { call: shellCall, parts } = backgroundCall();
    const bare = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      {
        resources: {} as never,
        assertWritable: async () => undefined,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        admit: async () => undefined,
        dispatchStarted: async () => undefined,
        attach: async () => undefined,
        settleFailed: async () => undefined,
        record: () => undefined,
        settleExited: async () => undefined,
      } as never,
      undefined,
    );
    const result = await bare.execute(
      [shellCall],
      parts,
      'model',
      new AbortController().signal,
    );
    // shell-mode has no publication lane for the detached family, so the
    // request refuses at admission instead of travelling v2 and failing 409.
    expect(result[0]?.functionResponse?.response).toMatchObject({
      error:
        'Hosted Shell requires a foreground command in the saved directory. Background jobs and Monitor are unavailable; correct the arguments before retrying.',
    });
  });

  it('does not let one failed resume poison every later one', async () => {
    const publisher = {
      setMonitorObserver: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('observer bridge gone');
        })
        .mockImplementation(() => undefined),
    };
    const commandRef = await session.resources.publish(
      'managed-tool-args',
      Buffer.from(JSON.stringify({ command: 'true' }), 'utf8'),
    );
    const record = {
      monitorId: 'monitor-x',
      commandRef,
      maxEvents: 100,
      idleTimeoutMs: 60_000,
      debounceMs: 1_000,
      startReceiptRef: {
        resourceId: 'receipt-monitor-x',
        kind: 'managed-runtime-receipt',
        schemaVersion: 1,
        byteLength: 2,
        digest: 'a'.repeat(64),
      },
      stopReason: null,
      run: { runtime: { runtimeBindingId: 'binding-1', generation: '1' } },
    };
    const monitors = {
      record: (id: string) => (id === 'monitor-x' ? record : undefined),
    } as never;
    const shell: {
      monitorLoops: Map<string, unknown>;
      monitorWakeKick: () => void;
    } = {
      monitorLoops: new Map<string, unknown>(),
      monitorWakeKick: () => undefined,
    };
    const bare = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      {
        resources: {} as never,
        assertWritable: async () => undefined,
        ...shell,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      monitors,
    );
    (bare as unknown as { publisher: unknown }).publisher = publisher;
    const resume = (
      bare as unknown as { resumeMonitorWatch: (id: string) => Promise<void> }
    ).resumeMonitorWatch.bind(bare);
    await expect(resume('monitor-x')).rejects.toThrow('observer bridge gone');
    // The failed start leaves no dead loop behind to short-circuit the
    // retry that comes from a fresh accept.
    expect(shell.monitorLoops.has('monitor-x')).toBe(false);
    await expect(resume('monitor-x')).resolves.toBeUndefined();
    expect(shell.monitorLoops.has('monitor-x')).toBe(true);
  });

  it('records a monitor refusal without any funnel call on an empty session', async () => {
    const { call, parts } = monitorCall();
    const bare = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      {
        resources: {} as never,
        assertWritable: async () => {},
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const result = await bare.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    expect(result[0]?.functionResponse?.response).toMatchObject({
      error:
        'Hosted Monitor is unavailable on this Session profile; read output through the task surface instead.',
    });
  });

  it('refuses a Monitor on a Session that owns monitors but no v3 lane', async () => {
    enablement.monitorRun = true;
    const { call, parts } = monitorCall();
    const bare = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      {
        resources: {} as never,
        assertWritable: async () => undefined,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { record: () => undefined } as never,
      undefined,
    );
    const result = await bare.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    // Owning monitors without a v3 lane must never send the Monitor
    // travelling v2 to the Runtime: it refuses at admission, accurately.
    expect(result[0]?.functionResponse?.response).toMatchObject({
      error:
        'Hosted Monitor is unavailable on this Session profile; read output through the task surface instead.',
    });
  });
});

function backgroundCall() {
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    callId: 'background-call',
    args: { command: 'echo hi', is_background: true as const },
  };
  const parts: Part[] = [
    {
      functionCall: {
        id: call.callId,
        name: call.name,
        args: call.args,
      },
    },
  ];
  return { call, parts };
}

it('admits a background Shell through its child_run orchestrator and lands the detached receipt family', async () => {
  const { call, parts } = backgroundCall();
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Background shell started under unit qwen-bg-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(detached);
  turn = rig.turn;
  const result = await turn.execute(
    [call],
    parts,
    'model',
    new AbortController().signal,
  );

  expect(result[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'success',
  });
  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'attach',
  ]);
  const [admit] = rig.orchestrator.calls;
  expect(admit?.[1]).toMatchObject({
    shellId: 'shell-execution',
    executionCallId: 'shell-execution',
    args: { command: 'echo hi', is_background: true },
  });
  const [, dispatch] = rig.orchestrator.calls;
  expect(dispatch).toMatchObject([
    'dispatchStarted',
    {
      id: 'shell-execution',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    },
  ]);
  const [, , attach] = rig.orchestrator.calls;
  expect(attach?.[1]).toMatchObject({
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  const receipt = (attach?.[1] as { receipt: Record<string, unknown> }).receipt;
  expect(receipt['executionCallId']).toBe('shell-execution');
  expect(receipt['bindingGeneration']).toBe('1');
  expect(receipt['unitName']).toMatch(/^qwen-bg-/);
  expect(broker.acknowledgeV3).toHaveBeenCalledWith('shell-execution', {
    executionCallId: 'shell-execution',
    manifest: null,
    deliveryStatus: 'blocked',
    historyRevision: null,
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'renew',
    'execute',
    'tool_result',
    'ack',
  ]);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.payload).toMatchObject({
    executionCallId: 'shell-execution',
    resultRef: null,
    resources: [],
  });
  const outcomeRef = assertManagedSessionDurableRef(
    receipts[0]!.payload['toolOutcomeRef'],
    'background outcome',
  );
  const savedOutcome = JSON.parse(
    (await session.resources.read(outcomeRef)).toString('utf8'),
  ) as Record<string, unknown>;
  expect(savedOutcome).toMatchObject({
    schemaVersion: 1,
    decision: 'blocked',
    manifestRef: null,
  });
  expect(savedOutcome['envelope']).toEqual(detached);
});

it('registers the Session capture lane for a background turn in publication mode', async () => {
  const { call, parts } = backgroundCall();
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Background shell started under unit qwen-bg-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const descriptor = { url: 'http://127.0.0.1:9/lane', token: 'lane-token' };
  const order2: string[] = [];
  const lane: HostedShellTurnOptions = {
    resources: {} as never,
    assertWritable: async () => undefined,
    publisher: {
      start: async () => descriptor,
      register: vi.fn(),
      settleAttached: async (id: string) => {
        order2.push(`settleAttached:${id}`);
      },
      close: async () => undefined,
    } as never,
  };
  const rig = backgroundTurnRig(detached, { lane });
  turn = rig.turn;
  const result = await turn.execute(
    [call],
    parts,
    'model',
    new AbortController().signal,
  );
  expect(result[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'success',
  });
  // The production lane owns the detached family's funnel from admission:
  // installed on the Runtime, fed this call's register, and its
  // settleAttached is the hook the attach arm drives — it fires right
  // after the attach, without any client retry anywhere in the turn.
  expect(broker.registerPublisher).toHaveBeenCalledWith(descriptor);
  expect(broker.registerPublisher).toHaveBeenCalledTimes(1);
  const register = lane.publisher!.register as ReturnType<typeof vi.fn>;
  expect(register).toHaveBeenCalledTimes(1);
  expect(register.mock.calls[0]![0]).toMatchObject({
    capture: {
      executionCallId: 'shell-execution',
      background: true,
    },
  });
  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'attach',
  ]);
  expect(order2).toEqual(['settleAttached:shell-execution']);
});

it('answers a retried accept from the journal without minting a rerun', async () => {
  const { call, parts } = backgroundCall();
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Background shell started under unit qwen-bg-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(detached);
  turn = rig.turn;
  await turn.execute([call], parts, 'model', new AbortController().signal);

  const accept = (
    rig.turn as unknown as {
      acceptBackgroundShell(
        request: { call: ToolCallRequestInfo; input: Record<string, unknown> },
        executionCallId: string,
        saved: Record<string, string>,
        result: ToolResultEnvelope,
        model: string,
      ): Promise<Part[]>;
    }
  ).acceptBackgroundShell.bind(rig.turn);
  const retried = await accept(
    { call, input: call.args as Record<string, unknown> },
    'shell-execution',
    {
      publicationId: 'publication-1',
      publicationToken: 'token-1',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
      runtimeCallId: 'rt',
    },
    detached,
    'model',
  );
  expect(retried[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'success',
  });
  expect(
    rig.orchestrator.calls.filter(([name]) => name === 'attach'),
  ).toHaveLength(1);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
});

it('tolerates a crash between attach and journal instead of a rerun', async () => {
  const { call, parts } = backgroundCall();
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Background shell started under unit qwen-bg-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(detached, { attached: true });
  turn = rig.turn;
  await turn.execute([call], parts, 'model', new AbortController().signal);
  expect(
    rig.orchestrator.calls.filter(([name]) => name === 'attach'),
  ).toHaveLength(0);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
  expect(broker.acknowledgeV3).toHaveBeenCalledWith('shell-execution', {
    executionCallId: 'shell-execution',
    manifest: null,
    deliveryStatus: 'blocked',
    historyRevision: null,
  });
});

it('records a proven-unstarted background refuse as start_failed and lands the unstarted family', async () => {
  const { call, parts } = backgroundCall();
  const rejectedStart: ToolResultEnvelope = {
    executionStatus: 'not_started',
    responseParts: [],
    capture: null,
    error: {
      message:
        'Background Shell requires a delegated Linux cgroup v2 directory on this Runtime.',
    },
  };
  const rig = backgroundTurnRig(rejectedStart);
  turn = rig.turn;
  await turn.execute([call], parts, 'model', new AbortController().signal);

  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.orchestrator.calls.at(-1)?.[1]).toEqual({
    id: 'shell-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'renew',
    'execute',
    'close_not_started',
    'tool_result',
  ]);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.payload).toMatchObject({
    resultRef: null,
    resources: [],
  });
  expect(broker.acknowledgeV3).not.toHaveBeenCalled();
});

it('settles the admitted child run when grant reservation exhausts its retries', async () => {
  // R3-23: the checkpoint committed, dispatch_started is durable, and the
  // /grants reserve then refuses three times — the recovery catch closes
  // the grant as NOT_STARTED, which is also the proof under which the
  // admitted run record must settle instead of staying dispatch_started
  // forever.
  const { call, parts } = backgroundCall();
  const unreached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'unreached' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(unreached, { reserveRefused: true });
  turn = rig.turn;
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.orchestrator.calls.at(-1)?.[1]).toEqual({
    id: 'shell-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'reserve',
    'reserve',
    'close_not_started',
  ]);
});

it('settles the admitted child run when executeV3 fails without the proven 409', async () => {
  // R3-24: dispatch_started is durable and the v3 start then fails with
  // anything but the execution-unknown 409 — the turn refuses recovery,
  // and the admitted record settles under the same close_not_started
  // proof instead of reporting running forever.
  const { call, parts } = backgroundCall();
  const unreached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'unreached' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(unreached);
  turn = rig.turn;
  broker.executeV3.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(500, 'runtime_internal_error'),
  );
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.orchestrator.calls.at(-1)?.[1]).toEqual({
    id: 'shell-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'renew',
    'close_not_started',
  ]);
});

it('settles the admitted monitor run on the same unstarted recovery proof', async () => {
  // R3-23 monitor half: the monitor_run record admitted at dispatch time
  // faces the same refusal windows and must settle under the same proof.
  const { call, parts } = monitorCall();
  const unreached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'unreached' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = monitorTurnRig(unreached, { reserveRefused: true });
  turn = rig.turn;
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(rig.monitors.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.monitors.calls.at(-1)?.[1]).toEqual({
    id: 'monitor-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'reserve',
    'reserve',
    'close_not_started',
  ]);
});

it('keeps the deliberate refusal while child_run stays disabled', async () => {
  const stillAdmitted: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'unreached' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(stillAdmitted);
  turn = rig.turn;
  enablement.childRun = false;
  enablement.monitorRun = false;
  const { call, parts } = backgroundCall();
  const result = await turn.execute(
    [call],
    parts,
    'model',
    new AbortController().signal,
  );
  expect(result[0]?.functionResponse?.response).toMatchObject({
    error: 'Hosted Shell requires one foreground command.',
  });
  expect(rig.orchestrator.calls).toHaveLength(0);
  expect(broker.executeV3).not.toHaveBeenCalled();
  expect(broker.prepareV3).not.toHaveBeenCalled();
});
