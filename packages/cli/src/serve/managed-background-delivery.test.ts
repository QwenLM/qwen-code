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
import { afterEach, expect, it, vi } from 'vitest';
import { MANAGED_DELIVERY_REQUEST_LIMIT_BYTES } from '@qwen-code/qwen-code-core/managed-runtime/managed-delivery-entry.js';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  MANAGED_TOOL_RESULT_PROTOCOL,
  parseToolResultManifestBytes,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  HOSTED_TOOL_RESULT_RESOURCE_LIMITS,
  type DurableToolResultResourceStore,
} from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { reattachAndDrainBackgroundDeliveries } from './hosted-background-delivery-recovery.js';
import {
  MANAGED_OBSERVATION_PULL_ROUTE,
  MANAGED_SHELL_PUBLISHER_DETACH_ROUTE,
  MANAGED_SHELL_PUBLISHER_ROUTE,
  ManagedShellPublisherRegistry,
} from './managed-shell-publisher.js';
import {
  BackgroundDeliveryRun,
  WorkerBackgroundCaptureSink,
  WorkerMonitorPolicy,
} from './managed-background-delivery.js';

let root: string | undefined;
let session: ManagedSession | undefined;
let publisher: HostedShellPublisher | undefined;
let server: Server | undefined;
let worker: Server | undefined;
const publishers: Server[] = [];

afterEach(async () => {
  await publisher?.close();
  for (const s of [server, worker, ...publishers.splice(0)]) {
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

async function rig(options: { install?: boolean; kindGated?: boolean } = {}) {
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
  // Mirror the production tool-result gate: only the capture kinds publish
  // there, so an observation's notification kinds must take the session lane.
  const toolResults: DurableToolResultResourceStore = options.kindGated
    ? {
        publish: (kind, bytes, resourceId) => {
          if (!Object.hasOwn(HOSTED_TOOL_RESULT_RESOURCE_LIMITS, kind)) {
            throw new Error('Unsupported tool result resource or size.');
          }
          return resources.publish(kind, bytes, resourceId);
        },
        read: (ref) => resources.read(ref),
      }
    : resources;
  const orchestrator = new HostedChildRunSession(
    { authority: session.authority, resources },
    key,
  );
  const monitors = new HostedMonitorSession(
    { authority: session.authority, resources },
    key,
  );
  publisher = new HostedShellPublisher(
    session,
    toolResults,
    async () => {},
    orchestrator,
    monitors,
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
  if (options.install !== false) {
    expect((await install(1)).status).toBe(200);
  }

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
    monitors,
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
  // Until the run retires, a second prepare of the same execution returns
  // the same sink and a re-finalize enqueues nothing new.
  const again = await r.registry.prepare(
    r.request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  expect(again.sink).toBe(prepared.sink);
  expect(await again.sink.finalize('success', [])).toEqual(envelope);
  await r.registry.accept(prepared.identity, envelope);
  const settled = r.orchestrator.record(r.executionCallId)!;
  expect(settled.run.state).toBe('settled');
  expect(settled.exitCode).toBe(0);
});

it('retires a finished run so a later registration no longer reports it', async () => {
  const r = await rig();
  const observed = async (writerGeneration: number) =>
    (
      (await (await r.install(writerGeneration)).json()) as {
        observedRuns: Record<string, number>;
      }
    ).observedRuns;
  const prepared = await r.registry.prepare(
    r.request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(7);
  await prepared.sink.write('stdout', Buffer.from('done\n'));
  expect(Object.keys(await observed(2))).toEqual([r.executionCallId]);
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  prepared.sink.setProcessResult({
    exitCode: 0,
    signal: null,
    rawOutput: Buffer.from('done\n'),
    output: 'done\n',
    error: null,
    aborted: false,
    pid: 7,
    executionMethod: 'child_process',
  });
  const envelope = await prepared.sink.finalize('success', []);
  await r.registry.accept(prepared.identity, envelope);
  expect(r.orchestrator.record(r.executionCallId)!.run.state).toBe('settled');
  expect(await observed(3)).toEqual({});
});

it('refuses a publisher registration from an older writer generation', async () => {
  const r = await rig();
  expect((await r.install(5)).status).toBe(200);
  const refused = await r.install(3);
  expect(refused.status).toBe(409);
  expect((await r.install(5)).status).toBe(200);
});

it('refuses a stale writer after a detach because the watermark survives', async () => {
  const r = await rig();
  expect((await r.install(5)).status).toBe(200);
  expect(r.registry.detachSession(r.key.sessionId, 5)).toBe(true);
  expect((await r.install(3)).status).toBe(409);
  expect((await r.install(5)).status).toBe(200);
});

it('worker monitor policy delivers an observation entry the applier commits once', async () => {
  const r = await rig();
  const monitorId = 'execution-mon';
  await r.monitors.admit({
    monitorId,
    ownerScopeId: r.key.sessionId,
    executionCallId: monitorId,
    args: { command: 'tail -f log', description: 'watch log' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
  });
  await r.monitors.dispatchStarted(monitorId, {
    runtimeBindingId: 'binding-a',
    generation: '1',
  });
  await r.monitors.attach(
    monitorId,
    { runtimeBindingId: 'binding-a', generation: '1' },
    { pid: 9 },
  );
  publisher!.register(
    {
      reference: {
        sessionId: r.key.sessionId,
        promptId: 'prompt-a',
        callId: 'worker-call-mon',
        argsDigest: `sha256:${'b'.repeat(64)}`,
      },
      capture: {
        tenantId: r.key.tenantId,
        sessionId: r.key.sessionId,
        turnId: 'turn-a',
        executionCallId: monitorId,
        bindingGeneration: '1',
        capturePolicy: 'complete_required',
        background: true,
        monitoring: true,
      },
    } as Parameters<HostedShellPublisher['register']>[0],
    'model-call-mon',
    'prompt-a',
  );
  const prepared = await r.registry.prepare({
    reference: {
      sessionId: r.key.sessionId,
      promptId: 'prompt-a',
      callId: 'worker-call-mon',
      argsDigest: `sha256:${'b'.repeat(64)}`,
    },
    capture: {
      tenantId: r.key.tenantId,
      sessionId: r.key.sessionId,
      turnId: 'turn-a',
      executionCallId: monitorId,
      bindingGeneration: '1',
      capturePolicy: 'complete_required',
      background: true,
      monitoring: true,
    },
  } as Parameters<ManagedShellPublisherRegistry['prepare']>[0]);
  const sink = prepared.sink as WorkerBackgroundCaptureSink;
  sink.attachMonitorPolicy(
    new WorkerMonitorPolicy(
      sink.run,
      {
        monitorId,
        executionCallId: monitorId,
        description: 'watch log',
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
        startSequence: 0,
      },
      async () => true,
    ),
  );
  sink.setStarted(9);
  await sink.write('stdout', Buffer.from('line1\nline2\n'));
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  sink.setProcessResult({
    exitCode: 0,
    signal: null,
    rawOutput: Buffer.from('line1\nline2\n'),
    output: 'line1\nline2\n',
    error: null,
    aborted: false,
    pid: 9,
    executionMethod: 'child_process',
  });
  const envelope = await sink.finalize('success', []);
  await r.registry.accept(prepared.identity, envelope);
  const record = r.monitors.record(monitorId)!;
  expect(record.observationSequence).toBe(1);
  expect(record.notifiedThrough).toBe(1);
  expect(record.run.state).toBe('settled');
  expect(record.stopReason).toBe('exited');
});

it('applies a live observation through the production kind gate, keeping the worker resource ids', async () => {
  const r = await rig({ kindGated: true });
  const monitorId = 'execution-mon-gated';
  const binding = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.monitors.admit({
    monitorId,
    ownerScopeId: r.key.sessionId,
    executionCallId: monitorId,
    args: { command: 'tail -f log', description: 'watch log' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
  });
  await r.monitors.dispatchStarted(monitorId, binding);
  await r.monitors.attach(monitorId, binding, { pid: 9 });
  const request = {
    reference: {
      sessionId: r.key.sessionId,
      promptId: 'prompt-a',
      callId: 'worker-call-mon',
      argsDigest: `sha256:${'b'.repeat(64)}`,
    },
    capture: {
      tenantId: r.key.tenantId,
      sessionId: r.key.sessionId,
      turnId: 'turn-a',
      executionCallId: monitorId,
      bindingGeneration: '1',
      capturePolicy: 'complete_required',
      background: true,
      monitoring: true,
    },
  };
  publisher!.register(
    request as Parameters<HostedShellPublisher['register']>[0],
    'model-call-mon',
    'prompt-a',
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  const sink = prepared.sink as WorkerBackgroundCaptureSink;
  const sessionPublish = vi.spyOn(session!.resources, 'publish');
  sink.attachMonitorPolicy(
    new WorkerMonitorPolicy(
      sink.run,
      {
        monitorId,
        executionCallId: monitorId,
        description: 'watch log',
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
        startSequence: 0,
      },
      async () => true,
    ),
  );
  sink.setStarted(9);
  await sink.write('stdout', Buffer.from('line1\nline2\n'));
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  sink.setProcessResult({
    exitCode: 0,
    signal: null,
    rawOutput: Buffer.from('line1\nline2\n'),
    output: 'line1\nline2\n',
    error: null,
    aborted: false,
    pid: 9,
    executionMethod: 'child_process',
  });
  const envelope = await sink.finalize('success', []);
  await r.registry.accept(prepared.identity, envelope);
  const record = r.monitors.record(monitorId)!;
  expect(record.observationSequence).toBe(1);
  expect(record.notifiedThrough).toBe(1);
  expect(record.run.state).toBe('settled');
  // The notification kinds must reach the session store under the worker's
  // explicit ids: the commit's resource closure verifies exactly those refs.
  for (const kind of ['managed-input', 'managed-admission']) {
    const index = sessionPublish.mock.calls.findIndex(
      ([published]) => published === kind,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const [, bytes, resourceId] = sessionPublish.mock.calls[index];
    expect(resourceId).toBeDefined();
    const ref = await sessionPublish.mock.results[index].value;
    expect(ref.resourceId).toBe(resourceId);
    expect(await session!.resources.read(ref)).toEqual(bytes);
  }
});

it('keeps the capture in held mode while the publisher is unavailable and resumes on registration', async () => {
  // No publisher installed yet: the worker owns the capture and must not lose
  // it (the legacy RemoteShellCapture would failCapture on a lost publisher).
  const r = await rig({ install: false });
  const prepared = await r.registry.prepare(
    r.request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  const sink = prepared.sink as WorkerBackgroundCaptureSink;
  sink.setStarted(7);
  await sink.write('stdout', Buffer.from('part1\n'));
  // Finishing the stream flushes a manifest revision while no publisher is
  // attached: the entry is retained in held mode, the capture is not lost.
  await sink.finish('stdout', true);
  expect(sink.run.deliveryMode).toBe('held');
  expect(sink.run.pendingCount).toBeGreaterThan(0);
  expect(sink.isLostCaptureResult({} as never)).toBe(false);

  // A publisher registers (the Harness comes back): delivery resumes from the
  // oldest unacknowledged entry, the same capture continues.
  expect((await r.install(1)).status).toBe(200);
  await sink.write('stderr', Buffer.from('part2\n'));
  await sink.finish('stderr', true);
  sink.setProcessResult({
    exitCode: 0,
    signal: null,
    rawOutput: Buffer.from('part1\n'),
    output: 'part1\n',
    error: null,
    aborted: false,
    pid: 7,
    executionMethod: 'child_process',
  });
  const envelope = await sink.finalize('success', []);
  const receipt = await r.registry.accept(prepared.identity, envelope);
  expect(receipt.deliveryStatus).toBe('blocked');

  const record = r.orchestrator.record(r.executionCallId)!;
  expect(record.run.state).toBe('settled');
  expect(record.exitCode).toBe(0);
  const manifest = parseToolResultManifestBytes(
    await r.resources.read(record.outputRef!),
  );
  const stdout = manifest.contents.find((c) => c.streamId === 'stdout')!;
  const stderr = manifest.contents.find((c) => c.streamId === 'stderr')!;
  expect(stdout.byteLength).toBe(Buffer.byteLength('part1\n'));
  expect(stdout.digest).toBe(
    createHash('sha256').update(Buffer.from('part1\n')).digest('hex'),
  );
  expect(stderr.digest).toBe(
    createHash('sha256').update(Buffer.from('part2\n')).digest('hex'),
  );
  expect(manifest.captureId).toBe(prepared.identity.captureId);
});

it('long-polls observation-pull while held, supersedes older waiters, returns attached when attached, and trims on ackThrough', async () => {
  const r = await rig({ install: true });
  const prepared = await r.registry.prepare(
    r.request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  const sink = prepared.sink as WorkerBackgroundCaptureSink;
  sink.setStarted(11);

  const workerBase = `http://127.0.0.1:${(worker!.address() as { port: number }).port}`;
  const headers = {
    authorization: 'Bearer runtime-token',
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'x-qwen-managed-lease-id': 'lease-a',
    'x-qwen-managed-lease-epoch': '1',
  };
  const pull = async (
    afterSeq: number,
    ackThrough = 0,
    waitMs = 0,
  ): Promise<Record<string, unknown>> => {
    const res = await fetch(workerBase + MANAGED_OBSERVATION_PULL_ROUTE.path, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 3,
        toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
        executionCallId: r.executionCallId,
        afterSeq,
        ackThrough,
        waitMs,
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  // Attached run returns immediately with status = attached and no entries.
  const whileAttached = await pull(0, 0, 5_000);
  expect(whileAttached['status']).toBe('attached');
  expect(whileAttached['entries']).toEqual([]);

  // Older generation detach is refused; matching generation switches to held.
  expect((await r.install(2)).status).toBe(200);
  const staleDetach = await fetch(
    workerBase + MANAGED_SHELL_PUBLISHER_DETACH_ROUTE.path,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 3,
        toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
        sessionId: r.key.sessionId,
        writerGeneration: 1,
      }),
    },
  );
  expect(staleDetach.status).toBe(409);

  const validDetach = await fetch(
    workerBase + MANAGED_SHELL_PUBLISHER_DETACH_ROUTE.path,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 3,
        toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
        sessionId: r.key.sessionId,
        writerGeneration: 2,
      }),
    },
  );
  expect(validDetach.status).toBe(200);
  expect(sink.run.deliveryMode).toBe('held');

  // First long-poll waits; a second long-poll immediately supersedes the first.
  const olderPull = pull(0, 0, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const newerPull = pull(0, 0, 5_000);
  expect((await olderPull)['status']).toBe('superseded');

  // Writing output while held wakes the active long poll without waiting 5s.
  await sink.write('stdout', Buffer.from('staged-line\n'));
  await sink.finish('stdout', true);
  const batch = await newerPull;
  expect(batch['status']).toBe('held');
  const entries = batch['entries'] as Array<{ deliverySeq: number }>;
  expect(entries.length).toBe(1);
  expect(entries[0]!.deliverySeq).toBe(1);
  expect(sink.run.pendingCount).toBe(1);

  // Next pull carries ackThrough = 1, trimming the outbox on the worker.
  const acked = await pull(1, 1, 0);
  expect(acked['ackedThrough']).toBe(1);
  expect(sink.run.pendingCount).toBe(0);
});

it('re-attaches before draining staged deliveries without gaps or duplicate commits across suspension', async () => {
  const r = await rig({ install: true });
  const runtimeSessionId = 'rt-session-1';
  const routeRef = await session!.resources.publish(
    'managed-tool-input',
    Buffer.from(
      JSON.stringify({
        harnessSessionId: r.key.sessionId,
        runtimeSessionId,
      }),
      'utf8',
    ),
  );
  const defRef = await session!.resources.publish(
    'managed-tool-definition',
    Buffer.from(JSON.stringify({ name: 'shell' }), 'utf8'),
  );
  const activation = session!.activation;
  await session!.authority.appendExecutionEvent(
    {
      operation: 'toolIntent',
      commandId: 'intent:' + r.executionCallId,
      sessionKey: r.key,
      contentDigest: routeRef.digest,
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: 'intent:' + r.executionCallId,
      sessionKey: r.key,
      kind: 'tool.intent',
      occurredAt: Date.now(),
      subject: {
        type: 'activation',
        scopeId: activation.activationId,
        ...activation,
      },
      payload: {
        executionCallId: r.executionCallId,
        batchId: 'batch:' + r.executionCallId,
        ordinal: 0,
        toolDefinitionRef: defRef,
        argsRef: routeRef,
        outcomeSource: 'runtime',
      },
    }),
    { class: 'harness', activation },
  );

  const prepared = await r.registry.prepare(
    r.request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  const sink = prepared.sink as WorkerBackgroundCaptureSink;
  sink.setStarted(21);

  // Entry 1 lands directly on the first Harness publisher (generation 1).
  await sink.write('stdout', Buffer.from('direct-1\n'));
  await sink.finish('stdout', true);
  // The direct push is an HTTP round trip plus a journal commit: wait for
  // its watermark instead of a fixed sleep a loaded runner can outrun.
  for (let waited = 0; waited < 5_000 && sink.run.lastApplied < 1; waited += 10)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(sink.run.lastApplied).toBe(1);

  // Suspend: detach generation 1 and close the first Harness publisher.
  const workerBase = `http://127.0.0.1:${(worker!.address() as { port: number }).port}`;
  const workerHeaders = {
    authorization: 'Bearer runtime-token',
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'x-qwen-managed-lease-id': 'lease-a',
    'x-qwen-managed-lease-epoch': '1',
  };
  await fetch(workerBase + MANAGED_SHELL_PUBLISHER_DETACH_ROUTE.path, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({
      protocolVersion: 3,
      toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
      sessionId: r.key.sessionId,
      writerGeneration: 1,
    }),
  });
  await publisher!.close();
  publisher = undefined;

  // While suspended, worker produces stderr output (entry 2), which the Broker
  // pulls, stores resources into the Session resource store, and stages without
  // inline bytesBase64.
  await sink.write('stderr', Buffer.from('staged-2\n'));
  await sink.finish('stderr', true);
  const pullRes = await fetch(
    workerBase + MANAGED_OBSERVATION_PULL_ROUTE.path,
    {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({
        protocolVersion: 3,
        toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
        executionCallId: r.executionCallId,
        afterSeq: 0,
        ackThrough: 0,
        waitMs: 0,
      }),
    },
  );
  const pulled = (await pullRes.json()) as {
    entries: Array<
      Record<string, unknown> & {
        deliverySeq: number;
        resources: Array<{
          ref: ManagedSessionDurableRef;
          bytesBase64: string;
        }>;
      }
    >;
  };
  expect(pulled.entries.map((e) => e.deliverySeq)).toEqual([2]);
  const stagedRows: Array<Record<string, unknown>> = [];
  for (const entry of pulled.entries) {
    for (const resItem of entry.resources) {
      await r.resources.publish(
        resItem.ref.kind,
        Buffer.from(resItem.bytesBase64, 'base64'),
        resItem.ref.resourceId,
      );
    }
    stagedRows.push({ ...entry, resources: [] });
  }
  // Acknowledge stagedThrough = 2 to the worker.
  await fetch(workerBase + MANAGED_OBSERVATION_PULL_ROUTE.path, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({
      protocolVersion: 3,
      toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
      executionCallId: r.executionCallId,
      afterSeq: 2,
      ackThrough: 2,
      waitMs: 0,
    }),
  });

  // Also enqueue terminal (entry 3) in the worker's outbox BEFORE re-attach:
  // the moment registerPublisher(gen 2) lands, the worker immediately pushes
  // entry 3 while the Harness is still draining entry 2!
  sink.setProcessResult({
    exitCode: 0,
    signal: null,
    rawOutput: Buffer.from('direct-1\n'),
    output: 'direct-1\n',
    error: null,
    aborted: false,
    pid: 21,
    executionMethod: 'child_process',
  });
  const envelopePromise = sink.finalize('success', []);

  // Mock Broker HTTP server forwarding publisher re-attach to worker and
  // serving staged-deliveries:list + staged-deliveries:acknowledge.
  const ackedCalls: Array<{ executionCallId: string; throughSeq: number }> = [];
  const brokerApp = express();
  brokerApp.use(express.json());
  brokerApp.post(
    `/internal/runtime-broker/v1/tool-sessions/${runtimeSessionId}:publisher`,
    async (req, res) => {
      const forward = await fetch(
        workerBase + MANAGED_SHELL_PUBLISHER_ROUTE.path,
        {
          method: 'POST',
          headers: workerHeaders,
          body: JSON.stringify({
            protocolVersion: 3,
            toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
            sessionId: r.key.sessionId,
            publisher: req.body.publisher,
            writerGeneration: req.body.writerGeneration,
          }),
        },
      );
      const data = (await forward.json()) as Record<string, unknown>;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        protocolVersion: 1,
        harnessSessionId: r.key.sessionId,
        runtimeSessionId,
        installed: true,
        bindingGeneration: '1',
        observation: data['observation'],
        observedRuns: data['observedRuns'],
      });
    },
  );
  brokerApp.post(
    `/internal/runtime-broker/v1/harness-sessions/${r.key.sessionId}/staged-deliveries/list`,
    async (_req, res) => {
      // Delay list slightly so the worker's live push of entry 3 arrives at
      // the new publisher BEFORE staged entry 2 finishes draining.
      await new Promise((resolve) => setTimeout(resolve, 30));
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        protocolVersion: 1,
        harnessSessionId: r.key.sessionId,
        entries: stagedRows,
      });
    },
  );
  brokerApp.post(
    `/internal/runtime-broker/v1/harness-sessions/${r.key.sessionId}/staged-deliveries/acknowledge`,
    (req, res) => {
      ackedCalls.push({
        executionCallId: req.body.executionCallId,
        throughSeq: req.body.throughSeq,
      });
      stagedRows.splice(
        0,
        stagedRows.length,
        ...stagedRows.filter(
          (row) => (row['deliverySeq'] as number) > req.body.throughSeq,
        ),
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        protocolVersion: 1,
        harnessSessionId: r.key.sessionId,
        acknowledged: true,
      });
    },
  );
  server = createServer(brokerApp);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const brokerPort = (server.address() as { port: number }).port;

  // A second unsettled run whose binding's worker never prepared it: the
  // reload must not certify its binding as worker-owned.
  await r.orchestrator.admit({
    shellId: 'execution-other',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'execution-other',
    args: { command: 'sleep 60', is_background: true },
  });
  await r.orchestrator.dispatchStarted('execution-other', {
    runtimeBindingId: 'binding-b',
    generation: '4',
  });

  const lane: {
    publisher?: HostedShellPublisher;
    readonly resources: DurableToolResultResourceStore;
    readonly assertWritable: () => Promise<void>;
    observationBindings?: Set<string>;
  } = {
    resources: r.resources,
    assertWritable: async () => {},
  };

  await reattachAndDrainBackgroundDeliveries({
    managed: session!,
    lane,
    writerOwner: {
      owner: async () => ({ writerId: 'writer-2', writerGeneration: 2 }),
    },
    brokerOptions: {
      baseUrl: `http://127.0.0.1:${brokerPort}`,
      token: 'broker-token',
    },
    childRuns: r.orchestrator,
    monitors: r.monitors,
  });
  publisher = lane.publisher;
  // The reload re-derives the observation ownership that dispatch records,
  // so the Session can suspend again with the run still live.
  expect(lane.observationBindings).toEqual(new Set(['binding-a@1']));

  const envelope = await envelopePromise;
  const receipt = await r.registry.accept(prepared.identity, envelope);
  expect(receipt.deliveryStatus).toBe('blocked');
  expect(ackedCalls).toEqual([
    { executionCallId: r.executionCallId, throughSeq: 2 },
  ]);
  expect(stagedRows).toEqual([]);

  const record = r.orchestrator.record(r.executionCallId)!;
  expect(record.run.state).toBe('settled');
  expect(record.exitCode).toBe(0);
  const manifest = parseToolResultManifestBytes(
    await r.resources.read(record.outputRef!),
  );
  const stdout = manifest.contents.find((c) => c.streamId === 'stdout')!;
  const stderr = manifest.contents.find((c) => c.streamId === 'stderr')!;
  expect(stdout.byteLength).toBe(Buffer.byteLength('direct-1\n'));
  expect(stderr.byteLength).toBe(Buffer.byteLength('staged-2\n'));
});

function workerIdentity(executionCallId: string) {
  return {
    tenantId: 'tenant-a',
    sessionId: randomUUID(),
    turnId: 'turn-a',
    executionCallId,
    callId: 'worker-call-a',
    invocationDigest: `sha256:${'a'.repeat(64)}`,
    bindingGeneration: '1',
    captureId: randomUUID(),
    revision: 1,
  };
}

/** A Harness delivery endpoint that answers each push with `status`. */
async function deliveryEndpoint(
  status: (seqs: number[]) => number | Promise<number>,
) {
  const applied: number[][] = [];
  const sizes: number[] = [];
  const endpoint = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      sizes.push(raw.byteLength);
      const seqs = (
        JSON.parse(raw.toString('utf8')) as {
          entries: Array<{ deliverySeq: number }>;
        }
      ).entries.map((entry) => entry.deliverySeq);
      void Promise.resolve(status(seqs)).then((code) => {
        if (code === 200) applied.push(seqs);
        res.writeHead(code, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({ appliedThrough: seqs.at(-1) }));
      });
    });
  });
  await new Promise<void>((resolve) =>
    endpoint.listen(0, '127.0.0.1', resolve),
  );
  publishers.push(endpoint);
  const port = (endpoint.address() as { port: number }).port;
  return {
    descriptor: { url: `http://127.0.0.1:${port}/`, token: 'harness-token' },
    applied,
    sizes,
  };
}

function exited(sink: WorkerBackgroundCaptureSink): void {
  sink.setProcessResult({
    exitCode: 0,
    signal: null,
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    pid: 7,
    executionMethod: 'child_process',
  });
}

function monitorPolicy(
  run: BackgroundDeliveryRun,
  maxEvents: number,
  terminate: () => Promise<boolean>,
): WorkerMonitorPolicy {
  return new WorkerMonitorPolicy(
    run,
    {
      monitorId: run.executionCallId,
      executionCallId: run.executionCallId,
      description: 'watch',
      maxEvents,
      idleTimeoutMs: 60_000,
      debounceMs: 1_000,
      startSequence: 0,
    },
    terminate,
  );
}

it('sizes a push batch by its serialized request, wrapper and separators included', async () => {
  const harness = await deliveryEndpoint(() => 200);
  const run = new BackgroundDeliveryRun('execution-batch', '1', 'monitor_run');
  for (let sequence = 1; sequence <= 2_500; sequence++) {
    await run.enqueueObservation(sequence, ['x'.repeat(150)], null, []);
  }
  run.attach(harness.descriptor, 1);
  await vi.waitFor(() => expect(run.pendingCount).toBe(0), {
    timeout: 10_000,
  });
  expect(Math.max(...harness.sizes)).toBeLessThanOrEqual(
    MANAGED_DELIVERY_REQUEST_LIMIT_BYTES,
  );
  expect(harness.applied.flat()).toEqual(
    Array.from({ length: 2_500 }, (_, index) => index + 1),
  );
});

it('hands an in-flight push to a newer attach and keeps what the Broker staged meanwhile', async () => {
  let failOld: ((code: number) => void) | undefined;
  const old = await deliveryEndpoint(
    () => new Promise<number>((resolve) => (failOld = resolve)),
  );
  const fresh = await deliveryEndpoint(() => 200);
  const run = new BackgroundDeliveryRun(
    'execution-handover',
    '1',
    'monitor_run',
  );
  run.attach(old.descriptor, 1);
  await run.enqueueObservation(1, ['first'], null, []);
  await vi.waitFor(() => expect(failOld).toBeDefined());
  // A staging acknowledgement while a Harness holds the publisher must not
  // trim an entry that Harness never applied.
  const pulled = await run.pullForStage({ afterSeq: 1, ackThrough: 1 });
  expect(pulled.status).toBe('attached');
  expect(run.pendingCount).toBe(1);
  expect(run.attach(fresh.descriptor, 2)).toBe(true);
  failOld!(500);
  await vi.waitFor(() => expect(run.pendingCount).toBe(0));
  expect(run.deliveryMode).toBe('attached');
  expect(fresh.applied.flat()).toEqual([1]);
});

it('retries a failed push while held and never trims what that Harness still owes', async () => {
  let refuse = true;
  const harness = await deliveryEndpoint(() => (refuse ? 500 : 200));
  const run = new BackgroundDeliveryRun('execution-retry', '1', 'monitor_run');
  run.attach(harness.descriptor, 1);
  await run.enqueueObservation(1, ['early'], null, []);
  await vi.waitFor(() => expect(run.deliveryMode).toBe('held'));
  const staged = await run.pullForStage({ afterSeq: 0 });
  expect(staged.entries.map((entry) => entry.deliverySeq)).toEqual([1]);
  await run.pullForStage({ afterSeq: 1, ackThrough: 1 });
  expect(run.pendingCount).toBe(1);
  refuse = false;
  await vi.waitFor(() => expect(run.pendingCount).toBe(0), {
    timeout: 5_000,
  });
  expect(run.deliveryMode).toBe('attached');
  expect(harness.applied.flat()).toEqual([1]);
  run.close();
});

it('keeps a background stream healthy across more idle partial flushes than the page bound', async () => {
  const run = new BackgroundDeliveryRun('execution-ticks', '1', 'child_run');
  const sink = new WorkerBackgroundCaptureSink(
    workerIdentity('execution-ticks'),
    run,
  );
  sink.setStarted(7);
  for (let tick = 0; tick < 70; tick++) {
    await sink.write('stdout', Buffer.from(`tick ${tick}\n`));
    await sink.capture.flushPartial('stdout');
  }
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  exited(sink);
  const envelope = await sink.finalize('success', []);
  await sink.close();
  expect(envelope.capture?.captureStatus).toBe('complete');
  const manifest = parseToolResultManifestBytes(
    await sink.resources.read(envelope.capture!.manifest!),
  );
  const stdout = manifest.contents.find((c) => c.streamId === 'stdout')!;
  expect(
    (
      stdout.body as { readonly pages: ReadonlyArray<{ segmentCount: number }> }
    ).pages.map((page) => page.segmentCount),
  ).toEqual([70]);
  // Every revision rides an enqueued entry, so the worker keeps only the
  // final manifest the capture reads back.
  expect(
    sink.resources.since(-1).map((resource) => resource.ref.resourceId),
  ).toEqual([envelope.capture!.manifest!.resourceId]);
});

it('keeps capture output out of monitor observation entries', async () => {
  const run = new BackgroundDeliveryRun(
    'execution-mon-out',
    '1',
    'monitor_run',
  );
  const sink = new WorkerBackgroundCaptureSink(
    workerIdentity('execution-mon-out'),
    run,
  );
  const policy = monitorPolicy(run, 100, async () => true);
  sink.attachMonitorPolicy(policy);
  sink.setStarted(9);
  await sink.write(
    'stdout',
    Buffer.concat([Buffer.from('event\n'), Buffer.alloc(128 * 1024, 0x61)]),
  );
  await policy.flushTail();
  await sink.close();
  const { entries } = await run.pullForStage({ afterSeq: 0, maxEntries: 256 });
  const kinds = (kind: string) =>
    entries
      .filter((entry) => entry.kind === kind)
      .flatMap((entry) => entry.resources.map((resource) => resource.ref.kind));
  expect(kinds('output')).toContain(MANAGED_TOOL_RESULT_KINDS.content);
  expect(kinds('observation').sort()).toEqual([
    'managed-admission',
    'managed-input',
  ]);
});

it('settles a Monitor whose tail reaches maxEvents without waiting on its own completion', async () => {
  const run = new BackgroundDeliveryRun(
    'execution-mon-tail',
    '1',
    'monitor_run',
  );
  const sink = new WorkerBackgroundCaptureSink(
    workerIdentity('execution-mon-tail'),
    run,
  );
  // terminate resolves with the unit's completion, which is this finalize.
  const unit: { completion?: Promise<unknown> } = {};
  sink.attachMonitorPolicy(
    monitorPolicy(run, 1, async () => {
      await unit.completion;
      return true;
    }),
  );
  sink.setStarted(9);
  await sink.write('stdout', Buffer.from('only\n'));
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  exited(sink);
  unit.completion = sink.finalize('success', []);
  const outcome = await Promise.race([
    unit.completion.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 2_000)),
  ]);
  await sink.close();
  expect(outcome).toBe('settled');
  const { entries } = await run.pullForStage({ afterSeq: 0, maxEntries: 256 });
  expect(entries.filter((entry) => entry.kind === 'observation')).toHaveLength(
    1,
  );
  expect(entries.at(-1)).toMatchObject({
    kind: 'terminal',
    monitorStopReason: 'exited',
  });
});

it('drops the tail window after a max_events stop instead of exceeding the quota', async () => {
  const run = new BackgroundDeliveryRun(
    'execution-mon-quota',
    '1',
    'monitor_run',
  );
  const sink = new WorkerBackgroundCaptureSink(
    workerIdentity('execution-mon-quota'),
    run,
  );
  let terminated = false;
  sink.attachMonitorPolicy(
    monitorPolicy(run, 1, async () => {
      terminated = true;
      return true;
    }),
  );
  sink.setStarted(9);
  await sink.write('stdout', Buffer.from('first\nsecond'));
  await vi.waitFor(() => expect(terminated).toBe(true), { timeout: 3_000 });
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  exited(sink);
  await sink.finalize('success', []);
  await sink.close();
  const { entries } = await run.pullForStage({ afterSeq: 0, maxEntries: 256 });
  expect(entries.filter((entry) => entry.kind === 'observation')).toHaveLength(
    1,
  );
  expect(entries.at(-1)).toMatchObject({
    kind: 'terminal',
    monitorStopReason: 'max_events',
  });
});
