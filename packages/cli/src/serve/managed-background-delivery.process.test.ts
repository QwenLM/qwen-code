/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
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
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import {
  MANAGED_SHELL_PUBLISHER_DETACH_ROUTE,
  MANAGED_SHELL_PUBLISHER_ROUTE,
  ManagedShellPublisherRegistry,
} from './managed-shell-publisher.js';
import type { WorkerBackgroundCaptureSink } from './managed-background-delivery.js';

/**
 * Phase 3b acceptance (§10) against real background processes: the worker's
 * capture reads actual pipes, so a Harness restart, a quiet exit and a forced
 * stop under backpressure are exercised end to end rather than through
 * synthetic sink writes.
 */

let root: string | undefined;
let session: ManagedSession | undefined;
let worker: Server | undefined;
const publishers: HostedShellPublisher[] = [];
const children: Array<ChildProcessByStdio<null, Readable, Readable>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
  for (const publisher of publishers.splice(0)) await publisher.close();
  if (worker?.listening) {
    worker.closeAllConnections();
    await new Promise<void>((resolve) => worker!.close(() => resolve()));
  }
  await session?.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  session = undefined;
  worker = undefined;
});

function resourceStore(
  baseDir: string,
  sessionId: string,
  reader: { read: (ref: ManagedSessionDurableRef) => Promise<Buffer> },
): DurableToolResultResourceStore {
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

const EXECUTION = 'execution-bg';

async function rig() {
  root = await mkdtemp(path.join(tmpdir(), 'qwen-bg-process-'));
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
  await createManagedHarnessHandle(session).ensureRunnable();
  const resources = resourceStore(root, key.sessionId, session.resources);
  const childRuns = new HostedChildRunSession(
    { authority: session.authority, resources },
    key,
  );
  const monitors = new HostedMonitorSession(
    { authority: session.authority, resources },
    key,
  );
  const capture = {
    tenantId: key.tenantId,
    sessionId: key.sessionId,
    turnId: 'turn-a',
    executionCallId: EXECUTION,
    bindingGeneration: '1',
    capturePolicy: 'complete_required' as const,
    background: true,
  };
  const request = {
    reference: {
      sessionId: key.sessionId,
      promptId: 'prompt-a',
      callId: 'worker-call-a',
      argsDigest: `sha256:${'a'.repeat(64)}`,
    },
    capture,
  };
  const newPublisher = () => {
    const publisher = new HostedShellPublisher(
      session!,
      resources,
      async () => {},
      childRuns,
      monitors,
    );
    publishers.push(publisher);
    return publisher;
  };
  const first = newPublisher();
  first.register(
    request as Parameters<HostedShellPublisher['register']>[0],
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
  const workerBase = `http://127.0.0.1:${(worker!.address() as { port: number }).port}`;
  const headers = {
    authorization: 'Bearer runtime-token',
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'x-qwen-managed-lease-id': 'lease-a',
    'x-qwen-managed-lease-epoch': '1',
  };
  const install = async (
    publisher: HostedShellPublisher,
    generation: number,
  ) => {
    const response = await fetch(
      workerBase + MANAGED_SHELL_PUBLISHER_ROUTE.path,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocolVersion: 3,
          toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
          sessionId: key.sessionId,
          publisher: await publisher.start(),
          writerGeneration: generation,
        }),
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };
  const detach = async (generation: number) => {
    const response = await fetch(
      workerBase + MANAGED_SHELL_PUBLISHER_DETACH_ROUTE.path,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          protocolVersion: 3,
          toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
          sessionId: key.sessionId,
          writerGeneration: generation,
        }),
      },
    );
    expect(response.status).toBe(200);
  };

  await childRuns.admit({
    shellId: EXECUTION,
    ownerScopeId: key.sessionId,
    executionCallId: EXECUTION,
    args: { command: 'real background shell', is_background: true },
  });
  await childRuns.dispatchStarted(EXECUTION, {
    runtimeBindingId: 'binding-a',
    generation: '1',
  });
  // The start receipt the settle path requires: without it the record stays
  // dispatch_started and a terminal delivery is refused.
  await childRuns.attach(
    EXECUTION,
    { runtimeBindingId: 'binding-a', generation: '1' },
    { pid: 0 },
  );
  await install(first, 1);
  const prepared = await registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  return {
    key,
    childRuns,
    registry,
    resources,
    request,
    prepared,
    sink: prepared.sink as WorkerBackgroundCaptureSink,
    newPublisher,
    install,
    detach,
    workerBase,
    headers,
  };
}

/** Pipes a real process into the worker sink, honoring its backpressure. */
function driveRealProcess(
  sink: WorkerBackgroundCaptureSink,
  command: string,
): {
  child: ChildProcessByStdio<null, Readable, Readable>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  drained: Promise<void>;
} {
  const child = spawn('bash', ['-c', command], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  sink.setStarted(child.pid ?? 0);
  let chain = Promise.resolve();
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].on('data', (chunk: Buffer) => {
      chain = chain.then(() => sink.write(stream, chunk));
    });
    child[stream].on('end', () => {
      chain = chain.then(() => sink.finish(stream, true));
    });
  }
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, drained: chain };
}

async function waitFor(
  predicate: () => boolean,
  boundMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(predicate()).toBe(true);
}

/** The settled manifest's per-stream declaration: bytes and digest. */
async function streamSummary(
  r: Awaited<ReturnType<typeof rig>>,
  manifestRef: ManagedSessionDurableRef,
): Promise<Array<{ streamId: string; byteLength: number }>> {
  const manifest = parseToolResultManifestBytes(
    await r.resources.read(manifestRef),
  );
  return manifest.contents.map((content) => ({
    streamId: content.streamId,
    byteLength: content.byteLength,
  }));
}
/**
 * Re-attaches a fresh applier the way a reload does (§4.6): hold live pushes,
 * install at the newer generation, then seed the cursor from the watermark the
 * worker reports. Without the seed the first post-acknowledgement entry looks
 * out of order, because the worker already trimmed the acked prefix.
 */
async function reattach(
  r: Awaited<ReturnType<typeof rig>>,
  applier: HostedShellPublisher,
  generation: number,
): Promise<void> {
  applier.restoreBackgroundCapture(
    EXECUTION,
    'child_run',
    r.childRuns.record(EXECUTION)!.outputRef,
  );
  const release = applier.holdDeliveries();
  try {
    const installed = await r.install(applier, generation);
    const observed = (installed['observedRuns'] ?? {}) as Record<
      string,
      number
    >;
    await applier.applyStagedDeliveries([], observed, async () => {});
  } finally {
    release();
  }
}
it('a quiet exit while detached settles from the terminal entry on re-attach', async () => {
  const r = await rig();
  await r.detach(1);
  await publishers[0]!.close();

  // No output at all: the only entry the worker can emit is the terminal one.
  const { exited, drained } = driveRealProcess(r.sink, 'exit 0');
  const { code } = await exited;
  await drained;
  expect(r.sink.run.lastApplied).toBe(0);
  r.sink.setProcessResult({
    exitCode: code,
    signal: null,
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    pid: 0,
    executionMethod: 'child_process',
  });
  const envelopePromise = r.sink.finalize('success', []);
  await waitFor(() => r.sink.run.isClosedOrTerminal);

  const second = r.newPublisher();
  second.restoreBackgroundCapture(
    EXECUTION,
    'child_run',
    r.childRuns.record(EXECUTION)!.outputRef,
  );
  await r.install(second, 2);
  const envelope = await envelopePromise;
  await r.registry.accept(r.prepared.identity, envelope);
  await waitFor(() => r.childRuns.record(EXECUTION)!.run.state === 'settled');
  expect(r.childRuns.record(EXECUTION)!.exitCode).toBe(0);
  // A quiet exit still leaves a valid, empty manifest chain rather than no
  // Artifact at all.
  const settled = r.childRuns.record(EXECUTION)!;
  expect(settled.outputRef).not.toBeNull();
  const summary = await streamSummary(r, settled.outputRef!);
  expect(summary.every((stream) => stream.byteLength === 0)).toBe(true);
});
it('a Harness restart mid-stream keeps one capture and every byte exactly once', async () => {
  const r = await rig();
  const chunks = 48;
  const chunkWidth = 8192;
  const expected = Array.from(
    { length: chunks },
    (_, i) => String(i + 1).padStart(chunkWidth, '0') + '\n',
  ).join('');
  const { exited, drained } = driveRealProcess(
    r.sink,
    `for i in $(seq 1 ${chunks}); do printf '%0${chunkWidth}d\\n' "$i"; sleep 0.01; done`,
  );

  // The first Harness applies a prefix, then dies while the process runs on.
  await waitFor(() => r.sink.run.lastApplied > 0);
  const appliedBeforeRestart = r.sink.run.lastApplied;
  await r.detach(1);
  await publishers[0]!.close();

  const second = r.newPublisher();
  await reattach(r, second, 2);

  const { code } = await exited;
  await drained;
  r.sink.setProcessResult({
    exitCode: code,
    signal: null,
    rawOutput: Buffer.from(expected),
    output: expected,
    error: null,
    aborted: false,
    pid: 0,
    executionMethod: 'child_process',
  });
  const envelope = await r.sink.finalize('success', [{ text: expected }]);
  expect(envelope.executionStatus).toBe('success');
  await r.registry.accept(r.prepared.identity, envelope);
  await waitFor(() => r.childRuns.record(EXECUTION)!.run.state === 'settled');

  const settled = r.childRuns.record(EXECUTION)!;
  expect(settled.exitCode).toBe(0);
  expect(appliedBeforeRestart).toBeGreaterThan(0);
  // Every byte exactly once, in order, through one capture lineage.
  const manifest = parseToolResultManifestBytes(
    await r.resources.read(settled.outputRef!),
  );
  const stdout = manifest.contents.find((c) => c.streamId === 'stdout')!;
  expect(stdout.byteLength).toBe(Buffer.byteLength(expected));
  expect(stdout.digest).toBe(
    createHash('sha256').update(expected).digest('hex'),
  );
  expect(manifest.revision).toBeGreaterThan(1);
});

it('a forced stop under backpressure still produces its exit proof', async () => {
  const r = await rig();
  await r.detach(1);
  await publishers[0]!.close();

  // An unbounded producer fills the held outbox until the capture's write
  // queue parks on the byte budget — the worker-side equivalent of a
  // process paused on its own output pipes. SIGSTOP freezes the producer
  // so the buffered tail stays bounded, then SIGKILL is the forced stop.
  const line = '0'.repeat(8191) + '1\n';
  const { child, exited } = driveRealProcess(
    r.sink,
    `while :; do printf '%08192d\\n' 1; done`,
  );
  // Wait until the outbox is full and the write queue parks on the budget:
  // the entry count stops growing while the producer is still writing, so
  // more buffered output sits behind the parked revision — the tail the
  // stop must drop. Freezing earlier could land on a segment boundary with
  // nothing left to lose.
  let stable = 0;
  let previous = r.sink.run.pendingCount;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && stable < 2) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = r.sink.run.pendingCount;
    stable = current === previous && current > 0 ? stable + 1 : 0;
    previous = current;
  }
  expect(stable).toBeGreaterThanOrEqual(2);
  child.kill('SIGSTOP');
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill('SIGKILL');
  const { signal } = await exited;
  expect(signal).toBe('SIGKILL');

  // The registry's completion order: stop marker, physical evidence, then
  // finish + finalize. None of it may wait on the parked write queue (§4.4:
  // a full outbox must never keep a stopped process from its exit proof).
  r.sink.setStopRequested();
  r.sink.setProcessResult({
    exitCode: null,
    signal: constants.signals.SIGKILL,
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    pid: 0,
    executionMethod: 'child_process',
  });
  await r.sink.finish('stdout', true);
  await r.sink.finish('stderr', true);
  const envelope = await r.sink.finalize('error', [], {
    message: 'Background Shell terminated with SIGKILL.',
  });
  expect(r.sink.run.isClosedOrTerminal).toBe(true);
  expect(envelope.capture?.captureStatus).toBe('partial');
  expect(envelope.capture?.captureReason).toBe('cancelled');

  // The exit proof rides the reserved terminal slot; a fresh applier drains
  // the queued prefix and settles the stop without a model turn.
  const second = r.newPublisher();
  await reattach(r, second, 2);
  const receipt = await r.registry.accept(r.prepared.identity, envelope);
  expect(receipt.manifest).not.toBeNull();
  await waitFor(
    () => r.childRuns.record(EXECUTION)!.run.execution === 'settled',
  );
  const settled = r.childRuns.record(EXECUTION)!;
  expect(settled.run.state).toBe('cancelled');
  expect(settled.stopReason).toBe('stop_requested');
  expect(settled.stopRequested).toBe(true);
  // A stop by anyone else carries no exit status (contract rule).
  expect(settled.exitCode).toBeNull();
  expect(settled.exitSignal).toBeNull();

  // The retained prefix is exactly the producer's bytes; the dropped tail
  // is a declared gap, not admitted bytes.
  const manifest = parseToolResultManifestBytes(
    await r.resources.read(settled.outputRef!),
  );
  expect(manifest.executionStatus).toBe('error');
  expect(manifest.signal).toBe('SIGKILL');
  expect(manifest.captureStatus).toBe('partial');
  expect(manifest.captureReason).toBe('cancelled');
  const stdout = manifest.contents.find((c) => c.streamId === 'stdout')!;
  expect(stdout.state).toBe('incomplete');
  expect(stdout.byteLength).toBeGreaterThan(0);
  expect(stdout.missingRanges).toEqual([
    { start: stdout.byteLength, end: null },
  ]);
  const prefix = line
    .repeat(Math.ceil(stdout.byteLength / line.length))
    .slice(0, stdout.byteLength);
  expect(stdout.digest).toBe(createHash('sha256').update(prefix).digest('hex'));
}, 30_000);
