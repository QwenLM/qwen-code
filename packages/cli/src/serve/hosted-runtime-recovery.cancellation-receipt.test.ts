/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import { settleInterruptedTurnRuntime } from './hosted-runtime-recovery.js';

let root: string | undefined;
let session: ManagedSession | undefined;
let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await session?.close();
  resetManagedRuntimeDispatchGatesForTest();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  session = undefined;
  server = undefined;
});

async function cancellationFixture(
  resultKind:
    | 'producer-lost'
    | 'not-found'
    | 'settled-success'
    | 'settled-error'
    | 'settled-not-started'
    | 'legacy-cancelled' = 'producer-lost',
  identity: { harnessSessionId?: string; bindingGeneration?: string } = {},
) {
  root = await mkdtemp(path.join(tmpdir(), 'hosted-cancel-receipt-'));
  const key = {
    tenantId: 'tenant-cancel',
    workspaceId: 'workspace-cancel',
    sessionId: randomUUID(),
  };
  const promptId = 'prompt-cancel';
  const executionCallId = 'execution-cancel';
  const workerCallId = 'worker-call-cancel';
  const modelCallId = 'model-call-cancel';
  const transcriptPath = path.join(root, 'transcript.jsonl');
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey: key,
  });
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath,
    sessionId: key.sessionId,
    sessionKey: key,
    version: 'test',
    workerId: 'replacement-worker',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  const command = (operation: string, commandId: string, bytes: Buffer) => ({
    operation,
    commandId,
    sessionKey: key,
    contentDigest: createHash('sha256').update(bytes).digest('hex'),
  });
  const input = {
    command: 'a foreground process cancelled by its owner',
    timeout: 540_000,
    is_background: false,
    description: 'original foreground cancellation',
  };
  const payloadJson = JSON.stringify({ toolName: 'run_shell_command', input });
  const inputBytes = Buffer.from(payloadJson);
  const requestDigest = `sha256:${createHash('sha256').update(inputBytes).digest('hex')}`;
  const inputDigest = managedToolDigest(input);
  const argsRef = await resources.publish(
    'managed-tool-args',
    Buffer.from(JSON.stringify(input)),
  );
  const contentRef = await resources.publish(
    'managed-input',
    Buffer.from('{}'),
  );
  await session.authority.submitInput(
    command('submitInput', promptId, inputBytes),
    {
      inputId: promptId,
      turnId: promptId,
      source: 'web_shell',
      contentRef,
      admissionRef: contentRef,
      deadline: null,
      wakeReason: 'input',
    },
  );
  const harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  await session.sink.write({
    uuid: 'model-message-cancel',
    parentUuid: null,
    sessionId: key.sessionId,
    timestamp: new Date().toISOString(),
    type: 'assistant',
    cwd: root,
    version: 'test',
    daemonPromptId: promptId,
    model: 'test-model',
    message: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: modelCallId,
            name: 'run_shell_command',
            args: input,
          },
        },
      ],
    },
  });
  const definitionRef = await resources.publish(
    'managed-tool-definition',
    Buffer.from('{}'),
  );
  await session.authority.appendExecutionEvent(
    command('toolIntent', executionCallId, inputBytes),
    (sequence) => ({
      v: 1,
      sequence,
      eventId: 'intent-cancel',
      sessionKey: key,
      kind: 'tool.intent',
      occurredAt: Date.now(),
      subject: {
        type: 'activation',
        scopeId: session!.activation.activationId,
        ...session!.activation,
      },
      payload: {
        executionCallId,
        batchId: 'batch-cancel',
        ordinal: 0,
        toolDefinitionRef: definitionRef,
        argsRef,
        outcomeSource: 'runtime',
      },
    }),
    { class: 'harness', activation: session.activation },
  );
  await harness.commitAwaitRuntimeBatch(
    [
      {
        functionCallId: modelCallId,
        toolName: 'run_shell_command',
        executionCallId,
        invocationBindingId: workerCallId,
        capabilityVersion: 'cap-cancel',
        policyVersion: 'policy-cancel',
        mediaVersion: null,
        modelMessageId: 'model-message-cancel',
        partIndex: 0,
        ordinal: 0,
        inputDigest,
        progressCursor: null,
        attemptId: 'attempt-cancel',
        routeRef: await resources.publish('managed-route', Buffer.from('{}')),
      },
    ],
    { turnId: promptId, promptId },
  );
  const envelope: ToolResultEnvelope = {
    executionStatus: 'cancelled',
    responseParts: [{ text: 'output before the original publisher was lost' }],
    error: { message: 'Cancelled output is unavailable.' },
    capture: {
      captureStatus: 'unavailable',
      captureReason: 'producer_lost',
      manifest: null,
      previewTruncated: true,
      deliveryStatus: 'blocked',
    },
  };
  const requests: string[] = [];
  let cancelled = false;
  server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}`);
    const route = `/internal/runtime-broker/v1/executions/${executionCallId}`;
    if (request.method === 'POST' && url.pathname === `${route}:cancel`) {
      cancelled = true;
    } else if (request.method !== 'GET' || url.pathname !== route) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'unexpected_test_route' }));
      return;
    }
    if (resultKind === 'not-found') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'runtime_execution_not_found' }));
      return;
    }
    const settled = cancelled || resultKind !== 'producer-lost';
    const brokerResult =
      resultKind === 'legacy-cancelled'
        ? {
            executionStatus: 'cancelled',
            responseParts: envelope.responseParts,
            error: envelope.error,
          }
        : resultKind.startsWith('settled-')
          ? {
              executionStatus: resultKind
                .slice('settled-'.length)
                .replace('-', '_'),
              responseParts: envelope.responseParts,
              capture:
                resultKind === 'settled-not-started' ? null : envelope.capture,
            }
          : envelope;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        protocolVersion: 1,
        harnessSessionId: identity.harnessSessionId ?? key.sessionId,
        runtimeSessionId: promptId,
        executionCallId,
        requestDigest,
        runtimeBindingId: 'binding-cancel',
        bindingGeneration: identity.bindingGeneration ?? '1',
        status: {
          state: settled ? 'settled' : 'executing',
          ...(settled ? { result: brokerResult } : {}),
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const managed = session;
  const settleInput = {
    session,
    sessionId: key.sessionId,
    cwd: root,
    promptId,
    brokerOptions: {
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'fixture-only',
    },
    toolProfile: true,
    shell: {
      resources: session.resources,
      async assertWritable() {
        const authority = session!.authority;
        const activation = authority.currentActivation;
        const authorization = await authority.harnessRunAuthorization();
        if (
          authority.writesStopped ||
          !activation ||
          activation.phase !== 'active' ||
          activation.expiresAt <= Date.now() ||
          authorization.status !== 'runnable'
        ) {
          throw new Error('The actual fixture authority is not writable.');
        }
      },
    },
  };
  return {
    key,
    executionCallId,
    workerCallId,
    modelCallId,
    promptId,
    transcriptPath,
    resources,
    envelope,
    requests,
    session: managed,
    cancelled: () => cancelled,
    settle: () => settleInterruptedTurnRuntime(settleInput),
  };
}

it('records a durable Shell receipt when cancellation recovery settles a producer-lost execution', async () => {
  const f = await cancellationFixture();
  const {
    key,
    executionCallId,
    workerCallId,
    promptId,
    transcriptPath,
    resources,
    envelope,
    requests,
    session: managed,
  } = f;
  const result = await f.settle();
  expect(result.kind).toBe('ready');
  expect(f.cancelled()).toBe(true);
  expect(requests.filter((r) => r.endsWith(':cancel'))).toHaveLength(1);
  expect(requests.some((r) => /:start|:prepare/.test(r))).toBe(false);
  const journal = await LocalJsonlManagedSessionJournalStore.read(
    transcriptPath,
    key,
  );
  const receipts = journal.events.filter(
    (event) =>
      event.kind === 'tool.receipt' &&
      event.payload['executionCallId'] === executionCallId,
  );
  expect(receipts).toHaveLength(1);
  const ref = assertManagedSessionDurableRef(
    receipts[0].payload['toolOutcomeRef'],
    'native cancellation outcome',
  );
  const outcome = JSON.parse((await resources.read(ref)).toString());
  expect(outcome).toMatchObject({
    version: 1,
    decision: 'blocked',
    identity: {
      tenantId: key.tenantId,
      sessionId: key.sessionId,
      turnId: promptId,
      executionCallId,
      callId: workerCallId,
      bindingGeneration: '1',
    },
    envelope: {
      ...envelope,
      capture: { ...envelope.capture, deliveryStatus: 'pending' },
    },
  });
  expect(receipts[0].payload['resultRef']).toBeNull();
  expect(receipts[0].payload['resources']).toEqual([]);
  const authorization = await managed.authority.harnessRunAuthorization();
  expect(authorization.status).toBe('runnable');
  if (authorization.status === 'runnable') {
    expect(authorization.checkpoint.tools?.items[0].outcomeRef).toEqual(ref);
  }
});

it.each([
  'not-found',
  'settled-success',
  'settled-error',
  'settled-not-started',
  'legacy-cancelled',
] as const)(
  'settles %s through a generic cancellation outcome without a native receipt',
  async (resultKind) => {
    const f = await cancellationFixture(resultKind);
    await expect(f.settle()).resolves.toMatchObject({ kind: 'ready' });
    const authorization = await f.session.authority.harnessRunAuthorization();
    expect(authorization.status).toBe('runnable');
    if (authorization.status !== 'runnable') return;
    expect(authorization.checkpoint.continuation.phase).toBe('results_ready');
    const item = authorization.checkpoint.tools!.items[0];
    expect(item.state).toBe('settled');
    const ref = item.outcomeRef;
    if (ref === null) throw new Error('Missing generic cancellation outcome.');
    expect(ref.kind).toBe('managed-tool-outcome');
    const outcome = JSON.parse((await f.resources.read(ref)).toString());
    expect(Object.keys(outcome).sort()).toEqual([
      'executionCallId',
      'functionResponse',
    ]);
    expect(outcome).toMatchObject({
      executionCallId: f.executionCallId,
      functionResponse: {
        id: f.modelCallId,
        name: 'run_shell_command',
        response: { executionStatus: 'cancelled' },
      },
    });
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      f.transcriptPath,
      f.key,
    );
    expect(
      journal.events.filter((event) => event.kind === 'tool.receipt'),
    ).toHaveLength(0);
    await expect(f.settle()).resolves.toMatchObject({ kind: 'ready' });
    const repeated = await f.session.authority.harnessRunAuthorization();
    expect(repeated.status).toBe('runnable');
    if (repeated.status === 'runnable') {
      expect(repeated.checkpoint.tools!.items[0].outcomeRef).toEqual(ref);
    }
    const repeatedJournal = await LocalJsonlManagedSessionJournalStore.read(
      f.transcriptPath,
      f.key,
    );
    expect(
      repeatedJournal.events.filter((event) => event.kind === 'tool.receipt'),
    ).toHaveLength(0);
    expect(repeatedJournal.events).toHaveLength(journal.events.length);
    expect(f.cancelled()).toBe(false);
    expect(f.requests.some((request) => /:start|:prepare/.test(request))).toBe(
      false,
    );
  },
);

it.each([
  {
    identity: { harnessSessionId: 'foreign-session' },
    message: 'Runtime Broker response identity changed.',
  },
  {
    identity: { bindingGeneration: '0' },
    message: 'Original Shell result is not settled under its binding.',
  },
])(
  'keeps a legacy result with conflicting identity pending (%j)',
  async ({ identity, message }) => {
    const f = await cancellationFixture('legacy-cancelled', identity);
    await expect(f.settle()).rejects.toThrow(message);
    const authorization = await f.session.authority.harnessRunAuthorization();
    expect(authorization.status).toBe('runnable');
    if (authorization.status === 'runnable') {
      expect(authorization.checkpoint.continuation.phase).toBe('await_runtime');
      expect(authorization.checkpoint.tools!.items[0].state).toBe(
        'in_progress',
      );
    }
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      f.transcriptPath,
      f.key,
    );
    expect(
      journal.events.filter((event) => event.kind === 'tool.receipt'),
    ).toHaveLength(0);
  },
);
