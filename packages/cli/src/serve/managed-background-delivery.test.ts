/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  MANAGED_TOOL_RESULT_PROTOCOL,
  parseToolResultManifestBytes,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import {
  MANAGED_SHELL_PUBLISHER_ROUTE,
  ManagedShellPublisherRegistry,
} from './managed-shell-publisher.js';

let root: string | undefined;
let session: ManagedSession | undefined;
let publisher: HostedShellPublisher | undefined;
let server: Server | undefined;
let worker: Server | undefined;

afterEach(async () => {
  await publisher?.close();
  for (const s of [server, worker]) {
    if (s?.listening) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }
  await session?.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  session = undefined;
  publisher = undefined;
  server = undefined;
  worker = undefined;
});

function resourceStore(
  baseDir: string,
  sessionId: string,
  reader: { read: (ref: ManagedSessionDurableRef) => Promise<Buffer> },
): DurableToolResultResourceStore {
  // Land bytes in the same session resource root a production write leaves,
  // honoring the id-pinned publish the segment store requires, so the
  // authority's resource verification reads the exact layout.
  return {
    async publish(kind, bytes, resourceId = randomUUID()) {
      const directory = path.join(baseDir, 'resources', sessionId, kind);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, resourceId), bytes);
      return {
        resourceId,
        kind,
        schemaVersion: 1,
        byteLength: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    read: (ref) => reader.read(ref),
  };
}

async function rig() {
  root = await mkdtemp(path.join(tmpdir(), 'qwen-worker-delivery-'));
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
  const harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  const resources = resourceStore(root, key.sessionId, session.resources);
  const orchestrator = new HostedChildRunSession(
    { authority: session.authority, resources },
    key,
  );
  publisher = new HostedShellPublisher(
    session,
    resources,
    async () => {},
    orchestrator,
  );
  const descriptor = await publisher.start();
  publisher.register(
    {
      reference: {
        sessionId: key.sessionId,
        promptId: 'prompt-a',
        callId: 'worker-call-a',
        argsDigest: `sha256:${'a'.repeat(64)}`,
      },
      capture: {
        tenantId: key.tenantId,
        sessionId: key.sessionId,
        turnId: 'turn-a',
        executionCallId: 'execution-bg',
        bindingGeneration: '1',
        capturePolicy: 'complete_required',
        background: true,
      },
    } as Parameters<HostedShellPublisher['register']>[0],
    'model-call-a',
    'prompt-a',
  );

  const registry = new ManagedShellPublisherRegistry({
    enabled: true,
    workspaceId: key.workspaceId,
  });
  const app = express();
  registry.register(
    app,
    { token: 'runtime-token', leaseId: 'lease-a', epoch: 1 },
    (id) => id === key.sessionId,
  );
  worker = createServer(app);
  await new Promise<void>((resolve) => worker!.listen(0, '127.0.0.1', resolve));
  const install = async (writerGeneration: number) =>
    fetch(
      `http://127.0.0.1:${(worker!.address() as { port: number }).port}${MANAGED_SHELL_PUBLISHER_ROUTE.path}`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer runtime-token',
          'cache-control': 'no-store',
          'content-type': 'application/json',
          'x-qwen-managed-lease-id': 'lease-a',
          'x-qwen-managed-lease-epoch': '1',
        },
        body: JSON.stringify({
          protocolVersion: 3,
          toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
          sessionId: key.sessionId,
          publisher: descriptor,
          writerGeneration,
        }),
      },
    );
  expect((await install(1)).status).toBe(200);

  const executionCallId = 'execution-bg';
  await orchestrator.admit({
    shellId: executionCallId,
    ownerScopeId: key.sessionId,
    executionCallId,
    args: { command: 'echo hi', is_background: true },
  });
  await orchestrator.dispatchStarted(executionCallId, {
    runtimeBindingId: 'binding-a',
    generation: '1',
  });
  await orchestrator.attach(
    executionCallId,
    { runtimeBindingId: 'binding-a', generation: '1' },
    { pid: 7 },
  );

  const request = {
    reference: {
      sessionId: key.sessionId,
      promptId: 'prompt-a',
      callId: 'worker-call-a',
      argsDigest: `sha256:${'a'.repeat(64)}`,
    },
    capture: {
      tenantId: key.tenantId,
      sessionId: key.sessionId,
      turnId: 'turn-a',
      executionCallId,
      bindingGeneration: '1',
      capturePolicy: 'complete_required' as const,
      background: true,
    },
  };
  return {
    key,
    orchestrator,
    registry,
    resources,
    request,
    install,
    executionCallId,
  };
}

it('worker-owned capture delivers output and terminal entries that settle the record', async () => {
  const r = await rig();
  const prepared = await r.registry.prepare(
    r.request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(7);
  await prepared.sink.write('stdout', Buffer.from('hello\n'));
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  prepared.sink.setProcessResult({
    exitCode: 0,
    signal: null,
    rawOutput: Buffer.from('hello\n'),
    output: 'hello\n',
    error: null,
    aborted: false,
    pid: 7,
    executionMethod: 'child_process',
  });
  const envelope = await prepared.sink.finalize('success', [
    { text: 'hello\n' },
  ]);
  const receipt = await r.registry.accept(prepared.identity, envelope);
  expect(receipt.deliveryStatus).toBe('blocked');

  // The applier published the manifest into the shared store and settled.
  const record = r.orchestrator.record(r.executionCallId)!;
  expect(record.run.state).toBe('settled');
  expect(record.exitCode).toBe(0);
  expect(record.outputRef).not.toBeNull();
  const manifest = parseToolResultManifestBytes(
    await r.resources.read(record.outputRef!),
  );
  expect(manifest.executionStatus).toBe('success');
  expect(manifest.captureId).toBe(prepared.identity.captureId);
  // The stdout content is reconstructable from the delivered manifest.
  const stdout = manifest.contents.find((c) => c.streamId === 'stdout')!;
  expect(stdout.byteLength).toBe(Buffer.byteLength('hello\n'));
});

it('re-delivering an applied batch is idempotent', async () => {
  const r = await rig();
  const prepared = await r.registry.prepare(
    r.request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(7);
  await prepared.sink.write('stdout', Buffer.from('data\n'));
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  prepared.sink.setProcessResult({
    exitCode: 0,
    signal: null,
    rawOutput: Buffer.from('data\n'),
    output: 'data\n',
    error: null,
    aborted: false,
    pid: 7,
    executionMethod: 'child_process',
  });
  const envelope = await prepared.sink.finalize('success', []);
  await r.registry.accept(prepared.identity, envelope);
  const settled = r.orchestrator.record(r.executionCallId)!;
  expect(settled.run.state).toBe('settled');
  // A second prepare of the same execution returns the same sink; re-finalize
  // is a no-op and the record stays settled at the same revision.
  const again = await r.registry.prepare(
    r.request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  const envelope2 = await again.sink.finalize('success', []);
  await r.registry.accept(again.identity, envelope2);
  const after = r.orchestrator.record(r.executionCallId)!;
  expect(after.run.state).toBe('settled');
  expect(after.outputRef).toEqual(settled.outputRef);
});

it('refuses a publisher registration from an older writer generation', async () => {
  const r = await rig();
  expect((await r.install(5)).status).toBe(200);
  const refused = await r.install(3);
  expect(refused.status).toBe(409);
  expect((await r.install(5)).status).toBe(200);
});
