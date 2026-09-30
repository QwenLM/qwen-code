/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import express from 'express';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { LocalToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/local-managed-tool-result-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { parseToolResultManifestBytes } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import { LocalShellResultSession } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-session.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';
import { registerManagedRuntimeToolV3Routes } from './managed-runtime-tool-v3-routes.js';

const sessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
};
const script = `
  const { once } = require('node:events');
  (async () => {
    const bytes = Buffer.alloc(1024 * 1024, 0x91);
    for (let index = 0; index < 100; index++) {
      if (!process.stdout.write(bytes)) await once(process.stdout, 'drain');
    }
  })().catch(() => process.exit(1));
`;
const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script.replace(/\s+/g, ' '))}`;
const argsDigest = createHash('sha256')
  .update(JSON.stringify({ command }))
  .digest('hex');

async function run(root: string, crashBeforeReceipt: boolean) {
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(runtimeBaseDir, 'chats', 'session-a.jsonl');
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir,
    sessionId: sessionKey.sessionId,
    transcriptPath,
  });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  const store = await LocalToolResultSegmentStore.openWritable({
    lease,
    sessionKey,
  });
  const session = await openManagedSession({
    runtimeBaseDir,
    sessionId: sessionKey.sessionId,
    transcriptPath,
    sessionKey,
    cwd: root,
    version: 'test',
    workerId: 'worker-a',
    activationLeaseDurationMs: 60_000,
    lease,
    resourceStore: resources,
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
  const harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  const commandIdentity = (operation: string, commandId: string) => ({
    operation,
    commandId,
    sessionKey,
    contentDigest: '9'.repeat(64),
  });
  const turnResult = await resources.publish(
    'managed-turn-result',
    Buffer.from('{"state":"completed"}'),
  );
  await session.authority.commitTurnComplete(
    commandIdentity('settleTurn', 'settle-a'),
    {
      turn: {
        turnId: 'turn-a',
        outcome: 'completed',
        stopReason: 'end_turn',
        resultRef: turnResult,
        occurredAt: 1,
        eventId: 'turn:a',
      },
      boundary: 'turn_complete',
      state: (checkpointIdentity, previous) =>
        encodeHarnessCheckpointV1(
          createNextTurnReadyHarnessCheckpoint({
            previous,
            ...checkpointIdentity,
            activationId: session.activation.activationId,
            turnId: 'turn-a',
            promptId: 'turn-a',
          }),
        ),
    },
    { class: 'harness', activation: session.activation },
  );
  const argsRef = await resources.publish(
    'managed-tool-args',
    Buffer.from(JSON.stringify({ command })),
  );
  const definitionRef = await resources.publish(
    'managed-tool-definition',
    Buffer.from('{}'),
  );
  await session.authority.appendExecutionEvent(
    commandIdentity('recordToolIntent', 'intent-a'),
    (sequence) => ({
      v: 1,
      sequence,
      eventId: 'intent:a',
      sessionKey,
      kind: 'tool.intent',
      occurredAt: 1,
      subject: {
        type: 'activation',
        scopeId: session.activation.activationId,
        activationId: session.activation.activationId,
        epoch: session.activation.epoch,
      },
      payload: {
        executionCallId: 'execution-a',
        batchId: 'batch-a',
        ordinal: 0,
        toolDefinitionRef: definitionRef,
        argsRef,
        outcomeSource: 'runtime',
      },
    }),
    { class: 'harness', activation: session.activation },
  );
  await harness.commitAwaitRuntime({
    functionCallId: 'call-a',
    toolName: 'run_shell_command',
    executionCallId: 'execution-a',
    invocationBindingId: 'binding-a',
    capabilityVersion: 'cap-a',
    policyVersion: 'policy-a',
    mediaVersion: null,
    modelMessageId: 'model-a',
    partIndex: 0,
    ordinal: 0,
    inputDigest: argsDigest,
    progressCursor: null,
    attemptId: 'attempt-a',
    routeRef: await resources.publish('managed-route', Buffer.from('{}')),
  });
  const publisher = new LocalShellResultSession(
    session,
    store,
    '1',
    lease,
    'runtime-session-a',
  );
  const toolSet = createManagedToolSet(root, 'runtime-session-a');
  const executor = new ManagedToolExecutor(
    async () => toolSet,
    crashBeforeReceipt
      ? {
          prepare: (request) => publisher.prepare(request),
          accept: async () => {
            process.kill(process.pid, 'SIGKILL');
            throw new Error('child host did not stop');
          },
        }
      : publisher,
  );
  const app = express();
  registerManagedRuntimeToolV3Routes(
    app,
    { token: 'test-token', leaseId: 'lease-a', epoch: 1 },
    executor,
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(
    `${origin}/internal/managed-runtime/v3/execute`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'x-qwen-managed-lease-id': 'lease-a',
        'x-qwen-managed-lease-epoch': '1',
      },
      body: JSON.stringify({
        protocolVersion: 3,
        toolResult: 'managed-tool-result/1',
        reference: {
          sessionId: 'runtime-session-a',
          promptId: 'turn-a',
          callId: 'call-a',
          argsDigest,
        },
        toolName: 'run_shell_command',
        input: { command },
        capture: {
          tenantId: sessionKey.tenantId,
          sessionId: sessionKey.sessionId,
          turnId: 'turn-a',
          executionCallId: 'execution-a',
          bindingGeneration: '1',
          capturePolicy: 'complete_required',
        },
      }),
    },
  );
  const answer = (await response.json()) as {
    state: string;
    result?: {
      executionStatus: string;
      capture?: {
        captureStatus: string;
        deliveryStatus: string;
        manifest: unknown;
      };
    };
  };
  if (
    response.status !== 200 ||
    answer.state !== 'settled' ||
    answer.result?.executionStatus !== 'success' ||
    answer.result.capture?.captureStatus !== 'complete' ||
    answer.result.capture.deliveryStatus !== 'committed'
  ) {
    throw new Error(`child host did not commit: ${JSON.stringify(answer)}`);
  }
  const manifestRef = answer.result.capture.manifest;
  const manifest = parseToolResultManifestBytes(
    await resources.read(manifestRef as Parameters<typeof resources.read>[0]),
  );
  const receipt = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .find((event) => event.kind === 'tool.receipt');
  if (!receipt) throw new Error('child host committed no receipt');
  await executor.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await store.close();
  await session.close();
  await session.releaseActivation();
  await session.authority.close();
  return {
    manifestRef,
    identity: {
      tenantId: manifest.tenantId,
      sessionId: manifest.sessionId,
      turnId: manifest.turnId,
      executionCallId: manifest.executionCallId,
      callId: manifest.callId,
      invocationDigest: manifest.invocationDigest,
      bindingGeneration: manifest.bindingGeneration,
      captureId: manifest.captureId,
      revision: manifest.revision,
    },
    historyRevision: receipt.sequence,
  };
}

process.once('message', (message: unknown) => {
  const request = message as { root?: unknown; crashBeforeReceipt?: unknown };
  const root = request?.root;
  if (typeof root !== 'string') throw new Error('host root is missing');
  void run(root, request.crashBeforeReceipt === true).then(
    (result) =>
      process.send?.({ status: 'ok', ...result }, () => process.exit(0)),
    (error: unknown) =>
      process.send?.({ status: 'error', message: String(error) }, () =>
        process.exit(1),
      ),
  );
});
