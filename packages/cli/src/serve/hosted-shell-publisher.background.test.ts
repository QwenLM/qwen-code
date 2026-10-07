/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { parseChildShellRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  MANAGED_TOOL_RESULT_PROTOCOL,
  parseToolResultManifestBytes,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ToolResultStoreOutcome } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type {
  ToolResultRangeRequest,
  ToolResultSegmentStore,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedMonitorLoop } from './hosted-monitor-loop.js';
import { HostedMonitorRemoteExecutor } from './hosted-monitor-remote-executor.js';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { ManagedShellPublisherRegistry } from './managed-shell-publisher.js';

// child_run and monitor_run are enabled by the H3 enablement slice; the
// test drives both background paths ahead of it with the same test-only
// flip the authority suites use.
const enablement = vi.hoisted(() => ({ childRun: true, monitorRun: true }));

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
        if (
          domain === 'child_run'
            ? !enablement.childRun
            : domain === 'monitor_run'
              ? !enablement.monitorRun
              : true
        ) {
          actual.assertManagedSessionDomainEnabled(domain);
        }
      },
    };
  },
);

let root: string | undefined;
let session: ManagedSession | undefined;
let orchestrator: HostedChildRunSession | undefined;
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
  orchestrator = undefined;
  publisher = undefined;
  server = undefined;
});

interface Rig {
  key: {
    tenantId: string;
    workspaceId: string;
    sessionId: string;
  };
  orchestrator: HostedChildRunSession;
  monitors: HostedMonitorSession;
  registry: ManagedShellPublisherRegistry;
  resources: DurableToolResultResourceStore;
  store: ToolResultSegmentStore;
  manifests: Set<ManagedSessionDurableRef>;
  descriptor: {
    readonly url: string;
    readonly token: string;
  };
}

/** An in-memory segment store behind the same durable-resource double. */
function segmentStore(
  values: Map<string, { ref: ManagedSessionDurableRef; bytes: Buffer }>,
): ToolResultSegmentStore {
  return {
    async publish(request: unknown) {
      const req = request as {
        captureId: string;
        streamId: string;
        ordinal: number;
        bytes: Buffer;
      };
      values.set(`${req.captureId}/${req.streamId}/${req.ordinal}`, {
        ref: {} as ManagedSessionDurableRef,
        bytes: Buffer.from(req.bytes),
      });
      const outcome: ToolResultStoreOutcome<{
        ordinal: number;
        byteLength: number;
        digest: string;
      }> = {
        status: 'ok',
        result: {
          ordinal: req.ordinal,
          byteLength: req.bytes.byteLength,
          digest: createHash('sha256').update(req.bytes).digest('hex'),
        },
      };
      return outcome;
    },
    async seal() {
      return {
        status: 'ok' as const,
        result: { segmentCount: 1, byteLength: 0, digest: '0'.repeat(64) },
      };
    },
    async prefix() {
      return {
        status: 'ok' as const,
        result: {
          segmentCount: 1,
          byteLength: 0,
          digest: '0'.repeat(64),
          sealed: false,
        },
      };
    },
    async readRange(_request: ToolResultRangeRequest) {
      return { status: 'ok' as const, result: Buffer.alloc(0) };
    },
    async close() {},
  };
}

async function rig(): Promise<Rig> {
  root = await mkdtemp(path.join(tmpdir(), 'qwen-hosted-bg-'));
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
  void harness;
  orchestrator = new HostedChildRunSession(
    { authority: session.authority, resources: session.resources },
    key,
  );
  await orchestrator.admit({
    shellId: 'execution-bg',
    ownerScopeId: key.sessionId,
    executionCallId: 'execution-bg',
    args: { command: 'echo hi', is_background: true },
  });
  await orchestrator.dispatchStarted('execution-bg', {
    runtimeBindingId: 'binding-a',
    generation: '1',
  });
  await orchestrator.attach(
    'execution-bg',
    { runtimeBindingId: 'binding-a', generation: '1' },
    { pid: 7 },
  );
  const monitors = new HostedMonitorSession(
    { authority: session.authority, resources: session.resources },
    key,
  );

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
      values.set(resourceId, { ref, bytes: Buffer.from(bytes) });
      return ref;
    },
    async read(ref) {
      const entry = values.get(ref.resourceId);
      if (!entry) throw new Error(`Resource ${ref.resourceId} unavailable.`);
      return Buffer.from(entry.bytes);
    },
  };
  publisher = new HostedShellPublisher(
    session,
    resources,
    async () => {},
    orchestrator,
    monitors,
  );
  const descriptor = await publisher.start();
  const registry = new ManagedShellPublisherRegistry();
  const app = express();
  registry.register(
    app,
    { token: 'runtime-token', leaseId: 'lease-a', epoch: 1 },
    (id) => id === 'runtime-a',
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const registrationUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${'/internal/managed-runtime/v3/publisher'}`;
  const answer = await fetch(registrationUrl, {
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
      sessionId: 'runtime-a',
      publisher: descriptor,
    }),
  });
  expect(answer.status).toBe(200);
  return {
    key,
    orchestrator,
    monitors,
    registry,
    resources,
    store: segmentStore(values),
    manifests: new Set<ManagedSessionDurableRef>(),
    descriptor,
  };
}

type BackgroundRigArg = Parameters<
  ManagedShellPublisherRegistry['prepare']
>[0] & { capture: { background: true } };

function backgroundRequest(
  key: { tenantId: string; sessionId: string },
  generation: string,
  monitoring = false,
): BackgroundRigArg {
  return {
    reference: {
      sessionId: 'runtime-a',
      promptId: 'prompt-a',
      callId: 'worker-call-a',
      argsDigest: `sha256:${'a'.repeat(64)}`,
    },
    capture: {
      tenantId: key.tenantId,
      sessionId: key.sessionId,
      turnId: 'turn-a',
      ...(monitoring ? { monitoring: true } : {}),
      executionCallId: 'execution-bg',
      bindingGeneration: generation,
      capturePolicy: 'complete_required',
      background: true,
    } as never,
  } as BackgroundRigArg;
}

it('admits the foreground of every turn of the Session beside a background watch', async () => {
  const r = await rig();
  const bg = backgroundRequest(r.key, '1');
  publisher!.register(
    { reference: bg.reference, capture: bg.capture },
    'model-call-a',
    'prompt-a',
  );
  const fg = (promptId: string) => ({
    reference: {
      sessionId: promptId,
      promptId,
      callId: 'worker-call-b',
      argsDigest: `sha256:${'a'.repeat(64)}`,
    },
    capture: {
      tenantId: r.key.tenantId,
      sessionId: r.key.sessionId,
      turnId: promptId,
      executionCallId: `execution-${promptId}`,
      bindingGeneration: '1',
      capturePolicy: 'complete_required' as const,
    },
  });
  publisher!.register(fg('prompt-a'), 'model-call-a2', 'prompt-a');
  // A later turn's foreground names its own prompt on the same instance.
  publisher!.register(fg('prompt-b'), 'model-call-b', 'prompt-b');
  // While one that pretends its registering turn's identity is refused.
  expect(() =>
    publisher!.register(fg('prompt-c'), 'model-call-c', 'prompt-b'),
  ).toThrow(/Runtime Session conflicts/);
});

it('runs the background exit leg: revise, seal, settle as one evidence', async () => {
  const r = await rig();
  const request = backgroundRequest(r.key, '1');
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    backgroundRequest(r.key, '1') as Parameters<
      ManagedShellPublisherRegistry['prepare']
    >[0],
  );
  prepared.sink.setStarted(1);
  await prepared.sink.write('stdout', Buffer.alloc(64 * 1024, 7));
  await prepared.sink.write('stderr', Buffer.from('warn'));

  // The record's output manifest advanced to what the live capture shows.
  let record = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-bg')!.record,
  );
  expect(record.outputRef?.kind).toBe(MANAGED_TOOL_RESULT_KINDS.manifest);

  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 3,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  const envelope = await prepared.sink.finalize(
    'error',
    [{ text: 'done' }],
    undefined,
  );
  expect(envelope.executionStatus).toBe('error');
  expect(envelope.capture?.manifest?.kind).toBe(
    MANAGED_TOOL_RESULT_KINDS.manifest,
  );

  await r.registry.accept(prepared.identity, envelope);

  // The record settled with exactly that evidence, and the manifest's
  // physical fields read the same exit.
  record = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-bg')!.record,
  );
  expect(record).toMatchObject({
    stopReason: 'exited',
    exitCode: 3,
    exitSignal: null,
    startReceiptRef: record.startReceiptRef,
  });
  expect(record.run.state).toBe('settled');
  expect(record.run.execution).toBe('settled');
  const finalManifest = parseToolResultManifestBytes(
    await (
      session!.resources as {
        read: (ref: ManagedSessionDurableRef) => Promise<Buffer>;
      }
    ).read(record.outputRef!),
  );
  expect(finalManifest.executionStatus).toBe('error');
  expect(finalManifest.exitCode).toBe(3);
  expect(finalManifest.captureStatus).toBe('complete');
  expect(finalManifest.contents.map((each) => each.state)).toEqual([
    'sealed',
    'sealed',
  ]);
  expect(finalManifest.contents[0]!.byteLength).toBe(64 * 1024);
  expect(finalManifest.contents[1]!.byteLength).toBe(4);
  // No second tool.receipt exists anywhere for this outcome.
  expect(
    session!.authority
      .eventsInSequenceRange(1, session!.authority.committedSequence)
      .filter((event) => event.kind === 'tool.receipt'),
  ).toHaveLength(0);
});

it('melds a monitor watch through one terminal step only after its start receipt', async () => {
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.monitors.admit({
    monitorId: 'monitor-execution',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'monitor-execution',
    args: { command: 'du -sh .', description: 'du watch' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
  });
  await r.monitors.dispatchStarted('monitor-execution', BINDING);

  const request = backgroundRequest(r.key, '1', true);
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'monitor-execution';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-m',
    request.reference.sessionId,
  );
  // Production start order: prepare, then supervisor.start, then attach.
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  let record = parseMonitorRun(
    session!.authority.extensionRecord('monitor_run', 'monitor-execution')!
      .record,
  );
  expect(record.startReceiptRef).toBeNull();
  expect(record.outputRef).toBeNull();

  // The proven start's receipt arrives; only now may the record's output
  // advance (and only through the monitor funnel, never the Shell's).
  await r.monitors.attach('monitor-execution', BINDING, { pid: 8 });
  const loop = new HostedMonitorLoop(
    r.monitors,
    'monitor-execution',
    new HostedMonitorRemoteExecutor(publisher!),
  );
  await loop.resumeAttached({
    ownerScopeId: r.key.sessionId,
    executionCallId: 'monitor-execution',
    args: { command: 'du -sh .', description: 'du watch' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
    runtime: BINDING,
  });

  prepared.sink.setStarted(8);
  await prepared.sink.write('stdout', Buffer.from('line one\nline two\n'));
  record = parseMonitorRun(
    session!.authority.extensionRecord('monitor_run', 'monitor-execution')!
      .record,
  );
  expect(record.outputRef?.kind).toBe(MANAGED_TOOL_RESULT_KINDS.manifest);

  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  const envelope = await prepared.sink.finalize(
    'success',
    [{ text: 'finished' }],
    undefined,
  );
  await r.registry.accept(prepared.identity, envelope);

  // The finalize awaited the loop's own exit chain: the last window is
  // committed to the record before its settled mark, exactly once.
  record = parseMonitorRun(
    session!.authority.extensionRecord('monitor_run', 'monitor-execution')!
      .record,
  );
  expect(record).toMatchObject({
    observationSequence: 1,
    notifiedThrough: 1,
    stopReason: 'exited',
    run: { state: 'settled', execution: 'settled' },
  });
});

it('retries a finalize that failed once instead of caching the refusal forever', async () => {
  const r = await rig();
  const request = backgroundRequest(r.key, '1');
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(1);
  await prepared.sink.write('stdout', Buffer.from('half a line\n'));
  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  // One malformed finalize lands it: anything after used to re-answer
  // that cached rejection forever, wedging this capture's terminal leg.
  const failed = await fetch(r.descriptor.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${r.descriptor.token}`,
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'finalize',
      executionCallId: 'execution-bg',
      started: true,
      failed: false,
      process: {
        exitCode: 'not-an-integer',
        signal: null,
        previewBytes: 0,
      },
      executionStatus: 'success',
      responseParts: [],
      previewTruncated: false,
      error: null,
    }),
  });
  expect(failed.status).toBeGreaterThanOrEqual(400);
  const envelope = await prepared.sink.finalize('success', [], undefined);
  expect(envelope.capture?.captureStatus).toBe('complete');
  const record = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-bg')!.record,
  );
  expect(record).toMatchObject({
    stopReason: 'exited',
    run: { state: 'settled', execution: 'settled' },
  });
});

it('commits the tail an ownerless watch decoded before its record settles', async () => {
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.monitors.admit({
    monitorId: 'monitor-tail',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'monitor-tail',
    args: { command: 'du -sh .', description: 'du watch' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
  });
  await r.monitors.dispatchStarted('monitor-tail', BINDING);
  const request = backgroundRequest(r.key, '1', true);
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'monitor-tail';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-m',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  await r.monitors.attach('monitor-tail', BINDING, { pid: 9 });
  prepared.sink.setStarted(9);
  // The watch ends before any observation arm registers: its decoded
  // lines still commit — with the wake the end should raise too.
  await prepared.sink.write('stdout', Buffer.from('last window\nvery last\n'));
  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  const envelope = await prepared.sink.finalize('success', [], undefined);
  await r.registry.accept(prepared.identity, envelope);
  const record = parseMonitorRun(
    session!.authority.extensionRecord('monitor_run', 'monitor-tail')!.record,
  );
  expect(record).toMatchObject({
    observationSequence: 1,
    notifiedThrough: 1,
    stopReason: 'exited',
    run: { state: 'settled', execution: 'settled' },
  });
  const wakes = session!.authority
    .eventsInSequenceRange(1, session!.authority.committedSequence)
    .filter((event) => event.kind === 'wake.requested');
  expect(wakes).toHaveLength(1);
});

it('completes a refused exit settle on the record’s own attach, without a client retry', async () => {
  const r = await rig();
  // The exit outruns the start receipt: admitted and dispatched, never yet
  // attached — the exact shape of a fast exit racing the accepted start.
  await r.orchestrator.admit({
    shellId: 'execution-late',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'execution-late',
    args: { command: 'echo bye', is_background: true },
  });
  await r.orchestrator.dispatchStarted('execution-late', {
    runtimeBindingId: 'binding-a',
    generation: '1',
  });
  const request = backgroundRequest(r.key, '1');
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'execution-late';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(7);
  await prepared.sink.write('stdout', Buffer.from('done\n'));
  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  const first = await fetch(r.descriptor.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${r.descriptor.token}`,
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'finalize',
      executionCallId: 'execution-late',
      started: true,
      failed: false,
      process: { exitCode: 0, signal: null, previewBytes: 0 },
      executionStatus: 'success',
      responseParts: [],
      previewTruncated: false,
      error: null,
    }),
  });
  // The record refuses a settle it cannot name as attached.
  expect(first.status).toBeGreaterThanOrEqual(400);
  const unattached = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-late')!.record,
  );
  expect(unattached.stopReason).toBeNull();
  // The start receipt lands through the ordinary accept: the refused
  // finalize completes from the entry's own memory — no client retry.
  await r.orchestrator.attach(
    'execution-late',
    { runtimeBindingId: 'binding-a', generation: '1' },
    { pid: 7 },
  );
  await publisher!.settleAttached('execution-late');
  const record = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-late')!.record,
  );
  expect(record).toMatchObject({
    stopReason: 'exited',
    run: { state: 'settled', execution: 'settled' },
  });
  expect(record.outputRef).not.toBeNull();
});

it('re-drives a refused final forward on an attached record without any client action', async () => {
  // S15b: the worker finalizes exactly once and moves on; a single
  // transient failure on that last forward leaves the record running
  // forever. The refused body that owns the settle re-drives itself.
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.orchestrator.admit({
    shellId: 'execution-strand',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'execution-strand',
    args: { command: 'echo bye', is_background: true },
  });
  await r.orchestrator.dispatchStarted('execution-strand', BINDING);
  await r.orchestrator.attach('execution-strand', BINDING, { pid: 7 });
  const request = backgroundRequest(r.key, '1');
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'execution-strand';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(7);
  await prepared.sink.write('stdout', Buffer.from('done\n'));
  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  // The one transient failure on the final record forward. Fake timers
  // keep the re-drive tick parked while the pre-re-drive state is read.
  vi.useFakeTimers();
  const advance = vi
    .spyOn(r.orchestrator, 'advanceOutput')
    .mockRejectedValueOnce(new Error('transient store 5xx'));
  const refused = await fetch(r.descriptor.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${r.descriptor.token}`,
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'finalize',
      executionCallId: 'execution-strand',
      started: true,
      failed: false,
      process: { exitCode: 0, signal: null, previewBytes: 0 },
      executionStatus: 'success',
      responseParts: [],
      previewTruncated: false,
      error: null,
    }),
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(advance).toHaveBeenCalledOnce();
  const stranded = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-strand')!.record,
  );
  expect(stranded.stopReason).toBeNull();
  // No client retry, no re-attach, no manual settle: the refused body's
  // own re-drive completes the record.
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  await vi.waitFor(
    () => {
      const record = parseChildShellRun(
        session!.authority.extensionRecord('child_run', 'execution-strand')!
          .record,
      );
      expect(record).toMatchObject({
        stopReason: 'exited',
        run: { state: 'settled', execution: 'settled' },
      });
      expect(record.outputRef).not.toBeNull();
    },
    { timeout: 5_000, interval: 50 },
  );
});

it('heals a refused final forward through the bounded redrive when the store flaps twice (S15c)', async () => {
  // One immediate tick cannot heal a brief store outage: the re-drive is
  // bounded, so a refusal on both the forward and its first retry still
  // lands on its second attempt.
  const r = await rig();
  vi.useFakeTimers();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.orchestrator.admit({
    shellId: 'execution-flap',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'execution-flap',
    args: { command: 'echo bye', is_background: true },
  });
  await r.orchestrator.dispatchStarted('execution-flap', BINDING);
  await r.orchestrator.attach('execution-flap', BINDING, { pid: 7 });
  const request = backgroundRequest(r.key, '1');
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'execution-flap';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(7);
  await prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  // The route's own advance fails (#1), and the redrive's first attempt
  // meets the same unhealthy store one backoff earlier than it would
  // land: the bounded chain reaches its second attempt with #3.
  const advance = vi
    .spyOn(r.orchestrator, 'advanceOutput')
    .mockRejectedValueOnce(new Error('transient store 5xx #1'))
    .mockRejectedValueOnce(new Error('transient store 5xx #2'));
  const refused = await fetch(r.descriptor.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${r.descriptor.token}`,
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'finalize',
      executionCallId: 'execution-flap',
      started: true,
      failed: false,
      process: { exitCode: 0, signal: null, previewBytes: 0 },
      executionStatus: 'success',
      responseParts: [],
      previewTruncated: false,
      error: null,
    }),
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(
    parseChildShellRun(
      session!.authority.extensionRecord('child_run', 'execution-flap')!.record,
    ).stopReason,
  ).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    parseChildShellRun(
      session!.authority.extensionRecord('child_run', 'execution-flap')!.record,
    ).stopReason,
  ).toBeNull();
  // The backoff step's attempted number two also fires inside the
  // fake-timer window before the wall clock resumes.
  await vi.advanceTimersByTimeAsync(400);
  vi.useRealTimers();
  await vi.waitFor(
    () => {
      const record = parseChildShellRun(
        session!.authority.extensionRecord('child_run', 'execution-flap')!
          .record,
      );
      expect(record).toMatchObject({
        stopReason: 'exited',
        run: { state: 'settled', execution: 'settled' },
      });
    },
    { timeout: 5_000, interval: 50 },
  );
  expect(advance.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it('waits an in-flight redrive inside the drain instead of closing past it (P2-A)', async () => {
  // A re-drive already running must land before the publisher's drain
  // answers its close: alone among the close paths it owns a stranded
  // record that only it can still settle.
  const r = await rig();
  vi.useFakeTimers();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.orchestrator.admit({
    shellId: 'execution-drain',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'execution-drain',
    args: { command: 'echo bye', is_background: true },
  });
  await r.orchestrator.dispatchStarted('execution-drain', BINDING);
  await r.orchestrator.attach('execution-drain', BINDING, { pid: 7 });
  const request = backgroundRequest(r.key, '1');
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'execution-drain';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(7);
  await prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  vi.spyOn(r.orchestrator, 'advanceOutput').mockRejectedValueOnce(
    new Error('transient store 5xx'),
  );
  // The in-flight settle of the tick holds a gate we control.
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const original = publisher!.settleAttached.bind(publisher!);
  const settled = vi
    .spyOn(publisher!, 'settleAttached')
    .mockImplementation(async (executionCallId: string) => {
      await gate;
      await original(executionCallId);
    });
  const refused = await fetch(r.descriptor.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${r.descriptor.token}`,
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'finalize',
      executionCallId: 'execution-drain',
      started: true,
      failed: false,
      process: { exitCode: 0, signal: null, previewBytes: 0 },
      executionStatus: 'success',
      responseParts: [],
      previewTruncated: false,
      error: null,
    }),
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toHaveBeenCalledOnce();
  vi.useRealTimers();
  const closing = publisher!.close();
  let answered = false;
  void closing.then(() => {
    answered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(answered).toBe(false);
  releaseGate();
  await closing;
  const record = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-drain')!.record,
  );
  expect(record).toMatchObject({
    stopReason: 'exited',
    run: { state: 'settled', execution: 'settled' },
  });
});

it('waits a redrive whose backoff fires only while the drain is already waiting (P2-3)', async () => {
  // Round-17 P2-3: the drain's one-shot snapshot of in-flight re-drives
  // misses a sibling whose backoff timer fires during the wait. Capture A
  // parks its in-flight re-drive on a gate; capture B sits in its real
  // 250 ms backoff; the close starts, and B's timer fires INSIDE the
  // drain. The close must keep collecting rounds until that attempt has
  // landed too — answering after A alone strands B's record on a Session
  // whose own teardown then eats B's settle with SessionWriterLostError.
  // Real timers the whole way: close() drains an HTTP server whose
  // keep-alive bookkeeping runs on real time.
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  const finalizeBody = (executionCallId: string) => ({
    operation: 'finalize',
    executionCallId,
    started: true,
    failed: false,
    process: { exitCode: 0, signal: null, previewBytes: 0 },
    executionStatus: 'success',
    responseParts: [],
    previewTruncated: false,
    error: null,
  });
  const postFinalize = (executionCallId: string) =>
    fetch(r.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${r.descriptor.token}`,
        'cache-control': 'no-store',
        'content-type': 'application/json',
      },
      body: JSON.stringify(finalizeBody(executionCallId)),
    });
  const admissions = ['execution-a', 'execution-b'].map(
    async (executionCallId) => {
      await r.orchestrator.admit({
        shellId: executionCallId,
        ownerScopeId: r.key.sessionId,
        executionCallId,
        args: { command: 'echo bye', is_background: true },
      });
      await r.orchestrator.dispatchStarted(executionCallId, BINDING);
      await r.orchestrator.attach(executionCallId, BINDING, { pid: 7 });
      const request = backgroundRequest(r.key, '1');
      (request.capture as Record<string, unknown>)['executionCallId'] =
        executionCallId;
      publisher!.register(
        { reference: request.reference, capture: request.capture },
        `model-call-${executionCallId}`,
        request.reference.sessionId,
      );
      const prepared = await r.registry.prepare(
        request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
      );
      prepared.sink.setStarted(7);
      await prepared.sink.setProcessResult({
        rawOutput: Buffer.alloc(0),
        output: '',
        error: null,
        aborted: false,
        exitCode: 0,
        signal: null,
        pid: undefined,
        executionMethod: 'child_process',
      });
      await prepared.sink.finish('stdout', true);
      await prepared.sink.finish('stderr', true);
    },
  );
  for (const admission of admissions) await admission;
  // A's route forward fails once, healing on its re-drive; B's route
  // forward and its 0 ms attempt both fail, arming the 250 ms backoff.
  const advances = new Map<string, number>();
  const originalAdvance = r.orchestrator.advanceOutput.bind(r.orchestrator);
  vi.spyOn(r.orchestrator, 'advanceOutput').mockImplementation(
    async (shellId, ref) => {
      const count = (advances.get(shellId) ?? 0) + 1;
      advances.set(shellId, count);
      const budget = shellId === 'execution-a' ? 1 : 2;
      if (count <= budget) throw new Error(`transient store 5xx #${count}`);
      return originalAdvance(shellId, ref);
    },
  );
  // A's re-drive in flight and B's backoff-fired attempt each hold a gate.
  let releaseGateA!: () => void;
  let releaseGateB!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseGateA = resolve;
  });
  const gateB = new Promise<void>((resolve) => {
    releaseGateB = resolve;
  });
  const settleCalls = new Map<string, number>();
  const originalSettle = publisher!.settleAttached.bind(publisher!);
  vi.spyOn(publisher!, 'settleAttached').mockImplementation(
    async (executionCallId: string) => {
      const count = (settleCalls.get(executionCallId) ?? 0) + 1;
      settleCalls.set(executionCallId, count);
      if (executionCallId === 'execution-a') await gateA;
      if (executionCallId === 'execution-b' && count >= 2) await gateB;
      await originalSettle(executionCallId);
    },
  );
  expect((await postFinalize('execution-a')).status).toBeGreaterThanOrEqual(
    400,
  );
  expect((await postFinalize('execution-b')).status).toBeGreaterThanOrEqual(
    400,
  );
  // Attempt one ticks (0 ms): A's settle parks on its gate before ever
  // calling the store again; B's attempt fails onto the flap and re-arms
  // as the real 250 ms backoff B still owns.
  await vi.waitFor(() => {
    expect(settleCalls.get('execution-a')).toBe(1);
    expect(advances.get('execution-a')).toBe(1);
    expect(settleCalls.get('execution-b')).toBe(1);
    expect(advances.get('execution-b')).toBe(2);
  });
  // Close with A in flight and B's timer armed; B fires inside the drain.
  const closing = publisher!.close();
  let answered = false;
  void closing.then(() => {
    answered = true;
  });
  await vi.waitFor(() => {
    expect(settleCalls.get('execution-b')).toBe(2);
  });
  releaseGateA();
  await vi.waitFor(() => {
    expect(
      parseChildShellRun(
        session!.authority.extensionRecord('child_run', 'execution-a')!.record,
      ).stopReason,
    ).toBe('exited');
  });
  // Give every close step behind A's landing its honest wall clock: the
  // one-shot drain would be fully answered by now.
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A landed; its sibling's drain-started attempt must still hold the
  // answer: a one-shot snapshot would have closed past B here.
  expect(answered).toBe(false);
  releaseGateB();
  await closing;
  for (const executionCallId of ['execution-a', 'execution-b']) {
    const record = parseChildShellRun(
      session!.authority.extensionRecord('child_run', executionCallId)!.record,
    );
    expect(record).toMatchObject({
      stopReason: 'exited',
      run: { state: 'settled', execution: 'settled' },
    });
  }
});

it('advances the record when a blind-capture revision lands, without waiting for another output (P2-B)', async () => {
  // The boxed failure lands its own manifest revision — the record stops
  // advertising the still-pending last healthy forward the moment the
  // degradation is committed, not at the next edging output.
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.orchestrator.admit({
    shellId: 'execution-blind',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'execution-blind',
    args: { command: 'echo bye', is_background: true },
  });
  await r.orchestrator.dispatchStarted('execution-blind', BINDING);
  await r.orchestrator.attach('execution-blind', BINDING, { pid: 7 });
  const request = backgroundRequest(r.key, '1');
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'execution-blind';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  const outputRef = () =>
    parseChildShellRun(
      session!.authority.extensionRecord('child_run', 'execution-blind')!
        .record,
    ).outputRef;
  const openRef = outputRef()!;
  expect(openRef).not.toBeNull();
  // The one segment publish is refused by the record resources: the
  // stream latches blind, and the announced revision lands alone, ahead
  // of any edging, carrying exactly the failure's name.
  const origPublish = session!.resources.publish.bind(session!.resources);
  let failPages = 1;
  const resourcesSpy = vi
    .spyOn(session!.resources, 'publish')
    .mockImplementation(async (kind: string, bytes: Buffer) => {
      if (kind === 'managed-tool-result-page' && failPages-- > 0)
        throw new Error('storage gone');
      return origPublish(kind, bytes);
    });
  const writeOps: Array<Promise<Response>> = [];
  for (let bucket = 0; bucket < 15; bucket++) {
    writeOps.push(
      fetch(r.descriptor.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${r.descriptor.token}`,
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'write',
          executionCallId: 'execution-blind',
          stream: 'stdout',
          offset: bucket * 65536,
          bytesBase64: Buffer.alloc(65536, 6).toString('base64'),
        }),
      }),
    );
  }
  for (const op of writeOps) expect((await op).status).toBeLessThan(300);
  // A finish flushes the partial page — its single refused page publish
  // latches the stream blind, and the announced revision alone reaches
  // its record.
  const finish = await fetch(r.descriptor.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${r.descriptor.token}`,
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'finish',
      executionCallId: 'execution-blind',
      stream: 'stdout',
      complete: false,
    }),
  });
  expect(finish.status).toBeLessThan(300);
  void resourcesSpy;
  await vi.waitFor(
    () => {
      const next = outputRef();
      expect(next).not.toBeNull();
      expect(next).not.toEqual(openRef);
    },
    { timeout: 5_000, interval: 50 },
  );
  const bytes = Buffer.from(await session!.resources.read(outputRef()!));
  const manifest = JSON.parse(bytes.toString()) as Record<string, unknown>;
  expect(manifest['captureStatus']).toBe('partial');
  expect(manifest['captureReason']).toBe('storage_failed');
  expect(manifest['executionStatus']).toBe('unknown');
});

it('swallows a refused write-arm forward and retries it on the next edging write (M8b)', async () => {
  // The prepare-time advance left no advance mark: with lastManifest
  // unset, the write op's own advance runs, its single injected failure
  // is swallowed with the byte it already landed, and the next edging
  // write retried the same manifest against the chain-link rule.
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.orchestrator.admit({
    shellId: 'execution-write',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'execution-write',
    args: { command: 'echo hi', is_background: true },
  });
  await r.orchestrator.dispatchStarted('execution-write', BINDING);
  await r.orchestrator.attach('execution-write', BINDING, { pid: 7 });
  const request = backgroundRequest(r.key, '1');
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'execution-write';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const failAdvance = () =>
    vi
      .spyOn(r.orchestrator, 'advanceOutput')
      .mockRejectedValueOnce(new Error('transient store 5xx'));
  failAdvance();
  await expect(
    r.registry.prepare(
      request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
    ),
  ).rejects.toThrow('Shell publisher refused the request.');
  const outputRef = () =>
    parseChildShellRun(
      session!.authority.extensionRecord('child_run', 'execution-write')!
        .record,
    ).outputRef;
  expect(outputRef()).toBeNull();
  let offset = 0;
  const writeChunk = (text: string) => {
    const bytes = Buffer.from(text, 'utf8');
    const body = JSON.stringify({
      operation: 'write',
      executionCallId: 'execution-write',
      stream: 'stdout',
      offset,
      bytesBase64: bytes.toString('base64'),
    });
    offset += bytes.byteLength;
    return fetch(r.descriptor.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${r.descriptor.token}`,
        'cache-control': 'no-store',
        'content-type': 'application/json',
      },
      body,
    });
  };
  // The write op's own advance arm carries the swallow: the byte stands,
  // the answer accepts it, and the record is not told about this edge.
  failAdvance();
  const first = await writeChunk('one\n');
  expect(first.status).toBeGreaterThanOrEqual(200);
  expect(first.status).toBeLessThan(300);
  expect(outputRef()).toBeNull();
  // The next edging write retries the same manifest and the record moves.
  const second = await writeChunk('two\n');
  expect(second.status).toBeGreaterThanOrEqual(200);
  expect(second.status).toBeLessThan(300);
  expect(outputRef()).not.toBeNull();
});

it('keeps an ownerless tail for the settle that its attach unblocks', async () => {
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.monitors.admit({
    monitorId: 'monitor-late',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'monitor-late',
    args: { command: 'tail -f log', description: 'log watch' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
  });
  await r.monitors.dispatchStarted('monitor-late', BINDING);
  const request = backgroundRequest(r.key, '1', true);
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'monitor-late';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-m',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(9);
  await prepared.sink.write('stdout', Buffer.from('first\nlast\n'));
  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  const first = await fetch(r.descriptor.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${r.descriptor.token}`,
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'finalize',
      executionCallId: 'monitor-late',
      started: true,
      failed: false,
      process: { exitCode: 0, signal: null, previewBytes: 0 },
      executionStatus: 'success',
      responseParts: [],
      previewTruncated: false,
      error: null,
    }),
  });
  expect(first.status).toBeGreaterThanOrEqual(400);
  const pending = parseMonitorRun(
    session!.authority.extensionRecord('monitor_run', 'monitor-late')!.record,
  );
  // The refusal consumed nothing: the tail waits with its record un-settled.
  expect(pending).toMatchObject({
    observationSequence: 0,
    notifiedThrough: 0,
    stopReason: null,
  });
  await r.monitors.attach('monitor-late', BINDING, { pid: 9 });
  await publisher!.settleAttached('monitor-late');
  const record = parseMonitorRun(
    session!.authority.extensionRecord('monitor_run', 'monitor-late')!.record,
  );
  expect(record).toMatchObject({
    observationSequence: 1,
    notifiedThrough: 1,
    stopReason: 'exited',
    run: { state: 'settled', execution: 'settled' },
  });
  const observation = JSON.parse(
    (await session!.resources.read(record.lastObservationRef!)).toString(
      'utf8',
    ),
  ) as { lines: string[] };
  expect(observation.lines).toEqual(['first', 'last']);
});

it('retries the record forward a wedge threw once instead of latching its write', async () => {
  const r = await rig();
  const request = backgroundRequest(r.key, '1');
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'execution-bg';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(7);
  const broken = vi
    .spyOn(r.orchestrator, 'advanceOutput')
    .mockRejectedValueOnce(new Error('record wedge'));
  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: 0,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.write('stdout', Buffer.from('one\ntwo\n'));
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  const envelope = await prepared.sink.finalize('success', [], undefined);
  expect(envelope.capture?.captureStatus).toBe('complete');
  // The thrown arm retried on the next edging write instead of latching:
  // the record ends pinned at the very manifest the byte chain reached.
  expect(broken.mock.calls.length).toBeGreaterThanOrEqual(2);
  const record = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-bg')!.record,
  );
  expect(record.outputRef).toEqual(envelope.capture!.manifest!);
});

it('settles an unproven background end as a failure, never as an exit', async () => {
  const r = await rig();
  const request = backgroundRequest(r.key, '1');
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-a',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(1);
  await prepared.sink.write('stdout', Buffer.from('half a line\n'));
  // The worker's end-without-proof arm reports exactly this null pair.
  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: null,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  await prepared.sink.finish('stderr', true);
  const envelope = await prepared.sink.finalize('error', [], {
    message: 'Background Shell ended without exit evidence.',
  });
  await r.registry.accept(prepared.identity, envelope);
  const record = parseChildShellRun(
    session!.authority.extensionRecord('child_run', 'execution-bg')!.record,
  );
  expect(record).toMatchObject({
    stopReason: 'process_failed',
    run: { state: 'failed', execution: 'settled' },
  });
});

it('settles an unproven monitor end as watch_failed, never as a clean exit', async () => {
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.monitors.admit({
    monitorId: 'monitor-unproven',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'monitor-unproven',
    args: { command: 'du -sh .', description: 'du watch' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
  });
  await r.monitors.dispatchStarted('monitor-unproven', BINDING);
  const request = backgroundRequest(r.key, '1', true);
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'monitor-unproven';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-m',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  await r.monitors.attach('monitor-unproven', BINDING, { pid: 9 });
  prepared.sink.setStarted(9);
  await prepared.sink.write('stdout', Buffer.from('still watching\n'));
  prepared.sink.setProcessResult({
    rawOutput: Buffer.alloc(0),
    output: '',
    error: null,
    aborted: false,
    exitCode: null,
    signal: null,
    pid: undefined,
    executionMethod: 'child_process',
  });
  await prepared.sink.finish('stdout', true);
  const envelope = await prepared.sink.finalize('error', [], {
    message: 'Background Shell ended without exit evidence.',
  });
  await r.registry.accept(prepared.identity, envelope);
  const record = parseMonitorRun(
    session!.authority.extensionRecord('monitor_run', 'monitor-unproven')!
      .record,
  );
  expect(record).toMatchObject({
    stopReason: 'watch_failed',
    run: { state: 'failed', execution: 'settled' },
  });
});

it('replays the lines a monitor wrote before its observer registered', async () => {
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.monitors.admit({
    monitorId: 'monitor-lines',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'monitor-lines',
    args: { command: 'du -sh .', description: 'du watch' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
  });
  await r.monitors.dispatchStarted('monitor-lines', BINDING);
  const request = backgroundRequest(r.key, '1', true);
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'monitor-lines';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-m',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(9);
  await prepared.sink.write('stdout', Buffer.from('one\ntwo\nthree'));
  const lines: string[] = [];
  publisher!.setMonitorObserver('monitor-lines', {
    onLine: (line) => lines.push(line),
    onExit: () => undefined,
  });
  expect(lines).toEqual(['one', 'two']);
  await prepared.sink.write('stdout', Buffer.from('-and-a-half\nfour\n'));
  expect(lines).toEqual(['one', 'two', 'three-and-a-half', 'four']);
});

it('force-emits a truncated observation at the partial-line ceiling instead of discarding it', async () => {
  const r = await rig();
  const BINDING = { runtimeBindingId: 'binding-a', generation: '1' };
  await r.monitors.admit({
    monitorId: 'monitor-cap',
    ownerScopeId: r.key.sessionId,
    executionCallId: 'monitor-cap',
    args: { command: 'jq -c .', description: 'jq watch' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1_000,
  });
  await r.monitors.dispatchStarted('monitor-cap', BINDING);
  const request = backgroundRequest(r.key, '1', true);
  (request.capture as Record<string, unknown>)['executionCallId'] =
    'monitor-cap';
  publisher!.register(
    { reference: request.reference, capture: request.capture },
    'model-call-m',
    request.reference.sessionId,
  );
  const prepared = await r.registry.prepare(
    request as Parameters<ManagedShellPublisherRegistry['prepare']>[0],
  );
  prepared.sink.setStarted(9);
  await prepared.sink.write('stdout', Buffer.from('x'.repeat(5000)));
  const lines: string[] = [];
  publisher!.setMonitorObserver('monitor-cap', {
    onLine: (line) => lines.push(line),
    onExit: () => undefined,
  });
  // Legacy shape: the truncated prefix with an ellipsis is one
  // observation; the rest of the overlong line is gone by design — never
  // a silent clear that loses the observation entirely.
  expect(lines).toEqual(['x'.repeat(4096) + '...']);
  await prepared.sink.write('stdout', Buffer.from('yyyyy\n'));
  expect(lines).toEqual(['x'.repeat(4096) + '...', 'yyyyy']);
});
