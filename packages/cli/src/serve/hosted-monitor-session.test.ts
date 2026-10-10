/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import {
  LocalManagedSessionAuthority,
  type ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { managedExtensionRecordKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedMonitorSession,
  monitorRebuildAllowed,
} from './hosted-monitor-session.js';

// monitor_run is enabled by the H3 enablement slice; this suite drives the
// hosted orchestrator ahead of it, like the core authority suite does.
const enablement = vi.hoisted(() => ({ monitorRun: true }));

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
        if (domain !== 'monitor_run' || !enablement.monitorRun) {
          actual.assertManagedSessionDomainEnabled(domain);
        }
      },
    };
  },
);

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};
const TASK_ID = `task_${managedExtensionRecordKey(sessionId, 'monitor_run', 'monitor-1')}`;

function manifestBody(over: {
  revision: number;
  captureId?: string;
  executionCallId?: string;
  streamId?: string;
}): Buffer {
  const { streamId = 'stdout', ...body } = over;
  return Buffer.from(
    JSON.stringify({
      toolResult: 'managed-tool-result/1',
      type: 'manifest',
      tenantId: sessionKey.tenantId,
      sessionId,
      turnId: 'turn-1',
      executionCallId: 'call-monitor-1',
      callId: 'call-1',
      invocationDigest: 'sha256:' + 'a'.repeat(64),
      bindingGeneration: '1',
      captureId: 'capture-1',
      captureScope: 'process_pipes',
      capturePolicy: 'complete_required',
      captureStatus: 'pending',
      captureReason: null,
      upstreamTruncated: false,
      executionStatus: 'unknown',
      exitCode: null,
      signal: null,
      contents: [
        {
          streamId,
          role: 'stdout',
          mimeType: 'application/octet-stream',
          state: 'open',
          byteLength: 0,
          digest: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
          missingRanges: [],
          body: { pages: [] },
        },
      ],
      ...body,
    }),
    'utf8',
  );
}

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.monitorRun = true;
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

interface Harness {
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  readonly store: LocalManagedSessionResourceStore;
  now: number;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-monitor-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return {
    runtimeBaseDir,
    transcriptPath,
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
    now: 1_000,
  };
}

async function withOrchestrator<T>(
  harness: Harness,
  run: (
    authority: LocalManagedSessionAuthority,
    orchestrator: HostedMonitorSession,
  ) => Promise<T>,
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      now: () => harness.now,
      create: {
        definitionRef: await harness.store.publish(
          'managed-definition',
          Buffer.from('{}', 'utf8'),
        ),
        rootSnapshotRef: await harness.store.publish(
          'managed-root',
          Buffer.from('{}', 'utf8'),
        ),
        createdBy: 'daemon',
      },
    });
    const orchestrator = new HostedMonitorSession(
      { authority, resources: harness.store },
      sessionKey,
    );
    return await run(authority, orchestrator);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };
const ARGS = { command: 'du -sh .', periodMs: 1000 };

function admitCall(orchestrator: HostedMonitorSession, maxEvents = 100) {
  return orchestrator.admit({
    monitorId: 'monitor-1',
    ownerScopeId: 'scope-main',
    executionCallId: 'call-monitor-1',
    args: ARGS,
    maxEvents,
    idleTimeoutMs: 60_000,
    debounceMs: 1000,
  });
}

function committed(authority: LocalManagedSessionAuthority): {
  revision: number;
  body: ReturnType<typeof parseMonitorRun>;
} {
  const existing = authority.extensionRecord('monitor_run', 'monitor-1');
  if (!existing) throw new Error('No monitor_run record for monitor-1.');
  return {
    revision: existing.revision,
    body: parseMonitorRun(existing.record),
  };
}

describe('HostedMonitorSession', () => {
  it('commits the whole watch line through the authority funnel', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      const commandRef = await admitCall(orchestrator);
      expect(commandRef.kind).toBe('managed-tool-args');
      expect(
        JSON.parse((await harness.store.read(commandRef)).toString()),
      ).toEqual(ARGS);
      expect(committed(authority).revision).toBe(1);
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'monitor',
          state: 'pending',
          runtimeState: 'unbound',
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: null,
          settledAt: null,
        },
      ]);

      harness.now = 2_000;
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      expect(committed(authority).body.run).toMatchObject({
        state: 'admitted',
        execution: 'dispatch_started',
        runtime: BINDING,
      });

      harness.now = 3_000;
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      const attached = committed(authority);
      expect(attached.revision).toBe(3);
      expect(attached.body.startReceiptRef?.kind).toBe(
        'managed-runtime-receipt',
      );
      expect(attached.body.run).toMatchObject({
        state: 'running',
        execution: 'running_attached',
      });

      harness.now = 4_000;
      await orchestrator.observe('monitor-1', { size: 1024 });
      const observed = committed(authority);
      expect(observed.revision).toBe(4);
      expect(observed.body.observationSequence).toBe(1);
      expect(
        JSON.parse(
          (
            await harness.store.read(observed.body.lastObservationRef!)
          ).toString(),
        ),
      ).toEqual({ size: 1024 });

      harness.now = 5_000;
      await orchestrator.observe('monitor-1', { size: 2048 });
      expect(committed(authority).body.observationSequence).toBe(2);

      harness.now = 6_000;
      const manifest = await harness.store.publish(
        'managed-tool-result-manifest',
        manifestBody({ revision: 1 }),
      );
      await orchestrator.advanceOutput('monitor-1', manifest);
      expect(committed(authority).body.outputRef).toEqual(manifest);
      const manifestTwo = await harness.store.publish(
        'managed-tool-result-manifest',
        manifestBody({ revision: 2 }),
      );
      await orchestrator.advanceOutput('monitor-1', manifestTwo);
      expect(committed(authority).body.outputRef).toEqual(manifestTwo);
      // Output only ever advances forward: back to the older revision
      // refuses exactly, leaving nothing committed behind.
      await expect(
        orchestrator.advanceOutput('monitor-1', manifest),
      ).rejects.toThrow('lineage');
      expect(committed(authority).body.outputRef).toEqual(manifestTwo);
      // A replay of the very same reference is a no-op, not a refusal: a
      // redelivered advance must never wedge the watch's exit leg.
      const revisionBeforeReplay = committed(authority).revision;
      await orchestrator.advanceOutput('monitor-1', manifestTwo);
      expect(committed(authority).revision).toBe(revisionBeforeReplay);
      expect(committed(authority).body.outputRef).toEqual(manifestTwo);

      harness.now = 7_000;
      await orchestrator.settleQuiet('monitor-1', 'exited');
      const settled = committed(authority);
      expect(settled.body.run).toMatchObject({
        state: 'settled',
        execution: 'settled',
      });
      expect(settled.body.stopReason).toBe('exited');
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'monitor',
          state: 'completed',
          runtimeState: null,
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: 3_000,
          settledAt: 7_000,
        },
      ]);
    });
  });

  it('refuses output outside its capture lineage, higher numbers included', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      const publish = (body: Buffer) =>
        harness.store.publish('managed-tool-result-manifest', body);
      const rev1 = await publish(manifestBody({ revision: 1 }));
      await orchestrator.advanceOutput('monitor-1', rev1);
      // A higher number from another capture is a lineage break, never
      // progress: it would chain the record's view to bytes this capture
      // never wrote.
      const foreign = await publish(
        manifestBody({ revision: 2, captureId: 'capture-9' }),
      );
      await expect(
        orchestrator.advanceOutput('monitor-1', foreign),
      ).rejects.toThrow('lineage');
      // A jump the funnel missed once lands whole: the contents chain
      // already carries every skipped revision forward.
      const leapt = await publish(manifestBody({ revision: 3 }));
      await orchestrator.advanceOutput('monitor-1', leapt);
      expect(committed(authority).body.outputRef).toEqual(leapt);
      const backward = await publish(manifestBody({ revision: 2 }));
      await expect(
        orchestrator.advanceOutput('monitor-1', backward),
      ).rejects.toThrow('lineage');
      const brokenChain = await publish(
        manifestBody({ revision: 4, streamId: 'stderr' }),
      );
      await expect(
        orchestrator.advanceOutput('monitor-1', brokenChain),
      ).rejects.toThrow('lineage');
      // And no manifest ever anchors another call's capture onto this record.
      const elsewhere = await publish(
        manifestBody({ revision: 1, executionCallId: 'call-elsewhere' }),
      );
      await expect(
        orchestrator.advanceOutput('monitor-1', elsewhere),
      ).rejects.toThrow('another call');
    });
  });

  it('commits each settled, failed and cancelled terminal shape', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      // max_events settles exactly when the quota of observations arrives.
      await admitCall(orchestrator, 2);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      await orchestrator.observe('monitor-1', { size: 1 });
      await expect(
        orchestrator.settleQuiet('monitor-1', 'max_events'),
      ).rejects.toThrow(ManagedSessionRecordError);
      await orchestrator.observe('monitor-1', { size: 2 });
      await orchestrator.settleQuiet('monitor-1', 'max_events');
      expect(committed(authority).body).toMatchObject({
        observationSequence: 2,
        stopReason: 'max_events',
        run: { state: 'settled', execution: 'settled' },
      });
    });

    const second = await createHarness();
    await withOrchestrator(second, async (authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      await orchestrator.settleQuiet('monitor-1', 'idle_timeout');
      expect(committed(authority).body).toMatchObject({
        stopReason: 'idle_timeout',
        run: { state: 'settled', execution: 'settled' },
      });
    });
  });

  it('advances the watermark only when a notification rides the revision', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      const input: ManagedSessionInputRequest = {
        inputId: 'monitor-1:notify:1',
        turnId: 'monitor-1:notify:1',
        source: 'monitor',
        contentRef: await harness.store.publish(
          'managed-input',
          Buffer.from('{"text":"changed"}', 'utf8'),
        ),
        deadline: null,
        admissionRef: await harness.store.publish(
          'managed-admission',
          Buffer.from('{}', 'utf8'),
        ),
        wakeReason: 'input',
      };
      await orchestrator.observe('monitor-1', { size: 1 }, { input });
      expect(committed(authority).body).toMatchObject({
        observationSequence: 1,
        notifiedThrough: 1,
      });
      expect(
        authority
          .readEvents()
          .slice(-3)
          .map((event) => event.kind),
      ).toEqual(['domain.committed', 'input.accepted', 'wake.requested']);

      await orchestrator.observe('monitor-1', { size: 2 });
      expect(committed(authority).body).toMatchObject({
        observationSequence: 2,
        notifiedThrough: 1,
      });
    });
  });

  it('commits a start failure on not_started_proven and a watch failure settled', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.settleFailed('monitor-1', {
        stopReason: 'start_failed',
        started: false,
      });
      expect(committed(authority).body).toMatchObject({
        startReceiptRef: null,
        stopReason: 'start_failed',
        run: { state: 'failed', execution: 'not_started_proven' },
      });
    });

    const second = await createHarness();
    await withOrchestrator(second, async (authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      await orchestrator.settleFailed('monitor-1', {
        stopReason: 'watch_failed',
        started: true,
      });
      expect(committed(authority).body).toMatchObject({
        stopReason: 'watch_failed',
        run: { state: 'failed', execution: 'settled' },
      });
    });
  });

  it('commits a stop request as cancelled and refuses a second receipt', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      await expect(
        orchestrator.attach('monitor-1', BINDING, { watch: 'again' }),
      ).rejects.toThrow(ManagedSessionRecordError);
      await orchestrator.settleStopRequested('monitor-1');
      expect(committed(authority).body).toMatchObject({
        stopReason: 'stop_requested',
        run: { state: 'cancelled', execution: 'settled' },
      });
    });
  });

  it('commits a recovery-blocked state and rebuilds with a new receipt', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      await orchestrator.observe('monitor-1', { size: 1024 });
      const attached = committed(authority).body;

      await orchestrator.blockedRuntimeLost('monitor-1');
      const blocked = committed(authority).body;
      expect(blocked).toMatchObject({
        run: {
          state: 'recovery_blocked',
          reason: 'runtime_lost',
          execution: 'outcome_unknown',
          runtime: BINDING,
        },
      });

      const rebuildBinding = { runtimeBindingId: 'binding-2', generation: '2' };
      await orchestrator.rebuildFromRuntimeLost('monitor-1', rebuildBinding, {
        watch: 'restarted',
      });
      const rebuilt = committed(authority).body;
      expect(rebuilt.run).toMatchObject({
        state: 'running',
        reason: 'runtime_lost',
        execution: 'running_attached',
        runtime: rebuildBinding,
      });
      // The watermark survived the rebuild; only the receipt was reminted.
      expect(rebuilt.observationSequence).toBe(1);
      expect(rebuilt.lastObservationRef).toEqual(attached.lastObservationRef);
      expect(rebuilt.startReceiptRef).not.toEqual(attached.startReceiptRef);
      expect(rebuilt.startReceiptRef?.kind).toBe('managed-runtime-receipt');
    });
  });

  it('refuses a rebuild from a watch that never lost its Runtime', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (_authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      await expect(
        orchestrator.rebuildFromRuntimeLost('monitor-1', BINDING, {
          watch: 'restarted',
        }),
      ).rejects.toThrow('cannot rebuild from its current state');
    });
  });

  it('refuses a rebuild after the run ended', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (_authority, orchestrator) => {
      await admitCall(orchestrator);
      await orchestrator.dispatchStarted('monitor-1', BINDING);
      await orchestrator.attach('monitor-1', BINDING, { watch: 'started' });
      await orchestrator.settleQuiet('monitor-1', 'exited');
      await expect(
        orchestrator.rebuildFromRuntimeLost('monitor-1', BINDING, {
          watch: 'restarted',
        }),
      ).rejects.toThrow('cannot rebuild from its current state');
    });
  });

  it('permits only a known read-only command to be rebuilt', async () => {
    expect(await monitorRebuildAllowed('du -sh .', os.tmpdir())).toBe(true);
    expect(await monitorRebuildAllowed('pwd && ls -la', os.tmpdir())).toBe(
      true,
    );
    expect(await monitorRebuildAllowed('rm -rf nowhere', os.tmpdir())).toBe(
      false,
    );
    expect(await monitorRebuildAllowed('', os.tmpdir())).toBe(false);
  });
});
