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
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { managedExtensionRecordKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import { parseChildShellRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';

// child_run is enabled by the H3 enablement slice; this suite drives the
// hosted orchestrator ahead of it, like the core authority suite does.
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

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};
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
      executionCallId: 'call-shell-1',
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
const TASK_ID = `task_${managedExtensionRecordKey(sessionId, 'child_run', 'shell-1')}`;

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.childRun = true;
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-child-'));
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
    orchestrator: HostedChildRunSession,
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
    const orchestrator = new HostedChildRunSession(
      { authority, resources: harness.store },
      sessionKey,
    );
    return await run(authority, orchestrator);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };
const ARGS = { command: 'yes', is_background: true };

function committed(
  authority: LocalManagedSessionAuthority,
  shellId = 'shell-1',
): { revision: number; body: ReturnType<typeof parseChildShellRun> } {
  const existing = authority.extensionRecord('child_run', shellId);
  if (!existing) throw new Error(`No child_run record for ${shellId}.`);
  return {
    revision: existing.revision,
    body: parseChildShellRun(existing.record),
  };
}

describe('HostedChildRunSession', () => {
  it('commits the whole shell line through the authority funnel', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      const commandRef = await orchestrator.admit({
        shellId: 'shell-1',
        ownerScopeId: 'scope-main',
        executionCallId: 'call-shell-1',
        args: ARGS,
      });
      expect(commandRef.kind).toBe('managed-tool-args');
      expect(
        JSON.parse((await harness.store.read(commandRef)).toString()),
      ).toEqual(ARGS);
      expect(committed(authority).revision).toBe(1);
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'background_shell',
          state: 'pending',
          runtimeState: 'unbound',
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: null,
          settledAt: null,
        },
      ]);

      harness.now = 2_000;
      await orchestrator.dispatchStarted('shell-1', BINDING);
      expect(committed(authority).body.run).toMatchObject({
        state: 'running',
        execution: 'dispatch_started',
        runtime: BINDING,
      });

      harness.now = 3_000;
      await orchestrator.attach('shell-1', BINDING, { pid: 4242 });
      const attached = committed(authority);
      expect(attached.revision).toBe(3);
      expect(attached.body.startReceiptRef?.kind).toBe(
        'managed-runtime-receipt',
      );
      expect(
        JSON.parse(
          (await harness.store.read(attached.body.startReceiptRef!)).toString(),
        ),
      ).toEqual({ pid: 4242 });
      expect(attached.body.run).toMatchObject({
        state: 'running',
        execution: 'running_attached',
      });

      harness.now = 4_000;
      const manifestA = await harness.store.publish(
        'managed-tool-result-manifest',
        manifestBody({ revision: 1 }),
      );
      const manifestB = await harness.store.publish(
        'managed-tool-result-manifest',
        manifestBody({ revision: 2 }),
      );
      await orchestrator.advanceOutput('shell-1', manifestA);
      await orchestrator.advanceOutput('shell-1', manifestB);
      const advanced = committed(authority);
      expect(advanced.revision).toBe(5);
      expect(advanced.body.outputRef).toEqual(manifestB);
      await expect(
        orchestrator.advanceOutput('shell-1', manifestA),
      ).rejects.toThrow('lineage');
      expect(committed(authority).body.outputRef).toEqual(manifestB);
      // A replay of the very same reference is not a refusal and commits
      // nothing: a redelivered advance must never wedge the Shell's exit
      // leg, and since it changes no field, the deep-equal skip owns it.
      await orchestrator.advanceOutput('shell-1', manifestB);
      expect(committed(authority).body.outputRef).toEqual(manifestB);
      expect(committed(authority).revision).toBe(5);
      // The live run line holds its state through every advance of a
      // running process — the projection's `waiting` means paused, never
      // "the second revision".
      expect(advanced.body.run.state).toBe('running');

      harness.now = 5_000;
      await orchestrator.settleExited('shell-1', {
        exitCode: 0,
        exitSignal: null,
      });
      const settled = committed(authority);
      expect(settled.revision).toBe(6);
      expect(settled.body).toMatchObject({
        stopReason: 'exited',
        exitCode: 0,
        stopRequested: false,
        commandRef,
        outputRef: manifestB,
      });
      expect(settled.body.run).toMatchObject({
        state: 'settled',
        execution: 'settled',
      });
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'background_shell',
          state: 'completed',
          runtimeState: null,
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: 2_000,
          settledAt: 5_000,
        },
      ]);

      // A replayed advance landing after the exit leg is the
      // replay-after-restart shape: it may resend the same manifest, but it
      // must never step the terminal run line back to live.
      await orchestrator.advanceOutput('shell-1', manifestB);
      const replayed = committed(authority);
      expect(replayed.body.outputRef).toEqual(manifestB);
      expect(replayed.body.run).toMatchObject({
        state: 'settled',
        execution: 'settled',
      });
    });
  });

  it('refuses output outside its capture lineage, higher numbers included', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await orchestrator.admit({
        shellId: 'shell-1',
        ownerScopeId: 'scope-main',
        executionCallId: 'call-shell-1',
        args: ARGS,
      });
      await orchestrator.dispatchStarted('shell-1', BINDING);
      await orchestrator.attach('shell-1', BINDING, { pid: 4242 });
      const publish = (body: Buffer) =>
        harness.store.publish('managed-tool-result-manifest', body);
      const rev1 = await publish(manifestBody({ revision: 1 }));
      await orchestrator.advanceOutput('shell-1', rev1);
      // A higher number from another capture is a lineage break, never
      // progress: it would chain the record's view to bytes this capture
      // never wrote.
      const foreign = await publish(
        manifestBody({ revision: 2, captureId: 'capture-9' }),
      );
      await expect(
        orchestrator.advanceOutput('shell-1', foreign),
      ).rejects.toThrow('lineage');
      // A jump the funnel missed once lands whole: the contents chain
      // already carries every skipped revision forward.
      const leapt = await publish(manifestBody({ revision: 3 }));
      await orchestrator.advanceOutput('shell-1', leapt);
      expect(committed(authority).body.outputRef).toEqual(leapt);
      const backward = await publish(manifestBody({ revision: 2 }));
      await expect(
        orchestrator.advanceOutput('shell-1', backward),
      ).rejects.toThrow('lineage');
      const brokenChain = await publish(
        manifestBody({ revision: 4, streamId: 'stderr' }),
      );
      await expect(
        orchestrator.advanceOutput('shell-1', brokenChain),
      ).rejects.toThrow('lineage');
      // And no manifest ever anchors another call's capture onto this record.
      const elsewhere = await publish(
        manifestBody({ revision: 1, executionCallId: 'call-elsewhere' }),
      );
      await expect(
        orchestrator.advanceOutput('shell-1', elsewhere),
      ).rejects.toThrow('another call');
    });
  });

  it('records a stop request exactly once and settles it as cancelled', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await orchestrator.admit({
        shellId: 'shell-1',
        ownerScopeId: 'scope-main',
        executionCallId: 'call-shell-1',
        args: ARGS,
      });
      await orchestrator.dispatchStarted('shell-1', BINDING);
      await orchestrator.attach('shell-1', BINDING, { pid: 7 });
      await orchestrator.requestStop('shell-1');
      const draining = committed(authority);
      expect(draining.body.stopRequested).toBe(true);
      expect(draining.body.run.state).toBe('running');
      await orchestrator.settleStopRequested('shell-1');
      expect(committed(authority).body).toMatchObject({
        stopReason: 'stop_requested',
        stopRequested: true,
        exitCode: null,
        run: { state: 'cancelled', execution: 'settled' },
      });
    });
  });

  it('settles a pre-start failure on not_started_proven and freezes it', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await orchestrator.admit({
        shellId: 'shell-1',
        ownerScopeId: 'scope-main',
        executionCallId: 'call-shell-1',
        args: ARGS,
      });
      await orchestrator.settleFailed('shell-1', {
        stopReason: 'start_failed',
        started: false,
      });
      const failed = committed(authority);
      expect(failed.body).toMatchObject({
        stopReason: 'start_failed',
        startReceiptRef: null,
      });
      expect(failed.body.run).toMatchObject({
        state: 'failed',
        execution: 'not_started_proven',
      });
      // The terminal freeze survives the funnel: a later step is refused.
      await expect(
        orchestrator.dispatchStarted('shell-1', BINDING),
      ).rejects.toThrow(/stopReason|must follow|successor|revision/);
    });
  });

  it('serializes unawaited steps and skips deep-equal revisions', async () => {
    const harness = await createHarness();
    await withOrchestrator(harness, async (authority, orchestrator) => {
      await orchestrator.admit({
        shellId: 'shell-1',
        ownerScopeId: 'scope-main',
        executionCallId: 'call-shell-1',
        args: ARGS,
      });
      const dispatches = [
        orchestrator.dispatchStarted('shell-1', BINDING),
        orchestrator.dispatchStarted('shell-1', BINDING),
      ];
      await Promise.all(dispatches);
      // The second dispatch is byte-identical, so the funnel skips it.
      expect(committed(authority).revision).toBe(2);
      const attach = orchestrator.attach('shell-1', BINDING, { pid: 9 });
      const stop = orchestrator.requestStop('shell-1');
      const settle = orchestrator.settleStopRequested('shell-1');
      await Promise.all([attach, stop, settle]);
      const settled = committed(authority);
      expect(settled.revision).toBe(5);
      expect(settled.body.run).toMatchObject({
        state: 'cancelled',
        execution: 'settled',
      });
    });
  });
});
