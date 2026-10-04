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
import { parseChildRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
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
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import { ManagedShellPublisherRegistry } from './managed-shell-publisher.js';

// child_run is enabled by the H3 enablement slice; the test drives the
// background path ahead of it with the same test-only flip the suites use.
const enablement = vi.hoisted(() => ({ childRun: true }));

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
        if (domain !== 'child_run' || !enablement.childRun) {
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
  registry: ManagedShellPublisherRegistry;
  resources: DurableToolResultResourceStore;
  store: ToolResultSegmentStore;
  manifests: Set<ManagedSessionDurableRef>;
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
    registry,
    resources,
    store: segmentStore(values),
    manifests: new Set<ManagedSessionDurableRef>(),
  };
}

type BackgroundRigArg = Parameters<
  ManagedShellPublisherRegistry['prepare']
>[0] & { capture: { background: true } };

function backgroundRequest(
  key: { tenantId: string; sessionId: string },
  generation: string,
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
  let record = parseChildRun(
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
  record = parseChildRun(
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
