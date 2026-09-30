/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedHarnessHandle } from './managed-harness-factory.js';
import {
  createNextTurnReadyHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import { openManagedSession } from './managed-session-assembly.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalToolResultSegmentStore } from './local-managed-tool-result-store.js';
import { LocalShellResultSession } from './local-shell-result-session.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import type {
  ToolResultExpectedIdentity,
  ToolResultSegmentStore,
} from './managed-tool-result-store.js';

const sessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
};
const argsDigest = createHash('sha256')
  .update('{"command":"printf hello"}')
  .digest('hex');
const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

describe('local Shell result Session receipt', () => {
  it('commits 100 MiB once and reopens its original tail in another process', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-shell-session-'),
    );
    roots.add(root);
    const runtimeBaseDir = path.join(root, 'runtime');
    const transcriptPath = path.join(
      runtimeBaseDir,
      'chats',
      'session-a.jsonl',
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir,
      sessionId: sessionKey.sessionId,
      transcriptPath,
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
      create: {
        definitionRef: await resource('definition'),
        rootSnapshotRef: await resource('root'),
        createdBy: 'test',
      },
    });
    const store = await LocalToolResultSegmentStore.openWritable({
      lease,
      sessionKey,
    });
    let manifestRef: ManagedSessionDurableRef | null = null;
    let capturedIdentity: ToolResultExpectedIdentity | null = null;
    try {
      const harness = createManagedHarnessHandle(session);
      await harness.ensureRunnable();
      const turnResult = await session.resources.publish(
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
          state: (identity, previous) =>
            encodeHarnessCheckpointV1(
              createNextTurnReadyHarnessCheckpoint({
                previous,
                ...identity,
                activationId: session.activation.activationId,
                turnId: 'turn-a',
                promptId: 'prompt-a',
              }),
            ),
        },
        { class: 'harness', activation: session.activation },
      );
      const definitionRef = await session.resources.publish(
        'managed-tool-definition',
        Buffer.from('{}'),
      );
      const argsRef = await session.resources.publish(
        'managed-tool-args',
        Buffer.from('{"command":"printf hello"}'),
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
        routeRef: await session.resources.publish(
          'managed-route',
          Buffer.from('{}'),
        ),
      });
      const coordinator = new LocalShellResultSession(
        session,
        store,
        '1',
        lease,
        'runtime-session-a',
      );
      const captureRequest = {
        reference: {
          sessionId: 'runtime-session-a',
          promptId: 'prompt-a',
          callId: 'call-a',
          argsDigest: `sha256:${argsDigest}`,
        },
        capture: {
          tenantId: 'tenant-a',
          sessionId: 'session-a',
          turnId: 'turn-a',
          executionCallId: 'execution-a',
          bindingGeneration: '1',
          capturePolicy: 'complete_required',
        },
      } as const;
      await expect(
        coordinator.prepare({
          ...captureRequest,
          reference: {
            ...captureRequest.reference,
            sessionId: 'another-runtime-session',
          },
        }),
      ).rejects.toThrow(/Session or binding/);
      const { identity, sink } = await coordinator.prepare(captureRequest);
      capturedIdentity = identity;
      sink.setStarted(42);
      const unit = Buffer.alloc(1024 * 1024, 0x91);
      for (let index = 0; index < 100; index++) {
        await sink.write('stdout', unit);
      }
      await sink.finish('stdout', true);
      await sink.finish('stderr', true);
      sink.setProcessResult({
        rawOutput: Buffer.from('hello'),
        output: 'hello',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 42,
        executionMethod: 'child_process',
      });
      const envelope = await sink.finalize('success', ['hello']);
      manifestRef = envelope.capture?.manifest ?? null;
      const unsealedStore: ToolResultSegmentStore = {
        publish: (request) => store.publish(request),
        seal: (request) => store.seal(request),
        prefix: async (request) => {
          const result = await store.prefix(request);
          return result.status === 'ok'
            ? { status: 'ok', result: { ...result.result, sealed: false } }
            : result;
        },
        readRange: (request) => store.readRange(request),
        close: () => store.close(),
      };
      const unsealed = new LocalShellResultSession(
        session,
        unsealedStore,
        '1',
        lease,
        'runtime-session-a',
      );
      await unsealed.prepare(captureRequest);
      await expect(unsealed.accept(identity, envelope)).rejects.toThrow(
        /not sealed/,
      );
      const coordinatorHarness = Reflect.get(
        coordinator,
        'harness',
      ) as ReturnType<typeof createManagedHarnessHandle>;
      const checkpointFailure = vi
        .spyOn(coordinatorHarness, 'resolveAwaitRuntime')
        .mockRejectedValueOnce(new Error('checkpoint write failed'));
      await expect(coordinator.accept(identity, envelope)).rejects.toThrow(
        /checkpoint write failed/,
      );
      checkpointFailure.mockRestore();
      expect(
        parseHarnessCheckpointV1(
          (await session.authority.readCheckpointState())!,
        ).continuation.phase,
      ).toBe('await_runtime');
      const recorded = await coordinator.recorded(identity);
      expect(recorded?.deliveryStatus).toBe('committed');
      const receipt = await coordinator.recover(identity);
      if (!receipt) throw new Error('Committed Shell receipt disappeared.');
      expect(receipt).toEqual(recorded);
      expect(receipt.deliveryStatus).toBe('committed');
      expect(receipt.historyRevision).toBeGreaterThan(0);
      expect(
        parseHarnessCheckpointV1(
          (await session.authority.readCheckpointState())!,
        ).continuation.phase,
      ).toBe('results_ready');
      expect(await coordinator.accept(identity, envelope)).toEqual(receipt);
      await expect(
        coordinator.accept(identity, {
          ...envelope,
          responseParts: ['changed'],
        }),
      ).rejects.toThrow(/conflicts/);
    } finally {
      await store.close();
      await session.close();
      await session.releaseActivation();
      await session.authority.close();
    }
    expect(manifestRef).not.toBeNull();
    expect(capturedIdentity).not.toBeNull();
    const helper = fileURLToPath(
      new URL('./local-shell-result-session.test-helper.ts', import.meta.url),
    );
    const child = fork(helper, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      const answer = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('reader timed out')),
          15_000,
        );
        child.once('message', (message) => {
          clearTimeout(timeout);
          resolve(message);
        });
        child.once('error', reject);
        child.send({
          runtimeBaseDir,
          sessionKey,
          manifestRef,
          identity: capturedIdentity,
          length: 100 * 1024 * 1024,
        });
      });
      expect(answer).toEqual({
        status: 'ok',
        base64: Buffer.alloc(5, 0x91).toString('base64'),
      });
    } finally {
      child.kill();
    }
  }, 120_000);
});

function command(operation: string, commandId: string) {
  return {
    operation,
    commandId,
    sessionKey,
    contentDigest: '9'.repeat(64),
  };
}

async function resource(kind: string) {
  return {
    resourceId: `resource-${kind}`,
    kind,
    schemaVersion: 1,
    byteLength: 0,
    digest: createHash('sha256').update('').digest('hex'),
  };
}
