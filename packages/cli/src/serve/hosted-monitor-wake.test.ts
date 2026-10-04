/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import {
  HostedMonitorWakeScheduler,
  settlePendingMonitorInputs,
  type HostedMonitorWakeTurn,
} from './hosted-monitor-wake.js';

// monitor_run is enabled by the H3 enablement slice; the close-side settle
// rig commits a notification input ahead of it, like the funnel suite does.
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
        if (domain !== 'monitor_run') {
          actual.assertManagedSessionDomainEnabled(domain);
        }
      },
    };
  },
);

async function poll(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('poll timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('HostedMonitorWakeScheduler', () => {
  it('delivers pending turns oldest first until the Set drains', async () => {
    const queue: HostedMonitorWakeTurn[] = [
      {
        turnId: 'm:notify:1',
        text: '<task-notification>1</task-notification>',
      },
      {
        turnId: 'm:notify:2',
        text: '<task-notification>2</task-notification>',
      },
    ];
    const ran: string[] = [];
    const scheduler = new HostedMonitorWakeScheduler({
      next: async () => queue[0],
      state: () => 'idle',
      runTurn: async (turn) => {
        ran.push(turn.turnId);
        queue.shift();
        return 'settled';
      },
      failed: (cause) => {
        throw cause instanceof Error ? cause : new Error(String(cause));
      },
    });
    scheduler.kick();
    await poll(() => queue.length === 0);
    expect(ran).toEqual(['m:notify:1', 'm:notify:2']);
    scheduler.close();
  });

  it('queues on a busy Session and the retry delivers once idle', async () => {
    const queue: HostedMonitorWakeTurn[] = [{ turnId: 'm:1', text: 'x' }];
    let busy = true;
    const ran: string[] = [];
    const scheduler = new HostedMonitorWakeScheduler(
      {
        next: async () => queue[0],
        state: () => (busy ? 'busy' : 'idle'),
        runTurn: async (turn) => {
          ran.push(turn.turnId);
          queue.shift();
          return 'settled';
        },
        failed: () => {
          throw new Error('pump must not fail here');
        },
      },
      10,
    );
    scheduler.kick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
    busy = false;
    await poll(() => ran.length === 1);
    expect(ran).toEqual(['m:1']);
    scheduler.close();
  });

  it('treats a runTurn busy answer like a busy state and retries', async () => {
    const queue: HostedMonitorWakeTurn[] = [{ turnId: 'm:1', text: 'x' }];
    let contend = true;
    const ran: string[] = [];
    const scheduler = new HostedMonitorWakeScheduler(
      {
        next: async () => queue[0],
        state: () => 'idle',
        runTurn: async (turn) => {
          if (contend) return 'busy';
          ran.push(turn.turnId);
          queue.shift();
          return 'settled';
        },
        failed: () => {
          throw new Error('pump must not fail here');
        },
      },
      10,
    );
    scheduler.kick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
    contend = false;
    await poll(() => ran.length === 1);
    scheduler.close();
  });

  it('leaves a blocked Session’s remainder pending', async () => {
    const queue: HostedMonitorWakeTurn[] = [{ turnId: 'm:1', text: 'x' }];
    const ran: string[] = [];
    const scheduler = new HostedMonitorWakeScheduler({
      next: async () => queue[0],
      state: () => 'blocked',
      runTurn: async (turn) => {
        ran.push(turn.turnId);
        return 'settled';
      },
      failed: () => {
        throw new Error('pump must not fail here');
      },
    });
    scheduler.kick();
    scheduler.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
    expect(queue).toHaveLength(1);
  });

  it('fails the owner when a turn did not consume its input', async () => {
    const queue: HostedMonitorWakeTurn[] = [{ turnId: 'm:1', text: 'x' }];
    const failures: unknown[] = [];
    const scheduler = new HostedMonitorWakeScheduler(
      {
        next: async () => queue[0],
        state: () => 'idle',
        runTurn: async () => 'settled',
        failed: (cause) => failures.push(cause),
      },
      10,
    );
    scheduler.kick();
    await poll(() => failures.length === 1);
    expect(String(failures[0])).toContain('m:1');
    scheduler.close();
  });

  it('stops retrying once closed', async () => {
    const queue: HostedMonitorWakeTurn[] = [{ turnId: 'm:1', text: 'x' }];
    const ran: string[] = [];
    const scheduler = new HostedMonitorWakeScheduler(
      {
        next: async () => queue[0],
        state: () => 'busy',
        runTurn: async (turn) => {
          ran.push(turn.turnId);
          return 'settled';
        },
        failed: () => {
          throw new Error('pump must not fail here');
        },
      },
      10,
    );
    scheduler.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    scheduler.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toEqual([]);
  });
});

describe('settlePendingMonitorInputs', () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const sessionKey = {
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    sessionId,
  };
  const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };
  const temporaryDirectories = new Set<string>();

  afterEach(async () => {
    for (const directory of temporaryDirectories) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    temporaryDirectories.clear();
  });

  it('settles pending monitor notifications cancelled and leaves other inputs pending', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-hosted-wake-settle-'),
    );
    temporaryDirectories.add(root);
    const runtimeBaseDir = path.join(root, 'runtime');
    const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
    await fs.mkdir(runtimeBaseDir, { recursive: true });
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId,
      transcriptPath,
    });
    try {
      const resourceStore = LocalManagedSessionResourceStore.create({
        runtimeBaseDir,
        sessionKey,
      });
      const session = await openManagedSession({
        runtimeBaseDir,
        sessionId,
        transcriptPath,
        sessionKey,
        cwd: '/workspace',
        version: 'test',
        workerId: 'worker-test',
        activationLeaseDurationMs: 60_000,
        lease,
        resourceStore,
        create: {
          definitionRef: await resourceStore.publish(
            'managed-definition',
            Buffer.from('{}', 'utf8'),
          ),
          rootSnapshotRef: await resourceStore.publish(
            'managed-root',
            Buffer.from('{}', 'utf8'),
          ),
          createdBy: 'test',
        },
      });
      const authority = session.authority;
      const store = session.resources;
      const monitors = new HostedMonitorSession(
        { authority, resources: store },
        sessionKey,
      );
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: 'scope-main',
        executionCallId: 'call-1',
        args: { command: 'du -sh .' },
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1000,
      });
      await monitors.dispatchStarted('monitor-1', BINDING);
      await monitors.attach('monitor-1', BINDING, { watch: 'started' });
      await monitors.observe(
        'monitor-1',
        { lines: ['one'] },
        {
          input: {
            inputId: 'monitor-1:notify:1',
            turnId: 'monitor-1:notify:1',
            source: 'monitor',
            contentRef: await store.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            deadline: null,
            admissionRef: await store.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            wakeReason: 'input',
          },
        },
      );
      await authority.submitInput(
        {
          operation: 'submitInput',
          commandId: 'prompt-1',
          sessionKey,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: 'prompt-1',
          turnId: 'prompt-1',
          source: 'hosted-harness',
          contentRef: await store.publish(
            'managed-input',
            Buffer.from('[{"type":"text","text":"hi"}]', 'utf8'),
          ),
          admissionRef: await store.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      expect(
        pendingSessionInputs(authority.readEvents()).map((i) => i.turnId),
      ).toEqual(['monitor-1:notify:1', 'prompt-1']);

      const settled = await settlePendingMonitorInputs({
        authority,
        sink: session.sink,
        sessionId,
        cwd: '/workspace',
      });
      expect(settled).toBe(1);
      const settledEvents = authority
        .readEvents()
        .filter((event) => event.kind === 'turn.settled');
      expect(settledEvents).toHaveLength(1);
      expect(settledEvents[0].payload).toMatchObject({
        turnId: 'monitor-1:notify:1',
        outcome: 'cancelled',
        stopReason: 'session_closing',
      });
      expect(
        pendingSessionInputs(authority.readEvents()).map((i) => i.turnId),
      ).toEqual(['prompt-1']);
    } finally {
      await lease.release().catch(() => undefined);
    }
  });
});
