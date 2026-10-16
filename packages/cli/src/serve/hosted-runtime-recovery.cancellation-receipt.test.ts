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

it('records a durable Shell receipt when cancellation recovery settles a producer-lost execution', async () => {
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
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        protocolVersion: 1,
        harnessSessionId: key.sessionId,
        runtimeSessionId: promptId,
        executionCallId,
        requestDigest,
        runtimeBindingId: 'binding-cancel',
        bindingGeneration: '1',
        reference: {
          runtimeProtocol: 3,
          dispatchMode: 'deferred',
          sessionId: promptId,
          promptId,
          callId: workerCallId,
          argsDigest: requestDigest,
          inputDigest,
        },
        status: {
          state: cancelled ? 'settled' : 'executing',
          ...(cancelled ? { result: envelope } : {}),
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const result = await settleInterruptedTurnRuntime({
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
  });
  expect(result.kind).toBe('ready');
  expect(cancelled).toBe(true);
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
  const authorization = await session.authority.harnessRunAuthorization();
  expect(authorization.status).toBe('runnable');
  if (authorization.status === 'runnable') {
    expect(authorization.checkpoint.tools?.items[0].outcomeRef).toEqual(ref);
  }
});
