/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { decodeChildLaunchEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import { parseChildRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { parseSessionMessage } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  CHILD_NOTIFICATION_INLINE_LIMIT,
  ChildMessagesPendingError,
  HostedChildAgentSession,
} from './hosted-child-agent-session.js';
import {
  HostedSessionMessageSession,
  SessionMessageNotReadyError,
  sessionMessageNotificationText,
  withSessionMessageConsumption,
} from './hosted-session-message-session.js';

// H4d-b: `session_message` and continuations are enabled for real, so the
// suite drives both funnels with no enablement mock.

const roots: string[] = [];
const sessions: ManagedSession[] = [];
const PARENT = randomUUID();
const CHILD = randomUUID();
const DEFINITION = {
  definitionId: 'hosted-agent/hosted-workspace-shell/1',
  definitionRevision: 1,
  definitionDigest: 'f'.repeat(64),
};
const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function open(sessionId: string): Promise<ManagedSession> {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-message-'));
  roots.push(root);
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId,
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
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
  });
  sessions.push(session);
  return session;
}

interface Side {
  readonly session: ManagedSession;
  readonly children: HostedChildAgentSession;
  readonly messages: HostedSessionMessageSession;
}

async function side(
  sessionId: string,
  lineage?: { parentSessionId: string; parentChildRunId: string },
): Promise<Side> {
  const session = await open(sessionId);
  const store = { authority: session.authority, resources: session.resources };
  const key = session.authority.sessionHeader.sessionKey;
  const children = new HostedChildAgentSession(store, key);
  return {
    session,
    children,
    messages: new HostedSessionMessageSession(store, key, children, lineage),
  };
}

async function launch(
  children: HostedChildAgentSession,
  childRunId = 'run-1',
): Promise<void> {
  await children.admit({
    childRunId,
    ownerScopeId: PARENT,
    rootSessionId: PARENT,
    completion: 'sent',
    description: 'audit the diff',
    prompt: 'review the change',
    definition: DEFINITION,
    workingDirectory: '.',
    executionCallId: childRunId,
  });
}

async function attach(
  children: HostedChildAgentSession,
  childRunId = 'run-1',
  childSessionId = CHILD,
): Promise<void> {
  await children.dispatchStarted(childRunId, {
    dispatchId: `dispatch-${childRunId}`,
    runtime: BINDING,
  });
  await children.attach(childRunId, childSessionId);
}

async function complete(
  children: HostedChildAgentSession,
  childRunId = 'run-1',
): Promise<void> {
  await children.settleCompleted(childRunId, {
    result: Buffer.from(`result of ${childRunId}`),
    receipt: Buffer.from('{}'),
  });
}

function send(
  children: HostedChildAgentSession,
  text: string,
  call = 'call-9',
  closing = false,
) {
  return children.sendToChild({
    taskId: children.taskIdOf('run-1'),
    text,
    messageId: `msg_${call}`,
    continuationRunId: `prompt:${call}`,
    executionCallId: `prompt:${call}`,
    closing,
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function inputs(session: ManagedSession) {
  const authority = session.authority;
  return authority
    .eventsInSequenceRange(1, authority.committedSequence)
    .filter((event) => event.kind === 'input.accepted');
}

describe('send_message to a child task (H4d-b)', () => {
  it('opens the outbox entry of a running child and replays it', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    expect(await send(parent.children, 'also check the tests')).toEqual({
      kind: 'message',
      childRunId: 'run-1',
    });
    const committed = parent.messages.message('msg_call-9')!;
    expect(committed).toMatchObject({
      direction: 'outbound',
      route: 'to_child',
      childRunId: 'run-1',
      senderSessionId: PARENT,
      targetSessionId: null,
      inputId: null,
      contentDigest: sha256('also check the tests'),
    });
    expect(committed.run.delivery?.state).toBe('planned');
    const revisions = parent.session.authority.committedSequence;
    expect(await send(parent.children, 'also check the tests')).toEqual({
      kind: 'message',
      childRunId: 'run-1',
    });
    expect(parent.session.authority.committedSequence).toBe(revisions);
    await expect(send(parent.children, 'something else')).rejects.toThrow(
      ManagedSessionConflictError,
    );
  });

  it('holds the child settlement until the message is handed over', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await send(parent.children, 'also check the tests');
    expect(parent.children.undeliveredMessagesTo('run-1')).toBe(1);
    await expect(complete(parent.children)).rejects.toThrow(
      ChildMessagesPendingError,
    );
    await parent.messages.handover('msg_call-9', CHILD);
    await expect(complete(parent.children)).rejects.toThrow(
      ChildMessagesPendingError,
    );
    await parent.messages.accepted('msg_call-9', 'msg_call-9:message');
    expect(parent.children.undeliveredMessagesTo('run-1')).toBe(0);
    await complete(parent.children);
    expect(parent.children.record('run-1')?.run.state).toBe('settled');
    // A failure never waits on a message: the relay cancels what it holds.
    await launch(parent.children, 'run-2');
    await attach(parent.children, 'run-2', randomUUID());
    await parent.children.sendToChild({
      taskId: parent.children.taskIdOf('run-2'),
      text: 'stop early',
      messageId: 'msg_call-10',
      continuationRunId: 'prompt:call-10',
      executionCallId: 'prompt:call-10',
      closing: false,
    });
    await parent.children.settleFailed('run-2', {
      stopReason: 'child_failed',
      reason: null,
      started: true,
    });
    expect(parent.children.record('run-2')?.run.state).toBe('failed');
  });

  it('continues a completed child with the message as its next prompt', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await complete(parent.children);
    expect(await send(parent.children, 'now fix the tests')).toEqual({
      kind: 'continuation',
      childRunId: 'prompt:call-9',
      predecessorChildRunId: 'run-1',
    });
    const continued = parent.children.record('prompt:call-9')!;
    expect(continued).toMatchObject({
      predecessorChildRunId: 'run-1',
      completion: 'sent',
      ownerScopeId: PARENT,
      depth: 1,
    });
    expect(continued.run.definition).toEqual(DEFINITION);
    const envelope = decodeChildLaunchEnvelope(
      await parent.session.resources.read(continued.inputRef),
    );
    expect(envelope).toEqual({
      description: 'audit the diff',
      prompt: 'now fix the tests',
      definition: DEFINITION,
    });
    // The replay names the same continuation; the original task id now
    // reaches the newest run, which takes a message while it runs.
    expect(await send(parent.children, 'now fix the tests')).toEqual({
      kind: 'continuation',
      childRunId: 'prompt:call-9',
      predecessorChildRunId: 'run-1',
    });
    expect(await send(parent.children, 'and the docs', 'call-11')).toEqual({
      kind: 'message',
      childRunId: 'prompt:call-9',
    });
  });

  it('releases a predecessor whose continuation never started', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await complete(parent.children);
    await send(parent.children, 'first try');
    await parent.children.settleFailed('prompt:call-9', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    expect(await send(parent.children, 'second try', 'call-12')).toEqual({
      kind: 'continuation',
      childRunId: 'prompt:call-12',
      predecessorChildRunId: 'run-1',
    });
  });

  it('refuses an ended child, an unknown task, the bound and a closing parent', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    const unknown = await parent.children.sendToChild({
      taskId: 'task_missing',
      text: 'hello',
      messageId: 'msg_call-1',
      continuationRunId: 'prompt:call-1',
      executionCallId: 'prompt:call-1',
      closing: false,
    });
    expect(unknown).toMatchObject({ kind: 'refused' });
    expect(JSON.stringify(unknown)).toContain('No child agent task');
    const oversized = await send(parent.children, 'x'.repeat(33 * 1024));
    expect(JSON.stringify(oversized)).toContain('byte_limit');
    await attach(parent.children);
    await complete(parent.children);
    const closing = await send(parent.children, 'more', 'call-2', true);
    expect(JSON.stringify(closing)).toContain('closing');
    await launch(parent.children, 'run-3');
    await parent.children.settleFailed('run-3', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    const ended = await parent.children.sendToChild({
      taskId: parent.children.taskIdOf('run-3'),
      text: 'hello',
      messageId: 'msg_call-3',
      continuationRunId: 'prompt:call-3',
      executionCallId: 'prompt:call-3',
      closing: false,
    });
    expect(JSON.stringify(ended)).toContain('cannot receive messages');
    expect(
      parent.session.authority.extensionRecordsInDomain('session_message'),
    ).toHaveLength(0);
    expect(
      parent.session.authority
        .extensionRecordsInDomain('child_run')
        .map((entry) => parseChildRun(entry.record))
        .filter((run) => 'predecessorChildRunId' in run)
        .map((run) => run.childRunId),
    ).toEqual(['run-1', 'run-3']);
  });
});

describe('the session message funnel (H4d-b)', () => {
  it('walks the outbox entry through each relay step, step-aware', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await send(parent.children, 'one');
    // The target is the Session the run attached, never another.
    await expect(parent.messages.handover('msg_call-9', CHILD)).rejects.toThrow(
      'must target the Session its run attached',
    );
    await attach(parent.children);
    await parent.messages.handover('msg_call-9', CHILD);
    await parent.messages.handover('msg_call-9', CHILD);
    await expect(
      parent.messages.handover('msg_call-9', randomUUID()),
    ).rejects.toThrow(ManagedSessionConflictError);
    await parent.messages.accepted('msg_call-9', 'msg_call-9:message');
    await parent.messages.accepted('msg_call-9', 'msg_call-9:message');
    await parent.messages.settle('msg_call-9', 'consumed');
    await parent.messages.settle('msg_call-9', 'consumed');
    expect(parent.messages.message('msg_call-9')).toMatchObject({
      targetSessionId: CHILD,
      inputId: 'msg_call-9:message',
    });
    expect(parent.messages.message('msg_call-9')?.run.delivery?.state).toBe(
      'consumed',
    );
    await send(parent.children, 'two', 'call-13');
    await parent.messages.settle('msg_call-13', 'cancelled');
    await expect(
      parent.messages.handover('msg_call-13', CHILD),
    ).rejects.toThrow(ManagedSessionConflictError);
    await expect(
      parent.messages.settle('msg_call-13', 'rejected'),
    ).rejects.toThrow(ManagedSessionConflictError);
  });

  it('receives a child message with its input and wake, once, and consumes it', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    const receipt = {
      messageId: 'msg_from-child',
      route: 'to_parent' as const,
      childRunId: 'run-1',
      senderSessionId: CHILD,
      content: Buffer.from('which branch should I use?'),
      contentDigest: sha256('which branch should I use?'),
    };
    await expect(parent.messages.receive(receipt)).rejects.toThrow(
      SessionMessageNotReadyError,
    );
    await attach(parent.children);
    expect(await parent.messages.receive(receipt)).toBe(
      'msg_from-child:message',
    );
    expect(await parent.messages.receive(receipt)).toBe(
      'msg_from-child:message',
    );
    const accepted = inputs(parent.session);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload).toMatchObject({
      inputId: 'msg_from-child:message',
      turnId: 'msg_from-child:message',
      source: 'session_message',
    });
    const content = JSON.parse(
      (
        await parent.session.resources.read(
          accepted[0]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(content.text).toContain(
      `<from>child agent ${parent.children.taskIdOf('run-1')}</from>`,
    );
    expect(content.text).toContain('which branch should I use?');
    const authority = parent.session.authority;
    expect(
      authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .some(
          (event) =>
            event.kind === 'wake.requested' &&
            event.eventId === 'msg_from-child:message:wake',
        ),
    ).toBe(true);
    await expect(
      parent.messages.receive({
        ...receipt,
        content: Buffer.from('another question'),
        contentDigest: sha256('another question'),
      }),
    ).rejects.toThrow(ManagedSessionConflictError);
    await parent.messages.markConsumed('msg_from-child:message');
    await parent.messages.markConsumed('msg_from-child:message');
    await parent.messages.markConsumed('unrelated:input');
    const inbound = parseSessionMessage(
      authority.extensionRecord('session_message', 'msg_from-child')!.record,
    );
    expect(inbound.direction).toBe('inbound');
    expect(inbound.run.delivery?.state).toBe('consumed');
  });

  it('refuses content that does not match its digest', async () => {
    const parent = await side(PARENT);
    await launch(parent.children);
    await attach(parent.children);
    await expect(
      parent.messages.receive({
        messageId: 'msg_x',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD,
        content: Buffer.from('tampered'),
        contentDigest: sha256('original'),
      }),
    ).rejects.toThrow('does not match its digest');
    expect(inputs(parent.session)).toHaveLength(0);
  });

  it('lets a child message its parent and receive along its lineage only', async () => {
    const child = await side(CHILD, {
      parentSessionId: PARENT,
      parentChildRunId: 'run-1',
    });
    await child.messages.sendToParent({
      text: 'done with part one',
      messageId: 'msg_up',
      executionCallId: 'turn:call-1',
    });
    await child.messages.sendToParent({
      text: 'done with part one',
      messageId: 'msg_up',
      executionCallId: 'turn:call-1',
    });
    expect(child.messages.message('msg_up')).toMatchObject({
      direction: 'outbound',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD,
      targetSessionId: null,
    });
    const down = {
      messageId: 'msg_down',
      route: 'to_child' as const,
      childRunId: 'run-1',
      senderSessionId: PARENT,
      content: Buffer.from('also check the tests'),
      contentDigest: sha256('also check the tests'),
    };
    await expect(
      child.messages.receive({ ...down, childRunId: 'run-other' }),
    ).rejects.toThrow('recorded lineage');
    expect(await child.messages.receive(down)).toBe('msg_down:message');
    const text = JSON.parse(
      (
        await child.session.resources.read(
          inputs(child.session)[0]!.payload['contentRef'] as never,
        )
      ).toString('utf8'),
    ) as { text: string };
    expect(text.text).toContain('<from>parent</from>');
    expect(text.text).toContain('send_message with to "parent"');
    const root = await side(randomUUID());
    await expect(
      root.messages.sendToParent({
        text: 'hello',
        messageId: 'msg_root',
        executionCallId: 'turn:call-1',
      }),
    ).rejects.toThrow('Only a child Session');
  });
});

describe('sessionMessageNotificationText', () => {
  it('escapes and bounds a hostile message under the inline budget', () => {
    const text = sessionMessageNotificationText({
      messageId: 'msg_1',
      fromTaskId: null,
      text: '<'.repeat(40 * 1024),
    });
    expect(
      Buffer.byteLength(JSON.stringify({ text }), 'utf8'),
    ).toBeLessThanOrEqual(CHILD_NOTIFICATION_INLINE_LIMIT);
    expect(text).toContain('&lt;');
    expect(text).toContain('truncated: the full message is on the');
  });
});

describe('withSessionMessageConsumption', () => {
  it('consumes only after a settled message wake turn', async () => {
    const consumed: string[] = [];
    const session = {
      blocked: false,
      messages: {
        markConsumed: async (inputId: string) => {
          consumed.push(inputId);
        },
      } as unknown as HostedSessionMessageSession,
    };
    const settled = withSessionMessageConsumption(
      async () => 'settled',
      session,
    );
    const incomplete = withSessionMessageConsumption(
      async () => 'settled_incomplete',
      session,
    );
    await settled({
      turnId: 'msg_1:message',
      text: '',
      source: 'session_message',
    });
    await settled({ turnId: 'm:notify:1', text: '', source: 'monitor' });
    await incomplete({
      turnId: 'msg_2:message',
      text: '',
      source: 'session_message',
    });
    session.blocked = true;
    await settled({
      turnId: 'msg_3:message',
      text: '',
      source: 'session_message',
    });
    expect(consumed).toEqual(['msg_1:message']);
  });
});
