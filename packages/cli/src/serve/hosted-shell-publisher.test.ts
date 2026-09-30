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
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointV1,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
import {
  ResourceToolResultSegmentStore,
  type DurableToolResultResourceStore,
} from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ManagedShellCaptureSink } from './managed-runtime-tool-executor.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import {
  boundedShellPreview,
  ManagedShellPublisherRegistry,
  MANAGED_SHELL_PUBLISHER_ROUTE,
  parseShellPublisher,
} from './managed-shell-publisher.js';

let root: string | undefined;
let session: ManagedSession | undefined;
let publisher: HostedShellPublisher | undefined;
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await publisher?.close();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await session?.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  session = undefined;
  publisher = undefined;
  server = undefined;
});

const headers = {
  authorization: 'Bearer runtime-token',
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'x-qwen-managed-lease-id': 'lease-a',
  'x-qwen-managed-lease-epoch': '1',
};

async function fixture(runtimeCallId = 'worker-call-a') {
  root = await mkdtemp(path.join(tmpdir(), 'qwen-hosted-publisher-'));
  const key = {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    sessionId: randomUUID(),
  };
  const local = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey: key,
  });
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: key.sessionId,
    sessionKey: key,
    version: 'test',
    workerId: 'worker-a',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await local.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await local.publish('managed-root', Buffer.from('{}')),
      createdBy: 'test',
    },
  });
  const authority = session.authority;
  const harness = createManagedHarnessHandle(session);
  const command = (operation: string, commandId: string) => ({
    operation,
    commandId,
    sessionKey: key,
    contentDigest: '1'.repeat(64),
  });
  await harness.ensureRunnable();
  await authority.commitTurnComplete(
    command('settleTurn', 'settle-a'),
    {
      turn: {
        turnId: 'turn-a',
        outcome: 'completed',
        stopReason: 'end_turn',
        resultRef: await local.publish(
          'managed-turn-result',
          Buffer.from('{}'),
        ),
        occurredAt: 1,
        eventId: 'turn-a',
      },
      boundary: 'turn_complete',
      state: (identity, previous) =>
        encodeHarnessCheckpointV1(
          createNextTurnReadyHarnessCheckpoint({
            previous,
            ...identity,
            activationId: session!.activation.activationId,
            turnId: 'turn-a',
            promptId: 'prompt-a',
          }),
        ),
    },
    { class: 'harness', activation: session.activation },
  );
  const input = { command: 'printf hello' };
  const request: LocalShellCaptureRequest = {
    reference: {
      sessionId: 'runtime-a',
      promptId: 'prompt-a',
      callId: 'worker-call-a',
      argsDigest: managedToolDigest(input),
    },
    capture: {
      tenantId: key.tenantId,
      sessionId: key.sessionId,
      turnId: 'turn-a',
      executionCallId: 'execution-a',
      bindingGeneration: '1',
      capturePolicy: 'complete_required',
    },
  };
  const definitionRef = await local.publish(
    'managed-tool-definition',
    Buffer.from('{}'),
  );
  const argsRef = await local.publish(
    'managed-tool-args',
    Buffer.from(JSON.stringify(input)),
  );
  await authority.appendExecutionEvent(
    command('toolIntent', 'intent-a'),
    (sequence) => ({
      v: 1,
      sequence,
      eventId: 'intent-a',
      sessionKey: key,
      kind: 'tool.intent',
      occurredAt: 1,
      subject: {
        type: 'activation',
        scopeId: session!.activation.activationId,
        ...session!.activation,
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
    functionCallId: 'model-call-a',
    toolName: 'run_shell_command',
    executionCallId: 'execution-a',
    invocationBindingId: runtimeCallId,
    capabilityVersion: 'cap-a',
    policyVersion: 'policy-a',
    mediaVersion: null,
    modelMessageId: 'model-a',
    partIndex: 0,
    ordinal: 0,
    inputDigest: managedToolDigest(input),
    progressCursor: null,
    attemptId: 'attempt-a',
    routeRef: await local.publish('managed-route', Buffer.from('{}')),
  });
  const values = new Map<
    string,
    { ref: ManagedSessionDurableRef; bytes: Buffer }
  >();
  const resources: DurableToolResultResourceStore = {
    async publish(kind, bytes, resourceId = randomUUID()) {
      const ref = {
        resourceId,
        kind,
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
      const previous = values.get(resourceId);
      if (previous && JSON.stringify(previous.ref) !== JSON.stringify(ref))
        throw new Error('Resource conflicts.');
      values.set(resourceId, { ref, bytes: Buffer.from(bytes) });
      return ref;
    },
    async read(ref) {
      const entry = values.get(ref.resourceId);
      if (!entry || JSON.stringify(entry.ref) !== JSON.stringify(ref))
        throw new Error('Resource unavailable.');
      return Buffer.from(entry.bytes);
    },
  };
  const writable = vi.fn(async () => {});
  publisher = new HostedShellPublisher(
    session,
    resources,
    writable,
    'runtime-a',
  );
  const descriptor = await publisher.start();
  publisher.register(request, 'model-call-a');
  const registry = new ManagedShellPublisherRegistry();
  const app = express();
  registry.register(
    app,
    { token: 'runtime-token', leaseId: 'lease-a', epoch: 1 },
    (id) => id === 'runtime-a',
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const registrationUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${MANAGED_SHELL_PUBLISHER_ROUTE.path}`;
  const register = (
    publisherDescriptor = descriptor,
    sessionId = 'runtime-a',
  ) =>
    fetch(registrationUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 3,
        toolResult: 'managed-tool-result/1',
        sessionId,
        publisher: publisherDescriptor,
      }),
    });
  expect((await register()).status).toBe(200);
  return {
    request,
    registry,
    resources,
    writable,
    register,
    descriptor,
    values,
  };
}

function physical(sink: ManagedShellCaptureSink): void {
  sink.setStarted(42);
  sink.setProcessResult({
    rawOutput: Buffer.from('preview'),
    output: 'preview',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    pid: 42,
    executionMethod: 'child_process',
  });
}

it('captures through HTTP and commits one receipt without advancing model history', async () => {
  const { registry, request, resources } = await fixture();
  const { sink, identity } = await registry.prepare(request);
  physical(sink);
  const bytes = Buffer.alloc(1024 * 1024 + 7, 0x91);
  await sink.write('stdout', bytes);
  await sink.write('stderr', Buffer.from('stderr'));
  await Promise.all([sink.finish('stdout', true), sink.finish('stderr', true)]);
  const envelope = await sink.finalize('success', [{ text: 'preview' }]);
  expect(envelope.capture).toMatchObject({
    captureStatus: 'complete',
    deliveryStatus: 'pending',
  });
  const receipt = await registry.accept(identity, envelope);
  expect(receipt.deliveryStatus).toBe('committed');
  expect(await registry.accept(identity, envelope)).toEqual(receipt);
  expect(
    parseHarnessCheckpointV1((await session!.authority.readCheckpointState())!)
      .continuation.phase,
  ).toBe('await_runtime');
  const delivered = {
    ...envelope,
    capture: { ...envelope.capture!, deliveryStatus: receipt.deliveryStatus },
  };
  expect(await publisher!.receipt('execution-a', delivered)).toEqual(receipt);
  const reader = new ResourceToolResultSegmentStore(resources);
  expect(
    await reader.readRange({
      manifestRef: envelope.capture!.manifest!,
      expectedIdentity: identity,
      streamId: 'stdout',
      offset: bytes.length - 9,
      length: 9,
    }),
  ).toEqual({ status: 'ok', result: Buffer.alloc(9, 0x91) });
  await reader.close();
});

it('serializes overlapping writes and finish for each process pipe', async () => {
  const { registry, request, resources } = await fixture();
  const { sink, identity } = await registry.prepare(request);
  physical(sink);
  const chunks = [Buffer.alloc(64 * 1024, 0x91), Buffer.from('last bytes')];
  await Promise.all([
    sink.write('stdout', chunks[0]),
    sink.write('stdout', chunks[1]),
    sink.finish('stdout', true),
    sink.finish('stderr', true),
  ]);
  const envelope = await sink.finalize('success', [{ text: 'preview' }]);
  expect(envelope.capture?.captureStatus).toBe('complete');
  expect((await registry.accept(identity, envelope)).deliveryStatus).toBe(
    'committed',
  );
  const reader = new ResourceToolResultSegmentStore(resources);
  expect(
    await reader.readRange({
      manifestRef: envelope.capture!.manifest!,
      expectedIdentity: identity,
      streamId: 'stdout',
      offset: 0,
      length: chunks[0].length + chunks[1].length,
    }),
  ).toEqual({ status: 'ok', result: Buffer.concat(chunks) });
  await reader.close();
});

it('ignores a write delivered after its stream has finished', async () => {
  const { registry, request } = await fixture();
  const { sink, identity } = await registry.prepare(request);
  physical(sink);
  await sink.write('stdout', Buffer.from('captured'));
  await sink.finish('stdout', true);
  await sink.write('stdout', Buffer.from('late'));
  await sink.finish('stderr', true);

  const envelope = await sink.finalize('success', [{ text: 'preview' }]);
  expect(envelope.capture?.captureStatus).toBe('complete');
  expect((await registry.accept(identity, envelope)).deliveryStatus).toBe(
    'committed',
  );
});

it('reports an unstarted process result as not_started', async () => {
  const { registry, request } = await fixture();
  const { sink } = await registry.prepare(request);
  sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    exitCode: 1,
    signal: null,
    error: new Error('spawn failed'),
    aborted: false,
    pid: undefined,
    executionMethod: 'child_process',
  });

  const envelope = await sink.finalize('cancelled', [], {
    message: 'spawn failed',
  });
  expect(envelope).toMatchObject({
    executionStatus: 'not_started',
    capture: null,
  });
});

it('irreversibly blocks capture after a lost raw write acknowledgement', async () => {
  const { registry, request } = await fixture();
  const { sink, identity } = await registry.prepare(request);
  physical(sink);
  const fetchActual = globalThis.fetch;
  let writes = 0;
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchActual(input, init);
      if (JSON.parse(String(init?.body)).operation === 'write') {
        writes++;
        await response.arrayBuffer();
        throw new Error('reply lost after owner accepted bytes');
      }
      return response;
    },
  );
  await sink.write('stdout', Buffer.from('already accepted'));
  await sink.write('stdout', Buffer.from('must not upload'));
  await Promise.all([sink.finish('stdout', true), sink.finish('stderr', true)]);
  const envelope = await sink.finalize('success', [{ text: 'preview' }]);
  expect(writes).toBe(1);
  expect(envelope.executionStatus).toBe('success');
  expect(envelope.capture).toMatchObject({
    captureStatus: 'unavailable',
    captureReason: 'storage_failed',
  });
  expect((await registry.accept(identity, envelope)).deliveryStatus).toBe(
    'blocked',
  );
  expect(
    parseHarnessCheckpointV1((await session!.authority.readCheckpointState())!)
      .continuation.phase,
  ).toBe('await_runtime');
});

it('retains the accepted prefix when a producer holds a pipe past the drain boundary', async () => {
  const { registry, request, resources } = await fixture();
  const { sink, identity } = await registry.prepare(request);
  physical(sink);
  const bytes = Buffer.from('accepted before drain');
  await sink.write('stdout', bytes);
  await Promise.all([
    sink.finish('stdout', false),
    sink.finish('stderr', true),
  ]);

  const envelope = await sink.finalize('success', [{ text: 'preview' }]);
  expect(envelope.capture).toMatchObject({
    captureStatus: 'partial',
    captureReason: 'producer_lost',
  });
  expect((await registry.accept(identity, envelope)).deliveryStatus).toBe(
    'blocked',
  );
  const reader = new ResourceToolResultSegmentStore(resources);
  expect(
    await reader.readRange({
      manifestRef: envelope.capture!.manifest!,
      expectedIdentity: identity,
      streamId: 'stdout',
      offset: 0,
      length: bytes.length,
    }),
  ).toEqual({ status: 'ok', result: bytes });
  await reader.close();
});

it('refuses missing registration and immutable descriptor changes', async () => {
  const { registry, request, register, descriptor } = await fixture();
  expect((await register()).status).toBe(200);
  expect(
    (await register({ ...descriptor, token: 'a'.repeat(43) })).status,
  ).toBe(409);
  expect((await register(descriptor, 'another-runtime')).status).toBe(409);
  await expect(
    registry.prepare({
      ...request,
      capture: { ...request.capture, tenantId: 'another-tenant' },
    }),
  ).rejects.toThrow();
  await expect(
    registry.prepare({
      ...request,
      reference: { ...request.reference, sessionId: 'another-runtime' },
    }),
  ).rejects.toThrow(/not registered/);
});

it('refuses an original execution after its activation was replaced', async () => {
  const { registry, request } = await fixture();
  await session!.replaceActivation();
  await expect(registry.prepare(request)).rejects.toThrow();
});

it.each(['argument read', 'writer guard'] as const)(
  'refuses preparation when activation changes during %s',
  async (boundary) => {
    const { registry, request, writable } = await fixture();
    let replaced = false;
    if (boundary === 'argument read') {
      const read = session!.resources.read.bind(session!.resources);
      vi.spyOn(session!.resources, 'read').mockImplementation(async (ref) => {
        const bytes = await read(ref);
        if (ref.kind === 'managed-tool-args') {
          await session!.replaceActivation();
          replaced = true;
        }
        return bytes;
      });
    } else {
      writable.mockImplementationOnce(async () => {
        await session!.replaceActivation();
        replaced = true;
      });
    }
    await expect(registry.prepare(request)).rejects.toThrow();
    expect(replaced).toBe(true);
  },
);

it('refuses a prepare replay after activation replacement', async () => {
  const { registry, request } = await fixture();
  await registry.prepare(request);
  await session!.replaceActivation();
  await expect(registry.prepare(request)).rejects.toThrow();
});

it('checks the durable Runtime binding rather than a caller supplied model ID', async () => {
  const { registry, request } = await fixture('other-worker-call');
  await expect(registry.prepare(request)).rejects.toThrow();
});

it.each(['output verification', 'receipt queue'] as const)(
  'fences activation replacement during %s before committing a receipt',
  async (boundary) => {
    const { registry, request, resources } = await fixture();
    const { sink, identity } = await registry.prepare(request);
    physical(sink);
    await sink.write('stdout', Buffer.alloc(3 * 1024 * 1024, 0x91));
    await Promise.all([
      sink.finish('stdout', true),
      sink.finish('stderr', true),
    ]);
    const envelope = await sink.finalize('success', [{ text: 'preview' }]);
    let replaced = false;
    let replacementSequence = 0;
    const replace = async () => {
      await session!.replaceActivation();
      replaced = true;
      replacementSequence = session!.authority.committedSequence;
    };
    if (boundary === 'output verification') {
      const read = resources.read.bind(resources);
      vi.spyOn(resources, 'read').mockImplementation(async (ref) => {
        const bytes = await read(ref);
        if (!replaced && ref.byteLength === 1024 * 1024) await replace();
        return bytes;
      });
    } else {
      const append = session!.authority.appendExecutionEvent.bind(
        session!.authority,
      );
      vi.spyOn(session!.authority, 'appendExecutionEvent').mockImplementation(
        async (command, event, actor) => {
          if (command.operation === 'recordToolResult') await replace();
          return append(command, event, actor);
        },
      );
    }
    await expect(registry.accept(identity, envelope)).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(session!.authority.committedSequence).toBe(replacementSequence);
    expect(
      session!.authority
        .eventsInSequenceRange(1, session!.authority.committedSequence)
        .filter((event) => event.kind === 'tool.receipt'),
    ).toEqual([]);
    expect(
      parseHarnessCheckpointV1(
        (await session!.authority.readCheckpointState())!,
      ).continuation.phase,
    ).toBe('await_runtime');
  },
);

it.each([
  'http://localhost:1234/internal/hosted-shell-publisher/v1',
  'http://127.0.0.1:65536/internal/hosted-shell-publisher/v1',
  'http://127.0.0.1:1234/internal/hosted-shell-publisher/v1?redirect=x',
  'https://127.0.0.1:1234/internal/hosted-shell-publisher/v1',
])('refuses noncanonical publisher URL %s', (url) =>
  expect(() => parseShellPublisher({ url, token: 'a'.repeat(43) })).toThrow(),
);

it('bounds escaped model preview bytes for inline outcome resources', () => {
  const parts = boundedShellPreview([
    { text: '\u0000'.repeat(100_000) },
    { text: 'ignored' },
  ]);
  expect(Buffer.byteLength(JSON.stringify(parts))).toBeLessThan(50 * 1024);
});

it('keeps both ends of a long preview, where Shell reports failures', () => {
  const [part] = boundedShellPreview(
    Array.from({ length: 10_000 }, (_, index) => ({
      text: index === 9_999 ? '\nExit Code: 3' : 'x',
    })),
  ) as Array<{ text: string }>;
  expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(8 * 1024);
  expect(part.text.startsWith('x'.repeat(2 * 1024))).toBe(true);
  expect(part.text).toContain('preview truncated');
  expect(part.text.endsWith('\nExit Code: 3')).toBe(true);
  expect(boundedShellPreview([{ text: 'x'.repeat(8192) }])).toEqual([
    { text: 'x'.repeat(8192) },
  ]);
});

it('never splits a UTF-8 character at either cut', () => {
  const [part] = boundedShellPreview([{ text: '中'.repeat(5_000) }]) as Array<{
    text: string;
  }>;
  expect(part.text).not.toContain('\uFFFD');
  expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(8 * 1024);
});

it('uses the joined UTF-8 preview to decide whether capture text was truncated', async () => {
  const { registry, request } = await fixture();
  const { sink } = await registry.prepare(request);
  physical(sink);
  await Promise.all([sink.finish('stdout', true), sink.finish('stderr', true)]);
  const parts = [{ text: `${'x'.repeat(8188)}\ud83d` }, { text: '\ude00' }];
  const envelope = await sink.finalize('success', parts);
  expect(envelope.capture).toMatchObject({
    captureStatus: 'complete',
    previewTruncated: false,
  });
  expect(envelope.responseParts).toEqual([{ text: `${'x'.repeat(8188)}😀` }]);
});

it('requires the publisher capability and stops listening once closed', async () => {
  const { descriptor } = await fixture();
  const post = (authorization?: string) =>
    fetch(descriptor.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({
        operation: 'finish',
        executionCallId: 'execution-a',
        stream: 'stdout',
        complete: false,
      }),
    });
  expect((await post()).status).toBe(401);
  expect((await post(`Bearer ${'A'.repeat(43)}`)).status).toBe(401);
  await publisher!.close();
  await expect(post(`Bearer ${descriptor.token}`)).rejects.toThrow();
});
