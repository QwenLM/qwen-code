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
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { managedExtensionRecordKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import {
  CHILD_NOTIFICATION_INLINE_LIMIT,
  childResultNotificationText,
  HostedChildAgentSession,
  type ChildAgentLaunchParams,
} from './hosted-child-agent-session.js';

// The H4b gates are real: the kind gate admits `child_agent` and
// `child_acceptance` sits in the plain enabled list, so this suite drives
// the hosted orchestrator with no enablement mock. One H4c case plants a
// `workflow` record ahead of that kind's enablement; the flag lifts the
// kind gate for that planting only.
const enablement = vi.hoisted(() => ({ workflowKind: false }));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
    return {
      ...actual,
      assertManagedSessionChildRunKindEnabled: (kind: string) => {
        if (kind !== 'workflow' || !enablement.workflowKind) {
          actual.assertManagedSessionChildRunKindEnabled(kind);
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

const TASK_ID = `task_${managedExtensionRecordKey(sessionId, 'child_run', 'run-1')}`;

const DEFINITION = {
  definitionId: 'agent-main',
  definitionRevision: 3,
  definitionDigest: 'f'.repeat(64),
};

const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.workflowKind = false;
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-agent-'));
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

async function withAuthority<T>(
  harness: Harness,
  run: (authority: LocalManagedSessionAuthority) => Promise<T>,
  options: { create?: boolean } = {},
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const create =
      options.create === false
        ? undefined
        : {
            agentId: 'agent-main',
            modelKey: 'model-1',
            definitionRef: await harness.store.publish(
              'managed-definition',
              Buffer.from('{}', 'utf8'),
            ),
            rootSnapshotRef: await harness.store.publish(
              'managed-root',
              Buffer.from('{}', 'utf8'),
            ),
            createdBy: 'daemon',
          };
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      now: () => harness.now,
      ...(create === undefined ? {} : { create }),
    });
    return await run(authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

function launchParams(
  overrides: Partial<ChildAgentLaunchParams> = {},
): ChildAgentLaunchParams {
  return {
    childRunId: 'run-1',
    ownerScopeId: 'scope-main',
    rootSessionId: sessionId,
    completion: 'sent',
    description: 'audit the diff',
    prompt: 'review the change',
    definition: DEFINITION,
    workingDirectory: '.',
    executionCallId: 'call-1',
    ...overrides,
  };
}

async function settleThroughAttach(
  children: HostedChildAgentSession,
): Promise<void> {
  await children.admit(launchParams());
  await children.dispatchStarted('run-1', {
    dispatchId: 'dispatch-1',
    runtime: BINDING,
  });
  await children.attach('run-1', 'session-child');
}

describe('childResultNotificationText', () => {
  it('round-trips a result far below the inline cap untouched', () => {
    const notification = childResultNotificationText({
      taskId: TASK_ID,
      description: 'audit the diff',
      text: '审阅通过,生成文件两份。',
    });
    expect(notification).toContain(`<task-id>${TASK_ID}</task-id>`);
    expect(notification).toContain('<result>审阅通过,生成文件两份。</result>');
    expect(notification).not.toContain('truncated');
    expect(notification).not.toContain('prompt:callId');
    expect(Buffer.byteLength(notification, 'utf8')).toBeLessThan(
      CHILD_NOTIFICATION_INLINE_LIMIT,
    );
  });

  it('bounds an XML-hostile result under the packaged-input budget', () => {
    // The real-stack B1/B1b finding: 20 KiB of '<' escapes beyond the
    // JSON-serialized cap of the bundled input, then of the wake turn's
    // own managed-message — the bound is serialized bytes, not the XML.
    const notification = childResultNotificationText({
      taskId: TASK_ID,
      description: 'audit',
      text: '<'.repeat(20 * 1024),
    });
    expect(
      Buffer.byteLength(JSON.stringify({ text: notification }), 'utf8'),
    ).toBeLessThanOrEqual(CHILD_NOTIFICATION_INLINE_LIMIT);
    expect(notification).toContain('&lt;');
    expect(notification).toContain('truncated: the full result is on the');
    expect(notification).toContain('acceptance record');
  });

  it('keeps the result newlines while stripping display controls', () => {
    const notification = childResultNotificationText({
      taskId: TASK_ID,
      description: 'audit',
      text: 'first line\u202a\nsecond line\u202e\n- item A',
    });
    expect(notification).toContain(
      '<result>first line\nsecond line\n- item A</result>',
    );
  });
});

describe('hosted child agent session (H4b)', () => {
  it('chains the sent arm into a wake-carrying acceptance', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await children.admit(launchParams());
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'child_agent',
          state: 'pending',
          runtimeState: 'unbound',
          definitionRevision: 3,
          createdAt: 1_000,
          startedAt: null,
          settledAt: null,
        },
      ]);
      await children.dispatchStarted('run-1', {
        dispatchId: 'dispatch-1',
        runtime: BINDING,
      });
      await children.attach('run-1', 'session-child');
      const resultRef = await children.settleCompleted('run-1', {
        result: Buffer.from('审阅通过,生成文件两份。', 'utf8'),
        receipt: Buffer.from(
          '{"outcome":"settled","turnId":"turn-c1"}',
          'utf8',
        ),
      });
      expect(resultRef.kind).toBe('managed-child-result');
      harness.now = 2_000;
      await children.accept('run-1', {
        notification: { description: 'audit the diff' },
      });
      // The acceptance and its notification input + wake ride one
      // transaction: domain.committed then input.accepted/wake.requested.
      const events = authority.readEvents({ afterSequence: 0, limit: 64 });
      const kinds = events.map((event) => event.kind);
      const acceptanceIndex = kinds.lastIndexOf('domain.committed');
      expect(kinds.slice(acceptanceIndex)).toEqual([
        'domain.committed',
        'input.accepted',
        'wake.requested',
      ]);
      const input = events[acceptanceIndex + 1]!;
      expect(input.kind).toBe('input.accepted');
      expect((input.payload as Record<string, unknown>)['source']).toBe(
        'child_agent',
      );
      expect(authority.taskViews()[0]).toMatchObject({
        kind: 'child_agent',
        state: 'completed',
      });
      await children.markAccepted('run-1');
      await children.markConsumed('run-1');
      const record = children.record('run-1')!;
      expect(record.run.delivery).toEqual({
        target: 'session',
        state: 'consumed',
      });
      expect(children.acceptance('run-1')!.run.delivery).toEqual({
        target: 'session',
        state: 'consumed',
      });
    });
  });

  it('a consumption that outruns the delivered step still lands in order', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await settleThroughAttach(children);
      await children.settleCompleted('run-1', {
        result: Buffer.from('{"ok":true}', 'utf8'),
        receipt: Buffer.from('{}', 'utf8'),
      });
      await children.accept('run-1', {
        notification: { description: 'audit the diff' },
      });
      expect(children.record('run-1')!.run.delivery).toEqual({
        target: 'session',
        state: 'accepting',
      });
      // The wake turn consumed before the relay's accepted commit landed:
      // accepting → accepted → consumed in two ordered revisions.
      await children.markConsumed('run-1');
      expect(children.record('run-1')!.run.delivery).toEqual({
        target: 'session',
        state: 'consumed',
      });
      expect(children.acceptance('run-1')!.run.delivery).toEqual({
        target: 'session',
        state: 'consumed',
      });
      // The relay's later accepted is now a no-op, not a rewinding commit.
      const eventsBefore = authority.readEvents({
        afterSequence: 0,
        limit: 64,
      }).length;
      await children.markAccepted('run-1');
      expect(authority.readEvents({ afterSequence: 0, limit: 64 }).length).toBe(
        eventsBefore,
      );
      expect(children.record('run-1')!.run.delivery).toEqual({
        target: 'session',
        state: 'consumed',
      });
    });
  });

  it('commits the tool-arm acceptance alone, without any input', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await children.admit(launchParams({ completion: 'tool' }));
      await children.dispatchStarted('run-1', {
        dispatchId: 'dispatch-1',
        runtime: BINDING,
      });
      await children.attach('run-1', 'session-child');
      await children.settleCompleted('run-1', {
        result: Buffer.from('{"summary":"clean"}', 'utf8'),
        receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      });
      const before = authority.readEvents({
        afterSequence: 0,
        limit: 64,
      }).length;
      await children.accept('run-1');
      const events = authority.readEvents({ afterSequence: 0, limit: 64 });
      expect(events.slice(before).map((event) => event.kind)).toEqual([
        'domain.committed',
      ]);
      const acceptance = children.acceptance('run-1')!;
      expect(acceptance.parentExecutionCallId).toBe('call-1');
    });
  });

  it('replays the same verbs into the same revisions', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await settleThroughAttach(children);
      await children.settleCompleted('run-1', {
        result: Buffer.from('{"ok":true}', 'utf8'),
        receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      });
      await children.accept('run-1', {
        notification: { description: 'audit the diff' },
      });
      await children.markAccepted('run-1');
      const eventsBefore = authority.readEvents({
        afterSequence: 0,
        limit: 64,
      }).length;
      // Restarting the funnel (a harness replacement) must not restate any
      // already-committed revision: every verb is replay-safe by command id
      // or by deep-equal skip.
      const restarted = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await restarted.dispatchStarted('run-1', {
        dispatchId: 'dispatch-1',
        runtime: BINDING,
      });
      await restarted.attach('run-1', 'session-child');
      await restarted.accept('run-1', {
        notification: { description: 'audit the diff' },
      });
      await restarted.markAccepted('run-1');
      expect(authority.readEvents({ afterSequence: 0, limit: 64 }).length).toBe(
        eventsBefore,
      );
    });
  });

  it('rebuilds the chains after a reopen', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await settleThroughAttach(children);
      await children.settleCompleted('run-1', {
        result: Buffer.from('{"ok":true}', 'utf8'),
        receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      });
      await children.accept('run-1', {
        notification: { description: 'audit the diff' },
      });
      await children.markAccepted('run-1');
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.taskViews()).toEqual([
          {
            taskId: TASK_ID,
            sessionId,
            kind: 'child_agent',
            state: 'completed',
            runtimeState: null,
            definitionRevision: 3,
            createdAt: 1_000,
            startedAt: 1_000,
            settledAt: 1_000,
          },
        ]);
        const children = new HostedChildAgentSession(
          { authority, resources: harness.store },
          sessionKey,
        );
        expect(children.record('run-1')!.run.delivery).toEqual({
          target: 'session',
          state: 'accepted',
        });
        expect(children.acceptance('run-1')!.run.delivery).toEqual({
          target: 'session',
          state: 'accepted',
        });
      },
      { create: false },
    );
  });

  it('refuses settling a result beyond the copy bound', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await settleThroughAttach(children);
      // The bound is pinned to the parent Session's durable inline limit:
      // one byte over it already takes the named byte_limit refusal.
      await expect(
        children.settleCompleted('run-1', {
          result: Buffer.alloc(64 * 1024 + 1, 65),
          receipt: Buffer.from('{}', 'utf8'),
        }),
      ).rejects.toThrow('byte_limit');
      expect(children.record('run-1')!.run.state).toBe('running');
    });
  });

  it('commits the cancel cascade revisions', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await children.admit(launchParams());
      await children.dispatchStarted('run-1', {
        dispatchId: 'dispatch-1',
        runtime: BINDING,
      });
      await children.requestStop('run-1');
      expect(children.record('run-1')).toMatchObject({
        stopRequested: true,
        run: { state: 'running' },
      });
      expect(authority.taskViews()[0]).toMatchObject({
        state: 'running',
        runtimeState: 'draining',
      });
      await children.settleCancelled('run-1', { started: false });
      expect(children.record('run-1')).toMatchObject({
        stopReason: 'stop_requested',
        run: {
          state: 'cancelled',
          execution: 'not_started_proven',
          delivery: { target: 'session', state: 'cancelled' },
        },
      });
    });
  });

  it('counts only the active children of the scope', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      expect(children.activeChildRunsOf('scope-main')).toHaveLength(0);
      await settleThroughAttach(children);
      await children.admit(
        launchParams({ childRunId: 'run-2', executionCallId: 'call-2' }),
      );
      expect(
        children.activeChildRunsOf('scope-main').map((run) => run.childRunId),
      ).toEqual(['run-1', 'run-2']);
      expect(children.activeChildRunsOf('scope-other')).toHaveLength(0);
      await children.settleCompleted('run-1', {
        result: Buffer.from('{"ok":true}', 'utf8'),
        receipt: Buffer.from('{}', 'utf8'),
      });
      await children.admit(
        launchParams({ childRunId: 'run-3', executionCallId: 'call-3' }),
      );
      await children.settleCancelled('run-3', { started: false });
      expect(
        children.activeChildRunsOf('scope-main').map((run) => run.childRunId),
      ).toEqual(['run-2']);
    });
  });

  // H4c: the quotas count child Sessions, so a workflow child spends the
  // same concurrency and launch budget a child agent does, while the
  // child agent funnel itself never reads it as one of its own.
  it('counts a workflow child against the scope quotas', async () => {
    enablement.workflowKind = true;
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      const { inputRef } = await children.admit(launchParams());
      await authority.commitExtensionRecord(
        {
          operation: 'commitChildRunRecord',
          commandId: 'workflow-1:1',
          sessionKey,
          contentDigest: 'd'.repeat(64),
        },
        {
          domain: 'child_run',
          record: {
            ...children.record('run-1')!,
            kind: 'workflow',
            childRunId: 'workflow-1',
            inputRef,
          },
        },
        { class: 'trusted_entry' },
      );
      expect(
        children
          .launchedChildRunsOf('scope-main')
          .map((run) => [run.kind, run.childRunId]),
      ).toEqual([
        ['child_agent', 'run-1'],
        ['workflow', 'workflow-1'],
      ]);
      expect(children.activeChildRunsOf('scope-main')).toHaveLength(2);
      expect(children.record('workflow-1')).toBeUndefined();
    });
  });

  it('refuses consumption steps the acceptance never reached', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await settleThroughAttach(children);
      await children.settleCompleted('run-1', {
        result: Buffer.from('{"ok":true}', 'utf8'),
        receipt: Buffer.from('{}', 'utf8'),
      });
      await expect(children.markAccepted('run-1')).rejects.toThrow(
        'reaches accepted or consumed only with its acceptance record',
      );
      await expect(children.markConsumed('run-1')).rejects.toThrow(
        'reaches accepted or consumed only with its acceptance record',
      );
    });
  });

  it('reuses the committed result references on a replayed settle', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await settleThroughAttach(children);
      const payload = {
        result: Buffer.from('审阅通过', 'utf8'),
        receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      };
      const resultRef = await children.settleCompleted('run-1', payload);
      const eventsBefore = authority.readEvents({
        afterSequence: 0,
        limit: 64,
      }).length;
      // The same replay after a lost reply answers with the committed
      // copies and no second terminal revision.
      await expect(children.settleCompleted('run-1', payload)).resolves.toEqual(
        resultRef,
      );
      expect(authority.readEvents({ afterSequence: 0, limit: 64 }).length).toBe(
        eventsBefore,
      );
      expect(children.record('run-1')!.resultRef).toEqual(resultRef);
    });
  });

  it('refuses a replayed settle that names different bytes', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const children = new HostedChildAgentSession(
        { authority, resources: harness.store },
        sessionKey,
      );
      await settleThroughAttach(children);
      await children.settleCompleted('run-1', {
        result: Buffer.from('审阅通过', 'utf8'),
        receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      });
      const eventsBefore = authority.readEvents({
        afterSequence: 0,
        limit: 64,
      }).length;
      await expect(
        children.settleCompleted('run-1', {
          result: Buffer.from('审阅不通过', 'utf8'),
          receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
        }),
      ).rejects.toThrow('was already settled with a different result');
      expect(authority.readEvents({ afterSequence: 0, limit: 64 }).length).toBe(
        eventsBefore,
      );
      expect(children.record('run-1')!.run.state).toBe('settled');
    });
  });
});
