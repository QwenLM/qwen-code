/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  MonitorWakeTransientReadError,
  settlePendingMonitorInputs,
} from './hosted-monitor-wake.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import {
  enqueueHostedWakeContinuation,
  hostedWakeContinuationId,
  readHostedWakeContinuation,
} from './hosted-wake-continuation.js';

describe('durable wake continuation', () => {
  let root: string;
  let managed: Awaited<ReturnType<typeof openManagedSession>>;
  const sessionId = randomUUID();
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId,
  };
  const notification = 'member-1:accept:notify';

  async function open(create = false) {
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey,
    });
    return openManagedSession({
      runtimeBaseDir: root,
      transcriptPath: path.join(root, `${sessionId}.jsonl`),
      sessionId,
      sessionKey,
      cwd: root,
      version: 'test',
      workerId: randomUUID(),
      activationLeaseDurationMs: 60_000,
      resourceStore: resources,
      ...(create
        ? {
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
          }
        : {}),
    });
  }

  async function admit(source = 'child_agent') {
    await managed.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: notification,
        sessionKey,
        contentDigest: 'a'.repeat(64),
      },
      {
        inputId: notification,
        turnId: notification,
        source,
        contentRef: await managed.resources.publish(
          'managed-input',
          Buffer.from(JSON.stringify({ text: 'alice finished the review' })),
        ),
        admissionRef: await managed.resources.publish(
          'managed-admission',
          Buffer.from('{}'),
        ),
        deadline: null,
        wakeReason: 'input',
      },
    );
  }

  function pending() {
    return pendingSessionInputs(
      managed.authority.eventsInSequenceRange(
        1,
        managed.authority.committedSequence,
      ),
    ).map((input) => input.turnId);
  }

  async function settle(
    turnId: string,
    state: 'error' | 'completed' = 'error',
  ) {
    await managed.sink.write({
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      cwd: root,
      version: 'test',
      subtype: 'turn_result',
      systemPayload: {
        promptId: turnId,
        state,
        stopReason: state,
        endedAt: Date.now(),
      },
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qwen-wake-continuation-'));
    managed = await open(true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await managed.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['monitor', 'child_agent', 'workflow'])(
    'survives a restart between admission and settlement (%s)',
    async (source) => {
      await admit(source);
      const continuation = hostedWakeContinuationId(notification);
      await enqueueHostedWakeContinuation(managed, notification);
      expect(pending()).toEqual([notification, continuation]);
      await managed.close();
      managed = await open();
      const before = managed.authority.committedSequence;
      expect(await enqueueHostedWakeContinuation(managed, notification)).toBe(
        continuation,
      );
      expect(managed.authority.committedSequence).toBe(before);
      await settle(notification);
      expect(pending()).toEqual([continuation]);
      const turn = await readHostedWakeContinuation(managed, continuation);
      expect(turn.notificationTurnId).toBe(notification);
      expect(turn.text).toContain('alice finished the review');
      expect(turn.text).toContain('Do not repeat completed operations');
      await settle(continuation, 'completed');
      await managed.close();
      managed = await open();
      expect(pending()).toEqual([]);
      expect(await managed.sink.project()).toEqual([]);
    },
  );

  it('keeps the original input owed when follow-up admission fails', async () => {
    await admit();
    vi.spyOn(managed.authority, 'submitInput').mockRejectedValueOnce(
      new Error('store unavailable'),
    );
    await expect(
      enqueueHostedWakeContinuation(managed, notification),
    ).rejects.toThrow('store unavailable');
    expect(pending()).toEqual([notification]);
    await enqueueHostedWakeContinuation(managed, notification);
    expect(pending()).toEqual([
      notification,
      hostedWakeContinuationId(notification),
    ]);
  });

  it('keeps the root notification and bounded text across repeated interruptions', async () => {
    await admit();
    const first = (await enqueueHostedWakeContinuation(managed, notification))!;
    await settle(notification);
    const second = (await enqueueHostedWakeContinuation(managed, first))!;
    await settle(first);
    expect(second).not.toBe(first);
    expect(second.length).toBe(first.length);
    expect(await readHostedWakeContinuation(managed, second)).toEqual(
      await readHostedWakeContinuation(managed, first),
    );
    expect(pending()).toEqual([second]);
  });

  it.each(['channel', 'automation', 'session_message', 'hosted-harness'])(
    'preserves the source recovery policy (%s)',
    async (source) => {
      await admit(source);
      expect(
        await enqueueHostedWakeContinuation(managed, notification),
      ).toBeUndefined();
      expect(pending()).toEqual([notification]);
    },
  );

  it('uses the wake read retry for unavailable original context', async () => {
    await admit();
    const turnId = (await enqueueHostedWakeContinuation(
      managed,
      notification,
    ))!;
    const read = managed.resources.read.bind(managed.resources);
    let reads = 0;
    vi.spyOn(managed.resources, 'read').mockImplementation(async (ref) => {
      if (++reads === 2) throw new Error('temporary context read failure');
      return read(ref);
    });
    await expect(
      readHostedWakeContinuation(managed, turnId),
    ).rejects.toBeInstanceOf(MonitorWakeTransientReadError);
    expect(pending()).toEqual([notification, turnId]);
  });

  it('cancels queued continuations model-free on close', async () => {
    await admit();
    await enqueueHostedWakeContinuation(managed, notification);
    await settle(notification);
    expect(
      await settlePendingMonitorInputs({
        authority: managed.authority,
        sink: managed.sink,
        sessionId,
        cwd: root,
      }),
    ).toBe(1);
    expect(pending()).toEqual([]);
  });
});
