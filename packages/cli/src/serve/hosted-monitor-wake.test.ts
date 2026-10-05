/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { MANAGED_SESSION_LIMITS } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import {
  HostedMonitorWakeScheduler,
  settlePendingMonitorInputs,
  wakeHasPriorAttempt,
  type HostedMonitorWakeTurn,
} from './hosted-monitor-wake.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  createMonitorWakeRunTurn,
  monitorWakeNeedsRecovery as needsRecovery,
  type MonitorWakeTurnSession,
} from './hosted-monitor-wake-turn.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';
import { HostedMcpRecoveryRequiredError } from './hosted-mcp-session.js';
import { HostedHookRecoveryRequiredError } from './hosted-hook-session.js';

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

  it('retries a transiently blocked Session once it clears', async () => {
    const queue: HostedMonitorWakeTurn[] = [{ turnId: 'm:1', text: 'x' }];
    let blocked = true;
    const ran: string[] = [];
    const scheduler = new HostedMonitorWakeScheduler(
      {
        next: async () => queue[0],
        state: () => (blocked ? 'blocked' : 'idle'),
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
    expect(queue).toHaveLength(1);
    blocked = false;
    await poll(() => ran.length === 1);
    expect(ran).toEqual(['m:1']);
    scheduler.close();
  });

  it('a kick that lands mid-pump runs the turn that arrived with it', async () => {
    const queue: HostedMonitorWakeTurn[] = [{ turnId: 'm:1', text: 'x' }];
    const ran: string[] = [];
    let reads = 0;
    const scheduler = new HostedMonitorWakeScheduler({
      next: async () => {
        reads += 1;
        if (reads === 2) {
          // The notification commits while this pump's again-read runs:
          // without remembering it, the pump exits with the turn unseen.
          queue.push({ turnId: 'm:2', text: 'y' });
          scheduler.kick();
          return undefined;
        }
        return queue[0];
      },
      state: () => 'idle',
      runTurn: async (turn) => {
        ran.push(turn.turnId);
        queue.shift();
        return 'settled';
      },
      failed: () => {
        throw new Error('pump must not fail here');
      },
    });
    scheduler.kick();
    await poll(() => ran.length === 2);
    expect(ran).toEqual(['m:1', 'm:2']);
    scheduler.close();
  });
});

describe('wakeHasPriorAttempt', () => {
  it('knows an attempt by its wake turn id', () => {
    expect(wakeHasPriorAttempt([{ daemonPromptId: 'm:1' }], 'm:1')).toBe(true);
    expect(wakeHasPriorAttempt([{ daemonPromptId: 'm:1' }], 'm:2')).toBe(false);
    expect(wakeHasPriorAttempt([], 'm:1')).toBe(false);
  });
});

describe('createMonitorWakeRunTurn', () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const sessionKey = {
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    sessionId,
  };
  const temporaryDirectories = new Set<string>();

  afterEach(async () => {
    for (const directory of temporaryDirectories) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    temporaryDirectories.clear();
  });

  async function openWakeSession() {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-monitor-wake-turn-'),
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
    return { session, lease };
  }

  it('queues instead of clearing a prompt claim that lands mid-read', async () => {
    const { session, lease } = await openWakeSession();
    try {
      const access: MonitorWakeTurnSession['session'] = {
        active: undefined,
        blocked: false,
        managed: { sink: session.sink },
      };
      let openGate: () => void = () => undefined;
      const gate = new Promise<ReadonlyArray<{ daemonPromptId?: string }>>(
        (resolve) => {
          openGate = () => resolve([]);
        },
      );
      const project = vi
        .spyOn(session.sink, 'project')
        .mockImplementation(() => gate as Promise<ChatRecord[]>);
      let reachedModel = false;
      const runTurn = createMonitorWakeRunTurn({
        session: access,
        sessionId,
        cwd: '/workspace',
        executeHostedTurn: async () => {
          reachedModel = true;
        },
        busy: () => access.active !== undefined,
        needsRecovery,
        writeStderr: () => undefined,
      });
      const pending = runTurn({ turnId: 'm:1', text: 'wake' });
      // The prompt route's own admission lands while the journal read
      // is still open: the wake turn must queue, never trade claims.
      const user = {
        promptId: 'user-1',
        digest: '',
        abort: new AbortController(),
      } as const;
      access.active = user;
      openGate();
      expect(await pending).toBe('busy');
      expect(access.active).toBe(user);
      expect(reachedModel).toBe(false);
      expect(project).toHaveBeenCalledTimes(1);
    } finally {
      await lease.release().catch(() => undefined);
    }
  });

  it('runs the turn and returns active to its idle claim after settle', async () => {
    const { session, lease } = await openWakeSession();
    try {
      const access: MonitorWakeTurnSession['session'] = {
        active: undefined,
        blocked: false,
        managed: { sink: session.sink },
      };
      let ran: string | undefined;
      const runTurn = createMonitorWakeRunTurn({
        session: access,
        sessionId,
        cwd: '/workspace',
        executeHostedTurn: async (promptId) => {
          ran = promptId;
        },
        busy: () => access.active !== undefined,
        needsRecovery,
        writeStderr: () => undefined,
      });
      expect(await runTurn({ turnId: 'm:1', text: 'wake' })).toBe('settled');
      expect(ran).toBe('m:1');
      expect(access.active).toBeUndefined();
    } finally {
      await lease.release().catch(() => undefined);
    }
  });

  it.each([
    ['tool', () => new HostedToolRecoveryRequiredError(new Error('parked'))],
    ['mcp', () => new HostedMcpRecoveryRequiredError()],
    ['hook', () => new HostedHookRecoveryRequiredError()],
  ])(
    'leaves a %s recovery-required input unsettled rather than consuming it',
    async (_kind, makeCause) => {
      const { session, lease } = await openWakeSession();
      try {
        const access: MonitorWakeTurnSession['session'] = {
          active: undefined,
          blocked: false,
          managed: { sink: session.sink },
        };
        const writes = vi.spyOn(session.sink, 'write');
        const runTurn = createMonitorWakeRunTurn({
          session: access,
          sessionId,
          cwd: '/workspace',
          executeHostedTurn: async () => {
            throw makeCause();
          },
          busy: () => access.active !== undefined,
          needsRecovery,
          writeStderr: () => undefined,
        });
        expect(await runTurn({ turnId: 'm:1', text: 'wake' })).toBe('settled');
        // A recovery-required turn parks like a parked prompt: blocked, its
        // input unconsumed, and no error turn_result minted on top of it.
        expect(access.blocked).toBe(true);
        expect(writes).not.toHaveBeenCalled();
        expect(access.active).toBeUndefined();
      } finally {
        await lease.release().catch(() => undefined);
      }
    },
  );

  it('settles a generic wake failure as an error turn_result and rethrows', async () => {
    const { session, lease } = await openWakeSession();
    try {
      const access: MonitorWakeTurnSession['session'] = {
        active: undefined,
        blocked: false,
        managed: { sink: session.sink },
      };
      const writes = vi.spyOn(session.sink, 'write');
      const failure = new Error('boom');
      const runTurn = createMonitorWakeRunTurn({
        session: access,
        sessionId,
        cwd: '/workspace',
        executeHostedTurn: async () => {
          throw failure;
        },
        busy: () => access.active !== undefined,
        needsRecovery,
        writeStderr: () => undefined,
      });
      await expect(runTurn({ turnId: 'm:1', text: 'wake' })).rejects.toBe(
        failure,
      );
      expect(writes).toHaveBeenCalledTimes(1);
      expect(writes.mock.calls[0]![0]).toMatchObject({
        subtype: 'turn_result',
        systemPayload: {
          promptId: 'm:1',
          state: 'error',
          stopReason: 'error',
        },
      });
      expect(access.blocked).toBe(false);
      expect(access.active).toBeUndefined();
    } finally {
      await lease.release().catch(() => undefined);
    }
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

  it('settles a notification that landed beyond the default event page', async () => {
    // A real Session's log runs past the bounded read's default page long
    // before its first Monitor notification arrives. Settling only what a
    // default-sized read returns would leave that notification owed, and an
    // owed input parks the Session as hosted_turn_recovery_required at its
    // next open — the wedge this path exists to prevent.
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-hosted-wake-page-'),
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
      const monitors = new HostedMonitorSession(
        { authority, resources: session.resources },
        sessionKey,
      );
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: 'scope-main',
        executionCallId: 'call-1',
        args: { command: 'du -sh .' },
        maxEvents: 10_000,
        idleTimeoutMs: 60_000,
        debounceMs: 1000,
      });
      await monitors.dispatchStarted('monitor-1', BINDING);
      await monitors.attach('monitor-1', BINDING, { watch: 'started' });
      // One revision per accepted observation pushes the log well past the
      // default page before the notification rides a late revision.
      for (let index = 0; index < 110; index++) {
        await monitors.observe('monitor-1', { size: index });
      }
      await monitors.observe(
        'monitor-1',
        { size: 110 },
        {
          input: {
            inputId: 'monitor-1:notify:111',
            turnId: 'monitor-1:notify:111',
            source: 'monitor',
            contentRef: await session.resources.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            deadline: null,
            admissionRef: await session.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            wakeReason: 'input',
          },
        },
      );
      expect(authority.committedSequence).toBeGreaterThan(
        MANAGED_SESSION_LIMITS.defaultReadEvents,
      );
      expect(
        pendingSessionInputs(
          authority.eventsInSequenceRange(1, authority.committedSequence),
        ).map((input) => input.turnId),
      ).toEqual(['monitor-1:notify:111']);

      expect(
        await settlePendingMonitorInputs({
          authority,
          sink: session.sink,
          sessionId,
          cwd: '/workspace',
        }),
      ).toBe(1);
      expect(
        pendingSessionInputs(
          authority.eventsInSequenceRange(1, authority.committedSequence),
        ),
      ).toEqual([]);
    } finally {
      await lease.release().catch(() => undefined);
    }
  });

  it('leaves an already-attempted wake turn to its recovery owner', async () => {
    // The wake turn ran and parked with its input still owed: canceling it
    // here would mint a "cancelled" line on top of a turn that ran and lies
    // to the recovery fleet that closes over the parked one.
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-hosted-wake-attempted-'),
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
      // The turn its notification started left its user record behind.
      await session.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        daemonPromptId: 'monitor-1:notify:1',
        cwd: '/workspace',
        version: 'test',
        message: { role: 'user', parts: [{ text: 'the wake' }] },
      });
      const settled = await settlePendingMonitorInputs({
        authority,
        sink: session.sink,
        sessionId,
        cwd: '/workspace',
      });
      expect(settled).toBe(0);
      expect(
        authority.readEvents().filter((event) => event.kind === 'turn.settled'),
      ).toHaveLength(0);
      expect(
        pendingSessionInputs(
          authority.eventsInSequenceRange(1, authority.committedSequence),
        ).map((input) => input.turnId),
      ).toEqual(['monitor-1:notify:1']);
    } finally {
      await lease.release().catch(() => undefined);
    }
  });
});
