/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { LocalToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/local-managed-tool-result-store.js';
import { LocalShellResultSession } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-session.js';
import { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import { parseToolResultManifestBytes } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointV1,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';
import { registerManagedRuntimeToolRoutes } from './managed-runtime-tool-routes.js';
import { registerManagedRuntimeToolV3Routes } from './managed-runtime-tool-v3-routes.js';

const sessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
};
const shellCommand = 'printf hello';
const identity = {
  tenantId: sessionKey.tenantId,
  sessionId: sessionKey.sessionId,
  turnId: 'turn-a',
  executionCallId: 'execution-a',
  callId: 'call-a',
  invocationDigest: createHash('sha256')
    .update(JSON.stringify({ command: shellCommand }))
    .digest('hex'),
  bindingGeneration: '1',
  captureId: 'capture-a',
  revision: 1,
};
const reference = {
  sessionId: 'runtime-session-a',
  promptId: 'turn-a',
  callId: 'call-a',
  argsDigest: identity.invocationDigest,
};
const headers = {
  authorization: 'Bearer test-token',
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'x-qwen-managed-lease-id': 'lease-a',
  'x-qwen-managed-lease-epoch': '1',
};

let server: Server | undefined;
let store: LocalToolResultSegmentStore | undefined;
let lease: SessionWriterLease | undefined;
let session: ManagedSession | undefined;
let executor: ManagedToolExecutor | undefined;
let root: string | undefined;
afterEach(async () => {
  await executor?.close();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await store?.close();
  if (session) {
    await session.close();
    await session.releaseActivation();
    await session.authority.close();
  } else {
    await lease?.release();
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
  server = undefined;
  store = undefined;
  lease = undefined;
  session = undefined;
  executor = undefined;
  root = undefined;
});

describe('Tool v3 local worker routes', () => {
  it('executes one Shell and binds status and ACK to the original receipt', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-tool-v3-'));
    const runtimeBaseDir = path.join(root, 'runtime');
    const transcriptPath = path.join(
      runtimeBaseDir,
      'chats',
      'session-a.jsonl',
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    store = await LocalToolResultSegmentStore.openWritable({
      lease,
      sessionKey,
    });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    session = await openManagedSession({
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
    const command = (operation: string, commandId: string) => ({
      operation,
      commandId,
      sessionKey,
      contentDigest: '9'.repeat(64),
    });
    const harness = createManagedHarnessHandle(session);
    await harness.ensureRunnable();
    const turnResult = await resources.publish(
      'managed-turn-result',
      Buffer.from('{"state":"completed"}'),
    );
    await session.authority.commitTurnComplete(
      command('settleTurn', 'settle-a'),
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
              activationId: session!.activation.activationId,
              turnId: 'turn-a',
              promptId: 'turn-a',
            }),
          ),
      },
      { class: 'harness', activation: session.activation },
    );
    const argsRef = await resources.publish(
      'managed-tool-args',
      Buffer.from(JSON.stringify({ command: shellCommand })),
    );
    const definitionRef = await resources.publish(
      'managed-tool-definition',
      Buffer.from('{}'),
    );
    await session.authority.appendExecutionEvent(
      command('recordToolIntent', 'intent-a'),
      (sequence) => ({
        v: 1,
        sequence,
        eventId: 'intent:a',
        sessionKey,
        kind: 'tool.intent',
        occurredAt: 1,
        subject: {
          type: 'activation',
          scopeId: session!.activation.activationId,
          activationId: session!.activation.activationId,
          epoch: session!.activation.epoch,
        },
        payload: {
          executionCallId: identity.executionCallId,
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
      functionCallId: identity.callId,
      toolName: 'run_shell_command',
      executionCallId: identity.executionCallId,
      invocationBindingId: 'binding-a',
      capabilityVersion: 'cap-a',
      policyVersion: 'policy-a',
      mediaVersion: null,
      modelMessageId: 'model-a',
      partIndex: 0,
      ordinal: 0,
      inputDigest: identity.invocationDigest,
      progressCursor: null,
      attemptId: 'attempt-a',
      routeRef: await resources.publish('managed-route', Buffer.from('{}')),
    });
    const publisher = new LocalShellResultSession(
      session,
      store,
      '1',
      lease,
      reference.sessionId,
    );
    const toolSet = createManagedToolSet(root, 'runtime-session-a');
    executor = new ManagedToolExecutor(async () => toolSet, publisher);
    const app = express();
    registerManagedRuntimeToolV3Routes(
      app,
      { token: 'test-token', leaseId: 'lease-a', epoch: 1 },
      executor,
    );
    registerManagedRuntimeToolRoutes(
      app,
      {
        token: 'test-token',
        leaseId: 'lease-a',
        epoch: 1,
        runtimeIncarnation: 'incarnation-a',
      },
      executor,
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (operation: string, body: Record<string, unknown>) =>
      fetch(`${origin}/internal/managed-runtime/v3/${operation}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocolVersion: 3,
          toolResult: 'managed-tool-result/1',
          reference,
          ...body,
        }),
      });
    const fixtures = JSON.parse(
      await fs.readFile(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../../core/src/managed-runtime/contracts/managed-tool-result-v1.fixtures.json',
        ),
        'utf8',
      ),
    ) as {
      requestCases: Array<{
        id: string;
        route: string;
        body: Record<string, unknown>;
        valid: boolean;
      }>;
    };
    for (const fixture of fixtures.requestCases.filter((item) => !item.valid)) {
      const response = await fetch(
        `${origin}/internal/managed-runtime/v3/${fixture.route}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(fixture.body),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'managed_runtime_attestation_invalid',
      });
    }
    const marker = path.join(root, 'wrong-args-ran');
    expect(
      (
        await post('execute', {
          toolName: 'run_shell_command',
          input: { command: `touch ${JSON.stringify(marker)}` },
          capture: {
            tenantId: sessionKey.tenantId,
            sessionId: sessionKey.sessionId,
            turnId: 'turn-a',
            executionCallId: identity.executionCallId,
            bindingGeneration: '1',
            capturePolicy: 'complete_required',
          },
        })
      ).status,
    ).toBe(409);
    await expect(fs.access(marker)).rejects.toThrow();
    const execute = await post('execute', {
      toolName: 'run_shell_command',
      input: { command: shellCommand },
      capture: {
        tenantId: sessionKey.tenantId,
        sessionId: sessionKey.sessionId,
        turnId: 'turn-a',
        executionCallId: identity.executionCallId,
        bindingGeneration: '1',
        capturePolicy: 'complete_required',
      },
    });
    expect(execute.status).toBe(200);
    const settled = await execute.json();
    expect(settled).toMatchObject({
      protocolVersion: 3,
      state: 'settled',
      result: {
        executionStatus: 'success',
        capture: { captureStatus: 'complete', deliveryStatus: 'committed' },
      },
    });
    const receiptEvent = session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .find((event) => event.kind === 'tool.receipt');
    expect(receiptEvent).toBeDefined();
    expect(receiptEvent?.payload['resultRef']).toEqual(
      settled.result.capture.manifest,
    );
    expect(
      parseHarnessCheckpointV1((await session.authority.readCheckpointState())!)
        .continuation.phase,
    ).toBe('results_ready');
    const status = await post('status', { afterSequence: 0 });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      state: 'settled',
      result: { capture: { deliveryStatus: 'committed' } },
    });
    for (const operation of ['status', 'cancel']) {
      const v2 = await fetch(
        `${origin}/internal/managed-runtime/v2/${operation}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ protocolVersion: 2, reference }),
        },
      );
      expect(v2.status).toBe(409);
      expect(await v2.json()).toMatchObject({
        code: 'managed_runtime_identity_conflict',
      });
    }
    const receipt = {
      executionCallId: identity.executionCallId,
      manifest: settled.result.capture.manifest,
      deliveryStatus: 'committed',
      historyRevision: receiptEvent!.sequence,
    };
    expect((await post('acknowledge', { receipt })).status).toBe(200);
    const changedAck = await post('acknowledge', {
      receipt: { ...receipt, historyRevision: receipt.historyRevision + 1 },
    });
    expect(changedAck.status).toBe(409);
    expect(await changedAck.json()).toMatchObject({
      code: 'managed_tool_result_conflict',
    });
    expect(
      (
        await post('execute', {
          toolName: 'run_shell_command',
          input: { command: 'printf changed' },
          capture: {
            tenantId: sessionKey.tenantId,
            sessionId: sessionKey.sessionId,
            turnId: 'turn-a',
            executionCallId: identity.executionCallId,
            bindingGeneration: '1',
            capturePolicy: 'complete_required',
          },
        })
      ).status,
    ).toBe(409);
  }, 30_000);

  it('does not rerun a Shell side effect after segment storage fails', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-tool-v3-fault-'));
    const runtimeBaseDir = path.join(root, 'runtime');
    const transcriptPath = path.join(
      runtimeBaseDir,
      'chats',
      'session-a.jsonl',
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    lease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    store = await LocalToolResultSegmentStore.openWritable({
      lease,
      sessionKey,
    });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    const failingStore: ToolResultSegmentStore = {
      publish: async () => {
        throw new Error('ENOSPC');
      },
      seal: (request) => store!.seal(request),
      prefix: (request) => store!.prefix(request),
      readRange: (request) => store!.readRange(request),
      close: () => store!.close(),
    };
    const marker = path.join(root, 'effects');
    const command = `printf x >> ${JSON.stringify(marker)}; head -c 1048576 /dev/zero`;
    const input = { command, is_background: false };
    const digest = managedToolDigest(input);
    const originalReference = { ...reference, argsDigest: digest };
    const request = {
      reference: originalReference,
      toolName: 'run_shell_command',
      input,
      capture: {
        tenantId: sessionKey.tenantId,
        sessionId: sessionKey.sessionId,
        turnId: 'turn-a',
        executionCallId: identity.executionCallId,
        bindingGeneration: '1',
        capturePolicy: 'complete_required' as const,
      },
    };
    const outcomeRef = await resources.publish(
      'managed-tool-outcome',
      Buffer.from('{}'),
    );
    let receiptFails = false;
    executor = new ManagedToolExecutor(
      async () => createManagedToolSet(root!, 'runtime-session-a'),
      {
        prepare: async ({ reference: call, capture }) => {
          const captureIdentity = {
            ...identity,
            callId: call.callId,
            executionCallId: capture.executionCallId,
            captureId: `capture-${call.callId}`,
            invocationDigest: digest,
          };
          return {
            identity: captureIdentity,
            sink: new LocalShellResultCapture(
              failingStore,
              resources,
              captureIdentity,
            ),
          };
        },
        accept: async (_identity, envelope) => {
          if (receiptFails) throw new Error('receipt unavailable');
          return {
            executionCallId: identity.executionCallId,
            manifest: envelope.capture?.manifest ?? null,
            deliveryStatus: 'blocked',
            historyRevision: null,
            outcomeRef,
          };
        },
      },
    );
    const [first, concurrent] = await Promise.all([
      executor.executeV3(request),
      executor.executeV3({
        ...request,
        input: { is_background: false, command },
        capture: {
          capturePolicy: 'complete_required',
          bindingGeneration: '1',
          executionCallId: identity.executionCallId,
          turnId: 'turn-a',
          sessionId: sessionKey.sessionId,
          tenantId: sessionKey.tenantId,
        },
      }),
    ]);
    expect(concurrent).toEqual(first);
    expect(first).toMatchObject({
      state: 'settled',
      result: {
        executionStatus: 'success',
        capture: { captureStatus: 'unavailable', deliveryStatus: 'blocked' },
      },
    });
    expect(await fs.readFile(marker, 'utf8')).toBe('x');
    expect(await executor.executeV3(request)).toEqual(first);
    expect(executor.statusV3(originalReference)).toEqual(first);
    expect(await fs.readFile(marker, 'utf8')).toBe('x');
    receiptFails = true;
    const receiptFailure = {
      ...request,
      reference: { ...originalReference, callId: 'call-b' },
      capture: { ...request.capture, executionCallId: 'execution-b' },
    };
    const unknown = await executor.executeV3(receiptFailure);
    expect(unknown.state).toBe('unknown');
    expect(executor.hasActiveSession(originalReference.sessionId)).toBe(false);
    expect(await executor.executeV3(receiptFailure)).toEqual(unknown);
    expect(await fs.readFile(marker, 'utf8')).toBe('xx');
  }, 30_000);

  it('reopens the committed 100 MiB after the real worker host exits', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-tool-v3-host-'));
    const helper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'managed-runtime-tool-v3-host.test-helper.ts',
    );
    const child = fork(helper, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let hostResult: {
      status: string;
      manifestRef: Awaited<
        ReturnType<LocalManagedSessionResourceStore['publish']>
      >;
      identity: Parameters<LocalShellResultSession['recorded']>[0];
      historyRevision: number;
    };
    try {
      hostResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('child host timed out')),
          60_000,
        );
        child.once('message', (message) => {
          clearTimeout(timeout);
          resolve(message as typeof hostResult);
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`child host exited before reporting: ${code}`));
        });
        child.send({ root });
      });
      if (child.exitCode === null) {
        await new Promise<void>((resolve, reject) =>
          child.once('exit', (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`child host exited ${code}`)),
          ),
        );
      }
      expect(hostResult.status).toBe('ok');
    } finally {
      if (child.exitCode === null) child.kill();
    }
    const runtimeBaseDir = path.join(root, 'runtime');
    const transcriptPath = path.join(
      runtimeBaseDir,
      'chats',
      'session-a.jsonl',
    );
    lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    session = await openManagedSession({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
      sessionKey,
      cwd: root,
      version: 'test',
      workerId: 'worker-b',
      activationLeaseDurationMs: 60_000,
      lease,
      resourceStore: resources,
    });
    store = await LocalToolResultSegmentStore.openReadOnly({
      runtimeBaseDir,
      sessionKey,
    });
    const coordinator = new LocalShellResultSession(
      session,
      store,
      '1',
      lease,
      'runtime-session-a',
    );
    expect(await coordinator.recorded(hostResult.identity)).toMatchObject({
      executionCallId: 'execution-a',
      deliveryStatus: 'committed',
      historyRevision: hostResult.historyRevision,
      manifest: hostResult.manifestRef,
    });
    const manifest = parseToolResultManifestBytes(
      await resources.read(hostResult.manifestRef),
    );
    const stdout = manifest.contents.find(
      (entry) => entry.streamId === 'stdout',
    );
    const expectedHash = createHash('sha256');
    const unit = Buffer.alloc(1024 * 1024, 0x91);
    for (let index = 0; index < 100; index++) expectedHash.update(unit);
    expect(stdout?.byteLength).toBe(100 * 1024 * 1024);
    expect(stdout?.digest).toBe(expectedHash.digest('hex'));
    expect(
      await store.readRange({
        manifestRef: hostResult.manifestRef,
        expectedIdentity: hostResult.identity,
        streamId: 'stdout',
        offset: 100 * 1024 * 1024 - 5,
        length: 5,
      }),
    ).toEqual({ status: 'ok', result: Buffer.alloc(5, 0x91) });
  }, 120_000);

  it('keeps sealed bytes without admitting an unreceipted result after host death', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-tool-v3-crash-'));
    const helper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'managed-runtime-tool-v3-host.test-helper.ts',
    );
    const child = fork(helper, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      const signal = await new Promise<NodeJS.Signals | null>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('child host crash timed out')),
            60_000,
          );
          child.once('exit', (_code, stoppedBy) => {
            clearTimeout(timeout);
            resolve(stoppedBy);
          });
          child.once('error', reject);
          child.send({ root, crashBeforeReceipt: true });
        },
      );
      expect(signal).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    const runtimeBaseDir = path.join(root, 'runtime');
    store = await LocalToolResultSegmentStore.openReadOnly({
      runtimeBaseDir,
      sessionKey,
    });
    const captureId = createHash('sha256')
      .update(JSON.stringify([sessionKey, 'execution-a', '1']))
      .digest('hex')
      .slice(0, 32);
    const prefix = await store.prefix({ captureId, streamId: 'stdout' });
    const expectedHash = createHash('sha256');
    const unit = Buffer.alloc(1024 * 1024, 0x91);
    for (let index = 0; index < 100; index++) expectedHash.update(unit);
    expect(prefix).toEqual({
      status: 'ok',
      result: {
        sealed: true,
        segmentCount: 100,
        byteLength: 100 * 1024 * 1024,
        digest: expectedHash.digest('hex'),
      },
    });
    const transcriptPath = path.join(
      runtimeBaseDir,
      'chats',
      'session-a.jsonl',
    );
    expect(await fs.readFile(transcriptPath, 'utf8')).not.toContain(
      'tool.receipt',
    );
    lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
    });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    });
    session = await openManagedSession({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
      sessionKey,
      cwd: root,
      version: 'test',
      workerId: 'worker-b',
      activationLeaseDurationMs: 60_000,
      lease,
      resourceStore: resources,
    });
    const checkpoint = parseHarnessCheckpointV1(
      (await session.authority.readCheckpointState())!,
    );
    expect(checkpoint.continuation.phase).toBe('await_runtime');
    const originalDigest = checkpoint.tools?.items.find(
      (item) => item.executionCallId === 'execution-a',
    )?.inputDigest;
    expect(originalDigest).toMatch(/^[0-9a-f]{64}$/);
    const coordinator = new LocalShellResultSession(
      session,
      store,
      '1',
      lease,
      'runtime-session-a',
    );
    expect(
      await coordinator.recorded({
        ...identity,
        invocationDigest: originalDigest!,
        captureId,
      }),
    ).toBeNull();
    await expect(
      coordinator.prepare({
        reference: {
          sessionId: 'runtime-session-a',
          promptId: 'turn-a',
          callId: 'call-a',
          argsDigest: originalDigest!,
        },
        capture: {
          tenantId: sessionKey.tenantId,
          sessionId: sessionKey.sessionId,
          turnId: 'turn-a',
          executionCallId: 'execution-a',
          bindingGeneration: '1',
          capturePolicy: 'complete_required',
        },
      }),
    ).rejects.toThrow(/before dispatch/);
  }, 120_000);

  it('admits a native Monitor payload into the Monitor admission family', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-tool-v3-monitor-'));
    executor = new ManagedToolExecutor(
      async () => createManagedToolSet(root!, 'runtime-session-a'),
      {} as never,
    );
    const app = express();
    registerManagedRuntimeToolV3Routes(
      app,
      { token: 'test-token', leaseId: 'lease-a', epoch: 1 },
      executor,
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (operation: string, body: Record<string, unknown>) =>
      fetch(`${origin}/internal/managed-runtime/v3/${operation}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocolVersion: 3,
          toolResult: 'managed-tool-result/1',
          reference,
          ...body,
        }),
      });
    const capture = {
      tenantId: sessionKey.tenantId,
      sessionId: sessionKey.sessionId,
      turnId: 'turn-a',
      executionCallId: identity.executionCallId,
      bindingGeneration: '1',
      capturePolicy: 'complete_required',
    };
    const admitted = await post('execute', {
      toolName: 'monitor',
      input: { command: shellCommand },
      capture,
    });
    expect(admitted.status).toBe(200);
    // The payload ran as far as the monitor admission family; without a
    // delegated cgroup root this exact Runtime accurately refuses the start
    // rather than the payload.
    expect(await admitted.json()).toMatchObject({
      protocolVersion: 3,
      state: 'settled',
      result: {
        executionStatus: 'not_started',
        capture: null,
        error: {
          message:
            'Monitor watch requires a delegated Linux cgroup v2 root on this Runtime.',
        },
      },
    });
    const refused = await post('execute', {
      toolName: 'edit',
      input: { command: shellCommand },
      capture,
    });
    expect(refused.status).toBe(400);
  });
});
